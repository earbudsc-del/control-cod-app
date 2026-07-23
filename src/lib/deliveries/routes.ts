import { detectSdZone, type ZoneId } from '@/lib/sd-zones'
import {
  isSdEligible,
  computePool,
  computeStatus,
  computeOwnership,
  computeAllowedActions,
  type SdOrderRow,
  type LatestAction,
  type SdStatus,
} from '@/lib/deliveries/sd-status'

// "Rutas" derivadas — Sprint 2 (Complemento de múltiples rutas).
//
// No existe todavía una entidad persistente de ruta en Control COD (se
// revisó: no hay `delivery_routes`/`delivery_route_stops`, ni tabla
// equivalente). Crear esa persistencia ahora habría ampliado demasiado este
// sprint (tablas + migraciones + reconciliación con SD Delivery + consola
// admin) — se documenta como Sprint 3 Parte B, según el propio plan de
// fallback del pedido.
//
// Para este sprint, una "ruta" es un agrupamiento DERIVADO en el servidor
// (nunca en el estado de React) de los pedidos SD ya asignados al mensajero
// y despachados (pool='confirmado', normalized_status='en_reparto'),
// agrupados por zona real (detectSdZone — la misma lógica que usa SD
// Delivery, sin listas nuevas). El id de la ruta es estable dentro del día
// (`${zoneId}_${YYYY-MM-DD}` en hora RD) para que sea direccionable vía
// GET /routes/[id] entre requests sin persistirlo aparte.
//
// Lo que esto SÍ y NO garantiza (documentar en cualquier UI que consuma
// esto, no solo aquí):
//   • Se derivan de los pedidos actuales del mensajero — no de una tabla de rutas.
//   • No existe todavía `delivery_routes` ni `delivery_route_stops`.
//   • El orden de las paradas (`stop.sequence`) NO es persistente — se
//     recalcula por prioridad operativa en cada request.
//   • Una recarga puede dar una ruta con distinto id/paradas si el conjunto
//     de pedidos asignados cambió entre requests (ej. otro pedido se aceptó
//     o se entregó).
//   • El admin todavía NO puede crear, reordenar ni mover pedidos entre
//     rutas — esa consola requiere la persistencia formal (Sprint 3).

export interface RouteOrderRow extends SdOrderRow {
  order_number: string | null
  customer_name: string | null
  customer_phone: string | null
  cod_amount: number | null
  latitude?: number | null
  longitude?: number | null
  created_at: string
  status_since: string | null
  last_tracking_update: string | null
  updated_at: string
}

export interface DerivedStop {
  sequence: number
  orderId: string
  orderNumber: string | null
  customerName: string | null
  phone: string | null
  address: string | null
  amountToCollect: number | null
  status: SdStatus
  latitude: number | null
  longitude: number | null
  hasLocation: boolean
  allowedActions: string[]
}

export interface DerivedRoute {
  id: string
  name: string
  zoneKey: ZoneId
  status: 'pendiente' | 'activa' | 'completada'
  scheduledDate: string
  stopsCount: number
  stopsWithLocation: number
  stopsPendingLocation: number
  codTotal: number
  delivered: number
  courierId: string | null
}

function rdToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(new Date())
}

// Prioridad visual/operativa dentro de una ruta — mismo criterio que
// actionPriorityTier() en sd-delivery/page.tsx: en_ruta primero (ya salió),
// luego confirmado_listo (listo para salir), luego el resto.
function priorityTier(status: SdStatus): number {
  if (status === 'en_ruta') return 0
  if (status === 'confirmado_listo') return 1
  return 2
}

export interface BuildRoutesParams {
  orders: RouteOrderRow[]
  latestByOrder: Map<string, LatestAction>
  courierId: string
  role: string
}

// Devuelve las rutas derivadas (para el listado) y, por ruta, sus stops ya
// ordenados por prioridad — todo calculado una sola vez para reusar en
// GET /routes y GET /routes/[id] sin dos recorridos distintos.
export function buildDerivedRoutes(params: BuildRoutesParams): { routes: DerivedRoute[]; stopsByRoute: Map<string, DerivedStop[]> } {
  const { orders, latestByOrder, courierId, role } = params
  const today = rdToday()

  const byZone = new Map<string, RouteOrderRow[]>()
  for (const order of orders) {
    if (!isSdEligible(order)) continue
    const pool = computePool(order)
    if (pool !== 'confirmado') continue // solo pedidos ya despachados cuentan como "parada de ruta"
    const zone = detectSdZone(order.city, order.province, order.customer_address)
    const list = byZone.get(zone.id) ?? []
    list.push(order)
    byZone.set(zone.id, list)
  }

  const routes: DerivedRoute[] = []
  const stopsByRoute = new Map<string, DerivedStop[]>()

  for (const [zoneId, zoneOrders] of byZone) {
    const zone = detectSdZone(zoneOrders[0].city, zoneOrders[0].province, zoneOrders[0].customer_address)
    const routeId = `${zoneId}_${today}`

    const stops: DerivedStop[] = zoneOrders.map(order => {
      const latest = latestByOrder.get(order.id)
      const status = computeStatus(order, 'confirmado', latest)
      const ownership = computeOwnership(order.assigned_to, courierId, role)
      return {
        sequence: 0, // se asigna tras ordenar
        orderId: order.id,
        orderNumber: order.order_number,
        customerName: order.customer_name,
        phone: order.customer_phone,
        address: order.customer_address,
        amountToCollect: order.cod_amount,
        status,
        latitude: order.latitude ?? null,
        longitude: order.longitude ?? null,
        hasLocation: order.latitude != null && order.longitude != null,
        allowedActions: computeAllowedActions(status, 'confirmado', ownership),
      }
    })

    stops.sort((a, b) => {
      const tierDiff = priorityTier(a.status) - priorityTier(b.status)
      if (tierDiff !== 0) return tierDiff
      return 0
    })
    stops.forEach((s, i) => { s.sequence = i + 1 })

    const stopsWithLocation = stops.filter(s => s.hasLocation).length
    const delivered = stops.filter(s => s.status === 'entregado').length
    const terminal = stops.filter(s => s.status === 'entregado' || s.status === 'cancelado').length
    const hasActive = stops.some(s => s.status === 'en_ruta')

    routes.push({
      id: routeId,
      name: zone.routeLabel,
      zoneKey: zone.id,
      status: terminal === stops.length && stops.length > 0 ? 'completada' : hasActive ? 'activa' : 'pendiente',
      scheduledDate: today,
      stopsCount: stops.length,
      stopsWithLocation,
      stopsPendingLocation: stops.length - stopsWithLocation,
      codTotal: stops.reduce((sum, s) => sum + (s.amountToCollect ?? 0), 0),
      delivered,
      courierId,
    })
    stopsByRoute.set(routeId, stops)
  }

  return { routes, stopsByRoute }
}
