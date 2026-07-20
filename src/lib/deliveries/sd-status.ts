import { isSantoDomingoOrder } from '@/lib/alert-helpers'

// Motor de estado/transiciones compartido entre los endpoints de
// /api/v1/deliveries/** (Ruta COD). Reutiliza exactamente los mismos pools y
// reglas que src/app/(app)/sd-delivery/page.tsx (computeDisplayState) — no es
// un modelo paralelo, es la misma máquina de estados expuesta por API.

export type SdPool = 'nuevo' | 'confirmado'

export type SdStatus =
  | 'nuevo'
  | 'espera_despacho'
  | 'confirmado_listo'
  | 'en_ruta'
  | 'no_responde'
  | 'reprogramado'
  | 'entregado'
  | 'cancelado'

export type SdAction =
  | 'accept'
  | 'ready_for_route'
  | 'start_route'
  | 'delivered'
  | 'paid'
  | 'no_response'
  | 'reschedule'
  | 'customer_cancelled'
  | 'incident'
  | 'release'

export type Ownership = 'unassigned' | 'mine' | 'other'

export type LatestAction =
  | 'route_confirmed'
  | 'rescheduled'
  | 'customer_declined'
  | 'no_answer'
  | undefined

export interface SdOrderRow {
  id: string
  city: string | null
  province: string | null
  customer_address: string | null
  tracking_number: string | null
  normalized_status: string
  confirmation_status: string | null
  assigned_to: string | null
}

const TERMINAL = new Set(['delivered', 'returned', 'cancelled'])

export function isSdEligible(order: SdOrderRow): boolean {
  return !order.tracking_number && isSantoDomingoOrder(order.city, order.province, order.customer_address)
}

// Pool A (en_reparto) → 'confirmado'. Pool B (pending) / Pool C (confirmed,
// aún sin despachar) → 'nuevo'. null = fuera de los pools activos SD.
export function computePool(order: SdOrderRow): SdPool | null {
  if (order.normalized_status === 'en_reparto') return 'confirmado'
  if (TERMINAL.has(order.normalized_status)) return null
  if (order.confirmation_status === 'confirmed' || order.confirmation_status === 'pending') return 'nuevo'
  return null
}

export function computeStatus(order: SdOrderRow, pool: SdPool | null, latest: LatestAction): SdStatus {
  if (order.normalized_status === 'delivered') return 'entregado'
  if (latest === 'customer_declined') return 'cancelado'
  if (pool === 'confirmado') {
    if (latest === 'route_confirmed') return 'en_ruta'
    if (latest === 'no_answer') return 'no_responde'
    if (latest === 'rescheduled') return 'reprogramado'
    return 'confirmado_listo'
  }
  // pool === 'nuevo' (Pool B sin confirmar, o Pool C ya confirmado sin despachar)
  if (order.confirmation_status === 'confirmed') {
    if (latest === 'no_answer') return 'no_responde'
    if (latest === 'rescheduled') return 'reprogramado'
    return 'espera_despacho'
  }
  if (latest === 'no_answer') return 'no_responde'
  if (latest === 'rescheduled') return 'reprogramado'
  return 'nuevo'
}

export function computeOwnership(assignedTo: string | null, userId: string, role: string): Ownership {
  if (role === 'admin') return 'mine'
  if (!assignedTo) return 'unassigned'
  return assignedTo === userId ? 'mine' : 'other'
}

// Estados terminales — un pedido en uno de estos no admite 'release' (ya no
// tiene sentido "liberarlo de mi ruta").
const TERMINAL_SD_STATUS = new Set<SdStatus>(['entregado', 'cancelado'])

