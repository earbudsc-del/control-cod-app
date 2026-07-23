import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { corsHeaders } from '@/lib/cors'
import { getBearerToken, authenticateDeliveryRequest } from '@/lib/deliveries/auth'
import { checkConversationOrderAccess, resolveOrCreateConversationForOrder } from '@/lib/deliveries/conversations'
import type { SdOrderRow } from '@/lib/deliveries/sd-status'

// GET /api/v1/deliveries/orders/[id]/conversation
//
// Resuelve (o crea, si aún no existe ninguna) la conversación de WhatsApp de
// un pedido — usado por el botón "WhatsApp" de Ruta COD para abrir el Inbox
// interno incluso antes de que el cron haya enviado el mensaje automático.
// wa.me externo solo debe usarse como fallback si esto falla (spec sección 1).

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin')
  const headers = corsHeaders(origin)

  try {
    const { id: orderId } = await params
    const token = getBearerToken(request)
    if (!token) return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })

    const auth = await authenticateDeliveryRequest(token)
    if (auth.kind === 'unauthorized') return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })
    if (auth.kind === 'forbidden') return NextResponse.json({ error: 'Sin permisos' }, { status: 403, headers })
    const { userId, profile } = auth.user

    const supabase = await createServiceClient()

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, store_id, customer_name, customer_phone, city, province, customer_address, tracking_number, normalized_status, confirmation_status, assigned_to')
      .eq('id', orderId)
      .maybeSingle()

    if (orderError || !order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404, headers })
    if (order.store_id !== profile.store_id && profile.role !== 'admin') {
      return NextResponse.json({ error: 'Pedido fuera de tu tienda' }, { status: 403, headers })
    }

    const access = checkConversationOrderAccess(order as SdOrderRow, userId, profile.role)
    if (!access.allowed) {
      return NextResponse.json({ error: 'No tienes acceso a la conversación de este pedido' }, { status: 403, headers })
    }

    if (!order.customer_phone) {
      return NextResponse.json({ error: 'El pedido no tiene teléfono registrado' }, { status: 422, headers })
    }

    const conversationId = await resolveOrCreateConversationForOrder(
      supabase, order.store_id, order.id, order.customer_phone, order.customer_name,
    )

    return NextResponse.json({ conversationId }, { status: 200, headers })
  } catch (err) {
    console.error('[GET /api/v1/deliveries/orders/[id]/conversation]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}
