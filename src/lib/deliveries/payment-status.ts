import type { createServiceClient } from '@/lib/supabase/server'

type SupabaseClient = Awaited<ReturnType<typeof createServiceClient>>

export type PaymentStatus = 'pending' | 'paid'

// LIMITACIÓN CONOCIDA (documentada, no resuelta silenciosamente): no existe
// una columna local de "pagado" ni un ledger de cobros — orders no tiene
// paid_at/amount_collected. La única fuente real y ya existente que registra
// cuándo se confirmó un cobro es `shopify_sync_log` (event_type='mark_paid'),
// escrita tanto por el auto-pago histórico de mark-delivered como por la
// acción explícita 'paid'. Se reutiliza esa tabla como fuente de verdad de
// "¿ya se pagó?" en vez de inventar un estado nuevo que pueda desincronizarse
// de lo que realmente pasó en Shopify.
//
// Esto es exacto para pagos hechos a través de este flujo (delivered
// histórico o 'paid' de Ruta COD). Si un pedido se marcó pagado en Shopify
// por otra vía (ej. un admin lo edita directamente en el panel de Shopify),
// esa fila no queda en shopify_sync_log y este helper seguiría reportando
// 'pending' aunque Shopify ya diga PAID — es la brecha real de no tener un
// ledger local propio. Cerrarla requiere un ledger de cobros persistido
// (Sprint 3), no un parche aquí.
export async function fetchPaidOrderIds(
  supabase: SupabaseClient,
  orderIds: string[],
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set()

  const { data, error } = await supabase
    .from('shopify_sync_log')
    .select('order_id')
    .eq('event_type', 'mark_paid')
    .in('order_id', orderIds)
    .in('result', ['success', 'skipped'])

  if (error) {
    console.error('[payment-status] shopify_sync_log query FAILED', error.message)
    return new Set()
  }

  return new Set((data ?? []).map(row => row.order_id as string))
}

export function withoutPaidAction<T extends string>(allowedActions: T[], alreadyPaid: boolean): T[] {
  return alreadyPaid ? allowedActions.filter(a => a !== 'paid') : allowedActions
}
