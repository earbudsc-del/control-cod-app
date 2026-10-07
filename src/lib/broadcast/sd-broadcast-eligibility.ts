// Sprint Broadcast A — dominio de elegibilidad del broadcast estándar SD.
//
// Única fuente de verdad server-side para decidir qué pedidos pueden recibir
// el template sd_broadcast_confirmation. Funciones PURAS: no leen DB, no
// envían nada. El futuro endpoint de creación de broadcast (Sprint B) carga
// los pedidos y las filas existentes de wa_template_queue y delega aquí —
// nunca confía en una selección hecha por el frontend.
//
// Geografía: isSantoDomingoOrder() (src/lib/alert-helpers.ts), que ya usa
// SD_COVERAGE_TERMS de src/lib/sd-zones.ts. NO se crea una tercera lista de
// zonas. SD_FILTER (confirmacion/pedidos + confirmacion/stats) NO se usa
// aquí — ver auditoría scripts/audit-sd-classification-matrix.ts.

import { isSantoDomingoOrder } from '@/lib/alert-helpers'
import { normalizePhone } from '@/lib/customers/normalize-phone'

export const SD_BROADCAST_TEMPLATE_NAME = 'sd_broadcast_confirmation'

// Versión de la regla — se guarda en wa_broadcasts.eligibility_rule_version
// para que cada broadcast sea auditable contra la regla con que se armó.
export const SD_BROADCAST_ELIGIBILITY_RULE_VERSION = 'sd_standard_v1'

// Códigos de área dominicanos. El broadcast es exclusivamente para clientes
// SD: un número NANP de otro código de área se excluye (fail-closed).
const DR_AREA_CODES = new Set(['809', '829', '849'])

export interface BroadcastCandidateOrder {
  id:                      string
  store_id:                string
  source:                  string | null
  shopify_order_id:        string | null
  is_test:                 boolean | null
  archived_at:             string | null
  customer_phone:          string | null
  city:                    string | null
  province:                string | null
  customer_address:        string | null
  confirmation_status:     string | null
  normalized_status:       string | null
  payment_status:          string | null
  tracking_number:         string | null
  sd_location_received_at: string | null
}

// Fila existente de wa_template_queue para (order_id, SD_BROADCAST_TEMPLATE_NAME).
export interface ExistingBroadcastQueueRow {
  order_id: string
  status:   string
}

export type BroadcastExcludedReason =
  | 'not_shopify_order'
  | 'test_or_archived'
  | 'confirmed'
  | 'cancelled'
  | 'unreachable'
  | 'confirmation_not_pending'
  | 'paid'
  | 'delivered'
  | 'returned'
  | 'external_tracking'
  | 'not_santo_domingo'
  | 'invalid_phone'
  | 'broadcast_already_active'
  | 'broadcast_already_sent'
  | 'broadcast_previous_attempt'
  | 'multiple_active_orders_same_phone'

export type BroadcastWarning = 'location_received_but_pending'

export type OrderEligibility =
  | { eligible: true;  phone_normalized: string; warnings: BroadcastWarning[] }
  | { eligible: false; reason: BroadcastExcludedReason }

function isBlank(v: string | null | undefined): boolean {
  return v == null || v.trim() === ''
}

/**
 * Teléfono apto para broadcast → formato de wa_template_queue.phone_normalized
 * (solo dígitos, con '1', ej. '18095551234' — mismo formato que
 * normalizePhoneRD produce para números válidos). null si no es un número
 * dominicano inequívoco.
 */
export function normalizeBroadcastPhone(raw: string | null | undefined): string | null {
  const r = normalizePhone(raw)
  if (!r.valid || r.country_code !== '1' || !r.national_number) return null
  if (r.national_number.length !== 10) return null
  if (!DR_AREA_CODES.has(r.national_number.slice(0, 3))) return null
  return `1${r.national_number}`
}

