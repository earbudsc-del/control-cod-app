// Inbox WhatsApp — búsqueda global, filtros y paginación del lado del servidor.
//
// SERVER-ONLY. Reemplaza el "primeras 100 + filtro en el cliente": cualquier
// conversación de la tienda se encuentra por nombre, teléfono (completo o
// parcial, normalizado) o número de pedido, combinable con un filtro.
//
// Aislamiento: el cliente de Supabase es el de la sesión (RLS: tienda + rol
// de Inbox) y además cada consulta filtra store_id explícitamente.
//
// Estados de atención — fuentes de verdad EXISTENTES (sin estado ni tabla nueva):
//   Sin leer    → wa_conversations.unread_count > 0. El webhook lo suma por cada
//                 entrante; abrir la conversación lo pone en 0 (= leído).
//   Sin atender → gestión pendiente aunque ya se haya leído:
//                 · wa_broadcast_responses.handled_at IS NULL (respuesta de campaña),
//                 · genesis_escalations.status = 'open' (escalamiento a humano).
//                 Abrir la conversación NO lo resuelve: solo "Marcar atendida"
//                 (handled_at) o resolver el escalamiento.
//   Atendida    → tuvo gestión y ya no queda ninguna pendiente (derivado).
//
// Orden: last_message_at DESC NULLS LAST, id DESC. Paginación por cursor
// (keyset): estable aunque lleguen mensajes nuevos mientras se pagina.

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const INBOX_FILTERS = ['all', 'unread', 'attention', 'broadcast', 'unassigned', 'mine'] as const
export type InboxFilter = typeof INBOX_FILTERS[number]

export const INBOX_PAGE_SIZE = 50
export const INBOX_PAGE_SIZE_MAX = 100
// PostgREST (Supabase) devuelve como máximo 1000 filas por respuesta aunque se
// pida más: toda lectura que pueda superar ese número se pagina con range() y
// todo tope se detecta (nunca un resultado truncado en silencio).
export const PG_MAX_ROWS = 1000
// Contactos que puede devolver una búsqueda: menos que PG_MAX_ROWS para que la
// fila extra (+1) detecte "demasiados" en UNA consulta.
export const INBOX_MATCH_CAP = 900
// Conversaciones candidatas de un filtro por conjunto (Sin atender / Campañas).
export const INBOX_SET_CAP = 5000
// Filas leídas como máximo para armar un conjunto (p. ej. mensajes de campaña).
export const INBOX_SCAN_CAP = 50_000
// Listas IN por bloques: una URL de PostgREST con cientos de UUID se vuelve
// demasiado larga.
const ID_CHUNK = 100
// El conjunto "recibió campaña" solo cambia cuando sale un envío: se reutiliza
// unos segundos por instancia para no releer los mensajes en cada refresco.
export const BROADCAST_SET_TTL_MS = 30_000
export const INBOX_QUERY_MAX = 80

export const CONVERSATION_COLUMNS = `id, status, unread_count, last_message_at, last_message_preview,
         assigned_to, ai_enabled, created_at, updated_at,
         contact:wa_contacts(id, phone_normalized, display_name, wa_id, order_id),
         assigned_agent:profiles(id, full_name)`

export interface InboxSearchContext { storeId: string; userId: string }

export interface InboxCursor { lma: string | null; id: string }

export interface ParsedQuery {
  text:   string | null   // nombre (sin comodines de PostgREST)
  digits: string | null   // teléfono parcial/completo, normalizado
  order:  string | null   // número de pedido candidato (solo dígitos)
}

export class InboxQueryTooBroadError extends Error {}

export function parseInboxFilter(v: unknown): InboxFilter {
  return (INBOX_FILTERS as readonly unknown[]).includes(v) ? v as InboxFilter : 'all'
}

/**
 * Texto libre → criterios. "#9177" / "9177" → pedido (y teléfono parcial si
 * tiene ≥4 dígitos). Teléfonos: se quitan separadores y el prefijo 1 de un
 * número NANP de 11 dígitos, para que 809… y 1809… encuentren lo mismo.
 */
