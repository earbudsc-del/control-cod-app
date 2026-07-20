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
  // El endpoint histórico de SD Delivery (web) no tiene un paso de "marcar
  // pagado" separado — su único mecanismo para sincronizar el cobro con
  // Shopify siempre fue marcar pagado automáticamente al entregar. Cambiar
  // eso ahora dejaría esos pedidos sin ninguna forma de quedar 'paid' en
  // Shopify, porque la web no tiene todavía un botón "Marcar pagado"
  // equivalente al de Ruta COD. Por eso ese endpoint sigue pasando
  // autoMarkPaid=true — comportamiento sin cambios para el flujo ya
  // shippeado. La API v1 de Ruta COD SIEMPRE pasa autoMarkPaid=false:
  // entregado y pagado son dos confirmaciones explícitas y separadas del
  // mensajero (regla aprobada). Si se agrega un botón "Marcar pagado" a la
  // web de SD Delivery más adelante, este flag debería pasar a false ahí
  // también y usar exclusivamente el paso de pago explícito.
  autoMarkPaid?: boolean
  shopifyOrderId?: string | null
  source?: string | null
  triggeredBy: string
  triggeredAction: string
}

export async function markSdOrderDelivered(
  supabase: SupabaseClient,
  orderId: string,
  agentId: string,
  options: MarkDeliveredOptions,
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

  if (options.autoMarkPaid && options.shopifyOrderId && options.source === 'shopify_webhook') {
    await recordMarkPaidSideEffect(supabase, {
      orderId,
      shopifyOrderId: options.shopifyOrderId,
      triggeredBy: options.triggeredBy,
      triggeredAction: options.triggeredAction,
    })
  }

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
