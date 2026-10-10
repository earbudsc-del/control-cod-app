// Ubicación recibida por WhatsApp → pedido SD (antes: bloque 4b del webhook).
// Sprint C.1.2 — dos correcciones, el resto del comportamiento se conserva:
//
//   1. La confirmación + autodespacho por ubicación es una AUTOMATIZACIÓN:
//      solo corre con WA_AUTOMATIONS_ENABLED='true'. Con el flag ausente o
//      apagado la ubicación se guarda igual en el pedido y un agente confirma
//      con los flujos canónicos. (Antes confirmaba siempre, sin flag — una
//      respuesta a Broadcast con un pin, incluso después de "Ya no lo deseo",
//      confirmaba y despachaba el pedido sin intervención humana.)
//
//   2. Varios pedidos activos candidatos (ambiguo): NO se asigna la
//      ubicación a ninguno. Antes se escribía en el más reciente con
//      sd_location_status='ambiguous' — un pedido elegido a ciegas que Ruta
//      COD ubica en el mapa y que el template sd_location_request y Broadcast
//      tratan como "ubicación ya recibida". La coordenada queda en el propio
//      wa_message, marcado location_assignment_status='ambiguous'
//      (C.1.3), y un agente la asocia desde el Inbox con
//      assignLocationToOrder() — misma escritura de ubicación, con
//      revalidación y auditoría, SIN confirmar ni despachar.
//
// Un solo candidato: igual que antes (se guarda con status 'received'; con
// automations activas, applyConfirmationAction(guardAutomated) — que exige
// confirmation_status='pending' y no terminal).

import { findActiveSdOrdersByPhone } from '@/lib/deliveries/active-sd-orders-by-phone'
import { applyConfirmationAction } from '@/lib/orders/confirmation'

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface InboundLocationInput {
  inboundMessageId?: string   // wa_messages.id del pin (para marcarlo si es ambiguo)
  storeId:         string
  phoneNormalized: string
  conversationId:  string
  waMsgId:         string
  latitude:        number
  longitude:       number
  sentAt:          string
}

export type InboundLocationOutcome =
  | { outcome: 'no_candidates' }
  | { outcome: 'ambiguous_not_assigned'; candidates: number }
  | { outcome: 'save_error'; orderId: string; error: string }
  | { outcome: 'saved_automations_off'; orderId: string }
  | { outcome: 'saved_confirmed'; orderId: string; autoDispatched: boolean }
  | { outcome: 'saved_confirm_skipped'; orderId: string; reason: string }

export interface InboundLocationDeps {
  automationsEnabled: () => boolean
  findCandidates?: typeof findActiveSdOrdersByPhone
  confirm?: typeof applyConfirmationAction
}

export async function handleInboundLocation(
  db: SupabaseLike, i: InboundLocationInput, deps: InboundLocationDeps,
): Promise<InboundLocationOutcome> {
  const find = deps.findCandidates ?? findActiveSdOrdersByPhone
  const confirm = deps.confirm ?? applyConfirmationAction

  const candidates = await find(db as never, i.storeId, i.phoneNormalized)
  if (candidates.length === 0) return { outcome: 'no_candidates' }
  if (candidates.length > 1) {
    if (i.inboundMessageId) {
      await mergeMessageMetadata(db, i.inboundMessageId, {
        location_assignment_status: 'ambiguous', location_candidates_count: candidates.length,
      })
    }
    return { outcome: 'ambiguous_not_assigned', candidates: candidates.length }
  }

  const orderId = candidates[0].id
  const { error } = await writeOrderLocation(db, i.storeId, orderId, {
    latitude: i.latitude, longitude: i.longitude, sentAt: i.sentAt, waMsgId: i.waMsgId, conversationId: i.conversationId,
  })
  if (error) return { outcome: 'save_error', orderId, error: error.message ?? String(error) }

  if (!deps.automationsEnabled()) return { outcome: 'saved_automations_off', orderId }

  const r = await confirm({
    supabase: db as never, orderId, action: 'confirmed', method: 'whatsapp_location', userId: null, guardAutomated: true,
  })
  return r.ok
    ? { outcome: 'saved_confirmed', orderId, autoDispatched: !!r.auto_dispatched }
    : { outcome: 'saved_confirm_skipped', orderId, reason: r.reason }
}

