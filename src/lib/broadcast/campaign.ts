// Sprint Broadcast B.2 / B.2.1 — tipos de campaña explícitos.
//
// SOLO existen DOS templates de Broadcast (B.2.1):
//   sd_broadcast_confirmation ← coordination / pending
//                             ← coordination / confirmed_unpaid (mismo template)
//   sd_broadcast_repurchase   ← repurchase / window_days (oferta estándar propia)
// No existe ni se necesita 'sd_broadcast_coordination'.
//
// Cada campaña tiene intención, copy, botones y regla distintos. No hay un
// "incluir confirmados" ambiguo. Puro / client-safe.

import { PERSONAL_BUNDLE_PRICE } from './catalog'

export type CoordinationSegment = 'pending' | 'confirmed_unpaid'
// Sub-filtro de confirmed_unpaid: todos | sin ruta (no en_reparto) | ya en ruta.
export const ROUTE_FILTERS = ['all', 'not_in_route', 'in_route'] as const
export type RouteFilter = typeof ROUTE_FILTERS[number]
export const REPURCHASE_WINDOWS = [30, 45, 60] as const
export type RepurchaseWindow = typeof REPURCHASE_WINDOWS[number]

export type BroadcastCampaign =
  | { type: 'coordination'; segment: 'pending' }
  | { type: 'coordination'; segment: 'confirmed_unpaid'; route?: RouteFilter }  // route ausente = 'all'
  | { type: 'repurchase';   window_days: RepurchaseWindow }

export const BROADCAST_TEMPLATES = ['sd_broadcast_confirmation', 'sd_broadcast_repurchase'] as const
export type BroadcastTemplateName = typeof BROADCAST_TEMPLATES[number]

// ── Oferta estándar de RECOMPRA (B.2.1) ──────────────────────────────────────
// Oferta comercial propia de la campaña — NO depende de la compra histórica
// del cliente (ni su precio ni su composición). Única fuente del precio de
// recompra: precio = lista × (1 − descuento).
export const REPURCHASE_OFFER = {
  pasteQty:     2,
  includesBrush: false,
  discountPct:  10,
  listPrice:    PERSONAL_BUNDLE_PRICE,
  // price = lista × 0.90 = RD$1,890 (derivado, nunca literal)
  get price(): number { return Math.round(this.listPrice * (1 - this.discountPct / 100)) },
  freeShipping: true,
  cashOnDelivery: true,
} as const

// ── Descuento de RECUPERACIÓN (Génesis, Sprint C/Génesis 2) ──────────────────
// Política declarativa — NO implementada en ningún flujo todavía.
export const MAX_RECOVERY_DISCOUNT_PCT = 10

export type RecoveryStage =
  | 'button_declined'            // pulsó "Ya no lo deseo" — NUNCA basta para descuento
  | 'objection_identified'       // Génesis identificó la objeción
  | 'objection_unresolved_price' // objeción de precio que no se resolvió con valor/beneficios

export interface RecoveryDiscountInput {
  campaign:                BroadcastCampaign
  stage:                   RecoveryStage
  discountAlreadyOffered:  boolean
  orderAlreadyDiscounted:  boolean   // p.ej. pedido nacido de recompra (ya -10%)
  requestedPct:            number
}

/** ¿Puede Génesis ofrecer descuento de recuperación ahora? (puro) */
export function recoveryDiscountDecision(i: RecoveryDiscountInput): { allowed: boolean; pct: number; reason: string } {
  if (i.campaign.type !== 'coordination') return { allowed: false, pct: 0, reason: 'solo_pedidos_en_coordinacion' }
  if (i.stage !== 'objection_unresolved_price') return { allowed: false, pct: 0, reason: 'primero_resolver_objecion' }
  if (i.discountAlreadyOffered) return { allowed: false, pct: 0, reason: 'ya_ofrecido' }
  if (i.orderAlreadyDiscounted) return { allowed: false, pct: 0, reason: 'no_acumulable' }
  const pct = Math.min(Math.max(i.requestedPct, 0), MAX_RECOVERY_DISCOUNT_PCT)
  return pct > 0 ? { allowed: true, pct, reason: 'ok' } : { allowed: false, pct: 0, reason: 'pct_invalido' }
}

