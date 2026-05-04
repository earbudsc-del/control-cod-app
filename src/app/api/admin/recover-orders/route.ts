import { NextResponse }          from 'next/server'
import { createClient }          from '@/lib/supabase/server'
import { createServiceClient }   from '@/lib/supabase/server'
import { createTaskIfNotExists } from '@/lib/tasks/auto-tasks'

const ACTIVE_STATUSES = [
  'pending', 'in_transit', 'out_for_delivery', 'en_reparto', 'novedad',
] as const

interface ShopifyAddress {
  name?:     string
  address1?: string
  city?:     string
  province?: string
  phone?:    string
}
interface ShopifyCustomer { first_name?: string; last_name?: string; phone?: string }
interface ShopifyLineItem  { title: string; variant_title?: string; quantity: number }
interface ShopifyOrder {
  id:                number
  name?:             string
  created_at?:       string
  total_price?:      string
  customer?:         ShopifyCustomer
  shipping_address?: ShopifyAddress
  billing_address?:  ShopifyAddress
  line_items?:       ShopifyLineItem[]
}

function buildSummary(items: ShopifyLineItem[]): string {
  return items.map(i => {
    const p = [i.title]
    if (i.variant_title) p.push(i.variant_title)
    if (i.quantity > 1)  p.push(`x${i.quantity}`)
    return p.join(' - ')
  }).join(', ')
}

export async function POST(request: Request) {
  try {
    // 1. Auth — solo admin
    const auth = await createClient()
    const { data: { user } } = await auth.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await auth
      .from('profiles').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
    }

    // 2. Env vars
    const shopDomain  = process.env.SHOPIFY_SHOP_DOMAIN
    const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
    if (!shopDomain || !accessToken) {
      return NextResponse.json({
        error: 'Faltan SHOPIFY_SHOP_DOMAIN y/o SHOPIFY_ADMIN_ACCESS_TOKEN en variables de entorno.',
      }, { status: 500 })
    }

    // 3. Parámetros opcionales de fecha (default: hoy completo en UTC)
    let body: { from?: string; to?: string } = {}
    try { body = await request.json() } catch { /* body vacío es válido */ }

    const from = body.from ?? '2026-05-03T00:00:00Z'
    const to   = body.to   ?? '2026-05-03T23:59:59Z'

    // 4. Llamar a Shopify Admin API con paginación
    const shopifyOrders: ShopifyOrder[] = []
    const fields = 'id,name,created_at,total_price,customer,shipping_address,billing_address,line_items'
    let url: string | null =
      `https://${shopDomain}/admin/api/2026-04/orders.json` +
      `?status=any&limit=250` +
      `&created_at_min=${encodeURIComponent(from)}` +
      `&created_at_max=${encodeURIComponent(to)}` +
      `&fields=${fields}`

    while (url) {
      const res: Response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        const txt = await res.text()
        return NextResponse.json({ error: `Shopify API ${res.status}: ${txt}` }, { status: 502 })
      }
      const data = (await res.json()) as { orders: ShopifyOrder[] }
      shopifyOrders.push(...(data.orders ?? []))

      const link:      string                  = res.headers.get('link') ?? ''
      const nextMatch: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/)
      url = nextMatch ? nextMatch[1] : null
    }

    const shopifyFound = shopifyOrders.length
    if (shopifyFound === 0) {
      return NextResponse.json({ shopify_found: 0, already_in_db: 0, inserted: 0, errors: [] })
    }

    // 5. Verificar cuáles ya existen en Supabase
    const service    = await createServiceClient()
    const shopifyIds = shopifyOrders.map(o => String(o.id))

    const { data: existingRows } = await service
      .from('orders')
      .select('shopify_order_id')
      .in('shopify_order_id', shopifyIds)

    const existingSet = new Set((existingRows ?? []).map(r => r.shopify_order_id as string))
    const alreadyInDb = shopifyOrders.filter(o => existingSet.has(String(o.id))).length

    // 6. Resolver tienda activa
    const { data: storeRow } = await service
      .from('stores').select('id').eq('is_active', true)
      .order('created_at', { ascending: true }).limit(1).maybeSingle()
    if (!storeRow) {
      return NextResponse.json({ error: 'No se encontró tienda activa.' }, { status: 404 })
    }
    const storeId = storeRow.id as string

    // 7. Insertar solo los faltantes
    let inserted = 0
    const errors: string[] = []

    for (const order of shopifyOrders) {
      const shopifyOrderId = String(order.id)
      if (existingSet.has(shopifyOrderId)) continue

      try {
        const addr = order.shipping_address ?? order.billing_address
        const customerName =
          [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') ||
          addr?.name || null
        const customerPhone = order.customer?.phone ?? addr?.phone ?? null

        // Detección de duplicados por teléfono
        let duplicateAlert        = false
        let duplicateOfOrderId: string | null = null
        let duplicateReason: string | null    = null

        if (customerPhone) {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
          const { data: dup } = await service
            .from('orders')
            .select('id, order_number, normalized_status')
            .eq('store_id', storeId)
            .eq('customer_phone', customerPhone)
            .in('normalized_status', [...ACTIVE_STATUSES])
            .gte('created_at', sevenDaysAgo)
            .order('created_at', { ascending: false })
            .limit(1).maybeSingle()
          if (dup) {
            duplicateAlert     = true
            duplicateOfOrderId = dup.id as string
            duplicateReason    = 'same_phone_recent_order'
          }
        }

        const { data: newOrder, error: insertErr } = await service
          .from('orders')
          .insert({
            store_id:              storeId,
            shopify_order_id:      shopifyOrderId,
            order_number:          order.name ?? null,
            customer_name:         customerName || null,
            customer_phone:        customerPhone,
            customer_address:      addr?.address1 ?? null,
            city:                  addr?.city ?? null,
            province:              addr?.province ?? null,
            product_summary:       order.line_items?.length ? buildSummary(order.line_items) : null,
            cod_amount:            order.total_price ? (parseFloat(order.total_price) || null) : null,
            normalized_status:     'pending',
            source:                'shopify_webhook',
            customer_confirmed:    false,
            shopify_created_at:    order.created_at ?? null,
            duplicate_alert:       duplicateAlert,
            duplicate_of_order_id: duplicateOfOrderId,
            duplicate_reason:      duplicateReason,
            updated_at:            new Date().toISOString(),
          })
          .select('id')
          .single()

        if (insertErr) {
          if (insertErr.code === '23505') continue  // ya existe — race condition
          errors.push(`${order.name ?? shopifyOrderId}: ${insertErr.message}`)
          continue
        }

        await createTaskIfNotExists(service, {
          orderId: newOrder.id as string, storeId, taskType: 'confirmation', priority: 'high',
        })

        inserted++
        console.log(`[recover-orders] ✓ ${shopifyOrderId} (${order.name ?? ''})`)

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${order.name ?? shopifyOrderId}: ${msg}`)
        console.error(`[recover-orders] Error ${shopifyOrderId}:`, err)
      }
    }

    console.log(`[recover-orders] Completado — encontrados: ${shopifyFound}, ya en DB: ${alreadyInDb}, insertados: ${inserted}, errores: ${errors.length}`)

    return NextResponse.json({
      shopify_found: shopifyFound,
      already_in_db: alreadyInDb,
      inserted,
      errors_count:  errors.length,
      errors,
    })

  } catch (err) {
    console.error('[POST /api/admin/recover-orders]', err)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
