import { NextResponse }        from 'next/server'
import crypto                   from 'crypto'
import { createServiceClient }  from '@/lib/supabase/server'
import { normalizePhoneRD }     from '@/lib/normalize-phone'

// ── Types ─────────────────────────────────────────────────────────────────────

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>

interface MetaWebhookMessage {
  from:       string
  id:         string              // wamid.xxx — clave de deduplicación
  timestamp:  string              // Unix epoch segundos, como string
  type:       string              // 'text' | 'image' | 'audio' | etc.
  text?:      { body: string }
  [key: string]: unknown          // otros campos según el tipo de mensaje
}

interface MetaWebhookContact {
  profile?: { name?: string }
  wa_id?:   string
}

interface MetaWebhookStatus {
  id:           string
  status:       'sent' | 'delivered' | 'read' | 'failed'
  timestamp:    string
  recipient_id: string
  errors?:      Array<{ code: number; [key: string]: unknown }>
}

interface MetaWebhookValue {
  messaging_product: string
  metadata:          { phone_number_id: string; display_phone_number: string }
  contacts?:         MetaWebhookContact[]
  messages?:         MetaWebhookMessage[]
  statuses?:         MetaWebhookStatus[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function verifyMetaHmac(rawBody: string, signatureHeader: string, appSecret: string): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false
  const receivedHex = signatureHeader.slice('sha256='.length)
  const expectedHex = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex')
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedHex, 'hex'),
      Buffer.from(receivedHex,  'hex'),
    )
  } catch {
    return false
  }
}


// Trunca el preview a 150 chars. Contrato: el webhook es el único escritor.
function makePreview(body: string | null | undefined, msgType: string): string {
  if (!body?.trim()) return `[${msgType}]`
  const t = body.trim()
  return t.length <= 150 ? t : t.slice(0, 150) + '…'
}

// ── GET — Verificación del webhook por Meta ───────────────────────────────────
// Meta llama este endpoint una vez al registrar el webhook.
// Responde con hub.challenge si hub.verify_token coincide.

export function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode      = searchParams.get('hub.mode')
  const token     = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  const verifyToken = process.env.WA_WEBHOOK_VERIFY_TOKEN
  if (!verifyToken) {
    console.error('[wa-webhook] WA_WEBHOOK_VERIFY_TOKEN no configurado')
    return new Response('Webhook not configured', { status: 500 })
  }

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[wa-webhook] ✓ Verificación Meta exitosa')
    return new Response(challenge ?? '', { status: 200 })
  }

  console.warn('[wa-webhook] ✖ Verificación fallida — token no coincide')
  return new Response('Forbidden', { status: 403 })
}

// ── POST — Eventos entrantes de Meta ─────────────────────────────────────────
// Recibe mensajes inbound y status updates.
// Debe responder 200 en < 5s o Meta reintenta.
// La deduplicación de mensajes la garantiza UNIQUE(wa_msg_id) en DB.

