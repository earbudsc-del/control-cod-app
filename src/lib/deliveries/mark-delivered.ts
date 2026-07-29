import type { createServiceClient } from '@/lib/supabase/server'
import { markOrderAsPaid } from '@/lib/shopify/payments'

type SupabaseClient = Awaited<ReturnType<typeof createServiceClient>>

// Único punto de escritura para "marcar entregado" en pedidos SD locales.
// Usado por:
//   - POST /api/sd-delivery/orders/[id]/mark-delivered (endpoint histórico,
//     consumido por la página web /sd-delivery)
//   - la acción 'delivered' de POST /api/v1/deliveries/orders/[id]/actions
//     (Ruta COD)
// No duplicar este UPDATE+INSERT en ningún otro archivo — si el flujo de
// entrega necesita un campo o efecto nuevo, se agrega aquí una sola vez.

export interface MarkDeliveredResult {
  actionId: string
  reportedAt: string
}

export interface MarkDeliveredOptions {
  notes?: string
}

// Responsabilidad deliberadamente acotada a la ENTREGA — no toca
// payment_status ni sincroniza Shopify. Antes esta función tenía un flag
// autoMarkPaid que llamaba a recordMarkPaidSideEffect() directamente, lo que
// solo sincronizaba Shopify sin escribir orders.payment_status/paid_at/paid_by
// en DB local — causaba divergencia (pedido "pagado" en Shopify pero
// 'pending' localmente). Fix: quien necesite marcar entregado Y pagado en el
// mismo flujo (ver POST /api/sd-delivery/orders/[id]/mark-delivered) debe
// llamar a esta función y luego, por separado, al motor único markOrderPaid()
// (src/lib/orders/mark-paid.ts) — el mismo que ya usan Confirmación/Confirmados
// y Ruta COD. Así no se duplica lógica de pago en dos sitios.
export async function markSdOrderDelivered(
  supabase: SupabaseClient,
  orderId: string,
  agentId: string,
  options: MarkDeliveredOptions = {},
): Promise<MarkDeliveredResult> {
  const now = new Date().toISOString()

  const [{ error: updateError }, { data: action, error: actionError }] = await Promise.all([
    supabase.from('orders').update({
      normalized_status: 'delivered',
      last_tracking_update: now,
      follow_up_result: 'delivered',
    }).eq('id', orderId),
    supabase.from('agent_actions').insert({
      order_id: orderId,
      agent_id: agentId,
      action_type: 'delivered',
      contact_result: null,
      notes: options.notes ?? 'Entregado por mensajero local SD',
    }).select('id, created_at').single(),
  ])

  if (updateError) throw updateError
  if (actionError) throw actionError

  return { actionId: action!.id, reportedAt: action!.created_at }
}

export interface MarkPaidSideEffectParams {
  orderId: string
  shopifyOrderId: string
  triggeredBy: string
  triggeredAction: string
}

export interface MarkPaidSideEffectResult {
  success: boolean
  skipped?: boolean
  error?: string
}

// Llama a markOrderAsPaid (idempotente en Shopify — no duplica el cobro) y
// deja el registro de auditoría en shopify_sync_log. Reutilizado por el
// auto-pago histórico de mark-delivered (SD Delivery web) y por la acción
// explícita 'paid' de la API v1 (Ruta COD) — un solo punto de escritura.
export async function recordMarkPaidSideEffect(
  supabase: SupabaseClient,
  params: MarkPaidSideEffectParams,
): Promise<MarkPaidSideEffectResult> {
  const paidResult = await markOrderAsPaid(params.shopifyOrderId)

  const { error: logErr } = await supabase.from('shopify_sync_log').insert({
    order_id: params.orderId,
    shopify_order_id: params.shopifyOrderId,
    event_type: 'mark_paid',
    result: paidResult.success ? (paidResult.skipped ? 'skipped' : 'success') : 'error',
    error_message: paidResult.error ?? null,
    metadata: { triggered_action: params.triggeredAction },
    triggered_by: params.triggeredBy,
  })
  if (logErr) console.error('[mark-delivered] shopify_sync_log error:', logErr.message)

  return paidResult
}
