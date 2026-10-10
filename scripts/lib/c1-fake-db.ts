// DB en memoria para los tests de Sprint C.1 (Broadcast operativo + Inbox).
// Emula el subconjunto de PostgREST que usan launch/processor/responses/
// metrics/inbox-context, incluidos los UNIQUE e índices parciales de
// 033/064/065/066 (un 23505 se devuelve igual que en Postgres).
// Sin red, sin DB real.

import { randomUUID } from 'node:crypto'

export type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Op = 'eq' | 'neq' | 'in' | 'is' | 'not_is' | 'gte' | 'lt' | 'lte' | 'match'
type Filter = { op: Op; col: string; val: unknown }

function getPath(row: Row, col: string): unknown {
  const m = col.match(/^(\w+)->>(\w+)$/)
  if (m) { const obj = row[m[1]]; return obj == null ? null : (obj[m[2]] ?? null) }
  return row[col]
}

function cmp(a: unknown, b: unknown): number {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN, tb = typeof b === 'string' ? Date.parse(b) : NaN
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && /\d{4}-\d{2}-\d{2}/.test(String(a))) return ta - tb
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

interface Unique { cols: string[]; where?: (r: Row) => boolean; name: string }

const UNIQUES: Record<string, Unique[]> = {
  wa_template_queue: [
    { cols: ['order_id', 'template_name'], name: 'wa_template_queue_order_id_template_name_key' },
    { cols: ['broadcast_id', 'phone_normalized'], where: r => r.broadcast_id != null, name: 'idx_wa_template_queue_broadcast_phone' },
  ],
  wa_broadcasts: [
    { cols: ['store_id', 'request_key'], name: 'wa_broadcasts_store_request_key_key' },
    { cols: ['store_id', 'launch_request_key'], where: r => r.launch_request_key != null, name: 'idx_wa_broadcasts_launch_request_key' },
    { cols: ['store_id'], where: r => ['queued', 'processing', 'paused'].includes(r.status), name: 'idx_wa_broadcasts_one_running' },
  ],
  wa_broadcast_responses: [{ cols: ['inbound_message_id'], name: 'wa_broadcast_responses_inbound_message_id_key' }],
  wa_contact_preferences: [{ cols: ['store_id', 'phone_normalized'], name: 'wa_contact_preferences_store_id_phone_normalized_key' }],
  wa_messages: [{ cols: ['wa_msg_id'], name: 'wa_messages_wa_msg_id_key' }],
  wa_contacts: [{ cols: ['store_id', 'phone_normalized'], name: 'wa_contacts_store_id_phone_normalized_key' }],
}

export class C1FakeDb {
  tables: Record<string, Row[]> = {}
  log: Array<{ table: string; op: string }> = []

  t(name: string): Row[] { return (this.tables[name] ??= []) }

  private violates(table: string, candidate: Row, ignoreId?: string): string | null {
    for (const u of UNIQUES[table] ?? []) {
      if (u.where && !u.where(candidate)) continue
      if (u.cols.some(c => candidate[c] == null)) continue
      const clash = this.t(table).some(r => r.id !== ignoreId && (!u.where || u.where(r)) && u.cols.every(c => r[c] === candidate[c]))
      if (clash) return u.name
    }
    return null
  }

