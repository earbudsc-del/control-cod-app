// Lookup canónico: pedidos SD ACTIVOS de un teléfono (B.2.2).
//
// Usado por el webhook de WhatsApp (bloque 4b: asociar un pin de ubicación al
// pedido) y diseñado para reutilizarse en respuestas a Broadcast y Génesis 2.
// Antes vivía dentro de webhooks/whatsapp/route.ts y traía los 200 pedidos
// MÁS RECIENTES DE TODA LA TIENDA para filtrar el teléfono en memoria: un
// pedido activo más viejo que esos 200 nunca se encontraba (su ubicación se
// perdía). Además contaba pedidos cancelados como "activos" → ambigüedad falsa.
//
// Estrategia nueva: búsqueda DIRIGIDA por teléfono en la DB.
//   - store_id
//   - customer_phone coincide en sus últimos 7 dígitos, tolerando cualquier
//     formato (guiones, espacios, paréntesis, +1): regex POSIX
//     'd\D*d\D*…d\D*$' (operador PostgREST `match`, sin depender de los
//     "últimos N" de la tienda)
//   - estados realmente activos (abajo)
// Luego, en TS, la misma regla de coincidencia de siempre (sufijo ≥ 7 dígitos)
// + isSantoDomingoOrder().
//
// Participan (activo coordinable SD):
//   tracking_number IS NULL
//   confirmation_status IN ('pending', 'confirmed', 'unreachable')
//   normalized_status NOT IN ('delivered', 'returned', 'cancelled')
//   payment_status <> 'paid'
//   is_test = false y archived_at IS NULL
// NO participan: cancelled / no_coverage / wrong_number, pagados, entregados,
// devueltos, con guía EFI, de prueba o archivados — un histórico nunca compite
// con el pedido activo actual.
//
// Varios activos del mismo teléfono → el llamador recibe todos (más reciente
// primero) y debe tratarlo como 'ambiguous' (nunca elegir a ciegas).

import { isSantoDomingoOrder } from '@/lib/alert-helpers'

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const ACTIVE_SD_CONFIRMATION_STATUSES = ['pending', 'confirmed', 'unreachable'] as const
const INACTIVE_NORMALIZED = new Set(['delivered', 'returned', 'cancelled'])
export const MATCH_DIGITS = 7
// Tope POR TELÉFONO (no por tienda): un número no tiene cientos de pedidos activos.
const PER_PHONE_LIMIT = 50

/** Regex POSIX/JS: los últimos `n` dígitos en orden, con cualquier separador. */
export function phoneSuffixPattern(digits: string, n = MATCH_DIGITS): string {
  return digits.slice(-n).split('').join('\\D*') + '\\D*$'
}

/** Coincidencia histórica de teléfonos: uno es sufijo del otro, ≥ 7 dígitos. */
export function phoneDigitsMatch(storedRaw: string | null | undefined, phoneDigits: string): boolean {
  if (!storedRaw) return false
  const stored  = String(storedRaw).replace(/\D/g, '')
  const shorter = stored.length <= phoneDigits.length ? stored : phoneDigits
  const longer  = stored.length <= phoneDigits.length ? phoneDigits : stored
  return longer.endsWith(shorter) && shorter.length >= MATCH_DIGITS
}

export interface ActiveSdOrderFields {
  tracking_number:     string | null
  confirmation_status: string | null
  normalized_status:   string | null
  payment_status?:     string | null
  is_test?:            boolean | null
  archived_at?:        string | null
  city:                string | null
  province:            string | null
  customer_address:    string | null
}

/** Predicado único de "pedido SD activo" (mismo que usa el lookup). */
export function isActiveSdOrderRow(o: ActiveSdOrderFields): boolean {
  if (o.tracking_number) return false
  if (!(ACTIVE_SD_CONFIRMATION_STATUSES as readonly (string | null)[]).includes(o.confirmation_status)) return false
  if (INACTIVE_NORMALIZED.has(o.normalized_status ?? '')) return false
  if (o.payment_status === 'paid') return false
  if (o.is_test === true || o.archived_at != null) return false
  return isSantoDomingoOrder(o.city, o.province, o.customer_address)
}

export interface ActiveSdOrderRef { id: string; created_at: string }

export async function findActiveSdOrdersByPhone(
  supabase:        SupabaseLike,
  storeId:         string,
  phoneNormalized: string,
): Promise<ActiveSdOrderRef[]> {
  const phoneDigits = phoneNormalized.replace(/\D/g, '')
  if (phoneDigits.length < MATCH_DIGITS) return []

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, customer_phone, customer_address, city, province, tracking_number, normalized_status, confirmation_status, payment_status, is_test, archived_at, created_at')
    .eq('store_id', storeId)
    .is('tracking_number', null)
    .in('confirmation_status', [...ACTIVE_SD_CONFIRMATION_STATUSES])
    .filter('customer_phone', 'match', phoneSuffixPattern(phoneDigits))
    .order('created_at', { ascending: false })
    .limit(PER_PHONE_LIMIT)

  if (error) {
    console.error('[active-sd-orders-by-phone] query error:', error.message ?? String(error))
    return []
  }
  if (!orders?.length) return []

  return (orders as Array<Record<string, any>>) // eslint-disable-line @typescript-eslint/no-explicit-any
    .filter(o => phoneDigitsMatch(o.customer_phone, phoneDigits) && isActiveSdOrderRow(o as ActiveSdOrderFields))
    .map(o => ({ id: o.id as string, created_at: o.created_at as string }))
}
