import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse }        from 'next/server'

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

interface ShopifyCustomer {
  first_name?: string
  last_name?:  string
  email?:      string
  phone?:      string
}

interface ShopifyDraftOrder {
  id:           number
  name:         string        // "#D2256"
  status:       string        // "open" | "invoice_sent" | "completed"
  email?:       string
  completed_at: string | null
  created_at:   string
  updated_at:   string
  total_price:  string
  invoice_url?: string
  customer?:    ShopifyCustomer
  shipping_address?: ShopifyAddress
  billing_address?:  ShopifyAddress
  line_items?:       ShopifyLineItem[]
  note_attributes?:  { name: string; value: string }[]
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

// Paginación genérica via Link header (reutilizada por checkouts y draft orders)
async function paginatedFetch<T>(
  baseUrl:     string,
  accessToken: string,
  jsonKey:     string,
): Promise<T[]> {
  const results: T[] = []
  let nextUrl: string | null = baseUrl

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
      throw new Error(`Shopify API ${res.status}: ${body.slice(0, 300)}`)
    }
    const json = await res.json() as Record<string, T[]>
    results.push(...(json[jsonKey] ?? []))

    const linkHeader: string = res.headers.get('link') ?? ''
    const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
    nextUrl = nextMatch ? nextMatch[1]! : null
  }

  return results
}

