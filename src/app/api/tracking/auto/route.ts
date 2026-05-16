import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { updateOrderTracking } from '@/lib/tracking/update-order'
import { createTaskIfNotExists, resolveAutoTasks } from '@/lib/tasks/auto-tasks'

// Vercel Pro permite hasta 300 s para serverless functions.
// Con 300 s podemos procesar ~200 órdenes cómodamente a 1-3 s por fetch EFI.
export const maxDuration = 300

const FINAL_STATUSES = ['delivered', 'returned', 'cancelled']
const BATCH_SIZE     = 5
const BATCH_DELAY_MS = 1_000

// Ventana de revalidación: re-consulta EFI para returned/delivered recientes.
// Si EFI los reactivó, los sacamos del estado final sin depender de raw_status congelado.
// Límite conservador para mantener runtime < 300 s (activas ~120 s + revalidación ~30 s).
const REVALIDATION_DAYS  = 21
const REVALIDATION_LIMIT = 15

// Campos mínimos — incluimos normalized_status para el guard anti-unknown-overwrite
const SELECT = 'id, tracking_number, normalized_status, last_tracking_update, store_id'

type SB = Awaited<ReturnType<typeof createServiceClient>>

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Lógica de tracking compartida entre GET (Vercel Cron) y POST (script local) ──
//
// Estrategia de cuatro queries (prioridades):
//   Q1. Hasta 60 pedidos in_transit      — reclasificación más crítica
//   Q2. Hasta 50 pedidos en_reparto      — reparto activo: necesita sync frecuente
//   Q3. Hasta 50 pedidos en otros estados no finalizados (novedad, pending, unknown…)
//   Q4. Hasta 15 returned/delivered de últimos 21 días — revalidación contra EFI
//       → Si EFI los reactivó (courier reagendó, error de clasificación), los sacamos
//         del estado final. NO depende de raw_status en DB (que puede estar congelado).
//
// Q4 corre DESPUÉS de Q1/Q2/Q3 (activas tienen prioridad). Límite conservador para
// mantener el runtime total dentro de 300 s: ~59 activas × 1.5 s + 15 finals × 1.5 s ≈ 110 s.

