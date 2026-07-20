import type { createServiceClient } from '@/lib/supabase/server'
import { recordMarkPaidSideEffect, type MarkPaidSideEffectResult } from '@/lib/deliveries/mark-delivered'

type SupabaseClient = Awaited<ReturnType<typeof createServiceClient>>

// Único punto de escritura para "marcar pagado" en cualquier pedido COD.
// Usado por:
//   - POST /api/orders/[id]/mark-paid (botón "Pagado" en Confirmación/Confirmados)
//   - a futuro, el case 'paid' de POST /api/v1/deliveries/orders/[id]/actions
//     (Ruta COD) — no duplicar esta lógica ahí, importar esta función.
//
// Responsabilidad deliberadamente acotada al lado del PAGO — no toca
// normalized_status ni marca "entregado". Ruta COD ya exige status='entregado'
// antes de permitir su acción 'paid' (ver sd-status.ts computeAllowedActions),
// así que esta función asume que la entrega, si corresponde, ya se resolvió
// por separado (ver markSdOrderDelivered en mark-delivered.ts). El endpoint
// que orquesta "Pagado" desde Confirmación/Confirmados es responsable de
// llamar a markSdOrderDelivered primero cuando el pedido aún no esté
// entregado — esta función nunca lo hace por su cuenta.

export interface MarkOrderPaidInput {
  id: string
  payment_status: 'pending' | 'paid'
  shopify_order_id: string | null
  source: string | null
}

export interface MarkOrderPaidOptions {
  triggeredBy: string
  triggeredAction: string
  notes?: string
}

export interface MarkOrderPaidResult {
  alreadyPaid: boolean
  paidAt: string
  actionId?: string
  shopifySync: MarkPaidSideEffectResult | null
}

export async function markOrderPaid(
  supabase: SupabaseClient,
  order: MarkOrderPaidInput,
  agentId: string,
  options: MarkOrderPaidOptions,
): Promise<MarkOrderPaidResult> {
  // Idempotencia — un segundo intento (doble tap, retry, refresh) no debe
  // crear otra fila en agent_actions ni volver a invocar Shopify.
  if (order.payment_status === 'paid') {
    const { data: existing } = await supabase
      .from('orders')
      .select('paid_at')
      .eq('id', order.id)
      .single()
    return { alreadyPaid: true, paidAt: existing?.paid_at ?? new Date().toISOString(), shopifySync: null }
  }

  const now = new Date().toISOString()

  const { data: updated, error: updateError } = await supabase
    .from('orders')
    .update({ payment_status: 'paid', paid_at: now, paid_by: agentId })
    .eq('id', order.id)
    .eq('payment_status', 'pending')
    .select('id, paid_at')

  if (updateError) throw updateError

  if (!updated || updated.length === 0) {
    // Carrera perdida — otro request lo marcó pagado entre el fetch y este
    // UPDATE. Tratar como ya pagado, sin duplicar auditoría ni Shopify.
    const { data: fresh } = await supabase.from('orders').select('paid_at').eq('id', order.id).single()
    return { alreadyPaid: true, paidAt: fresh?.paid_at ?? now, shopifySync: null }
  }

  const { data: action, error: actionError } = await supabase
    .from('agent_actions')
    .insert({
      order_id: order.id,
      agent_id: agentId,
      action_type: 'paid',
      contact_result: null,
      notes: options.notes ?? 'Pago registrado (COD cobrado)',
    })
    .select('id, created_at')
    .single()

  if (actionError) throw actionError

  let shopifySync: MarkPaidSideEffectResult | null = null
  if (order.shopify_order_id && order.source === 'shopify_webhook') {
    shopifySync = await recordMarkPaidSideEffect(supabase, {
      orderId: order.id,
      shopifyOrderId: order.shopify_order_id,
      triggeredBy: options.triggeredBy,
      triggeredAction: options.triggeredAction,
    })
  }

  return {
    alreadyPaid: false,
    paidAt: updated[0].paid_at,
    actionId: action?.id,
    shopifySync,
  }
}
