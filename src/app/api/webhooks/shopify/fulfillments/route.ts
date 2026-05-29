import { NextResponse }        from 'next/server'
import crypto                  from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'

// ── Shopify payload types ─────────────────────────────────────────────────────

interface ShopifyFulfillmentPayload {
  id:                number
  order_id:          number
  tracking_number?:  string | null
  tracking_numbers?: string[]
  tracking_company?: string | null
  status?:           string
}

// Statuses where it's safe to transition to in_transit.
// Never touch: novedad, en_reparto, delivered, returned, cancelled
const SAFE_TO_TRANSIT = new Set(['pending', 'unknown', null, undefined])

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

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const topic      = request.headers.get('x-shopify-topic')       ?? ''
  const shopDomain = request.headers.get('x-shopify-shop-domain') ?? ''
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256') ?? ''

  // ── DIAG 1: log immediately (before HMAC) so we know this handler was reached ──
  console.log(
    '[fulfillment-webhook] RECEIVED — handler=/api/webhooks/shopify/fulfillments',
    '| topic:', topic || '(no topic header)',
    '| shop:', shopDomain || '(no shop header)',
    '| hmac_present:', hmacHeader ? 'yes' : 'NO',
  )

  // Warn if topic is unexpected — Shopify may send orders/updated instead of fulfillments/create
  if (topic && !topic.startsWith('fulfillments/')) {
    console.warn(
      '[fulfillment-webhook] UNEXPECTED TOPIC — expected fulfillments/create or fulfillments/update, got:',
      topic,
      '— will still attempt to process',
    )
  }

  console.log('[fulfillment-webhook] topic recibido:', topic || '(vacío)')

  // 1. Read raw body before any parse (required for HMAC verification)
  const rawBody = await request.text()

  // 2. Verify HMAC
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET
  if (!webhookSecret) {
    console.error('[fulfillment-webhook] SHOPIFY_WEBHOOK_SECRET not configured')
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })
  }

  if (!verifyHmac(rawBody, hmacHeader, webhookSecret)) {
    console.warn('[fulfillment-webhook] HMAC invalid — shop:', shopDomain || '(no header)')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 3. Parse JSON
  let payload: ShopifyFulfillmentPayload
  try {
    payload = JSON.parse(rawBody) as ShopifyFulfillmentPayload
  } catch {
    console.error('[fulfillment-webhook] Invalid JSON — shop:', shopDomain)
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // ── DIAG 2: full payload summary ──────────────────────────────────────────────
  console.log(
    `[fulfillment-webhook] PAYLOAD ► topic:${topic}`,
    '| fulfillment_id:', String(payload.id),
    '| order_id:', String(payload.order_id),
    '| tracking_number:', payload.tracking_number ?? '(null)',
    '| tracking_numbers:', JSON.stringify(payload.tracking_numbers ?? []),
    '| tracking_company:', payload.tracking_company ?? '(null)',
    '| status:', payload.status ?? '(null)',
    '| payload_keys:', Object.keys(payload).join(','),
  )

  const supabase = await createServiceClient()

  // 4. Resolve store — same logic as orders webhook
  let storeId: string | null = null

  if (shopDomain) {
    const { data: store } = await supabase
      .from('stores')
      .select('id')
      .eq('shopify_domain', shopDomain)
      .eq('is_active', true)
      .maybeSingle()
    storeId = store?.id ?? null
  }

  if (!storeId) {
    const { data } = await supabase
      .from('stores')
      .select('id')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    storeId = data?.id ?? null
  }

  if (!storeId) {
    console.error('[fulfillment-webhook] No active store found — domain:', shopDomain || '(empty)')
    // Return 200 so Shopify doesn't retry endlessly for a config issue
    return NextResponse.json({ ok: true, skipped: 'store_not_found' })
  }

  // 5. Find the order by shopify_order_id
  const shopifyOrderId = String(payload.order_id)

  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('id, order_number, tracking_number, normalized_status, confirmation_status, raw_status')
    .eq('store_id', storeId)
    .eq('shopify_order_id', shopifyOrderId)
    .maybeSingle()

  if (orderErr) {
    console.error('[fulfillment-webhook] DB error looking up order:', orderErr.message)
    return NextResponse.json({ error: 'DB error' }, { status: 500 })
  }

  if (!order) {
    console.log('[fulfillment-webhook] Order not found in DB — shopify_order_id:', shopifyOrderId, '→ skipping')
    return NextResponse.json({ ok: true, skipped: 'order_not_found' })
  }

  // ── DIAG 3: order found ───────────────────────────────────────────────────────
  console.log(
    '[fulfillment-webhook] ORDER FOUND — order_number:', order.order_number ?? '(null)',
    '| shopify_order_id:', shopifyOrderId,
    '| internal_id:', order.id,
    '| normalized_status:', order.normalized_status ?? '(null)',
    '| current_tracking:', order.tracking_number ?? '(none)',
    '| confirmation_status:', order.confirmation_status ?? '(null)',
  )

  // 6. Extract tracking number from payload (tracking_number takes priority, fallback to first in array)
  const trackingFromField  = payload.tracking_number?.trim() || null
  const trackingFromArray  = payload.tracking_numbers?.find(t => t?.trim())?.trim() || null
  const incomingTracking   = trackingFromField ?? trackingFromArray ?? null

  // ── DIAG 4: tracking resolution ──────────────────────────────────────────────
  console.log(
    '[fulfillment-webhook] TRACKING RESOLUTION',
    '| tracking_number_field:', trackingFromField ?? '(empty)',
    '| tracking_numbers_array:', JSON.stringify(payload.tracking_numbers ?? []),
    '| tracking_numbers_first:', trackingFromArray ?? '(empty)',
    '| resolved:', incomingTracking ?? '(none)',
    '| source:', trackingFromField ? 'tracking_number field' : trackingFromArray ? 'tracking_numbers[0]' : 'none',
  )

  if (!incomingTracking) {
    console.log('[fulfillment-webhook] FULFILLMENT WITHOUT TRACKING — fulfillment_id:', String(payload.id), '→ skipping')
    return NextResponse.json({ ok: true, skipped: 'no_tracking_number' })
  }

  // 7. Idempotency: if the order already has this tracking number, nothing to do
  if (order.tracking_number && order.tracking_number === incomingTracking) {
    console.log('[fulfillment-webhook] Tracking already set — order:', order.id, 'tracking:', incomingTracking)
    return NextResponse.json({ ok: true, skipped: 'tracking_already_set' })
  }

  // 8. Build update payload
  const updates: Record<string, unknown> = {
    tracking_number:      incomingTracking,
    last_tracking_update: new Date().toISOString(),
    updated_at:           new Date().toISOString(),
  }

  // Carrier (optional)
  if (payload.tracking_company) {
    updates.carrier = payload.tracking_company
  }

  // confirmation_status: only update if currently pending
  if (order.confirmation_status === 'pending') {
    updates.confirmation_status      = 'confirmed'
    updates.last_confirmation_attempt = new Date().toISOString()
    // NEVER set customer_confirmed = true automatically
  }

  // normalized_status: only transition to in_transit from safe states
  const rawStatusLower = (order.raw_status ?? '').toLowerCase()
  const isGenerada     = rawStatusLower.includes('generada')
  const isSafeState    = SAFE_TO_TRANSIT.has(order.normalized_status as null | undefined) || isGenerada

  if (isSafeState) {
    updates.normalized_status = 'in_transit'
  }

  // 9. Apply update
  const { error: updateErr } = await supabase
    .from('orders')
    .update(updates)
    .eq('id', order.id)

  if (updateErr) {
    console.error('[fulfillment-webhook] DB update error — order:', order.id, updateErr.message)
    return NextResponse.json({ error: 'Failed to update order' }, { status: 500 })
  }

  // 10. Insert internal note for audit trail
  await supabase.from('notes').insert({
    order_id:   order.id,
    created_by: null,
    content:    `Tracking asignado automáticamente desde Shopify fulfillment: ${incomingTracking}`,
  })

  console.log(
    `[fulfillment-webhook] UPDATED ORDER:`, order.id,
    '| order_number:', order.order_number ?? '(null)',
    '→ tracking:', incomingTracking,
    '| status_changed:', isSafeState ? `${order.normalized_status ?? 'null'} → in_transit` : 'no',
    '| confirmation_changed:', order.confirmation_status === 'pending' ? 'pending → confirmed' : 'no',
  )

  return NextResponse.json({
    ok:             true,
    order_id:       order.id,
    tracking:       incomingTracking,
    status_changed: isSafeState,
  })
}