/**
 * Elegibilidad individual de un pedido (sin considerar otros pedidos del
 * mismo teléfono — eso lo resuelve classifyBroadcastCandidates).
 * El orden de las reglas es determinístico: se reporta la PRIMERA que falla.
 */
export function evaluateOrderEligibility(
  order: BroadcastCandidateOrder,
  existingRow: ExistingBroadcastQueueRow | null,
): OrderEligibility {
  // 1. Pedido Shopify real.
  if (order.source !== 'shopify_webhook' || isBlank(order.shopify_order_id)) {
    return { eligible: false, reason: 'not_shopify_order' }
  }
  if (order.is_test === true || order.archived_at != null) {
    return { eligible: false, reason: 'test_or_archived' }
  }

  // 2. Confirmación: solo pending.
  switch (order.confirmation_status) {
    case 'pending':     break
    case 'confirmed':   return { eligible: false, reason: 'confirmed' }
    case 'cancelled':   return { eligible: false, reason: 'cancelled' }
    case 'unreachable': return { eligible: false, reason: 'unreachable' }
    default:            return { eligible: false, reason: 'confirmation_not_pending' }
  }

  // 3. Estado comercial/logístico terminal.
  if (order.payment_status === 'paid')         return { eligible: false, reason: 'paid' }
  if (order.normalized_status === 'delivered') return { eligible: false, reason: 'delivered' }
  if (order.normalized_status === 'returned')  return { eligible: false, reason: 'returned' }

  // 4. Courier externo (incluye Novedad con tracking).
  if (!isBlank(order.tracking_number)) return { eligible: false, reason: 'external_tracking' }

  // 5. Santo Domingo operativo — fuente canónica.
  if (!isSantoDomingoOrder(order.city, order.province, order.customer_address)) {
    return { eligible: false, reason: 'not_santo_domingo' }
  }

  // 6. Teléfono.
  const phone = normalizeBroadcastPhone(order.customer_phone)
  if (!phone) return { eligible: false, reason: 'invalid_phone' }

  // 7. Broadcast previo de este tipo para el mismo pedido. Cualquier fila
  // existente bloquea: además UNIQUE(order_id, template_name) en
  // wa_template_queue impediría insertar otra.
  if (existingRow) {
    if (existingRow.status === 'pending' || existingRow.status === 'processing') {
      return { eligible: false, reason: 'broadcast_already_active' }
    }
    if (existingRow.status === 'sent') return { eligible: false, reason: 'broadcast_already_sent' }
    return { eligible: false, reason: 'broadcast_previous_attempt' }
  }

  // Ubicación recibida + pending: se permite, pero se marca — normalmente
  // debió auto-confirmarse.
  const warnings: BroadcastWarning[] = order.sd_location_received_at ? ['location_received_but_pending'] : []
  return { eligible: true, phone_normalized: phone, warnings }
}

export interface BroadcastEligibleOrder {
  order_id:         string
  store_id:         string
  phone_normalized: string
  warnings:         BroadcastWarning[]
}

export interface BroadcastExcludedOrder {
  order_id:        string
  excluded_reason: BroadcastExcludedReason
}

export interface BroadcastClassification {
  eligible:           BroadcastEligibleOrder[]
  excluded:           BroadcastExcludedOrder[]
  excluded_by_reason: Partial<Record<BroadcastExcludedReason, number>>
}

/**
 * Clasificación completa de un conjunto de candidatos.
 *
 * order_id es la unidad comercial; el teléfono normalizado es la unidad de
 * contacto. Si un mismo teléfono tiene 2+ pedidos individualmente elegibles,
 * NINGUNO se envía automáticamente: todos quedan excluidos como
 * 'multiple_active_orders_same_phone' para revisión manual (no se elige uno
 * arbitrariamente ni se envían dos mensajes).
 *
 * `contextOrders` (opcional): otros pedidos activos de la tienda que NO son
 * candidatos de esta selección pero cuentan para la ambigüedad. Si el admin
 * selecciona 1 de 2 pedidos elegibles del mismo teléfono, el seleccionado
 * igual queda excluido — el cliente tiene otro pedido pendiente. Los
 * contextOrders nunca aparecen en eligible/excluded.
 */
