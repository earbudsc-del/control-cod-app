import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params

    // Auth con cliente normal para leer sesión del usuario
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await authClient
      .from('profiles').select('id, role, store_id').eq('id', user.id).single()

    const canDispatch =
      profile?.role === 'admin' ||
      profile?.role === 'dispatch_agent' ||
      profile?.role === 'santo_domingo_delivery_agent'
    if (!canDispatch) {
      return NextResponse.json({ error: 'Sin permisos para despachar localmente' }, { status: 403 })
    }

    // Service client para las operaciones DB (evita bloqueos RLS en edge cases)
    const supabase = await createServiceClient()

    const { data: order } = await supabase
      .from('orders')
      .select('id, store_id, confirmation_status, tracking_number, normalized_status')
      .eq('id', id)
      .single()

    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })

    // Verificar que el pedido pertenece a la misma tienda del admin
    if (order.store_id !== profile.store_id) {
      return NextResponse.json({ error: 'Sin acceso a este pedido' }, { status: 403 })
    }

    if (order.confirmation_status !== 'confirmed') {
      return NextResponse.json({
        error: `El pedido no está confirmado (estado actual: ${order.confirmation_status})`,
      }, { status: 422 })
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

    const [updateResult, actionResult] = await Promise.all([
      supabase
        .from('orders')
        .update({ normalized_status: 'en_reparto', status_since: now })
        .eq('id', id)
        .select('id'),

      supabase
        .from('agent_actions')
        .insert({
          order_id:    id,
          agent_id:    profile.id,
          action_type: 'local_dispatched',
          notes:       profile.role === 'admin'
            ? 'Despachado por admin — transporte SD sin guía EFI'
            : profile.role === 'dispatch_agent'
              ? 'Despachado por agente de despacho — transporte SD sin guía EFI'
              : 'Despachado por mensajero SD — transporte local sin guía EFI',
        }),
    ])

    if (updateResult.error) throw updateResult.error
    if (actionResult.error) throw actionResult.error

    // Detectar actualización silenciosa (0 filas afectadas)
    if (!updateResult.data || updateResult.data.length === 0) {
      console.error(`[dispatch-local] UPDATE returned 0 rows — order=${id}`)
      return NextResponse.json({ error: 'No se pudo actualizar el pedido' }, { status: 500 })
    }

    console.log(`[dispatch-local] order=${id} by=${profile.id} role=${profile.role} → en_reparto`)

    return NextResponse.json({ success: true, dispatched_at: now })
  } catch (err) {
    console.error('[POST /api/orders/[id]/dispatch-local]', err)
    return NextResponse.json({ error: 'Error interno al despachar' }, { status: 500 })
  }
}
