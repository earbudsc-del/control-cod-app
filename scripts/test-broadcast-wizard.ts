// Sprint C.2 — asistente Grupo → Template → Destinatarios → Revisar → Enviar.
// Uso: npx tsx scripts/test-broadcast-wizard.ts
//
// Offline: DB en memoria (C1FakeDb) y `send` simulado. Sin red, sin Supabase, sin Meta.

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { C1FakeDb, type Row } from './lib/c1-fake-db'
import { createBroadcastDraft, audienceFromDraft, listBroadcasts, type BroadcastAdminContext } from '../src/lib/broadcast/broadcast-service'
import { parseBroadcastSelection, selectionTemplate } from '../src/lib/broadcast/selection'
import { templateCompatibility, BROADCAST_TEMPLATES, type BroadcastCampaign } from '../src/lib/broadcast/campaign'
import { computeLaunchPreview, computeSelectionSendable, launchBroadcast } from '../src/lib/broadcast/launch'
import { processBroadcastQueue } from '../src/lib/broadcast/processor'
import { getBroadcastMetrics } from '../src/lib/broadcast/metrics'
import { classifyMetaFailure, loadPhoneStatuses } from '../src/lib/broadcast/phone-rules'
import { paginateRecipients } from '../src/lib/broadcast/recipients'
import { renderRepurchaseTemplateBody, TEMPLATE_DEFINITIONS } from '../src/lib/broadcast/templates'
import type { SendTemplateRequest, SendTemplateResult } from '../src/lib/whatsapp/send-template'
import type { LaunchRecipient } from '../src/lib/broadcast/launch'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''}`)
}

const S1 = 'store-1'
const ADMIN: BroadcastAdminContext = { userId: 'admin-1', storeId: S1 }
const ENV = {
  WA_BROADCAST_CONFIRMATION_IMAGE_URL: 'https://cdn.example.com/luma-2x1.jpg',
  WA_BROADCAST_REPURCHASE_IMAGE_URL: 'https://cdn.example.com/luma-recompra.jpg',
}
const PERSONAL = 'LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita - x2, + 1 Cepillo GRATIS'
const DAY = 24 * 60 * 60 * 1000
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()
let seq = 0

function mkOrder(o: Partial<Row> = {}): Row {
  seq++
  return {
    id: randomUUID(), store_id: S1, order_number: `#${3000 + seq}`, source: 'shopify_webhook', shopify_order_id: `shp-${seq}`,
    is_test: false, archived_at: null, customer_name: `Cliente ${seq}`, customer_phone: `809-555-${String(3000 + seq)}`,
    city: 'Santo Domingo Este', province: 'Santo Domingo', customer_address: 'Calle 1', product_summary: PERSONAL, cod_amount: 2100,
    confirmation_status: 'pending', confirmation_attempts: 0, normalized_status: 'pending', payment_status: 'pending',
    tracking_number: null, sd_location_received_at: null, shopify_created_at: '2026-09-01T12:00:00.000Z', paid_at: null,
    customer_confirmed_at: null, created_at: '2026-09-01T00:00:00.000Z', ...o,
  }
}
const paidOrder = (daysAgo: number, o: Partial<Row> = {}) => mkOrder({
  confirmation_status: 'confirmed', payment_status: 'paid', paid_at: ago(daysAgo), normalized_status: 'delivered', ...o,
})
const phoneOf = (o: Row) => `1${String(o.customer_phone).replace(/\D/g, '')}`

function seedDb(orders: Row[]): C1FakeDb {
  const db = new C1FakeDb()
  db.tables.orders = orders; db.tables.wa_template_queue = []; db.tables.wa_broadcasts = []; db.tables.order_history = []
  db.tables.wa_contacts = []; db.tables.wa_conversations = []; db.tables.wa_messages = []
  return db
}
function sender(): { calls: SendTemplateRequest[]; fn: (r: SendTemplateRequest) => Promise<SendTemplateResult> } {
  const calls: SendTemplateRequest[] = []
  return { calls, fn: async r => { calls.push(r); return { kind: 'accepted', wamid: `wamid.${randomUUID()}` } } }
}
const deps = (db: C1FakeDb, s: ReturnType<typeof sender>, env: Record<string, string | undefined> = ENV) =>
  ({ db, env, isEnabled: () => true, send: s.fn, now: () => new Date(), sleep: async () => {} })
