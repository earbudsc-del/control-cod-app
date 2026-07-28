import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isSantoDomingoOrder } from '@/lib/alert-helpers'
import { dispatchOrderLocally, type DispatchLocalRole } from '@/lib/deliveries/dispatch-local'

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
      .select('id, store_id, confirmation_status, tracking_number, normalized_status, city, province, customer_address')
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

    // Cobertura geográfica: "Despachar local" es exclusivo de Santo
    // Domingo/DN. Pedidos de otras provincias deben salir por EFI/Gintracom
    // — nunca por este flujo. Reutiliza el motor geográfico central
    // (isSantoDomingoOrder) en vez de duplicar una lista de zonas aquí. Ver
    // auditoría 2026-07-28: los pedidos #10798/#10800 (La Romana) quedaron
    // marcados como despacho local por error, sin guía, invisibles en
    // /confirmados hasta que se les asignó guía EFI manualmente.
    if (!isSantoDomingoOrder(order.city, order.province, order.customer_address)) {
      return NextResponse.json({
        error: 'Este pedido no pertenece a la cobertura local de Santo Domingo y debe despacharse mediante EFI/Gintracom.',
      }, { status: 422 })
    }

    if (order.normalized_status === 'en_reparto') {
      return NextResponse.json({ error: 'El pedido ya está despachado' }, { status: 409 })
    }

    const result = await dispatchOrderLocally(supabase, id, profile.id, profile.role as DispatchLocalRole)

    if (!result.ok) {
      console.error(`[dispatch-local] order=${id} error=${result.error}`)
      return NextResponse.json({ error: 'No se pudo actualizar el pedido' }, { status: 500 })
    }

    console.log(`[dispatch-local] order=${id} by=${profile.id} role=${profile.role} → en_reparto`)

    return NextResponse.json({ success: true, dispatched_at: result.dispatchedAt })
  } catch (err) {
    console.error('[POST /api/orders/[id]/dispatch-local]', err)
    return NextResponse.json({ error: 'Error interno al despachar' }, { status: 500 })
  }
}
