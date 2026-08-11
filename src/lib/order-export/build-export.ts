import type { Order } from '@/types'

// Helpers puros y client-side para exportar una selección de pedidos a TXT o
// a una vista imprimible (PDF vía window.print, ver ExportOrdersButton). No
// tocan `orders` ni ningún endpoint — solo formatean los pedidos que la
// página ya tiene cargados en memoria (misma selección que alimenta
// PrintCodLabelsBatchButton).

export interface ExportRow {
  orderNumber: string | null
  customerName: string
  phone: string | null
  city: string | null
  address: string | null
  product: string | null
  amount: string | null   // ya formateado "RD$2,100"
  tracking: string | null
}

function formatAmount(amount: number | null): string | null {
  if (amount == null) return null
  return `RD$${Math.round(amount).toLocaleString('es-DO')}`
}

export function toExportRow(order: Order): ExportRow {
  return {
    orderNumber: order.order_number,
    customerName: order.customer_name?.trim() || 'Cliente sin nombre',
    phone: order.customer_phone?.trim() || null,
    city: order.city?.trim() || null,
    address: order.customer_address?.trim() || null,
    product: order.product_summary?.trim() || null,
    amount: formatAmount(order.cod_amount),
    tracking: order.tracking_number?.trim() || null,
  }
}

function todayLabelRD(): string {
  return new Date().toLocaleDateString('es-DO', {
    timeZone: 'America/Santo_Domingo', day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

export function buildOrdersTxt(orders: Order[], scopeLabel: string): string {
  const rows = orders.map(toExportRow)
  const lines: string[] = [
    `PEDIDOS ${scopeLabel.toUpperCase()}`,
    `Fecha: ${todayLabelRD()}`,
    `Total: ${rows.length} pedido${rows.length !== 1 ? 's' : ''}`,
    '',
  ]

  rows.forEach((row, i) => {
    lines.push(`${i + 1}. ${row.customerName}`)
    if (row.phone)      lines.push(`📞 ${row.phone}`)
    if (row.city)        lines.push(`📍 ${row.city}`)
    if (row.address)    lines.push(`🏠 ${row.address}`)
    if (row.product)    lines.push(`📦 ${row.product}`)
    if (row.amount)     lines.push(`💵 ${row.amount}`)
    if (row.orderNumber) lines.push(`#️⃣ Pedido ${row.orderNumber}`)
    if (row.tracking)   lines.push(`🔖 Guía ${row.tracking}`)
    lines.push('')
  })

  return lines.join('\n').trimEnd() + '\n'
}

function slugify(text: string): string {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

export function buildExportFilename(scopeLabel: string, ext: 'txt' | 'pdf'): string {
  const dateISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' })
  return `pedidos-${slugify(scopeLabel)}-${dateISO}.${ext}`
}

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
