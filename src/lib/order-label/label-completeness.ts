import type { Order } from '@/types'

export interface LabelCompleteness {
  complete: boolean
  missingFields: string[]
}

// Función pura — detecta si un pedido tiene los datos mínimos para imprimir un
// Sticker COD legible. Nunca inventa datos: solo reporta qué falta para que el
// agente decida (revisar el pedido o excluirlo del lote). Usada exclusivamente
// por el endpoint batch (POST /api/orders/cod-labels/batch) antes de imprimir.
export function checkLabelCompleteness(order: Order): LabelCompleteness {
  const missingFields: string[] = []

  if (!order.customer_name?.trim()) missingFields.push('Nombre del cliente')
  if (!order.customer_phone?.trim()) missingFields.push('Teléfono')
  if (!order.customer_address?.trim()) missingFields.push('Dirección')
  if (!order.cod_amount || order.cod_amount <= 0) missingFields.push('Monto COD')

  return { complete: missingFields.length === 0, missingFields }
}
