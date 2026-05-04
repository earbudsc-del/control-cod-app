import { NextResponse }          from 'next/server'
import { createClient }          from '@/lib/supabase/server'
import { createServiceClient }   from '@/lib/supabase/server'
import { createTaskIfNotExists } from '@/lib/tasks/auto-tasks'

// ── Shopify API ────────────────────────────────────────────────────────────��──

const SHOPIFY_API_VERSION = '2024-07'

interface ShopifyAddress {
  name?:     string
  address1?: string
  city?:     string
  province?: string
  phone?:    string
}

interface ShopifyCustomer {
  first_name?: string
  last_name?:  string
  phone?:      string
}

interface ShopifyLineItem {
  title:          string
  variant_title?: string
  quantity:       number
}

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

// Estados activos para detección de duplicados — misma lista que el webhook
const ACTIVE_STATUSES = [
  'pending', 'in_transit', 'out_for_delivery', 'en_reparto', 'novedad',
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convierte un rango de fechas RD (YYYY-MM-DD) a timestamps UTC.
 * Medianoche RD = 04:00 UTC (UTC-4, sin DST).
 */
function rdDateRangeUTC(from: string, to: string): { min: string; max: string } {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const min = new Date(Date.UTC(fy, fm - 1, fd,     4, 0, 0, 0)).toISOString()
  const max = new Date(Date.UTC(ty, tm - 1, td + 1, 4, 0, 0, 0)).toISOString()
  return { min, max }
}

function buildProductSummary(items: ShopifyLineItem[]): string {
  return items
    .map(item => {
      const parts = [item.title]
      if (item.variant_title) parts.push(item.variant_title)
      if (item.quantity > 1)  parts.push(`x${item.quantity}`)
      return parts.join(' - ')
    })
    .join(', ')
}

/**
 * Descarga pedidos de Shopify Admin API con paginación via Link header.
 * Devuelve todos los pedidos del rango — sin límite de 250.
 */
async function fetchShopifyOrders(
  shopDomain:    string,
  accessToken:   string,
  createdAtMin:  string,
  createdAtMax:  string,
): Promise<ShopifyOrder[]> {
  const fields = 'id,name,created_at,total_price,customer,shipping_address,billing_address,line_items'
  const base   =
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders.json` +
    `?status=any&limit=250` +
    `&created_at_min=${encodeURIComponent(createdAtMin)}` +
    `&created_at_max=${encodeURIComponent(createdAtMax)}` +
    `&fields=${fields}`

  const all: ShopifyOrder[] = []
  let url: string | null = base

  while (url) {
    const res: Response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Shopify API ${res.status}: ${body}`)
    }

    const data = (await res.json()) as { orders: ShopifyOrder[] }
    all.push(...(data.orders ?? []))

    // Shopify paginación: header Link con rel="next"
    const link:      string                  = res.headers.get('link') ?? ''
    const nextMatch: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/)
    url = nextMatch ? nextMatch[1] : null
  }

  return all
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    // 1. Auth — solo admin
    const authSupabase = await createClient()
    const { data: { user } } = await authSupabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await authSupabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins pueden ejecutar esta operación' }, { status: 403 })
    }

    // 2. Verificar env vars
    const shopDomain  = process.env.SHOPIFY_SHOP_DOMAIN
    const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN

    if (!shopDomain || !accessToken) {
      return NextResponse.json({
        error: 'Configuración incompleta: faltan SHOPIFY_SHOP_DOMAIN y/o SHOPIFY_ADMIN_ACCESS_TOKEN en variables de entorno.',
      }, { status: 500 })
    }

    // 3. Parsear body
    let body: { from?: string; to?: string; order_numbers?: string[] }
    try {
      body = (await request.json()) as { from?: string; to?: string; order_numbers?: string[] }
    } catch {
      return NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 })
    }

    const { from, to, order_numbers } = body

    if (!from || !to) {
      return NextResponse.json({
        error: 'Se requieren los campos "from" y "to" en formato YYYY-MM-DD (zona horaria RD).',
      }, { status: 400 })
    }

    // Validar formato básico de fechas
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return NextResponse.json({ error: 'Formato de fecha inválido. Usar YYYY-MM-DD.' }, { status: 400 })
    }

    // 4. Rango UTC para la API de Shopify
    const { min: createdAtMin, max: createdAtMax } = rdDateRangeUTC(from, to)

    console.log(
      `[recover-shopify-orders] Iniciando — rango RD: ${from} → ${to}`,
      `(UTC: ${createdAtMin} → ${createdAtMax})`,
      order_numbers?.length ? `order_numbers: ${order_numbers.join(', ')}` : '',
    )

    // 5. Descargar pedidos de Shopify
    let shopifyOrders = await fetchShopifyOrders(shopDomain, accessToken, createdAtMin, createdAtMax)

    // Filtrar por order_numbers si se especificaron
    if (order_numbers && order_numbers.length > 0) {
      shopifyOrders = shopifyOrders.filter(o => order_numbers.includes(o.name ?? ''))
    }

    const shopifyFound = shopifyOrders.length

    if (shopifyFound === 0) {
      return NextResponse.json({
        shopify_found: 0,
        already_in_db: 0,
        inserted:      0,
        errors:        [],
        range:         { from, to, utc_min: createdAtMin, utc_max: createdAtMax },
        message:       'Shopify no devolvió pedidos para el rango indicado.',
      })
    }

    // 6. Comparar contra Supabase — buscar cuáles ya existen
    const service      = await createServiceClient()
    const shopifyIds   = shopifyOrders.map(o => String(o.id))

    const { data: existingRows } = await service
      .from('orders')
      .select('shopify_order_id')
      .in('shopify_order_id', shopifyIds)

    const existingSet  = new Set((existingRows ?? []).map(r => r.shopify_order_id as string))
    const alreadyInDb  = shopifyOrders.filter(o => existingSet.has(String(o.id))).length

    // 7. Resolver tienda — primero por shopify_domain, fallback a primera activa
    const { data: storeRow, error: storeError } = await service
      .from('stores')
      .select('*')
      .eq('shopify_domain', shopDomain)
      .eq('is_active', true)
      .maybeSingle()

    if (storeError) {
      console.error('[recover-shopify-orders] Error buscando tienda por shopify_domain:', storeError)
    }

    let resolvedStore = storeRow

    if (!resolvedStore) {
      console.warn(`[recover-shopify-orders] No se encontró tienda con shopify_domain="${shopDomain}", intentando fallback a primera tienda activa...`)

      const { data: fallbackStore, error: fallbackError } = await service
        .from('stores')
        .select('*')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()

      if (fallbackError) {
        console.error('[recover-shopify-orders] Error en fallback de tienda:', fallbackError)
      }

      if (!fallbackStore) {
        return NextResponse.json({
          error: 'No se encontró tienda activa en la base de datos.',
          shopify_domain_buscado: shopDomain,
          storeError:   storeError?.message   ?? null,
          fallbackError: fallbackError?.message ?? null,
        }, { status: 404 })
      }

      resolvedStore = fallbackStore
      console.log(`[recover-shopify-orders] Tienda resuelta por fallback: id=${resolvedStore.id}`)
    } else {
      console.log(`[recover-shopify-orders] Tienda resuelta por shopify_domain: id=${resolvedStore.id}`)
    }

    const storeId = resolvedStore.id as string

    // 8. Insertar pedidos faltantes
    let inserted = 0
    const errors: string[] = []

    for (const order of shopifyOrders) {
      const shopifyOrderId = String(order.id)

      // Ya existe — saltar
      if (existingSet.has(shopifyOrderId)) continue

      try {
        const addr = order.shipping_address ?? order.billing_address

        const customerName =
          [order.customer?.first_name, order.customer?.last_name]
            .filter(Boolean)
            .join(' ') ||
          addr?.name ||
          null

        const customerPhone = order.customer?.phone ?? addr?.phone ?? null

        // Detección de duplicados por teléfono — igual que el webhook
        let duplicateAlert        = false
        let duplicateOfOrderId: string | null = null
        let duplicateReason: string | null    = null

        if (customerPhone) {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

          const { data: potentialDup } = await service
            .from('orders')
            .select('id, order_number, normalized_status')
            .eq('store_id', storeId)
            .eq('customer_phone', customerPhone)
            .in('normalized_status', [...ACTIVE_STATUSES])
            .gte('created_at', sevenDaysAgo)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (potentialDup) {
            duplicateAlert     = true
            duplicateOfOrderId = potentialDup.id as string
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
            product_summary:       order.line_items?.length
                                     ? buildProductSummary(order.line_items)
                                     : null,
            cod_amount:            order.total_price
                                     ? (parseFloat(order.total_price) || null)
                                     : null,
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
          // 23505 = unique_violation — race condition, el pedido ya existe
          if (insertErr.code === '23505') continue
          errors.push(`${order.name ?? shopifyOrderId}: ${insertErr.message}`)
          continue
        }

        await createTaskIfNotExists(service, {
          orderId:  newOrder.id as string,
          storeId,
          taskType: 'confirmation',
          priority: 'high',
        })

        inserted++
        console.log(`[recover-shopify-orders] ✓ Insertado: ${shopifyOrderId} (${order.name ?? ''})`)

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${order.name ?? shopifyOrderId}: ${msg}`)
        console.error(`[recover-shopify-orders] Error procesando ${shopifyOrderId}:`, err)
      }
    }

    console.log(
      `[recover-shopify-orders] Completado — encontrados: ${shopifyFound},`,
      `ya en DB: ${alreadyInDb}, insertados: ${inserted}, errores: ${errors.length}`,
    )

    return NextResponse.json({
      shopify_found: shopifyFound,
      already_in_db: alreadyInDb,
      inserted,
      errors_count:  errors.length,
      errors,
      range: { from, to, utc_min: createdAtMin, utc_max: createdAtMax },
    })

  } catch (err) {
    console.error('[POST /api/admin/recover-shopify-orders]', err)
    return NextResponse.json({ error: 'Error interno al procesar la recuperación.' }, { status: 500 })
  }
}
