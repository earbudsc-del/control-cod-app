// Resolución contacto WhatsApp → pedido relevante (B.2.3).
//
// Alimenta wa_contacts.order_id desde el webhook de WhatsApp. Ese vínculo NO
// es decorativo: Ruta COD lo usa para AUTORIZAR al mensajero a ver/escribir la
// conversación (loadConversationForMessenger → checkConversationOrderAccess),
// y también lo leen whatsapp-link.ts y las rutas del Inbox.
//
// Antes (findOrderByPhone en el webhook): últimos 200 pedidos de TODA la
// tienda, filtro de teléfono en memoria, primer match = el más reciente,
// incluyendo cancelados y pedidos pagados. Además el vínculo era "pegajoso":
// solo se escribía si estaba vacío, así que un contacto ligado a un pedido ya
// entregado nunca pasaba a su pedido nuevo.
//
// Semántica nueva (distinta de findActiveSdOrdersByPhone a propósito: aquí NO
// se exige Santo Domingo ni ausencia de guía — un pedido EFI en tránsito o en
// novedad también es el pedido relevante de ese cliente para el Inbox):
//   pedido ACTIVO para el contacto =
//     normalized_status NOT IN (delivered, returned, cancelled)
//     confirmation_status <> 'cancelled'
//     payment_status <> 'paid'
//     is_test = false y archived_at IS NULL
//   1 activo        → ese pedido
//   2+ activos      → ambiguous → NO se asocia (nunca elegir a ciegas)
//   0 activos       → none → NO se asocia un histórico (pagado/entregado/
//                     cancelado): el contacto no tiene pedido en curso.
// Búsqueda dirigida por tienda + teléfono (mismo patrón que B.2.2).

import { phoneDigitsMatch, phoneSuffixPattern, MATCH_DIGITS } from '@/lib/deliveries/active-sd-orders-by-phone'

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

const INACTIVE_NORMALIZED = new Set(['delivered', 'returned', 'cancelled'])
const PER_PHONE_LIMIT = 50

export interface ContactOrderCandidate {
  confirmation_status: string | null
  normalized_status:   string | null
  payment_status:      string | null
  is_test:             boolean | null
  archived_at:         string | null
}

export function isActiveOrderForContact(o: ContactOrderCandidate): boolean {
  return !INACTIVE_NORMALIZED.has(o.normalized_status ?? '')
    && o.confirmation_status !== 'cancelled'
    && o.payment_status !== 'paid'
    && o.is_test !== true && o.archived_at == null
}

export type ContactOrderResolution =
  | { status: 'single';    orderId: string }
  | { status: 'ambiguous'; orderId: null; candidates: number }
  | { status: 'none';      orderId: null }

const COLUMNS = 'id, customer_phone, confirmation_status, normalized_status, payment_status, is_test, archived_at, created_at'

export async function resolveContactOrderByPhone(
  supabase: SupabaseLike,
  storeId: string,
  phoneNormalized: string,
): Promise<ContactOrderResolution> {
  const digits = phoneNormalized.replace(/\D/g, '')
  if (digits.length < MATCH_DIGITS) return { status: 'none', orderId: null }

  const { data, error } = await supabase
    .from('orders')
    .select(COLUMNS)
    .eq('store_id', storeId)
    .filter('customer_phone', 'match', phoneSuffixPattern(digits))
    .order('created_at', { ascending: false })
    .limit(PER_PHONE_LIMIT)

  if (error) {
    console.error('[contact-order] query error:', error.message ?? String(error))
    return { status: 'none', orderId: null }
  }

  const active = ((data ?? []) as Array<ContactOrderCandidate & { id: string; customer_phone: string | null }>)
    .filter(o => phoneDigitsMatch(o.customer_phone, digits) && isActiveOrderForContact(o))

  if (active.length === 1) return { status: 'single', orderId: active[0].id }
  if (active.length > 1)   return { status: 'ambiguous', orderId: null, candidates: active.length }
  return { status: 'none', orderId: null }
}

/** ¿El pedido vinculado hoy sigue activo para el contacto? (lectura por id) */
export async function isLinkedOrderStillActive(supabase: SupabaseLike, orderId: string): Promise<boolean> {
  const { data } = await supabase.from('orders')
    .select('confirmation_status, normalized_status, payment_status, is_test, archived_at')
    .eq('id', orderId).maybeSingle()
  return !!data && isActiveOrderForContact(data as ContactOrderCandidate)
}

/**
 * Decide el nuevo wa_contacts.order_id (puro). Devuelve el id a escribir, o
 * null = no cambiar nada.
 *   - sin vínculo → vincular solo si hay UN activo;
 *   - vínculo activo → se respeta (no se reescribe);
 *   - vínculo ya no activo → se re-vincula solo si hay UN activo distinto;
 *     si no (ninguno/ambiguo) se conserva el vínculo histórico, no se borra.
 */
export function decideContactOrderLink(
  currentOrderId: string | null,
  currentStillActive: boolean,
  resolution: ContactOrderResolution,
): string | null {
  if (currentOrderId && currentStillActive) return null
  if (resolution.status !== 'single') return null
  return resolution.orderId === currentOrderId ? null : resolution.orderId
}
