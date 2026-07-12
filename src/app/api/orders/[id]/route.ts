import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const [orderRes, notesRes, actionsRes, assignmentsRes, attemptsRes, historyRes] =
      await Promise.all([
        supabase.from('orders_with_sla').select('*').eq('id', id).single(),
        supabase.from('notes')
          .select('*, profile:profiles!created_by(full_name)')
          .eq('order_id', id).order('created_at', { ascending: false }),
        supabase.from('agent_actions')
          .select('*, profile:profiles!agent_id(full_name)')
          .eq('order_id', id).order('created_at', { ascending: false }),
        supabase.from('order_assignments')
          .select('*, assigned_profile:profiles!assigned_to(full_name), assigned_by_profile:profiles!assigned_by(full_name)')
          .eq('order_id', id).order('assigned_at', { ascending: false }),
        supabase.from('delivery_attempt_records')
          .select('*').eq('order_id', id).order('attempt_number'),
        supabase.from('order_history')
          .select('*, profile:profiles!changed_by(full_name)')
          .eq('order_id', id).order('created_at', { ascending: false }).limit(30),
      ])

    if (orderRes.error) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })

    return NextResponse.json({
      order:       orderRes.data,
      notes:       notesRes.data ?? [],
      actions:     actionsRes.data ?? [],
      assignments: assignmentsRes.data ?? [],
      attempts:    attemptsRes.data ?? [],
      history:     historyRes.data ?? [],
    })
  } catch (err) {
    console.error('[GET /api/orders/[id]]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const body = await request.json()

    // Solo estos campos son modificables manualmente
    const allowed = [
      'classification', 'is_at_risk', 'follow_up_result',
      'normalized_status', 'customer_confirmed',
    ]
    const update: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in body) update[key] = body[key]
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Sin campos válidos para actualizar' }, { status: 400 })
    }

    // Motor de Novedades: marcar "No salvable" es una gestión real del agente,
    // aunque no pase por /actions (no inserta agent_actions — es una decisión
    // administrativa, no un contacto). Se registra igual en last_action_at.
    if (update.follow_up_result === 'no_action') {
      update.last_action_at = new Date().toISOString()
    }

    const { data, error } = await supabase
      .from('orders')
      .update(update)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json(data)
  } catch (err) {
    console.error('[PATCH /api/orders/[id]]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
