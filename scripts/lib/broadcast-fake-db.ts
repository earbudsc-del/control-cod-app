// DB en memoria compartida por los tests de Broadcast (B/B.1/B.2).
// Emula el subconjunto de PostgREST que usa el servicio y registra cada
// consulta y escritura. Sin red, sin DB real.

import { randomUUID } from 'node:crypto'

// ── DB en memoria ────────────────────────────────────────────────────────────

export type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Filter = { op: 'eq' | 'in' | 'is' | 'gte' | 'lt' | 'lte' | 'match'; col: string; val: unknown }

function getPath(row: Row, col: string): unknown {
  const m = col.match(/^(\w+)->>(\w+)$/)
  if (m) { const obj = row[m[1]]; return obj == null ? null : (obj[m[2]] ?? null) }
  return row[col]
}

export class FakeDb {
  tables: Record<string, Row[]> = { orders: [], wa_template_queue: [], wa_broadcasts: [] }
  queries: Array<{ table: string; op: 'select' | 'insert'; filters: Filter[] }> = []
  writes:  Array<{ table: string; op: string }> = []
  // Hook para simular una request concurrente que inserta justo antes.
  beforeInsert: ((table: string, payload: Row) => void) | null = null

  from(table: string) {
    const db = this
    const state = { table, op: 'select' as 'select' | 'insert', filters: [] as Filter[], payload: null as Row | null,
      orderCol: null as string | null, asc: true, rangeFrom: 0, rangeTo: Infinity, lim: Infinity, mode: 'many' as 'many' | 'single' | 'maybe' }
    const run = () => {
      db.queries.push({ table, op: state.op, filters: state.filters })
      if (state.op === 'insert') {
        db.writes.push({ table, op: 'insert' })
        if (db.beforeInsert) { const h = db.beforeInsert; db.beforeInsert = null; h(table, state.payload!) }
        // UNIQUE (store_id, request_key) — migración 065.
        if (table === 'wa_broadcasts' && db.tables.wa_broadcasts.some(r =>
          r.store_id === state.payload!.store_id && r.request_key === state.payload!.request_key)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "wa_broadcasts_store_request_key_key"' } }
        }
        const row = { id: randomUUID(), created_at: new Date().toISOString(), ...state.payload }
        db.tables[table].push(row)
        return { data: row, error: null }
      }
      let rows = (db.tables[table] ?? []).filter(r => state.filters.every(f => {
        const v = getPath(r, f.col)
        switch (f.op) {
          case 'eq':  return v === f.val
          case 'in':  return (f.val as unknown[]).includes(v)
          case 'is':  return v === null || v === undefined
          case 'gte': return v != null && String(v) >= String(f.val)
          case 'lt':  return v != null && String(v) <  String(f.val)
          case 'lte': return v != null && Date.parse(String(v)) <= Date.parse(String(f.val))
          case 'match': return v != null && new RegExp(String(f.val)).test(String(v))  // PostgREST `match` (~)
        }
      }))
      if (state.orderCol) {
        const c = state.orderCol
        rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (state.asc ? 1 : -1))
      }
      rows = rows.slice(state.rangeFrom, state.rangeTo + 1).slice(0, state.lim)
      if (state.mode === 'single' || state.mode === 'maybe') return { data: rows[0] ?? null, error: null }
      return { data: rows, error: null }
    }
    const b: any = { // eslint-disable-line @typescript-eslint/no-explicit-any
      select: () => b,
      insert: (payload: Row) => { state.op = 'insert'; state.payload = payload; return b },
      update: () => { db.writes.push({ table, op: 'update' }); throw new Error('update no permitido en Sprint B') },
      upsert: () => { db.writes.push({ table, op: 'upsert' }); throw new Error('upsert no permitido en Sprint B') },
      delete: () => { db.writes.push({ table, op: 'delete' }); throw new Error('delete no permitido en Sprint B') },
      eq:  (col: string, val: unknown) => { state.filters.push({ op: 'eq', col, val }); return b },
      in:  (col: string, val: unknown[]) => { state.filters.push({ op: 'in', col, val }); return b },
      is:  (col: string, val: unknown) => { state.filters.push({ op: 'is', col, val }); return b },
      gte: (col: string, val: unknown) => { state.filters.push({ op: 'gte', col, val }); return b },
      lt:  (col: string, val: unknown) => { state.filters.push({ op: 'lt', col, val }); return b },
      lte: (col: string, val: unknown) => { state.filters.push({ op: 'lte', col, val }); return b },
      filter: (col: string, op: string, val: unknown) => {
        if (op !== 'match') throw new Error(`fake: operador ${op} no soportado`)
        state.filters.push({ op: 'match', col, val }); return b
      },
      order: (col: string, o?: { ascending?: boolean }) => { state.orderCol = col; state.asc = o?.ascending !== false; return b },
      range: (a: number, z: number) => { state.rangeFrom = a; state.rangeTo = z; return b },
      limit: (n: number) => { state.lim = n; return b },
      single:      () => { state.mode = 'single'; return b },
      maybeSingle: () => { state.mode = 'maybe'; return b },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        try { return Promise.resolve(run()).then(res, rej) } catch (e) { return Promise.reject(e).then(res, rej) }
      },
    }
    return b
  }
}