export const DEFAULT_CAMPAIGN: BroadcastCampaign = { type: 'coordination', segment: 'pending' }

// Versión de regla guardada en wa_broadcasts.eligibility_rule_version.
// coordination v2 = sd_standard_v1 + segmento confirmed_unpaid + ambigüedad
// de teléfono entre segmentos (más estricta, nunca más laxa).
export function campaignRuleVersion(c: BroadcastCampaign): string {
  return c.type === 'coordination' ? 'sd_coordination_v2' : 'sd_repurchase_v1'
}

// template_name interno (identidad en wa_template_queue: UNIQUE(order_id, template_name)).
// 'sd_broadcast_repurchase' AÚN no es aceptado por los CHECK de 064 → ver
// propuesta de migración 066 (Sprint C). Por eso repurchase es preview-only.
export function campaignTemplateName(c: BroadcastCampaign): BroadcastTemplateName {
  return c.type === 'coordination' ? 'sd_broadcast_confirmation' : 'sd_broadcast_repurchase'
}

export function campaignCanCreateDraft(c: BroadcastCampaign): boolean {
  return c.type === 'coordination'
}

// Quick replies EXACTOS de los templates (B.2.1). Coordinación: SOLO dos, sin ubicación.
export const TEMPLATE_BUTTONS: Record<BroadcastTemplateName, [string, string]> = {
  sd_broadcast_confirmation: ['Sí, confirmar', 'Ya no lo deseo'],
  sd_broadcast_repurchase:   ['Sí, quiero aprovechar', 'Ahora no'],
}

export function campaignButtons(c: BroadcastCampaign): [string, string] {
  return TEMPLATE_BUTTONS[campaignTemplateName(c)]
}

export function campaignLabel(c: BroadcastCampaign): string {
  if (c.type === 'coordination') {
    if (c.segment === 'pending') return 'Coordinar pedido · Pendientes'
    const r = c.route ?? 'all'
    return `Coordinar pedido · Confirmados sin pagar${r === 'not_in_route' ? ' · sin ruta' : r === 'in_route' ? ' · ya en ruta' : ''}`
  }
  return `Recompra · ${c.window_days}+ días desde el pago`
}

export function parseCampaign(input: unknown): { ok: true; campaign: BroadcastCampaign } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, campaign: DEFAULT_CAMPAIGN }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'campaign inválida' }
  const c = input as Record<string, unknown>
  const keys = Object.keys(c)
  if (c.type === 'coordination') {
    if (c.segment === 'pending') {
      if (keys.some(k => k !== 'type' && k !== 'segment')) return { ok: false, error: 'campaign: claves no soportadas' }
      return { ok: true, campaign: { type: 'coordination', segment: 'pending' } }
    }
    if (c.segment === 'confirmed_unpaid') {
      if (keys.some(k => k !== 'type' && k !== 'segment' && k !== 'route')) return { ok: false, error: 'campaign: claves no soportadas' }
      const route = c.route ?? 'all'
      if (!(ROUTE_FILTERS as readonly unknown[]).includes(route)) return { ok: false, error: 'route inválido' }
      return { ok: true, campaign: { type: 'coordination', segment: 'confirmed_unpaid', route: route as RouteFilter } }
    }
    return { ok: false, error: 'segment inválido' }
  }
  if (c.type === 'repurchase') {
    if (keys.some(k => k !== 'type' && k !== 'window_days')) return { ok: false, error: 'campaign: claves no soportadas' }
    if (!(REPURCHASE_WINDOWS as readonly unknown[]).includes(c.window_days)) return { ok: false, error: 'window_days debe ser 30, 45 o 60' }
    return { ok: true, campaign: { type: 'repurchase', window_days: c.window_days as RepurchaseWindow } }
  }
  return { ok: false, error: 'campaign.type debe ser coordination o repurchase' }
}