export async function POST(request: Request) {
  // 1. Leer raw body antes de parsear — necesario para verificar HMAC
  const rawBody = await request.text()

  // 2. Verificar HMAC con App Secret (timing-safe)
  const appSecret = process.env.WA_APP_SECRET
  if (!appSecret) {
    console.error('[wa-webhook] WA_APP_SECRET no configurado')
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })
  }

  const signatureHeader = request.headers.get('x-hub-signature-256') ?? ''
  if (!verifyMetaHmac(rawBody, signatureHeader, appSecret)) {
    console.warn('[wa-webhook] ✖ HMAC inválido — request rechazado')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 3. Parsear payload
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    console.error('[wa-webhook] ✖ JSON inválido')
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // 4. Procesar eventos — error aquí nunca debe bloquear el 200 a Meta
  try {
    const supabase = await createServiceClient()

    // ── DIAGNÓSTICO: confirmar a qué proyecto Supabase conectamos ─────────────
    // Comparar este project ref con el proyecto abierto en supabase.com/dashboard
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '(no configurado)'
    const serviceKeyExists = !!process.env.SUPABASE_SERVICE_ROLE_KEY
    let projectRef = '(no se pudo extraer)'
    try { projectRef = new URL(supabaseUrl).hostname.split('.')[0] } catch { /* noop */ }
    console.log('[wa-diag] ── INICIO DIAGNÓSTICO ──────────────────────────────')
    console.log('[wa-diag] Supabase URL:       ', supabaseUrl)
    console.log('[wa-diag] Project ref:         ', projectRef)
    console.log('[wa-diag] SERVICE_ROLE_KEY OK: ', serviceKeyExists)
    // ─────────────────────────────────────────────────────────────────────────

    // Resolver tienda activa — single-store setup actual.
    // Para multi-store: mapear via wa_config.phone_number_id (Fase futura).
    const { data: store, error: storeErr } = await supabase
      .from('stores')
      .select('id')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    console.log('[wa-diag] store lookup → data:', store, '| error:', storeErr?.message ?? null)

    if (!store) {
      console.error('[wa-webhook] No se encontró tienda activa')
      return NextResponse.json({ ok: true }) // 200 a Meta de todos modos
    }

    const storeId = store.id
    const entries = (payload.entry as Array<Record<string, unknown>>) ?? []

    for (const entry of entries) {
      const changes = (entry.changes as Array<Record<string, unknown>>) ?? []
      for (const change of changes) {
        const value = change.value as MetaWebhookValue | undefined
        if (!value) continue

        // ── Mensajes inbound ────────────────────────────────────────────────
        if (value.messages?.length) {
          // Mapa de contactos para lookup de display_name por wa_id
          const contactsMap = new Map<string, MetaWebhookContact>()
          for (const c of value.contacts ?? []) {
            if (c.wa_id) contactsMap.set(c.wa_id, c)
          }

          for (const msg of value.messages) {
            // Fase 1B: solo mensajes text inbound.
            // Otros tipos (image, audio, document) se procesan en Fase 1C.
            if (msg.type !== 'text') {
              console.log('[wa-webhook] tipo', msg.type, 'omitido — Fase 1B solo text')
              continue
            }

            const displayName = contactsMap.get(msg.from)?.profile?.name ?? null
            await processInboundMessage(supabase, storeId, msg, displayName)
          }
        }

        // ── Status updates outbound ─────────────────────────────────────────
        if (value.statuses?.length) {
          for (const status of value.statuses) {
            await processStatusUpdate(supabase, status)
          }
        }
      }
    }
  } catch (err) {
    // Log pero siempre 200 — evitar que Meta reintente indefinidamente
    console.error('[wa-webhook] Error inesperado procesando evento:', err)
  }

  return NextResponse.json({ ok: true })
}

// ── Core: actualizar status de mensaje outbound ───────────────────────────────

async function processStatusUpdate(
  supabase: ServiceClient,
  status:   MetaWebhookStatus,
): Promise<void> {
  console.log('[wa-webhook] procesando status update — wa_msg_id:', status.id, 'status:', status.status)

  const { data: msg, error: selectErr } = await supabase
    .from('wa_messages')
    .select('id, status, delivered_at')
    .eq('wa_msg_id', status.id)
    .maybeSingle()

  if (selectErr) {
    console.error('[wa-webhook] ✖ Error buscando mensaje para status update:', selectErr.message)
    return
  }

  if (!msg) {
    console.warn('[wa-webhook] ⚠ wa_msg_id no encontrado para status update — ignorando:', status.id)
    return
  }

  const ts = new Date(parseInt(status.timestamp, 10) * 1000).toISOString()
  const updates: Record<string, unknown> = {}

  if (status.status === 'sent') {
    if (msg.status === 'delivered' || msg.status === 'read') {
      console.log('[wa-webhook] ⏭ sent: skip downgrade desde', msg.status, '— wa_msg_id:', status.id)
      return
    }
    if (msg.status !== 'pending' && msg.status !== 'sent') {
      console.log('[wa-webhook] ⏭ sent: estado actual no es pending/sent, skip — wa_msg_id:', status.id)
      return
    }
    updates.status = 'sent'
  } else if (status.status === 'delivered') {
    updates.status      = 'delivered'
    updates.delivered_at = ts
  } else if (status.status === 'read') {
    updates.status  = 'read'
    updates.read_at = ts
    if (!msg.delivered_at) {
      updates.delivered_at = ts
    }
  } else if (status.status === 'failed') {
    updates.status = 'failed'
    const errorCode = status.errors?.[0]?.code
    if (errorCode !== undefined) {
      updates.error_code = String(errorCode)
    }
  }

  if (Object.keys(updates).length === 0) return

  const { error: updateErr } = await supabase
    .from('wa_messages')
    .update(updates)
    .eq('id', msg.id)

  if (updateErr) {
    console.error('[wa-webhook] ✖ Error actualizando status de mensaje:', updateErr.message)
    return
  }

  console.log('[wa-webhook] ✓ status actualizado — wa_msg_id:', status.id, 'nuevo status:', updates.status ?? msg.status)
}