export function parseInboxQuery(raw: unknown): ParsedQuery | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const q = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, INBOX_QUERY_MAX)
  if (q.length < 2) return null
  const onlyDigits = q.replace(/\D/g, '')
  const looksNumeric = /^[\s#+()\-.\d]+$/.test(q)
  let digits: string | null = null
  let order: string | null = null
  if (looksNumeric && onlyDigits.length > 0) {
    let d = onlyDigits
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1)
    if (d.length >= 4) digits = d
    if (onlyDigits.length >= 3 && onlyDigits.length <= 7) order = onlyDigits
  }
  // Nombre: sin comodines ni separadores de la sintaxis de filtros de PostgREST.
  const text = looksNumeric ? null : q.replace(/[%_*\\,()]/g, ' ').replace(/\s+/g, ' ').trim() || null
  if (!text && !digits && !order) return null
  return { text, digits, order }
}

/** Últimos 10 dígitos de un teléfono (NANP), o null. */
function last10(phone: string | null | undefined): string | null {
  const d = String(phone ?? '').replace(/\D/g, '')
  return d.length >= 10 ? d.slice(-10) : null
}

function addAll(set: Set<string>, rows: Array<{ id: string }> | null | undefined) {
  for (const r of rows ?? []) set.add(r.id)
}

function capCheck(set: Set<string>, cap = INBOX_MATCH_CAP) {
  if (set.size > cap) throw new InboxQueryTooBroadError('Demasiados resultados — afina la búsqueda')
}

/** Lee todas las filas de una consulta en páginas de PG_MAX_ROWS (orden estable por id). */
async function readAll<T>(build: () => any, label: string, maxRows = INBOX_SCAN_CAP): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = []
  for (let from = 0; ; from += PG_MAX_ROWS) {
    const { data, error } = await build().order('id', { ascending: true }).range(from, from + PG_MAX_ROWS - 1)
    if (error) throw new Error(`${label}: ${error.message ?? String(error)}`)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (out.length > maxRows) throw new InboxQueryTooBroadError('Demasiados resultados — afina la búsqueda')
    if (rows.length < PG_MAX_ROWS) return out
  }
}

async function contactsByPhones(db: SupabaseLike, storeId: string, phones10: string[], into: Set<string>) {
  const variants = [...new Set(phones10.flatMap(p => [p, `1${p}`]))]
  for (let i = 0; i < variants.length; i += 100) {
    const { data, error } = await db.from('wa_contacts').select('id')
      .eq('store_id', storeId).in('phone_normalized', variants.slice(i, i + 100))
    if (error) throw new Error(`wa_contacts(phones): ${error.message ?? String(error)}`)
    addAll(into, data)
  }
}

/** Contactos de la tienda que coinciden con la búsqueda (null = sin búsqueda). */
export async function resolveSearchContacts(db: SupabaseLike, storeId: string, q: ParsedQuery | null): Promise<Set<string> | null> {
  if (!q) return null
  const ids = new Set<string>()

  if (q.text) {
    const like = `%${q.text}%`
    // Nombre del perfil de WhatsApp.
    const { data: byName, error: e1 } = await db.from('wa_contacts').select('id')
      .eq('store_id', storeId).ilike('display_name', like).limit(INBOX_MATCH_CAP + 1)
    if (e1) throw new Error(`wa_contacts(name): ${e1.message ?? String(e1)}`)
    addAll(ids, byName)
    // Nombre del pedido (puede diferir del perfil de WhatsApp) → por teléfono / pedido vinculado.
    const { data: orders, error: e2 } = await db.from('orders').select('id, customer_phone')
      .eq('store_id', storeId).ilike('customer_name', like)
      .order('created_at', { ascending: false }).limit(200)   // los 200 pedidos más recientes con ese nombre
    if (e2) throw new Error(`orders(name): ${e2.message ?? String(e2)}`)
    await linkOrders(db, storeId, (orders ?? []) as Array<{ id: string; customer_phone: string | null }>, ids)
  }

  if (q.digits) {
    const { data, error } = await db.from('wa_contacts').select('id')
      .eq('store_id', storeId).ilike('phone_normalized', `%${q.digits}%`).limit(INBOX_MATCH_CAP + 1)
    if (error) throw new Error(`wa_contacts(phone): ${error.message ?? String(error)}`)
    addAll(ids, data)
  }

  if (q.order) {
    const { data, error } = await db.from('orders').select('id, customer_phone')
      .eq('store_id', storeId).in('order_number', [`#${q.order}`, q.order]).limit(20)
    if (error) throw new Error(`orders(number): ${error.message ?? String(error)}`)
    await linkOrders(db, storeId, (data ?? []) as Array<{ id: string; customer_phone: string | null }>, ids)
  }

  capCheck(ids)
  return ids
}

