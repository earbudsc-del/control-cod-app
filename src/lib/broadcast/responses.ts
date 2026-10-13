// Sprint C.1 — respuestas de botones de Broadcast (registro de INTENCIÓN).
//
// Llamado por el webhook de WhatsApp después de guardar el inbound. NUNCA
// confirma, cancela ni modifica pedidos: solo registra la intención en
// wa_broadcast_responses para que un agente humano la atienda con los flujos
// canónicos (confirmación / cancelación de Control COD).
//
// Asociación, en orden de confianza:
//   1. payload   — bc1:<queue_id>:<índice>, el payload propio que el
//                  processor puso en cada quick reply (templates.ts).
//   2. context_wamid — msg.context.id = wamid del template respondido →
//                  wa_template_queue.wa_message_id.
//   3. none      — el texto coincide con un botón de Broadcast pero no hay
//                  forma de saber a qué envío responde: intent 'unknown',
//                  queda para revisión humana (no se infiere pedido).
// En 1 y 2 se exige además que la fila sea de la MISMA tienda y del MISMO
// teléfono que escribió.
//
// Botones de automations ('Confirmar' / 'No, gracias') no son de Broadcast:
// devuelve null y no registra nada (los sigue manejando el webhook igual que antes).

import { TEMPLATE_BUTTONS, BROADCAST_TEMPLATES, type BroadcastTemplateName } from './campaign'
import { parseButtonPayload, TEMPLATE_BUTTON_INTENTS, type ButtonIntent } from './templates'
import { compareEvents, withMessageTimes, type ResponseEvent } from './response-timeline'

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type ResponseIntent = ButtonIntent | 'unknown'

export interface ButtonResponseInput {
  storeId:           string
  conversationId:    string
  inboundMessageId:  string
  phoneNormalized:   string
  buttonText:        string | null
  buttonPayload:     string | null
  contextWamid:      string | null
}

export interface RecordedResponse {
  intent:       ResponseIntent
  association:  'payload' | 'context_wamid' | 'none'
  broadcastId:  string | null
  queueId:      string | null
  orderId:      string | null
  duplicate:    boolean
}

const BROADCAST_BUTTON_TEXTS = new Set(BROADCAST_TEMPLATES.flatMap(t => TEMPLATE_BUTTONS[t]))

export function isBroadcastButtonText(text: string | null | undefined): boolean {
  return !!text && BROADCAST_BUTTON_TEXTS.has(text.trim())
}

function intentForText(template: BroadcastTemplateName, text: string | null): ResponseIntent {
  const idx = TEMPLATE_BUTTONS[template].indexOf((text ?? '').trim())
  return idx === 0 || idx === 1 ? TEMPLATE_BUTTON_INTENTS[template][idx] : 'unknown'
}

interface QueueRowRef { id: string; store_id: string; broadcast_id: string | null; order_id: string; template_name: string; phone_normalized: string }

const isBroadcastTemplate = (t: string): t is BroadcastTemplateName => (BROADCAST_TEMPLATES as readonly string[]).includes(t)

async function findQueueRow(db: SupabaseLike, storeId: string, col: 'id' | 'wa_message_id', val: string): Promise<QueueRowRef | null> {
  const { data } = await db.from('wa_template_queue')
    .select('id, store_id, broadcast_id, order_id, template_name, phone_normalized')
    .eq(col, val).eq('store_id', storeId).maybeSingle()
  const r = data as QueueRowRef | null
  return r && r.broadcast_id && isBroadcastTemplate(r.template_name) ? r : null
}

export async function recordBroadcastButtonResponse(db: SupabaseLike, i: ButtonResponseInput): Promise<RecordedResponse | null> {
  let association: RecordedResponse['association'] = 'none'
  let row: QueueRowRef | null = null
  let intent: ResponseIntent = 'unknown'

  const parsed = parseButtonPayload(i.buttonPayload)
  if (parsed) {
    const r = await findQueueRow(db, i.storeId, 'id', parsed.queueId)
    if (r && r.phone_normalized === i.phoneNormalized) {
      row = r; association = 'payload'
      intent = TEMPLATE_BUTTON_INTENTS[r.template_name as BroadcastTemplateName][parsed.index]
    }
  }
  if (!row && i.contextWamid) {
    const r = await findQueueRow(db, i.storeId, 'wa_message_id', i.contextWamid)
    if (r && r.phone_normalized === i.phoneNormalized) {
      row = r; association = 'context_wamid'
      intent = intentForText(r.template_name as BroadcastTemplateName, i.buttonText)
    }
  }
  // Sin asociación verificable: solo se registra si el TEXTO es de un botón
  // de Broadcast (para revisión humana). Cualquier otro botón no es nuestro.
  if (!row && !parsed && !isBroadcastButtonText(i.buttonText)) return null

  const record = {
    store_id: i.storeId, conversation_id: i.conversationId, inbound_message_id: i.inboundMessageId,
    broadcast_id: row?.broadcast_id ?? null, queue_id: row?.id ?? null, order_id: row?.order_id ?? null,
    template_name: row?.template_name ?? null, button_text: i.buttonText, button_payload: i.buttonPayload,
    intent, association,
  }
  const { error } = await db.from('wa_broadcast_responses').insert(record)
  if (error && error.code !== '23505') throw new Error(`wa_broadcast_responses: ${error.message ?? String(error)}`)

  return {
    intent, association, broadcastId: record.broadcast_id, queueId: record.queue_id, orderId: record.order_id,
    duplicate: error?.code === '23505',
  }
}

