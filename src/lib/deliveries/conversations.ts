import { normalizePhoneRD } from '@/lib/normalize-phone'
import { isSdEligible, computeOwnership, type SdOrderRow, type Ownership } from './sd-status'

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

// Regla de acceso a conversaciones (spec Sprint 3A sección 8): solo pedidos
// SD, de la tienda del mensajero, asignados a él o disponibles, o admin.
export function checkConversationOrderAccess(
  order: SdOrderRow,
  userId: string,
  role: string,
): ConversationOrderAccess {
  if (!isSdEligible(order)) return { allowed: false, ownership: 'other' }
  const ownership = computeOwnership(order.assigned_to, userId, role)
  return { allowed: ownership !== 'other', ownership }
}
