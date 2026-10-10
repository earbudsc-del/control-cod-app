import { NextResponse }        from 'next/server'
import crypto                   from 'crypto'
import { createServiceClient }  from '@/lib/supabase/server'
import { normalizePhoneRD }     from '@/lib/normalize-phone'
import { applyConfirmationAction, type ConfirmAction } from '@/lib/orders/confirmation'
import { decideContactOrderLink, isLinkedOrderStillActive, resolveContactOrderByPhone } from '@/lib/whatsapp/contact-order'
import { maybeGenesisRespond }  from '@/lib/genesis/respond'
import { handleInboundLocation } from '@/lib/whatsapp/inbound-location'
import { isWaAutomationsEnabled } from '@/lib/config/wa-automations'
import { recordBroadcastButtonResponse } from '@/lib/broadcast/responses'
import { isMarketingOptOutRequest, recordMarketingOptOut } from '@/lib/broadcast/suppression'

// ── Types ─────────────────────────────────────────────────────────────────────

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>

interface MetaWebhookButtonReply {
  type:          string                          // 'button_reply'
  button_reply?: { id: string; title: string }
}

interface MetaWebhookButton {
  text:    string
  payload: string
}

interface MetaWebhookLocation {
  latitude:  number
  longitude: number
  name?:     string
  address?:  string
}

interface MetaWebhookMessage {
  from:        string
  id:          string              // wamid.xxx — clave de deduplicación
  timestamp:   string              // Unix epoch segundos, como string
  type:        string              // 'text' | 'image' | 'audio' | 'interactive' | 'button' | 'location' | etc.
  text?:       { body: string }
  interactive?: MetaWebhookButtonReply   // respuesta a botones interactive (Reply Buttons)
  button?:      MetaWebhookButton        // respuesta a quick-reply de un template
  location?:    MetaWebhookLocation      // pin de ubicación (Sprint 3A)
  [key: string]: unknown          // otros campos según el tipo de mensaje
}

// Contenido normalizado de un mensaje inbound, sin importar su tipo de origen.
interface InboundContent {
  body:        string | null
  messageType: string
  metadata:    Record<string, unknown> | null
}

