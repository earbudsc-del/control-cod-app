import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isSdEligible } from '@/lib/deliveries/sd-status'
import { markSdOrderDelivered } from '@/lib/deliveries/mark-delivered'
import { markOrderPaid } from '@/lib/orders/mark-paid'

// POST /api/orders/[id]/mark-paid
//
// Botón "Pagado" de Confirmación/Confirmados. Solo para pedidos de entrega
// local Santo Domingo (isSdEligible = sin tracking_number + dirección SD).
//
// Un solo click confirma dos hechos operativos que hoy no tienen otro punto
// de entrada en estos módulos: "fue entregado" y "se cobró". Se mantienen
// conceptualmente separados (normalized_status vs payment_status, dos filas
// distintas en agent_actions) aunque se disparen juntos aquí — ver
// src/lib/orders/mark-paid.ts, que NUNCA marca entregado por su cuenta.

const ALLOWED_ROLES = ['admin', 'dispatch_agent', 'confirmation_agent']

const ORDER_FIELDS =
  'id, store_id, order_number, customer_name, city, province, customer_address, ' +
  'tracking_number, normalized_status, confirmation_status, assigned_to, ' +
  'payment_status, shopify_order_id, source'

interface OrderRow {
  id: string
  store_id: string
  order_number: string | null
  customer_name: string | null
  city: string | null
  province: string | null
  customer_address: string | null
  tracking_number: string | null
  normalized_status: string
  confirmation_status: string | null
  assigned_to: string | null
  payment_status: 'pending' | 'paid' | null
  shopify_order_id: string | null
  source: string | null
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params

    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await authClient
      .from('profiles').select('id, role, store_id').eq('id', user.id).single()

    if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos para marcar pagos' }, { status: 403 })
    }

    const supabase = await createServiceClient()

    const { data: orderData } = await supabase
      .from('orders')
      .select(ORDER_FIELDS)
      .eq('id', id)
      .single()

    if (!orderData) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })
    const order = orderData as unknown as OrderRow

    if (order.store_id !== profile.store_id) {
      return NextResponse.json({ error: 'Sin acceso a este pedido' }, { status: 403 })
    }

    if (!isSdEligible(order)) {
      return NextResponse.json({
        error: 'Este botón solo aplica a pedidos de entrega local Santo Domingo (sin guía EFI).',
      }, { status: 422 })
    }

    if (order.normalized_status === 'returned' || order.normalized_status === 'unknown') {
      return NextResponse.json({
        error: `No se puede marcar pagado un pedido en estado "${order.normalized_status}".`,
      }, { status: 422 })
    }

    let deliveredNow = false
    if (order.normalized_status !== 'delivered') {
      await markSdOrderDelivered(supabase, id, profile.id, {
        notes: `Entregado — confirmado desde /confirmados por ${profile.role}`,
      })
      deliveredNow = true
    }

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
        triggeredAction: 'mark_paid_confirmados',
        notes: `Pago registrado por ${profile.role} desde módulo de confirmación`,
      },
    )

    console.log(
      `[mark-paid] order=${id} by=${profile.id} role=${profile.role} ` +
      `deliveredNow=${deliveredNow} alreadyPaid=${paidResult.alreadyPaid}`,
    )

    return NextResponse.json({
      success: true,
      delivered_now: deliveredNow,
      already_paid: paidResult.alreadyPaid,
      paid_at: paidResult.paidAt,
      shopify_sync: paidResult.shopifySync,
    })
  } catch (err) {
    console.error('[POST /api/orders/[id]/mark-paid]', err)
    return NextResponse.json({ error: 'Error interno al marcar el pago' }, { status: 500 })
  }
}
