// Broadcast — respuestas ESCRITAS al template ("Sí, confirmar" citando el mensaje).
// Uso: npx tsx scripts/test-broadcast-text-replies.ts
//
// Offline: DB en memoria (C1FakeDb). Sin red, sin Supabase, sin Meta.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { C1FakeDb, type Row } from './lib/c1-fake-db'
import { normalizeButtonText, recordBroadcastButtonResponse, recordBroadcastTextReply } from '../src/lib/broadcast/responses'
import { isMarketingOptOutRequest } from '../src/lib/broadcast/suppression'
import { __resetInboxCaches, attentionConversationIds } from '../src/lib/whatsapp/conversation-search'
import { getBroadcastMetrics } from '../src/lib/broadcast/metrics'
import { buildBroadcastInboxContext, markBroadcastResponsesHandled } from '../src/lib/broadcast/inbox-context'
import { decisionsBySend } from '../src/lib/broadcast/response-timeline'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`)
}

const S1 = 'store-1', S2 = 'store-2'
const PHONE = '18295551120', OTHER_PHONE = '18295559999'

function seed() {
  __resetInboxCaches()
  const db = new C1FakeDb()
  const orderId = randomUUID(), repurchaseOrder = randomUUID()
  db.tables.orders = [
    { id: orderId, store_id: S1, order_number: '#12446', confirmation_status: 'confirmed', normalized_status: 'en_reparto' },
    { id: repurchaseOrder, store_id: S1, order_number: '#9001', confirmation_status: 'confirmed', normalized_status: 'delivered' },
  ]
  const convId = randomUUID()
  const q = (o: Partial<Row>) => ({ id: randomUUID(), store_id: S1, order_id: orderId, phone_normalized: PHONE, status: 'sent', ...o })
  db.tables.wa_template_queue = [
    q({ template_name: 'sd_broadcast_confirmation', broadcast_id: 'bc-1', wa_message_id: 'wamid.CAMPAIGN' }),
    q({ template_name: 'sd_broadcast_repurchase', broadcast_id: 'bc-2', wa_message_id: 'wamid.REPURCHASE', order_id: repurchaseOrder }),
    q({ template_name: 'order_confirmation_cod', broadcast_id: null, wa_message_id: 'wamid.AUTOMATION' }),
    q({ template_name: 'sd_broadcast_confirmation', broadcast_id: 'bc-9', wa_message_id: 'wamid.OTHERSTORE', store_id: S2 }),
  ]
  db.tables.wa_broadcast_responses = []
  db.tables.wa_contact_preferences = []
  db.tables.genesis_escalations = []
  db.tables.wa_contacts = [{ id: 'ct-1', store_id: S1, phone_normalized: PHONE }]
  db.tables.wa_conversations = [{ id: convId, store_id: S1, contact_id: 'ct-1', status: 'open' }]
  db.tables.wa_messages = []
  db.tables.wa_broadcasts = []
  const input = (o: Partial<Parameters<typeof recordBroadcastTextReply>[1]> = {}) => ({
    storeId: S1, conversationId: convId, inboundMessageId: randomUUID(), phoneNormalized: PHONE,
    text: 'Sí, confirmar', contextWamid: 'wamid.CAMPAIGN', ...o,
  })
  // Mensaje real del cliente a la hora `at` (minutos desde T0), como lo guarda el webhook.
  const T0 = Date.parse('2026-10-12T14:00:00Z')
  const msgAt = (min: number) => new Date(T0 + min * 60_000).toISOString()
  const inbound = (min: number) => {
    const id = randomUUID()
    db.t('wa_messages').push({ id, store_id: S1, conversation_id: convId, direction: 'inbound', message_type: 'text', sent_at: msgAt(min) })
    return id
  }
  const say = (text: string, min: number, o: Partial<Parameters<typeof recordBroadcastTextReply>[1]> = {}) =>
    recordBroadcastTextReply(db as never, input({ text, inboundMessageId: inbound(min), messageAt: msgAt(min), ...o }))
  return { db, orderId, convId, input, inbound, say, msgAt, queue: (wamid: string) => db.t('wa_template_queue').find(r => r.wa_message_id === wamid)! }
}

async function main() {
  console.log('\n=== B1 — asociación verificable ===')
  {
    const { db, orderId, input, queue } = seed()
    const before = JSON.stringify(db.t('orders'))
    const r = await recordBroadcastTextReply(db as never, input())
    check('B1.1 texto exacto citando el template de campaña → confirm_interest', r?.intent === 'confirm_interest' && r.association === 'context_wamid' && !r.duplicate, r)
    const row = db.t('wa_broadcast_responses')[0]
    check('B1.2 asociado a la campaña, al envío y al pedido correctos', row?.broadcast_id === 'bc-1' && row.queue_id === queue('wamid.CAMPAIGN').id && row.order_id === orderId)
    check('B1.3 guarda el texto escrito, sin payload', row?.button_text === 'Sí, confirmar' && row.button_payload === null && row.template_name === 'sd_broadcast_confirmation')
    check('B1.4 no confirma ni cancela pedidos (orders sin cambios)', JSON.stringify(db.t('orders')) === before)
    const dec = await recordBroadcastTextReply(db as never, input({ text: 'Cancelar oferta' }))
    check('B1.5 "Cancelar oferta" escrito → decline_order (pedido sin cancelar)', dec?.intent === 'decline_order' && JSON.stringify(db.t('orders')) === before)
    const rep = await recordBroadcastTextReply(db as never, input({ text: 'Sí, quiero aprovechar', contextWamid: 'wamid.REPURCHASE' }))
    check('B1.6 recompra: "Sí, quiero aprovechar" → repurchase_interest', rep?.intent === 'repurchase_interest')
  }

  console.log('\n=== B2 — coincidencia exacta (normalizada) ===')
  {
    check('B2.1 normaliza mayúsculas, tildes y espacios', normalizeButtonText('  SI,   CONFIRMAR ') === 'si, confirmar' && normalizeButtonText('Sí, confirmar') === 'si, confirmar')
    for (const text of ['si,  CONFIRMAR', 'SÍ, CONFIRMAR', ' sí, confirmar ']) {
      const { db, input } = seed()
      const r = await recordBroadcastTextReply(db as never, input({ text }))
      check(`B2.2 variante aceptada: "${text}"`, r?.intent === 'confirm_interest')
    }
    for (const text of ['Sí, confirmar mañana', 'Sí confirmar', 'si', 'confirmar', 'Sí, confirmar 🙏', 'ok', '']) {
      const { db, input } = seed()
      const r = await recordBroadcastTextReply(db as never, input({ text }))
      check(`B2.3 no exacto → no se registra: "${text}"`, r === null && db.t('wa_broadcast_responses').length === 0)
    }
  }

  console.log('\n=== B3 — mensajes no vinculados ===')
  {
    const cases: Array<[string, Partial<Parameters<typeof recordBroadcastTextReply>[1]>]> = [
      ['sin mensaje citado (texto suelto)', { contextWamid: null }],
      ['cita un mensaje desconocido', { contextWamid: 'wamid.NOEXISTE' }],
      ['cita una automatización (no Broadcast)', { contextWamid: 'wamid.AUTOMATION' }],
      ['otro teléfono', { phoneNormalized: OTHER_PHONE }],
      ['botón de OTRO template ("Ahora no" citando recuperación)', { text: 'Ahora no' }],
      ['botón de OTRO template ("Sí, confirmar" citando recompra)', { contextWamid: 'wamid.REPURCHASE' }],
    ]
    for (const [label, o] of cases) {
      const { db, input } = seed()
      const r = await recordBroadcastTextReply(db as never, input(o))
      check(`B3 ${label} → no se registra`, r === null && db.t('wa_broadcast_responses').length === 0)
    }
  }

  console.log('\n=== B4 — aislamiento entre tiendas ===')
  {
    const { db, input } = seed()
    const crossA = await recordBroadcastTextReply(db as never, input({ contextWamid: 'wamid.OTHERSTORE' }))
    const crossB = await recordBroadcastTextReply(db as never, input({ storeId: S2 }))
    check('B4.1 cita un envío de otra tienda → no se registra', crossA === null)
    check('B4.2 misma cita desde otra tienda → no se registra', crossB === null && db.t('wa_broadcast_responses').length === 0)
  }

  console.log('\n=== B5 — duplicados e historial ===')
  {
    const { db, input, inbound, msgAt } = seed()
    const id = inbound(0)
    const msg = input({ inboundMessageId: id, messageAt: msgAt(0) })
    await recordBroadcastTextReply(db as never, msg)
    const again = await recordBroadcastTextReply(db as never, msg)
    check('B5.1 mismo mensaje dos veces (reintento de Meta) → una sola fila', again?.duplicate === true && db.t('wa_broadcast_responses').length === 1)
    const parallel = await Promise.all([recordBroadcastTextReply(db as never, msg), recordBroadcastTextReply(db as never, msg)])
    check('B5.2 reintentos simultáneos del mismo mensaje → siguen siendo una fila', parallel.every(r => r?.duplicate) && db.t('wa_broadcast_responses').length === 1)

    const s2 = seed()
    const [a1, a2] = await Promise.all([s2.say('Sí, confirmar', 1), s2.say('Cancelar oferta', 2)])
    check('B5.3 dos mensajes distintos procesados a la vez → ninguno se descarta', !a1?.duplicate && !a2?.duplicate && s2.db.t('wa_broadcast_responses').length === 2)
    const sameMs = seed()
    await sameMs.say('Sí, confirmar', 5); await sameMs.say('Cancelar oferta', 5)
    check('B5.4 dos mensajes con la misma hora → ambos se conservan (desempate determinístico)', sameMs.db.t('wa_broadcast_responses').length === 2)
  }

  console.log('\n=== B9 — cambios de decisión (última intención válida por envío) ===')
  {
    const decision = async (db: C1FakeDb) => {
      const m = await getBroadcastMetrics(db as never, S1, 'bc-1')
      return { m, by: m.responses_by_intent }
    }
    // Sí → Sí
    {
      const t = seed()
      await t.say('Sí, confirmar', 1); await t.say('si, confirmar', 2)
      const { m, by } = await decision(t.db)
      check('B9.1 Sí → Sí: se guardan ambas (historial), cuenta 1 envío que quiere confirmar, sin cambio',
        t.db.t('wa_broadcast_responses').length === 2 && m.responded === 1 && by.confirm_interest === 1 && m.responses_changed === 0 && m.responses_total === 2, m)
    }
    // Sí → Cancelar
    {
      const t = seed()
      await t.say('Sí, confirmar', 1); await t.say('Cancelar oferta', 2)
      const { m, by } = await decision(t.db)
      check('B9.2 Sí → Cancelar: última = rechaza, cambió de decisión, no cuenta como "quiere confirmar"',
        m.responded === 1 && by.decline_order === 1 && !by.confirm_interest && m.responses_changed === 1, m)
      const ctx = await buildBroadcastInboxContext(t.db as never, S1, t.convId)
      check('B9.3 Inbox: muestra la última intención y «antes quería confirmar»', ctx?.responses[0].intent === 'decline_order' && ctx?.decision_changed_from === 'confirm_interest', ctx?.decision_changed_from)
    }
    // Sí → Cancelar → Sí
    {
      const t = seed()
      await t.say('Sí, confirmar', 1); await t.say('Cancelar oferta', 2)
      const back = await t.say('Sí, confirmar', 3)
      const { m, by } = await decision(t.db)
      check('B9.4 Sí → Cancelar → Sí: volver a una intención anterior SÍ se registra', !back?.duplicate && t.db.t('wa_broadcast_responses').length === 3)
      check('B9.5 Sí → Cancelar → Sí: última = quiere confirmar, cambió (antes rechazaba)',
        by.confirm_interest === 1 && !by.decline_order && m.responses_changed === 1, m)
      const ctx = await buildBroadcastInboxContext(t.db as never, S1, t.convId)
      check('B9.6 Inbox: «antes rechazaba la oferta»', ctx?.decision_changed_from === 'decline_order')
    }
    // Cancelar → Sí → Cancelar
    {
      const t = seed()
      await t.say('Cancelar oferta', 1); await t.say('Sí, confirmar', 2); await t.say('Cancelar oferta', 3)
      const { m, by } = await decision(t.db)
      check('B9.7 Cancelar → Sí → Cancelar: 3 filas, última = rechaza, cambió', t.db.t('wa_broadcast_responses').length === 3 && by.decline_order === 1 && !by.confirm_interest && m.responses_changed === 1, m)
    }
    // Botón seguido de texto con la misma intención
    {
      const t = seed()
      const q = t.queue('wamid.CAMPAIGN')
      const btnMsg = t.inbound(1)
      await recordBroadcastButtonResponse(t.db as never, { storeId: S1, conversationId: t.convId, inboundMessageId: btnMsg,
        phoneNormalized: PHONE, buttonText: 'Sí, confirmar', buttonPayload: `bc1:${q.id}:0`, contextWamid: 'wamid.CAMPAIGN' })
      const typed = await t.say('Sí, confirmar', 2)
      const { m, by } = await decision(t.db)
      check('B9.8 botón y luego lo escribe: se conserva el texto, se cuenta una sola decisión y no es cambio',
        !typed?.duplicate && t.db.t('wa_broadcast_responses').length === 2 && m.responded === 1 && by.confirm_interest === 1 && m.responses_changed === 0, m)
      const ctx = await buildBroadcastInboxContext(t.db as never, S1, t.convId)
      check('B9.9 Inbox: sin aviso de cambio', ctx?.decision_changed_from === null)
    }
    // Mensajes recibidos fuera de orden: Sí (10) → Cancelar (20, llega tarde) → Sí (30)
    {
      const t = seed()
      await t.say('Sí, confirmar', 10)
      await t.say('Sí, confirmar', 30)
      const late = await t.say('Cancelar oferta', 20)       // reintento de Meta procesado después
      const { m, by } = await decision(t.db)
      check('B9.10 fuera de orden: el evento viejo se guarda (no se descarta)', !late?.duplicate && t.db.t('wa_broadcast_responses').length === 3)
      check('B9.11 fuera de orden: la última decisión real sigue siendo "quiere confirmar"', by.confirm_interest === 1 && !by.decline_order && m.responses_changed === 1, m)
      const ctx = await buildBroadcastInboxContext(t.db as never, S1, t.convId)
      check('B9.12 Inbox ordena por hora real del cliente, no por hora de proceso', ctx?.responses[0].intent === 'confirm_interest' && ctx?.responses[0].message_at === t.msgAt(30))
    }
    // Evento viejo tardío NO sobrescribe ni reabre "Sin atender"
    {
      const t = seed()
      await t.say('Sí, confirmar', 10)
      await markBroadcastResponsesHandled(t.db as never, S1, t.convId, 'agent-1')
      await t.say('Cancelar oferta', 5)                      // más antiguo que la decisión atendida
      __resetInboxCaches()
      const attention = await attentionConversationIds(t.db as never, S1)
      const { by } = await decision(t.db)
      check('B9.13 evento viejo tardío: no cambia la última decisión ni reabre "Sin atender"', by.confirm_interest === 1 && !attention.has(t.convId))
    }
    // Nueva respuesta válida después de atendida → vuelve a "Sin atender"
    {
      const t = seed()
      await t.say('Sí, confirmar', 1)
      await markBroadcastResponsesHandled(t.db as never, S1, t.convId, 'agent-1')
      __resetInboxCaches()
      const before = (await attentionConversationIds(t.db as never, S1)).has(t.convId)
      await t.say('Cancelar oferta', 2)
      __resetInboxCaches()
      const afterChange = (await attentionConversationIds(t.db as never, S1)).has(t.convId)
      await markBroadcastResponsesHandled(t.db as never, S1, t.convId, 'agent-1')
      await t.say('Cancelar oferta', 3)
      __resetInboxCaches()
      const afterRepeat = (await attentionConversationIds(t.db as never, S1)).has(t.convId)
      check('B9.14 tras atender, una nueva respuesta válida vuelve a "Sin atender" (cambio o repetición)', !before && afterChange && afterRepeat)
    }
    // Distintas campañas y envíos
    {
      const t = seed()
      await t.say('Sí, confirmar', 1)                                       // bc-1
      await t.say('Ahora no', 2, { contextWamid: 'wamid.REPURCHASE' })      // bc-2
      const m1 = await getBroadcastMetrics(t.db as never, S1, 'bc-1')
      const m2 = await getBroadcastMetrics(t.db as never, S1, 'bc-2')
      check('B9.15 campañas distintas: cada respuesta cuenta solo en su campaña y envío',
        m1.responded === 1 && m1.responses_by_intent.confirm_interest === 1 && m1.responses_changed === 0
        && m2.responded === 1 && m2.responses_by_intent.repurchase_decline === 1 && m2.responses_changed === 0, { m1: m1.responses_by_intent, m2: m2.responses_by_intent })
      const rows = t.db.t('wa_broadcast_responses')
      check('B9.16 asociación verificable: respuesta ↔ envío ↔ campaña ↔ tienda ↔ teléfono',
        rows.every(r => r.store_id === S1 && r.conversation_id === t.convId)
        && rows[0].queue_id === t.queue('wamid.CAMPAIGN').id && rows[0].broadcast_id === 'bc-1'
        && rows[1].queue_id === t.queue('wamid.REPURCHASE').id && rows[1].broadcast_id === 'bc-2')
      const d = decisionsBySend(rows as never)
      check('B9.17 categorías mutuamente excluyentes: una decisión por envío', d.size === 2 && [...d.values()].every(x => typeof x.latest === 'string'))
    }
    // Ningún cambio automático en pedidos
    {
      const t = seed()
      const before = JSON.stringify(t.db.t('orders'))
      await t.say('Sí, confirmar', 1); await t.say('Cancelar oferta', 2); await t.say('Sí, confirmar', 3)
      await getBroadcastMetrics(t.db as never, S1, 'bc-1'); await buildBroadcastInboxContext(t.db as never, S1, t.convId)
      check('B9.18 cambios de decisión no modifican pedidos', JSON.stringify(t.db.t('orders')) === before)
      check('B9.19 cambios de decisión no crean bajas promocionales', t.db.t('wa_contact_preferences').length === 0)
    }
  }

  console.log('\n=== B6 — flujo de botones intacto ===')
  {
    const { db, convId, queue } = seed()
    const q = queue('wamid.CAMPAIGN')
    const viaPayload = await recordBroadcastButtonResponse(db as never, { storeId: S1, conversationId: convId, inboundMessageId: randomUUID(),
      phoneNormalized: PHONE, buttonText: 'Texto que Meta cambió', buttonPayload: `bc1:${q.id}:1`, contextWamid: null })
    check('B6.1 botón por payload: decline_order por índice (sin cambios)', viaPayload?.intent === 'decline_order' && viaPayload.association === 'payload')
    const loose = await recordBroadcastButtonResponse(db as never, { storeId: S1, conversationId: convId, inboundMessageId: randomUUID(),
      phoneNormalized: PHONE, buttonText: 'Sí, confirmar', buttonPayload: null, contextWamid: null })
    check('B6.2 botón sin asociación: sigue registrándose como unknown/none para revisión', loose?.intent === 'unknown' && loose.association === 'none')
  }

  console.log('\n=== B7 — bajas promocionales y Sin atender ===')
  {
    check('B7.1 textos de botones NO son baja promocional', ['Sí, confirmar', 'Cancelar oferta', 'Ahora no', 'si, confirmar'].every(t => !isMarketingOptOutRequest(t)))
    check('B7.2 la detección de bajas sigue funcionando', ['STOP', 'Baja', 'no me escriban más'].every(isMarketingOptOutRequest))
    const { db, convId, input } = seed()
    await recordBroadcastTextReply(db as never, input())
    check('B7.3 registrar la respuesta escrita no crea bajas', db.t('wa_contact_preferences').length === 0)
    const attention = await attentionConversationIds(db as never, S1)
    check('B7.4 la respuesta escrita aparece en "Sin atender"', attention.has(convId))
    db.t('wa_broadcast_responses')[0].handled_at = new Date().toISOString()
    check('B7.5 al marcarla atendida sale de "Sin atender"', !(await attentionConversationIds(db as never, S1)).has(convId))
  }

  console.log('\n=== B8 — webhook ===')
  {
    const w = readFileSync('src/app/api/webhooks/whatsapp/route.ts', 'utf8')
    const textBranch = w.indexOf('recordBroadcastTextReply(supabase')
    const optOut = w.indexOf("content.messageType === 'text' && isMarketingOptOutRequest(body)")
    check('B8.1 solo mensajes de texto, con el context.id del mensaje citado', /if \(content\.messageType === 'text'\) \{\s*try \{\s*const context = msg\.context/.test(w))
    check('B8.2 aislado en su propio try/catch y antes de la detección de bajas (que sigue igual)', textBranch > 0 && optOut > textBranch && /registro de respuesta escrita Broadcast falló/.test(w))
    check('B8.3 la confirmación automática del webhook sigue limitada a los botones de automations',
      /buttonTitle === 'Confirmar'   \? 'confirmed' :/.test(w) && /buttonTitle === 'No, gracias' \? 'cancelled' :/.test(w)
      && /if \(content\.messageType === 'button_reply' \|\| content\.messageType === 'interactive'\) \{\s*const buttonTitle/.test(w))
  }

  console.log(failures === 0 ? '\n✅ TODO OK' : `\n❌ ${failures} FALLOS`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