async function linkOrders(db: SupabaseLike, storeId: string, orders: Array<{ id: string; customer_phone: string | null }>, into: Set<string>) {
  if (orders.length === 0) return
  const orderIds = orders.map(o => o.id)
  for (let i = 0; i < orderIds.length; i += 100) {
    const { data, error } = await db.from('wa_contacts').select('id')
      .eq('store_id', storeId).in('order_id', orderIds.slice(i, i + 100))
    if (error) throw new Error(`wa_contacts(order): ${error.message ?? String(error)}`)
    addAll(into, data)
  }
  const phones = orders.map(o => last10(o.customer_phone)).filter((p): p is string => !!p)
  if (phones.length) await contactsByPhones(db, storeId, phones, into)
}

/** Conversaciones con gestión pendiente (Sin atender), según las fuentes existentes. Sin caché: debe reflejar "Marcar atendida" al instante. */
export async function attentionConversationIds(db: SupabaseLike, storeId: string): Promise<Set<string>> {
  const ids = new Set<string>()
  const r = await readAll<{ conversation_id: string }>(() => db.from('wa_broadcast_responses').select('id, conversation_id')
    .eq('store_id', storeId).is('handled_at', null), 'wa_broadcast_responses(attention)')
  for (const x of r) ids.add(x.conversation_id)
  const g = await readAll<{ conversation_id: string }>(() => db.from('genesis_escalations').select('id, conversation_id')
    .eq('store_id', storeId).eq('status', 'open'), 'genesis_escalations(attention)')
  for (const x of g) ids.add(x.conversation_id)
  return ids
}

const broadcastSetCache = new Map<string, { at: number; ids: Set<string> }>()

/** Solo para pruebas: vacía la caché por instancia del conjunto de campañas. */
export function __resetInboxCaches() { broadcastSetCache.clear() }

/**
 * Conversaciones que recibieron una campaña de Broadcast (mensaje saliente con
 * broadcast_id). Se lee paginado (sin truncar en 1000) y se reutiliza
 * BROADCAST_SET_TTL_MS por instancia y tienda.
 */
export async function broadcastConversationIds(db: SupabaseLike, storeId: string, nowMs = Date.now()): Promise<Set<string>> {
  const hit = broadcastSetCache.get(storeId)
  if (hit && nowMs - hit.at < BROADCAST_SET_TTL_MS) return hit.ids
  const rows = await readAll<{ conversation_id: string }>(() => db.from('wa_messages').select('id, conversation_id')
    .eq('store_id', storeId).eq('direction', 'outbound').not('metadata->>broadcast_id', 'is', null), 'wa_messages(broadcast)')
  const ids = new Set(rows.map(x => x.conversation_id))
  broadcastSetCache.set(storeId, { at: nowMs, ids })
  return ids
}

interface Scope { contactIds: Set<string> | null; convIds: Set<string> | null; filter: InboxFilter }

/**
 * Estado de UNA solicitud: cada conjunto (contactos buscados, Sin atender,
 * Campañas, filas ligeras de la búsqueda) se consulta como mucho una vez y lo
 * reutilizan la página y los contadores.
 */
class InboxRequest {
  private attention?: Promise<Set<string>>
  private broadcast?: Promise<Set<string>>
  private searchLite?: Promise<LiteRow[]>
  constructor(readonly db: SupabaseLike, readonly ctx: InboxSearchContext, readonly contactIds: Set<string> | null) {}

  attentionIds() { return (this.attention ??= attentionConversationIds(this.db, this.ctx.storeId)) }
  broadcastIds() { return (this.broadcast ??= broadcastConversationIds(this.db, this.ctx.storeId)) }
  async convIdsFor(filter: InboxFilter): Promise<Set<string> | null> {
    const ids = filter === 'attention' ? await this.attentionIds() : filter === 'broadcast' ? await this.broadcastIds() : null
    if (ids) capCheck(ids, INBOX_SET_CAP)
    return ids
  }
  /** Filas ligeras de TODAS las conversaciones de los contactos buscados (una sola lectura por bloques). */
  searchRows(): Promise<LiteRow[]> {
    return (this.searchLite ??= liteRowsBy(this.db, this.ctx, 'contact_id', [...this.contactIds!]))
  }
}

