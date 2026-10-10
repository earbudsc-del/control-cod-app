// Sprint C.1 — Broadcast operativo + Inbox humano. 100% offline.
//
// DB en memoria (scripts/lib/c1-fake-db.ts), Meta simulado, reloj inyectado.
// NO lee .env.local, NO conecta a Supabase, NO llama a Meta, NO envía nada.
//
// Corre con: npx tsx scripts/test-broadcast-c1.ts  (o npm run test:broadcast-c1)

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { C1FakeDb, type Row } from './lib/c1-fake-db'
import { createBroadcastDraft, type BroadcastAdminContext } from '../src/lib/broadcast/broadcast-service'
import { parseBroadcastSelection } from '../src/lib/broadcast/selection'
import { computeLaunchPreview, launchBroadcast, pauseBroadcast, resumeBroadcast } from '../src/lib/broadcast/launch'
import { processBroadcastQueue, MAX_ATTEMPTS } from '../src/lib/broadcast/processor'
import { recordBroadcastButtonResponse } from '../src/lib/broadcast/responses'
import { getBroadcastMetrics } from '../src/lib/broadcast/metrics'
import { buildBroadcastInboxContext, markBroadcastResponsesHandled } from '../src/lib/broadcast/inbox-context'
import { isMarketingOptOutRequest, recordMarketingOptOut } from '../src/lib/broadcast/suppression'
import { buildConfirmationBodyParams, buildRepurchaseBodyParams, buildTemplateComponents, parseButtonPayload, resolveTemplateConfig, sanitizeTemplateParam } from '../src/lib/broadcast/templates'
import { assignLocationToOrder, handleInboundLocation, listPendingLocationAssignments } from '../src/lib/whatsapp/inbound-location'
import { aiEnabledAfterRelease, aiEnabledForAssignment } from '../src/lib/broadcast/conversation-guard'
import { isWithinServiceWindow } from '../src/lib/whatsapp/conversation-window'
import { getBroadcastAdminContext } from '../src/lib/broadcast/admin-context'
import { isAutomationQueueCandidate } from '../src/lib/wa-queue/automation-queue'
import { isGenesisEnabled } from '../src/lib/config/genesis'
import type { SendTemplateRequest, SendTemplateResult } from '../src/lib/whatsapp/send-template'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const S1 = 'store-1', S2 = 'store-2'
const ADMIN: BroadcastAdminContext = { userId: 'admin-1', storeId: S1 }
const ENV = {
  WA_BROADCAST_CONFIRMATION_IMAGE_URL: 'https://cdn.example.com/luma-2x1.jpg',
}
const PERSONAL = 'LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita - x2, + 1 Cepillo GRATIS'
let seq = 0

function mkOrder(o: Partial<Row> = {}): Row {
  seq++
  return {
    id: randomUUID(), store_id: S1, order_number: `#${9000 + seq}`, source: 'shopify_webhook', shopify_order_id: `shp-${seq}`,
    is_test: false, archived_at: null, customer_name: `Cliente ${seq}`, customer_phone: `809-555-${String(1000 + seq)}`,
    city: 'Santo Domingo Este', province: 'Santo Domingo', customer_address: 'Calle 1', product_summary: PERSONAL, cod_amount: 2100,
    confirmation_status: 'pending', confirmation_attempts: 0, normalized_status: 'pending', payment_status: 'pending',
    tracking_number: null, sd_location_received_at: null, shopify_created_at: '2026-10-01T12:00:00.000Z', paid_at: null,
    customer_confirmed_at: null, created_at: '2026-10-01T00:00:00.000Z', ...o,
  }
}

function phoneOf(o: Row): string { return `1${String(o.customer_phone).replace(/\D/g, '')}` }

async function mkDraft(db: C1FakeDb, orders: Row[], segment: 'pending' | 'confirmed_unpaid' = 'pending', ctx = ADMIN) {
  const sel = parseBroadcastSelection({ mode: 'selected_ids', order_ids: orders.map(o => o.id), campaign: { type: 'coordination', segment } })
  if (!sel.ok) throw new Error(sel.error)
  const r = await createBroadcastDraft(db, ctx, sel.selection, randomUUID())
  if (!r.ok) throw new Error(r.error)
  return r.broadcast.id
}

function seedDb(orders: Row[]): C1FakeDb {
  const db = new C1FakeDb()
  db.tables.orders = orders
  db.tables.wa_template_queue = []
  db.tables.wa_broadcasts = []
  return db
}

type SendMock = { calls: SendTemplateRequest[]; fn: (r: SendTemplateRequest) => Promise<SendTemplateResult> }
function sender(results: Array<SendTemplateResult['kind'] | SendTemplateResult> = []): SendMock {
  const calls: SendTemplateRequest[] = []
  let i = 0
  return {
    calls,
    fn: async (r) => {
      calls.push(r)
      const next = results[i++] ?? 'accepted'
      if (typeof next !== 'string') return next
      switch (next) {
        case 'accepted':     return { kind: 'accepted', wamid: `wamid.${randomUUID()}` }
        case 'ambiguous':    return { kind: 'ambiguous', error: 'timeout' }
        case 'rate_limited': return { kind: 'rate_limited', httpStatus: 429, metaCode: '130429', error: 'rate' }
        case 'server_error': return { kind: 'server_error', httpStatus: 503, metaCode: null, error: '503' }
        case 'rejected':     return { kind: 'rejected', httpStatus: 400, metaCode: '131026', error: 'undeliverable' }
        case 'not_configured': return { kind: 'not_configured', error: 'sin credenciales' }
      }
    },
  }
}

let clock = new Date()
const nowFn = () => (clock.getTime() > Date.now() ? clock : new Date())
let flag = true

function deps(db: C1FakeDb, s: SendMock, env: Record<string, string | undefined> = ENV) {
  return { db, env, isEnabled: () => flag, send: s.fn, now: nowFn, sleep: async () => {} }
}

async function launchAll(db: C1FakeDb, id: string, limit = 50) {
  const p = await computeLaunchPreview(db, ADMIN, id, limit, ENV)
  if (!p.ok) throw new Error(p.error)
  return launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: randomUUID(), sendLimit: limit, confirmCount: p.preview.batch.length }, true, ENV)
}

const rows = (db: C1FakeDb, id: string) => db.t('wa_template_queue').filter(r => r.broadcast_id === id)

