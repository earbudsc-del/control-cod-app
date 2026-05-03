import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isAgentOrAbove } from '@/lib/roles'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: order_id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: assigner } = await supabase
      .from('profiles').select('id, role').eq('id', user.id).single()

    if (!assigner || !isAgentOrAbove(assigner.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const { assigned_to, reason } = await request.json()

    // Cerrar asignación vigente
    await supabase
      .from('order_assignments')
      .update({ unassigned_at: new Date().toISOString() })
      .eq('order_id', order_id)
      .is('unassigned_at', null)

    // Crear nueva asignación
    if (assigned_to) {
      await supabase.from('order_assignments').insert({
        order_id,
        assigned_to,
        assigned_by: assigner.id,
        reason: reason ?? null,
      })
    }

    // Actualizar campos en orders
    const { data, error } = await supabase
      .from('orders')
      .update({
        assigned_to:  assigned_to ?? null,
        assigned_by:  assigner.id,
        assigned_at:  assigned_to ? new Date().toISOString() : null,
      })
      .eq('id', order_id)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json(data)
  } catch (err) {
    console.error('[POST /api/orders/[id]/assign]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