// ── Escritura única de la ubicación en el pedido (auto y manual) ─────────────

function writeOrderLocation(
  db: SupabaseLike, storeId: string, orderId: string,
  l: { latitude: number; longitude: number; sentAt: string; waMsgId: string; conversationId: string },
) {
  return db.from('orders').update({
    sd_location_lat: l.latitude,
    sd_location_lng: l.longitude,
    sd_location_received_at: l.sentAt,
    sd_location_status: 'received',
    sd_location_wa_msg_id: l.waMsgId,
    sd_location_conversation_id: l.conversationId,
  }).eq('id', orderId).eq('store_id', storeId)
}

async function mergeMessageMetadata(db: SupabaseLike, messageId: string, patch: Record<string, unknown>): Promise<void> {
  const { data } = await db.from('wa_messages').select('metadata').eq('id', messageId).maybeSingle()
  const current = ((data as { metadata: Record<string, unknown> | null } | null)?.metadata) ?? {}
  await db.from('wa_messages').update({ metadata: { ...current, ...patch } }).eq('id', messageId)
}

// ── C.1.3 — asociación manual de una ubicación ambigua (Inbox) ───────────────

export interface PendingLocation {
  message_id: string; sent_at: string | null; latitude: number; longitude: number
  name: string | null; address: string | null; candidates_count: number | null
}

export interface LocationCandidateOrder {
  id: string; order_number: string | null; customer_name: string | null; confirmation_status: string | null
  normalized_status: string | null; cod_amount: number | null; customer_address: string | null; city: string | null
  created_at: string | null
}

async function conversationContext(db: SupabaseLike, storeId: string, conversationId: string): Promise<{ phone: string } | null> {
  const { data } = await db.from('wa_conversations').select('id, store_id, contact:wa_contacts(phone_normalized)')
    .eq('id', conversationId).eq('store_id', storeId).maybeSingle()
  if (!data) return null
  const raw = (data as { contact: { phone_normalized: string } | { phone_normalized: string }[] | null }).contact
  const phone = (Array.isArray(raw) ? raw[0] : raw)?.phone_normalized
  return phone ? { phone } : null
}

/** Pins ambiguos aún sin asociar + pedidos SD activos del contacto (estado actual). READ ONLY. */
export async function listPendingLocationAssignments(
  db: SupabaseLike, storeId: string, conversationId: string,
  findCandidates: typeof findActiveSdOrdersByPhone = findActiveSdOrdersByPhone,
): Promise<{ pending: PendingLocation[]; candidates: LocationCandidateOrder[] } | null> {
  const conv = await conversationContext(db, storeId, conversationId)
  if (!conv) return null
  const { data: msgs } = await db.from('wa_messages').select('id, sent_at, metadata')
    .eq('conversation_id', conversationId).eq('store_id', storeId).eq('direction', 'inbound').eq('message_type', 'location')
    .eq('metadata->>location_assignment_status', 'ambiguous').order('sent_at', { ascending: false }).limit(10)
  const pending: PendingLocation[] = ((msgs ?? []) as Array<{ id: string; sent_at: string | null; metadata: Record<string, unknown> }>)
    .filter(m => typeof m.metadata?.latitude === 'number' && typeof m.metadata?.longitude === 'number')
    .map(m => ({
      message_id: m.id, sent_at: m.sent_at, latitude: m.metadata.latitude as number, longitude: m.metadata.longitude as number,
      name: (m.metadata.name as string | null) ?? null, address: (m.metadata.address as string | null) ?? null,
      candidates_count: (m.metadata.location_candidates_count as number | null) ?? null,
    }))
  if (pending.length === 0) return { pending, candidates: [] }

  const refs = await findCandidates(db as never, storeId, conv.phone)
  let candidates: LocationCandidateOrder[] = []
  if (refs.length > 0) {
    const { data } = await db.from('orders')
      .select('id, order_number, customer_name, confirmation_status, normalized_status, cod_amount, customer_address, city, created_at')
      .eq('store_id', storeId).in('id', refs.map(r => r.id))
    candidates = ((data ?? []) as LocationCandidateOrder[]).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  }
  return { pending, candidates }
}

