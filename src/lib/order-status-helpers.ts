import type { Order } from '@/types'

/**
 * Guía cancelada/anulada en Effi.
 * Cubre raw_status: "Anulada", "Cancelada por transportadora", etc.
 */
export function isCancelledGuide(o: Order): boolean {
  const r = (o.raw_status ?? '').toLowerCase()
  return r.includes('anulad') || r.includes('cancelad')
}

/**
 * Guía creada en Effi pero sin movimiento real (tab "Generadas").
 * - Requiere tracking_number (ya existe en Effi)
 * - raw_status contiene "generada"
 * - No está anulada/cancelada
 * - No está en estado terminal o post-tránsito
 */
export function isGeneratedActive(o: Order): boolean {
  if (!o.tracking_number) return false
  const r = (o.raw_status ?? '').toLowerCase()
  if (!r.includes('generada')) return false
  if (isCancelledGuide(o)) return false
  const terminal = ['returned', 'delivered', 'novedad', 'en_reparto'] as const
  return !terminal.includes(o.normalized_status as never)
}

/**
 * Guía en movimiento real hacia destino (tab "En tránsito").
 * - Requiere tracking_number
 * - normalized_status='in_transit'
 * - No es "Generada" (sin movimiento real)
 * - No está anulada/cancelada
 */
export function isTransitActive(o: Order): boolean {
  if (!o.tracking_number) return false
  if (o.normalized_status !== 'in_transit') return false
  if (isCancelledGuide(o)) return false
  const r = (o.raw_status ?? '').toLowerCase()
  return !r.includes('generada')
}
