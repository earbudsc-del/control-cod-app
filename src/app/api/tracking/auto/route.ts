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

// Campos mínimos — incluimos normalized_status para el guard anti-unknown-overwrite
const SELECT = 'id, tracking_number, normalized_status, last_tracking_update, store_id'

type SB = Awaited<ReturnType<typeof createServiceClient>>

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Lógica de tracking compartida entre GET (Vercel Cron) y POST (script local) ──
//
// Estrategia de tres queries (prioridades):
//   1. Hasta 60 pedidos in_transit      — reclasificación más crítica
//   2. Hasta 50 pedidos en_reparto      — reparto activo: necesita sync frecuente
//   3. Hasta 50 pedidos en otros estados no finalizados (novedad, pending, unknown…)
//
// Esto garantiza que guías en reparto no sean desplazadas por novedades cuando
// hay muchos pedidos en espera, y que in_transit siempre tenga prioridad máxima.

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

  if (allOrders.length === 0) {
    console.log(`${logPrefix} processed=0 updated=0 skipped=0 failed=0`)
    return NextResponse.json({ processed: 0, updated: 0, skipped: 0, failed: 0 })
  }

  let updated = 0
  let skipped = 0
  let failed  = 0
  const errors:   Array<{ trackingNumber: string; error: string }> = []
  const skips:    Array<{ trackingNumber: string; reason: string }> = []

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

  console.log(
    `${logPrefix} processed=${allOrders.length} ` +
    `updated=${updated} skipped=${skipped} failed=${failed}`,
  )

  // Confirmation tasks para pedidos importados por Excel (no crean task en import)
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
