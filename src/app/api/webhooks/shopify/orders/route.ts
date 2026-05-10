import { NextResponse }          from 'next/server'
import crypto                    from 'crypto'
import { createServiceClient }   from '@/lib/supabase/server'
import { createTaskIfNotExists } from '@/lib/tasks/auto-tasks'

// ── Shopify payload types ─────────────────────────────────────────────────────

interface ShopifyAddress {
  name?:     string
  address1?: string
  address2?: string
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

interface ShopifyOrderPayload {
  id:                number
  name?:             string    // e.g. "#1001"
  created_at?:       string
  total_price?:      string
  phone?:            string
  customer?:         ShopifyCustomer
  shipping_address?: ShopifyAddress
  billing_address?:  ShopifyAddress
  line_items?:       ShopifyLineItem[]
  note_attributes?:  { name: string; value: string }[]
}

// Statuses que indican un pedido aún activo en normalized_status.
// Nota: 'confirmed' vive en confirmation_status, 'rescheduled' en follow_up_result —
// ninguno es un normalized_status válido en el schema, por eso no aparecen aquí.
const ACTIVE_STATUSES = [
  'pending',
  'in_transit',
  'out_for_delivery',
  'en_reparto',
  'novedad',
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function verifyHmac(rawBody: string, hmacHeader: string, secret: string): boolean {
  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64')
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader))
  } catch {
    return false
  }
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

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const rawShop = request.headers.get('x-shopify-shop-domain')
  console.log('[webhook-diag] RAW SHOP HEADER:', rawShop)

  // ── DIAG: entrada ─────────────────────────────────────────────────────────────
  const diagShop    = request.headers.get('x-shopify-shop-domain') ?? '(sin header)'
  const diagTopic   = request.headers.get('x-shopify-topic')       ?? '(sin header)'
  const diagHmacRaw = request.headers.get('x-shopify-hmac-sha256') ?? ''
  console.log('[webhook-diag] ► REQUEST RECIBIDA', new Date().toISOString())
  console.log('[webhook-diag] shop:', diagShop)
  console.log('[webhook-diag] topic:', diagTopic)
  console.log('[webhook-diag] hmac presente:', diagHmacRaw.length > 0, '— longitud:', diagHmacRaw.length)
  console.log('[webhook-diag] SERVICE_ROLE_KEY EXISTS:', !!process.env.SUPABASE_SERVICE_ROLE_KEY)
  console.log('[webhook-diag] WEBHOOK_SECRET EXISTS:', !!process.env.SHOPIFY_WEBHOOK_SECRET)
  // ─────────────────────────────────────────────────────────────────────────────

  // 1. Leer raw body antes de cualquier parse (necesario para verificar HMAC)
  const rawBody = await request.text()
  console.log('[webhook-diag] body_bytes:', rawBody.length)

  // 2. Verificar HMAC con timing-safe compare
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET
  if (!webhookSecret) {
    console.error('[shopify-webhook] SHOPIFY_WEBHOOK_SECRET no configurado')
    console.error('[webhook-diag] ✖ STATUS 500 — WEBHOOK_SECRET faltante')
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })
  }

  const hmacHeader = request.headers.get('x-shopify-hmac-sha256') ?? ''
  const shopDomain = request.headers.get('x-shopify-shop-domain') ?? ''

  const hmacValid = verifyHmac(rawBody, hmacHeader, webhookSecret)
  console.log('[webhook-diag] HMAC válido:', hmacValid)

  if (!hmacValid) {
    console.warn(
      '[shopify-webhook] HMAC inválido — request rechazado.',
      'shop:', shopDomain || '(sin header)',
      'body_bytes:', rawBody.length,
      'hmac_header_length:', hmacHeader.length,
    )
    console.error('[webhook-diag] ✖ STATUS 401 — HMAC inválido')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 3. Parsear JSON
  let payload: ShopifyOrderPayload
  try {
    payload = JSON.parse(rawBody) as ShopifyOrderPayload
  } catch {
    console.error('[shopify-webhook] JSON inválido — shop:', shopDomain)
    console.error('[webhook-diag] ✖ STATUS 400 — JSON inválido')
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  console.log('[webhook-diag] shopify_order_id:', String(payload.id), '— order_name:', payload.name ?? '(sin nombre)')

  console.log(
    '[shopify-webhook] ✓ Recibido:',
    String(payload.id), payload.name ?? '',
    'shop:', shopDomain || '(sin header)',
  )
  const supabase = await createServiceClient()

  // 4. Resolver tienda
  //    Primero por shopify_domain exacto; si no coincide, usa la primera tienda activa.

  // DIAG: confirmar env vars y valor usado para lookup
  console.log('[webhook-diag] SUPABASE_URL:', process.env.NEXT_PUBLIC_SUPABASE_URL)
  console.log('[webhook-diag] SERVICE_ROLE_EXISTS:', !!process.env.SUPABASE_SERVICE_ROLE_KEY)
  console.log('[webhook-diag] shop used for lookup:', shopDomain)

  // DIAG: listar todas las tiendas visibles desde este cliente Supabase
  const { data: allStores, error: allStoresError } = await supabase
    .from('stores')
    .select('id, shopify_domain, is_active')
  console.log('[webhook-diag] all stores visible from webhook:', allStores)
  console.log('[webhook-diag] all stores error:', allStoresError)

  let storeId: string | null = null

  if (shopDomain) {
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id')
      .eq('shopify_domain', shopDomain)
      .eq('is_active', true)
      .maybeSingle()
    console.log('[webhook-diag] store lookup data:', store)
    console.log('[webhook-diag] store lookup error:', storeError)
    storeId = store?.id ?? null
  }

  if (!storeId) {
    const { data, error: storeErrFallback } = await supabase
      .from('stores')
      .select('id')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    storeId = data?.id ?? null
    if (storeErrFallback) console.error('[webhook-diag] Error en fallback tienda:', storeErrFallback.message)
    console.log('[webhook-diag] tienda por fallback:', storeId ?? 'no encontrada')
  }

  if (!storeId) {
    console.error('[shopify-webhook] No se encontró tienda activa — shop_domain_header:', shopDomain || '(vacío)')
    console.error('[webhook-diag] ✖ STATUS 404 — tienda no encontrada')
    return NextResponse.json({ error: 'Store not found' }, { status: 404 })
  }

  console.log('[shopify-webhook] Tienda resuelta:', storeId, '— domain:', shopDomain || '(fallback primera tienda)')

  const shopifyOrderId = String(payload.id)

  // 5. Idempotencia — evitar duplicados ante reintentos de Shopify
  const { data: existing } = await supabase
    .from('orders')
    .select('id')
    .eq('store_id', storeId)
    .eq('shopify_order_id', shopifyOrderId)
    .maybeSingle()

  if (existing) {
    console.log('[webhook-diag] idempotente — shopify_order_id ya existe:', shopifyOrderId)
    console.log('[shopify-webhook] Idempotente (ya existe):', shopifyOrderId, '→ order_id:', existing.id)
    // Asegurar que la task existe aunque la primera request haya fallado a mitad
    await createTaskIfNotExists(supabase, {
      orderId:  existing.id,
      storeId,
      taskType: 'confirmation',
      priority: 'high',
    })
    return NextResponse.json({ ok: true, duplicate: true, order_id: existing.id })
  }

  // 6. Mapear campos del payload — note_attributes tiene prioridad sobre shipping/billing
  const shipping = payload.shipping_address || {}
  const billing  = payload.billing_address  || {}
  const customer = payload.customer         || {}
  const notes    = payload.note_attributes  || []

  const getNote = (key: string) =>
    notes.find(n => n.name?.toLowerCase().includes(key))?.value || null

  const note_name     = getNote('nombre')
  const note_phone    = getNote('whatsapp') || getNote('telefono')
  const note_address  = getNote('dirección') || getNote('direccion')
  const note_city     = getNote('ciudad')
  const note_province = getNote('provincia')

  const customerName =
    note_name ||
    shipping.name ||
    `${customer.first_name || ''} ${customer.last_name || ''}`.trim() ||
    billing.name ||
    null

  const customerPhone =
    note_phone    ||
    shipping.phone ||
    billing.phone  ||
    customer.phone ||
    payload.phone  ||
    null

  const customerAddress =
    note_address ||
    [shipping.address1, shipping.address2].filter(Boolean).join(' ') ||
    [billing.address1,  billing.address2 ].filter(Boolean).join(' ') ||
    null

  const customerCity =
    note_city    ||
    shipping.city ||
    billing.city  ||
    null

  const customerProvince =
    note_province    ||
    shipping.province ||
    billing.province  ||
    null

  // 7. Detectar posible pedido duplicado por teléfono
  //    No bloquea la creación — solo marca el pedido para revisión del agente.
  let duplicateAlert        = false
  let duplicateOfOrderId: string | null = null
  let duplicateReason: string | null    = null
  let duplicateNoteText:  string | null = null   // solo para la nota interna — no va a DB

  if (customerPhone) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data: potentialDup } = await supabase
      .from('orders')
      .select('id, order_number, normalized_status')
      .eq('store_id', storeId)
      .eq('customer_phone', customerPhone)
      .in('normalized_status', ACTIVE_STATUSES)
      .gte('created_at', sevenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (potentialDup) {
      duplicateAlert     = true
      duplicateOfOrderId = potentialDup.id
      duplicateReason    = 'same_phone_recent_order'   // código para el frontend/filtros
      duplicateNoteText  =                             // texto legible para el agente
        `Mismo teléfono que pedido ${potentialDup.order_number ?? potentialDup.id} ` +
        `(estado: ${potentialDup.normalized_status})`
    }
  }

  // 8. Construir fila e insertar
  const orderRow = {
    store_id:              storeId,
    shopify_order_id:      shopifyOrderId,
    order_number:          payload.name ?? null,
    customer_name:         customerName    || null,
    customer_phone:        customerPhone,
    customer_address:      customerAddress || null,
    city:                  customerCity    || null,
    province:              customerProvince || null,
    product_summary:       payload.line_items?.length
                             ? buildProductSummary(payload.line_items)
                             : null,
    cod_amount:            payload.total_price
                             ? (parseFloat(payload.total_price) || null)
                             : null,
    normalized_status:     'pending',
    source:                'shopify_webhook',
    customer_confirmed:    false,
    shopify_created_at:    payload.created_at ?? null,
    duplicate_alert:       duplicateAlert,
    duplicate_of_order_id: duplicateOfOrderId,
    duplicate_reason:      duplicateReason,
    updated_at:            new Date().toISOString(),
  }

  const { data: newOrder, error: insertErr } = await supabase
    .from('orders')
    .insert(orderRow)
    .select('id')
    .single()

  if (insertErr) {
    // Código 23505 = unique_violation — carrera entre dos requests simultáneos
    if (insertErr.code === '23505') {
      console.log('[webhook-diag] unique_violation 23505 — race condition, buscando existente')
      const { data: dup } = await supabase
        .from('orders')
        .select('id')
        .eq('store_id', storeId)
        .eq('shopify_order_id', shopifyOrderId)
        .maybeSingle()
      if (dup) {
        await createTaskIfNotExists(supabase, {
          orderId:  dup.id,
          storeId,
          taskType: 'confirmation',
          priority: 'high',
        })
      }
      console.log('[webhook-diag] ✓ STATUS 200 — idempotente (race condition)')
      return NextResponse.json({ ok: true, duplicate: true, order_id: dup?.id ?? null })
    }
    console.error('[shopify-webhook] Error al insertar pedido:', insertErr)
    console.error('[webhook-diag] ✖ STATUS 500 — insert falló. code:', insertErr.code, '| message:', insertErr.message, '| details:', insertErr.details)
    return NextResponse.json({ error: 'Failed to save order' }, { status: 500 })
  }

  // 9. Si hay alerta de duplicado, insertar nota interna para el agente
  if (duplicateAlert && duplicateNoteText) {
    await supabase.from('notes').insert({
      order_id:   newOrder.id,
      created_by: null,    // nota de sistema
      content:    `⚠️ Posible pedido duplicado: ${duplicateNoteText}. Verificar antes de confirmar o despachar.`,
    })
  }

  // 10. Crear tarea de confirmación (usa la misma función del cron — no duplica)
  await createTaskIfNotExists(supabase, {
    orderId:  newOrder.id,
    storeId,
    taskType: 'confirmation',
    priority: 'high',
  })

  // 11. Auto-recuperar carritos abandonados por phone match
  //     Cuando un pedido entra, marca como 'recovered' cualquier carrito pendiente
  //     del mismo teléfono (coincidencia normalizada sin dígitos).
  if (customerPhone) {
    try {
      const normalizedIncoming = customerPhone.replace(/\D/g, '')
      const { data: pendingCarts } = await supabase
        .from('abandoned_carts')
        .select('id, customer_phone')
        .eq('store_id', storeId)
        .not('recovery_status', 'in', '(recovered,discarded)')
        .limit(500)

      if (pendingCarts?.length) {
        const matchIds = pendingCarts
          .filter(c => {
            if (!c.customer_phone) return false
            return c.customer_phone.replace(/\D/g, '') === normalizedIncoming
          })
          .map(c => c.id)

        if (matchIds.length > 0) {
          await supabase
            .from('abandoned_carts')
            .update({
              recovery_status:    'recovered',
              recovered_order_id: shopifyOrderId,
              updated_at:         new Date().toISOString(),
            })
            .in('id', matchIds)
          console.log(
            `[shopify-webhook] auto-recovered ${matchIds.length} abandoned cart(s)` +
            ` — phone match ${normalizedIncoming} — order ${shopifyOrderId}`,
          )
        }
      }
    } catch (cartErr) {
      // No crítico — no afecta el flujo principal del pedido
      console.warn('[shopify-webhook] error auto-recovering abandoned carts:', String(cartErr))
    }
  }

  console.log(
    `[shopify-webhook] Pedido ${shopifyOrderId} (${payload.name ?? ''}) guardado` +
    (duplicateAlert ? ` — ALERTA DUPLICADO: ${duplicateNoteText}` : '') +
    ` → tarea confirmation creada`,
  )
  console.log('[webhook-diag] ✓ STATUS 200 — pedido insertado. order_id:', newOrder.id)

  return NextResponse.json({
    ok:              true,
    order_id:        newOrder.id,
    duplicate_alert: duplicateAlert,
  })
}
