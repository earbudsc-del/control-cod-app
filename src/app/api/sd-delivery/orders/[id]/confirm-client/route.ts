import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const ALLOWED_ROLES = ['admin', 'santo_domingo_delivery_agent']

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: order_id } = await params

    // Auth con cliente normal para leer sesión
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await authClient
      .from('profiles').select('id, role, store_id').eq('id', user.id).single()

    if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    // Service client para operaciones DB — necesario mientras is_agent_or_above()
    // no incluya 'santo_domingo_delivery_agent' en la DB (migration 026 lo corrige
    // de forma definitiva; este service client actúa como respaldo inmediato).
    const supabase = await createServiceClient()

    const { data: order } = await supabase
      .from('orders').select('id, store_id, confirmation_status').eq('id', order_id).single()

    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })

    // Verificar que el pedido pertenece a la misma tienda
    if (order.store_id !== profile.store_id) {
      return NextResponse.json({ error: 'Sin acceso a este pedido' }, { status: 403 })
    }

    if (order.confirmation_status === 'confirmed') {
      return NextResponse.json({ error: 'El pedido ya está confirmado' }, { status: 409 })
    }

    const now = new Date().toISOString()

    const [
      { error: updateError },
      { data: action, error: actionError },
      { error: dispatchError },
    ] = await Promise.all([
      // Phase 1 SD V2: también salta a en_reparto en la misma llamada,
      // eliminando el paso intermedio de espera_despacho del admin.
      supabase
        .from('orders')
        .update({
          confirmation_status:       'confirmed',
          customer_confirmed:        true,
          customer_confirmed_at:     now,
          last_confirmation_attempt: now,
          confirmation_method:       'call',
          normalized_status:         'en_reparto',
          status_since:              now,
        })
        .eq('id', order_id),

      supabase
        .from('agent_actions')
        .insert({
          order_id,
          agent_id:    profile.id,
          action_type: 'confirmed',
          notes:       'Confirmado por mensajero SD (cliente confirmó recepción)',
        })
        .select('id, created_at')
        .single(),

      supabase
        .from('agent_actions')
        .insert({
          order_id,
          agent_id:    profile.id,
          action_type: 'local_dispatched',
          notes:       'Despachado automáticamente al confirmar — transporte local SD sin guía EFI',
        }),
    ])

    if (updateError) {
      console.error('[confirm-client] orders update error:', updateError)
      throw updateError
    }
    if (actionError) {
      console.error('[confirm-client] agent_actions insert error:', actionError)
      throw actionError
    }
    if (dispatchError) {
      // Solo auditoría — el pedido ya fue confirmado y despachado correctamente.
      console.error('[confirm-client] local_dispatched insert error (non-fatal):', dispatchError)
    }

    console.log(`[sd-delivery/confirm-client] order=${order_id} by=${profile.id} → en_reparto`)

    return NextResponse.json({
      action_id:    action!.id,
      confirmed_at: action!.created_at,
    }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/sd-delivery/orders/[id]/confirm-client]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
