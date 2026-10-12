// Inbox WhatsApp — búsqueda global, filtros, paginación y permisos.
// Uso: npx tsx scripts/test-inbox-search.ts
//
// Offline: DB en memoria (C1FakeDb). Sin red, sin Supabase, sin Meta.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { C1FakeDb, type Row } from './lib/c1-fake-db'
import {
  __resetInboxCaches, attentionFlags, BROADCAST_SET_TTL_MS, broadcastConversationIds, countConversations, decodeCursor,
  encodeCursor, INBOX_MATCH_CAP, InboxQueryTooBroadError, parseInboxQuery, PG_MAX_ROWS, queryInbox, searchConversations,
  type InboxFilter,
} from '../src/lib/whatsapp/conversation-search'
import { getInboxAccess } from '../src/lib/whatsapp/inbox-access'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`)
}

const S1 = 'store-1', S2 = 'store-2'
const AGENT = 'agent-1', OTHER = 'agent-2'
const ctx = { storeId: S1, userId: AGENT }
const T0 = Date.parse('2026-10-12T20:00:00.000Z')
const at = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString()

interface Seed { db: C1FakeDb; conv: (name: string) => Row; contact: (name: string) => Row }

/** 260 conversaciones en S1 (más que las 100 que antes cargaba la pantalla) + ruido en S2. */
function seed(): Seed {
  __resetInboxCaches()
  const db = new C1FakeDb()
  db.maxRows = PG_MAX_ROWS   // como Supabase: nunca más de 1000 filas por respuesta
  db.tables.wa_contacts = []; db.tables.wa_conversations = []; db.tables.orders = []
  db.tables.wa_broadcast_responses = []; db.tables.genesis_escalations = []; db.tables.wa_messages = []
  const contactsByName = new Map<string, Row>(), convsByName = new Map<string, Row>()
  const add = (store: string, name: string, phone: string, o: Partial<Row> = {}, orderNumber?: string, orderName?: string) => {
    let orderId: string | null = null
    if (orderNumber) {
      orderId = randomUUID()
      db.tables.orders.push({ id: orderId, store_id: store, order_number: orderNumber, customer_name: orderName ?? name, customer_phone: phone })
    }
    const c = { id: randomUUID(), store_id: store, phone_normalized: phone, display_name: name, order_id: orderId }
    db.tables.wa_contacts.push(c)
    const conv = { id: randomUUID(), store_id: store, contact_id: c.id, status: 'open', unread_count: 0, assigned_to: null,
      last_message_at: at(1), last_message_preview: 'hola', ai_enabled: false, ...o }
    db.tables.wa_conversations.push(conv)
    if (store === S1) { contactsByName.set(name, c); convsByName.set(name, conv) }
    return conv
  }
  for (let i = 0; i < 250; i++) add(S1, `Cliente ${i}`, `1809555${String(1000 + i)}`, { last_message_at: at(10 + i) })
  // Conversación antigua (posición ~250): solo se encuentra con búsqueda global.
  add(S1, 'Richard Alejandro', '18299816463', { last_message_at: at(60 * 24 * 90) }, '#9837')
  // Mismo número guardado en 10 dígitos (duplicado histórico).
  add(S1, 'Maria Diez', '8095550055', { last_message_at: at(5) })
  add(S1, 'Maria Once', '18095550055', { last_message_at: at(6) })
  // Nombre de perfil distinto al del pedido.
  add(S1, '~ M ~', '18497770001', { last_message_at: at(7) }, '#12001', 'Josefina Pérez')
  // Estados de atención.
  add(S1, 'Sin leer', '18291110001', { unread_count: 2, last_message_at: at(2) })
  add(S1, 'Leida campaña', '18291110002', { unread_count: 0, last_message_at: at(3) })
  add(S1, 'Escalada', '18291110003', { last_message_at: at(4) })
  add(S1, 'Atendida', '18291110004', { last_message_at: at(8) })
  add(S1, 'Mia', '18291110005', { assigned_to: AGENT, last_message_at: at(9) })
  add(S1, 'De otro', '18291110006', { assigned_to: OTHER, last_message_at: at(9.5) })
  // Sin actividad (last_message_at NULL) → al final.
  add(S1, 'Sin actividad A', '18291110007', { last_message_at: null })
  add(S1, 'Sin actividad B', '18291110008', { last_message_at: null })
  // Otra tienda: mismo nombre, mismo teléfono, mismo pedido.
  add(S2, 'Richard Alejandro', '18299816463', { last_message_at: at(1), unread_count: 5 }, '#9837')

  const id = (n: string) => convsByName.get(n)!.id
  db.tables.wa_broadcast_responses.push(
    { id: randomUUID(), store_id: S1, conversation_id: id('Leida campaña'), handled_at: null },
    { id: randomUUID(), store_id: S1, conversation_id: id('Atendida'), handled_at: at(1) },
  )
  db.tables.genesis_escalations.push(
    { id: randomUUID(), store_id: S1, conversation_id: id('Escalada'), status: 'open' },
    { id: randomUUID(), store_id: S1, conversation_id: id('Atendida'), status: 'resolved' },
  )
  for (const n of ['Leida campaña', 'Atendida', 'Cliente 3']) {
    db.tables.wa_messages.push({ id: randomUUID(), store_id: S1, conversation_id: id(n), direction: 'outbound', metadata: { broadcast_id: 'bc-1' } })
  }
  db.tables.wa_messages.push({ id: randomUUID(), store_id: S1, conversation_id: id('Cliente 4'), direction: 'outbound', metadata: { template_name: 'order_confirmation_cod' } })
  return { db, conv: n => convsByName.get(n)!, contact: n => contactsByName.get(n)! }
}

async function allPages(db: C1FakeDb, o: { q?: string; filter?: InboxFilter; limit?: number } = {}): Promise<{ ids: string[]; pages: number; totals: number[] }> {
  const ids: string[] = []; const totals: number[] = []
  let cursor: string | null = null; let pages = 0
  do {
    const p = await searchConversations(db as never, ctx, { ...o, cursor })
    ids.push(...p.data.map(r => r.id)); totals.push(p.total); cursor = p.next_cursor; pages++
  } while (cursor && pages < 50)
  return { ids, pages, totals }
}

async function main() {
  console.log('\n=== I1 — interpretación de la búsqueda ===')
  check('I1.1 texto corto (<2) → sin búsqueda', parseInboxQuery('a') === null && parseInboxQuery('  ') === null)
  check('I1.2 "#9837" → pedido', parseInboxQuery('#9837')?.order === '9837')
  const ph = parseInboxQuery('+1 (809) 555-0055')
  check('I1.3 teléfono con +1 y separadores → 10 dígitos', ph?.digits === '8095550055', ph)
  check('I1.4 teléfono parcial (4+ dígitos) también se busca como teléfono y como pedido', parseInboxQuery('0055')?.digits === '0055' && parseInboxQuery('0055')?.order === '0055')
  check('I1.5 comodines y separadores de PostgREST eliminados', parseInboxQuery('ri%c_h,a(r)d*')?.text === 'ri c h a r d')
  check('I1.6 texto con dígitos y letras → nombre', parseInboxQuery('Cliente 12')?.text === 'Cliente 12')

  console.log('\n=== I2 — búsqueda global (más allá de las primeras 100) ===')
  {
    const { db, conv } = seed()
    const r = await searchConversations(db as never, ctx, { q: 'Richard' })
    check('I2.1 nombre: encuentra la conversación antigua (posición >250)', r.data.length === 1 && r.data[0].id === conv('Richard Alejandro').id && r.total === 1, r)
    const byPhone = await searchConversations(db as never, ctx, { q: '829-981-6463' })
    check('I2.2 teléfono completo con separadores', byPhone.data.some(c => c.id === conv('Richard Alejandro').id))
    const partial = await searchConversations(db as never, ctx, { q: '6463' })
    check('I2.3 teléfono parcial', partial.data.some(c => c.id === conv('Richard Alejandro').id))
    const order = await searchConversations(db as never, ctx, { q: '#9837' })
    const orderPlain = await searchConversations(db as never, ctx, { q: '9837' })
    check('I2.4 número de pedido con y sin #', order.data.some(c => c.id === conv('Richard Alejandro').id) && orderPlain.data.some(c => c.id === conv('Richard Alejandro').id))
    const dup = await searchConversations(db as never, ctx, { q: '18095550055' })
    check('I2.5 formatos 10/11 dígitos: encuentra ambos contactos del mismo número', dup.data.length === 2 && dup.total === 2, dup.data.map(c => c.id))
    const byOrderName = await searchConversations(db as never, ctx, { q: 'Josefina' })
    check('I2.6 nombre del pedido (distinto del perfil de WhatsApp)', byOrderName.data.some(c => c.id === conv('~ M ~').id))
    const none = await searchConversations(db as never, ctx, { q: 'zzzz-nadie' })
    check('I2.7 sin coincidencias → vacío y total 0', none.data.length === 0 && none.total === 0 && none.next_cursor === null)
    check('I2.8 resultados con contacto embebido para la lista', (r.data[0] as Row).contact?.display_name === 'Richard Alejandro')
  }

  console.log('\n=== I3 — aislamiento por tienda ===')
  {
    const { db } = seed()
    const s2Ids = new Set(db.t('wa_conversations').filter(c => c.store_id === S2).map(c => c.id))
    const leaks: string[] = []
    for (const q of ['Richard', '6463', '#9837', '18299816463']) {
      const r = await searchConversations(db as never, ctx, { q })
      leaks.push(...r.data.filter(c => s2Ids.has(c.id)).map(c => c.id))
    }
    const all = await allPages(db)
    check('I3.1 búsqueda nunca devuelve conversaciones de otra tienda', leaks.length === 0, leaks)
    check('I3.2 listado completo solo de la tienda propia', all.ids.every(id => !s2Ids.has(id)))
    const counts = await countConversations(db as never, ctx)
    check('I3.3 contadores solo de la tienda propia (Sin leer no suma los 5 de otra tienda)', counts.unread === 1, counts)
  }

  console.log('\n=== I4 — paginación estable y total real ===')
  {
    const { db } = seed()
    const s1Total = db.t('wa_conversations').filter(c => c.store_id === S1).length
    const first = await searchConversations(db as never, ctx, { limit: 50 })
    check('I4.1 total = total real de la tienda, no lo cargado', first.total === s1Total && first.data.length === 50, { total: first.total, s1Total })
    const all = await allPages(db, { limit: 50 })
    check('I4.2 recorre todas las páginas sin duplicados ni huecos', all.ids.length === s1Total && new Set(all.ids).size === s1Total, { n: all.ids.length, pages: all.pages })
    const rows = all.ids.map(id => db.t('wa_conversations').find(c => c.id === id)!)
    const sorted = rows.every((r, i) => i === 0 || (() => {
      const p = rows[i - 1]
      if (p.last_message_at === null) return r.last_message_at === null
      return r.last_message_at === null || Date.parse(p.last_message_at) >= Date.parse(r.last_message_at)
    })())
    check('I4.3 orden por actividad reciente; sin actividad al final', sorted && rows.slice(-2).every(r => r.last_message_at === null))

    // Llega un mensaje mientras se pagina: la conversación sube al tope; la paginación no se rompe.
    const { db: db2 } = seed()
    const p1 = await searchConversations(db2 as never, ctx, { limit: 40 })
    const moved = db2.t('wa_conversations').find(c => c.id === (db2.t('wa_conversations').filter(x => x.store_id === S1)
      .sort((a, b) => Date.parse(a.last_message_at ?? '1970') - Date.parse(b.last_message_at ?? '1970'))[50].id))!
    moved.last_message_at = new Date(T0 + 60_000).toISOString()
    const seen = new Set(p1.data.map(r => r.id)); let cursor = p1.next_cursor; let dupes = 0
    while (cursor) {
      const p = await searchConversations(db2 as never, ctx, { limit: 40, cursor })
      for (const r of p.data) { if (seen.has(r.id)) dupes++; seen.add(r.id) }
      cursor = p.next_cursor
    }
    check('I4.4 mensaje nuevo durante la paginación: sin duplicados', dupes === 0)
    check('I4.5 cursor opaco válido / inválido ignorado', decodeCursor(encodeCursor({ lma: null, id: moved.id }))?.lma === null && decodeCursor('basura') === null)
    const big = await searchConversations(db as never, ctx, { limit: 9999 })
    check('I4.6 límite por página acotado a 100', big.data.length === 100)
  }

  console.log('\n=== I5 — estados de atención y filtros ===')
  {
    const { db, conv } = seed()
    const ids = async (filter: InboxFilter, q?: string) => (await allPages(db, { filter, q })).ids
    const unread = await ids('unread')
    check('I5.1 Sin leer = unread_count > 0', unread.length === 1 && unread[0] === conv('Sin leer').id, unread)
    const attention = await ids('attention')
    check('I5.2 Sin atender = respuesta de campaña sin atender + escalamiento abierto', attention.length === 2
      && attention.includes(conv('Leida campaña').id) && attention.includes(conv('Escalada').id), attention)
    check('I5.3 leída (unread 0) pero con gestión pendiente sigue en Sin atender', attention.includes(conv('Leida campaña').id) && conv('Leida campaña').unread_count === 0)
    check('I5.4 atendida (respuesta marcada + escalamiento resuelto) no aparece', !attention.includes(conv('Atendida').id))
    // Abrir la conversación = leer: pone unread en 0 pero NO la marca atendida.
    conv('Leida campaña').unread_count = 0
    check('I5.5 abrir/leer no cambia Sin atender', (await ids('attention')).includes(conv('Leida campaña').id))
    const bc = await ids('broadcast')
    check('I5.6 Campañas = recibieron un mensaje con broadcast_id', bc.length === 3 && !bc.includes(conv('Cliente 4').id), bc.length)
    const s1 = db.t('wa_conversations').filter(c => c.store_id === S1)
    const unassigned = await ids('unassigned')
    check('I5.7 Sin asignar', unassigned.length === s1.filter(c => !c.assigned_to).length && !unassigned.includes(conv('Mia').id))
    const mine = await ids('mine')
    check('I5.8 Asignados a mí (no los de otro agente)', mine.length === 1 && mine[0] === conv('Mia').id)
    const combo = await ids('attention', 'Escalada')
    const comboNone = await ids('unread', 'Richard')
    check('I5.9 búsqueda + filtro combinados', combo.length === 1 && combo[0] === conv('Escalada').id && comboNone.length === 0)
    const flags = await attentionFlags(db as never, S1, [conv('Leida campaña').id, conv('Escalada').id, conv('Atendida').id])
    check('I5.10 marcas por conversación para la lista', flags.get(conv('Leida campaña').id)?.broadcast === 1
      && flags.get(conv('Escalada').id)?.escalated === true && !flags.has(conv('Atendida').id))
  }

  console.log('\n=== I6 — contadores reales ===')
  {
    const { db } = seed()
    const c = await countConversations(db as never, ctx)
    const s1 = db.t('wa_conversations').filter(x => x.store_id === S1)
    check('I6.1 contadores por filtro', c.all === s1.length && c.unread === 1 && c.attention === 2 && c.broadcast === 3
      && c.unassigned === s1.filter(x => !x.assigned_to).length && c.mine === 1, c)
    const cq = await countConversations(db as never, ctx, '0055')
    check('I6.2 contadores respetan la búsqueda activa', cq.all === 2 && cq.unread === 0, cq)
    for (const f of ['all', 'unread', 'attention', 'broadcast', 'unassigned', 'mine'] as InboxFilter[]) {
      const p = await searchConversations(db as never, ctx, { filter: f, limit: 10 })
      if (p.total !== c[f]) check(`I6.3 total de la lista = contador (${f})`, false, { total: p.total, count: c[f] })
    }
    check('I6.3 total de cada lista coincide con su contador', true)
  }

  console.log('\n=== I7 — consultas acotadas ===')
  {
    const { db } = seed()
    // Más de 100 ids en el conjunto: se consulta por bloques (sin listas IN gigantes).
    for (const c of db.t('wa_conversations').filter(x => x.store_id === S1).slice(0, 180)) {
      db.tables.wa_broadcast_responses.push({ id: randomUUID(), store_id: S1, conversation_id: c.id, handled_at: null })
    }
    db.log = []
    const all = await allPages(db, { filter: 'attention', limit: 50 })
    const longIn = db.log.length
    check('I7.1 conjunto grande (>100 ids) paginado por bloques, sin duplicados', all.ids.length === new Set(all.ids).size && all.ids.length >= 180, { n: all.ids.length, queries: longIn })
    // Búsqueda demasiado amplia → error claro, no una consulta sin límite.
    __resetInboxCaches()
    for (let i = 0; i <= INBOX_MATCH_CAP; i++) db.tables.wa_contacts.push({ id: randomUUID(), store_id: S1, phone_normalized: `1849${String(i).padStart(7, '0')}`, display_name: 'Amplio' })
    let tooBroad = false
    try { await searchConversations(db as never, ctx, { q: 'Amplio' }) } catch (e) { tooBroad = e instanceof InboxQueryTooBroadError }
    check('I7.2 búsqueda demasiado amplia → pide afinar', tooBroad)
  }

  console.log('\n=== I8 — permisos ===')
  {
    const mk = (user: string | null, profile: Row | null) => ({
      auth: { getUser: async () => ({ data: { user: user ? { id: user } : null } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile }) }) }) }),
    })
    const ok = await getInboxAccess(mk('u1', { role: 'confirmation_agent', store_id: S1, is_active: true }))
    check('I8.1 rol del Inbox → acceso con store_id del perfil', ok.ok && ok.ctx.storeId === S1 && ok.ctx.userId === 'u1')
    const noUser = await getInboxAccess(mk(null, null))
    check('I8.2 sin sesión → 401', !noUser.ok && noUser.status === 401)
    for (const role of ['viewer', 'santo_domingo_delivery_agent']) {
      const r = await getInboxAccess(mk('u2', { role, store_id: S1, is_active: true }))
      check(`I8.3 ${role} → 403`, !r.ok && r.status === 403)
    }
    const inactive = await getInboxAccess(mk('u3', { role: 'admin', store_id: S1, is_active: false }))
    const noStore = await getInboxAccess(mk('u4', { role: 'admin', store_id: null, is_active: true }))
    check('I8.4 perfil inactivo o sin tienda → 403', !inactive.ok && !noStore.ok)
    const route = readFileSync('src/app/api/whatsapp/conversations/route.ts', 'utf8')
    const countsRoute = readFileSync('src/app/api/whatsapp/conversations/counts/route.ts', 'utf8')
    check('I8.5 rutas usan la sesión (RLS) + verificación de acceso; nunca service role',
      [route, countsRoute].every(s => /getInboxAccess\(supabase\)/.test(s) && /createClient\(\)/.test(s) && !/ServiceClient/.test(s)))
    const page = readFileSync('src/app/(app)/inbox/page.tsx', 'utf8')
    check('I8.6 la pantalla ya no limita a las primeras 100 ni filtra en el cliente', !/limit=100/.test(page) && /listUrl\(/.test(page))
  }


  console.log('\n=== I9 — rendimiento: consultas acotadas y sin repetir ===')
  {
    const reads = (db: C1FakeDb, table?: string) => db.log.filter(l => l.op === 'select' && (!table || l.table === table)).length
    const { db } = seed()
    // Contadores sin búsqueda: 3 COUNT HEAD + Sin atender (2) + Campañas (1). Ningún recorrido por filtro.
    db.log = []
    await countConversations(db as never, ctx)
    const c1 = reads(db)
    check('I9.1 contadores sin búsqueda: ≤ 7 consultas', c1 <= 7, c1)
    // Segunda vez dentro del TTL: el conjunto de Campañas no se relee.
    db.log = []
    await countConversations(db as never, ctx)
    check('I9.2 conjunto de Campañas en caché (TTL): no relee wa_messages', reads(db, 'wa_messages') === 0, db.log)
    // Lista + contadores en una sola petición comparten consultas.
    __resetInboxCaches(); db.log = []
    await queryInbox(db as never, ctx, { withCounts: true })
    const combined = reads(db)
    check('I9.3 primera página + contadores (sin búsqueda): ≤ 8 consultas y wa_messages leído 1 vez', combined <= 8 && reads(db, 'wa_messages') === 1, { combined, log: db.log })
    // Búsqueda + contadores: las conversaciones de los contactos se leen UNA vez para página y contadores.
    __resetInboxCaches(); db.log = []
    const r = await queryInbox(db as never, ctx, { q: 'Richard', withCounts: true })
    const convReads = reads(db, 'wa_conversations')
    check('I9.4 búsqueda + contadores: wa_conversations leído 2 veces (candidatas + filas de la página)', convReads === 2 && r.counts?.all === 1, { convReads, counts: r.counts })
    // Filtro Campañas: el conjunto se lee una vez por solicitud y las candidatas por bloques.
    __resetInboxCaches(); db.log = []
    await queryInbox(db as never, ctx, { filter: 'broadcast', withCounts: true })
    check('I9.5 Campañas + contadores: wa_messages leído 1 vez', reads(db, 'wa_messages') === 1, db.log)
    // Página siguiente dentro del TTL: no relee el conjunto.
    db.log = []
    await queryInbox(db as never, ctx, { filter: 'broadcast' })
    check('I9.6 página siguiente de Campañas: usa la caché', reads(db, 'wa_messages') === 0)
    check('I9.7 caché por tienda con caducidad', BROADCAST_SET_TTL_MS === 30_000)
    // Sin atender NUNCA usa caché: "Marcar atendida" se refleja al instante.
    const target = db.t('wa_broadcast_responses').find(x => x.handled_at === null)!
    target.handled_at = at(0)
    const after = await countConversations(db as never, ctx)
    check('I9.8 Sin atender refleja "Marcar atendida" de inmediato (sin caché)', after.attention === 1, after)
  }

  console.log('\n=== I10 — sin truncar en el límite de 1000 filas de PostgREST ===')
  {
    const { db } = seed()
    // 1500 mensajes de campaña en 750 conversaciones nuevas.
    for (let i = 0; i < 750; i++) {
      const cid = randomUUID(), conv = randomUUID()
      db.tables.wa_contacts.push({ id: cid, store_id: S1, phone_normalized: `1849${String(2000000 + i)}`, display_name: `Campaña ${i}` })
      db.tables.wa_conversations.push({ id: conv, store_id: S1, contact_id: cid, status: 'open', unread_count: 0, assigned_to: null, last_message_at: at(30 + i) })
      for (const n of [0, 1]) db.tables.wa_messages.push({ id: randomUUID(), store_id: S1, conversation_id: conv, direction: 'outbound', metadata: { broadcast_id: `bc-${n}` } })
    }
    const set = await broadcastConversationIds(db as never, S1)
    check('I10.1 conjunto de Campañas completo aunque haya >1000 mensajes', set.size === 753, set.size)
    const counts = await countConversations(db as never, ctx)
    check('I10.2 contador de Campañas correcto', counts.broadcast === 753, counts)
    const pages = await allPages(db, { filter: 'broadcast', limit: 100 })
    check('I10.3 lista de Campañas completa, paginada, sin duplicados', pages.ids.length === 753 && new Set(pages.ids).size === 753, pages.ids.length)
  }

  console.log('\n=== I11 — scroll infinito (interfaz) ===')
  {
    const list = readFileSync('src/components/whatsapp/WaConversationList.tsx', 'utf8')
    const page = readFileSync('src/app/(app)/inbox/page.tsx', 'utf8')
    check('I11.1 carga automática al acercarse al final (IntersectionObserver con margen)', /new IntersectionObserver/.test(list) && /rootMargin/.test(list) && /LOAD_AHEAD_PX/.test(list))
    check('I11.2 "Cargar más" se mantiene como alternativa manual', /Cargar más/.test(list) && /onClick=\{onLoadMore\}/.test(list))
    check('I11.3 sin peticiones duplicadas: una a la vez y nunca el mismo cursor dos veces',
      /loadingMoreRef\.current/.test(page) && /requestedCursors\.current\.has\(cursor\)/.test(page))
    check('I11.4 sin repetidas al anexar (deduplicación por id)', /filter\(c => !seen\.has\(c\.id\)\)/.test(page))
    check('I11.5 posición estable: anclaje con mediana y scroll arriba al cambiar búsqueda/filtro',
      /deltas\[Math\.floor\(deltas\.length \/ 2\)\]/.test(list) && /resetKey/.test(list) && /\[overflow-anchor:none\]/.test(list))
    check('I11.6 respeta búsqueda y filtro activos (cursor con la misma búsqueda/filtro)', /listUrl\(searchQRef\.current, filterRef\.current, cursor\)/.test(page))
    check('I11.7 una página por vez (no todo de golpe): el observador se desconecta mientras carga', /if \(!root \|\| !target \|\| !hasMore \|\| loading \|\| loadingMore\) return/.test(list))
    check('I11.8 respuestas viejas descartadas al cambiar de búsqueda (secuencia)', /seq !== requestSeq\.current/.test(page))
  }

  console.log(failures === 0 ? '\n✅ TODO OK' : `\n❌ ${failures} FALLOS`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
