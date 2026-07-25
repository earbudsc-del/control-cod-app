import type { OrderCodLabelItem } from './types'

// Parsea orders.product_summary — un string plano construido por
// buildProductSummary() en src/app/api/webhooks/shopify/orders/route.ts:
//   items.map(item => [title, variant_title, quantity>1 ? `x${quantity}` : null]
//               .filter(Boolean).join(' - ')).join(', ')
//
// Ejemplo real de producción: "LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita
// - x3, + 2 Cepillos GRATIS - x2, Envio prioritario"
//
// Dividir por ", " no es 100% seguro si un título de producto llegara a
// contener una coma — Shopify no lo impide. Por eso el resultado se valida
// reconstruyendo el string con el MISMO algoritmo de join que usa
// buildProductSummary(): si la reconstrucción no coincide exactamente con el
// texto original, `reliable=false` y el llamador debe mostrar el texto crudo
// en vez de la lista de items parseados. Nunca se inventan productos.
export interface ParsedProductSummary {
  items: OrderCodLabelItem[]
  reliable: boolean
}

function formatSegment(item: OrderCodLabelItem): string {
  return item.quantity > 1 ? `${item.title} - x${item.quantity}` : item.title
}

export function parseProductSummary(raw: string | null | undefined): ParsedProductSummary {
  const trimmed = raw?.trim()
  if (!trimmed) return { items: [], reliable: false }

  const segments = trimmed.split(/,\s*/).map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return { items: [], reliable: false }

  const items: OrderCodLabelItem[] = segments.map(segment => {
    const match = /^(.*)\s-\sx(\d+)$/.exec(segment)
    if (match) {
      return { title: match[1].trim(), quantity: parseInt(match[2], 10) }
    }
    return { title: segment, quantity: 1 }
  })

  const reconstructed = items.map(formatSegment).join(', ')
  const reliable = reconstructed === trimmed

  return { items, reliable }
}