export type AssignLocationResult =
  | { ok: true; orderId: string }
  | { ok: false; status: number; error: string }

/**
 * Asocia un pin ambiguo a UN pedido elegido por el agente. Revalida AHORA:
 *   - el mensaje es un pin inbound de ESTA conversación y tienda, aún pendiente;
 *   - el pedido es un pedido SD ACTIVO de la misma tienda y del MISMO
 *     teléfono del contacto (mismo lookup canónico que el webhook).
 * Escribe la ubicación igual que el flujo automático; NO confirma ni despacha.
 * Auditoría: agent_actions(note_added) con el agente + metadata del mensaje.
 */
export async function assignLocationToOrder(
  db: SupabaseLike,
  i: { storeId: string; conversationId: string; messageId: string; orderId: string; userId: string; now?: string },
  findCandidates: typeof findActiveSdOrdersByPhone = findActiveSdOrdersByPhone,
): Promise<AssignLocationResult> {
  const conv = await conversationContext(db, i.storeId, i.conversationId)
  if (!conv) return { ok: false, status: 404, error: 'Conversación no encontrada' }

  const { data: msg } = await db.from('wa_messages').select('id, wa_msg_id, sent_at, metadata, message_type, direction')
    .eq('id', i.messageId).eq('conversation_id', i.conversationId).eq('store_id', i.storeId).maybeSingle()
  const m = msg as { wa_msg_id: string; sent_at: string; metadata: Record<string, unknown> | null; message_type: string; direction: string } | null
  if (!m || m.message_type !== 'location' || m.direction !== 'inbound') {
    return { ok: false, status: 404, error: 'Ubicación no encontrada en esta conversación' }
  }
  const md = m.metadata ?? {}
  if (md.location_assignment_status !== 'ambiguous') {
    return { ok: false, status: 409, error: 'Esta ubicación ya fue asociada o no requiere asociación manual' }
  }
  if (typeof md.latitude !== 'number' || typeof md.longitude !== 'number') {
    return { ok: false, status: 422, error: 'El mensaje no tiene coordenadas válidas' }
  }

  const active = await findCandidates(db as never, i.storeId, conv.phone)
  if (!active.some(c => c.id === i.orderId)) {
    return { ok: false, status: 409, error: 'El pedido ya no está activo o no pertenece a este contacto' }
  }

  const now = i.now ?? new Date().toISOString()
  // Claim atómico del pin: solo UNA asociación gana (dos agentes a la vez →
  // el segundo recibe 409). UPDATE condicionado a que siga 'ambiguous'.
  const { data: claimed } = await db.from('wa_messages').update({
    metadata: { ...md, location_assignment_status: 'assigned', location_assigned_order_id: i.orderId,
                location_assigned_by: i.userId, location_assigned_at: now },
  }).eq('id', i.messageId).eq('metadata->>location_assignment_status', 'ambiguous').select('id').maybeSingle()
  if (!claimed) return { ok: false, status: 409, error: 'Esta ubicación ya fue asociada por otro agente' }

  const { error } = await writeOrderLocation(db, i.storeId, i.orderId, {
    latitude: md.latitude, longitude: md.longitude, sentAt: m.sent_at, waMsgId: m.wa_msg_id, conversationId: i.conversationId,
  })
  if (error) {
    await db.from('wa_messages').update({ metadata: md }).eq('id', i.messageId)   // revertir el claim
    return { ok: false, status: 500, error: 'No se pudo guardar la ubicación en el pedido' }
  }

  await db.from('agent_actions').insert({
    order_id: i.orderId, agent_id: i.userId, action_type: 'note_added',
    notes: `Ubicación de WhatsApp asociada manualmente desde el Inbox (pin ambiguo, mensaje ${m.wa_msg_id}). Sin confirmación automática.`,
  })
  return { ok: true, orderId: i.orderId }
}
