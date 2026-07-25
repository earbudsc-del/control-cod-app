import { isSantoDomingoOrder } from '@/lib/alert-helpers'

// Elegibilidad para el mensaje automático SD de confirmación + solicitud de
// ubicación (Sprint 3A, spec sección 2). Compartido entre el webhook de
// Shopify (que encola el job) y el cron de wa_template_queue (que re-valida
// antes de enviar — el pedido puede haber cambiado de estado entre el
// encolado y el envío).
export const SD_LOCATION_REQUEST_TEMPLATE_NAME = 'sd_location_request'

export interface SdLocationEligibleOrder {
  city: string | null
  province: string | null
  customer_address: string | null
  tracking_number: string | null
  normalized_status: string
  customer_phone: string | null
}

const NOT_ACTIVE = new Set(['delivered', 'returned', 'cancelled'])

export function isSdLocationRequestEligible(order: SdLocationEligibleOrder): boolean {
  if (!order.customer_phone) return false          // teléfono válido
  if (order.tracking_number) return false          // no courier externo (EFI)
  if (NOT_ACTIVE.has(order.normalized_status)) return false // pedido activo, no cancelado/entregado/devuelto
  return isSantoDomingoOrder(order.city, order.province, order.customer_address) // cobertura interna SD
}
