export interface OrderCodLabelItem {
  title: string
  quantity: number
}

// Modelo normalizado del Sticker COD — única forma en que Control COD y
// Ruta COD reciben datos de pedido para renderizar la etiqueta. Ningún
// consumidor debe reinterpretar order rows crudos: todo pasa por
// normalizeOrderLabel() (Control COD) o por el endpoint /cod-label (Ruta COD).
export interface OrderCodLabelModel {
  orderId: string
  orderNumber: string
  createdAt: string | null
  customerName: string
  phone: string | null
  addressLines: string[]
  city: string | null
  province: string | null
  country: string
  items: OrderCodLabelItem[]
  // false cuando parseProductSummary() no pudo reconstruir el texto original
  // con confianza — el consumidor debe mostrar rawProductSummary tal cual.
  itemsReliable: boolean
  rawProductSummary: string | null
  amount: number
  currency: string
  formattedAmount: string
  deliveryLabel: string
  paymentLabel: string
  isCod: boolean
  isLocalSd: boolean
  trackingNumber: string | null
}