// ── Respuesta ESCRITA al template (sin pulsar el botón) ──────────────────────
//
// El cliente puede responder citando el template y escribir el texto del botón
// ("Sí, confirmar"). WhatsApp lo entrega como mensaje de TEXTO con context.id =
// wamid del template, sin payload. Se registra como respuesta de campaña SOLO si:
//   1. el texto es exactamente el de un botón aprobado (normalizando mayúsculas,
//      tildes y espacios — "si,  CONFIRMAR" sí; "Sí, confirmar mañana" no);
//   2. el mensaje citado es un envío de Broadcast real de la MISMA tienda y el
//      MISMO teléfono (verificable: si no, no se registra nada — un texto suelto
//      puede significar cualquier cosa);
//   3. ese botón pertenece al template de ese envío.
// Igual que los botones: solo registra la intención (association='context_wamid',
// ya permitida por la DB); nunca confirma ni cancela.
// Duplicados: el MISMO mensaje nunca se registra dos veces (reintento de Meta;
// además UNIQUE inbound_message_id). Ninguna otra respuesta se descarta al
// escribir: con mensajes que llegan fuera de orden, descartar "porque la anterior
// tenía la misma intención" puede perder la última decisión real (Sí 10s →
// Cancelar 20s, que llega tarde → Sí 30s). Las repeticiones consecutivas de la
// misma intención (botón + texto, Sí → Sí) se colapsan al LEER
// (response-timeline.ts): no cuentan como decisión nueva ni como cambio.

export function normalizeButtonText(v: string | null | undefined): string {
  return String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

export interface TextReplyInput {
  storeId:          string
  conversationId:   string
  inboundMessageId: string
  phoneNormalized:  string
  text:             string | null
  contextWamid:     string | null
  messageAt?:       string | null   // sent_at del mensaje (timestamp de Meta)
}

export async function recordBroadcastTextReply(db: SupabaseLike, i: TextReplyInput): Promise<RecordedResponse | null> {
  if (!i.contextWamid || !i.text) return null
  const typed = normalizeButtonText(i.text)
  if (!typed || !BROADCAST_TEMPLATES.some(t => TEMPLATE_BUTTONS[t].some(b => normalizeButtonText(b) === typed))) return null

  const row = await findQueueRow(db, i.storeId, 'wa_message_id', i.contextWamid)
  if (!row || row.phone_normalized !== i.phoneNormalized) return null
  const template = row.template_name as BroadcastTemplateName
  const idx = TEMPLATE_BUTTONS[template].findIndex(b => normalizeButtonText(b) === typed)
  if (idx !== 0 && idx !== 1) return null            // botón de OTRO template: no corresponde a este envío
  const intent = TEMPLATE_BUTTON_INTENTS[template][idx]

  const base = { intent, association: 'context_wamid' as const, broadcastId: row.broadcast_id, queueId: row.id, orderId: row.order_id }
  const { data: prior, error: priorErr } = await db.from('wa_broadcast_responses')
    .select('id, queue_id, intent, created_at, inbound_message_id, handled_at, handled_by')
    .eq('store_id', i.storeId).eq('queue_id', row.id)
  if (priorErr) throw new Error(`wa_broadcast_responses(prior): ${priorErr.message ?? String(priorErr)}`)
  type Prior = ResponseEvent & { handled_at: string | null; handled_by: string | null }
  const existing = (prior ?? []) as Prior[]
  if (existing.some(e => e.inbound_message_id === i.inboundMessageId)) return { ...base, duplicate: true }   // reintento de Meta
  const timeline = await withMessageTimes(db, i.storeId, existing)
  const candidate: ResponseEvent = {
    id: '\uffff', queue_id: row.id, intent, created_at: new Date().toISOString(),
    inbound_message_id: i.inboundMessageId, message_at: i.messageAt ?? null,
  }
  // Atención: una respuesta NUEVA (la más reciente en el tiempo real del
  // cliente) queda sin atender → la conversación vuelve a "Sin atender". Una
  // respuesta VIEJA que llega tarde no cambia la última decisión: hereda el
  // estado de atención de la respuesta más reciente de ese envío.
  const newest = timeline.filter(e => compareEvents(e, candidate) > 0).sort(compareEvents).pop()
  const { error } = await db.from('wa_broadcast_responses').insert({
    store_id: i.storeId, conversation_id: i.conversationId, inbound_message_id: i.inboundMessageId,
    broadcast_id: row.broadcast_id, queue_id: row.id, order_id: row.order_id, template_name: row.template_name,
    button_text: i.text, button_payload: null, intent, association: 'context_wamid',
    ...(newest?.handled_at ? { handled_at: newest.handled_at, handled_by: newest.handled_by } : {}),
  })
  if (error && error.code !== '23505') throw new Error(`wa_broadcast_responses: ${error.message ?? String(error)}`)
  return { ...base, duplicate: error?.code === '23505' }
}