// Server-side — Ruta COD nunca decide qué transiciones son válidas.
export function computeAllowedActions(status: SdStatus, pool: SdPool | null, ownership: Ownership): SdAction[] {
  if (ownership === 'other') return []
  if (status === 'nuevo' && ownership === 'unassigned') return ['accept']

  let actions: SdAction[]
  switch (status) {
    case 'nuevo':            actions = ['ready_for_route', 'no_response']; break
    case 'espera_despacho':  actions = []; break
    case 'confirmado_listo': actions = ['start_route']; break
    case 'en_ruta':          actions = ['delivered', 'no_response', 'reschedule', 'incident']; break
    case 'no_responde':      actions = pool === 'confirmado'
      ? ['start_route', 'reschedule', 'customer_cancelled']
      : ['ready_for_route', 'reschedule', 'customer_cancelled']
      break
    case 'reprogramado':     actions = pool === 'confirmado' ? ['start_route'] : ['ready_for_route']; break
    case 'entregado':        actions = ['paid']; break
    case 'cancelado':        actions = []; break
    default:                 actions = []
  }

  // "Quitar de mi ruta" / liberar pedido — solo el mensajero dueño, y solo
  // mientras el pedido siga en un estado activo (no entregado/cancelado).
  // No requiere persistencia nueva: solo desasigna assigned_to (ver handler
  // en orders/[id]/actions/route.ts), el pedido vuelve al pool sin dueño.
  if (ownership === 'mine' && !TERMINAL_SD_STATUS.has(status)) {
    actions = [...actions, 'release']
  }

  return actions
}

// Última acción secundaria relevante (route_confirmed/rescheduled/customer_declined/no_answer)
// entre un lote de filas de agent_actions ya ordenadas created_at DESC — misma
// regla que /api/sd-delivery/sd-actions (la más reciente entre las 4 gana).
export function reduceLatestActions(
  rows: Array<{ order_id: string; action_type: string; contact_result: string | null }>,
): Map<string, LatestAction> {
  const result = new Map<string, LatestAction>()
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.order_id)) continue
    if (row.action_type === 'route_confirmed') {
      seen.add(row.order_id)
      result.set(row.order_id, 'route_confirmed')
    } else if (row.action_type === 'rescheduled') {
      seen.add(row.order_id)
      result.set(row.order_id, 'rescheduled')
    } else if (row.action_type === 'customer_declined') {
      seen.add(row.order_id)
      result.set(row.order_id, 'customer_declined')
    } else if (row.action_type === 'contacted' && row.contact_result === 'no_answer') {
      seen.add(row.order_id)
      result.set(row.order_id, 'no_answer')
    }
  }
  return result
}

// ═════════════════════════════════════════════════════════════════════════
// Fase 1 (Ruta COD v1) — Proyector de estado
// ═════════════════════════════════════════════════════════════════════════
//
// Ver docs/ARCHITECTURE_RUTA_COD_V1.md y docs/IMPLEMENTATION_PLAN_RUTA_COD_V1.md.
//
// Estas funciones NO reemplazan computePool/computeStatus/computeAllowedActions
// de arriba — coexisten. Ningún endpoint las consume todavía (eso es una fase
// posterior, con su propia validación). sd-status.ts deja de ser, a partir de
// esta sección, un motor de estados: es un PROYECTOR — nunca persiste nada,
// solo deriva de columnas que otros motores (applyConfirmationAction,
// autoAssignSdOrder, markDelivered, markPaid) ya escribieron.
//
// Separación de ejes (Principios 2 y 3 de la arquitectura):
//   - computeCommercialStatus() lee ÚNICAMENTE confirmación/ubicación. Nunca
//     lee assigned_to, assigned_at, rutas ni acciones del mensajero.
//   - computeOperationalStatus() lee ÚNICAMENTE la operación logística. Nunca
//     lee confirmation_status, customer_confirmed, confirmation_method ni
//     sd_location_status.
//   - computeDisplayStatus() combina ambos ejes para la UI. esperando_confirmacion,
//     esperando_ubicacion y confirmado_sin_asignar son estados PROYECTADOS —
//     no existen como valor persistido en ninguna columna de `orders` (regla 5).
//   - computeAllowedActionsV2() reproduce computeAllowedActions() sobre el
//     nuevo displayStatus, con las únicas diferencias intencionales anotadas
//     en su comentario.

export type CommercialStatus =
  | 'nuevo'
  | 'esperando_confirmacion'
  | 'esperando_ubicacion'
  | 'confirmado'
  | 'cancelado'