async function runTracking(supabase: SB, logPrefix: string): Promise<NextResponse> {
  const [transitRes, repartoRes, otherRes] = await Promise.all([
    supabase
      .from('orders')
      .select(SELECT)
      .not('tracking_number', 'is', null)
      .eq('normalized_status', 'in_transit')
      .order('last_tracking_update', { ascending: true, nullsFirst: true })
      .limit(60),
    supabase
      .from('orders')
      .select(SELECT)
      .not('tracking_number', 'is', null)
      .eq('normalized_status', 'en_reparto')
      .order('last_tracking_update', { ascending: true, nullsFirst: true })
      .limit(50),
    supabase
      .from('orders')
      .select(SELECT)
      .not('tracking_number', 'is', null)
      .not('normalized_status', 'in', `(in_transit,en_reparto,${FINAL_STATUSES.join(',')})`)
      .order('last_tracking_update', { ascending: true, nullsFirst: true })
      .limit(50),
  ])

  if (transitRes.error) {
    console.error(`${logPrefix} error fetching in_transit orders:`, transitRes.error)
    return NextResponse.json({ error: 'Error al obtener pedidos in_transit' }, { status: 500 })
  }
  if (repartoRes.error) {
    console.error(`${logPrefix} error fetching en_reparto orders:`, repartoRes.error)
    return NextResponse.json({ error: 'Error al obtener pedidos en_reparto' }, { status: 500 })
  }
  if (otherRes.error) {
    console.error(`${logPrefix} error fetching other orders:`, otherRes.error)
    return NextResponse.json({ error: 'Error al obtener pedidos otros' }, { status: 500 })
  }

  // Deduplicar: si un pedido aparece en más de un query (debería ser raro dado los filtros),
  // conservamos solo la primera aparición.
  const seen = new Set<string>()
  const allOrders = [...(transitRes.data ?? []), ...(repartoRes.data ?? []), ...(otherRes.data ?? [])]
    .filter(o => {
      if (seen.has(o.id)) return false
      seen.add(o.id)
      return true
    })

  console.log(
    `${logPrefix} queued: ` +
    `in_transit=${transitRes.data?.length ?? 0} ` +
    `en_reparto=${repartoRes.data?.length ?? 0} ` +
    `others=${otherRes.data?.length ?? 0} ` +
    `total=${allOrders.length}`,
  )

  let updated = 0
  let skipped = 0
  let failed  = 0
  const errors: Array<{ trackingNumber: string; error: string }> = []
  const skips:  Array<{ trackingNumber: string; reason: string }> = []

  // ── Q1/Q2/Q3: procesar órdenes activas ───────────────────────────────────
  if (allOrders.length === 0) {
    console.log(`${logPrefix} processed=0 updated=0 skipped=0 failed=0`)
  }

  for (let i = 0; i < allOrders.length; i += BATCH_SIZE) {
    const batch   = allOrders.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(o =>
        updateOrderTracking(o.id, o.tracking_number, supabase, o.normalized_status),
      ),
    )

    const taskPromises: Promise<void>[] = []

    for (const [j, r] of results.entries()) {
      const order = batch[j]
      if (r.success) {
        if (r.skipped) {
          skipped++
          if (r.skip_reason) skips.push({ trackingNumber: order.tracking_number, reason: r.skip_reason })
        } else {
          updated++
          if (r.normalized_status !== undefined && order.store_id) {
            taskPromises.push(
              resolveAutoTasks(supabase, {
                orderId:          r.orderId,
                storeId:          order.store_id,
                normalizedStatus: r.normalized_status,
              }).catch(e => console.error('[auto-tasks]', r.orderId, e)),
            )
          }
        }
      } else {
        failed++
        if (r.error) errors.push({ trackingNumber: order.tracking_number, error: r.error })
      }
    }

    await Promise.all(taskPromises)

    if (i + BATCH_SIZE < allOrders.length) await sleep(BATCH_DELAY_MS)
  }

  if (allOrders.length > 0) {
    console.log(
      `${logPrefix} processed=${allOrders.length} ` +
      `updated=${updated} skipped=${skipped} failed=${failed}`,
    )
  }

  // ── Q4: revalidación de finalizados recientes ─────────────────────────────
  //
  // Re-consulta EFI para returned/delivered de los últimos REVALIDATION_DAYS días.
  // Detecta órdenes que el courier reagendó o que EFI reclasificó como activas
  // DESPUÉS de que el cron las marcó como finales.
  //
  // Protecciones:
  //   - Solo returned/delivered (no cancelled — son finalizaciones intencionales)
  //   - Solo los últimos 21 días (no toca históricos reales antiguos)
  //   - Límite de 15 por run (runtime budget: ~30 s adicionales)
  //   - Guard anti-unknown de updateOrderTracking sigue activo
  //   - Si EFI confirma final → update idempotente, sin efecto operativo
  //   - Si EFI muestra activo → reactivación + auto-task si corresponde

  let revalidChecked     = 0
  let revalidReactivated = 0
  let revalidStayedFinal = 0
  let revalidErrors      = 0

  const d21ago          = new Date(Date.now() - REVALIDATION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const recentFinalsRes = await supabase
    .from('orders')
    .select(SELECT)
    .not('tracking_number', 'is', null)
    .in('normalized_status', ['returned', 'delivered'])
    .gte('last_tracking_update', d21ago)
    .order('last_tracking_update', { ascending: true, nullsFirst: true })
    .limit(REVALIDATION_LIMIT)

  if (!recentFinalsRes.error && recentFinalsRes.data && recentFinalsRes.data.length > 0) {
    const recentFinals = recentFinalsRes.data

    console.log(
      `${logPrefix}[revalidation] queued=${recentFinals.length} window=${REVALIDATION_DAYS}d`,
    )

    for (let i = 0; i < recentFinals.length; i += BATCH_SIZE) {
      const batch   = recentFinals.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(
        batch.map(o =>
          // Pasamos el normalized_status actual para que el guard anti-unknown siga activo:
          // si EFI devuelve unknown, NO sobreescribimos returned/delivered con unknown.
          updateOrderTracking(o.id, o.tracking_number, supabase, o.normalized_status),
        ),
      )

      const taskPromises: Promise<void>[] = []

      for (const [j, r] of results.entries()) {
        const order = batch[j]
        revalidChecked++

        if (!r.success) {
          revalidErrors++
        } else if (r.skipped) {
          // EFI devolvió unknown — guard mantuvo el estado final (correcto)
          revalidStayedFinal++
        } else if (r.normalized_status && !FINAL_STATUSES.includes(r.normalized_status)) {
          // EFI muestra estado activo → la orden fue reactivada en DB
          revalidReactivated++
          console.log(
            `${logPrefix}[revalidation] REACTIVATED guia=${order.tracking_number} ` +
            `old=${order.normalized_status} new=${r.normalized_status}`,
          )
          if (order.store_id) {
            taskPromises.push(
              resolveAutoTasks(supabase, {
                orderId:          r.orderId,
                storeId:          order.store_id,
                normalizedStatus: r.normalized_status,
              }).catch(e => console.error('[auto-tasks][revalidation]', r.orderId, e)),
            )
          }
        } else {
          // EFI confirma estado final → sin cambio operativo (last_tracking_update actualizado)
          revalidStayedFinal++
        }
      }

      await Promise.all(taskPromises)

      if (i + BATCH_SIZE < recentFinals.length) await sleep(BATCH_DELAY_MS)
    }

    console.log(
      `${logPrefix}[revalidation] checked=${revalidChecked} ` +
      `reactivated=${revalidReactivated} stayed_final=${revalidStayedFinal} errors=${revalidErrors}`,
    )
  } else {
    console.log(`${logPrefix}[revalidation] no recent finals in window=${REVALIDATION_DAYS}d`)
  }

  // ── Confirmation tasks para pedidos importados por Excel ──────────────────
  const { data: pendingOrders } = await supabase
    .from('orders')
    .select('id, store_id')
    .eq('normalized_status', 'pending')
    .limit(100)

  if (pendingOrders?.length) {
    await Promise.all(
      pendingOrders.map(o =>
        createTaskIfNotExists(supabase, {
          orderId:  o.id,
          storeId:  o.store_id,
          taskType: 'confirmation',
          priority: 'high',
        }).catch(e => console.error('[auto-tasks][confirmation]', o.id, e)),
      ),
    )
    console.log(`${logPrefix} confirmation tasks checked for ${pendingOrders.length} pending orders`)
  }

  return NextResponse.json({
    processed: allOrders.length,
    updated,
    skipped,
    failed,
    revalidation: {
      checked:      revalidChecked,
      reactivated:  revalidReactivated,
      stayed_final: revalidStayedFinal,
      errors:       revalidErrors,
    },
    ...(errors.length > 0 && { errors: errors.slice(0, 20) }),
    ...(skips.length  > 0 && { skips:  skips.slice(0, 20) }),
  })
}

// ── GET — Vercel Cron ─────────────────────────────────────────────────────────
// Vercel envía: GET /api/tracking/auto
// Header:       Authorization: Bearer <CRON_SECRET>

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET
  const auth       = req.headers.get('authorization')

  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  console.log('[vercel-cron] tracking iniciado')
  const supabase = await createServiceClient()
  return runTracking(supabase, '[vercel-cron]')
}

// ── POST — script local / ejecución manual ────────────────────────────────────
// Header: x-cron-secret: <CRON_SECRET>  → usa service role (bypass RLS)
// Sin header                             → requiere sesión activa

export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET
  const isCron     = !!(cronSecret && req.headers.get('x-cron-secret') === cronSecret)

  const supabase = isCron
    ? await createServiceClient()
    : await createClient()

  if (!isCron) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  return runTracking(supabase as SB, '[auto-tracking]')
}