async function buildScope(req: InboxRequest, filter: InboxFilter): Promise<Scope> {
  return { contactIds: req.contactIds, convIds: await req.convIdsFor(filter), filter }
}

function isEmptyScope(s: Scope): boolean {
  return (s.contactIds !== null && s.contactIds.size === 0) || (s.convIds !== null && s.convIds.size === 0)
}

/** Filtros simples (columnas de wa_conversations) sobre una consulta. */
function applyColumnFilter(qb: any, ctx: InboxSearchContext, filter: InboxFilter): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  let q = qb.eq('store_id', ctx.storeId)
  if (filter === 'unread') q = q.gt('unread_count', 0)
  if (filter === 'unassigned') q = q.is('assigned_to', null)
  if (filter === 'mine') q = q.eq('assigned_to', ctx.userId)
  return q
}

function matchesColumnFilter(r: LiteRow, ctx: InboxSearchContext, filter: InboxFilter): boolean {
  if (filter === 'unread') return (r.unread_count ?? 0) > 0
  if (filter === 'unassigned') return r.assigned_to == null
  if (filter === 'mine') return r.assigned_to === ctx.userId
  return true
}

export function encodeCursor(c: InboxCursor): string {
  return Buffer.from(JSON.stringify([c.lma, c.id]), 'utf8').toString('base64url')
}

export function decodeCursor(raw: unknown): InboxCursor | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (!Array.isArray(v) || v.length !== 2) return null
    const [lma, id] = v
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null
    if (lma !== null && (typeof lma !== 'string' || Number.isNaN(Date.parse(lma)))) return null
    return { lma, id }
  } catch {
    return null
  }
}

type ConvRow = { id: string; last_message_at: string | null; [k: string]: unknown }
type LiteRow = { id: string; contact_id: string; last_message_at: string | null; unread_count: number | null; assigned_to: string | null }