export type OperationalStatus =
  | 'sin_asignar'
  | 'asignado'
  | 'ruta_preparada'
  | 'en_recorrido'
  | 'entregado'
  | 'pagado'

export type DisplayStatus =
  | 'nuevo'
  | 'esperando_confirmacion'
  | 'esperando_ubicacion'
  | 'espera_despacho'
  | 'confirmado_sin_asignar'
  | 'confirmado_listo'
  | 'en_ruta'
  | 'no_responde'
  | 'reprogramado'
  | 'entregado'
  | 'pagado'
  | 'cancelado'

// Mismo vocabulario que ya devuelve fetchSdLocationRequestInfoBatch()
// (src/lib/deliveries/sd-location-request-status.ts) — se reutiliza el tipo,
// no se inventa uno paralelo.
export type LocationRequestStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'skipped'
  | 'failed'
  | null
  | undefined

export interface CommercialStatusInput {
  confirmation_status: string | null
  locationRequestStatus?: LocationRequestStatus
}

const COMMERCIAL_CANCELLED = new Set(['cancelled', 'no_coverage', 'unreachable'])

// Eje comercial puro. Nunca lee assigned_to/assigned_at/rutas/acciones del
// mensajero (Principio 2) — solo confirmation_status y el estado del mensaje
// automático de ubicación.
export function computeCommercialStatus(input: CommercialStatusInput): CommercialStatus {
  const { confirmation_status, locationRequestStatus } = input
  if (confirmation_status === 'confirmed') return 'confirmado'
  if (confirmation_status && COMMERCIAL_CANCELLED.has(confirmation_status)) return 'cancelado'
  if (locationRequestStatus === 'sent') return 'esperando_ubicacion'
  if (locationRequestStatus === 'pending' || locationRequestStatus === 'processing') return 'esperando_confirmacion'
  return 'nuevo'
}

export interface OperationalStatusInput {
  assigned_to: string | null
  normalized_status: string
  latestAction: LatestAction
  paymentStatus?: 'pending' | 'paid'
}

// Eje operativo puro. Nunca lee confirmation_status/customer_confirmed/
// confirmation_method/sd_location_status (Principio 3) — solo assigned_to,
// normalized_status, la acción más reciente del mensajero (para distinguir
// "ruta preparada" de "en recorrido") y el estado de pago.
export function computeOperationalStatus(input: OperationalStatusInput): OperationalStatus {
  const { assigned_to, normalized_status, latestAction, paymentStatus } = input
  if (normalized_status === 'delivered') {
    return paymentStatus === 'paid' ? 'pagado' : 'entregado'
  }
  if (normalized_status === 'en_reparto') {
    return latestAction === 'route_confirmed' ? 'en_recorrido' : 'ruta_preparada'
  }
  return assigned_to != null ? 'asignado' : 'sin_asignar'
}

// Síntesis para UI — combina los dos ejes puros de arriba, preservando
// exactamente la misma precedencia que computeStatus() tiene hoy:
//   1) entregado/pagado (normalized_status='delivered', máxima precedencia —
//      igual que hoy, que lo chequea antes que cualquier otra cosa)
//   2) cancelado (customer_declined, o rechazo comercial — el segundo nunca
//      ocurre hoy en la práctica porque el nivel de query ya excluye pedidos
//      comercialmente rechazados antes de llegar aquí, pero la función queda
//      correcta de forma standalone)
//   3) en_ruta (route_confirmed)
//   4) no_responde / reprogramado (overlays de agent_actions, igual que hoy)
//   5) confirmado_listo / espera_despacho / confirmado_sin_asignar — los
//      "default" según el eje operativo, condicionados a que el eje comercial
//      ya esté 'confirmado' (evita etiquetar como "listo para despachar" un
//      pedido que tiene assigned_to por ruido de datos pero nunca fue
//      confirmado — ver Fase 1 del plan, hallazgo de la validación)
//   6) esperando_ubicacion / esperando_confirmacion / nuevo
//
// esperando_confirmacion, esperando_ubicacion y confirmado_sin_asignar son
// PROYECTADOS — nunca se escriben en `orders` (regla 5).
export function computeDisplayStatus(
  commercial: CommercialStatus,
  operational: OperationalStatus,
  latestAction: LatestAction,
): DisplayStatus {
  if (operational === 'entregado' || operational === 'pagado') return operational
  if (latestAction === 'customer_declined') return 'cancelado'
  if (commercial === 'cancelado') return 'cancelado'
  if (operational === 'en_recorrido') return 'en_ruta'
  if (latestAction === 'no_answer') return 'no_responde'
  if (latestAction === 'rescheduled') return 'reprogramado'
  if (operational === 'ruta_preparada') return 'confirmado_listo'
  if (commercial === 'confirmado' && operational === 'asignado') return 'espera_despacho'
  if (commercial === 'confirmado' && operational === 'sin_asignar') return 'confirmado_sin_asignar'
  if (commercial === 'esperando_ubicacion') return 'esperando_ubicacion'
  if (commercial === 'esperando_confirmacion') return 'esperando_confirmacion'
  return 'nuevo'
}