async function fetchShopifyCheckouts(
  shopDomain:  string,
  accessToken: string,
): Promise<ShopifyCheckout[]> {
  const createdAtMax = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const createdAtMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  return paginatedFetch<ShopifyCheckout>(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/checkouts.json` +
    `?status=open&limit=250` +
    `&created_at_min=${encodeURIComponent(createdAtMin)}` +
    `&created_at_max=${encodeURIComponent(createdAtMax)}`,
    accessToken,
    'checkouts',
  )
}

async function fetchShopifyDraftOrders(
  shopDomain:  string,
  accessToken: string,
): Promise<ShopifyDraftOrder[]> {
  // Ventana de 90 días para draft orders (más amplia que checkouts)
  const updatedAtMin = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

  // Traer open + invoice_sent en paralelo (ambos estados son "pendientes de completar")
  const [open, invoiceSent] = await Promise.all([
    paginatedFetch<ShopifyDraftOrder>(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/draft_orders.json` +
      `?status=open&limit=250&updated_at_min=${encodeURIComponent(updatedAtMin)}`,
      accessToken,
      'draft_orders',
    ),
    paginatedFetch<ShopifyDraftOrder>(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/draft_orders.json` +
      `?status=invoice_sent&limit=250&updated_at_min=${encodeURIComponent(updatedAtMin)}`,
      accessToken,
      'draft_orders',
    ),
  ])

  return [...open, ...invoiceSent]
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST() {
  try {
    // Auth
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('role').eq('id', user.id).single()
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

    const svc = await createServiceClient()

    // Resolver store_id
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

    // ── Fetch paralelo: checkouts + draft orders ──────────────────────────────

    let checkouts:   ShopifyCheckout[]   = []
    let draftOrders: ShopifyDraftOrder[] = []
    let draftScopeError: string | null   = null

    const [checkoutResult, draftResult] = await Promise.allSettled([
      fetchShopifyCheckouts(shopDomain, accessToken),
      fetchShopifyDraftOrders(shopDomain, accessToken),
    ])

    if (checkoutResult.status === 'fulfilled') {
      checkouts = checkoutResult.value.filter(c => !c.completed_at)
    } else {
      console.warn('[sync] checkouts fetch error:', checkoutResult.reason)
    }

    if (draftResult.status === 'fulfilled') {
      draftOrders = draftResult.value
    } else {
      const errMsg = String(draftResult.reason)
      if (errMsg.includes('403') || errMsg.toLowerCase().includes('scope')) {
        draftScopeError = 'Falta el scope read_draft_orders en la app de Shopify. Ve a Shopify Partners → App → Scopes y agrega read_draft_orders.'
      } else {
        draftScopeError = `Error al cargar draft orders: ${errMsg.slice(0, 200)}`
      }
      console.warn('[sync] draft orders fetch error:', draftResult.reason)
    }

    // ── Contadores ────────────────────────────────────────────────────────────

    let checkoutNew  = 0, checkoutUpdated = 0
    let draftNew     = 0, draftUpdated    = 0, draftRecovered = 0
    const errors: string[] = []

    // ── Procesar checkouts abandonados ────────────────────────────────────────

    for (const checkout of checkouts) {
      try {
        const attrs = checkout.note_attributes ?? []
        const ship  = checkout.shipping_address ?? checkout.billing_address

        const name     = getNote(attrs, 'nombre')    ?? ship?.name     ?? null
        const phone    = getNote(attrs, 'whatsapp')  ?? getNote(attrs, 'telefono') ?? ship?.phone ?? null
        const joined   = [ship?.address1, ship?.address2].filter(Boolean).join(', ')
        const address  = getNote(attrs, 'dirección') ?? getNote(attrs, 'direccion') ?? (joined || null)
        const city     = getNote(attrs, 'ciudad')    ?? ship?.city     ?? null
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
          source:              'shopify_abandoned_checkout',
        }

        const { data: existing } = await svc
          .from('abandoned_carts')
          .select('id')
          .eq('store_id', storeId)
          .eq('shopify_checkout_id', String(checkout.id))
          .maybeSingle()

        if (!existing) {
          await svc.from('abandoned_carts').insert(row)
          checkoutNew++
        } else {
          const { shopify_checkout_id: _cid, store_id: _sid, ...updateFields } = row
          await svc
            .from('abandoned_carts')
            .update({ ...updateFields, updated_at: new Date().toISOString() })
            .eq('id', existing.id)
          checkoutUpdated++
        }
      } catch (e) {
        errors.push(`checkout ${checkout.id}: ${String(e)}`)
      }
    }

    // ── Procesar draft orders ─────────────────────────────────────────────────

    for (const draft of draftOrders) {
      try {
        const attrs    = draft.note_attributes ?? []
        const ship     = draft.shipping_address ?? draft.billing_address
        const customer = draft.customer

        // Prioridad: note_attributes → shipping → billing → customer
        const name =
          getNote(attrs, 'nombre') ??
          ship?.name               ??
          ([customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || null)

        const phone =
          getNote(attrs, 'whatsapp')            ??
          getNote(attrs, 'telefono')            ??
          ship?.phone                           ??
          customer?.phone                       ??
          null

        const email =
          draft.email            ??
          customer?.email        ??
          null

        const joined  = [ship?.address1, ship?.address2].filter(Boolean).join(', ')
        const address = getNote(attrs, 'dirección') ?? getNote(attrs, 'direccion') ?? (joined || null)
        const city    = getNote(attrs, 'ciudad')    ?? ship?.city     ?? null
        const province = getNote(attrs, 'provincia') ?? ship?.province ?? null

        // Si el draft ya fue completado → marcar carrito existente como recovered y saltar
        if (draft.completed_at) {
          const { data: existingDraft } = await svc
            .from('abandoned_carts')
            .select('id, recovery_status')
            .eq('store_id', storeId)
            .eq('shopify_draft_order_id', String(draft.id))
            .maybeSingle()

          if (existingDraft && !['recovered', 'discarded'].includes(existingDraft.recovery_status)) {
            await svc
              .from('abandoned_carts')
              .update({
                recovery_status:    'recovered',
                draft_status:       draft.status,
                completed_at:       draft.completed_at,
                updated_at:         new Date().toISOString(),
              })
              .eq('id', existingDraft.id)
            draftRecovered++
            console.log(`[sync drafts] auto-recovered draft ${draft.name} (completed_at set)`)
          }
          continue // no insertar drafts completados
        }

        const draftRow = {
          store_id:                storeId,
          shopify_draft_order_id:  String(draft.id),
          shopify_draft_order_name: draft.name,
          draft_status:            draft.status,
          customer_name:           name,
          customer_phone:          phone,
          customer_email:          email,
          products_summary:        buildProductSummary(draft.line_items),
          total_amount:            parseFloat(draft.total_price) || null,
          currency:                'DOP',
          checkout_url:            draft.invoice_url ?? null,
          customer_address:        address,
          city,
          province,
          abandoned_at:            draft.updated_at ?? draft.created_at,
          source:                  'shopify_draft_order',
        }

        const { data: existing } = await svc
          .from('abandoned_carts')
          .select('id')
          .eq('store_id', storeId)
          .eq('shopify_draft_order_id', String(draft.id))
          .maybeSingle()

        if (!existing) {
          await svc.from('abandoned_carts').insert(draftRow)
          draftNew++
        } else {
          const { shopify_draft_order_id: _did, store_id: _sid, ...updateFields } = draftRow
          await svc
            .from('abandoned_carts')
            .update({ ...updateFields, updated_at: new Date().toISOString() })
            .eq('id', existing.id)
          draftUpdated++
        }
      } catch (e) {
        errors.push(`draft ${draft.name}: ${String(e)}`)
      }
    }

    // ── Logs ──────────────────────────────────────────────────────────────────

    console.log(
      `[sync abandoned-carts]` +
      ` checkouts: fetched=${checkouts.length} new=${checkoutNew} updated=${checkoutUpdated}` +
      ` | drafts: fetched=${draftOrders.length} new=${draftNew} updated=${draftUpdated} recovered=${draftRecovered}` +
      ` | errors=${errors.length}`,
    )

    if (draftOrders.length === 0 && !draftScopeError) {
      console.log('[sync drafts] 0 draft orders — ¿el flujo COD crea drafts? Verifica en Shopify Admin → Orders → Drafts.')
    }
    if (checkouts.length === 0 && !draftScopeError) {
      console.log('[sync checkouts] 0 checkouts — ESPERADO si el flujo es COD form sin checkout nativo.')
    }

    return NextResponse.json({
      checkouts: {
        synced:  checkouts.length,
        new:     checkoutNew,
        updated: checkoutUpdated,
      },
      drafts: {
        synced:    draftOrders.length,
        new:       draftNew,
        updated:   draftUpdated,
        recovered: draftRecovered,
      },
      errors:          errors.length,
      errorLog:        errors.slice(0, 5),
      ...(draftScopeError  && { draftScopeError }),
    })
  } catch (err) {
    console.error('[POST /api/abandoned-carts/sync]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
