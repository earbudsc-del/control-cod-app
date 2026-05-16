import { NextResponse }        from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'

// GET /api/debug/tracking-reconcile
// Solo admin.
//
// Responde preguntas clave sobre el universo de órdenes:
//   - ¿Cuántas tienen tracking_number en DB?
//   - ¿Cuántas NO tienen tracking_number (cron no puede procesarlas)?
//   - ¿Cuántas están en FINAL_STATUSES (excluidas del cron para siempre)?
//   - ¿Hay órdenes en returned/delivered que parecen prematuras (raw_status activo)?
//   - ¿Cuántas órdenes de Shopify llegaron hoy vs cuántas están en DB?

const ALLOWED_ROLES = ['admin']

function rdTodayBounds(): { start: string; end: string } {
  const rd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = rd.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, d,     4, 0, 0, 0)).toISOString()
  const end   = new Date(Date.UTC(y, m - 1, d + 1, 4, 0, 0, 0)).toISOString()
  return { start, end }
}

// raw_status que indican un estado activo — no deberían aparecer en returned/delivered
const ACTIVE_RAW_PATTERNS = [
  'reparto', 'en ruta', 'mensajero', 'despacho', 'en camino', 'en entrega',
  'para entrega', 'a entregar', 'novedad', 'ausente', 'en transito', 'tránsito',
  'transito', 'bodega', 'recibido', 'generada', 'en proceso',
]

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
    const today   = rdTodayBounds()
    const d7ago   = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString()
    const d30ago  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const [
      // 1 - Todos los pedidos con tracking: por normalized_status
      withTrackingRes,
      // 2 - Sin tracking_number (en DB pero cron no los procesa)
      noTrackingRes,
      // 3 - En final status (excluidos del cron para siempre)
      finalStatusRes,
      // 4 - Returned recientes (últimos 7 días, con raw_status para detectar incorrectos)
      recentReturnedRes,
      // 5 - Delivered recientes (últimos 7 días)
      recentDeliveredRes,
      // 6 - Cancelled (total)
      cancelledRes,
      // 7 - Pedidos hoy en DB (por source)
      dbHoyWebhookRes,
      dbHoyCsvRes,
      // 8 - Últimos 50 pedidos con tracking (para muestra de consistencia)
      recentTrackingRes,
      // 9 - Pedidos con tracking + unknown
      unknownWithTrackingRes,
      // 10 - Pedidos sin tracking + pending (esperando tracking)
      pendingNoTrackingRes,
      // 11 - Total general
      totalRes,
    ] = await Promise.all([
      // 1
      service.from('orders').select('normalized_status').not('tracking_number', 'is', null),

      // 2 - sin tracking
      service
        .from('orders')
        .select('id, order_number, normalized_status, source, created_at', { count: 'exact' })
        .is('tracking_number', null)
        .not('normalized_status', 'in', '(delivered,returned,cancelled)')
        .order('created_at', { ascending: false })
        .limit(30),

      // 3 - final status con tracking
      service
        .from('orders')
        .select('normalized_status', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .in('normalized_status', ['delivered', 'returned', 'cancelled']),

      // 4 - returned recientes con raw_status
      service
        .from('orders')
        .select('id, tracking_number, order_number, raw_status, normalized_status, last_tracking_update, created_at, source')
        .eq('normalized_status', 'returned')
        .not('tracking_number', 'is', null)
        .gte('last_tracking_update', d7ago)
        .order('last_tracking_update', { ascending: false })
        .limit(30),

      // 5 - delivered recientes
      service
        .from('orders')
        .select('id, tracking_number, order_number, raw_status, normalized_status, last_tracking_update, created_at, source')
        .eq('normalized_status', 'delivered')
        .not('tracking_number', 'is', null)
        .gte('last_tracking_update', d7ago)
        .order('last_tracking_update', { ascending: false })
        .limit(30),

      // 6 - cancelled
      service
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .eq('normalized_status', 'cancelled'),

      // 7 - DB hoy webhook
      service
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .gte('created_at', today.start)
        .lt('created_at', today.end),

      // 7b - DB hoy CSV
      service
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('source', 'csv_import')
        .gte('created_at', today.start)
        .lt('created_at', today.end),

      // 8 - últimos 50 con tracking (muestra de consistencia)
      service
        .from('orders')
        .select('tracking_number, order_number, raw_status, normalized_status, last_tracking_update, created_at, source')
        .not('tracking_number', 'is', null)
        .order('created_at', { ascending: false })
        .limit(50),

      // 9 - unknown con tracking
      service
        .from('orders')
        .select('tracking_number, order_number, raw_status, last_tracking_update, created_at', { count: 'exact' })
        .not('tracking_number', 'is', null)
        .eq('normalized_status', 'unknown')
        .order('created_at', { ascending: false })
        .limit(20),

      // 10 - pending sin tracking
      service
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .is('tracking_number', null)
        .eq('normalized_status', 'pending'),

      // 11 - total
      service
        .from('orders')
        .select('id', { count: 'exact', head: true }),
    ])

    // Agrupar conteos con tracking por normalized_status
    const withTrackingByStatus: Record<string, number> = {}
    for (const row of withTrackingRes.data ?? []) {
      const k = row.normalized_status as string
      withTrackingByStatus[k] = (withTrackingByStatus[k] ?? 0) + 1
    }
    const totalWithTracking   = (withTrackingRes.data ?? []).length
    const activeWithTracking  = totalWithTracking - (withTrackingByStatus['delivered'] ?? 0)
                                                  - (withTrackingByStatus['returned']  ?? 0)
                                                  - (withTrackingByStatus['cancelled'] ?? 0)

    // Detectar returned/delivered con raw_status sospechoso (podría ser finalización incorrecta)
    const suspectReturned = (recentReturnedRes.data ?? []).filter(o => {
      const raw = (o.raw_status ?? '').toLowerCase()
      return ACTIVE_RAW_PATTERNS.some(p => raw.includes(p))
    })

    const suspectDelivered = (recentDeliveredRes.data ?? []).filter(o => {
      const raw = (o.raw_status ?? '').toLowerCase()
      return ACTIVE_RAW_PATTERNS.some(p => raw.includes(p))
    })

    // Pedidos sin tracking por source
    const noTrackingBySource: Record<string, number> = {}
    for (const row of noTrackingRes.data ?? []) {
      const k = row.source as string ?? 'unknown'
      noTrackingBySource[k] = (noTrackingBySource[k] ?? 0) + 1
    }

    // Check Shopify Admin API si hay env vars
    let shopifyComparison: null | {
      shopify_orders_today: number
      db_orders_today_webhook: number
      db_orders_today_csv: number
      missing_from_db: number
      missing_order_names: string[]
      note: string
    } = null

    const shopDomain  = process.env.SHOPIFY_SHOP_DOMAIN
    const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN

    if (shopDomain && accessToken) {
      try {
        const fields = 'id,name,order_number,created_at'
        const url    =
          `https://${shopDomain}/admin/api/2024-07/orders.json` +
          `?status=any&limit=250` +
          `&created_at_min=${encodeURIComponent(today.start)}` +
          `&created_at_max=${encodeURIComponent(today.end)}` +
          `&fields=${fields}`

        const res = await fetch(url, {
          headers: { 'X-Shopify-Access-Token': accessToken },
          signal:  AbortSignal.timeout(10_000),
        })

        if (res.ok) {
          const json = await res.json() as { orders: { id: number; name?: string }[] }
          const shopifyOrders = json.orders ?? []
          const shopifyIds    = new Set(shopifyOrders.map(o => String(o.id)))

          // Buscar cuáles están en DB
          const { data: dbOrders } = await service
            .from('orders')
            .select('shopify_order_id, order_number')
            .in('shopify_order_id', [...shopifyIds])

          const dbShopifyIds  = new Set((dbOrders ?? []).map(o => o.shopify_order_id as string))
          const missingFromDb = shopifyOrders.filter(o => !dbShopifyIds.has(String(o.id)))

          shopifyComparison = {
            shopify_orders_today:    shopifyOrders.length,
            db_orders_today_webhook: dbHoyWebhookRes.count ?? 0,
            db_orders_today_csv:     dbHoyCsvRes.count ?? 0,
            missing_from_db:         missingFromDb.length,
            missing_order_names:     missingFromDb.map(o => o.name ?? String(o.id)),
            note: missingFromDb.length > 0
              ? `ALERTA: ${missingFromDb.length} pedidos de Shopify HOY no están en DB. El webhook puede estar fallando.`
              : 'Todos los pedidos de Shopify de hoy están en DB.',
          }
        }
      } catch {
        // Shopify API falló — no es crítico para el diagnóstico
      }
    }

    return NextResponse.json({
      generatedAt: new Date().toISOString(),

      // Universo total
      totalOrders: totalRes.count ?? 0,

      // Con tracking
      withTracking: {
        total:           totalWithTracking,
        active:          activeWithTracking,
        inFinalStatus:   finalStatusRes.count ?? 0,
        byStatus:        Object.entries(withTrackingByStatus)
                           .sort((a, b) => b[1] - a[1])
                           .map(([status, count]) => ({ status, count })),
      },

      // Sin tracking (cron no los toca)
      withoutTracking: {
        total:          noTrackingRes.count ?? 0,
        pendingOnly:    pendingNoTrackingRes.count ?? 0,
        bySource:       noTrackingBySource,
        sample:         (noTrackingRes.data ?? []).slice(0, 20),
        note:           'Estos pedidos existen en DB pero el cron no los procesa porque no tienen tracking_number.',
      },

      // Finalizados (excluidos del cron para siempre)
      finalStatus: {
        returned:   withTrackingByStatus['returned']  ?? 0,
        delivered:  withTrackingByStatus['delivered'] ?? 0,
        cancelled:  cancelledRes.count ?? 0,
        note:       'Una vez en final status, el cron NUNCA vuelve a sincronizar. Si alguno fue clasificado incorrectamente, se quedará fijo.',
      },

      // Posibles clasificaciones incorrectas (returned/delivered recientes con raw_status activo)
      suspectFinalizations: {
        returned_with_active_raw:   suspectReturned.length,
        delivered_with_active_raw:  suspectDelivered.length,
        returned_sample:            suspectReturned,
        delivered_sample:           suspectDelivered,
        note: suspectReturned.length + suspectDelivered.length > 0
          ? 'ALERTA: Órdenes en final status con raw_status que parece activo. Posible clasificación prematura por el parser.'
          : 'No se detectaron finalizaciones sospechosas recientes.',
      },

      // Unknown (parser no pudo clasificar)
      unknownWithTracking: {
        count:  unknownWithTrackingRes.count ?? 0,
        sample: unknownWithTrackingRes.data ?? [],
        note:   'El parser extrajo info de EFI pero no pudo mapear el estado. Revisar body_sample en logs de Vercel.',
      },

      // Hoy — comparativa DB vs Shopify
      today: {
        db_webhook: dbHoyWebhookRes.count ?? 0,
        db_csv:     dbHoyCsvRes.count ?? 0,
        shopify:    shopifyComparison,
        today_range: today,
      },

      // Muestra de las últimas 50 guías con tracking
      recentTrackingSample: recentTrackingRes.data ?? [],
    })

  } catch (err) {
    console.error('[GET /api/debug/tracking-reconcile]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
