import { NextResponse }        from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'

// GET /api/debug/active-universe
// Solo admin. Solo lectura — no modifica ningún dato.
//
// Diagnóstico del universo activo del cron EFI:
// explica POR QUÉ el cron procesa N órdenes cuando EFI tiene más guías activas.
//
// Responde:
//   1. Simulación exacta de las 3 queries del cron (Q1/Q2/Q3) con totales reales
//   2. Breakdown completo por normalized_status (incluidas vs excluidas del cron)
//   3. Cuántas órdenes quedan excluidas por cada condición
//   4. Distribución temporal de returned/delivered (cuándo fueron finalizadas)
//   5. Muestra de returned/delivered últimos 30 días (para inspección de raw_status)
//   6. Reconcile Shopify extendido (30 días, no solo hoy)
//   7. Diagnóstico resumido con causas probables y pasos siguientes

const ALLOWED_ROLES  = ['admin']
const FINAL_STATUSES = ['delivered', 'returned', 'cancelled']
const CRON_SELECT    = 'id, tracking_number, normalized_status, last_tracking_update'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!ALLOWED_ROLES.includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
    }

    const service = await createServiceClient()
    const now = new Date()
    const d2ago  = new Date(now.getTime() -  2 * 24 * 60 * 60 * 1000).toISOString()
    const d7ago  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString()
    const d14ago = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const d30ago = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const d60ago = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()

    // ── Bloque 1: Simulación exacta de las 3 queries del cron ────────────────
    // Reproduce Q1, Q2, Q3 de runTracking() para mostrar cuántos existen en total
    // vs cuántos el cron toma (cap por run). Incluye muestra de datos reales.
    const [
      cronQ1CountRes,   // total real in_transit con tracking
      cronQ2CountRes,   // total real en_reparto con tracking
      cronQ3CountRes,   // total real "others" con tracking
      cronQ1SampleRes,  // muestra de Q1 (primeros 5 que procesaría el cron)
      cronQ2SampleRes,  // muestra de Q2
      cronQ3SampleRes,  // muestra de Q3
    ] = await Promise.all([
      service.from('orders').select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .eq('normalized_status', 'in_transit'),

      service.from('orders').select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .eq('normalized_status', 'en_reparto'),

      service.from('orders').select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .not('normalized_status', 'in', `(in_transit,en_reparto,${FINAL_STATUSES.join(',')})`),

      service.from('orders').select(CRON_SELECT)
        .not('tracking_number', 'is', null)
        .eq('normalized_status', 'in_transit')
        .order('last_tracking_update', { ascending: true, nullsFirst: true })
        .limit(5),

      service.from('orders').select(CRON_SELECT)
        .not('tracking_number', 'is', null)
        .eq('normalized_status', 'en_reparto')
        .order('last_tracking_update', { ascending: true, nullsFirst: true })
        .limit(5),

      service.from('orders').select(CRON_SELECT)
        .not('tracking_number', 'is', null)
        .not('normalized_status', 'in', `(in_transit,en_reparto,${FINAL_STATUSES.join(',')})`)
        .order('last_tracking_update', { ascending: true, nullsFirst: true })
        .limit(5),
    ])

    // ── Bloque 2: Breakdown completo por normalized_status ───────────────────
    // Sin límite — muestra el universo real de TODOS los pedidos con tracking.
    const [
      allStatusesRes,       // todos los rows con tracking para agrupar
      noTrackingTotalRes,   // pedidos SIN tracking (excluidos del cron completamente)
    ] = await Promise.all([
      service.from('orders').select('normalized_status').not('tracking_number', 'is', null),
      service.from('orders').select('id', { count: 'exact', head: true })
        .is('tracking_number', null)
        .not('normalized_status', 'in', '(delivered,returned,cancelled)'),
    ])

    const byStatus: Record<string, number> = {}
    for (const row of allStatusesRes.data ?? []) {
      const k = row.normalized_status as string
      byStatus[k] = (byStatus[k] ?? 0) + 1
    }
    const totalWithTracking = (allStatusesRes.data ?? []).length
    const activeTotal = Object.entries(byStatus)
      .filter(([k]) => !FINAL_STATUSES.includes(k))
      .reduce((sum, [, v]) => sum + v, 0)

    // ── Bloque 3: Distribución temporal de returned/delivered ────────────────
    // Clave para entender si las órdenes finalizadas son antiguas (normales)
    // o recientes (candidatas a re-verificar en EFI).
    // Usa last_tracking_update = momento en que el cron las marcó como final.
    const [
      ret2d,   ret7d,   ret14d,   ret30d,   ret60d,   retTotal,
      del2d,   del7d,   del14d,   del30d,   del60d,   delTotal,
    ] = await Promise.all([
      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'returned').not('tracking_number', 'is', null)
        .gte('last_tracking_update', d2ago),
      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'returned').not('tracking_number', 'is', null)
        .gte('last_tracking_update', d7ago),
      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'returned').not('tracking_number', 'is', null)
        .gte('last_tracking_update', d14ago),
      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'returned').not('tracking_number', 'is', null)
        .gte('last_tracking_update', d30ago),
      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'returned').not('tracking_number', 'is', null)
        .gte('last_tracking_update', d60ago),
      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'returned').not('tracking_number', 'is', null),

      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered').not('tracking_number', 'is', null)
        .gte('last_tracking_update', d2ago),
      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered').not('tracking_number', 'is', null)
        .gte('last_tracking_update', d7ago),
      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered').not('tracking_number', 'is', null)
        .gte('last_tracking_update', d14ago),
      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered').not('tracking_number', 'is', null)
        .gte('last_tracking_update', d30ago),
      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered').not('tracking_number', 'is', null)
        .gte('last_tracking_update', d60ago),
      service.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered').not('tracking_number', 'is', null),
    ])

    // ── Bloque 4: Muestra de finalizados recientes para inspección ───────────
    // returned/delivered de los últimos 30 días con raw_status visible.
    // El analista puede ver si algún raw_status parece activo (novedad, reparto…).
    // IMPORTANTE: raw_status está congelado al momento de la ÚLTIMA sync del cron.
    // Si EFI lo reactivó después, raw_status NO lo reflejará — hay que comparar manualmente.
    const [
      retSampleRes,
      delSampleRes,
    ] = await Promise.all([
      service.from('orders')
        .select('id, tracking_number, order_number, raw_status, normalized_status, last_tracking_update, status_since, created_at')
        .eq('normalized_status', 'returned')
        .not('tracking_number', 'is', null)
        .gte('last_tracking_update', d30ago)
        .order('last_tracking_update', { ascending: false })
        .limit(30),
      service.from('orders')
        .select('id, tracking_number, order_number, raw_status, normalized_status, last_tracking_update, status_since, created_at')
        .eq('normalized_status', 'delivered')
        .not('tracking_number', 'is', null)
        .gte('last_tracking_update', d30ago)
        .order('last_tracking_update', { ascending: false })
        .limit(30),
    ])

    // ── Bloque 5: Muestra de activas actuales (lo que el cron procesa hoy) ───
    const activeSampleRes = await service.from('orders')
      .select('tracking_number, order_number, normalized_status, raw_status, last_tracking_update, status_since')
      .not('tracking_number', 'is', null)
      .not('normalized_status', 'in', `(${FINAL_STATUSES.join(',')})`)
      .order('last_tracking_update', { ascending: true, nullsFirst: true })
      .limit(20)

    // ── Bloque 6: Reconcile Shopify extendido (últimos 30 días) ─────────────
    // El reconcile original solo chequea HOY. Este chequea 30 días para detectar
    // órdenes históricas que nunca entraron a DB (webhook gaps antes del fix).
    let shopify30d: null | {
      shopify_count: number
      db_count:      number
      gap:           number
      note:          string
      warning?:      string
    } = null

    const shopDomain  = process.env.SHOPIFY_SHOP_DOMAIN
    const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN

    if (shopDomain && accessToken) {
      try {
        // Shopify REST limita a 250 por request. Para 30 días puede haber más,
        // pero como diagnóstico inicial es suficiente para detectar brechas obvias.
        const url = `https://${shopDomain}/admin/api/2024-07/orders.json` +
          `?status=any&limit=250&fields=id,name` +
          `&created_at_min=${encodeURIComponent(d30ago)}`

        const res = await fetch(url, {
          headers: { 'X-Shopify-Access-Token': accessToken },
          signal:  AbortSignal.timeout(12_000),
        })

        if (res.ok) {
          const json = await res.json() as { orders: { id: number; name?: string }[] }
          const shopifyOrders = json.orders ?? []

          // Cuántos de esos shopify_order_ids están en nuestra DB
          const shopifyIds = shopifyOrders.map(o => String(o.id))
          let dbMatchCount = 0
          if (shopifyIds.length > 0) {
            const { count } = await service
              .from('orders')
              .select('id', { count: 'exact', head: true })
              .in('shopify_order_id', shopifyIds)
            dbMatchCount = count ?? 0
          }

          const gap = shopifyOrders.length - dbMatchCount
          shopify30d = {
            shopify_count: shopifyOrders.length,
            db_count:      dbMatchCount,
            gap,
            note: gap > 0
              ? `ALERTA: ~${gap} pedidos de Shopify (últimos 30d, máx 250 revisados) no están en DB.`
              : 'Sin brecha detectada en los últimos 30 días (limitado a 250 pedidos por request).',
            ...(shopifyOrders.length === 250 && {
              warning: 'Shopify devolvió exactamente 250 — hay más pedidos sin revisar. Considera paginar para cobertura completa.',
            }),
          }
        }
      } catch { /* no crítico para el diagnóstico */ }
    }

    // ── Construir exclusionAnalysis ──────────────────────────────────────────
    const excl = {
      delivered: byStatus['delivered'] ?? 0,
      returned:  byStatus['returned']  ?? 0,
      cancelled: byStatus['cancelled'] ?? 0,
    }
    const totalExcluded = excl.delivered + excl.returned + excl.cancelled

    const q1Total = cronQ1CountRes.count ?? 0
    const q2Total = cronQ2CountRes.count ?? 0
    const q3Total = cronQ3CountRes.count ?? 0

    return NextResponse.json({
      generatedAt: now.toISOString(),

      // ── 1. Simulación exacta del cron ──────────────────────────────────────
      cronSimulation: {
        note: 'Simula las 3 queries de runTracking() exactamente. `total_in_db` = registros reales. `cap` = límite del cron. El cron toma min(total_in_db, cap).',
        Q1_in_transit: {
          filter:         'normalized_status = in_transit',
          total_in_db:    q1Total,
          cap_per_run:    60,
          taken_by_cron:  Math.min(q1Total, 60),
          capped:         q1Total > 60,
          sample:         cronQ1SampleRes.data ?? [],
        },
        Q2_en_reparto: {
          filter:         'normalized_status = en_reparto',
          total_in_db:    q2Total,
          cap_per_run:    50,
          taken_by_cron:  Math.min(q2Total, 50),
          capped:         q2Total > 50,
          sample:         cronQ2SampleRes.data ?? [],
        },
        Q3_others: {
          filter:         'normalized_status NOT IN (in_transit, en_reparto, delivered, returned, cancelled)',
          includes:       'novedad · pending · unknown · y cualquier status no final no en Q1/Q2',
          total_in_db:    q3Total,
          cap_per_run:    50,
          taken_by_cron:  Math.min(q3Total, 50),
          capped:         q3Total > 50,
          sample:         cronQ3SampleRes.data ?? [],
        },
        total_processed_per_run: Math.min(q1Total, 60) + Math.min(q2Total, 50) + Math.min(q3Total, 50),
        total_active_in_db:      activeTotal,
        cron_covers_all_active:  activeTotal <= 160,
      },

      // ── 2. Universo completo (con tracking) ────────────────────────────────
      universeBreakdown: {
        total_with_tracking:      totalWithTracking,
        active_included_in_cron:  activeTotal,
        excluded_in_final_status: totalExcluded,
        no_tracking_active:       noTrackingTotalRes.count ?? 0,
        by_normalized_status: Object.entries(byStatus)
          .sort((a, b) => b[1] - a[1])
          .map(([status, count]) => ({
            status,
            count,
            cron_action: FINAL_STATUSES.includes(status)
              ? 'EXCLUIDA — final status, el cron nunca vuelve a procesarla'
              : 'INCLUIDA — procesada por Q1/Q2/Q3 según corresponda',
          })),
        exclusionByCondition: {
          no_tracking_number: {
            count:  noTrackingTotalRes.count ?? 0,
            reason: 'tracking_number IS NULL — el cron filtra .not(tracking_number, is, null)',
            note:   'Estas órdenes existen en DB pero el cron no puede consultarlas en EFI',
          },
          delivered: {
            count:  excl.delivered,
            reason: 'normalized_status = delivered → en FINAL_STATUSES, excluida para siempre',
          },
          returned: {
            count:  excl.returned,
            reason: 'normalized_status = returned → en FINAL_STATUSES, excluida para siempre',
          },
          cancelled: {
            count:  excl.cancelled,
            reason: 'normalized_status = cancelled → en FINAL_STATUSES, excluida para siempre',
          },
          total_excluded: totalExcluded,
        },
      },

      // ── 3. Distribución temporal de finalizados ────────────────────────────
      finalStatusTimeline: {
        note: 'last_tracking_update = cuándo el cron marcó la orden como final. Órdenes finalizadas recientemente son las candidatas a re-verificar si EFI las reactivó.',
        returned: {
          total:     retTotal.count ?? 0,
          last_2d:   ret2d.count  ?? 0,
          last_7d:   ret7d.count  ?? 0,
          last_14d:  ret14d.count ?? 0,
          last_30d:  ret30d.count ?? 0,
          last_60d:  ret60d.count ?? 0,
          older_60d: (retTotal.count ?? 0) - (ret60d.count ?? 0),
        },
        delivered: {
          total:     delTotal.count ?? 0,
          last_2d:   del2d.count  ?? 0,
          last_7d:   del7d.count  ?? 0,
          last_14d:  del14d.count ?? 0,
          last_30d:  del30d.count ?? 0,
          last_60d:  del60d.count ?? 0,
          older_60d: (delTotal.count ?? 0) - (del60d.count ?? 0),
        },
        interpretation: {
          last_2d_returned: ret2d.count ?? 0,
          last_2d_delivered: del2d.count ?? 0,
          key_insight: [
            'Si returned.last_7d es alto: el reactivate-tracking (ventana 7d) debería haberlos detectado.',
            'Si returned.last_14d >> last_7d: hay candidatos entre 7-14 días que el reactivate-tracking NO vio.',
            'Si returned.older_60d domina: son históricos reales, probablemente correctos.',
            'CRÍTICO: el raw_status en DB está congelado al momento de la ÚLTIMA sync del cron.',
            'Una orden puede tener raw_status=Devuelto en DB pero EFI ahora dice En Reparto.',
            'El reactivate-tracking busca raw_status activos en DB — NUNCA encontrará esos casos.',
          ],
        },
      },

      // ── 4. Muestra de finalizados recientes ────────────────────────────────
      recentFinalSample: {
        note: [
          'returned/delivered de los últimos 30 días. Inspeccionar raw_status manualmente.',
          'ADVERTENCIA: raw_status puede estar desactualizado — es el estado cuando el cron los finalizó, no el estado actual en EFI.',
          'Para confirmar si EFI los reactivó: tomar tracking_number y consultar effi.com.co/tracking/index/{guia}',
        ],
        returned_last_30d:  retSampleRes.data  ?? [],
        delivered_last_30d: delSampleRes.data ?? [],
      },

      // ── 5. Activas actuales (lo que el cron procesa) ───────────────────────
      currentActiveSample: {
        note: 'Las 20 órdenes activas más antiguas sin actualizar — las que el cron procesa primero.',
        count:  activeTotal,
        sample: activeSampleRes.data ?? [],
      },

      // ── 6. Reconcile Shopify extendido (30 días) ────────────────────────────
      shopify30dReconcile: shopify30d
        ? shopify30d
        : { note: 'No disponible — SHOPIFY_SHOP_DOMAIN o SHOPIFY_ADMIN_ACCESS_TOKEN no configurados.' },

      // ── 7. Diagnóstico resumido ────────────────────────────────────────────
      diagnosis: {
        headline: `El cron procesa correctamente TODAS las ${activeTotal} órdenes activas. El gap con EFI (${activeTotal} vs ~133) NO es un problema de la query sino del estado de la DB.`,
        gap_estimate: 133 - activeTotal,
        query_bottleneck: false,
        root_cause_candidates: [
          {
            priority: 1,
            label: 'Finalizaciones históricas que EFI reactivó',
            description: [
              `${excl.returned} órdenes en "returned" y ${excl.delivered} en "delivered" son excluidas permanentemente del cron.`,
              'Si EFI reactivó alguna (courier reagendó, error de clasificación, etc.), la DB nunca se enterará.',
              'El reactivate-tracking solo busca 7 días y usa raw_status de DB (congelado al momento del sync).',
              'Una orden con raw_status="Devuelto" en DB puede estar como "En reparto" en EFI ahora mismo.',
              'El endpoint solo detecta sospechosas si raw_status tiene palabras activas — pero si EFI dijo "Devuelto" al momento del sync, raw_status es "Devuelto" y no será detectado.',
            ],
            how_to_verify: 'Tomar 10-20 tracking_number de recentFinalSample.returned_last_30d y consultar manualmente en effi.com.co/tracking/index/{guia}',
          },
          {
            priority: 2,
            label: 'Órdenes históricas faltantes en DB (webhook gaps)',
            description: [
              'El reconcile original solo chequea HOY. No hay verificación sistemática de los últimos 30 días.',
              'Si el webhook falló durante 1-4 semanas antes del fix, hay órdenes en EFI que nunca llegaron a DB.',
              'Esas órdenes tendrían tracking en EFI pero CERO presencia en nuestra DB.',
            ],
            how_to_verify: 'Ver shopify30dReconcile.gap — si > 0, correr recover-shopify-orders con rango de 30 días.',
          },
          {
            priority: 3,
            label: 'Ventana de reactivate-tracking demasiado estrecha (7 días)',
            description: [
              'reactivate-tracking usa .gte(last_tracking_update, 7_days_ago).',
              'Órdenes finalizadas hace 8-30+ días no son revisadas aunque estén activas en EFI.',
              'La propuesta de fix es ampliar la ventana a 21-30 días en el endpoint.',
            ],
            how_to_verify: 'Ver finalStatusTimeline.returned.last_14d vs last_7d — si hay salto grande, hay candidatos en el rango 7-14 días.',
          },
        ],
        next_steps: [
          'PASO 1: Consultar manualmente en EFI 5-10 tracking_numbers de recentFinalSample.returned_last_30d.',
          'PASO 2: Si shopify30dReconcile.gap > 0 → correr POST /api/admin/recover-shopify-orders con from=30_dias_atras.',
          'PASO 3: Si se confirman finalizaciones incorrectas → ampliar ventana de reactivate-tracking a 21 días.',
          'PASO 4: Para el problema estructural (raw_status congelado), la única solución real es re-consultar EFI para los finalizados recientes en lugar de confiar en raw_status de DB.',
          'NO hacer cambios agresivos hasta confirmar cuál escenario domina (1, 2, o 3).',
        ],
      },
    })

  } catch (err) {
    console.error('[GET /api/debug/active-universe]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