  from(table: string) {
    const db = this
    const st = {
      op: 'select' as 'select' | 'insert' | 'update' | 'upsert', cols: '*', filters: [] as Filter[],
      payload: null as Row | Row[] | null, onConflict: null as string | null,
      orderCol: null as string | null, asc: true, from: 0, to: Infinity, lim: Infinity,
      mode: 'many' as 'many' | 'single' | 'maybe',
    }
    const matches = (r: Row) => st.filters.every(f => {
      const v = getPath(r, f.col)
      switch (f.op) {
        case 'eq':     return v === f.val
        case 'neq':    return v !== f.val
        case 'in':     return (f.val as unknown[]).includes(v)
        case 'is':     return v === null || v === undefined
        case 'not_is': return v !== null && v !== undefined
        case 'gte':    return v != null && cmp(v, f.val) >= 0
        case 'lt':     return v != null && cmp(v, f.val) < 0
        case 'lte':    return v != null && cmp(v, f.val) <= 0
        case 'match':  return v != null && new RegExp(String(f.val)).test(String(v))
      }
    })
    const embed = (r: Row): Row => {
      if (!st.cols.includes('contact:wa_contacts(')) return r
      const c = db.t('wa_contacts').find(x => x.id === r.contact_id) ?? null
      return { ...r, contact: c }
    }
    const shape = (rows: Row[]) => {
      if (st.mode === 'single') return rows[0] ? { data: rows[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
      if (st.mode === 'maybe') return { data: rows[0] ?? null, error: null }
      return { data: rows, error: null }
    }
    const run = () => {
      db.log.push({ table, op: st.op })
      if (st.op === 'insert') {
        const payloads = Array.isArray(st.payload) ? st.payload : [st.payload!]
        const out: Row[] = []
        for (const p of payloads) {
          const row = { id: randomUUID(), created_at: new Date().toISOString(), ...p }
          const v = db.violates(table, row)
          if (v) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${v}"` } }
          db.t(table).push(row); out.push(row)
        }
        return shape(out)
      }
      if (st.op === 'upsert') {
        const p = st.payload as Row
        const keys = (st.onConflict ?? '').split(',').map(s => s.trim()).filter(Boolean)
        const existing = db.t(table).find(r => keys.every(k => r[k] === p[k]))
        if (existing) { Object.assign(existing, p); return shape([existing]) }
        const row = { id: randomUUID(), created_at: new Date().toISOString(), ...p }
        db.t(table).push(row); return shape([row])
      }
      if (st.op === 'update') {
        const targets = db.t(table).filter(matches)
        for (const r of targets) {
          const v = db.violates(table, { ...r, ...(st.payload as Row) }, r.id)
          if (v) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${v}"` } }
        }
        for (const r of targets) Object.assign(r, st.payload)
        return shape(targets.map(r => ({ ...r })))
      }
      let rows = db.t(table).filter(matches)
      if (st.orderCol) {
        const c = st.orderCol
        rows = [...rows].sort((a, b) => cmp(a[c], b[c]) * (st.asc ? 1 : -1))
      }
      rows = rows.slice(st.from, st.to + 1).slice(0, st.lim).map(r => embed({ ...r }))
      return shape(rows)
    }
    const b: any = { // eslint-disable-line @typescript-eslint/no-explicit-any
      select: (cols?: string) => { if (st.op === 'select') st.cols = cols ?? '*'; return b },
      insert: (p: Row | Row[]) => { st.op = 'insert'; st.payload = p; return b },
      update: (p: Row) => { st.op = 'update'; st.payload = p; return b },
      upsert: (p: Row, o?: { onConflict?: string }) => { st.op = 'upsert'; st.payload = p; st.onConflict = o?.onConflict ?? null; return b },
      delete: () => { throw new Error('delete no permitido') },
      eq:  (c: string, v: unknown) => { st.filters.push({ op: 'eq', col: c, val: v }); return b },
      neq: (c: string, v: unknown) => { st.filters.push({ op: 'neq', col: c, val: v }); return b },
      in:  (c: string, v: unknown[]) => { st.filters.push({ op: 'in', col: c, val: v }); return b },
      is:  (c: string, v: unknown) => { st.filters.push({ op: 'is', col: c, val: v }); return b },
      not: (c: string, op: string, v: unknown) => {
        if (op !== 'is' || v !== null) throw new Error(`fake: not(${op}) no soportado`)
        st.filters.push({ op: 'not_is', col: c, val: null }); return b
      },
      gte: (c: string, v: unknown) => { st.filters.push({ op: 'gte', col: c, val: v }); return b },
      lt:  (c: string, v: unknown) => { st.filters.push({ op: 'lt', col: c, val: v }); return b },
      lte: (c: string, v: unknown) => { st.filters.push({ op: 'lte', col: c, val: v }); return b },
      filter: (c: string, op: string, v: unknown) => {
        if (op !== 'match') throw new Error(`fake: filter ${op} no soportado`)
        st.filters.push({ op: 'match', col: c, val: v }); return b
      },
      order: (c: string, o?: { ascending?: boolean }) => { st.orderCol = c; st.asc = o?.ascending !== false; return b },
      range: (a: number, z: number) => { st.from = a; st.to = z; return b },
      limit: (n: number) => { st.lim = n; return b },
      single: () => { st.mode = 'single'; return b },
      maybeSingle: () => { st.mode = 'maybe'; return b },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        // Resolución asíncrona real: permite intercalar workers concurrentes.
        return new Promise(r => setImmediate(r)).then(() => run()).then(res, rej)
      },
    }
    return b
  }
}
