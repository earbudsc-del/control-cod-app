// Sprint Broadcast B — DTO de selección de audiencia.
//
// El browser solo puede describir la selección con esta forma estructurada:
//   - selected_ids: lista explícita de order_id (UUID), con tope.
//   - filtered:     filtros de la pestaña Sto. Domingo de /confirmacion,
//                   por ALLOWLIST. Claves desconocidas → rechazo.
// Nunca se aceptan SQL, expresiones PostgREST ni filtros arbitrarios.
//
// Puro y sin dependencias de servidor: lo importan los endpoints (validación)
// y la UI (tipos).
//
// Frontera de audiencia de un draft (ver broadcast-service.ts):
//   - selected_ids: los order_ids guardados son la frontera — revalidar solo
//     puede quitar ids, nunca agregar.
//   - filtered: el draft guarda además resolved_at; solo pertenecen pedidos con
//     orders.created_at <= resolved_at (instante de alta en Control COD,
//     inmutable). Pedidos posteriores que cumplan el filtro NO pertenecen.

export const MAX_SELECTED_IDS = 500
export const MAX_SEARCH_LENGTH = 80

// Mismos valores que el selector "Estado" de /confirmacion.
export const BROADCAST_STATUS_FILTERS = ['', 'pending', 'reintentar', 'confirmed', 'cancelled', 'no_coverage', 'unreachable'] as const
// Mismos valores que el filtro "Pago" de la pestaña Sto. Domingo.
export const BROADCAST_PAYMENT_FILTERS = ['todos', 'pendiente', 'pagado'] as const

export type BroadcastStatusFilter  = typeof BROADCAST_STATUS_FILTERS[number]
export type BroadcastPaymentFilter = typeof BROADCAST_PAYMENT_FILTERS[number]

export interface BroadcastFilters {
  // Geografía fija: la autoridad es isSantoDomingoOrder() en el servidor,
  // NO el SD_FILTER de /api/confirmacion/pedidos.
  scope:     'santo_domingo'
  status:    BroadcastStatusFilter
  payment:   BroadcastPaymentFilter
  date_from: string | null   // ISO, inclusivo
  date_to:   string | null   // ISO, exclusivo
  search:    string | null
}

export type BroadcastSelection =
  | { mode: 'selected_ids'; order_ids: string[] }
  | { mode: 'filtered';     filters: BroadcastFilters }

export type ParseResult =
  | { ok: true;  selection: BroadcastSelection }
  | { ok: false; error: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FILTER_KEYS = new Set(['scope', 'status', 'payment', 'date_from', 'date_to', 'search'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseIso(v: unknown, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null }
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return { ok: false, error: `${field} inválido` }
  return { ok: true, value: new Date(v).toISOString() }
}

/**
 * Búsqueda: texto plano, recortado, sin caracteres de control. Se aplica en
 * TypeScript (substring normalizado), nunca se interpola en PostgREST.
 */
export function normalizeSearch(v: unknown): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_SEARCH_LENGTH)
  return s === '' ? null : s
}

export function parseBroadcastSelection(input: unknown): ParseResult {
  if (!isPlainObject(input)) return { ok: false, error: 'selection requerida' }

  if (input.mode === 'selected_ids') {
    const ids = input.order_ids
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: 'order_ids requerido' }
    if (!ids.every(id => typeof id === 'string' && UUID_RE.test(id))) return { ok: false, error: 'order_ids inválidos' }
    const unique = [...new Set((ids as string[]).map(id => id.toLowerCase()))]
    if (unique.length > MAX_SELECTED_IDS) {
      return { ok: false, error: `Máximo ${MAX_SELECTED_IDS} pedidos por selección manual — usa "todos los resultados del filtro"` }
    }
    return { ok: true, selection: { mode: 'selected_ids', order_ids: unique } }
  }

  if (input.mode === 'filtered') {
    const f = input.filters
    if (!isPlainObject(f)) return { ok: false, error: 'filters requerido' }
    const unknown = Object.keys(f).filter(k => !FILTER_KEYS.has(k))
    if (unknown.length) return { ok: false, error: `Filtros no soportados: ${unknown.join(', ')}` }
    if (f.scope !== 'santo_domingo') return { ok: false, error: 'scope debe ser santo_domingo' }

    const status  = (f.status ?? '') as BroadcastStatusFilter
    const payment = (f.payment ?? 'todos') as BroadcastPaymentFilter
    if (!(BROADCAST_STATUS_FILTERS as readonly string[]).includes(status))   return { ok: false, error: 'status inválido' }
    if (!(BROADCAST_PAYMENT_FILTERS as readonly string[]).includes(payment)) return { ok: false, error: 'payment inválido' }

    const from = parseIso(f.date_from, 'date_from'); if (!from.ok) return from
    const to   = parseIso(f.date_to,   'date_to');   if (!to.ok)   return to
    if (from.value && to.value && from.value >= to.value) return { ok: false, error: 'Rango de fechas inválido' }

    return {
      ok: true,
      selection: {
        mode: 'filtered',
        filters: { scope: 'santo_domingo', status, payment, date_from: from.value, date_to: to.value, search: normalizeSearch(f.search) },
      },
    }
  }

  return { ok: false, error: 'mode debe ser selected_ids o filtered' }
}
