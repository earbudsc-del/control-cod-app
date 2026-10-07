// Sprint B.2.4 — autorización de conversaciones Ruta COD.
//
// Determinístico, DB en memoria. NO toca la DB real, NO envía nada.
//
// Corre con: npx tsx scripts/test-conversation-access.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FakeDb, type Row } from './lib/broadcast-fake-db'
import {
  checkConversationOrderAccess, decideConversationAccess, loadActiveSdOrdersIndex, loadConversationForMessenger,
  resolveConversationAccess, type AccessOrderRow,
} from '../src/lib/deliveries/conversations'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

const S1 = 'store-1', S2 = 'store-2'
const A = 'messenger-A', B = 'messenger-B', C = 'messenger-C', ADMIN = 'admin-1'
const MSG = 'santo_domingo_delivery_agent'
const PHONE = '18095551234'
let n = 0
function ord(o: Partial<Row> = {}): Row {
  n++
  return {
    id: randomUUID(), store_id: S1, customer_phone: '809-555-1234', city: 'Santo Domingo Este', province: 'Santo Domingo',
    customer_address: 'Calle 4', tracking_number: null, normalized_status: 'en_reparto', confirmation_status: 'confirmed',
    payment_status: 'pending', is_test: false, archived_at: null, assigned_to: A,
    order_number: `#${8000 + n}`, customer_name: `Cliente ${n}`, cod_amount: 2100,
    created_at: new Date(Date.now() - (1000 - n) * 60_000).toISOString(), ...o,
  }
}
const asRow = (o: Row) => o as unknown as AccessOrderRow
const dec = (active: Row[], linked: Row | null, user: string, role = MSG) =>
  decideConversationAccess(active.map(asRow), linked ? asRow(linked) : null, user, role)
const resolveFor = (db: FakeDb, user: string, role = MSG, linkedOrderId: string | null = null, store = S1) =>
  resolveConversationAccess(db, { storeId: store, contactPhone: PHONE, linkedOrderId, userId: user, role })

