// Sprint C.1 — find-or-create de wa_contact + wa_conversation activa.
//
// Mismo patrón que ya usan el webhook y el processor de automations
// (incluido el manejo de la carrera 23505 → releer), extraído para el
// processor de Broadcast. No reemplaza las copias existentes (no se tocan).
// Un contacto existente NO se re-vincula a otro pedido aquí: el vínculo
// wa_contacts.order_id lo gobierna contact-order.ts.

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function ensureContactAndConversation(
  db: SupabaseLike,
  i: { storeId: string; phoneNormalized: string; displayName: string | null; orderId: string | null },
): Promise<{ contactId: string; conversationId: string }> {
  const findContact = async () => {
    const { data } = await db.from('wa_contacts').select('id')
      .eq('store_id', i.storeId).eq('phone_normalized', i.phoneNormalized).maybeSingle()
    return (data as { id: string } | null)?.id ?? null
  }

  let contactId = await findContact()
  if (!contactId) {
    const { data, error } = await db.from('wa_contacts').insert({
      store_id: i.storeId, phone_normalized: i.phoneNormalized, wa_id: i.phoneNormalized,
      display_name: i.displayName, order_id: i.orderId,
    }).select('id').single()
    if (error) {
      if (error.code !== '23505') throw new Error(`wa_contacts(insert): ${error.message ?? String(error)}`)
      contactId = await findContact()
      if (!contactId) throw new Error('wa_contacts: conflicto sin fila al releer')
    } else {
      contactId = (data as { id: string }).id
    }
  }

  const findConv = async () => {
    const { data } = await db.from('wa_conversations').select('id')
      .eq('contact_id', contactId).neq('status', 'closed')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    return (data as { id: string } | null)?.id ?? null
  }

  let conversationId = await findConv()
  if (!conversationId) {
    const { data, error } = await db.from('wa_conversations').insert({
      store_id: i.storeId, contact_id: contactId, status: 'open', unread_count: 0,
    }).select('id').single()
    if (error) {
      if (error.code !== '23505') throw new Error(`wa_conversations(insert): ${error.message ?? String(error)}`)
      conversationId = await findConv()
      if (!conversationId) throw new Error('wa_conversations: conflicto sin fila al releer')
    } else {
      conversationId = (data as { id: string }).id
    }
  }

  return { contactId: contactId!, conversationId: conversationId! }
}