async function main() {
  console.log('\n=== Audiencia (1–8) ===')
  {
    const o = {
      pending:   mkOrder(),
      paid:      mkOrder({ payment_status: 'paid', paid_at: '2026-10-02T00:00:00Z' }),
      cancelled: mkOrder({ confirmation_status: 'cancelled' }),
      tracking:  mkOrder({ tracking_number: 'EFI-123' }),
      familiar:  mkOrder({ product_summary: 'LÜMA Teeth™ — Pasta Dental Restauradora - x4, + 2 Cepillos GRATIS - x2', cod_amount: 3400 }),
      priority:  mkOrder({ product_summary: `${PERSONAL}, Envio prioritario`, cod_amount: 2200 }),
      badPhone:  mkOrder({ customer_phone: '12345' }),
      dupA:      mkOrder({ customer_phone: '809-555-7777' }),
      dupB:      mkOrder({ customer_phone: '809-555-7777' }),
    }
    const db = seedDb(Object.values(o))
    const id = await mkDraft(db, Object.values(o))
    const p = await computeLaunchPreview(db, ADMIN, id, 50, ENV)
    if (!p.ok) throw new Error(p.error)
    const batch = new Set(p.preview.batch.map(b => b.order_id))
    const ex = { ...p.preview.revalidated.excluded_by_reason, ...p.preview.launch_excluded_by_reason } as Record<string, number>
    check('1. pedido pendiente elegible', batch.has(o.pending.id))
    check('3. pagado excluido', !batch.has(o.paid.id) && (ex.paid ?? 0) >= 1, ex)
    check('4. cancelado excluido', !batch.has(o.cancelled.id) && (ex.cancelled ?? 0) >= 1, ex)
    check('5. despachado (guía activa) excluido', !batch.has(o.tracking.id) && (ex.external_tracking ?? 0) >= 1, ex)
    check('6a. oferta familiar incompatible excluida', !batch.has(o.familiar.id))
    check('6b. envío prioritario (+RD$100) excluido', !batch.has(o.priority.id))
    check('6c. motivo offer_incompatible contado', (ex.offer_incompatible ?? 0) >= 2, ex)
    check('7. teléfono inválido excluido', !batch.has(o.badPhone.id) && (ex.invalid_phone ?? 0) >= 1, ex)
    check('8. dos pedidos mismo teléfono → ninguno', !batch.has(o.dupA.id) && !batch.has(o.dupB.id) && (ex.multiple_active_orders_same_phone ?? 0) === 2, ex)
    check('1b. lote = solo el pendiente compatible', p.preview.batch.length === 1, p.preview.batch)
  }
  {
    const confirmed = mkOrder({ confirmation_status: 'confirmed' })
    const db = seedDb([confirmed])
    const id = await mkDraft(db, [confirmed], 'confirmed_unpaid')
    const p = await computeLaunchPreview(db, ADMIN, id, 10, ENV)
    check('2. confirmado sin pagar elegible (segmento confirmed_unpaid)', p.ok && p.preview.batch.length === 1, p)
  }

  console.log('\n=== Supresión (9) y revalidación (10) ===')
  {
    const a = mkOrder(), b = mkOrder()
    const db = seedDb([a, b])
    db.tables.wa_contact_preferences = [{ id: randomUUID(), store_id: S1, phone_normalized: phoneOf(a), marketing_opt_out: true }]
    const id = await mkDraft(db, [a, b])
    const p = await computeLaunchPreview(db, ADMIN, id, 10, ENV)
    check('9a. baja promocional excluida al lanzar', p.ok && p.preview.batch.length === 1 && p.preview.launch_excluded_by_reason.marketing_opt_out === 1, p.ok && p.preview)
    await launchAll(db, id)
    // baja registrada DESPUÉS del lanzamiento → se respeta antes de enviar
    await recordMarketingOptOut(db, { storeId: S1, phoneNormalized: phoneOf(b), source: 'customer_keyword', reason: 'STOP' })
    const s = sender()
    await processBroadcastQueue(deps(db, s))
    check('9b. baja posterior al lanzamiento → no se envía', s.calls.length === 0 && rows(db, id)[0].skip_reason === 'marketing_opt_out', rows(db, id))
  }
  {
    const a = mkOrder(), b = mkOrder()
    const db = seedDb([a, b])
    const id = await mkDraft(db, [a, b])
    await launchAll(db, id)
    a.payment_status = 'paid'                       // cambia después de encolar
    b.tracking_number = 'EFI-999'
    const s = sender()
    await processBroadcastQueue(deps(db, s))
    const rs = rows(db, id)
    check('10. revalidación antes de enviar: pagado/despachado → skipped', s.calls.length === 0
      && rs.every(r => r.status === 'skipped' && String(r.skip_reason).startsWith('no_longer_eligible')), rs)
  }

  console.log('\n=== Idempotencia y concurrencia (11–14) ===')
  {
    const orders = [mkOrder(), mkOrder(), mkOrder()]
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    const key = randomUUID()
    const input = { broadcastId: id, launchRequestKey: key, sendLimit: 10, confirmCount: 3 }
    const [r1, r2] = await Promise.all([launchBroadcast(db, ADMIN, input, true, ENV), launchBroadcast(db, ADMIN, input, true, ENV)])
    check('11a. doble clic (misma clave) → ambos ok, una sola campaña', r1.ok && r2.ok, [r1, r2])
    check('11b. sin filas duplicadas', rows(db, id).length === 3, rows(db, id).length)
    const r3 = await launchBroadcast(db, ADMIN, { ...input, launchRequestKey: randomUUID() }, true, ENV)
    check('11c. otra clave sobre campaña ya lanzada → 409', !r3.ok && r3.status === 409, r3)
    const wrong = mkOrder(); db.tables.orders.push(wrong)
    const id2 = await mkDraft(db, [wrong])
    const p2 = await computeLaunchPreview(db, ADMIN, id2, 10, ENV)
    const r4 = await launchBroadcast(db, ADMIN, { broadcastId: id2, launchRequestKey: randomUUID(), sendLimit: 10, confirmCount: p2.ok ? p2.preview.batch.length : 0 }, true, ENV)
    check('11d. segunda campaña mientras otra está activa → 409', !r4.ok && r4.status === 409, r4)
    const r5 = await launchBroadcast(db, ADMIN, { broadcastId: id2, launchRequestKey: randomUUID(), sendLimit: 10, confirmCount: 99 }, true, ENV)
    check('11e. cantidad confirmada ≠ recalculada → 409', !r5.ok && r5.status === 409, r5)

    const s = sender()
    await processBroadcastQueue(deps(db, s))
    await processBroadcastQueue(deps(db, s))
    check('12. reintento del processor no reenvía', s.calls.length === 3, s.calls.length)
  }
  {
    const orders = Array.from({ length: 6 }, () => mkOrder())
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    await launchAll(db, id)
    const s = sender()
    await Promise.all([processBroadcastQueue(deps(db, s)), processBroadcastQueue(deps(db, s))])
    const tos = s.calls.map(c => c.to)
    check('13. dos workers concurrentes: cada destinatario una sola vez', tos.length === 6 && new Set(tos).size === 6, tos)
  }
  {
    const o = mkOrder()
    const db = seedDb([o])
    const id = await mkDraft(db, [o])
    await launchAll(db, id)
    const s = sender(['ambiguous'])
    await processBroadcastQueue(deps(db, s))
    await processBroadcastQueue(deps(db, s))
    check('14. respuesta ambigua → send_unknown y nunca se reintenta', rows(db, id)[0].status === 'send_unknown' && s.calls.length === 1, rows(db, id))
    // fila 'processing' abandonada → send_unknown
    const o2 = mkOrder(); db.tables.orders.push(o2)
    db.t('wa_broadcasts').find(b => b.id === id)!.status = 'processing'
    db.t('wa_template_queue').push({ id: randomUUID(), store_id: S1, order_id: o2.id, template_name: 'sd_broadcast_confirmation',
      phone_normalized: phoneOf(o2), status: 'processing', attempt_count: 1, broadcast_id: id,
      last_attempted_at: new Date(clock.getTime() - 30 * 60_000).toISOString(), scheduled_at: clock.toISOString() })
    const r = await processBroadcastQueue(deps(db, s))
    check('14b. worker caído a mitad de envío → send_unknown, sin reenvío', r.reaped === 1 && s.calls.length === 1, r)
  }

  console.log('\n=== Errores de Meta (15–17) ===')
  {
    const orders = [mkOrder(), mkOrder()]
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    await launchAll(db, id)
    const s = sender(['rate_limited'])
    const r = await processBroadcastQueue(deps(db, s))
    const rs = rows(db, id)
    const retried = rs.find(x => x.meta_error_code === '130429')
    check('15a. 429 → vuelve a pending con espera', !!retried && retried.status === 'pending' && Date.parse(retried.scheduled_at) > clock.getTime(), rs)
    check('15b. 429 corta el lote (no sigue enviando)', s.calls.length === 1 && r.stopped_reason === 'rate_limited', r)
  }
  {
    const o = mkOrder()
    const db = seedDb([o])
    const id = await mkDraft(db, [o])
    await launchAll(db, id)
    const s = sender(['rejected'])
    await processBroadcastQueue(deps(db, s))
    await processBroadcastQueue(deps(db, s))
    const row = rows(db, id)[0]
    check('16. 4xx permanente → failed con código Meta, sin reintento', row.status === 'failed' && row.meta_error_code === '131026' && s.calls.length === 1, row)
  }
  {
    const o = mkOrder()
    const db = seedDb([o])
    const id = await mkDraft(db, [o])
    await launchAll(db, id)
    const s = sender(Array(MAX_ATTEMPTS).fill('server_error'))
    const start = clock
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      await processBroadcastQueue(deps(db, s))
      clock = new Date(clock.getTime() + 60 * 60_000)
    }
    clock = start
    const row = rows(db, id)[0]
    check(`17. 5xx → reintenta hasta ${MAX_ATTEMPTS} y luego failed`, s.calls.length === MAX_ATTEMPTS && row.status === 'failed', { calls: s.calls.length, row })
  }

  console.log('\n=== Respuestas de botones (18–22) ===')
  let inboxDb: C1FakeDb, inboxBroadcast = '', inboxOrder: Row
  {
    const o = mkOrder({ customer_name: 'Ana Pérez' }), other = mkOrder()
    inboxOrder = o
    const db = seedDb([o, other]); inboxDb = db
    const id = await mkDraft(db, [o, other]); inboxBroadcast = id
    await launchAll(db, id)
    const s = sender()
    await processBroadcastQueue(deps(db, s))
    const row = rows(db, id).find(r => r.order_id === o.id)!
    const otherRow = rows(db, id).find(r => r.order_id === other.id)!
    const conv = db.t('wa_messages').find(m => m.wa_msg_id === row.wa_message_id)!.conversation_id
    const before = JSON.stringify(db.t('orders'))
    const inbound = (n: number) => ({ id: `in-${n}` })

    const conf = await recordBroadcastButtonResponse(db, { storeId: S1, conversationId: conv, inboundMessageId: inbound(1).id,
      phoneNormalized: row.phone_normalized, buttonText: 'Sí, confirmar', buttonPayload: `bc1:${row.id}:0`, contextWamid: row.wa_message_id })
    check('19a. "Sí, confirmar" → intención confirm_interest por payload', conf?.intent === 'confirm_interest' && conf.association === 'payload' && conf.orderId === o.id, conf)

    const dup = await recordBroadcastButtonResponse(db, { storeId: S1, conversationId: conv, inboundMessageId: inbound(1).id,
      phoneNormalized: row.phone_normalized, buttonText: 'Sí, confirmar', buttonPayload: `bc1:${row.id}:0`, contextWamid: null })
    check('18. webhook duplicado → una sola fila', dup?.duplicate === true && db.t('wa_broadcast_responses').length === 1)

    const dec = await recordBroadcastButtonResponse(db, { storeId: S1, conversationId: conv, inboundMessageId: inbound(2).id,
      phoneNormalized: row.phone_normalized, buttonText: 'Ya no lo deseo', buttonPayload: null, contextWamid: row.wa_message_id })
    check('20a. "Ya no lo deseo" → decline_order por context.id', dec?.intent === 'decline_order' && dec.association === 'context_wamid', dec)
    check('19b/20b. ningún pedido se confirma ni cancela', JSON.stringify(db.t('orders')) === before)
    check('20c. "Ya no lo deseo" NO es baja promocional', (db.tables.wa_contact_preferences ?? []).length === 0)

    const unk = await recordBroadcastButtonResponse(db, { storeId: S1, conversationId: conv, inboundMessageId: inbound(3).id,
      phoneNormalized: row.phone_normalized, buttonText: 'Sí, confirmar', buttonPayload: 'Sí, confirmar', contextWamid: null })
    check('21a. sin campaña identificable → unknown/none, sin pedido', unk?.intent === 'unknown' && unk.association === 'none' && unk.orderId === null, unk)
    const auto = await recordBroadcastButtonResponse(db, { storeId: S1, conversationId: conv, inboundMessageId: inbound(4).id,
      phoneNormalized: row.phone_normalized, buttonText: 'Confirmar', buttonPayload: 'Confirmar', contextWamid: null })
    check('21b. botón de automations ("Confirmar") no se registra como Broadcast', auto === null)

    const spoof = await recordBroadcastButtonResponse(db, { storeId: S1, conversationId: conv, inboundMessageId: inbound(5).id,
      phoneNormalized: row.phone_normalized, buttonText: 'Sí, confirmar', buttonPayload: `bc1:${otherRow.id}:0`, contextWamid: null })
    check('22a. payload de OTRO destinatario no se asocia', spoof?.association === 'none' && spoof.orderId === null, spoof)
    check('22b. asociación correcta campaña/destinatario', conf?.broadcastId === id && conf.queueId === row.id)
    check('22c. payload parseable', parseButtonPayload(`bc1:${row.id}:1`)?.index === 1 && parseButtonPayload('bc1:x:0') === null)
  }

  console.log('\n=== Aislamiento de flags (23–25) ===')
  {
    const saved = process.env.GENESIS_ENABLED
    delete process.env.GENESIS_ENABLED
    check('23a. Génesis OFF con flag ausente', isGenesisEnabled() === false)
    if (saved !== undefined) process.env.GENESIS_ENABLED = saved
    const strip = (p: string) => readFileSync(p, 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const c1 = ['src/lib/broadcast/launch.ts', 'src/lib/broadcast/processor.ts', 'src/lib/broadcast/responses.ts',
                'src/lib/broadcast/suppression.ts', 'src/app/api/cron/wa-broadcast-queue/route.ts'].map(strip).join('\n')
    check('23b. código C.1 no toca Génesis ni ai_agent_config', !/genesis|ai_agent_config|GENESIS_ENABLED/i.test(c1))
    check('24a. código C.1 no usa WA_AUTOMATIONS_ENABLED ni templates de automations', !/WA_AUTOMATIONS_ENABLED|isWaAutomationsEnabled|order_confirmation_cod|sd_location_request/.test(c1))
    check('24b. processor de automations ignora filas de Broadcast', !isAutomationQueueCandidate({ broadcast_id: 'b-1', template_name: 'sd_broadcast_confirmation', status: 'pending' }))
    const cronSrc = strip('src/app/api/cron/wa-broadcast-queue/route.ts')
    check('24c. cron de Broadcast: endpoint propio, flag verificado ANTES de crear el cliente de DB',
      cronSrc.indexOf('isWaBroadcastEnabled()') > -1 && cronSrc.indexOf('isWaBroadcastEnabled()') < cronSrc.indexOf('createServiceClient()')
      && !/wa-template-queue|automation-queue/.test(cronSrc))
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: Array<{ path: string; schedule: string }> }
    check('24d. vercel.json: tracking intacto + cron Broadcast preparado */5',
      vercel.crons.some(c => c.path === '/api/tracking/auto' && c.schedule === '*/5 * * * *')
      && vercel.crons.some(c => c.path === '/api/cron/wa-broadcast-queue' && c.schedule === '*/5 * * * *')
      && !vercel.crons.some(c => c.path.includes('wa-template-queue')))

    const o = mkOrder()
    const db = seedDb([o])
    const id = await mkDraft(db, [o])
    const p = await computeLaunchPreview(db, ADMIN, id, 10, ENV)
    const off = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: randomUUID(), sendLimit: 10, confirmCount: p.ok ? p.preview.batch.length : 0 }, false, ENV)
    check('25a. Broadcast OFF → lanzar 403', !off.ok && off.status === 403 && rows(db, id).length === 0, off)
    check('25b. Broadcast OFF → preview sigue disponible (solo lectura)', p.ok)
    await launchAll(db, id)
    flag = false
    const before = db.log.length
    const s = sender()
    const r = await processBroadcastQueue(deps(db, s))
    check('25c. Broadcast OFF → processor no lee ni escribe la cola', r.disabled === true && s.calls.length === 0
      && db.log.slice(before).every(l => l.table !== 'wa_template_queue'), r)
    const res = await resumeBroadcast(db, ADMIN, id, false)
    check('25d. Broadcast OFF → reanudar 403', !res.ok && res.status === 403)
    flag = true
    // flag se apaga justo antes del envío: se libera la fila sin enviar
    let toggles = 0
    const r2 = await processBroadcastQueue({ ...deps(db, s), isEnabled: () => (toggles++ < 2) })
    check('25e. flag apagado a mitad del lote → no envía y la fila vuelve a pending',
      s.calls.length === 0 && rows(db, id)[0].status === 'pending' && rows(db, id)[0].attempt_count === 0, { r2, row: rows(db, id)[0] })
    const noTpl = await processBroadcastQueue(deps(db, s, {}))
    check('25f. template sin configurar → no envía, deja last_error', s.calls.length === 0 && noTpl.stopped_reason === 'template_not_configured'
      && String(db.t('wa_broadcasts').find(b => b.id === id)!.last_error).includes('WA_BROADCAST_CONFIRMATION_IMAGE_URL'), noTpl)
  }

  console.log('\n=== Tiendas, permisos, pausa (26–28) ===')
  {
    const o = mkOrder()
    const db = seedDb([o])
    const id = await mkDraft(db, [o])
    const p = await computeLaunchPreview(db, { userId: 'admin-2', storeId: S2 }, id, 10, ENV)
    check('26a. campaña de otra tienda → 404', !p.ok && p.status === 404, p)
    await launchAll(db, id)
    const s = sender(); await processBroadcastQueue(deps(db, s))
    const row = rows(db, id)[0]
    const r = await recordBroadcastButtonResponse(db, { storeId: S2, conversationId: 'conv-x', inboundMessageId: 'in-s2',
      phoneNormalized: row.phone_normalized, buttonText: 'Sí, confirmar', buttonPayload: `bc1:${row.id}:0`, contextWamid: row.wa_message_id })
    check('26b. respuesta desde otra tienda no se asocia a la campaña', r?.association === 'none' && r.broadcastId === null, r)
    const pz = await pauseBroadcast(db, { userId: 'x', storeId: S2 }, id)
    check('26c. pausar campaña de otra tienda → rechazado', !pz.ok)
  }
  {
    const fakeSession = (role: string, is_active = true) => ({
      auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role, store_id: S1, is_active } }) }) }) }),
    })
    const agent = await getBroadcastAdminContext(fakeSession('confirmation_agent'))
    const inactive = await getBroadcastAdminContext(fakeSession('admin', false))
    check('27. agente sin permiso / admin inactivo → 403', !agent.ok && agent.status === 403 && !inactive.ok && inactive.status === 403)
  }
  {
    const orders = [mkOrder(), mkOrder()]
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    await launchAll(db, id)
    const pz = await pauseBroadcast(db, ADMIN, id)
    const s = sender()
    await processBroadcastQueue(deps(db, s))
    check('28a. campaña pausada → processor no envía', pz.ok && s.calls.length === 0 && rows(db, id).every(r => r.status === 'pending'))
    const rs = await resumeBroadcast(db, ADMIN, id, true)
    await processBroadcastQueue(deps(db, s))
    check('28b. reanudar → envía los pendientes', rs.ok && s.calls.length === 2, s.calls.length)
    check('28c. pausar una campaña completada → 409', !(await pauseBroadcast(db, ADMIN, id)).ok)
  }

  console.log('\n=== Estados (29) e Inbox (30) ===')
  {
    const db = inboxDb!
    const sentRows = rows(db, inboxBroadcast).filter(r => r.wa_message_id)
    const msg = db.t('wa_messages').find(m => m.wa_msg_id === sentRows[0].wa_message_id)!
    let m = await getBroadcastMetrics(db, S1, inboxBroadcast)
    check('29a. aceptado por Meta ≠ entregado', m.accepted === 2 && m.delivered === 0, m)
    msg.status = 'delivered'; msg.delivered_at = clock.toISOString()
    m = await getBroadcastMetrics(db, S1, inboxBroadcast)
    check('29b. entrega solo con evidencia de webhook', m.delivered === 1 && m.read === 0, m)
    msg.status = 'read'; msg.read_at = clock.toISOString()
    m = await getBroadcastMetrics(db, S1, inboxBroadcast)
    check('29c. leído cuenta como entregado y leído', m.delivered === 1 && m.read === 1, m)
    check('29d. intención ≠ confirmación atribuible', (m.responses_by_intent.confirm_interest ?? 0) === 1 && m.confirmations_attributable === 0, m)
    inboxOrder!.confirmation_status = 'confirmed'
    inboxOrder!.customer_confirmed_at = new Date(Date.parse(sentRows[0].processed_at) + 60_000).toISOString()
    m = await getBroadcastMetrics(db, S1, inboxBroadcast)
    check('29e. confirmación posterior al envío = atribuible', m.confirmations_attributable === 1, m)

    check('30a. template saliente registrado en el Inbox con campaña', msg.direction === 'outbound' && msg.message_type === 'template'
      && msg.metadata.broadcast_id === inboxBroadcast && msg.metadata.buttons?.[0] === 'Sí, confirmar')
    db.t('wa_messages').push({ id: 'in-1', store_id: S1, conversation_id: msg.conversation_id, wa_msg_id: 'wamid.in1', direction: 'inbound',
      message_type: 'button_reply', body: 'Sí, confirmar', status: 'received', sent_at: clock.toISOString() })
    const ctx = await buildBroadcastInboxContext(db, S1, msg.conversation_id, clock)
    check('30b. contexto del agente: pedido actual, campaña y botón', ctx?.order?.id === inboxOrder!.id && ctx?.order?.confirmation_status === 'confirmed'
      && ctx?.campaign?.id === inboxBroadcast && (ctx?.responses.length ?? 0) >= 2 && (ctx?.unhandled ?? 0) >= 2, ctx)
    check('30c. ventana 24 h abierta tras la respuesta del cliente', ctx?.window.open === true)
    const handled = await markBroadcastResponsesHandled(db, S1, msg.conversation_id, 'agent-1')
    const ctx2 = await buildBroadcastInboxContext(db, S1, msg.conversation_id, clock)
    check('30d. el agente marca la respuesta como atendida', handled >= 2 && ctx2?.unhandled === 0)
    check('30e. contexto de otra tienda → null', (await buildBroadcastInboxContext(db, S2, msg.conversation_id, clock)) === null)
  }

  console.log('\n=== Contrato real en el envío (C.1.2) ===')
  {
    const o = mkOrder({ customer_name: 'Ana Pérez' })
    const db = seedDb([o])
    const id = await mkDraft(db, [o])
    await launchAll(db, id)
    const s = sender()
    await processBroadcastQueue(deps(db, s))
    const call = s.calls[0]
    const body = (call?.components as Array<{ type: string; parameters: Array<{ text?: string }> }> | undefined)?.find(c => c.type === 'body')
    check('E1. envía con el nombre e idioma reales de Meta', call?.name === 'sd_broadcast_confirmation' && call.language === 'en', call)
    check('E2. body con los 5 parámetros aprobados', body?.parameters.map(p => p.text).join('|') === 'Ana Pérez|2x1|Incluye tu cepillo antibacterial GRATIS|2,100|Envío gratis', body)
    const msg = db.t('wa_messages').find(m => m.direction === 'outbound')!
    check('E3. Inbox guarda el texto aprobado con sus parámetros + nombres interno/Meta',
      String(msg.body).includes('Tu tratamiento *2x1 LÜMA Teeth*') && msg.metadata.meta_template_name === 'sd_broadcast_confirmation'
      && msg.metadata.template_name === 'sd_broadcast_confirmation' && msg.metadata.body_params.length === 5)
    const conv = db.t('wa_conversations').find(c => c.id === msg.conversation_id)!
    check('G1. conversación de Broadcast queda con ai_enabled=false', conv.ai_enabled === false, conv)
    check('G2. liberar conversación de Broadcast NO reactiva la IA', (await aiEnabledAfterRelease(db, conv.id)) === false)
    db.t('wa_conversations').push({ id: 'conv-normal', store_id: S1, contact_id: 'c-n', status: 'open', ai_enabled: false })
    db.t('wa_messages').push({ id: 'm-n', store_id: S1, conversation_id: 'conv-normal', wa_msg_id: 'wamid.n', direction: 'outbound',
      message_type: 'template', body: 'x', status: 'sent', sent_at: clock.toISOString(), metadata: { template_name: 'order_confirmation_cod' } })
    check('G3. conversación normal: liberar mantiene el comportamiento previo (ai_enabled=true)', (await aiEnabledAfterRelease(db, 'conv-normal')) === true)
    let failSafe = false
    try { failSafe = (await aiEnabledAfterRelease({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ not: () => ({ limit: async () => ({ data: null, error: { message: 'x' } }) }) }) }) }) }) }) }, 'c')) === false } catch { failSafe = false }
    check('G4. error de lectura → no reactiva la IA (fail-safe)', failSafe)
    const strip = (p: string) => readFileSync(p, 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const rel = strip('src/app/api/whatsapp/conversations/[id]/release/route.ts')
    check('G5. release usa el guard (sin ai_enabled: true fijo)', rel.includes('aiEnabledAfterRelease(') && !/ai_enabled:\s*true/.test(rel))
    const respond = strip('src/lib/genesis/respond.ts')
    check('G6. Génesis: kill switch global sigue antes de cualquier lectura', respond.indexOf('isGenesisEnabled()') > -1
      && respond.indexOf('isGenesisEnabled()') < respond.indexOf(".from('wa_conversations')"))
  }

  console.log('\n=== Ubicación por WhatsApp (C.1.2) ===')
  {
    const base = { storeId: S1, conversationId: 'conv-1', waMsgId: 'wamid.loc', latitude: 18.47, longitude: -69.9, sentAt: '2026-10-09T15:00:00.000Z' }
    const mkLoc = (orders: Row[]) => {
      const db = seedDb(orders)
      const confirmCalls: unknown[] = []
      const confirm = (async (args: unknown) => { confirmCalls.push(args); return { ok: true, auto_dispatched: true, confirmation_status: 'confirmed' } }) as never
      return { db, confirmCalls, confirm }
    }
    {
      const o = mkOrder()
      const { db, confirmCalls, confirm } = mkLoc([o])
      const r = await handleInboundLocation(db, { ...base, phoneNormalized: phoneOf(o) }, { automationsEnabled: () => false, confirm })
      check('L1. 1 pedido + automations OFF → guarda ubicación, NO confirma', r.outcome === 'saved_automations_off'
        && confirmCalls.length === 0 && o.sd_location_status === 'received' && o.sd_location_lat === 18.47 && o.confirmation_status === 'pending', r)
    }
    {
      const o = mkOrder()
      const { db, confirmCalls, confirm } = mkLoc([o])
      const r = await handleInboundLocation(db, { ...base, phoneNormalized: phoneOf(o) }, { automationsEnabled: () => true, confirm })
      check('L2. 1 pedido + automations ON → guarda y confirma (comportamiento previo)', r.outcome === 'saved_confirmed'
        && confirmCalls.length === 1 && (confirmCalls[0] as { guardAutomated: boolean; method: string }).guardAutomated === true
        && (confirmCalls[0] as { method: string }).method === 'whatsapp_location', r)
    }
    {
      const a = mkOrder({ customer_phone: '809-555-4444' }), b = mkOrder({ customer_phone: '809-555-4444' })
      const { db, confirmCalls, confirm } = mkLoc([a, b])
      const r = await handleInboundLocation(db, { ...base, phoneNormalized: '18095554444' }, { automationsEnabled: () => true, confirm })
      check('L3. varios pedidos activos → no asigna a ninguno ni confirma', r.outcome === 'ambiguous_not_assigned'
        && confirmCalls.length === 0 && [a, b].every(o => o.sd_location_lat == null && o.sd_location_status == null), r)
    }
    {
      const cancelled = mkOrder({ confirmation_status: 'cancelled' })
      const paid = mkOrder({ payment_status: 'paid' })
      const tracked = mkOrder({ tracking_number: 'EFI-1' })
      for (const [label, o] of [['cancelado', cancelled], ['pagado', paid], ['con guía', tracked]] as const) {
        const { db, confirmCalls, confirm } = mkLoc([o])
        const r = await handleInboundLocation(db, { ...base, phoneNormalized: phoneOf(o) }, { automationsEnabled: () => true, confirm })
        check(`L4. pedido ${label} → no es candidato, no se toca`, r.outcome === 'no_candidates' && confirmCalls.length === 0 && o.sd_location_lat == null, r)
      }
    }
    {
      const o = mkOrder()
      const { db, confirm } = mkLoc([o])
      const r = await handleInboundLocation(db, { ...base, storeId: S2, phoneNormalized: phoneOf(o) }, { automationsEnabled: () => true, confirm })
      check('L5. otra tienda → sin candidatos', r.outcome === 'no_candidates' && o.sd_location_lat == null)
    }
    {
      const o = mkOrder()
      const { db } = mkLoc([o])
      const skipped = (async () => ({ ok: false, reason: 'not_pending' })) as never
      const r = await handleInboundLocation(db, { ...base, phoneNormalized: phoneOf(o) }, { automationsEnabled: () => true, confirm: skipped })
      check('L6. guard de applyConfirmationAction respetado (not_pending)', r.outcome === 'saved_confirm_skipped' && r.reason === 'not_pending', r)
    }
    const strip = (p: string) => readFileSync(p, 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const wh = strip('src/app/api/webhooks/whatsapp/route.ts')
    check('L7. webhook delega la ubicación con el flag de automations', wh.includes('handleInboundLocation(') && wh.includes('automationsEnabled: isWaAutomationsEnabled'))
    check('L8. webhook ya no confirma por ubicación directamente', !/method:\s*'whatsapp_location'/.test(wh))
    check('L9. botones de automations ("Confirmar"/"No, gracias") sin cambios', wh.includes("buttonTitle === 'Confirmar'") && wh.includes("buttonTitle === 'No, gracias'"))
  }

  console.log('\n=== C.1.3 — ubicación ambigua asociada por un agente ===')
  {
    const a = mkOrder({ customer_phone: '809-555-6000', order_number: '#A' })
    const b = mkOrder({ customer_phone: '809-555-6000', order_number: '#B' })
    const other = mkOrder({ customer_phone: '809-555-6001' })
    const db = seedDb([a, b, other])
    const phone = '18095556000'
    db.t('wa_contacts').push({ id: 'ct-1', store_id: S1, phone_normalized: phone })
    db.t('wa_conversations').push({ id: 'cv-1', store_id: S1, contact_id: 'ct-1', status: 'open', ai_enabled: true })
    db.t('wa_messages').push({ id: '11111111-1111-1111-1111-111111111111', store_id: S1, conversation_id: 'cv-1', wa_msg_id: 'wamid.pin',
      direction: 'inbound', message_type: 'location', body: null, status: 'received', sent_at: '2026-10-09T15:00:00.000Z',
      metadata: { latitude: 18.47, longitude: -69.9, name: 'Casa', address: null } })
    db.t('wa_messages').push({ id: '22222222-2222-2222-2222-222222222222', store_id: S1, conversation_id: 'cv-1', wa_msg_id: 'wamid.txt',
      direction: 'inbound', message_type: 'text', body: 'hola', status: 'received', sent_at: '2026-10-09T15:01:00.000Z', metadata: null })

    const r = await handleInboundLocation(db, { inboundMessageId: '11111111-1111-1111-1111-111111111111', storeId: S1, phoneNormalized: phone,
      conversationId: 'cv-1', waMsgId: 'wamid.pin', latitude: 18.47, longitude: -69.9, sentAt: '2026-10-09T15:00:00.000Z' },
      { automationsEnabled: () => true, confirm: (async () => { throw new Error('no debe confirmar') }) as never })
    const pin = () => db.t('wa_messages').find(m => m.id === '11111111-1111-1111-1111-111111111111')!
    check('A1. pin ambiguo: sin asignar, marcado en el mensaje, coordenadas conservadas', r.outcome === 'ambiguous_not_assigned'
      && pin().metadata.location_assignment_status === 'ambiguous' && pin().metadata.latitude === 18.47 && a.sd_location_lat == null && b.sd_location_lat == null, pin().metadata)

    const list = await listPendingLocationAssignments(db, S1, 'cv-1')
    check('A2. Inbox lista el pin pendiente y los 2 pedidos activos del contacto', list?.pending.length === 1
      && list.candidates.map(c => c.id).sort().join() === [a.id, b.id].sort().join(), list)
    check('A3. otra tienda no ve el pin', (await listPendingLocationAssignments(db, S2, 'cv-1')) === null)

    const wrongStore = await assignLocationToOrder(db, { storeId: S2, conversationId: 'cv-1', messageId: '11111111-1111-1111-1111-111111111111', orderId: a.id, userId: 'agent-1' })
    check('A4. otra tienda → 404', !wrongStore.ok && wrongStore.status === 404)
    const notLoc = await assignLocationToOrder(db, { storeId: S1, conversationId: 'cv-1', messageId: '22222222-2222-2222-2222-222222222222', orderId: a.id, userId: 'agent-1' })
    check('A5. mensaje que no es ubicación → 404', !notLoc.ok && notLoc.status === 404)
    const otherContact = await assignLocationToOrder(db, { storeId: S1, conversationId: 'cv-1', messageId: '11111111-1111-1111-1111-111111111111', orderId: other.id, userId: 'agent-1' })
    check('A6. pedido de OTRO contacto → 409, sin escribir', !otherContact.ok && otherContact.status === 409 && other.sd_location_lat == null)
    b.confirmation_status = 'cancelled'
    const cancelled = await assignLocationToOrder(db, { storeId: S1, conversationId: 'cv-1', messageId: '11111111-1111-1111-1111-111111111111', orderId: b.id, userId: 'agent-1' })
    check('A7. pedido ya no activo (cancelado) → 409', !cancelled.ok && cancelled.status === 409 && b.sd_location_lat == null)
    b.confirmation_status = 'pending'

    const before = { cs: a.confirmation_status, ns: a.normalized_status }
    const [r1, r2] = await Promise.all([
      assignLocationToOrder(db, { storeId: S1, conversationId: 'cv-1', messageId: '11111111-1111-1111-1111-111111111111', orderId: a.id, userId: 'agent-1' }),
      assignLocationToOrder(db, { storeId: S1, conversationId: 'cv-1', messageId: '11111111-1111-1111-1111-111111111111', orderId: b.id, userId: 'agent-2' }),
    ])
    const wins = [r1, r2].filter(x => x.ok)
    check('A8. dos agentes a la vez → solo una asociación gana', wins.length === 1 && [r1, r2].some(x => !x.ok && x.status === 409), [r1, r2])
    const winner = r1.ok ? a : b, loser = r1.ok ? b : a, winnerAgent = r1.ok ? 'agent-1' : 'agent-2'
    check('A9. ubicación escrita en el pedido elegido (mismo formato que el flujo automático)', winner.sd_location_lat === 18.47
      && winner.sd_location_status === 'received' && winner.sd_location_wa_msg_id === 'wamid.pin' && winner.sd_location_conversation_id === 'cv-1'
      && loser.sd_location_lat == null)
    check('A10. NO confirma ni despacha', a.confirmation_status === before.cs && a.normalized_status === before.ns
      && b.confirmation_status === 'pending' && b.normalized_status === 'pending')
    const audit = db.t('agent_actions')
    check('A11. auditoría: quién asoció (agent_actions + metadata del mensaje)', audit.length === 1 && audit[0].agent_id === winnerAgent
      && audit[0].action_type === 'note_added' && audit[0].order_id === winner.id
      && pin().metadata.location_assignment_status === 'assigned' && pin().metadata.location_assigned_by === winnerAgent)
    const again = await assignLocationToOrder(db, { storeId: S1, conversationId: 'cv-1', messageId: '11111111-1111-1111-1111-111111111111', orderId: loser.id, userId: 'agent-3' })
    check('A12. pin ya asociado → 409 y deja de aparecer como pendiente', !again.ok && again.status === 409
      && (await listPendingLocationAssignments(db, S1, 'cv-1'))?.pending.length === 0)

    const strip = (f: string) => readFileSync(f, 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const route = strip('src/app/api/whatsapp/conversations/[id]/location-assignment/route.ts')
    check('A13. endpoint: auth de Inbox + store del perfil, sin confirmación', route.includes('getInboxAgentContext()')
      && route.includes('storeId: auth.storeId') && !/applyConfirmationAction|confirmation_status/.test(route))
    check('A14. webhook marca el pin con su wa_messages.id', strip('src/app/api/webhooks/whatsapp/route.ts').includes('inboundMessageId: newMsg.id'))
  }

  console.log('\n=== C.1.3 — assign protegido para Broadcast ===')
  {
    const db = new C1FakeDb()
    db.t('wa_messages').push({ id: 'mb', store_id: S1, conversation_id: 'conv-bc', wa_msg_id: 'w1', direction: 'outbound', message_type: 'template',
      metadata: { broadcast_id: 'b-1', template_name: 'sd_broadcast_confirmation' } })
    db.t('wa_messages').push({ id: 'mn', store_id: S1, conversation_id: 'conv-n', wa_msg_id: 'w2', direction: 'outbound', message_type: 'template',
      metadata: { template_name: 'order_confirmation_cod' } })
    check('G7. assign con ai_enabled=true en conversación de Broadcast → false', (await aiEnabledForAssignment(db, 'conv-bc', true)) === false)
    check('G8. assign en conversación normal → exactamente lo pedido', (await aiEnabledForAssignment(db, 'conv-n', true)) === true
      && (await aiEnabledForAssignment(db, 'conv-n', false)) === false)
    const strip = (f: string) => readFileSync(f, 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const assign = strip('src/app/api/whatsapp/conversations/[id]/assign/route.ts')
    const take = strip('src/app/api/whatsapp/conversations/[id]/take/route.ts')
    check('G9. assign usa el guard (sin ai_enabled del body directo)', assign.includes('aiEnabledForAssignment(supabase, id, body.ai_enabled)')
      && !/ai_enabled:\s*body\.ai_enabled/.test(assign))
    check('G10. take sigue fijando ai_enabled=false', /ai_enabled:\s*false/.test(take))
  }

  console.log('\n=== Templates, baja y ventana 24 h ===')
  {
    const missing = resolveTemplateConfig('sd_broadcast_confirmation', {})
    check('M1. sin URL de header → no configurado (fail-closed)', !missing.ok && missing.missing[0] === 'WA_BROADCAST_CONFIRMATION_IMAGE_URL')
    const http = resolveTemplateConfig('sd_broadcast_confirmation', { WA_BROADCAST_CONFIRMATION_IMAGE_URL: 'http://x/y.jpg' })
    check('M2. header no-https → inválido', !http.ok && http.invalid.length === 1)
    const ok = resolveTemplateConfig('sd_broadcast_confirmation', ENV)
    check('M3. contrato verificado: nombre, idioma en, 5 variables', ok.ok && ok.config.metaName === 'sd_broadcast_confirmation'
      && ok.config.language === 'en' && ok.config.bodyParamCount === 5)
    const rep = resolveTemplateConfig('sd_broadcast_repurchase', { WA_BROADCAST_REPURCHASE_IMAGE_URL: 'https://cdn.example.com/r.jpg' })
    check('M4. recompra → template real sd_broadcast_coordination, es_DO, 1 variable', rep.ok && rep.config.metaName === 'sd_broadcast_coordination'
      && rep.config.language === 'es_DO' && rep.config.bodyParamCount === 1)
    const bp = buildConfirmationBodyParams({ customer_name: 'Ana Pérez', product_summary: PERSONAL, cod_amount: 2100 })
    check('M5. 5 parámetros = ejemplo aprobado en Meta', bp.ok
      && JSON.stringify(bp.params) === JSON.stringify(['Ana Pérez', '2x1', 'Incluye tu cepillo antibacterial GRATIS', '2,100', 'Envío gratis']), bp)
    check('M6. oferta distinta → no hay parámetros (no se envía)',
      !buildConfirmationBodyParams({ customer_name: 'x', product_summary: PERSONAL, cod_amount: 2200 }).ok
      && !buildConfirmationBodyParams({ customer_name: 'x', product_summary: `${PERSONAL}, Envio prioritario`, cod_amount: 2100 }).ok
      && !buildConfirmationBodyParams({ customer_name: 'x', product_summary: 'LÜMA Teeth™ — Pasta Dental Restauradora - x4, + 2 Cepillos GRATIS - x2', cod_amount: 3400 }).ok)
    check('M7. nombre saneado para Meta (sin saltos, tabs, *, espacios múltiples)',
      sanitizeTemplateParam('  *Ana*\n\tMaría     López_ ') === 'Ana María López' && buildRepurchaseBodyParams({ customer_name: null }).ok)
    const comps = ok.ok && bp.ok ? buildTemplateComponents(ok.config, bp.params, '00000000-0000-0000-0000-000000000001') as Array<Record<string, unknown>> : []
    check('M8. componentes: header imagen + body 5 + 2 quick replies con payload propio', comps.length === 4
      && JSON.stringify(comps).includes('bc1:00000000-0000-0000-0000-000000000001:1') && JSON.stringify(comps).includes('"2x1"'))
    let threw = false
    try { if (ok.ok) buildTemplateComponents(ok.config, ['solo uno'], 'q') } catch { threw = true }
    check('M9. cantidad de parámetros distinta del contrato → error antes de llamar a Meta', threw)
    check('M10. botones exactos del template', ok.ok && ok.config.buttons.join('|') === 'Sí, confirmar|Ya no lo deseo')
    check('M11. sin precios literales en templates.ts (catálogo)', !/2[,.]?100|1[,.]?890|RD\$ ?\d/.test(readFileSync('src/lib/broadcast/templates.ts', 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')))

    const yes = ['STOP', 'Baja', 'no me escriban más', 'Por favor dejen de escribirme', 'denme de baja', 'No quiero recibir más mensajes']
    const no = ['Ya no lo deseo', 'no', 'no tengo dinero ahora', 'Ahora no', 'cancelar el pedido', 'baja el precio?']
    check('T5. baja: frases inequívocas detectadas', yes.every(isMarketingOptOutRequest), yes.filter(t => !isMarketingOptOutRequest(t)))
    check('T6. baja: rechazo de pedido/oferta NO es baja', no.every(t => !isMarketingOptOutRequest(t)), no.filter(isMarketingOptOutRequest))

    const now = new Date('2026-10-09T12:00:00Z')
    check('T7. ventana 24 h', isWithinServiceWindow('2026-10-09T00:00:00Z', now) && !isWithinServiceWindow('2026-10-08T11:00:00Z', now)
      && !isWithinServiceWindow(null, now))
  }
}

main()
  .catch(err => { failures++; console.error('❌ error inesperado:', err) })
  .finally(() => {
    console.log(`\n${failures === 0 ? '✅ TODO OK' : `❌ ${failures} fallo(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
  })