async function drain(db: C1FakeDb, s: ReturnType<typeof sender>, env: Record<string, string | undefined> = ENV) {
  for (let i = 0; i < 20; i++) { const r = await processBroadcastQueue(deps(db, s, env)); if (r.claimed === 0) return }
}
async function draft(db: C1FakeDb, sel: unknown) {
  const p = parseBroadcastSelection(sel)
  if (!p.ok) throw new Error(p.error)
  const r = await createBroadcastDraft(db, ADMIN, p.selection, randomUUID())
  if (!r.ok) throw new Error(r.error)
  return r.broadcast.id
}
async function launch(db: C1FakeDb, id: string, limit = 50, env: Record<string, string | undefined> = ENV) {
  const p = await computeLaunchPreview(db, ADMIN, id, limit, env)
  if (!p.ok) throw new Error(p.error)
  const r = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: randomUUID(), sendLimit: limit, confirmCount: p.preview.batch.length }, true, env)
  return { p: p.preview, r }
}
const NEUTRAL = { mode: 'filtered', filters: { scope: 'santo_domingo', status: '', payment: 'todos', date_from: null, date_to: null, search: null } }
const PENDING: BroadcastCampaign = { type: 'coordination', segment: 'pending' }
const CONFIRMED: BroadcastCampaign = { type: 'coordination', segment: 'confirmed_unpaid', route: 'all' }
const PAID: BroadcastCampaign = { type: 'repurchase', window_days: 30 }

