import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('id, role').eq('id', user.id).single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins pueden despachar localmente' }, { status: 403 })
    }

    const { data: order } = await supabase
      .from('orders')
      .select('id, confirmation_status, tracking_number, normalized_status')
      .eq('id', id)
      .single()

    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })

    if (order.confirmation_status !== 'confirmed') {
      return NextResponse.json({ error: 'El pedido no está confirmado' }, { status: 422 })
    }

    if (order.tracking_number !== null) {
      return NextResponse.json({
        error: 'El pedido tiene guía EFI — no es transporte local SD',
      }, { status: 422 })
    }

    if (order.normalized_status === 'en_reparto') {
      return NextResponse.json({ error: 'El pedido ya está despachado' }, { status: 409 })
    }

    const now = new Date().toISOString()

    const [{ error: updateError }, { error: actionError }] = await Promise.all([
      supabase
        .from('orders')
        .update({ normalized_status: 'en_reparto', status_since: now })
        .eq('id', id),

      supabase
        .from('agent_actions')
        .insert({
          order_id:    id,
          agent_id:    profile.id,
          action_type: 'status_updated',
          notes:       'Despachado localmente — transporte SD sin guía EFI',
        }),
    ])

    if (updateError) throw updateError
    if (actionError) throw actionError

    console.log(`[dispatch-local] order=${id} by=${profile.id}`)

    return NextResponse.json({ success: true, dispatched_at: now })
  } catch (err) {
    console.error('[POST /api/orders/[id]/dispatch-local]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
