import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getInboxAgentContext } from '@/lib/whatsapp/inbox-auth'
import { assignLocationToOrder, listPendingLocationAssignments } from '@/lib/whatsapp/inbound-location'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET — pins de ubicación AMBIGUOS (varios pedidos SD activos) aún sin asociar
 * en esta conversación + los pedidos activos candidatos del contacto. READ ONLY.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getInboxAgentContext()
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { id } = await params
    const data = await listPendingLocationAssignments(await createServiceClient(), auth.storeId, id)
    if (!data) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
    return NextResponse.json({ data })
  } catch (err) {
    console.error('[GET location-assignment]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

/**
 * POST — el agente asocia un pin ambiguo a UN pedido.
 * Body: { message_id, order_id }
 * Revalida tienda, contacto y que el pedido siga activo. Guarda la ubicación
 * en el pedido (mismo formato que el flujo automático) y audita en
 * agent_actions. NO confirma ni despacha: eso sigue en los flujos canónicos.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getInboxAgentContext()
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { id } = await params
    const body = await request.json().catch(() => null) as { message_id?: unknown; order_id?: unknown } | null
    const messageId = typeof body?.message_id === 'string' && UUID_RE.test(body.message_id) ? body.message_id : null
    const orderId = typeof body?.order_id === 'string' && UUID_RE.test(body.order_id) ? body.order_id : null
    if (!messageId || !orderId) return NextResponse.json({ error: 'message_id y order_id (UUID) requeridos' }, { status: 400 })

    const r = await assignLocationToOrder(await createServiceClient(),
      { storeId: auth.storeId, conversationId: id, messageId, orderId, userId: auth.userId })
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    console.log(`[inbox] ubicación asociada manualmente — conv=${id} order=${r.orderId} by=${auth.userId}`)
    return NextResponse.json({ ok: true, order_id: r.orderId })
  } catch (err) {
    console.error('[POST location-assignment]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
