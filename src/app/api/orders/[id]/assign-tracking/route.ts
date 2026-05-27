import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    const canAssign = profile?.role === 'admin' || profile?.role === 'dispatch_agent'
    if (!canAssign) {
      return NextResponse.json({ error: 'Sin permisos para asignar guías' }, { status: 403 })
    }

    const body = await request.json()
    const tracking_number: string = (body.tracking_number ?? '').toString().trim()

    if (!tracking_number) {
      return NextResponse.json({ error: 'El número de guía es requerido' }, { status: 400 })
    }

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, confirmation_status, tracking_number')
      .eq('id', id)
      .single()

    if (orderErr || !order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })
    }

    if (order.confirmation_status !== 'confirmed') {
      return NextResponse.json({ error: 'El pedido no está confirmado' }, { status: 422 })
    }

    if (order.tracking_number !== null) {
      return NextResponse.json({ error: 'El pedido ya tiene una guía asignada' }, { status: 422 })
    }

    // Verificar que la guía no esté asignada a otro pedido
    const { data: duplicate } = await supabase
      .from('orders')
      .select('id, order_number')
      .eq('tracking_number', tracking_number)
      .neq('id', id)
      .limit(1)
      .maybeSingle()

    if (duplicate) {
      return NextResponse.json({
        error: `La guía ${tracking_number} ya está asignada al pedido ${duplicate.order_number ?? duplicate.id}`,
      }, { status: 422 })
    }

    const { data: updated, error: updateErr } = await supabase
      .from('orders')
      .update({
        tracking_number,
        normalized_status: 'in_transit',
      })
      .eq('id', id)
      .select('id, tracking_number, normalized_status')
      .single()

    if (updateErr) throw updateErr

    // Registrar en agent_actions para auditoría y métricas de rendimiento
    await supabase.from('agent_actions').insert({
      order_id:    id,
      agent_id:    user.id,
      action_type: 'tracking_assigned',
      notes:       `Guía EFI asignada: ${tracking_number}`,
    })

    console.log(`[assign-tracking] orderId=${id} tracking=${tracking_number} assignedBy=${user.id}`)

    return NextResponse.json({ success: true, order: updated })
  } catch (err) {
    console.error('[PATCH /api/orders/[id]/assign-tracking]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
