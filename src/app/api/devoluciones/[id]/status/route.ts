import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

const ALLOWED_ROLES = ['admin', 'ia_supervisor', 'novelty_agent']

const VALID_STATUSES = [
  'pendiente_revision', 'revisado', 'escalado',
  'reclamo_preparado', 'reclamado', 'descartado',
]

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles').select('role, full_name').eq('id', user.id).single()
  const role = profile?.role ?? 'agent'
  if (!ALLOWED_ROLES.includes(role)) return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const { status } = body as { status?: string }

  if (!status || !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: 'Estado inválido' }, { status: 400 })
  }

  // Verificar que el pedido existe y es una devolución
  const { data: order } = await supabase
    .from('orders').select('id, normalized_status, tracking_number')
    .eq('id', id).single()

  if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })
  if (order.normalized_status !== 'returned') {
    return NextResponse.json({ error: 'El pedido no es una devolución' }, { status: 400 })
  }

  const { error } = await supabase
    .from('orders')
    .update({ return_review_status: status })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Registrar acción interna
  await supabase.from('notes').insert({
    order_id: id,
    content: `[Devolución] Estado de revisión cambiado a: ${status}`,
    created_by: user.id,
  }).select().single()

  return NextResponse.json({ success: true, status })
}