// ── Core: persistir un mensaje text inbound ───────────────────────────────────

async function processInboundMessage(
  supabase:    ServiceClient,
  storeId:     string,
  msg:         MetaWebhookMessage,
  displayName: string | null,
): Promise<void> {
  const phoneNormalized = normalizePhoneRD(msg.from)
  const sentAt = new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
  const body   = msg.text?.body ?? null

  console.log('[wa-webhook] procesando mensaje de', phoneNormalized, '— wa_msg_id:', msg.id)

  // ── 1. Resolver o crear wa_contact ────────────────────────────────────────
  const { data: existingContact, error: selectContactErr } = await supabase
    .from('wa_contacts')
    .select('id, order_id')
    .eq('store_id', storeId)
    .eq('phone_normalized', phoneNormalized)
    .maybeSingle()

  // DIAGNÓSTICO: loguear resultado completo del SELECT inicial
  console.log('[wa-diag] SELECT wa_contacts → data:', existingContact, '| error:', selectContactErr?.message ?? null, '| code:', selectContactErr?.code ?? null)

  let contact = existingContact

  if (!contact) {
    // Contacto nuevo — intentar vincular pedido activo por teléfono
    const orderId = await findOrderByPhone(supabase, storeId, phoneNormalized)

    const { data: newContact, error: insertContactErr } = await supabase
      .from('wa_contacts')
      .insert({
        store_id:         storeId,
        phone_normalized: phoneNormalized,
        wa_id:            msg.from,
        display_name:     displayName,
        order_id:         orderId,
        last_seen_at:     sentAt,
      })
      .select('id, order_id')
      .single()

    // DIAGNÓSTICO: loguear resultado completo del INSERT de contacto
    console.log('[wa-diag] INSERT wa_contacts → data:', newContact, '| error:', insertContactErr?.message ?? null, '| code:', insertContactErr?.code ?? null)

    if (insertContactErr) {
      // 23505 = race condition entre dos webhooks simultáneos — releer
      if (insertContactErr.code === '23505') {
        const { data: refetched } = await supabase
          .from('wa_contacts')
          .select('id, order_id')
          .eq('store_id', storeId)
          .eq('phone_normalized', phoneNormalized)
          .maybeSingle()
        contact = refetched
      }
      if (!contact) {
        console.error('[wa-webhook] ✖ Error creando contacto — abortando mensaje', msg.id)
        return
      }
    } else {
      contact = newContact
    }

  } else {
    // Contacto existente — actualizar last_seen_at y vincular pedido si falta
    const updates: Record<string, unknown> = { last_seen_at: sentAt }
    if (displayName)        updates.display_name = displayName
    if (!contact.order_id) {
      const orderId = await findOrderByPhone(supabase, storeId, phoneNormalized)
      if (orderId) updates.order_id = orderId
    }
    const { error: updateContactErr } = await supabase
      .from('wa_contacts').update(updates).eq('id', contact.id)
    console.log('[wa-diag] UPDATE wa_contacts → error:', updateContactErr?.message ?? null)
  }

  if (!contact) return

  console.log('[wa-diag] contact resuelto → id:', contact.id)

  // ── 2. Resolver o crear wa_conversation activa ────────────────────────────
  // idx_wa_convs_one_active_per_contact garantiza máximo 1 activa por contacto.
  const { data: existingConv, error: selectConvErr } = await supabase
    .from('wa_conversations')
    .select('id, unread_count')
    .eq('contact_id', contact.id)
    .neq('status', 'closed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  console.log('[wa-diag] SELECT wa_conversations → data:', existingConv, '| error:', selectConvErr?.message ?? null, '| code:', selectConvErr?.code ?? null)

  let conversation = existingConv

  if (!conversation) {
    const { data: newConv, error: insertConvErr } = await supabase
      .from('wa_conversations')
      .insert({
        store_id:     storeId,
        contact_id:   contact.id,
        status:       'open',
        unread_count: 0,
      })
      .select('id, unread_count')
      .single()

    // DIAGNÓSTICO: loguear resultado completo del INSERT de conversación
    console.log('[wa-diag] INSERT wa_conversations → data:', newConv, '| error:', insertConvErr?.message ?? null, '| code:', insertConvErr?.code ?? null)

    if (insertConvErr) {
      // 23505 = violación del índice único parcial — race condition, releer
      if (insertConvErr.code === '23505') {
        const { data: refetched } = await supabase
          .from('wa_conversations')
          .select('id, unread_count')
          .eq('contact_id', contact.id)
          .neq('status', 'closed')
          .maybeSingle()
        conversation = refetched
      }
      if (!conversation) {
        console.error('[wa-webhook] ✖ Error creando conversación — abortando mensaje', msg.id)
        return
      }
    } else {
      conversation = newConv
    }
  }

  console.log('[wa-diag] conversation resuelta → id:', conversation.id)

  // ── 3. Insertar wa_message con deduplicación ──────────────────────────────
  const { data: newMsg, error: insertMsgErr } = await supabase
    .from('wa_messages')
    .insert({
      store_id:        storeId,
      conversation_id: conversation.id,
      wa_msg_id:       msg.id,
      direction:       'inbound',
      message_type:    'text',
      body,
      raw_payload:     msg as Record<string, unknown>,
      status:          'received',
      sent_at:         sentAt,
    })
    .select('id')
    .single()

  // DIAGNÓSTICO: loguear resultado completo del INSERT de mensaje
  console.log('[wa-diag] INSERT wa_messages → data:', newMsg, '| error:', insertMsgErr?.message ?? null, '| code:', insertMsgErr?.code ?? null)

  if (insertMsgErr?.code === '23505') {
    // wa_msg_id ya existe — retry de Meta absorbido silenciosamente
    console.log('[wa-webhook] idempotente — wa_msg_id ya existe:', msg.id)
    return
  }

  if (insertMsgErr) {
    console.error('[wa-webhook] ✖ Error insertando mensaje — abortando:', insertMsgErr.message)
    return
  }

  // ── 4. Actualizar metadatos de la conversación ────────────────────────────
  const { error: updateConvErr } = await supabase
    .from('wa_conversations')
    .update({
      last_message_at:      sentAt,
      last_message_preview: makePreview(body, 'text'),
      unread_count:         (conversation.unread_count ?? 0) + 1,
    })
    .eq('id', conversation.id)

  console.log('[wa-diag] UPDATE wa_conversations → error:', updateConvErr?.message ?? null)

  console.log(
    '[wa-webhook] ✓ mensaje guardado — phone:', phoneNormalized,
    '— contact.id:', contact.id,
    '— conv.id:', conversation.id,
    '— msg.id (DB):', newMsg?.id,
    '— wa_msg_id:', msg.id,
  )
}

// ── Helper: buscar pedido activo por teléfono ─────────────────────────────────
// Mismo patrón que la recuperación de carritos en el webhook de Shopify:
// fetch con filtro amplio, normalizar en JS para manejar distintos formatos.
//
// Meta envía con código de país: "18091234567"
// DB puede tener: "809-123-4567" | "8091234567" | "+18091234567"
// Estrategia: comparar sufijos de ≥7 dígitos para absorber diferencias de
// formato y presencia/ausencia del código de país.

async function findOrderByPhone(
  supabase:        ServiceClient,
  storeId:         string,
  phoneNormalized: string,
): Promise<string | null> {
  if (phoneNormalized.length < 7) return null

  const { data: orders } = await supabase
    .from('orders')
    .select('id, customer_phone')
    .eq('store_id', storeId)
    .not('customer_phone', 'is', null)
    .not('normalized_status', 'in', '(delivered,returned)')
    .order('created_at', { ascending: false })
    .limit(200)

  if (!orders?.length) return null

  const match = orders.find(o => {
    if (!o.customer_phone) return false
    const stored  = o.customer_phone.replace(/\D/g, '')
    const shorter = stored.length <= phoneNormalized.length ? stored : phoneNormalized
    const longer  = stored.length <= phoneNormalized.length ? phoneNormalized : stored
    // "18091234567".endsWith("8091234567") → true
    // Mínimo 7 dígitos para evitar falsos positivos con números muy cortos
    return longer.endsWith(shorter) && shorter.length >= 7
  })

  return match?.id ?? null
}
