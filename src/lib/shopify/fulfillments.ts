// Integración con Shopify Fulfillments API (2024-07)
// Requiere scopes: write_fulfillments, read_fulfillments, read_orders, write_orders

import { shopifyRestUrl, shopifyHeaders } from './client'

export interface FulfillmentResult {
  success:        boolean
  skipped?:       boolean  // ya estaba fulfillado — no se duplicó
  fulfillment_id?: string
  error?:         string
}

interface ShopifyFulfillmentOrder {
  id:                   number
  status:               string   // 'open' | 'in_progress' | 'success' | 'cancelled' | 'incomplete' | 'closed'
  assigned_location_id: number | null
  line_items:           { id: number }[]
}

interface ShopifyOrderFulfillmentStatus {
  fulfillment_status: string | null   // null | 'fulfilled' | 'partial' | 'restocked'
  financial_status:   string          // 'pending' | 'paid' | 'refunded' | etc.
}

// Verifica si la orden ya está fulfillada en Shopify.
async function getOrderStatus(shopifyOrderId: string): Promise<ShopifyOrderFulfillmentStatus | null> {
  try {
    const res = await fetch(
      shopifyRestUrl(`orders/${shopifyOrderId}.json?fields=id,fulfillment_status,financial_status`),
      { headers: shopifyHeaders() },
    )
    if (!res.ok) return null
    const { order } = (await res.json()) as { order: ShopifyOrderFulfillmentStatus }
    return order
  } catch {
    return null
  }
}

// Obtiene los fulfillment orders abiertos para una orden.
async function getOpenFulfillmentOrders(shopifyOrderId: string): Promise<ShopifyFulfillmentOrder[]> {
  const res = await fetch(
    shopifyRestUrl(`orders/${shopifyOrderId}/fulfillment_orders.json`),
    { headers: shopifyHeaders() },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Shopify fulfillment_orders ${res.status}: ${text}`)
  }
  const { fulfillment_orders } = (await res.json()) as { fulfillment_orders: ShopifyFulfillmentOrder[] }
  return (fulfillment_orders ?? []).filter(fo => fo.status === 'open' || fo.status === 'in_progress')
}

/**
 * Crea un fulfillment local en Shopify para órdenes SD (sin tracking EFI externo).
 *
 * - Idempotente: si ya está fulfilled, retorna { success: true, skipped: true }
 * - Si Shopify falla, retorna { success: false, error } — NO lanza excepción
 *   para que el flujo local siga funcionando
 * - trackingNumber opcional: si se provee, se adjunta al fulfillment
 */
export async function createLocalFulfillment(
  shopifyOrderId: string,
  trackingNumber?: string | null,
): Promise<FulfillmentResult> {
  try {
    // 1. Verificar si ya está fulfillada
    const orderStatus = await getOrderStatus(shopifyOrderId)
    if (orderStatus?.fulfillment_status === 'fulfilled') {
      return { success: true, skipped: true }
    }

    // 2. Obtener fulfillment orders abiertas
    const openFOs = await getOpenFulfillmentOrders(shopifyOrderId)
    if (openFOs.length === 0) {
      // Sin FOs abiertas: puede que la orden ya esté cerrada o no sea fulfillable
      return { success: true, skipped: true }
    }

    // 3. Crear fulfillment via Fulfillment Orders API
    const body: Record<string, unknown> = {
      fulfillment: {
        line_items_by_fulfillment_order: openFOs.map(fo => ({
          fulfillment_order_id:        fo.id,
          fulfillment_order_line_items: fo.line_items.map(li => ({ id: li.id })),
        })),
        notify_customer: false,
      },
    }

    if (trackingNumber) {
      body.fulfillment = {
        ...(body.fulfillment as object),
        tracking_info: {
          number:  trackingNumber,
          company: 'SD Local',
          url:     null,
        },
      }
    }

    const res = await fetch(shopifyRestUrl('fulfillments.json'), {
      method:  'POST',
      headers: shopifyHeaders(),
      body:    JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      return { success: false, error: `Shopify ${res.status}: ${text}` }
    }

    const { fulfillment } = (await res.json()) as { fulfillment: { id: number } }
    return { success: true, fulfillment_id: String(fulfillment.id) }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
