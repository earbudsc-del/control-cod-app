import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { markSdOrderDelivered } from '@/lib/deliveries/mark-delivered'
import { markOrderPaid } from '@/lib/orders/mark-paid'

const ALLOWED_ROLES = ['admin', 'santo_domingo_delivery_agent']

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: order_id } = await params
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await authClient
      .from('profiles').select('id, role').eq('id', user.id).single()

    if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const supabase = await createServiceClient()

    const { data: order } = await supabase
      .from('orders')
      .select('id, normalized_status, shopify_order_id, source, payment_status')
      .eq('id', order_id)
      .single()

    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })

    // Paso 1 — registrar la entrega (motor único markSdOrderDelivered). Se
    // omite si el pedido YA está entregado — markSdOrderDelivered no tiene
    // guard propio y crearía una fila duplicada en agent_actions
    // (action_type='delivered') en cada reintento tras un pago fallido (caso
    // real: mensajero vuelve a tocar "Marcar entregado"). Mismo guard que ya
    // usa POST /api/orders/[id]/mark-paid. Nunca escribe payment_status —
    // eso es responsabilidad exclusiva del paso 2.
    let actionId: string | null = null
    let reportedAt = new Date().toISOString()
    if (order.normalized_status !== 'delivered') {
      const delivery = await markSdOrderDelivered(supabase, order_id, profile.id, {
        notes: 'Entregado por mensajero local SD',
      })
      actionId   = delivery.actionId
      reportedAt = delivery.reportedAt
    }

    // Paso 2 — registrar el pago vía el motor único markOrderPaid()
    // (src/lib/orders/mark-paid.ts) — el mismo que usan el botón "Pagado" de
    // Confirmación/Confirmados y la acción 'paid' de Ruta COD. Actualiza
    // payment_status/paid_at/paid_by, inserta agent_actions(action_type='paid')
    // y sincroniza Shopify una sola vez (no se duplica aquí). Es idempotente:
    // si el pedido ya estaba pagado, no crea un segundo evento ni reemplaza
    // paid_at/paid_by (ver markOrderPaid). Este flujo web histórico de SD
    // Delivery siempre marcó pagado junto con la entrega — ese comportamiento
    // se conserva, solo que ahora escribe el ledger local además de Shopify.
    //
    // La entrega del paso 1 ya quedó registrada en DB independientemente de
    // lo que pase aquí — si este paso falla, no se revierte la entrega (no
    // hay transacción real entre ambos pasos), pero el fallo se refleja en la
    // respuesta para no afirmar éxito completo cuando hay una divergencia.
    let paymentStatus: 'pending' | 'paid' = order.payment_status ?? 'pending'
    let paidAt: string | null = null
    let paymentError: string | null = null
    try {
      const paidResult = await markOrderPaid(
        supabase,
        {
          id: order.id,
          payment_status: order.payment_status ?? 'pending',
          shopify_order_id: order.shopify_order_id,
          source: order.source,
        },
        profile.id,
        {
          triggeredBy: profile.id,
          triggeredAction: 'sd_delivery_mark_delivered',
          notes: 'Pago registrado automáticamente al marcar entregado (SD Delivery)',
        },
      )
      paymentStatus = 'paid'
      paidAt = paidResult.paidAt
    } catch (err) {
      paymentError = err instanceof Error ? err.message : 'Error desconocido al registrar el pago'
      console.error(`[sd-delivery/mark-delivered] markOrderPaid FAILED order=${order_id}`, err)
    }

    console.log(
      `[sd-delivery/mark-delivered] order=${order_id} by=${profile.id} role=${profile.role} ` +
      `payment_status=${paymentStatus} payment_error=${paymentError ?? 'none'}`,
    )

    return NextResponse.json({
      action_id:         actionId,
      reported_at:       reportedAt,
      local_confirmed:   true,
      courier_confirmed: false,
      payment_status:    paymentStatus,
      paid_at:           paidAt,
      payment_error:     paymentError,
    }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/sd-delivery/orders/[id]/mark-delivered]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