/** Orden canónico: last_message_at DESC NULLS LAST, id DESC. */
export function compareConversations(a: { id: string; last_message_at: string | null }, b: { id: string; last_message_at: string | null }): number {
  const ta = a.last_message_at ? Date.parse(a.last_message_at) : null
  const tb = b.last_message_at ? Date.parse(b.last_message_at) : null
  if (ta !== tb) {
    if (ta === null) return 1
    if (tb === null) return -1
    return tb - ta
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** ¿La fila va estrictamente después del cursor en el orden canónico? */
function afterCursor(r: { id: string; last_message_at: string | null }, c: InboxCursor): boolean {
  return compareConversations({ id: c.id, last_message_at: c.lma }, r) < 0
}

export interface InboxPage {
  data:        ConvRow[]
  next_cursor: string | null
  total:       number            // total real de la búsqueda + filtro (no lo cargado)
}

const LITE_COLUMNS = 'id, contact_id, last_message_at, unread_count, assigned_to'

async function liteRowsBy(db: SupabaseLike, ctx: InboxSearchContext, col: 'id' | 'contact_id', keys: string[]): Promise<LiteRow[]> {
  const rows: LiteRow[] = []
  for (let i = 0; i < keys.length; i += ID_CHUNK) {
    const { data, error } = await db.from('wa_conversations').select(LITE_COLUMNS)
      .eq('store_id', ctx.storeId).in(col, keys.slice(i, i + ID_CHUNK))
    if (error) throw new Error(`wa_conversations(candidates): ${error.message ?? String(error)}`)
    rows.push(...((data ?? []) as LiteRow[]))
  }
  return rows
}

/**
 * Candidatas de un alcance por conjunto (búsqueda / Sin atender / Campañas):
 * columnas ligeras por bloques, filtro y orden en memoria. Con búsqueda se
 * parte de las filas de los contactos encontrados (leídas una sola vez) y el
 * filtro por conjunto se aplica en memoria.
 */
async function liteCandidates(req: InboxRequest, s: Scope): Promise<LiteRow[]> {
  const rows = s.contactIds !== null
    ? (await req.searchRows()).filter(r => !s.convIds || s.convIds.has(r.id))
    : await liteRowsBy(req.db, req.ctx, 'id', [...s.convIds!])
  return rows.filter(r => matchesColumnFilter(r, req.ctx, s.filter)).sort(compareConversations)
}

async function fullRows(db: SupabaseLike, storeId: string, ids: string[]): Promise<ConvRow[]> {
  if (ids.length === 0) return []
  const { data, error } = await db.from('wa_conversations').select(CONVERSATION_COLUMNS).eq('store_id', storeId).in('id', ids)
  if (error) throw new Error(`wa_conversations(rows): ${error.message ?? String(error)}`)
  const byId = new Map(((data ?? []) as ConvRow[]).map(r => [r.id, r]))
  return ids.map(id => byId.get(id)).filter((r): r is ConvRow => !!r)
}

export interface InboxQueryResult extends InboxPage {
  counts?: Record<InboxFilter, number>
}

/**
 * Una página de conversaciones (y, si se pide, los contadores de todos los
 * filtros) resolviendo búsqueda y conjuntos UNA sola vez.
 * Sin búsqueda ni filtro por conjunto → keyset directo en la DB, en tramos (sin OR):
 *   1) mismo last_message_at que el cursor con id menor; 2) last_message_at
 *   menor; 3) last_message_at NULL (al final), por id.
 * Con búsqueda / Sin atender / Campañas → candidatas ligeras (liteCandidates).
 */
export async function queryInbox(
  db: SupabaseLike, ctx: InboxSearchContext,
  o: { q?: unknown; filter?: unknown; cursor?: unknown; limit?: unknown; withCounts?: boolean; pageless?: boolean } = {},
): Promise<InboxQueryResult> {
  const filter = parseInboxFilter(o.filter)
  const req = new InboxRequest(db, ctx, await resolveSearchContacts(db, ctx.storeId, parseInboxQuery(o.q)))
  const page = o.pageless ? { data: [], next_cursor: null, total: 0 } : await pageFor(req, filter, o)
  if (!o.withCounts) return page
  return { ...page, counts: await countsFor(req, o.pageless ? null : { filter, total: page.total }) }
}

async function pageFor(req: InboxRequest, filter: InboxFilter, o: { cursor?: unknown; limit?: unknown }): Promise<InboxPage> {
  const { db, ctx } = req
  const scope = await buildScope(req, filter)
  const limit = Math.min(Math.max(1, Math.floor(Number(o.limit) || INBOX_PAGE_SIZE)), INBOX_PAGE_SIZE_MAX)
  const cursor = decodeCursor(o.cursor)
  if (isEmptyScope(scope)) return { data: [], next_cursor: null, total: 0 }

  if (scope.contactIds !== null || scope.convIds !== null) {
    const all = await liteCandidates(req, scope)
    const rest = cursor ? all.filter(r => afterCursor(r, cursor)) : all
    const pageLite = rest.slice(0, limit)
    const last = pageLite[pageLite.length - 1]
    return {
      data: await fullRows(db, ctx.storeId, pageLite.map(r => r.id)),
      next_cursor: rest.length > limit && last ? encodeCursor({ lma: last.last_message_at, id: last.id }) : null,
      total: all.length,
    }
  }

  const base = () => applyColumnFilter(db.from('wa_conversations').select(CONVERSATION_COLUMNS), ctx, filter)
  const run = async (qb: any, n: number): Promise<ConvRow[]> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (n <= 0) return []
    const { data, error } = await qb.limit(n)
    if (error) throw new Error(`wa_conversations(page): ${error.message ?? String(error)}`)
    return (data ?? []) as ConvRow[]
  }
  const want = limit + 1          // una fila de más para saber si hay página siguiente
  const out: ConvRow[] = []
  if (!cursor || cursor.lma !== null) {
    if (cursor) out.push(...await run(base().eq('last_message_at', cursor.lma).lt('id', cursor.id).order('id', { ascending: false }), want))
    const older = base().not('last_message_at', 'is', null)
    out.push(...await run((cursor ? older.lt('last_message_at', cursor.lma) : older)
      .order('last_message_at', { ascending: false }).order('id', { ascending: false }), want - out.length))
  }
  if (out.length < want) {
    const nulls = base().is('last_message_at', null)
    out.push(...await run((cursor?.lma === null ? nulls.lt('id', cursor.id) : nulls).order('id', { ascending: false }), want - out.length))
  }
  const page = out.slice(0, limit)
  const last = page[page.length - 1]
  return {
    data: page,
    next_cursor: out.length > limit && last ? encodeCursor({ lma: last.last_message_at, id: last.id }) : null,
    total: await headCount(req, filter),
  }
}

async function headCount(req: InboxRequest, filter: InboxFilter): Promise<number> {
  const { count, error } = await applyColumnFilter(req.db.from('wa_conversations').select('id', { count: 'exact', head: true }), req.ctx, filter)
  if (error) throw new Error(`wa_conversations(count ${filter}): ${error.message ?? String(error)}`)
  return typeof count === 'number' ? count : 0
}

/**
 * Contadores reales de todos los filtros.
 *   Con búsqueda: todo en memoria sobre las filas ligeras de los contactos
 *     encontrados (ya leídas para la página) — 0 consultas extra por filtro.
 *   Sin búsqueda: un COUNT HEAD por filtro de columna (reutilizando el total de
 *     la página si ya se calculó); Sin atender / Campañas = tamaño del conjunto
 *     (sus tablas ya están filtradas por tienda y referencian conversaciones existentes).
 */
async function countsFor(req: InboxRequest, known: { filter: InboxFilter; total: number } | null): Promise<Record<InboxFilter, number>> {
  const [attention, broadcast] = await Promise.all([req.attentionIds(), req.broadcastIds()])
  if (req.contactIds !== null) {
    const rows = req.contactIds.size === 0 ? [] : await req.searchRows()
    const n = (pred: (r: LiteRow) => boolean) => rows.filter(pred).length
    return {
      all:        rows.length,
      unread:     n(r => (r.unread_count ?? 0) > 0),
      attention:  n(r => attention.has(r.id)),
      broadcast:  n(r => broadcast.has(r.id)),
      unassigned: n(r => r.assigned_to == null),
      mine:       n(r => r.assigned_to === req.ctx.userId),
    }
  }
  const column = ['all', 'unread', 'unassigned', 'mine'] as const
  const values = await Promise.all(column.map(f => (known && known.filter === f ? known.total : headCount(req, f))))
  const out = Object.fromEntries(column.map((f, i) => [f, values[i]])) as Record<InboxFilter, number>
  out.attention = attention.size
  out.broadcast = broadcast.size
  return out
}

/** Una página de conversaciones (compatibilidad: sin contadores). */
export async function searchConversations(
  db: SupabaseLike, ctx: InboxSearchContext,
  o: { q?: unknown; filter?: unknown; cursor?: unknown; limit?: unknown } = {},
): Promise<InboxPage> {
  const { counts: _c, ...page } = await queryInbox(db, ctx, o) // eslint-disable-line @typescript-eslint/no-unused-vars
  return page
}

/** Contadores reales por filtro para la búsqueda actual (no lo cargado en pantalla). */
export async function countConversations(db: SupabaseLike, ctx: InboxSearchContext, rawQ?: unknown): Promise<Record<InboxFilter, number>> {
  return (await queryInbox(db, ctx, { q: rawQ, withCounts: true, pageless: true })).counts!
}

/** Marca de "Sin atender" por conversación para una página ya cargada. */
export async function attentionFlags(db: SupabaseLike, storeId: string, convIds: string[]): Promise<Map<string, { broadcast: number; escalated: boolean }>> {
  const out = new Map<string, { broadcast: number; escalated: boolean }>()
  if (convIds.length === 0) return out
  const get = (id: string) => out.get(id) ?? (out.set(id, { broadcast: 0, escalated: false }), out.get(id)!)
  const { data: r } = await db.from('wa_broadcast_responses').select('conversation_id')
    .eq('store_id', storeId).in('conversation_id', convIds).is('handled_at', null)
  for (const x of (r ?? []) as Array<{ conversation_id: string }>) get(x.conversation_id).broadcast++
  const { data: g } = await db.from('genesis_escalations').select('conversation_id')
    .eq('store_id', storeId).in('conversation_id', convIds).eq('status', 'open')
  for (const x of (g ?? []) as Array<{ conversation_id: string }>) get(x.conversation_id).escalated = true
  return out
}
