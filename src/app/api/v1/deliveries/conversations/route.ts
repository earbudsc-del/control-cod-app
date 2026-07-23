import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { corsHeaders } from '@/lib/cors'
import { getBearerToken, authenticateDeliveryRequest } from '@/lib/deliveries/auth'
import { checkConversationOrderAccess } from '@/lib/deliveries/conversations'
import type { SdOrderRow } from '@/lib/deliveries/sd-status'

// GET /api/v1/deliveries/conversations
//
// Lista las conversaciones de WhatsApp que el mensajero de Ruta COD puede
// ver — reutiliza wa_contacts/wa_conversations/wa_messages (el mismo Inbox
// de Control COD), nunca un sistema de chat paralelo. santo_domingo_delivery_agent
// está excluido de is_wa_inbox_role() (migración 039) a propósito — este
// endpoint es el único camino autorizado para que ese rol vea conversaciones,
// con su propio filtro de alcance (spec Sprint 3A sección 8): solo pedidos
// SD, de su tienda, asignados a él o disponibles — o todo, si es admin.

interface ContactRow {
  id: string
  order_id: string | null
  phone_normalized: string
  display_name: string | null
}

interface ConversationRow {
  id: string
  status: string
  unread_count: number
  last_message_at: string | null
  last_message_preview: string | null
  contact: ContactRow | ContactRow[] | null
}

export async function GET(request: Request) {
  const origin = request.headers.get('origin')
  const headers = corsHeaders(origin)

  try {
    const token = getBearerToken(request)
    if (!token) return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })

    const auth = await authenticateDeliveryRequest(token)
    if (auth.kind === 'unauthorized') return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })
    if (auth.kind === 'forbidden') return NextResponse.json({ error: 'Sin permisos' }, { status: 403, headers })
    const { userId, profile } = auth.user

    const supabase = await createServiceClient()

    const { data: convRows, error: convError } = await supabase
      .from('wa_conversations')
      .select(
        'id, status, unread_count, last_message_at, last_message_preview, ' +
        'contact:wa_contacts(id, order_id, phone_normalized, display_name)',
      )
      .eq('store_id', profile.store_id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(200)

    if (convError) {
      console.error('[deliveries/conversations] query error', convError.message)
      return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
    }

    const rows = (convRows ?? []) as unknown as ConversationRow[]
    const withOrder = rows
      .map(row => ({ row, contact: Array.isArray(row.contact) ? row.contact[0] : row.contact }))
      .filter((r): r is { row: ConversationRow; contact: ContactRow } => Boolean(r.contact?.order_id))

    const orderIds = [...new Set(withOrder.map(r => r.contact.order_id as string))]
    if (orderIds.length === 0) {
      return NextResponse.json({ conversations: [], serverTime: new Date().toISOString() }, { status: 200, headers })
    }

    const { data: orderRows, error: orderError } = await supabase
      .from('orders')
      .select('id, order_number, customer_name, customer_phone, customer_address, city, province, tracking_number, normalized_status, confirmation_status, assigned_to, cod_amount')
      .in('id', orderIds)

    if (orderError) {
      console.error('[deliveries/conversations] orders query error', orderError.message)
      return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
    }

    type OrderRow = SdOrderRow & { order_number: string | null; customer_name: string | null; cod_amount: number | null }
    const orderById = new Map<string, OrderRow>()
    for (const o of (orderRows ?? []) as OrderRow[]) orderById.set(o.id, o)

    const conversations = []
    for (const { row, contact } of withOrder) {
      const order = orderById.get(contact.order_id as string)
      if (!order) continue
      const access = checkConversationOrderAccess(order, userId, profile.role)
      if (!access.allowed) continue

      conversations.push({
        id: row.id,
        orderId: order.id,
        orderNumber: order.order_number,
        customerName: order.customer_name ?? contact.display_name,
        phone: contact.phone_normalized,
        status: row.status,
        unreadCount: row.unread_count,
        lastMessageAt: row.last_message_at,
        lastMessagePreview: row.last_message_preview,
      })
    }

    conversations.sort((a, b) => {
      const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
      const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
      return bt - at
    })

    return NextResponse.json({ conversations, serverTime: new Date().toISOString() }, { status: 200, headers })
  } catch (err) {
    console.error('[GET /api/v1/deliveries/conversations]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}
