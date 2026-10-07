import { normalizePhoneRD } from '@/lib/normalize-phone'
import { isSdEligible, computeOwnership, type SdOrderRow, type Ownership } from './sd-status'
import { ACTIVE_SD_CONFIRMATION_STATUSES, MATCH_DIGITS, findActiveSdOrdersByPhone, isActiveSdOrderRow, phoneDigitsMatch } from './active-sd-orders-by-phone'

interface SupabaseLike {
  from: (table: string) => any
}

// Encuentra o crea el contacto + conversación abierta de un pedido, para el
// botón "WhatsApp" de Ruta COD cuando todavía no existe ninguna conversación
// (pedido recién entrado, antes de que el cron envíe el mensaje automático).
// Mismo patrón find-or-create que ya usan el cron de wa_template_queue y el
// webhook inbound — no crea un mecanismo paralelo.
export async function resolveOrCreateConversationForOrder(
  supabase: SupabaseLike,
  storeId: string,
  orderId: string,
  phone: string,
  displayName: string | null,
): Promise<string> {
  const phoneNormalized = normalizePhoneRD(phone)

  const { data: existingContact } = await supabase
    .from('wa_contacts')
    .select('id')
    .eq('store_id', storeId)
    .eq('phone_normalized', phoneNormalized)
    .maybeSingle()

  let contactId: string
  if (existingContact) {
    contactId = existingContact.id
  } else {
    const { data: newContact, error: contactError } = await supabase
      .from('wa_contacts')
      .insert({ store_id: storeId, phone_normalized: phoneNormalized, display_name: displayName, order_id: orderId })
      .select('id')
      .single()

    if (contactError) {
      if (contactError.code === '23505') {
        const { data: refetched } = await supabase
          .from('wa_contacts').select('id')
          .eq('store_id', storeId).eq('phone_normalized', phoneNormalized)
          .maybeSingle()
        if (!refetched) throw new Error('Contact insert conflict, refetch failed')
        contactId = refetched.id
      } else {
        throw contactError
      }
    } else {
      contactId = newContact.id
    }
  }

  const { data: existingConv } = await supabase
    .from('wa_conversations')
    .select('id')
    .eq('contact_id', contactId)
    .neq('status', 'closed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingConv) return existingConv.id

  const { data: newConv, error: convError } = await supabase
    .from('wa_conversations')
    .insert({ store_id: storeId, contact_id: contactId, status: 'open', unread_count: 0 })
    .select('id')
    .single()

  if (convError) {
    if (convError.code === '23505') {
      const { data: refetchedConv } = await supabase
        .from('wa_conversations').select('id')
        .eq('contact_id', contactId).neq('status', 'closed')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (!refetchedConv) throw new Error('Conversation insert conflict, refetch failed')
      return refetchedConv.id
    }
    throw convError
  }

  return newConv.id
}

export interface ConversationOrderAccess {
  allowed: boolean
  ownership: Ownership
}

// Campos del pedido que la autorización necesita (B.2.4).
export interface AccessOrderRow extends SdOrderRow {
  store_id?:       string | null
  payment_status?: string | null
  is_test?:        boolean | null
  archived_at?:    string | null
}

export const ACCESS_ORDER_COLUMNS =
  'id, store_id, city, province, customer_address, tracking_number, normalized_status, confirmation_status, assigned_to, payment_status, is_test, archived_at'

// Regla de acceso a conversaciones (spec Sprint 3A sección 8): solo pedidos
// SD, de la tienda del mensajero, asignados a él o disponibles, o admin.
//
// B.2.4 — el pedido además debe estar OPERATIVAMENTE ACTIVO (mismo predicado
// que el lookup canónico: sin guía, pending/confirmed/unreachable, no
// entregado/devuelto/cancelado, no pagado, no de prueba/archivado). Un pedido
// histórico ya no autoriza a ningún mensajero (antes: un pedido entregado y
// sin asignar abría el chat a cualquier mensajero). Admin conserva acceso a
// pedidos SD históricos.
//
// Cierre B.2 — el chat privado exige ASIGNACIÓN: un pedido activo sin asignar
// sigue apareciendo como disponible en Ruta COD (acción 'accept' / auto-claim
// en orders/[id]/actions), pero NO abre el chat hasta que el mensajero lo toma.
// Ninguna acción del flujo necesita el chat antes de la asignación.
export function checkConversationOrderAccess(
  order: AccessOrderRow,
  userId: string,
  role: string,
): ConversationOrderAccess {
  if (!isSdEligible(order)) return { allowed: false, ownership: 'other' }
  if (role !== 'admin' && !isActiveSdOrderRow(order)) return { allowed: false, ownership: 'other' }
  const ownership = computeOwnership(order.assigned_to, userId, role)
  return { allowed: ownership === 'mine', ownership }   // 'mine' incluye admin
}

export type ConversationAccessDecision =
  | { allowed: true;  orderId: string; ownership: Ownership }
  | { allowed: false; reason: 'no_active_order' | 'ambiguous' | 'not_owner' }

/**
 * Decisión de acceso a la conversación de un contacto (pura, B.2.4 + cierre B.2).
 *
 * La autorización se basa en los pedidos SD ACTIVOS ACTUALES del teléfono
 * del contacto — nunca solo en wa_contacts.order_id (vínculo que puede ser
 * histórico, obsoleto o de otro pedido).
 *   1 activo        → solo si está asignado a mí (o admin). Sin asignar → no.
 *   2+ activos      → sin elegir a ciegas: mensajero solo si TODOS son
 *                     suyos; admin sí.
 *   0 activos       → mensajero NO (ningún vínculo viejo autoriza);
 *                     admin puede abrir el pedido vinculado si es SD.
 */
export function decideConversationAccess(
  activeOrders: AccessOrderRow[],
  linkedOrder: AccessOrderRow | null,
  userId: string,
  role: string,
): ConversationAccessDecision {
  const active = activeOrders.filter(o => isActiveSdOrderRow(o))

  if (active.length === 0) {
    if (role === 'admin' && linkedOrder && isSdEligible(linkedOrder)) {
      return { allowed: true, orderId: linkedOrder.id, ownership: 'mine' }
    }
    return { allowed: false, reason: 'no_active_order' }
  }

  if (active.length === 1) {
    const a = checkConversationOrderAccess(active[0], userId, role)
    return a.allowed ? { allowed: true, orderId: active[0].id, ownership: a.ownership } : { allowed: false, reason: 'not_owner' }
  }

  if (role === 'admin') return { allowed: true, orderId: active[0].id, ownership: 'mine' }
  const allMine = active.every(o => computeOwnership(o.assigned_to, userId, role) === 'mine')
  return allMine ? { allowed: true, orderId: active[0].id, ownership: 'mine' } : { allowed: false, reason: 'ambiguous' }
}

/** Resuelve (lectura) y decide el acceso a la conversación de un contacto. */
export async function resolveConversationAccess(
  supabase: SupabaseLike,
  params: { storeId: string; contactPhone: string | null; linkedOrderId: string | null; userId: string; role: string },
): Promise<ConversationAccessDecision> {
  const { storeId, contactPhone, linkedOrderId, userId, role } = params
  const refs = contactPhone ? await findActiveSdOrdersByPhone(supabase, storeId, contactPhone) : []

  let activeRows: AccessOrderRow[] = []
  if (refs.length > 0) {
    const { data } = await supabase.from('orders').select(ACCESS_ORDER_COLUMNS)
      .eq('store_id', storeId).in('id', refs.map(r => r.id))
    const byId = new Map(((data ?? []) as AccessOrderRow[]).map(o => [o.id, o]))
    activeRows = refs.map(r => byId.get(r.id)).filter((o): o is AccessOrderRow => !!o)   // orden: más reciente primero
  }

  let linked: AccessOrderRow | null = null
  if (activeRows.length === 0 && role === 'admin' && linkedOrderId) {
    const { data } = await supabase.from('orders').select(ACCESS_ORDER_COLUMNS)
      .eq('store_id', storeId).eq('id', linkedOrderId).maybeSingle()
    linked = (data as AccessOrderRow | null) ?? null
  }

  return decideConversationAccess(activeRows, linked, userId, role)
}

// ── Índice para la LISTA de conversaciones (B.2.4) ───────────────────────────
// La lista evalúa hasta 200 conversaciones: en vez de 2–3 consultas por
// conversación, carga UNA vez los pedidos SD activos de la tienda (paginado,
// sin "últimos N") y resuelve cada teléfono en memoria con la misma regla de
// coincidencia y el mismo predicado de actividad que el lookup canónico.

export type ListOrderRow = AccessOrderRow & {
  customer_phone: string | null; order_number: string | null; customer_name: string | null
  cod_amount: number | null; created_at: string
}

const LIST_COLUMNS = `${ACCESS_ORDER_COLUMNS}, customer_phone, order_number, customer_name, cod_amount, created_at`

export async function loadActiveSdOrdersIndex(
  supabase: SupabaseLike,
  storeId: string,
): Promise<(phone: string | null) => ListOrderRow[]> {
  const rows: ListOrderRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('orders').select(LIST_COLUMNS)
      .eq('store_id', storeId).is('tracking_number', null)
      .in('confirmation_status', [...ACTIVE_SD_CONFIRMATION_STATUSES])
      .order('created_at', { ascending: false }).range(from, from + 999)
    if (error) throw new Error(`orders(active-index): ${error.message ?? String(error)}`)
    rows.push(...((data ?? []) as ListOrderRow[]))
    if (!data || data.length < 1000) break
  }
  const byTail = new Map<string, ListOrderRow[]>()
  for (const o of rows) {
    if (!isActiveSdOrderRow(o) || !o.customer_phone) continue
    const d = o.customer_phone.replace(/\D/g, '')
    if (d.length < MATCH_DIGITS) continue
    const k = d.slice(-MATCH_DIGITS)
    byTail.set(k, [...(byTail.get(k) ?? []), o])
  }
  return (phone: string | null) => {
    const digits = (phone ?? '').replace(/\D/g, '')
    if (digits.length < MATCH_DIGITS) return []
    return (byTail.get(digits.slice(-MATCH_DIGITS)) ?? []).filter(o => phoneDigitsMatch(o.customer_phone, digits))
  }
}