async function main() {
  console.log('=== Casos obligatorios ===\n')
  {
    const o = ord({ assigned_to: A })
    const ra = dec([o], null, A), rb = dec([o], null, B)
    check('1. activo asignado a A → A tiene acceso', ra.allowed && ra.orderId === o.id)
    check('2. activo asignado a A → B NO tiene acceso', !rb.allowed && rb.reason === 'not_owner')

    const free = ord({ assigned_to: null })
    const rf = dec([free], null, C)
    check('cierre B.2: activo SIN asignar → ningún mensajero accede al chat hasta asignarse', !rf.allowed && rf.reason === 'not_owner')
    check('cierre B.2: activo sin asignar → admin sí', dec([free], null, ADMIN, 'admin').allowed)
  }
  {
    const delivered = ord({ normalized_status: 'delivered', payment_status: 'paid', assigned_to: A })
    const ra = dec([], delivered, A)
    check('3. pedido entregado: A pierde acceso operativo (política histórica: solo admin)', !ra.allowed && ra.reason === 'no_active_order')
    check('3. pedido entregado: admin conserva acceso histórico', dec([], delivered, ADMIN, 'admin').allowed)
    check('3. checkConversationOrderAccess: entregado → mensajero NO, admin SÍ',
      !checkConversationOrderAccess(asRow(delivered), A, MSG).allowed && checkConversationOrderAccess(asRow(delivered), ADMIN, 'admin').allowed)
  }
  {
    const re = ord({ assigned_to: B })
    check('4. reasignado A → B: A pierde acceso, B lo tiene', !dec([re], null, A).allowed && dec([re], null, B).allowed)
  }
  {
    // Vínculo obsoleto: wa_contacts.order_id apunta a un pedido entregado SIN asignar.
    // Antes: isSdEligible + unassigned → CUALQUIER mensajero tenía acceso.
    const staleFree = ord({ normalized_status: 'delivered', payment_status: 'paid', assigned_to: null })
    check('5. vínculo obsoleto (entregado sin asignar) → ningún mensajero obtiene acceso',
      !dec([], staleFree, A).allowed && !dec([], staleFree, C).allowed)
    check('5. checkConversationOrderAccess ya no autoriza un histórico sin asignar',
      !checkConversationOrderAccess(asRow(staleFree), C, MSG).allowed)
  }
  {
    const db = new FakeDb()
    const old = ord({ normalized_status: 'delivered', payment_status: 'paid', assigned_to: A, created_at: new Date(Date.now() - 60 * 86_400_000).toISOString() })
    const current = ord({ assigned_to: B })
    db.tables.orders.push(old, current)
    const ra = await resolveFor(db, A, MSG, old.id)
    const rb = await resolveFor(db, B, MSG, old.id)
    check('5. vínculo apunta al pedido viejo de A, pedido activo actual es de B → A NO, B SÍ (por el pedido actual)',
      !ra.allowed && rb.allowed && rb.orderId === current.id, { ra, rb })
  }
  {
    const a1 = ord({ assigned_to: A }), b1 = ord({ assigned_to: B })
    const ra = dec([a1, b1], null, A), rb = dec([a1, b1], null, B)
    check('6. dos activos (A y B) → nadie elige a ciegas: ambos mensajeros sin acceso',
      !ra.allowed && ra.reason === 'ambiguous' && !rb.allowed)
    check('6. dos activos ambos de A → A sí', dec([ord({ assigned_to: A }), ord({ assigned_to: A })], null, A).allowed)
    check('6. dos activos (A + sin asignar) → A no (no todos son suyos)', !dec([ord({ assigned_to: A }), ord({ assigned_to: null })], null, A).allowed)
    check('6. dos activos → admin sí', dec([a1, b1], null, ADMIN, 'admin').allowed)
  }
  {
    check('7. sin pedido activo y sin vínculo → sin acceso', !dec([], null, A).allowed)
    const oldLinked = ord({ normalized_status: 'returned', assigned_to: A })
    check('7. sin pedido activo + vínculo viejo propio → el vínculo NO concede acceso', !dec([], oldLinked, A).allowed)
  }
  {
    const anyActive = ord({ assigned_to: B })
    check('8. admin conserva acceso a pedido activo de cualquiera', dec([anyActive], null, ADMIN, 'admin').allowed)
    const efi = ord({ tracking_number: 'EFI1', normalized_status: 'delivered' })
    check('8. admin: histórico NO-SD (con guía) sigue sin acceso por Ruta COD', !dec([], efi, ADMIN, 'admin').allowed)
  }
  {
    const db = new FakeDb()
    db.tables.orders.push(ord({ store_id: S2, assigned_to: A }))
    const r1 = await resolveFor(db, A, MSG, null, S1)
    const r2 = await resolveFor(db, A, MSG, null, S2)
    check('9. aislamiento por tienda: pedido de otra tienda no autoriza', !r1.allowed && r2.allowed)
    const linkedOther = ord({ store_id: S2, normalized_status: 'delivered' })
    db.tables.orders.push(linkedOther)
    check('9. admin: vínculo a pedido de otra tienda no autoriza', !(await resolveFor(db, ADMIN, 'admin', linkedOther.id, S1)).allowed)
  }

  console.log('\n=== Estados que NO autorizan a un mensajero ===\n')
  for (const [label, o] of [
    ['cancelado', { confirmation_status: 'cancelled' }], ['devuelto', { normalized_status: 'returned' }],
    ['pagado', { payment_status: 'paid' }], ['con guía EFI', { tracking_number: 'EFI2' }],
    ['de prueba', { is_test: true }], ['archivado', { archived_at: new Date().toISOString() }],
    ['fuera de SD', { city: 'Santiago', province: 'Santiago' }], ['no_coverage', { confirmation_status: 'no_coverage' }],
  ] as const) {
    check(`${label} → mensajero sin acceso`, !checkConversationOrderAccess(asRow(ord({ ...o, assigned_to: A })), A, MSG).allowed)
  }

  console.log('\n=== Índice de la lista ===\n')
  {
    const db = new FakeDb()
    const mine = ord({ assigned_to: A, customer_phone: '(809) 555-1234' })
    db.tables.orders.push(mine, ord({ customer_phone: '829-111-2222', assigned_to: B }),
      ord({ customer_phone: '809-555-1234', normalized_status: 'delivered' }), ord({ customer_phone: '809-555-1234', store_id: S2 }))
    for (let i = 0; i < 1200; i++) db.tables.orders.push(ord({ customer_phone: `849-${String(100 + (i % 800)).padStart(3, '0')}-${String(3000 + i)}`, assigned_to: null }))
    const activeFor = await loadActiveSdOrdersIndex(db, S1)
    const act = activeFor(PHONE)
    check('lista: índice devuelve solo activos SD de la tienda para ese teléfono (paginado > 1000)', act.length === 1 && act[0].id === mine.id, act.map(o => o.id))
    check('lista: misma decisión que el endpoint de mensajes', dec(act as unknown as Row[], null, A).allowed && !dec(act as unknown as Row[], null, B).allowed)
    check('lista: teléfono sin pedidos activos → []', activeFor('18490000000').length === 0)
  }

  console.log('\n=== GET / POST de mensajes (loadConversationForMessenger) ===\n')
  {
    const db = new FakeDb()
    db.tables.wa_conversations = []
    const conv = (id: string, store: string, order_id: string | null, phone = PHONE) => ({
      id, store_id: store, contact: { order_id, wa_id: phone, phone_normalized: phone } })
    const mineA = ord({ assigned_to: A })
    db.tables.orders.push(mineA)
    db.tables.wa_conversations.push(conv('c-active', S1, mineA.id))
    const load = (id: string, user: string, role = MSG, store = S1) => loadConversationForMessenger(db, id, store, user, role)

    const ga = await load('c-active', A)
    check('GET/POST: pedido activo asignado a A → A ok (resuelve ese pedido)', ga.kind === 'ok' && ga.orderId === mineA.id, ga)
    check('GET/POST: mismo chat → B forbidden', (await load('c-active', B)).kind === 'forbidden')
    check('GET/POST: admin de la tienda → ok', (await load('c-active', ADMIN, 'admin')).kind === 'ok')
    check('GET/POST: otra tienda → not_found (también admin)',
      (await load('c-active', A, MSG, S2)).kind === 'not_found' && (await load('c-active', ADMIN, 'admin', S2)).kind === 'not_found')
    check('GET/POST: conversación inexistente → not_found', (await load('nope', A)).kind === 'not_found')

    const db2 = new FakeDb(); db2.tables.wa_conversations = []
    const free = ord({ assigned_to: null })
    db2.tables.orders.push(free)
    db2.tables.wa_conversations.push(conv('c-free', S1, free.id))
    check('GET/POST: pedido activo SIN asignar → forbidden para mensajero',
      (await loadConversationForMessenger(db2, 'c-free', S1, C, MSG)).kind === 'forbidden')

    const db3 = new FakeDb(); db3.tables.wa_conversations = []
    const delivered = ord({ normalized_status: 'delivered', payment_status: 'paid', assigned_to: A })
    db3.tables.orders.push(delivered)
    db3.tables.wa_conversations.push(conv('c-closed', S1, delivered.id))
    check('GET/POST: pedido cerrado → A pierde acceso; admin conserva histórico',
      (await loadConversationForMessenger(db3, 'c-closed', S1, A, MSG)).kind === 'forbidden'
        && (await loadConversationForMessenger(db3, 'c-closed', S1, ADMIN, 'admin')).kind === 'ok')

    const db4 = new FakeDb(); db4.tables.wa_conversations = []
    const old = ord({ normalized_status: 'delivered', assigned_to: B })
    const cur = ord({ assigned_to: A })
    db4.tables.orders.push(old, cur)
    db4.tables.wa_conversations.push(conv('c-stale', S1, old.id))
    const r4a = await loadConversationForMessenger(db4, 'c-stale', S1, A, MSG)
    check('GET/POST: vínculo obsoleto (pedido viejo de B) + activo de A → A ok por el pedido actual, B forbidden',
      r4a.kind === 'ok' && r4a.orderId === cur.id && (await loadConversationForMessenger(db4, 'c-stale', S1, B, MSG)).kind === 'forbidden')

    const db5 = new FakeDb(); db5.tables.wa_conversations = []
    db5.tables.orders.push(ord({ assigned_to: A }), ord({ assigned_to: B }))
    db5.tables.wa_conversations.push(conv('c-amb', S1, null))
    check('GET/POST: dos activos (A y B) → ambos forbidden; admin ok',
      (await loadConversationForMessenger(db5, 'c-amb', S1, A, MSG)).kind === 'forbidden'
        && (await loadConversationForMessenger(db5, 'c-amb', S1, B, MSG)).kind === 'forbidden'
        && (await loadConversationForMessenger(db5, 'c-amb', S1, ADMIN, 'admin')).kind === 'ok')

    // Orden en la ruta: la autorización ocurre ANTES de leer mensajes / enviar a Meta.
    const route = readFileSync(join(__dirname, '..', 'src/app/api/v1/deliveries/conversations/[id]/messages/route.ts'), 'utf8')
    const getBody = route.slice(route.indexOf('export async function GET('), route.indexOf('export async function POST('))
    const postBody = route.slice(route.indexOf('export async function POST('), route.indexOf('export async function OPTIONS('))
    const before = (body: string, guard: string, ...after: string[]) =>
      body.indexOf(guard) !== -1 && after.every(a => body.indexOf(a) === -1 || body.indexOf(guard) < body.indexOf(a))
    check('GET: autoriza (y corta en forbidden) antes de leer wa_messages',
      before(getBody, "if (access.kind === 'forbidden')", ".from('wa_messages')"))
    check('POST: autoriza (y corta en forbidden) antes de enviar a Meta o insertar',
      before(postBody, "if (access.kind === 'forbidden')", 'sendWhatsAppText(', 'fetch(', ".from('wa_messages')"))
  }

  console.log('\n=== Endpoints ===\n')
  {
    const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const list = read('src/app/api/v1/deliveries/conversations/route.ts')
    const msgs = read('src/app/api/v1/deliveries/conversations/[id]/messages/route.ts')
    const conv = read('src/app/api/v1/deliveries/orders/[id]/conversation/route.ts')
    check('lista: decide con loadActiveSdOrdersIndex + decideConversationAccess', list.includes('loadActiveSdOrdersIndex(supabase, profile.store_id)') && list.includes('decideConversationAccess('))
    check('lista: ya no autoriza con contact.order_id → checkConversationOrderAccess', !list.includes('checkConversationOrderAccess'))
    const lib = read('src/lib/deliveries/conversations.ts')
    check('mensajes (GET/POST): ambos usan loadConversationForMessenger de la lib, que decide con resolveConversationAccess',
      msgs.includes("import { loadConversationForMessenger } from '@/lib/deliveries/conversations'")
        && (msgs.match(/loadConversationForMessenger\(supabase, id/g) ?? []).length === 2
        && !/async function loadConversationForMessenger/.test(msgs)
        && /export async function loadConversationForMessenger[\s\S]*resolveConversationAccess\(supabase/.test(lib))
    check('mensajes: ya no lee el pedido por contact.order_id para autorizar', !/\.eq\('id', contact\.order_id\)/.test(msgs))
    check('orders/[id]/conversation: aislamiento de tienda también para admin', conv.includes('if (order.store_id !== profile.store_id) {') && !conv.includes("profile.role !== 'admin'"))
    check('orders/[id]/conversation: selecciona campos de actividad', /payment_status, is_test, archived_at/.test(conv))
  }

  console.log(`\n${failures === 0 ? '✅ TODOS LOS TESTS PASAN' : `❌ ${failures} FALLO(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