const TERMINAL_DISPLAY_STATUS = new Set<DisplayStatus>(['entregado', 'pagado', 'cancelado'])

// Reproduce computeAllowedActions() sobre displayStatus. Diferencias
// intencionales respecto al modelo viejo (ninguna es una regresión):
//   - 'pagado' es ahora su propio DisplayStatus (antes era 'entregado' +
//     paymentStatus:'paid' como campo separado devuelto aparte) — sin
//     acciones pendientes, igual que 'entregado' con pago ya registrado
//     quedaba hoy tras pasar por withoutPaidAction().
//   - 'esperando_confirmacion'/'esperando_ubicacion' reciben las mismas
//     acciones excepcionales de respaldo que 'nuevo' ya asignado
//     (ready_for_route/no_response) — no existían como estados propios antes,
//     así que no hay comportamiento previo que preservar para ellos.
//   - 'confirmado_sin_asignar' recibe las mismas acciones (ninguna) que
//     'espera_despacho' recibía hoy para el mismo pedido — mismos 15 pedidos
//     reales del baseline de la Fase 0.
export function computeAllowedActionsV2(
  displayStatus: DisplayStatus,
  operational: OperationalStatus,
  ownership: Ownership,
): SdAction[] {
  if (ownership === 'other') return []
  if (displayStatus === 'nuevo' && ownership === 'unassigned') return ['accept']

  const isDispatched =
    operational === 'ruta_preparada' || operational === 'en_recorrido' ||
    operational === 'entregado'      || operational === 'pagado'

  let actions: SdAction[]
  switch (displayStatus) {
    case 'nuevo':                  actions = ['ready_for_route', 'no_response']; break
    case 'esperando_confirmacion': actions = ['ready_for_route', 'no_response']; break
    case 'esperando_ubicacion':    actions = ['ready_for_route', 'no_response']; break
    case 'espera_despacho':        actions = []; break
    case 'confirmado_sin_asignar': actions = []; break
    case 'confirmado_listo':       actions = ['start_route']; break
    case 'en_ruta':                actions = ['delivered', 'no_response', 'reschedule', 'incident']; break
    case 'no_responde':            actions = isDispatched
      ? ['start_route', 'reschedule', 'customer_cancelled']
      : ['ready_for_route', 'reschedule', 'customer_cancelled']
      break
    case 'reprogramado':           actions = isDispatched ? ['start_route'] : ['ready_for_route']; break
    case 'entregado':              actions = ['paid']; break
    case 'pagado':                 actions = []; break
    case 'cancelado':              actions = []; break
    default:                       actions = []
  }

  // Misma regla de 'release' que computeAllowedActions() hoy, sobre el nuevo
  // conjunto de estados terminales (entregado/pagado/cancelado).
  if (ownership === 'mine' && !TERMINAL_DISPLAY_STATUS.has(displayStatus)) {
    actions = [...actions, 'release']
  }

  return actions
}
