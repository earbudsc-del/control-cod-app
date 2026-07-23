import { normalizePhoneRD } from '@/lib/normalize-phone'

// "WhatsApp" en Ruta COD: prioriza el Inbox interno de Control COD
// (wa_contacts/wa_conversations, ya usado por Confirmación/Novedad) buscando
// por order_id y, si no hay match, por teléfono normalizado. Si no existe
// conversación, cae a wa.me (fallback aprobado por el spec de Sprint 2).
//
// Nota: abrir la URL del Inbox interno requiere la sesión web (cookies) de
// Control COD, que Ruta COD no tiene todavía — se expone igual para uso
// futuro (ej. un WebView autenticado), documentado como limitación.

export interface WhatsappLink {
  kind: 'inbox' | 'external'
  url: string
  conversationId?: string
}

interface SupabaseLike {
  from: (table: string) => any
}

interface WaLinkOrderInput {
  id: string
  phone: string | null
  customerName: string | null
  orderNumber: string | null
}

function buildWaMeUrl(phone: string | null, customerName: string | null, orderNumber: string | null): string {
  const digits = phone ? normalizePhoneRD(phone) : ''
  const greeting = customerName ? `Hola ${customerName.split(' ')[0]}` : 'Hola'
  const orderRef = orderNumber ? ` (pedido ${orderNumber})` : ''
  const text = `${greeting}, te escribe tu mensajero de Control COD${orderRef}.`
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}

function inboxUrl(controlCodBaseUrl: string | null, conversationId: string): string | null {
  if (!controlCodBaseUrl) return null
  return `${controlCodBaseUrl.replace(/\/$/, '')}/inbox?conversation=${conversationId}`
}

// Batched — evita N+1: dos queries totales sin importar cuántos pedidos.
export async function resolveWhatsappLinksBatch(
  supabase: SupabaseLike,
  controlCodBaseUrl: string | null,
  orders: WaLinkOrderInput[],
): Promise<Map<string, WhatsappLink>> {
  const result = new Map<string, WhatsappLink>()
  for (const o of orders) {
    result.set(o.id, { kind: 'external', url: buildWaMeUrl(o.phone, o.customerName, o.orderNumber) })
  }
  if (orders.length === 0) return result

  try {
    const orderIds = orders.map(o => o.id)
    const phones = [...new Set(orders.map(o => (o.phone ? normalizePhoneRD(o.phone) : null)).filter(Boolean))] as string[]

    const [byOrderRes, byPhoneRes] = await Promise.all([
      supabase.from('wa_contacts').select('id, order_id').in('order_id', orderIds),
      phones.length > 0
        ? supabase.from('wa_contacts').select('id, phone_normalized').in('phone_normalized', phones)
        : Promise.resolve({ data: [] }),
    ])

    const contactIdByOrderId = new Map<string, string>()
    for (const row of byOrderRes.data ?? []) {
      if (row.order_id) contactIdByOrderId.set(row.order_id, row.id)
    }
    const contactIdByPhone = new Map<string, string>()
    for (const row of byPhoneRes.data ?? []) {
      contactIdByPhone.set(row.phone_normalized, row.id)
    }

    const contactIds = [...new Set([...contactIdByOrderId.values(), ...contactIdByPhone.values()])]
    if (contactIds.length === 0) return result

    const { data: conversations } = await supabase
      .from('wa_conversations')
      .select('id, contact_id, last_message_at')
      .in('contact_id', contactIds)
      .order('last_message_at', { ascending: false, nullsFirst: false })

    const conversationIdByContact = new Map<string, string>()
    for (const row of conversations ?? []) {
      if (!conversationIdByContact.has(row.contact_id)) conversationIdByContact.set(row.contact_id, row.id)
    }

    for (const o of orders) {
      const contactId = contactIdByOrderId.get(o.id)
        ?? (o.phone ? contactIdByPhone.get(normalizePhoneRD(o.phone)) : undefined)
      const conversationId = contactId ? conversationIdByContact.get(contactId) : undefined
      const url = conversationId ? inboxUrl(controlCodBaseUrl, conversationId) : null
      if (conversationId && url) {
        result.set(o.id, { kind: 'inbox', url, conversationId })
      }
    }
  } catch {
    // fallback ya está pre-cargado en `result` para todos los pedidos
  }

  return result
}

export async function resolveWhatsappLink(
  supabase: SupabaseLike,
  controlCodBaseUrl: string | null,
  order: WaLinkOrderInput,
): Promise<WhatsappLink> {
  const map = await resolveWhatsappLinksBatch(supabase, controlCodBaseUrl, [order])
  return map.get(order.id) ?? { kind: 'external', url: buildWaMeUrl(order.phone, order.customerName, order.orderNumber) }
}
