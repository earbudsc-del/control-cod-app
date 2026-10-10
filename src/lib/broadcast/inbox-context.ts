// Sprint C.1 — contexto de Broadcast para una conversación del Inbox.
//
// Lo que el agente necesita para atender una respuesta de campaña, leído
// SIEMPRE del estado canónico actual (orders), nunca de copias guardadas:
// cliente, pedido, estado, oferta, monto, dirección, ubicación, campaña de
// origen y botón pulsado. Las acciones comerciales (confirmar / cancelar)
// se hacen con los flujos existentes desde el detalle del pedido.

import { resolveCommercialOffer, offerContentsLine } from './offer'
import { BROADCAST_STATUS_LABELS } from './labels'
import { isWithinServiceWindow, lastInboundAt } from '@/lib/whatsapp/conversation-window'

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface BroadcastInboxContext {
  conversation_id: string
  phone_normalized: string | null
  marketing_opt_out: boolean
  window: { last_inbound_at: string | null; open: boolean }
  responses: Array<{
    id: string; intent: string; association: string; button_text: string | null
    created_at: string; handled_at: string | null; broadcast_id: string | null; order_id: string | null
  }>
  unhandled: number
  campaign: { id: string; template_name: string; status: string; status_label: string; launched_at: string | null } | null
  order: {
    id: string; order_number: string | null; customer_name: string | null; customer_phone: string | null
    confirmation_status: string | null; normalized_status: string | null; payment_status: string | null
    cod_amount: number | null; product_summary: string | null; offer_line: string | null
    address: string | null; city: string | null; province: string | null
    location: { status: string | null; received_at: string | null; has_coordinates: boolean }
    source: 'broadcast_response' | 'broadcast_sent' | 'none'
  } | null
}

export async function buildBroadcastInboxContext(
  db: SupabaseLike, storeId: string, conversationId: string, now: Date = new Date(),
): Promise<BroadcastInboxContext | null> {
  const { data: conv } = await db.from('wa_conversations')
    .select('id, store_id, contact:wa_contacts(phone_normalized)').eq('id', conversationId).eq('store_id', storeId).maybeSingle()
  if (!conv) return null
  const contactRaw = (conv as { contact: { phone_normalized: string } | { phone_normalized: string }[] | null }).contact
  const phone = (Array.isArray(contactRaw) ? contactRaw[0] : contactRaw)?.phone_normalized ?? null

  const { data: respData } = await db.from('wa_broadcast_responses')
    .select('id, intent, association, button_text, created_at, handled_at, broadcast_id, order_id')
    .eq('store_id', storeId).eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(10)
  const responses = (respData ?? []) as BroadcastInboxContext['responses']

  // Pedido/campaña: de la última respuesta asociada; si no hay, del último
  // template de Broadcast enviado en esta conversación (metadata del outbound).
  let orderId: string | null = responses.find(r => r.order_id)?.order_id ?? null
  let broadcastId: string | null = responses.find(r => r.broadcast_id)?.broadcast_id ?? null
  let source: 'broadcast_response' | 'broadcast_sent' | 'none' = orderId ? 'broadcast_response' : 'none'
  if (!orderId) {
    const { data: out } = await db.from('wa_messages').select('metadata')
      .eq('conversation_id', conversationId).eq('direction', 'outbound').eq('message_type', 'template')
      .not('metadata->>broadcast_id', 'is', null).order('sent_at', { ascending: false }).limit(1).maybeSingle()
    const md = (out as { metadata: Record<string, unknown> | null } | null)?.metadata
    if (md?.order_id) { orderId = String(md.order_id); broadcastId = broadcastId ?? (md.broadcast_id ? String(md.broadcast_id) : null); source = 'broadcast_sent' }
  }

  let campaign: BroadcastInboxContext['campaign'] = null
  if (broadcastId) {
    const { data: b } = await db.from('wa_broadcasts').select('id, template_name, status, launched_at')
      .eq('id', broadcastId).eq('store_id', storeId).maybeSingle()
    if (b) campaign = { ...(b as { id: string; template_name: string; status: string; launched_at: string | null }),
      status_label: BROADCAST_STATUS_LABELS[(b as { status: string }).status] ?? (b as { status: string }).status }
  }

  let order: BroadcastInboxContext['order'] = null
  if (orderId) {
    const { data: o } = await db.from('orders').select(
      'id, order_number, customer_name, customer_phone, confirmation_status, normalized_status, payment_status, cod_amount, ' +
      'product_summary, customer_address, city, province, sd_location_status, sd_location_received_at, sd_location_lat, sd_location_lng')
      .eq('id', orderId).eq('store_id', storeId).maybeSingle()
    if (o) {
      const r = o as Record<string, unknown>
      const offer = resolveCommercialOffer(r.product_summary as string | null, r.cod_amount as number | null)
      order = {
        id: String(r.id), order_number: (r.order_number as string) ?? null, customer_name: (r.customer_name as string) ?? null,
        customer_phone: (r.customer_phone as string) ?? null, confirmation_status: (r.confirmation_status as string) ?? null,
        normalized_status: (r.normalized_status as string) ?? null, payment_status: (r.payment_status as string) ?? null,
        cod_amount: (r.cod_amount as number) ?? null, product_summary: (r.product_summary as string) ?? null,
        offer_line: offerContentsLine(offer), address: (r.customer_address as string) ?? null,
        city: (r.city as string) ?? null, province: (r.province as string) ?? null,
        location: { status: (r.sd_location_status as string) ?? null, received_at: (r.sd_location_received_at as string) ?? null,
                    has_coordinates: typeof r.sd_location_lat === 'number' && typeof r.sd_location_lng === 'number' },
        source,
      }
    }
  }

  let optOut = false
  if (phone) {
    const { data: pref } = await db.from('wa_contact_preferences').select('marketing_opt_out')
      .eq('store_id', storeId).eq('phone_normalized', phone).maybeSingle()
    optOut = (pref as { marketing_opt_out: boolean } | null)?.marketing_opt_out === true
  }

  const last = await lastInboundAt(db, conversationId)
  return {
    conversation_id: conversationId, phone_normalized: phone, marketing_opt_out: optOut,
    window: { last_inbound_at: last, open: isWithinServiceWindow(last, now) },
    responses, unhandled: responses.filter(r => !r.handled_at).length, campaign, order,
  }
}

export async function markBroadcastResponsesHandled(db: SupabaseLike, storeId: string, conversationId: string, userId: string, now = new Date().toISOString()): Promise<number> {
  const { data, error } = await db.from('wa_broadcast_responses').update({ handled_at: now, handled_by: userId })
    .eq('store_id', storeId).eq('conversation_id', conversationId).is('handled_at', null).select('id')
  if (error) throw new Error(`wa_broadcast_responses(handled): ${error.message ?? String(error)}`)
  return (data ?? []).length
}
