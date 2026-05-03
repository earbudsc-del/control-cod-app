import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: order_id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('id, role').eq('id', user.id).single()

    if (!profile || !['admin', 'delivery_agent'].includes(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const { data: order } = await supabase
      .from('orders').select('id, normalized_status').eq('id', order_id).single()

    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })

    const { data: action, error } = await supabase
      .from('agent_actions')
      .insert({
        order_id,
        agent_id: profile.id,
        action_type: 'delivered',
        contact_result: null,
        notes: null,
      })
      .select('id, created_at')
      .single()

    if (error) throw error

    const courier_confirmed = order.normalized_status === 'delivered'

    return NextResponse.json({
      action_id:          action.id,
      reported_at:        action.created_at,
      courier_confirmed,
      pending_validation: !courier_confirmed,
    }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/reparto/orders/[id]/mark-delivered]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
