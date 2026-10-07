// Sprint Broadcast B — tests de selección, preview y creación de DRAFT.
//
// Determinístico: corre contra una DB en memoria que emula el subconjunto de
// PostgREST que usa el servicio (eq / in / is / gte / lt / order / range /
// limit / maybeSingle / insert().select().single(), incl. eq sobre rutas
// JSON 'col->>key') y registra cada consulta y cada escritura.
// NO toca la DB real, NO llama a Meta, NO envía nada.
//
// Corre con: npx tsx scripts/test-broadcast-draft.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import {
  audienceFromDraft,
  computeBroadcastAudience,
  createBroadcastDraft,
  existedAt,
  revalidateDraftAudience,
  type BroadcastAdminContext,
} from '../src/lib/broadcast/broadcast-service'
import { getBroadcastAdminContext } from '../src/lib/broadcast/admin-context'
import { parseBroadcastSelection, type BroadcastSelection } from '../src/lib/broadcast/selection'
import { BROADCAST_REASON_LABELS } from '../src/lib/broadcast/labels'
import { renderBroadcastPreview } from '../src/lib/broadcast/message-preview'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

import { FakeDb, type Row } from './lib/broadcast-fake-db'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const S1 = 'store-1', S2 = 'store-2'
const today = '2026-10-06T12:00:00.000Z'
let n = 0
function mkOrder(o: Partial<Row> = {}): Row {
  n++
  return {
    id: randomUUID(), store_id: S1, order_number: `#${9000 + n}`, source: 'shopify_webhook', shopify_order_id: `shp-${n}`,
    is_test: false, archived_at: null, customer_name: `Cliente ${n}`, customer_phone: `809-555-${String(1000 + n)}`,
    city: 'Santo Domingo Este', province: 'Santo Domingo', customer_address: 'Calle 1', product_summary: 'LÜMA Teeth', cod_amount: 1990,
    confirmation_status: 'pending', confirmation_attempts: 0, normalized_status: 'pending', payment_status: 'pending',
    tracking_number: null, sd_location_received_at: null, shopify_created_at: today, paid_at: null,
    created_at: '2026-10-01T00:00:00.000+00:00', ...o,
  }
}

function seed() {
  const db = new FakeDb()
  const o = {
    eligible:   mkOrder({ customer_name: 'Ana Pérez' }),
    confirmed:  mkOrder({ confirmation_status: 'confirmed' }),
    cancelled:  mkOrder({ confirmation_status: 'cancelled' }),
    delivered:  mkOrder({ normalized_status: 'delivered' }),
    returned:   mkOrder({ normalized_status: 'returned' }),
    paid:       mkOrder({ payment_status: 'paid', paid_at: today }),
    tracking:   mkOrder({ tracking_number: 'EFI123' }),
    badPhone:   mkOrder({ customer_phone: '555' }),
    dupA:       mkOrder({ customer_phone: '809-777-0001' }),
    dupB:       mkOrder({ customer_phone: '+1 (809) 777-0001' }),
    alreadyBc:  mkOrder(),
    santiago:   mkOrder({ city: 'Santiago', province: 'Santiago' }),
    poolSel:    mkOrder({ customer_phone: '829-444-0001' }),
    poolOther:  mkOrder({ customer_phone: '829-444-0001' }),
    otherStore: mkOrder({ store_id: S2 }),
    retry:      mkOrder({ confirmation_attempts: 2 }),
    location:   mkOrder({ sd_location_received_at: today }),
    old:        mkOrder({ shopify_created_at: '2026-01-15T12:00:00.000Z' }),
  }
  db.tables.orders.push(...Object.values(o))
  // Fila histórica de AUTOMATION pending para el pedido elegible: no debe bloquearlo.
  db.tables.wa_template_queue.push({ id: randomUUID(), store_id: S1, order_id: o.eligible.id, template_name: 'order_confirmation_cod', status: 'pending', broadcast_id: null })
  // Broadcast previo enviado para alreadyBc.
  db.tables.wa_template_queue.push({ id: randomUUID(), store_id: S1, order_id: o.alreadyBc.id, template_name: 'sd_broadcast_confirmation', status: 'sent', broadcast_id: 'bc-old' })
  return { db, o }
}

const ctx: BroadcastAdminContext = { userId: 'admin-1', storeId: S1 }
const NOW = new Date().toISOString()
const PENDING = { type: 'coordination', segment: 'pending' } as const
const reasonOf = (p: Awaited<ReturnType<typeof computeBroadcastAudience>>, id: string) =>
  p.excluded.find(x => x.order_id === id)?.excluded_reason ?? (p.eligible.some(e => e.order_id === id) ? 'ELIGIBLE' : 'MISSING')