export function classifyBroadcastCandidates(
  orders: BroadcastCandidateOrder[],
  existingRows: ExistingBroadcastQueueRow[],
  contextOrders: BroadcastCandidateOrder[] = [],
): BroadcastClassification {
  const rowByOrder = new Map(existingRows.map(r => [r.order_id, r]))

  const individuallyEligible: BroadcastEligibleOrder[] = []
  const excluded: BroadcastExcludedOrder[] = []
  const seen = new Set<string>()

  for (const o of orders) {
    if (seen.has(o.id)) continue // id duplicado en la entrada: se evalúa una sola vez
    seen.add(o.id)
    const r = evaluateOrderEligibility(o, rowByOrder.get(o.id) ?? null)
    if (r.eligible) {
      individuallyEligible.push({ order_id: o.id, store_id: o.store_id, phone_normalized: r.phone_normalized, warnings: r.warnings })
    } else {
      excluded.push({ order_id: o.id, excluded_reason: r.reason })
    }
  }

  const countByPhone = new Map<string, number>()
  for (const e of individuallyEligible) {
    countByPhone.set(e.phone_normalized, (countByPhone.get(e.phone_normalized) ?? 0) + 1)
  }
  for (const o of contextOrders) {
    if (seen.has(o.id)) continue // ya contado como candidato
    seen.add(o.id)
    const r = evaluateOrderEligibility(o, rowByOrder.get(o.id) ?? null)
    if (r.eligible) countByPhone.set(r.phone_normalized, (countByPhone.get(r.phone_normalized) ?? 0) + 1)
  }

  const eligible: BroadcastEligibleOrder[] = []
  for (const e of individuallyEligible) {
    if ((countByPhone.get(e.phone_normalized) ?? 0) > 1) {
      excluded.push({ order_id: e.order_id, excluded_reason: 'multiple_active_orders_same_phone' })
    } else {
      eligible.push(e)
    }
  }

  const excluded_by_reason: Partial<Record<BroadcastExcludedReason, number>> = {}
  for (const x of excluded) excluded_by_reason[x.excluded_reason] = (excluded_by_reason[x.excluded_reason] ?? 0) + 1

  return { eligible, excluded, excluded_by_reason }
}

// ── Aislamiento del backlog ───────────────────────────────────────────────────
//
// Contrato de selección que DEBE usar el futuro processor de Broadcast
// (Sprint C). Nunca `status='pending'` a secas: siempre el broadcast actual
// + el template de broadcast. Las filas históricas (broadcast_id NULL) no
// pueden coincidir — además la migración 064 impide por CHECK + trigger que
// una fila histórica reciba broadcast_id.

export interface BroadcastQueueSelector {
  broadcast_id:  string
  template_name: typeof SD_BROADCAST_TEMPLATE_NAME
  status:        'pending'
}

export function broadcastQueueSelector(broadcastId: string): BroadcastQueueSelector {
  if (typeof broadcastId !== 'string' || broadcastId.trim() === '') {
    throw new Error('broadcastQueueSelector: broadcastId requerido')
  }
  return { broadcast_id: broadcastId, template_name: SD_BROADCAST_TEMPLATE_NAME, status: 'pending' }
}

export interface QueueRowLike {
  broadcast_id:  string | null
  template_name: string
  status:        string
}

/** Predicado equivalente al selector — lo que el processor podría tomar. */
export function isSelectableByBroadcastProcessor(row: QueueRowLike, broadcastId: string): boolean {
  const s = broadcastQueueSelector(broadcastId)
  return row.broadcast_id === s.broadcast_id
    && row.template_name === s.template_name
    && row.status === s.status
}