// ── Acceso de Ruta COD a una conversación (GET/POST de mensajes) ─────────────
// Antes vivía dentro de conversations/[id]/messages/route.ts. Movido aquí para
// probar la autorización de GET y POST sin levantar Next.js.
export type MessengerConversationAccess =
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'ok'; contact: { order_id: string | null; wa_id: string | null; phone_normalized: string | null }; storeId: string; orderId: string }

export async function loadConversationForMessenger(
  supabase: SupabaseLike,
  conversationId: string,
  storeId: string,
  userId: string,
  role: string,
): Promise<MessengerConversationAccess> {
  const { data: conv } = await supabase
    .from('wa_conversations')
    .select('id, store_id, contact:wa_contacts(order_id, wa_id, phone_normalized)')
    .eq('id', conversationId)
    .maybeSingle()

  if (!conv || conv.store_id !== storeId) return { kind: 'not_found' }

  type ContactRow = { order_id: string | null; wa_id: string | null; phone_normalized: string | null }
  const contact = (Array.isArray(conv.contact) ? conv.contact[0] : conv.contact) as ContactRow | null
  if (!contact) return { kind: 'not_found' }

  // La autorización depende de los pedidos SD ACTIVOS actuales del teléfono
  // del contacto y de su asignación — nunca solo de wa_contacts.order_id.
  const decision = await resolveConversationAccess(supabase, {
    storeId, contactPhone: contact.phone_normalized, linkedOrderId: contact.order_id, userId, role,
  })
  if (!decision.allowed) return { kind: 'forbidden' }

  return { kind: 'ok', contact, storeId: conv.store_id as string, orderId: decision.orderId }
}
