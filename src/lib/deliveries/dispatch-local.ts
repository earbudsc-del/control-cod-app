import type { createServiceClient } from '@/lib/supabase/server'

type SupabaseClient = Awaited<ReturnType<typeof createServiceClient>>

export type DispatchLocalRole = 'admin' | 'dispatch_agent' | 'santo_domingo_delivery_agent'

export interface DispatchLocalResult {
  ok:           boolean
  dispatchedAt?: string
  error?:        string
}

// Único punto de escritura para la transición "Ruta preparada" del despacho
// local manual (botón "Despachar local" en /confirmados y /sd-delivery):
// normalized_status -> 'en_reparto' + agent_actions(local_dispatched).
//
// Regla 5 de docs/ARCHITECTURE_RUTA_COD_V1.md: cada salto del estado
// operativo tiene exactamente una función autorizada. Esta es esa función
// para el despacho local manual — el caller (POST /api/orders/[id]/dispatch-local)
// es responsable de validar ANTES de llamar aquí que el pedido está
// confirmado, sin guía, y que isSantoDomingoOrder() lo acepta.
//
// No confundir con el auto-despacho SD que corre dentro de
// applyConfirmationAction() (src/lib/orders/confirmation.ts) al confirmar un
// pedido — esa es una transición distinta (comercial → operativa en el mismo
// instante de la confirmación), con su propia nota de auditoría
// ("Auto-despachado al confirmar"). Tampoco reemplaza el flujo de
// confirm-client (mensajero SD, src/app/api/sd-delivery/orders/[id]/confirm-client/route.ts).
// Ambos quedan fuera del alcance de este cambio — documentados por separado
// como deuda pendiente en docs/ARCHITECTURE_RUTA_COD_V1.md (Fases 5 y 7).
export async function dispatchOrderLocally(
  supabase:  SupabaseClient,
  orderId:   string,
  actorId:   string,
  actorRole: DispatchLocalRole,
): Promise<DispatchLocalResult> {
  const now = new Date().toISOString()

  const note =
    actorRole === 'admin'
      ? 'Despachado por admin — transporte SD sin guía EFI'
      : actorRole === 'dispatch_agent'
        ? 'Despachado por agente de despacho — transporte SD sin guía EFI'
        : 'Despachado por mensajero SD — transporte local sin guía EFI'

  const [updateResult, actionResult] = await Promise.all([
    supabase
      .from('orders')
      .update({ normalized_status: 'en_reparto', status_since: now })
      .eq('id', orderId)
      .select('id'),

    supabase
      .from('agent_actions')
      .insert({
        order_id:    orderId,
        agent_id:    actorId,
        action_type: 'local_dispatched',
        notes:       note,
      }),
  ])

  if (updateResult.error) return { ok: false, error: updateResult.error.message }
  if (actionResult.error) return { ok: false, error: actionResult.error.message }

  // Detectar actualización silenciosa (0 filas afectadas)
  if (!updateResult.data || updateResult.data.length === 0) {
    return { ok: false, error: 'UPDATE returned 0 rows' }
  }

  return { ok: true, dispatchedAt: now }
}
