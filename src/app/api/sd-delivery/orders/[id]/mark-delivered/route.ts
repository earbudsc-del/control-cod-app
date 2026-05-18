import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { markOrderAsPaid } from '@/lib/shopify/payments'

const ALLOWED_ROLES = ['admin', 'santo_domingo_delivery_agent']

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: order_id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('id, role').eq('id', user.id).single()

    if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const { data: order } = await supabase
      .from('orders')
      .select('id, normalized_status, shopify_order_id, source')
      .eq('id', order_id)
      .single()

    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })

    // Para entregas locales SD: marcar como entregado directamente (sin esperar a EFI)
    const now = new Date().toISOString()

    const [{ error: updateError }, { data: action, error: actionError }] = await Promise.all([
      supabase
        .from('orders')
        .update({
          normalized_status:    'delivered',
          last_tracking_update: now,
          follow_up_result:     'delivered',
        })
        .eq('id', order_id),

      supabase
        .from('agent_actions')
        .insert({
          order_id,
          agent_id:       profile.id,
          action_type:    'delivered',
          contact_result: null,
          notes:          'Entregado por mensajero local SD',
        })
        .select('id, created_at')
        .single(),
    ])

    if (updateError) throw updateError
    if (actionError) throw actionError

    console.log(`[sd-delivery/mark-delivered] order=${order_id} by=${profile.id} role=${profile.role}`)

    // ── Sincronización Shopify: marcar como pagada (COD entregado = cobrado) ──
    if (order.shopify_order_id && order.source === 'shopify_webhook') {
      const paidResult = await markOrderAsPaid(order.shopify_order_id)

      // Log de sincronización — sin bloquear respuesta
      const logEntry = {
        order_id,
        shopify_order_id: order.shopify_order_id,
        event_type:       'mark_paid',
        result:           paidResult.success
          ? (paidResult.skipped ? 'skipped' : 'success')
          : 'error',
        error_message:    paidResult.error ?? null,
        metadata:         { triggered_action: 'mark-delivered' },
        triggered_by:     profile.id,
      }

      supabase.from('shopify_sync_log').insert(logEntry).then(({ error: logErr }) => {
        if (logErr) console.error('[mark-delivered] shopify_sync_log error:', logErr.message)
      })

      if (paidResult.success) {
        console.log(
          `[sd-delivery/mark-delivered] Shopify mark_paid ${paidResult.skipped ? 'ya estaba pagada' : 'OK'} — order=${order_id} shopify=${order.shopify_order_id}`,
        )
      } else {
        console.warn(
          `[sd-delivery/mark-delivered] Shopify mark_paid FALLÓ (flujo local OK) — order=${order_id} shopify=${order.shopify_order_id} error=${paidResult.error}`,
        )
      }
    }

    return NextResponse.json({
      action_id:         action!.id,
      reported_at:       action!.created_at,
      local_confirmed:   true,
      courier_confirmed: false,
    }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/sd-delivery/orders/[id]/mark-delivered]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
