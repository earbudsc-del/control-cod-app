import type { createServiceClient } from '@/lib/supabase/server'
import { createLocalFulfillment } from '@/lib/shopify/fulfillments'

type SupabaseClient = Awaited<ReturnType<typeof createServiceClient>>

export interface ExecResult {
  ok: boolean
  error?: string
}

// Extraído del case 'start_route' de POST /api/v1/deliveries/orders/[id]/actions
// para reutilizarlo también desde el inicio masivo de una ruta
// (POST /api/v1/deliveries/routes/[id]/start) sin duplicar el side-effect de
// Shopify. Mismo action_type ('route_confirmed') que usa SD Delivery.
export async function executeStartRoute(
  supabase: SupabaseClient,
  orderId: string,
  agentId: string,
  shopifyOrderId: string | null,
  trackingNumber: string | null,
  source: string | null,
): Promise<ExecResult> {
  const { error: insertError } = await supabase
    .from('agent_actions')
    .insert({ order_id: orderId, agent_id: agentId, action_type: 'route_confirmed', notes: null })

  if (insertError) return { ok: false, error: insertError.message }

  if (shopifyOrderId && source === 'shopify_webhook') {
    const fulfillResult = await createLocalFulfillment(shopifyOrderId, trackingNumber)
    await supabase.from('shopify_sync_log').insert({
      order_id: orderId,
      shopify_order_id: shopifyOrderId,
      event_type: 'fulfillment',
      result: fulfillResult.success ? (fulfillResult.skipped ? 'skipped' : 'success') : 'error',
      error_message: fulfillResult.error ?? null,
      metadata: { action_type: 'route_confirmed', source: 'ruta_cod_bulk_start' },
      triggered_by: agentId,
    }).then(({ error }) => {
      if (error) console.error('[action-executors] shopify_sync_log error:', error.message)
    })
  }

  return { ok: true }
}
