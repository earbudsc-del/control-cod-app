import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { normalizePhoneRD } from '@/lib/normalize-phone'

// Resuelve si existe una conversación de Inbox WhatsApp para el cliente de
// este pedido, buscando por teléfono normalizado (no por wa_contacts.order_id
// — ese campo se fija una sola vez y no es confiable para atribución 1:1
// pedido↔conversación cuando un mismo teléfono tiene varios pedidos COD).
//
// Usa el cliente de sesión (no service client) a propósito: is_wa_inbox_role()
// vía RLS filtra automáticamente tanto "no existe conversación" como "el rol
// no tiene acceso al Inbox" — ambos casos devuelven conversationId=null, sin
// necesidad de chequeo de rol manual acá. El frontend cae a wa.me externo.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: order } = await supabase
      .from('orders')
      .select('customer_phone')
      .eq('id', id)
      .maybeSingle()

    if (!order?.customer_phone) {
      return NextResponse.json({ conversationId: null })
    }

    const phoneNormalized = normalizePhoneRD(order.customer_phone)
    if (!phoneNormalized) {
      return NextResponse.json({ conversationId: null })
    }

    const { data: contact } = await supabase
      .from('wa_contacts')
      .select('id')
      .eq('phone_normalized', phoneNormalized)
      .maybeSingle()

    if (!contact) {
      return NextResponse.json({ conversationId: null })
    }

    const { data: conversations } = await supabase
      .from('wa_conversations')
      .select('id, status, last_message_at')
      .eq('contact_id', contact.id)
      .order('last_message_at', { ascending: false, nullsFirst: false })

    if (!conversations || conversations.length === 0) {
      return NextResponse.json({ conversationId: null })
    }

    const best = conversations.find(c => c.status !== 'closed') ?? conversations[0]
    return NextResponse.json({ conversationId: best.id })
  } catch (err) {
    console.error('[GET /api/orders/[id]/whatsapp-conversation]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
