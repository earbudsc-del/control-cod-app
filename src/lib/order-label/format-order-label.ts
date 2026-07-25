import { formatDate } from '@/lib/utils'
import type { OrderCodLabelItem, OrderCodLabelModel } from './types'

export function formatOrderLabelDate(createdAt: string | null): string {
  if (!createdAt) return '—'
  return formatDate(createdAt)
}

export function formatItemLine(item: OrderCodLabelItem): string {
  return `${item.quantity} × ${item.title}`
}

// Ciudad + provincia + país en una sola línea (en vez de país en línea
// aparte) — parte de la compactación para caber en 4x6 exactas (v2).
export function buildCityProvinceCountryLine(
  model: Pick<OrderCodLabelModel, 'city' | 'province' | 'country'>,
): string {
  const line = [model.city, model.province, model.country].filter(Boolean).join(', ')
  return line || model.country
}

// Tope de caracteres para la dirección del destinatario (~3 líneas a 11px
// Arial en la columna de ~278px de la sección Destinatario). Se probó
// primero con CSS -webkit-line-clamp, pero html-to-image (captura vía SVG
// foreignObject) no reproduce el clamp+elipsis de forma fiel: recorta el
// texto pero deja un hueco en blanco y no dibuja el "…" (confirmado en
// pruebas de Fase 16/17 con el pedido real #8751, dirección de 210
// caracteres). Truncar el STRING en sí con "…" literal es consistente en
// DOM vivo, impresión y PNG exportado — nunca desaparece en silencio.
const MAX_ADDRESS_CHARS = 130

export function truncateAddress(fullAddress: string): string {
  const trimmed = fullAddress.trim()
  if (trimmed.length <= MAX_ADDRESS_CHARS) return trimmed
  const cut = trimmed.slice(0, MAX_ADDRESS_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  const safeCut = lastSpace > MAX_ADDRESS_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut
  return `${safeCut}…`
}

// Máximo de líneas de producto mostradas antes de resumir el resto. La
// etiqueta tiene alto fijo (6in) — un pedido con muchos artículos (ej. #9999,
// 5 items) no puede hacerla crecer. Se muestran los primeros items y se
// resume el resto de forma EXPLÍCITA (nunca se ocultan en silencio), con el
// total de unidades restantes conservado.
const MAX_DISPLAYED_ITEMS = 3

export interface DisplayItemsResult {
  lines: string[]
  truncated: boolean
  hiddenCount: number
  hiddenQuantity: number
}

export function buildDisplayItems(items: OrderCodLabelItem[]): DisplayItemsResult {
  if (items.length <= MAX_DISPLAYED_ITEMS) {
    return { lines: items.map(formatItemLine), truncated: false, hiddenCount: 0, hiddenQuantity: 0 }
  }
  const shown = items.slice(0, MAX_DISPLAYED_ITEMS - 1)
  const hidden = items.slice(MAX_DISPLAYED_ITEMS - 1)
  const hiddenQuantity = hidden.reduce((sum, item) => sum + item.quantity, 0)
  return {
    lines: shown.map(formatItemLine),
    truncated: true,
    hiddenCount: hidden.length,
    hiddenQuantity,
  }
}

export function sanitizeFileName(orderNumber: string): string {
  return orderNumber.replace(/[^a-zA-Z0-9-]/g, '').replace(/^-+/, '') || 'pedido'
}
