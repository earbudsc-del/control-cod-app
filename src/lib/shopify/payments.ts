// Integración con Shopify GraphQL para marcar órdenes como pagadas
// Requiere scope: write_orders

import { shopifyGraphQL } from './client'

export interface MarkPaidResult {
  success:  boolean
  skipped?: boolean  // ya estaba pagada — no se duplicó
  error?:   string
}

interface OrderMarkAsPaidResponse {
  orderMarkAsPaid: {
    order: {
      id:              string
      financial_status?: string
    } | null
    userErrors: { field: string[]; message: string }[]
  }
}

interface OrderFinancialStatusResponse {
  order: {
    id:                     string
    displayFinancialStatus: string  // PAID | PENDING | PARTIALLY_PAID | REFUNDED | etc.
  } | null
}

// Consulta el estado financiero actual de la orden.
// NOTA: `financialStatus` no existe en Order a partir de la API version 2024-07
// (usada por SHOPIFY_API_VERSION en client.ts) — el campo vigente es
// `displayFinancialStatus`. Devuelve los mismos valores en mayúsculas (PAID,
// PENDING, etc.), así que el resto de esta función no necesita cambios.
async function getFinancialStatus(shopifyOrderGid: string): Promise<string | null> {
  const query = `
    query OrderFinancialStatus($id: ID!) {
      order(id: $id) {
        id
        displayFinancialStatus
      }
    }
  `
  try {
    const data = await shopifyGraphQL<OrderFinancialStatusResponse>(query, { id: shopifyOrderGid })
    return data.order?.displayFinancialStatus ?? null
  } catch {
    return null
  }
}

/**
 * Marca una orden COD como pagada en Shopify via GraphQL orderMarkAsPaid.
 *
 * - Solo actúa si financial_status != 'paid'
 * - Idempotente: si ya está paid, retorna { success: true, skipped: true }
 * - Si Shopify falla, retorna { success: false, error } — NO lanza excepción
 *
 * @param shopifyOrderId  ID numérico de la orden en Shopify (ej: "5678901234")
 */
export async function markOrderAsPaid(shopifyOrderId: string): Promise<MarkPaidResult> {
  try {
    const gid = `gid://shopify/Order/${shopifyOrderId}`

    // 1. Verificar estado financiero actual
    const financialStatus = await getFinancialStatus(gid)
    if (financialStatus === 'PAID') {
      return { success: true, skipped: true }
    }

    // 2. Marcar como pagada
    const mutation = `
      mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
        orderMarkAsPaid(input: $input) {
          order {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `
    const data = await shopifyGraphQL<OrderMarkAsPaidResponse>(mutation, {
      input: { id: gid },
    })

    const userErrors = data.orderMarkAsPaid?.userErrors ?? []
    if (userErrors.length > 0) {
      const msgs = userErrors.map(e => e.message).join(', ')
      // "already paid" no es un error real — idempotencia
      if (msgs.toLowerCase().includes('already paid') || msgs.toLowerCase().includes('ya está pagado')) {
        return { success: true, skipped: true }
      }
      return { success: false, error: `Shopify userErrors: ${msgs}` }
    }

    return { success: true }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
