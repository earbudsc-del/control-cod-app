import type { createServiceClient } from '@/lib/supabase/server'

type SupabaseClient = Awaited<ReturnType<typeof createServiceClient>>

export type PaymentStatus = 'pending' | 'paid'

// Fuente única de verdad: orders.payment_status (migración 046_orders_payment_status.sql,
// ya aplicada — ver también 047_agent_actions_paid_type.sql y
// 048_refresh_orders_view_payment_status.sql). El pago se escribe
// exclusivamente vía markOrderPaid() (src/lib/orders/mark-paid.ts), tanto
// desde POST /api/orders/[id]/mark-paid (Confirmación/Confirmados) como
// desde la acción 'paid' de POST /api/v1/deliveries/orders/[id]/actions
// (Ruta COD) — nunca desde este helper.
//
// Antes de la migración 046 este helper derivaba "¿ya se pagó?" de
// shopify_sync_log (event_type='mark_paid') porque no existía columna local.
// Eso ya no es correcto: un pedido puede tener payment_status='paid' sin
// ninguna fila en shopify_sync_log (pedidos no-Shopify, o el sync a Shopify
// fue omitido deliberadamente porque source != 'shopify_webhook'), y ese
// caso quedaba mal reportado como 'pending'. orders.payment_status es ahora
// el ledger persistido que antes faltaba — se lee directamente, sin
// heurísticas.
export async function fetchPaidOrderIds(
  supabase: SupabaseClient,
  orderIds: string[],
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set()

  const { data, error } = await supabase
    .from('orders')
    .select('id')
    .eq('payment_status', 'paid')
    .in('id', orderIds)

  if (error) {
    console.error('[payment-status] orders query FAILED', error.message)
    return new Set()
  }

  return new Set((data ?? []).map(row => row.id as string))
}

export function withoutPaidAction<T extends string>(allowedActions: T[], alreadyPaid: boolean): T[] {
  return alreadyPaid ? allowedActions.filter(a => a !== 'paid') : allowedActions
}