async function main() {
  // ── A / D / F / G: preview selected_ids ───────────────────────────────────
  console.log('=== A. Preview selected_ids ===\n')
  {
    const { db, o } = seed()
    const ghost = randomUUID()
    const sel: BroadcastSelection = { campaign: PENDING, mode: 'selected_ids', order_ids: [
      o.eligible.id, o.confirmed.id, o.cancelled.id, o.delivered.id, o.returned.id, o.paid.id, o.tracking.id,
      o.badPhone.id, o.dupA.id, o.dupB.id, o.alreadyBc.id, o.santiago.id, o.poolSel.id, o.otherStore.id,
      o.location.id, o.old.id, ghost,
    ] }
    const p = await computeBroadcastAudience(db, ctx, sel, NOW)

    check('A. elegible SD pending → eligible', reasonOf(p, o.eligible.id) === 'ELIGIBLE')
    check('A. fila histórica order_confirmation_cod pending NO bloquea el broadcast', reasonOf(p, o.eligible.id) === 'ELIGIBLE')
    check('A. pedido viejo (enero) sigue elegible', reasonOf(p, o.old.id) === 'ELIGIBLE')
    const loc = p.eligible.find(e => e.order_id === o.location.id)
    check('A. ubicación recibida + pending → elegible con warning', !!loc && loc.warnings.includes('location_received_but_pending'))
    check('A. preview individual renderiza valores reales',
      p.eligible.find(e => e.order_id === o.eligible.id)?.message_preview === renderBroadcastPreview({ customer_name: 'Ana Pérez', product_summary: 'LÜMA Teeth', cod_amount: 1990 })
      && /Hola, Ana Pérez 😊/.test(renderBroadcastPreview({ customer_name: 'Ana Pérez', product_summary: 'LÜMA Teeth', cod_amount: 1990 }))
      && /RD\$1,990/.test(renderBroadcastPreview({ customer_name: 'Ana Pérez', product_summary: 'LÜMA Teeth', cod_amount: 1990 })))

    console.log('\n=== G. Exclusiones + reasons ===\n')
    const expect: Array<[string, string, string]> = [
      ['confirmed', o.confirmed.id, 'confirmed'], ['cancelled', o.cancelled.id, 'cancelled'],
      ['delivered', o.delivered.id, 'delivered'], ['returned', o.returned.id, 'returned'],
      ['paid', o.paid.id, 'paid'], ['tracking', o.tracking.id, 'external_tracking'],
      ['teléfono inválido', o.badPhone.id, 'invalid_phone'], ['broadcast previo enviado', o.alreadyBc.id, 'broadcast_already_sent'],
      ['fuera de SD', o.santiago.id, 'not_santo_domingo'],
    ]
    for (const [label, id, reason] of expect) check(`G. ${label} → ${reason}`, reasonOf(p, id) === reason, reasonOf(p, id))
    check('G. todas las razones tienen label humano', Object.keys(p.excluded_by_reason).every(r => !!BROADCAST_REASON_LABELS[r]), p.excluded_by_reason)

    console.log('\n=== F. Teléfonos duplicados ===\n')
    check('F. mismo teléfono (2 formatos) + ambos seleccionados → ambos excluidos',
      reasonOf(p, o.dupA.id) === 'multiple_active_orders_same_phone' && reasonOf(p, o.dupB.id) === 'multiple_active_orders_same_phone')
    check('F. seleccionado 1 de 2 pedidos activos del mismo teléfono → excluido (pool de la tienda)',
      reasonOf(p, o.poolSel.id) === 'multiple_active_orders_same_phone')
    check('F. el pedido NO seleccionado no aparece en la respuesta', reasonOf(p, o.poolOther.id) === 'MISSING')

    console.log('\n=== D. Store isolation ===\n')
    check('D. pedido de otra tienda → not_found (no se lee)', reasonOf(p, o.otherStore.id) === 'not_found')
    check('D. id inexistente → not_found', reasonOf(p, ghost) === 'not_found')
    const scoped = db.queries.filter(q => ['orders', 'wa_template_queue', 'wa_broadcasts'].includes(q.table))
    check('D. TODA consulta lleva store_id de la sesión',
      scoped.length > 0 && scoped.every(q => q.filters.some(f => f.op === 'eq' && f.col === 'store_id' && f.val === S1)), scoped.length)

    console.log('\n=== J. Conteos ===\n')
    check('J. candidate = eligible + excluded', p.candidate_count === p.eligible_count + p.excluded_count)
    check('J. candidate_count = ids únicos pedidos (17)', p.candidate_count === 17, p.candidate_count)
    check('J. suma de excluded_by_reason = excluded_count',
      Object.values(p.excluded_by_reason).reduce((s, v) => s + (v ?? 0), 0) === p.excluded_count)
    check('J. preview no escribe nada', db.writes.length === 0, db.writes)
  }

  // ── B: preview filtered ────────────────────────────────────────────────────
  console.log('\n=== B. Preview filtered ===\n')
  {
    const { db, o } = seed()
    const pPending = await computeBroadcastAudience(db, ctx, ({ campaign: PENDING, mode: 'filtered', filters: {
      scope: 'santo_domingo', status: 'pending', payment: 'todos', date_from: null, date_to: null, search: null } }), NOW)
    const ids = new Set([...pPending.eligible, ...pPending.excluded].map(x => x.order_id))
    check('B. status=pending incluye SD pending sin intentos', ids.has(o.eligible.id) && ids.has(o.old.id))
    check('B. status=pending NO incluye reintentar (attempts>0)', !ids.has(o.retry.id))
    check('B. status=pending NO incluye confirmados', !ids.has(o.confirmed.id))
    check('B. geografía canónica: Santiago no es candidato', !ids.has(o.santiago.id))
    check('B. otra tienda no es candidato', !ids.has(o.otherStore.id))
    check('B. filtered también detecta teléfonos duplicados', reasonOf(pPending, o.poolSel.id) === 'multiple_active_orders_same_phone'
      && reasonOf(pPending, o.poolOther.id) === 'multiple_active_orders_same_phone')

    const pRetry = await computeBroadcastAudience(db, ctx, ({ campaign: PENDING, mode: 'filtered', filters: {
      scope: 'santo_domingo', status: 'reintentar', payment: 'todos', date_from: null, date_to: null, search: null } }), NOW)
    check('B. status=reintentar → solo attempts>0', pRetry.candidate_count === 1 && reasonOf(pRetry, o.retry.id) === 'ELIGIBLE')

    const pSearch = await computeBroadcastAudience(db, ctx, ({ campaign: PENDING, mode: 'filtered', filters: {
      scope: 'santo_domingo', status: '', payment: 'todos', date_from: null, date_to: null, search: 'ana perez' } }), NOW)
    check('B. búsqueda (sin acentos) resuelve en servidor', pSearch.candidate_count === 1 && reasonOf(pSearch, o.eligible.id) === 'ELIGIBLE')

    const pDate = await computeBroadcastAudience(db, ctx, ({ campaign: PENDING, mode: 'filtered', filters: {
      scope: 'santo_domingo', status: 'pending', payment: 'todos', date_from: '2026-01-01T00:00:00.000Z', date_to: '2026-02-01T00:00:00.000Z', search: null } }), NOW)
    check('B. rango de fecha', pDate.candidate_count === 1 && reasonOf(pDate, o.old.id) === 'ELIGIBLE')

    // Localidad que SD_FILTER pierde (province vacía) — la resolución canónica la incluye.
    db.tables.orders.push(mkOrder({ id: 'boca-chica', city: 'Boca Chica', province: null, customer_phone: '849-321-0000' }))
    const pBoca = await computeBroadcastAudience(db, ctx, ({ campaign: PENDING, mode: 'filtered', filters: {
      scope: 'santo_domingo', status: 'pending', payment: 'todos', date_from: null, date_to: null, search: 'boca chica' } }), NOW)
    check('B. Boca Chica sin province (omitida por SD_FILTER) SÍ es candidata', reasonOf(pBoca, 'boca-chica') === 'ELIGIBLE')
  }

  // ── E: allowlist / no confiar en frontend ─────────────────────────────────
  console.log('\n=== E. Elegibilidad solo server-side / allowlist ===\n')
  {
    check('E. filtro desconocido rechazado', !parseBroadcastSelection({ campaign: PENDING, mode: 'filtered', filters: { scope: 'santo_domingo', sql: 'drop' } }).ok)
    check('E. expresión PostgREST como filtro rechazada', !parseBroadcastSelection({ campaign: PENDING, mode: 'filtered', filters: { scope: 'santo_domingo', or: 'id.neq.0' } }).ok)
    check('E. status fuera de allowlist rechazado', !parseBroadcastSelection({ campaign: PENDING, mode: 'filtered', filters: { scope: 'santo_domingo', status: 'delivered' } }).ok)
    check('E. scope ≠ santo_domingo rechazado', !parseBroadcastSelection({ campaign: PENDING, mode: 'filtered', filters: { scope: 'all' } }).ok)
    check('E. order_ids no-UUID rechazados', !parseBroadcastSelection({ campaign: PENDING, mode: 'selected_ids', order_ids: ["1' OR 1=1"] }).ok)
    check('E. >500 ids rechazado', !parseBroadcastSelection({ mode: 'selected_ids', order_ids: Array.from({ length: 501 }, () => randomUUID()) }).ok)
    const dedup = parseBroadcastSelection({ campaign: PENDING, mode: 'selected_ids', order_ids: ['AAAAAAAA-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000000'] })
    check('E. ids deduplicados (case-insensitive)', dedup.ok && dedup.selection.mode === 'selected_ids' && dedup.selection.order_ids.length === 1)

    const ui = ['src/components/broadcast/BroadcastPrepareModal.tsx', 'src/components/broadcast/BroadcastHistoryModal.tsx', 'src/app/(app)/confirmacion/page.tsx']
      .map(f => readFileSync(join(__dirname, '..', f), 'utf8')).join('\n')
    check('E. UI no importa el servicio de audiencia', !ui.includes('broadcast-service'))
    check('E. UI no importa reglas de elegibilidad (sd-broadcast-eligibility)', !ui.includes('sd-broadcast-eligibility'))
    const createRoute = readFileSync(join(__dirname, '..', 'src/app/api/admin/broadcasts/route.ts'), 'utf8')
    check('E/H. endpoint create no lee conteos del body', !/body\??\.(candidate|eligible|excluded)_count/.test(createRoute) && !/body\??\.store_id/.test(createRoute))
  }

  // ── C: admin requerido ─────────────────────────────────────────────────────
  console.log('\n=== C. Admin requerido ===\n')
  {
    const sess = (user: { id: string } | null, profile: Row | null) => ({
      auth: { getUser: async () => ({ data: { user } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile }) }) }) }),
    })
    const r1 = await getBroadcastAdminContext(sess(null, null))
    check('C. sin sesión → 401', !r1.ok && r1.status === 401)
    for (const role of ['confirmation_agent', 'ia_supervisor', 'novelty_agent', 'delivery_agent', 'santo_domingo_delivery_agent', 'viewer']) {
      const r = await getBroadcastAdminContext(sess({ id: 'u' }, { role, store_id: S1, is_active: true }))
      check(`C. ${role} → 403`, !r.ok && r.status === 403)
    }
    const rInactive = await getBroadcastAdminContext(sess({ id: 'u' }, { role: 'admin', store_id: S1, is_active: false }))
    check('C. admin inactivo → 403', !rInactive.ok && rInactive.status === 403)
    const rNoStore = await getBroadcastAdminContext(sess({ id: 'u' }, { role: 'admin', store_id: null, is_active: true }))
    check('C. admin sin tienda → 403', !rNoStore.ok && rNoStore.status === 403)
    const rOk = await getBroadcastAdminContext(sess({ id: 'u-1' }, { role: 'admin', store_id: S1, is_active: true }))
    check('C. admin → ok, store_id del perfil', rOk.ok && rOk.ctx.storeId === S1 && rOk.ctx.userId === 'u-1')
    for (const f of ['src/app/api/admin/broadcasts/route.ts', 'src/app/api/admin/broadcasts/preview/route.ts']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8')
      const nAuth = (src.match(/getBroadcastAdminContext\(/g) ?? []).length
      const nHandlers = (src.match(/export async function (GET|POST)/g) ?? []).length
      check(`C. ${f.split('/api/')[1]}: cada handler verifica admin`, nAuth === nHandlers && nHandlers > 0, { nAuth, nHandlers })
    }
  }

  // ── H / I / J / K / L: create draft ───────────────────────────────────────
  console.log('\n=== H/I/J/K/L. Crear draft ===\n')
  {
    const { db, o } = seed()
    const sel: BroadcastSelection = { campaign: PENDING, mode: 'selected_ids', order_ids: [o.eligible.id, o.location.id, o.confirmed.id, o.dupA.id, o.dupB.id] }
    const preview = await computeBroadcastAudience(db, ctx, sel, NOW)
    check('H. preview: 2 elegibles', preview.eligible_count === 2, preview.eligible_count)

    // Entre preview y crear, el cliente confirma por otro canal.
    db.tables.orders.find(r => r.id === o.eligible.id)!.confirmation_status = 'confirmed'

    const queueBefore = db.tables.wa_template_queue.length
    const bcBefore    = db.tables.wa_broadcasts.length
    const key = randomUUID()
    const r1 = await createBroadcastDraft(db, ctx, sel, key)

    check('H. create recalcula en servidor (2 → 1 elegible)', r1.ok && r1.broadcast.eligible_count === 1, r1)
    check('I. wa_broadcasts +1', db.tables.wa_broadcasts.length === bcBefore + 1)
    check('I. wa_template_queue +0', db.tables.wa_template_queue.length === queueBefore)
    check('I. única escritura: INSERT en wa_broadcasts', db.writes.length === 1 && db.writes[0].table === 'wa_broadcasts' && db.writes[0].op === 'insert', db.writes)

    if (r1.ok) {
      const b = r1.broadcast
      check('J. status = draft', b.status === 'draft')
      check('J. template_name = sd_broadcast_confirmation', b.template_name === 'sd_broadcast_confirmation')
      check('J. store_id/created_by de la sesión', b.store_id === S1 && b.created_by === 'admin-1')
      check('J. eligibility_rule_version (coordinación v2)', b.eligibility_rule_version === 'sd_coordination_v2')
      check('J. conteos consistentes', b.candidate_count === 5 && b.eligible_count + b.excluded_count === b.candidate_count, b)
      check('J. excluded_by_reason correcto', b.excluded_by_reason.confirmed === 2 && b.excluded_by_reason.multiple_active_orders_same_phone === 2, b.excluded_by_reason)

      const sf = b.selection_filter as Row
      check('K. selection_filter: mode + order_ids', sf.mode === 'selected_ids' && Array.isArray(sf.order_ids) && sf.order_ids.length === 5)
      check('K. request_key en COLUMNA propia (no en JSONB) + resolved_at en selection_filter',
        b.request_key === key && !('request_key' in sf) && typeof sf.resolved_at === 'string')
      const sfJson = JSON.stringify(sf)
      check('K. selection_filter sin datos del pedido (nombres/teléfonos/productos)',
        !sfJson.includes('Ana Pérez') && !sfJson.includes('809-') && !sfJson.includes('LÜMA') && !sfJson.includes('confirmation_status'))

      // L. doble submit con la misma key → replay, sin nuevo draft.
      const r2 = await createBroadcastDraft(db, ctx, sel, key)
      check('L. misma request_key → devuelve el mismo draft (replay)', r2.ok && r2.replay && r2.broadcast.id === b.id)
      check('L. sigue habiendo 1 draft', db.tables.wa_broadcasts.length === bcBefore + 1)
      const r3 = await createBroadcastDraft(db, ctx, sel, randomUUID())
      check('L. key distinta → draft nuevo (intencional)', r3.ok && !r3.replay && db.tables.wa_broadcasts.length === bcBefore + 2)
    }

    // Filtered draft guarda filtros, no ids.
    const rf = await createBroadcastDraft(db, ctx, { campaign: PENDING, mode: 'filtered', filters: {
      scope: 'santo_domingo', status: 'pending', payment: 'todos', date_from: null, date_to: null, search: null } }, randomUUID())
    const sff = rf.ok ? rf.broadcast.selection_filter as Row : {}
    check('K. filtered: guarda filtros allowlisted, no ids', rf.ok && sff.mode === 'filtered' && sff.filters?.scope === 'santo_domingo' && !('order_ids' in sff))

    // 0 elegibles → no se crea draft.
    const before0 = db.tables.wa_broadcasts.length
    const r0 = await createBroadcastDraft(db, ctx, { campaign: PENDING, mode: 'selected_ids', order_ids: [o.confirmed.id] }, randomUUID())
    check('H. 0 elegibles → 422 y sin draft', !r0.ok && r0.status === 422 && db.tables.wa_broadcasts.length === before0)
    check('I. en todo el flujo: wa_template_queue intacta', db.tables.wa_template_queue.length === queueBefore)

    const modal = readFileSync(join(__dirname, '..', 'src/components/broadcast/BroadcastPrepareModal.tsx'), 'utf8')
    check('L. UI: botón deshabilitado mientras crea / ya creado', /disabled=\{loading \|\| creating/.test(modal) && /if \(creating \|\| created\) return/.test(modal))
    check('L. UI: request_key por apertura del modal', /useState\(newRequestKey\)/.test(modal))
  }

  // ── M: 0 caminos de envío ──────────────────────────────────────────────────
  console.log('\n=== M. 0 caminos de envío ===\n')
  {
    const files = [
      'src/lib/broadcast/broadcast-service.ts', 'src/lib/broadcast/selection.ts', 'src/lib/broadcast/admin-context.ts',
      'src/lib/broadcast/labels.ts', 'src/lib/broadcast/message-preview.ts',
      'src/app/api/admin/broadcasts/route.ts', 'src/app/api/admin/broadcasts/preview/route.ts',
      'src/components/broadcast/BroadcastPrepareModal.tsx', 'src/components/broadcast/BroadcastHistoryModal.tsx',
    ]
    const strip = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    const src = files.map(f => strip(readFileSync(join(__dirname, '..', f), 'utf8'))).join('\n')
    check('M. sin graph.facebook.com / Meta', !/graph\.facebook|WA_ACCESS_TOKEN|WA_PHONE_NUMBER_ID/.test(src))
    check('M. sin import del processor / cron', !/cron\/wa-template-queue|wa-queue\/automation-queue|runOrderConfirmationJob/.test(src))
    check('M. sin send template helpers', !/sendWhatsApp|sendTemplate|wa-test-send/i.test(src))
    check('M. sin escrituras en wa_template_queue', !/from\('wa_template_queue'\)[\s\S]{0,200}?\.(insert|upsert|update|delete)\(/.test(src))
    check('M. únicas escrituras: insert en wa_broadcasts', (src.match(/\.(insert|upsert|update|delete)\(/g) ?? []).length === 1 && /from\('wa_broadcasts'\)\.insert\(/.test(src))
    check('M. no depende de WA_BROADCAST_ENABLED ni de AUTOMATIONS', !/WA_BROADCAST_ENABLED|WA_AUTOMATIONS_ENABLED/.test(src))
    const vercel = readFileSync(join(__dirname, '..', 'vercel.json'), 'utf8')
    check('M. sin cron nuevo en vercel.json', !/broadcast/i.test(vercel))
  }

  // ── B.1: frontera de audiencia + idempotencia real ────────────────────────
  console.log('\n=== B.1 A–E. Filtered: resolved_at como cutoff (created_at) ===\n')
  {
    const { db, o } = seed()
    const queueBefore = db.tables.wa_template_queue.length
    const filtered: BroadcastSelection = { campaign: PENDING, mode: 'filtered', filters: {
      scope: 'santo_domingo', status: 'pending', payment: 'todos', date_from: null, date_to: null, search: null } }

    const r = await createBroadcastDraft(db, ctx, filtered, randomUUID())
    check('A. draft filtered creado a T0', r.ok && r.broadcast.status === 'draft')
    if (!r.ok) throw new Error('no draft')
    const draft = r.broadcast
    const T0 = (draft.selection_filter as Row).resolved_at as string
    check('A. resolved_at guardado (T0)', typeof T0 === 'string' && !Number.isNaN(Date.parse(T0)))

    const v0 = await revalidateDraftAudience(db, ctx, draft)
    const originalIds = new Set([...v0.eligible, ...v0.excluded].map(x => x.order_id))
    check('A. revalidar sin cambios = conteos del draft', v0.eligible_count === draft.eligible_count && v0.candidate_count === draft.candidate_count,
      { v0: [v0.candidate_count, v0.eligible_count], draft: [draft.candidate_count, draft.eligible_count] })
    check('B. pedido que existía antes de T0 pertenece', originalIds.has(o.eligible.id) && originalIds.has(o.old.id))

    // Borde: created_at == T0 (con otro formato ISO) pertenece; T0 + 1ms no.
    const t0ms = Date.parse(T0)
    check('B. created_at == T0 pertenece (<=), aunque venga como +00:00',
      existedAt({ created_at: new Date(t0ms).toISOString().replace('Z', '+00:00') }, T0))
    check('C. created_at == T0 + 1ms NO pertenece', !existedAt({ created_at: new Date(t0ms + 1).toISOString() }, T0))
    check('C. created_at null NO pertenece (fail-closed)', !existedAt({ created_at: null }, T0))

    // 10:15 — entran pedidos nuevos que cumplen el filtro.
    const late = [1, 2, 3].map(i => mkOrder({ customer_phone: `849-600-000${i}`, created_at: new Date(t0ms + 60_000 * i).toISOString() }))
    db.tables.orders.push(...late)
    // De los originales: uno confirma por otro canal, otro cancela.
    db.tables.orders.find(x => x.id === o.eligible.id)!.confirmation_status = 'confirmed'
    db.tables.orders.find(x => x.id === o.location.id)!.confirmation_status = 'cancelled'

    const v1 = await revalidateDraftAudience(db, ctx, draft)
    const v1Ids = [...v1.eligible, ...v1.excluded].map(x => x.order_id)
    check('C. pedidos creados después de T0 NO aparecen al revalidar', late.every(l => !v1Ids.includes(l.id)))
    check('D. revalidar reduce: confirmó/canceló salen de elegibles',
      !v1.eligible.some(e => e.order_id === o.eligible.id || e.order_id === o.location.id) && v1.eligible_count === draft.eligible_count - 2,
      { draft: draft.eligible_count, now: v1.eligible_count })
    check('E. nunca amplía: candidatos revalidados ⊆ candidatos originales', v1Ids.every(id => originalIds.has(id)))
    check('E. eligible revalidado <= eligible del draft', v1.eligible_count <= draft.eligible_count)

    // Contraste: un preview NUEVO (cutoff = ahora) sí ve los pedidos nuevos —
    // prueba que la exclusión viene del cutoff del draft, no del filtro.
    const fresh = await computeBroadcastAudience(db, ctx, filtered, new Date(t0ms + 3_600_000).toISOString())
    check('E. (contraste) preview nuevo con cutoff posterior sí los incluye',
      late.every(l => fresh.eligible.some(e => e.order_id === l.id)))
    check('E. cutoff también en SQL (lte created_at) del resolver filtered',
      db.queries.some(q => q.table === 'orders' && q.filters.some(f => f.op === 'lte' && f.col === 'created_at')))
    check('L. +0 wa_template_queue en todo el flujo B.1 filtered', db.tables.wa_template_queue.length === queueBefore)
  }

  console.log('\n=== B.1 F. selected_ids: los ids son la frontera ===\n')
  {
    const { db, o } = seed()
    const sel: BroadcastSelection = { campaign: PENDING, mode: 'selected_ids', order_ids: [o.eligible.id, o.location.id, o.confirmed.id] }
    const r = await createBroadcastDraft(db, ctx, sel, randomUUID())
    if (!r.ok) throw new Error('no draft')
    db.tables.orders.push(mkOrder({ customer_phone: '849-700-0001', created_at: new Date(Date.now() + 60_000).toISOString() }))
    db.tables.orders.push(mkOrder({ customer_phone: '849-700-0002' }))  // pedido viejo NO seleccionado
    db.tables.orders.find(x => x.id === o.eligible.id)!.payment_status = 'paid'
    const v = await revalidateDraftAudience(db, ctx, r.broadcast)
    const ids = [...v.eligible, ...v.excluded].map(x => x.order_id)
    check('F. candidatos revalidados == ids guardados (3), nunca otros', v.candidate_count === 3 && ids.every(id => sel.order_ids.includes(id)), ids)
    check('F. revalidar quita el que dejó de ser elegible', v.eligible_count === r.broadcast.eligible_count - 1 && reasonOf(v, o.eligible.id) === 'paid')

    let threw = 0
    for (const bad of [
      { campaign: PENDING, mode: 'filtered', filters: { scope: 'santo_domingo', sql: 'x' }, resolved_at: NOW },
      { campaign: PENDING, mode: 'selected_ids', order_ids: [o.eligible.id] },  // sin resolved_at
      { campaign: PENDING, mode: 'selected_ids', order_ids: ['no-uuid'], resolved_at: NOW },
    ]) { try { audienceFromDraft(bad) } catch { threw++ } }
    check('F. selection_filter manipulado/incompleto → revalidación rechaza', threw === 3)
    let other = false
    try { await revalidateDraftAudience(db, { userId: 'x', storeId: S2 }, r.broadcast) } catch { other = true }
    check('F. no se revalida un draft de otra tienda', other)
  }

  console.log('\n=== B.1 G/H/I. Idempotencia por (store_id, request_key) ===\n')
  {
    const { db, o } = seed()
    const sel: BroadcastSelection = { campaign: PENDING, mode: 'selected_ids', order_ids: [o.eligible.id] }
    const key = randomUUID()
    const a = await createBroadcastDraft(db, ctx, sel, key)
    const b = await createBroadcastDraft(db, ctx, sel, key)
    check('G. dos creates secuenciales misma key → mismo draft', a.ok && b.ok && b.replay && a.broadcast.id === b.broadcast.id)
    check('G. una sola fila para esa key', db.tables.wa_broadcasts.filter(r => r.request_key === key).length === 1)

    // H1. Determinístico: otra request gana entre el lookup y el insert.
    const keyH = randomUUID()
    let competitorId = ''
    db.beforeInsert = (table, payload) => {
      if (table !== 'wa_broadcasts') return
      competitorId = randomUUID()
      db.tables.wa_broadcasts.push({ ...payload, id: competitorId, created_at: new Date().toISOString() })
    }
    const h = await createBroadcastDraft(db, ctx, sel, keyH)
    check('H. unique conflict (23505) → devuelve el draft existente, sin error', h.ok && h.replay && h.broadcast.id === competitorId, h)
    check('H. una sola fila para la key en conflicto', db.tables.wa_broadcasts.filter(r => r.request_key === keyH).length === 1)

    // H2. Concurrencia real (interleaving async).
    const keyC = randomUUID()
    const [c1, c2] = await Promise.all([createBroadcastDraft(db, ctx, sel, keyC), createBroadcastDraft(db, ctx, sel, keyC)])
    check('H. dos creates concurrentes → ambos ok, mismo draft, una fila',
      c1.ok && c2.ok && c1.broadcast.id === c2.broadcast.id && (c1.replay !== c2.replay)
        && db.tables.wa_broadcasts.filter(r => r.request_key === keyC).length === 1, { c1, c2 })

    // Conflicto con key de OTRO admin de la tienda → 409, nunca 500 ni draft ajeno.
    const keyX = randomUUID()
    db.beforeInsert = (table, payload) => {
      if (table === 'wa_broadcasts') db.tables.wa_broadcasts.push({ ...payload, id: randomUUID(), created_by: 'otro-admin' })
    }
    const x = await createBroadcastDraft(db, ctx, sel, keyX)
    check('H. conflicto con draft de otro admin → 409 (no 500, no se entrega)', !x.ok && x.status === 409)

    // I. Misma key en otra tienda no colisiona.
    const ctx2: BroadcastAdminContext = { userId: 'admin-2', storeId: S2 }
    const i2 = await createBroadcastDraft(db, ctx2, { campaign: PENDING, mode: 'selected_ids', order_ids: [o.otherStore.id] }, key)
    check('I. misma request_key en otra tienda → draft propio (no replay)', i2.ok && !i2.replay && i2.broadcast.store_id === S2 && i2.broadcast.id !== (a.ok ? a.broadcast.id : ''))
    check('I. el replay busca por store_id + request_key',
      db.queries.some(q => q.table === 'wa_broadcasts' && q.filters.some(f => f.col === 'request_key') && q.filters.some(f => f.col === 'store_id')))
    check('L. +0 wa_template_queue tras todos los creates', db.tables.wa_template_queue.length === 2)
  }

  console.log('\n=== B.1 J/K. Precio dinámico ===\n')
  {
    check('J. renderer usa cod_amount (2500 → RD$2,500)', renderBroadcastPreview({ customer_name: 'X', product_summary: 'Y', cod_amount: 2500 }).includes('RD$2,500'))
    check('J. renderer con decimales (1490.5 → RD$1,490.5)', renderBroadcastPreview({ customer_name: 'X', product_summary: 'Y', cod_amount: 1490.5 }).includes('RD$1,490.5'))
    check('J. cod_amount null → RD$0 (no inventa precio)', renderBroadcastPreview({ customer_name: 'X', product_summary: 'Y', cod_amount: null }).includes('RD$0*'))
    const { db, o } = seed()
    db.tables.orders.find(x => x.id === o.eligible.id)!.cod_amount = 3450
    const p = await computeBroadcastAudience(db, ctx, { campaign: PENDING, mode: 'selected_ids', order_ids: [o.eligible.id] }, NOW)
    check('J. preview del servidor usa orders.cod_amount del pedido (3450)', p.eligible[0]?.message_preview.includes('RD$3,450') === true)

    const code = ['src/lib/broadcast/message-preview.ts', 'src/lib/broadcast/broadcast-service.ts', 'src/lib/broadcast/selection.ts',
      'src/lib/broadcast/labels.ts', 'src/lib/broadcast/sd-broadcast-eligibility.ts', 'src/app/api/admin/broadcasts/route.ts',
      'src/app/api/admin/broadcasts/preview/route.ts', 'src/components/broadcast/BroadcastPrepareModal.tsx',
      'src/components/broadcast/BroadcastHistoryModal.tsx'].map(f => readFileSync(join(__dirname, '..', f), 'utf8')).join('\n')
    check('K. sin 1990 / 1,990 en código Broadcast', !/1[,.]?990/.test(code))
    check('K. sin montos RD$ literales (precio siempre vía formatCodAmount)', !/RD\$ ?\d/.test(code) && code.includes('RD$${formatCodAmount(v.cod_amount)}'))
  }

  console.log('\n=== B.1 Migración 065 (estática, NO aplicada) ===\n')
  {
    const sql = readFileSync(join(__dirname, '..', 'supabase/migrations/065_wa_broadcast_request_key.sql'), 'utf8')
    const body = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    check('065: request_key UUID NOT NULL', /ADD COLUMN request_key UUID NOT NULL;/.test(body))
    check('065: UNIQUE (store_id, request_key)', /UNIQUE \(store_id, request_key\)/.test(body))
    check('065: aborta si wa_broadcasts no está vacía', /IF EXISTS \(SELECT 1 FROM wa_broadcasts\)[\s\S]*RAISE EXCEPTION/.test(body))
    check('065: no toca wa_template_queue', !/wa_template_queue/.test(body))
    let unchanged = false
    try { execSync('git diff --quiet HEAD -- supabase/migrations/064_wa_broadcasts.sql', { cwd: join(__dirname, '..') }); unchanged = true } catch { unchanged = false }
    check('064 sin cambios respecto al commit', unchanged)
  }

  console.log(`\n${failures === 0 ? '✅ TODOS LOS TESTS PASAN' : `❌ ${failures} FALLO(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
