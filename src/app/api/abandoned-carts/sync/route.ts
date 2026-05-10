import { createClient }         from '@/lib/supabase/server'
import { createServiceClient }  from '@/lib/supabase/server'
import { NextResponse }         from 'next/server'

const SHOPIFY_API_VERSION = '2024-07'
const ALLOWED_ROLES = ['admin', 'ia_supervisor', 'confirmation_agent'] as const

// ── Tipos Shopify ─────────────────────────────────────────────────────────────

interface ShopifyAddress {
  name?:     string
  address1?: string
  address2?: string
  city?:     string
  province?: string
  phone?:    string
}

interface ShopifyLineItem {
  title:          string
  variant_title?: string
  quantity:       number
}

interface ShopifyCheckout {
  id:                      number
  token:                   string
  email?:                  string
  completed_at:            string | null
  created_at:              string
  updated_at:              string
  total_price:             string
  abandoned_checkout_url?: string
  shipping_address?:       ShopifyAddress
  billing_address?:        ShopifyAddress
  line_items?:             ShopifyLineItem[]
  note_attributes?:        { name: string; value: string }[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getNote(attrs: { name: string; value: string }[], key: string): string | null {
  const found = attrs.find(a => a.name.toLowerCase().includes(key.toLowerCase()))
  return found?.value?.trim() || null
}

function buildProductSummary(items: ShopifyLineItem[] | undefined): string {
  if (!items?.length) return ''
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
 * Descarga checkouts abandonados de Shopify con paginación via Link header.
 * status=open devuelve checkouts con completed_at IS NULL.
 */
async function fetchShopifyCheckouts(
  shopDomain:  string,
  accessToken: string,
): Promise<ShopifyCheckout[]> {
  const results: ShopifyCheckout[] = []

  // Solo checkouts con >10 min de antigüedad y últimos 30 días
  const createdAtMax = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const createdAtMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  let nextUrl: string | null =
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/checkouts.json` +
    `?status=open&limit=250` +
    `&created_at_min=${encodeURIComponent(createdAtMin)}` +
    `&created_at_max=${encodeURIComponent(createdAtMax)}`

  while (nextUrl) {
    const currentUrl: string = nextUrl
    const res: Response = await fetch(currentUrl, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Shopify checkouts API ${res.status}: ${body}`)
    }
    const json = await res.json() as { checkouts: ShopifyCheckout[] }
    results.push(...(json.checkouts ?? []))

    // Paginación via Link header
    const linkHeader: string = res.headers.get('link') ?? ''
    const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
    nextUrl = nextMatch ? nextMatch[1]! : null
  }

  return results
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
    if (!ALLOWED_ROLES.includes(profile?.role as never)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const shopDomain  = process.env.SHOPIFY_SHOP_DOMAIN
    const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
    if (!shopDomain || !accessToken) {
      return NextResponse.json(
        { error: 'SHOPIFY_SHOP_DOMAIN o SHOPIFY_ADMIN_ACCESS_TOKEN no configurados' },
        { status: 500 },
      )
    }

    // Service client para bypass RLS en upsert masivo
    const svc = await createServiceClient()

    // Obtener store_id desde la tienda activa
    const { data: storeData, error: storeError } = await svc
      .from('stores')
      .select('id')
      .eq('shopify_domain', shopDomain.trim().toLowerCase())
      .single()

    if (storeError || !storeData) {
      return NextResponse.json(
        { error: 'Tienda no encontrada', detail: storeError?.message },
        { status: 404 },
      )
    }
    const storeId = storeData.id

    // Descargar checkouts de Shopify
    const checkouts = await fetchShopifyCheckouts(shopDomain, accessToken)
    // Filtrar: solo los que no están completados (paranoia — la API ya filtra)
    const abandoned = checkouts.filter(c => !c.completed_at)

    let newCount     = 0
    let updatedCount = 0
    const errors: string[] = []

    for (const checkout of abandoned) {
      try {
        const attrs = checkout.note_attributes ?? []
        const ship  = checkout.shipping_address ?? checkout.billing_address

        // Prioridad: note_attributes → shipping_address
        const name     = getNote(attrs, 'nombre') ?? ship?.name ?? null
        const phone    = getNote(attrs, 'whatsapp') ?? getNote(attrs, 'telefono') ?? ship?.phone ?? null
        const joined   = [ship?.address1, ship?.address2].filter(Boolean).join(', ')
        const address  = getNote(attrs, 'dirección') ?? getNote(attrs, 'direccion') ?? (joined || null)
        const city     = getNote(attrs, 'ciudad')   ?? ship?.city     ?? null
        const province = getNote(attrs, 'provincia') ?? ship?.province ?? null

        const row = {
          store_id:            storeId,
          shopify_checkout_id: String(checkout.id),
          customer_name:       name,
          customer_phone:      phone,
          customer_email:      checkout.email ?? null,
          products_summary:    buildProductSummary(checkout.line_items),
          total_amount:        parseFloat(checkout.total_price) || null,
          currency:            'DOP',
          checkout_url:        checkout.abandoned_checkout_url ?? null,
          customer_address:    address,
          city,
          province,
          abandoned_at:        checkout.updated_at ?? checkout.created_at,
          source:              'shopify',
        }

        // Verificar si ya existe para preservar recovery_status y notes del agente
        const { data: existing } = await svc
          .from('abandoned_carts')
          .select('id')
          .eq('store_id', storeId)
          .eq('shopify_checkout_id', String(checkout.id))
          .maybeSingle()

        if (!existing) {
          await svc.from('abandoned_carts').insert(row)
          newCount++
        } else {
          // Solo actualizar datos del carrito, preservar estado de recuperación y notas
          const { shopify_checkout_id: _cid, store_id: _sid, ...updateFields } = row
          await svc
            .from('abandoned_carts')
            .update({ ...updateFields, updated_at: new Date().toISOString() })
            .eq('id', existing.id)
          updatedCount++
        }
      } catch (e) {
        errors.push(`checkout ${checkout.id}: ${String(e)}`)
      }
    }

    console.log(
      `[sync abandoned-carts] fetched=${abandoned.length} new=${newCount} updated=${updatedCount} errors=${errors.length}`,
    )

    return NextResponse.json({
      synced:   abandoned.length,
      new:      newCount,
      updated:  updatedCount,
      errors:   errors.length,
      errorLog: errors.slice(0, 5),
    })
  } catch (err) {
    console.error('[POST /api/abandoned-carts/sync]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
