import type { Order } from '@/types'

/**
 * Timestamp base para calcular tiempo estancado en tránsito.
 * Prioridad: status_since (fecha real del estado EFI) →
 *            shipment_created_at (creación envío EFI) →
 *            shopify_created_at (creación pedido Shopify) →
 *            created_at (fallback DB)
 *
 * NO usar last_tracking_update: el cron lo sobrescribe a "ahora()" en cada
 * sync aunque el estado no haya cambiado, haciendo que guías estancadas
 * meses aparezcan como "Hace menos de 1h".
 */
export function transitSinceMs(order: Order): number {
  const ts =
    order.status_since        ??
    order.shipment_created_at ??
    order.shopify_created_at  ??
    order.created_at
  return new Date(ts).getTime()
}

export function horasEnTransito(order: Order): number {
  return (Date.now() - transitSinceMs(order)) / (1000 * 60 * 60)
}

export function transitCriticality(order: Order): 'critico' | 'riesgo' | 'normal' {
  const h = horasEnTransito(order)
  if (h >= 48) return 'critico'
  if (h >= 24) return 'riesgo'
  return 'normal'
}

export function sinMovimientoLabel(order: Order): string {
  const h    = horasEnTransito(order)
  const dias = Math.floor(h / 24)
  const hrs  = Math.floor(h % 24)
  if (h < 1)      return 'Hace menos de 1h'
  if (h < 24)     return `Hace ${Math.floor(h)}h`
  if (dias === 1) return hrs > 0 ? `Hace 1d ${hrs}h` : 'Hace 1 día'
  return hrs > 0 ? `Hace ${dias}d ${hrs}h` : `Hace ${dias} días`
}

export const TRANSIT_STYLES = {
  critico: { badge: 'bg-red-100 text-red-700',       dot: 'bg-red-500 animate-pulse', label: '+48h · Crítico',    row: 'bg-red-50/20 hover:bg-red-50/40'       },
  riesgo:  { badge: 'bg-yellow-100 text-yellow-800', dot: 'bg-yellow-500',            label: '1-2 días · Riesgo', row: 'bg-yellow-50/20 hover:bg-yellow-50/40'  },
  normal:  { badge: 'bg-green-100 text-green-700',   dot: 'bg-green-500',             label: '0-1 día · Normal',  row: 'hover:bg-gray-50/40'                    },
} as const