async function main() {
  console.log('\n=== W1 — matriz de compatibilidad ===')
  {
    const m = (t: typeof BROADCAST_TEMPLATES[number], c: BroadcastCampaign) => templateCompatibility(t, c).ok
    check('W1.1 recuperación: Pendientes ✓ · Confirmados sin pagar ✓ · Pagados ✗',
      m('sd_broadcast_confirmation', PENDING) && m('sd_broadcast_confirmation', CONFIRMED) && !m('sd_broadcast_confirmation', PAID))
    check('W1.2 recompra: Pagados ✓ · Pendientes ✗ · Confirmados sin pagar ✗',
      m('sd_broadcast_repurchase', PAID) && !m('sd_broadcast_repurchase', PENDING) && !m('sd_broadcast_repurchase', CONFIRMED))
    const bad1 = parseBroadcastSelection({ ...NEUTRAL, campaign: PAID, template: 'sd_broadcast_confirmation' })
    const bad2 = parseBroadcastSelection({ mode: 'selected_ids', order_ids: [randomUUID()], campaign: PENDING, template: 'sd_broadcast_repurchase' })
    const bad3 = parseBroadcastSelection({ ...NEUTRAL, campaign: PENDING, template: 'sd_broadcast_coordination' })
    check('W1.3 el servidor rechaza combinaciones bloqueadas y nombres que no son identificadores internos',
      !bad1.ok && !bad2.ok && !bad3.ok, [bad1, bad2, bad3])
    const def = parseBroadcastSelection({ ...NEUTRAL, campaign: PAID })
    check('W1.4 sin template explícito → el del grupo (compatibilidad con borradores anteriores)', def.ok && def.selection.template === 'sd_broadcast_repurchase')
    check('W1.5 identificador interno ≠ nombre en Meta (recompra → sd_broadcast_coordination, es_DO)',
      TEMPLATE_DEFINITIONS.sd_broadcast_repurchase.metaName === 'sd_broadcast_coordination' && TEMPLATE_DEFINITIONS.sd_broadcast_repurchase.language === 'es_DO'
      && TEMPLATE_DEFINITIONS.sd_broadcast_confirmation.metaName === 'sd_broadcast_confirmation' && TEMPLATE_DEFINITIONS.sd_broadcast_confirmation.language === 'en')
  }

  console.log('\n=== W2 — recompra de punta a punta ===')
  {
    const a = paidOrder(60), b = paidOrder(45), recent = paidOrder(5), noComplete = mkOrder({ payment_status: 'paid', paid_at: null, confirmation_status: 'confirmed' })
    const db = seedDb([a, b, recent, noComplete])
    const id = await draft(db, { ...NEUTRAL, campaign: PAID, template: 'sd_broadcast_repurchase' })
    const d = db.t('wa_broadcasts').find(x => x.id === id)!
    check('W2.1 borrador de recompra creado con template_name interno y template en selection_filter',
      d.template_name === 'sd_broadcast_repurchase' && d.selection_filter.template === 'sd_broadcast_repurchase')
    const { p } = await launch(db, id)
    const ids = new Set(p.batch.map(x => x.order_id))
    check('W2.2 solo compras completadas fuera de la ventana (compra reciente y sin completar excluidas)',
      ids.size === 2 && ids.has(a.id) && ids.has(b.id) && !ids.has(recent.id) && !ids.has(noComplete.id), [...ids])
    check('W2.3 variables de recompra: 1 ({{1}} nombre)', p.batch.every(x => x.body_params.length === 1 && x.body_params[0] === x.customer_name))
    check('W2.4 la revisión expone la imagen del encabezado de recompra', p.header_image_url === ENV.WA_BROADCAST_REPURCHASE_IMAGE_URL && p.template_ready)
    const s = sender()
    await drain(db, s)
    const call = s.calls[0]
    const comps = (call?.components ?? []) as Array<{ type: string; parameters?: Array<Record<string, unknown>> }>
    check('W2.5 envío real a Meta: sd_broadcast_coordination · es_DO · imagen + 1 variable + 2 quick replies',
      s.calls.length === 2 && call.name === 'sd_broadcast_coordination' && call.language === 'es_DO'
      && (comps.find(c => c.type === 'header')?.parameters?.[0]?.image as { link?: string })?.link === ENV.WA_BROADCAST_REPURCHASE_IMAGE_URL
      && comps.find(c => c.type === 'body')?.parameters?.length === 1 && comps.filter(c => c.type === 'button').length === 2, call)
    const msg = db.t('wa_messages').find(x => x.metadata?.template_name === 'sd_broadcast_repurchase')
    const approved = `🎁 *Tenemos una oferta especial para ti!*\n\nHola, ${a.customer_name} 😊\nPor ser cliente *LÜMA*, tienes un beneficio especial para renovar tu tratamiento 🦷✨\n\n*2 LÜMA Teeth — 10% de descuento*\nAntes: RD$2,100\n💙 Ahora: *RD$1,890*\n🚚 Envío gratis\n💵 Pagas al recibir\n\n*¿Quieres aprovechar tu precio especial?*`
    check('W2.6 copia de auditoría = texto aprobado en Meta (precios del catálogo)', renderRepurchaseTemplateBody([a.customer_name]) === approved
      && !!msg && msg.metadata.meta_template_name === 'sd_broadcast_coordination', msg?.body)
    const m = await getBroadcastMetrics(db, S1, id)
    check('W2.7 historial y métricas de la campaña de recompra', m.queued === 2 && m.accepted === 2)
  }
  {
    const a = paidOrder(60)
    const db = seedDb([a])
    const id = await draft(db, { ...NEUTRAL, campaign: PAID, template: 'sd_broadcast_repurchase' })
    const noImg = { WA_BROADCAST_CONFIRMATION_IMAGE_URL: ENV.WA_BROADCAST_CONFIRMATION_IMAGE_URL }
    const p = await computeLaunchPreview(db, ADMIN, id, 10, noImg)
    check('W2.8 sin WA_BROADCAST_REPURCHASE_IMAGE_URL → template no listo (fail-closed)', p.ok && !p.preview.template_ready
      && p.preview.template_missing.includes('WA_BROADCAST_REPURCHASE_IMAGE_URL') && p.preview.header_image_url === null)
  }
  {
    // Revalidación en el envío: pedido activo nuevo / compra nueva tras lanzar.
    const a = paidOrder(60), b = paidOrder(50)
    const db = seedDb([a, b])
    const id = await draft(db, { ...NEUTRAL, campaign: PAID, template: 'sd_broadcast_repurchase' })
    await launch(db, id)
    db.tables.orders.push(mkOrder({ customer_phone: a.customer_phone }))                   // a: pedido activo en curso
    db.tables.orders.push(paidOrder(1, { customer_phone: b.customer_phone }))             // b: compra completada nueva
    const s = sender()
    await drain(db, s)
    const rows = db.t('wa_template_queue').filter(r => r.broadcast_id === id)
    check('W2.9 antes de enviar: pedido activo o compra nueva → omitido, sin envío',
      s.calls.length === 0 && rows.find(r => r.order_id === a.id)?.skip_reason === 'no_longer_eligible:active_order_in_progress'
      && rows.find(r => r.order_id === b.id)?.skip_reason === 'no_longer_eligible:recent_purchase', rows.map(r => r.skip_reason))
  }
  {
    // Pagados con clientes elegidos a mano.
    const ps = [paidOrder(60), paidOrder(61), paidOrder(62), paidOrder(63)]
    const db = seedDb(ps)
    const id = await draft(db, { mode: 'selected_ids', order_ids: [ps[1].id, ps[3].id], campaign: PAID, template: 'sd_broadcast_repurchase' })
    const { p } = await launch(db, id)
    check('W2.10 Pagados · clientes elegidos: entran exactamente esos 2', p.batch.length === 2
      && new Set(p.batch.map(x => x.order_id)).has(ps[1].id) && new Set(p.batch.map(x => x.order_id)).has(ps[3].id))
  }

  console.log('\n=== W3 — selección manual en grupos de recuperación ===')
  {
    const os = Array.from({ length: 5 }, () => mkOrder())
    const db = seedDb(os)
    const chosen = [os[0].id, os[2].id, os[4].id]
    const id = await draft(db, { mode: 'selected_ids', order_ids: chosen, campaign: PENDING, template: 'sd_broadcast_confirmation' })
    const { p } = await launch(db, id)
    os[2].payment_status = 'paid'
    const s = sender()
    await drain(db, s)
    check('W3.1 lote = exactamente los elegidos; uno que deja de ser elegible se omite y no se sustituye',
      p.batch.length === 3 && p.batch.every(x => chosen.includes(x.order_id)) && s.calls.length === 2, { batch: p.batch.length, sent: s.calls.length })
    check('W3.2 variables exactas por destinatario (5 en recuperación)', p.batch.every(x => x.body_params.length === 5 && x.body_params[3] === '2,100'))
  }

  console.log('\n=== W4 — reglas por teléfono (todos los templates) ===')
  {
    const o = { f3: mkOrder(), f8: mkOrder(), failed3: mkOrder(), r49: mkOrder(), r49old: mkOrder(), u26: mkOrder(), u26ok: mkOrder(), u26tie: mkOrder(), u26wh: mkOrder(), ok: mkOrder() }
    const db = seedDb(Object.values(o))
    const otherB = 'other-broadcast'
    const q = (ord: Row, extra: Partial<Row>) => db.t('wa_template_queue').push({ id: randomUUID(), store_id: S1, order_id: randomUUID(),
      template_name: 'sd_broadcast_repurchase', phone_normalized: phoneOf(ord), broadcast_id: otherB, attempt_count: 1, created_at: ago(30), ...extra })
    q(o.f3,      { status: 'sent', processed_at: ago(3) })
    q(o.f8,      { status: 'sent', processed_at: ago(8) })
    q(o.failed3, { status: 'failed', processed_at: ago(3), meta_error_code: '131047' })
    q(o.r49,     { status: 'failed', processed_at: ago(2), meta_error_code: '131049' })
    q(o.r49old,  { status: 'failed', processed_at: ago(9), meta_error_code: '131049' })
    q(o.u26,     { status: 'failed', processed_at: ago(20), meta_error_code: '131026' })
    q(o.u26ok,   { status: 'failed', processed_at: ago(20), meta_error_code: '131026' })
    q(o.u26tie,  { status: 'failed', processed_at: '2026-09-20T10:00:00.000Z', meta_error_code: '131026' })
    // Evidencia: entrante posterior (u26ok) y entrante con la MISMA hora (u26tie).
    const conv = (ord: Row) => { const ct = randomUUID(), cv = randomUUID()
      db.t('wa_contacts').push({ id: ct, store_id: S1, phone_normalized: phoneOf(ord) }); db.t('wa_conversations').push({ id: cv, store_id: S1, contact_id: ct }); return cv }
    db.t('wa_messages').push({ id: randomUUID(), store_id: S1, conversation_id: conv(o.u26ok), direction: 'inbound', status: 'received', sent_at: ago(1) })
    db.t('wa_messages').push({ id: randomUUID(), store_id: S1, conversation_id: conv(o.u26tie), direction: 'inbound', status: 'received', sent_at: '2026-09-20T10:00:00.000Z' })
    // 131026 reportado por webhook (wa_messages) en un mensaje de automatización.
    db.t('wa_messages').push({ id: randomUUID(), store_id: S1, conversation_id: conv(o.u26wh), direction: 'outbound', status: 'failed', error_code: '131026', sent_at: ago(4) })

    const st = await loadPhoneStatuses(db, S1, Object.values(o).map(phoneOf))
    const r = (ord: Row) => st.get(phoneOf(ord))?.restriction ?? null
    check('W4.1 Broadcast recibido hace 3 días (otro template) → frequency_cap_7d; hace 8 → libre', r(o.f3) === 'frequency_cap_7d' && r(o.f8) === null)
    check('W4.2 failed no cuenta para la frecuencia', r(o.failed3) === null)
    check('W4.3 131049 hace 2 días → marketing_restricted_recent; hace 9 → libre', r(o.r49) === 'marketing_restricted_recent' && r(o.r49old) === null)
    check('W4.4 131026 sin evidencia → bloqueado en TODOS los templates', r(o.u26) === 'phone_unavailable_whatsapp')
    check('W4.5 131026 + mensaje entrante posterior → desbloqueado', r(o.u26ok) === null)
    check('W4.6 empate (entrante con la misma hora del fallo) → sigue bloqueado', r(o.u26tie) === 'phone_unavailable_whatsapp')
    check('W4.7 131026 reportado por webhook en wa_messages → bloqueado', r(o.u26wh) === 'phone_unavailable_whatsapp')
    check('W4.8 teléfono sin historial → libre', r(o.ok) === null)

    const sel = parseBroadcastSelection({ mode: 'selected_ids', order_ids: Object.values(o).map(x => x.id), campaign: PENDING, template: 'sd_broadcast_confirmation' })
    if (!sel.ok) throw new Error(sel.error)
    const sendable = await computeSelectionSendable(db, ADMIN, sel.selection, ENV)
    const sIds = new Set(sendable.sendable.map(x => x.order_id))
    check('W4.9 el asistente aplica las 3 reglas (enviables: f8, failed3, r49old, u26ok, ok)',
      sIds.size === 5 && [o.f8, o.failed3, o.r49old, o.u26ok, o.ok].every(x => sIds.has(x.id))
      && sendable.launch_excluded_by_reason.frequency_cap_7d === 1 && sendable.launch_excluded_by_reason.marketing_restricted_recent === 1
      && sendable.launch_excluded_by_reason.phone_unavailable_whatsapp === 3, sendable.launch_excluded_by_reason)
  }
  {
    // Antes de enviar: aparece un Broadcast reciente al mismo teléfono (otra campaña) → omitido.
    // La propia fila en 'processing' no se bloquea a sí misma.
    const a = mkOrder(), b = mkOrder()
    const db = seedDb([a, b])
    const id = await draft(db, { mode: 'selected_ids', order_ids: [a.id, b.id], campaign: PENDING, template: 'sd_broadcast_confirmation' })
    await launch(db, id)
    db.t('wa_template_queue').push({ id: randomUUID(), store_id: S1, order_id: randomUUID(), template_name: 'sd_broadcast_repurchase',
      phone_normalized: phoneOf(a), broadcast_id: 'other', status: 'sent', processed_at: ago(1), created_at: ago(1) })
    const s = sender()
    await drain(db, s)
    const rows = db.t('wa_template_queue').filter(r => r.broadcast_id === id)
    check('W4.10 antes de enviar: Broadcast reciente → omitido (frequency_cap_7d); el otro se envía (su propia fila no lo bloquea)',
      s.calls.length === 1 && rows.find(r => r.order_id === a.id)?.skip_reason === 'frequency_cap_7d'
      && rows.find(r => r.order_id === b.id)?.status === 'sent', rows.map(r => [r.status, r.skip_reason]))
  }

  console.log('\n=== W5 — destinatarios: búsqueda y paginación ===')
  {
    const all: LaunchRecipient[] = Array.from({ length: 60 }, (_, i) => ({
      order_id: `o${i}`, order_number: `#${1000 + i}`, customer_name: i === 7 ? 'María Pérez' : `Cliente ${i}`,
      phone_normalized: `1809555${String(1000 + i).padStart(4, '0')}`, warnings: [], body_params: ['x'],
    }))
    const p1 = paginateRecipients(all, { page: 1, page_size: 25 })
    const p3 = paginateRecipients(all, { page: 9, page_size: 25 })
    check('W5.1 paginación: 25 por página, 3 páginas, página fuera de rango → última', p1.items.length === 25 && p1.pages === 3 && p3.page === 3 && p3.items.length === 10)
    check('W5.2 búsqueda por nombre sin acentos / pedido / teléfono',
      paginateRecipients(all, { search: 'maria perez' }).filtered_total === 1 && paginateRecipients(all, { search: '#1042' }).items[0]?.order_id === 'o42'
      && paginateRecipients(all, { search: '5551059' }).items[0]?.order_id === 'o59')
    check('W5.3 tamaño de página acotado (máx. 100)', paginateRecipients(all, { page_size: 5000 }).page_size === 100)
  }

  console.log('\n=== W6 — fallos clasificados ===')
  {
    check('W6.1 clasificación', classifyMetaFailure('131026') === 'phone_unavailable' && classifyMetaFailure('131049') === 'marketing_restricted'
      && classifyMetaFailure('132000') === 'template_config' && classifyMetaFailure('130429') === 'temporary_exhausted'
      && classifyMetaFailure(null, 'Meta API error 503: x') === 'temporary_exhausted' && classifyMetaFailure('131047') === 'other')
    const db = seedDb([])
    db.t('wa_template_queue').push(
      { id: randomUUID(), store_id: S1, order_id: 'x1', broadcast_id: 'b1', status: 'failed', meta_error_code: '131026' },
      { id: randomUUID(), store_id: S1, order_id: 'x2', broadcast_id: 'b1', status: 'failed', meta_error_code: '131049' },
      { id: randomUUID(), store_id: S1, order_id: 'x3', broadcast_id: 'b1', status: 'failed', meta_error_code: '132001' },
      { id: randomUUID(), store_id: S1, order_id: 'x4', broadcast_id: 'b1', status: 'failed', meta_error_code: null, error_message: 'Meta API error 500: boom' })
    const m = await getBroadcastMetrics(db, S1, 'b1')
    check('W6.2 métricas: failed_by_category separa número, marketing, template y temporal', m.failed === 4
      && m.failed_by_category.phone_unavailable === 1 && m.failed_by_category.marketing_restricted === 1
      && m.failed_by_category.template_config === 1 && m.failed_by_category.temporary_exhausted === 1, m.failed_by_category)
  }

  console.log('\n=== W7 — compatibilidad y defensas del motor ===')
  {
    // Borrador anterior a C.2 (sin template en selection_filter) sigue funcionando.
    const a = mkOrder()
    const db = seedDb([a])
    const id = await draft(db, { mode: 'selected_ids', order_ids: [a.id], campaign: PENDING })
    const b = db.t('wa_broadcasts').find(x => x.id === id)!
    delete b.selection_filter.template
    const { selection } = audienceFromDraft(b.selection_filter)
    const p = await computeLaunchPreview(db, ADMIN, id, 10, ENV)
    check('W7.1 borrador sin template (C.1) → template del grupo; vista previa OK', selectionTemplate(selection) === 'sd_broadcast_confirmation' && p.ok && p.preview.batch.length === 1)
    // Manipulación: template_name de la fila ≠ selección → el processor no envía.
    await launch(db, id)
    b.template_name = 'sd_broadcast_repurchase'
    const s = sender()
    await processBroadcastQueue(deps(db, s))
    check('W7.2 template de la fila ≠ selección → el processor no envía y deja last_error', s.calls.length === 0 && !!b.last_error, b.last_error)
  }

  console.log('\n=== W8 — interfaz ===')
  {
    const wiz = readFileSync('src/components/broadcast/BroadcastWizard.tsx', 'utf8')
    const page = readFileSync('src/app/(app)/confirmacion/page.tsx', 'utf8')
    check('W8.1 /confirmacion usa el asistente (el modal antiguo ya no existe)', /BroadcastWizard/.test(page) && !/BroadcastPrepareModal/.test(page))
    check('W8.2 pasos Grupo → Template → Destinatarios → Revisar → Enviar', /'Grupo'[\s\S]*'Template'[\s\S]*'Destinatarios'[\s\S]*'Revisar'[\s\S]*'Enviar'/.test(wiz))
    const draftCalls = wiz.match(/postJson<[^>]*>\('\/api\/admin\/broadcasts'/g) ?? []
    const launchCalls = wiz.match(/\/launch`/g) ?? []
    check('W8.3 nada automático: un único POST de borrador (createDraft, con botón) y un único lanzamiento (launch)',
      draftCalls.length === 1 && launchCalls.length === 1 && /async function createDraft\(\)/.test(wiz) && /onClick=\{createDraft\}/.test(wiz) && /onClick=\{launch\}/.test(wiz))
    check('W8.4 enviar exige Broadcast activo + confirmación escrita + aceptación', /review\.broadcast_enabled && review\.template_ready && count > 0\s*\n\s*&& ack && typed\.trim\(\) === String\(count\)/.test(wiz))
    const oldTexts = /aún no es un template aprobado|se sube a Meta en Sprint C|solo preview hasta la migración/
    check('W8.5 sin textos desactualizados de la vista previa', !oldTexts.test(wiz) && !oldTexts.test(readFileSync('src/components/broadcast/BroadcastLaunchModal.tsx', 'utf8')))
    const route = readFileSync('src/app/api/admin/broadcasts/recipients/route.ts', 'utf8')
    check('W8.6 endpoint de destinatarios: admin validado antes del cliente privilegiado y solo lectura',
      route.indexOf('getBroadcastAdminContext(') < route.indexOf('createPrivilegedServiceClient()') && /if \(!auth\.ok\) return/.test(route)
      && !/\.(insert|update|upsert|delete)\(/.test(route))
  }

  console.log('\n=== V — verificación previa al commit ===')
  const optOut = (db: C1FakeDb, o: Row) => {
    db.tables.wa_contact_preferences = db.tables.wa_contact_preferences ?? []
    db.t('wa_contact_preferences').push({ id: randomUUID(), store_id: S1, phone_normalized: phoneOf(o), marketing_opt_out: true })
  }
  {
    // V1 — «Todo el grupo»: enviables con el template ≠ clientes del segmento.
    const os = Array.from({ length: 5 }, () => mkOrder())
    const db = seedDb(os); optOut(db, os[0])
    db.t('wa_template_queue').push({ id: randomUUID(), store_id: S1, order_id: randomUUID(), template_name: 'sd_broadcast_repurchase',
      phone_normalized: phoneOf(os[1]), broadcast_id: 'other', status: 'sent', processed_at: ago(2), created_at: ago(2) })
    const sel = parseBroadcastSelection({ ...NEUTRAL, campaign: PENDING, template: 'sd_broadcast_confirmation' })
    if (!sel.ok) throw new Error(sel.error)
    const r = await computeSelectionSendable(db, ADMIN, sel.selection, ENV)
    const wiz = readFileSync('src/components/broadcast/BroadcastWizard.tsx', 'utf8')
    const route = readFileSync('src/app/api/admin/broadcasts/recipients/route.ts', 'utf8')
    check('V1.1 grupo: 5 elegibles del segmento, 3 enviables con el template (baja promocional y 7 días excluidos con motivo)',
      r.audience.eligible_count === 5 && r.sendable.length === 3
      && r.launch_excluded_by_reason.marketing_opt_out === 1 && r.launch_excluded_by_reason.frequency_cap_7d === 1,
      { eligible: r.audience.eligible_count, sendable: r.sendable.length, ex: r.launch_excluded_by_reason })
    check('V1.2 la API y la UI muestran ambos totales por separado; «Todo el grupo» usa el total enviable',
      /candidate_count:/.test(route) && /eligible_count:/.test(route) && /sendable_total: r\.sendable\.length/.test(route)
      && /Elegibles del grupo/.test(wiz) && /Enviables con este template/.test(wiz) && /Todo el grupo enviable\$\{recipients \? ` \(\$\{recipients\.sendable_total\}\)`/.test(wiz))
  }
  {
    // V2 — selección manual: excluido con motivo visible, nunca sustituido (vista previa y envío).
    const os = Array.from({ length: 6 }, () => mkOrder())
    const db = seedDb(os)
    const chosen = [os[0], os[1], os[2]]
    const id = await draft(db, { mode: 'selected_ids', order_ids: chosen.map(o => o.id), campaign: PENDING, template: 'sd_broadcast_confirmation' })
    os[1].payment_status = 'paid'
    const p = await computeLaunchPreview(db, ADMIN, id, 50, ENV)
    if (!p.ok) throw new Error(p.error)
    const batchIds = new Set(p.preview.batch.map(x => x.order_id))
    const ex = p.preview.audience_excluded.find(x => x.order_id === os[1].id)
    check('V2.1 revisión: el elegido que ya pagó sale del lote con su nombre y motivo; nadie lo sustituye',
      batchIds.size === 2 && batchIds.has(os[0].id) && batchIds.has(os[2].id) && !!ex && ex.reason === 'paid'
      && ex.customer_name === os[1].customer_name && ![os[3], os[4], os[5]].some(o => batchIds.has(o.id)), { batch: [...batchIds], ex })
    await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: randomUUID(), sendLimit: 50, confirmCount: 2 }, true, ENV)
    optOut(db, os[2])
    const s2 = sender(); await drain(db, s2)
    const rows = db.t('wa_template_queue').filter(r => r.broadcast_id === id)
    const m = await getBroadcastMetrics(db, S1, id)
    check('V2.2 envío: otro elegido pide baja → omitido (marketing_opt_out); la cola no crece ni se rellena',
      s2.calls.length === 1 && rows.length === 2 && rows.find(r => r.order_id === os[2].id)?.skip_reason === 'marketing_opt_out'
      && m.skipped_by_reason.marketing_opt_out === 1, { sent: s2.calls.length, rows: rows.map(r => [r.order_id, r.status, r.skip_reason]) })
    const panel = readFileSync('src/components/broadcast/BroadcastCampaignPanel.tsx', 'utf8')
    check('V2.3 motivo visible: revisión lista excluidos con motivo; el panel muestra «Omitidos por causa»',
      /review\.audience_excluded\.map/.test(readFileSync('src/components/broadcast/BroadcastWizard.tsx', 'utf8')) && /Omitidos por causa/.test(panel))
  }
  {
    // V3 — recompra: una oferta por compra completada (pedido ancla + deduplicación existente).
    const older = paidOrder(60), anchor = paidOrder(45, { customer_phone: older.customer_phone }), other = paidOrder(50)
    const db = seedDb([older, anchor, other])
    const id1 = await draft(db, { ...NEUTRAL, campaign: PAID, template: 'sd_broadcast_repurchase' })
    const { p: p1 } = await launch(db, id1)
    check('V3.1 cliente con 2 compras completadas → 1 sola oferta, anclada a la compra más reciente',
      p1.batch.length === 2 && p1.batch.filter(x => x.phone_normalized === phoneOf(anchor)).length === 1
      && p1.batch.some(x => x.order_id === anchor.id) && !p1.batch.some(x => x.order_id === older.id))
    db.t('wa_broadcasts').find(b => b.id === id1)!.status = 'completed'
    // La oferta de `other` falla en Meta (no es 131026/131049): nunca se reenvía sola.
    db.t('wa_template_queue').find(r => r.order_id === other.id)!.status = 'failed'
    db.t('wa_template_queue').find(r => r.order_id === anchor.id)!.status = 'sent'
    db.t('wa_template_queue').find(r => r.order_id === anchor.id)!.processed_at = ago(10)
    const sel2 = parseBroadcastSelection({ ...NEUTRAL, campaign: PAID, template: 'sd_broadcast_repurchase' })
    if (!sel2.ok) throw new Error(sel2.error)
    const r2 = await computeSelectionSendable(db, ADMIN, sel2.selection, ENV)
    const d2 = await createBroadcastDraft(db, ADMIN, sel2.selection, randomUUID())
    check('V3.2 nueva campaña: la misma compra (enviada o fallida) no recibe otra oferta → repurchase_already_contacted; no se crea borrador vacío',
      r2.sendable.length === 0 && r2.audience.excluded_by_reason.repurchase_already_contacted === 2 && !d2.ok,
      { ex: r2.audience.excluded_by_reason, d2 })
    const dup = await db.from('wa_template_queue').insert({ id: randomUUID(), store_id: S1, order_id: anchor.id, template_name: 'sd_broadcast_repurchase',
      phone_normalized: phoneOf(anchor), broadcast_id: 'b-dup', status: 'pending' })
    check('V3.3 respaldo en DB: UNIQUE(order_id, template_name) rechaza una segunda oferta para el mismo pedido ancla',
      (dup as { error?: { code?: string } }).error?.code === '23505')
  }
  {
    // V4 + V5 — antes de CADA envío: 7 días entre templates, 131049 y 131026 de otros Broadcast, estado del pedido.
    const a = mkOrder(), b = mkOrder(), c = mkOrder(), d = mkOrder(), e = mkOrder()
    const db = seedDb([a, b, c, d, e])
    const id = await draft(db, { mode: 'selected_ids', order_ids: [a, b, c, d, e].map(o => o.id), campaign: PENDING, template: 'sd_broadcast_confirmation' })
    await launch(db, id)
    const otherRow = (o: Row, extra: Partial<Row>) => db.t('wa_template_queue').push({ id: randomUUID(), store_id: S1, order_id: randomUUID(),
      template_name: 'sd_broadcast_repurchase', phone_normalized: phoneOf(o), broadcast_id: 'other', created_at: ago(30), ...extra })
    otherRow(a, { status: 'send_unknown', processed_at: ago(6) })                              // 7 días (incierto cuenta)
    otherRow(b, { status: 'failed', meta_error_code: '131049', processed_at: ago(3) })        // 131049 reciente
    otherRow(c, { status: 'failed', meta_error_code: '131049', processed_at: ago(8) })        // 131049 vencido → se envía
    otherRow(d, { status: 'failed', meta_error_code: '131026', processed_at: ago(20) })       // 131026 sin evidencia
    e.confirmation_status = 'confirmed'                                                        // cambió el estado del pedido
    const s = sender(); await drain(db, s)
    const sk = (o: Row) => db.t('wa_template_queue').find(r => r.broadcast_id === id && r.order_id === o.id)?.skip_reason
    check('V4.1 7 días entre templates distintos (send_unknown de recompra bloquea recuperación)', sk(a) === 'frequency_cap_7d', sk(a))
    check('V4.2 131049 de otro Broadcast bloquea durante 7 días; vencido el plazo, se envía',
      sk(b) === 'marketing_restricted_recent' && s.calls.length === 1 && s.calls[0].to === phoneOf(c), { b: sk(b), sent: s.calls.map(x => x.to) })
    check('V5.1 revalidación justo antes del envío: 131026 y cambio de estado del pedido también se omiten',
      sk(d) === 'phone_unavailable_whatsapp' && /^no_longer_eligible:/.test(String(sk(e))), { d: sk(d), e: sk(e) })
    const proc = readFileSync('src/lib/broadcast/processor.ts', 'utf8')
    const order = ['.from(\'orders\')', 'loadOptedOutPhones(', 'loadPhoneStatuses(', 'd.send(']
    const idx = order.map(k => proc.indexOf(k))
    check('V5.2 orden en el processor: pedido → baja → teléfono → (flag/pausa) → Meta, todo por fila', idx.every((v, i) => v > 0 && (i === 0 || v > idx[i - 1])), idx)
  }
  {
    // V6 — borrador e historial reflejan grupo, template y destinatarios.
    const os = Array.from({ length: 3 }, () => mkOrder({ confirmation_status: 'confirmed' }))
    const db = seedDb(os)
    const id = await draft(db, { mode: 'selected_ids', order_ids: [os[0].id, os[2].id], campaign: CONFIRMED, template: 'sd_broadcast_confirmation' })
    const list = await listBroadcasts(db as never, S1) as Array<Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
    const row = list.find(r => r.id === id)!
    check('V6.1 borrador: template interno, grupo (segmento) y los ids exactos elegidos',
      row.template_name === 'sd_broadcast_confirmation' && row.selection_filter.template === 'sd_broadcast_confirmation'
      && row.selection_filter.campaign.segment === 'confirmed_unpaid' && row.selection_filter.mode === 'selected_ids'
      && JSON.stringify(row.selection_filter.order_ids) === JSON.stringify([os[0].id, os[2].id]), row.selection_filter)
    await launch(db, id)
    const q = db.t('wa_template_queue').filter(r => r.broadcast_id === id)
    check('V6.2 cola: solo los elegidos, con el template del borrador', q.length === 2 && q.every(r => r.template_name === 'sd_broadcast_confirmation')
      && new Set(q.map(r => r.order_id)).has(os[0].id) && new Set(q.map(r => r.order_id)).has(os[2].id))
    const hist = readFileSync('src/components/broadcast/BroadcastHistoryModal.tsx', 'utf8')
    check('V6.3 historial: grupo con los nombres del asistente, template con su nombre en Meta y tipo de selección',
      /GROUP_LABELS\[campaignGroup\(c\)\]/.test(hist) && /def\.label\} \(Meta: \$\{def\.metaName\}\)/.test(hist)
      && /Clientes elegidos · /.test(hist) && /Todo el grupo enviable/.test(hist))
  }

  console.log(failures === 0 ? '\n✅ TODO OK' : `\n❌ ${failures} FALLOS`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
