import type { Order } from '@/types'
import { isSdEligible } from '@/lib/deliveries/sd-status'
import { formatCurrency } from '@/lib/utils'
import { parseProductSummary } from './parse-product-summary'
import type { OrderCodLabelModel } from './types'
import { DELIVERY_LABEL_COURIER, DELIVERY_LABEL_SD, PAYMENT_LABEL_COD } from './constants'

// Función pura — sin fetch, sin DB, sin Shopify. Fuente única de verdad para
// transformar un order row (ya autorizado y ya cargado) en el modelo del
// Sticker COD. Usada tanto por el endpoint v1 (server-side, para Ruta COD)
// como directamente en el cliente por Control COD (el order ya está en
// memoria vía /api/orders/[id] — sin fetch adicional).
export function normalizeOrderLabel(order: Order): OrderCodLabelModel {
  const isLocalSd = isSdEligible({
    id: order.id,
    city: order.city,
    province: order.province,
    customer_address: order.customer_address,
    tracking_number: order.tracking_number || null,
    normalized_status: order.normalized_status,
    confirmation_status: order.confirmation_status ?? null,
    assigned_to: order.assigned_to,
  })

  const { items, reliable } = parseProductSummary(order.product_summary)

  const addressLines = [order.customer_address]
    .filter((v): v is string => !!v && v.trim().length > 0)
    .map(v => v.trim())

  const amount = order.cod_amount ?? 0

  return {
    orderId: order.id,
    orderNumber: order.order_number?.trim() || 'S/N',
    createdAt: order.shopify_created_at ?? order.created_at ?? null,
    customerName: order.customer_name?.trim() || 'Cliente',
    phone: order.customer_phone?.trim() || null,
    addressLines,
    city: order.city?.trim() || null,
    province: order.province?.trim() || null,
    country: 'República Dominicana',
    items,
    itemsReliable: reliable,
    rawProductSummary: order.product_summary,
    amount,
    currency: 'DOP',
    formattedAmount: formatCurrency(amount),
    deliveryLabel: isLocalSd ? DELIVERY_LABEL_SD : DELIVERY_LABEL_COURIER,
    paymentLabel: PAYMENT_LABEL_COD,
    // Esta versión no distingue pedidos prepagados: no existe payment_method
    // en el esquema (ver auditoría 2026-07-24). Todo pedido visible en el
    // sticker se asume COD, por decisión explícita del negocio.
    isCod: true,
    isLocalSd,
    trackingNumber: order.tracking_number || null,
  }
}