// Soporta: texto plano, botón de respuesta interactive (Reply Buttons) y
// quick-reply de un mensaje template (botones nativos del template, como
// "Confirmar" / "No, gracias" en order_confirmation_cod).
function parseInboundContent(msg: MetaWebhookMessage): InboundContent | null {
  if (msg.type === 'text') {
    return { body: msg.text?.body ?? null, messageType: 'text', metadata: null }
  }

  if (msg.type === 'interactive' && msg.interactive?.type === 'button_reply' && msg.interactive.button_reply) {
    const { id, title } = msg.interactive.button_reply
    return {
      body:        title,
      messageType: 'interactive',
      metadata:    { interactive: msg.interactive, button_reply_id: id, button_reply_title: title },
    }
  }

  if (msg.type === 'button' && msg.button) {
    const { text, payload } = msg.button
    return {
      body:        text,
      messageType: 'button_reply',
      metadata:    { button: msg.button, button_reply_id: payload, button_reply_title: text },
    }
  }

  // Pin de ubicación de WhatsApp (Sprint 3A) — usado para "Ubicación recibida"
  // en pedidos SD. body=null (no hay texto), la coordenada vive en metadata.
  if (msg.type === 'location' && msg.location) {
    return {
      body:        null,
      messageType: 'location',
      metadata:    {
        latitude:  msg.location.latitude,
        longitude: msg.location.longitude,
        name:      msg.location.name ?? null,
        address:   msg.location.address ?? null,
      },
    }
  }

  return null
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


// Enmascarado para logs — nunca coordenadas completas ni teléfono completo.
function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '(sin teléfono)'
  return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`
}
function maskCoord(n: number | null | undefined): string {
  if (typeof n !== 'number') return '(?)'
  return n.toFixed(1) + '…'
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
  // TEMPORAL — diagnóstico FASE 7B.2: confirmar que este webhook (el que
  // contiene maybeGenesisRespond) es el que Meta realmente está invocando.
  console.log('[wa-webhook] inbound recibido')

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
            // Fase 1B: text. Fase 6B: interactive/button (respuestas de botón).
            // Otros tipos (image, audio, document) se procesan en Fase 1C.
            const content = parseInboundContent(msg)
            if (!content) {
              console.log('[wa-webhook] tipo', msg.type, 'omitido — sin manejador')
              console.log('[wa-diag] FASE6B payload completo mensaje no soportado:', JSON.stringify(msg))
              continue
            }
            if (content.messageType === 'location') {
              console.log(`[wa-webhook] ✓ webhook recibió tipo location — from=${maskPhone(msg.from)}`)
            }

            const displayName = contactsMap.get(msg.from)?.profile?.name ?? null
            await processInboundMessage(supabase, storeId, msg, displayName, content)
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
  content:     InboundContent,
): Promise<void> {
  const phoneNormalized = normalizePhoneRD(msg.from)
  const sentAt = new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
  const body   = content.body

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
    // Contacto nuevo — vincular solo si hay UN pedido activo (B.2.3:
    // lookup dirigido, sin ambigüedad ni históricos — ver contact-order.ts).
    const orderId = (await resolveContactOrderByPhone(supabase, storeId, phoneNormalized)).orderId

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
    // B.2.3: (re)vincular si falta o si el pedido vinculado ya no está activo
    // y existe UN pedido activo. Nunca se borra un vínculo ni se elige a ciegas.
    const stillActive = contact.order_id ? await isLinkedOrderStillActive(supabase, contact.order_id) : false
    if (!contact.order_id || !stillActive) {
      const resolution = await resolveContactOrderByPhone(supabase, storeId, phoneNormalized)
      const newOrderId = decideContactOrderLink(contact.order_id, stillActive, resolution)
      if (newOrderId) updates.order_id = newOrderId
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
      message_type:    content.messageType,
      body,
      raw_payload:     msg as Record<string, unknown>,
      metadata:        content.metadata,
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
      last_message_preview: makePreview(body, content.messageType),
      unread_count:         (conversation.unread_count ?? 0) + 1,
    })
    .eq('id', conversation.id)

  console.log('[wa-diag] UPDATE wa_conversations → error:', updateConvErr?.message ?? null)

  // ── 4a. Broadcast C.1 — intención de botón + baja promocional ─────────────
  // Solo REGISTRA (wa_broadcast_responses / wa_contact_preferences) para que
  // un agente humano atienda. Nunca confirma, cancela ni modifica pedidos.
  // Aislado en try/catch: si las tablas de 066 no existen todavía o algo
  // falla, el webhook sigue igual que antes (200 a Meta, mensaje guardado).
  try {
    if (content.messageType === 'button_reply' || content.messageType === 'interactive') {
      const context = msg.context as { id?: string } | undefined
      const recorded = await recordBroadcastButtonResponse(supabase, {
        storeId, conversationId: conversation.id, inboundMessageId: newMsg.id, phoneNormalized,
        buttonText:    (content.metadata?.button_reply_title as string | undefined) ?? null,
        buttonPayload: (content.metadata?.button_reply_id as string | undefined) ?? null,
        contextWamid:  context?.id ?? null,
      })
      if (recorded) {
        console.log(`[wa-webhook] broadcast respuesta — intent=${recorded.intent} assoc=${recorded.association} broadcast=${recorded.broadcastId ?? '-'} dup=${recorded.duplicate}`)
      }
    }
    if (content.messageType === 'text' && isMarketingOptOutRequest(body)) {
      const r = await recordMarketingOptOut(supabase, {
        storeId, phoneNormalized, source: 'customer_keyword', reason: (body ?? '').slice(0, 200), sourceMessageId: newMsg.id,
      })
      console.log(`[wa-webhook] baja promocional registrada — phone=${maskPhone(phoneNormalized)} ok=${r.ok}`)
    }
  } catch (bcErr) {
    console.error('[wa-webhook] ⚠ registro de respuesta Broadcast falló (mensaje ya guardado):', bcErr instanceof Error ? bcErr.message : bcErr)
  }

  // ── 4b. Ubicación recibida — Ruta COD v1 Fase 5 / C.1.2 ───────────────────
  // Lógica en src/lib/whatsapp/inbound-location.ts:
  //   - 1 pedido SD activo: guarda la ubicación; confirma + autodespacha SOLO
  //     con WA_AUTOMATIONS_ENABLED='true' (applyConfirmationAction guardAutomated).
  //   - varios candidatos: no asigna a ninguno (la coordenada queda en el
  //     metadata de este wa_message para resolución humana).
  if (content.messageType === 'location' && content.metadata) {
    const lat = content.metadata.latitude as number | undefined
    const lng = content.metadata.longitude as number | undefined
    if (typeof lat === 'number' && typeof lng === 'number') {
      console.log(`[wa-webhook] location conversación encontrada — conv=${conversation.id} coords≈(${maskCoord(lat)},${maskCoord(lng)})`)
      const loc = await handleInboundLocation(supabase, {
        inboundMessageId: newMsg.id, storeId, phoneNormalized, conversationId: conversation.id, waMsgId: msg.id, latitude: lat, longitude: lng, sentAt,
      }, { automationsEnabled: isWaAutomationsEnabled })
      switch (loc.outcome) {
        case 'no_candidates':
          console.log('[wa-webhook] ubicación recibida sin pedido SD activo compatible — phone=', maskPhone(phoneNormalized)); break
        case 'ambiguous_not_assigned':
          console.warn(`[wa-webhook] ⚠ ubicación ambigua — ${loc.candidates} pedidos activos; no se asigna a ninguno (pendiente de asociación manual en el Inbox) — phone=${maskPhone(phoneNormalized)}`); break
        case 'save_error':
          console.error('[wa-webhook] ✖ Error guardando ubicación SD (update de orders falló):', loc.error); break
        case 'saved_automations_off':
          console.log(`[WA_AUTOMATION_DISABLED] step=location_confirm — ubicación guardada, sin confirmación automática — order=${loc.orderId}`); break
        case 'saved_confirmed':
          console.log(`[wa-webhook] ✓ pedido confirmado y despachado por ubicación — order=${loc.orderId} auto_dispatched=${loc.autoDispatched}`); break
        case 'saved_confirm_skipped':
          console.warn(`[wa-webhook] ⚠ confirmación automática por ubicación omitida — order=${loc.orderId} reason=${loc.reason}`); break
      }
    }
  }

  // ── 5. Acción automática sobre el pedido (Fase 6C) ────────────────────────
  // Botón "Confirmar" / "No, gracias" del template order_confirmation_cod.
  // Reutiliza exactamente la misma lógica que el endpoint manual de confirmación.
  //
  // IMPORTANTE (fix Fase 6C): un mismo teléfono puede tener múltiples pedidos
  // en COD, así que wa_contacts.order_id (que solo se vincula una vez y nunca
  // se reescribe) NO es fuente confiable para saber a qué pedido aplica este
  // botón. La fuente correcta es el order_id que viajó en el metadata del
  // template outbound que disparó el botón — se resuelve buscando el último
  // template 'order_confirmation_cod' enviado en esta misma conversación
  // antes (o al momento) de este reply.
  if (content.messageType === 'button_reply' || content.messageType === 'interactive') {
    const buttonTitle = content.metadata?.button_reply_title as string | undefined

    const action: ConfirmAction | null =
      buttonTitle === 'Confirmar'   ? 'confirmed' :
      buttonTitle === 'No, gracias' ? 'cancelled' :
      null

    if (action) {
      const orderId = await resolveOrderIdFromLastTemplate(supabase, conversation.id, sentAt)

      if (!orderId) {
        console.warn('[wa-webhook] ⚠ botón', JSON.stringify(buttonTitle), 'recibido sin order_id resoluble desde el template outbound — conv:', conversation.id, '— phone:', phoneNormalized)
      } else {
        const result = await applyConfirmationAction({
          supabase,
          orderId,
          action,
          method: 'whatsapp',
          guardAutomated: true,
        })

        if (!result.ok) {
          console.warn('[wa-webhook] ⚠ acción automática omitida — order:', orderId, '| action:', action, '| reason:', result.reason)
        } else {
          console.log('[wa-webhook] ✓ acción automática aplicada — order:', orderId, '| action:', action, '| confirmation_status:', result.confirmation_status)
        }
      }
    }
  }

  console.log(
    '[wa-webhook] ✓ mensaje guardado — phone:', phoneNormalized,
    '— contact.id:', contact.id,
    '— conv.id:', conversation.id,
    '— msg.id (DB):', newMsg?.id,
    '— wa_msg_id:', msg.id,
  )

  // ── 6. Respuesta automática de Génesis (Fase 7B.2 / Fase 1B) ──────────────
  // Solo dispara si la conversación cumple todas las condiciones — ahora
  // verificadas atómicamente por claim_genesis_run() dentro de
  // maybeGenesisRespond, no por chequeos sueltos aquí. Nunca lanza —
  // cualquier error queda contenido y logueado dentro de maybeGenesisRespond.
  // No se ejecuta para wa_msg_id duplicados (Meta retry) porque ese caso
  // retorna antes, en el bloque insertMsgErr?.code === '23505' de arriba.
  // newMsg.id (el id del propio mensaje inbound recién insertado) es
  // obligatorio para claim_genesis_run — antes no se pasaba.
  // TEMPORAL — diagnóstico FASE 7B.2.
  console.log('[wa-webhook] llamando maybeGenesisRespond')
  await maybeGenesisRespond(supabase, storeId, conversation.id, newMsg.id)
}

// ── Helper: resolver order_id desde el último template outbound (Fase 6C) ─────
// No usa wa_contacts.order_id — un mismo contacto puede recibir templates de
// pedidos distintos a lo largo del tiempo. Busca el wa_message outbound más
// reciente de tipo 'template' con metadata.template_name='order_confirmation_cod'
// en esta conversación, con sent_at <= el momento del button reply, y lee
// metadata.order_id (fallback metadata.test_order_id para envíos de prueba
// vía /api/admin/wa-test-send).
async function resolveOrderIdFromLastTemplate(
  supabase:       ServiceClient,
  conversationId: string,
  buttonSentAt:   string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('wa_messages')
    .select('metadata')
    .eq('conversation_id', conversationId)
    .eq('direction', 'outbound')
    .eq('message_type', 'template')
    .eq('metadata->>template_name', 'order_confirmation_cod')
    .lte('sent_at', buttonSentAt)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[wa-webhook] ✖ Error buscando template outbound para resolver order_id:', error.message)
    return null
  }

  const metadata = data?.metadata as Record<string, unknown> | null
  const orderId = (metadata?.order_id as string | undefined) ?? (metadata?.test_order_id as string | undefined) ?? null

  return orderId
}

// ── Lookups por teléfono ─────────────────────────────────────────────────────
// findOrderByPhone (últimos 200 pedidos de la tienda) fue reemplazado en B.2.3
// por resolveContactOrderByPhone — src/lib/whatsapp/contact-order.ts.

// findActiveSdOrdersByPhone vive en src/lib/deliveries/active-sd-orders-by-phone.ts
// (B.2.2): lookup dirigido por teléfono + tienda + estados activos, sin el
// límite global de "últimos 200 pedidos de la tienda".
