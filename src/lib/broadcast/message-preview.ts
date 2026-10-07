// Sprint Broadcast B / B.2 — COPY DE PREVIEW por tipo de campaña.
//
// NO es un template aprobado por Meta: es el texto propuesto para revisión.
// Sprint C deberá mapear cada copy_variant a un template aprobado (Meta no
// admite líneas libres: una variante por oferta, o variables de texto).
//
// Precio coordinación: SIEMPRE orders.cod_amount del pedido, formateado.
// Precio recompra: oferta estándar REPURCHASE_OFFER (campaign.ts), única fuente.
// Oferta: resolveCommercialOffer() (offer.ts) — nunca se inventan beneficios;
// si la oferta no se reconoce se usa el product_summary real.
// Puro / client-safe.

import { offerContentsLine, resolveCommercialOffer, type CommercialOffer } from './offer'
import { REPURCHASE_OFFER } from './campaign'

export interface PreviewVariables {
  customer_name:   string | null
  product_summary: string | null
  cod_amount:      number | string | null
}

export function formatCodAmount(v: number | string | null): string {
  const n = typeof v === 'string' ? Number(v) : v
  if (n == null || !Number.isFinite(n)) return '0'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n)
}

function firstName(v: string | null): string {
  return v?.trim() || 'Cliente'
}

function shippingLine(o: CommercialOffer): string {
  // Un pedido con cargo de envío (texto prioritario o monto sobre el bundle)
  // pagó el envío: nunca se le dice "gratis".
  if (o.priorityShipping) return '🚚 Envío prioritario — pagas al recibir'
  if (o.shippingCharged)  return '🚚 Pagas al recibir'
  // Oferta no reconocida: no sabemos si el envío es gratis → no se afirma.
  if (o.kind === 'unknown') return '🚚 Pagas al recibir'
  return '🚚 Envío gratis — pagas al recibir'
}

// ── Coordinar pedido ─────────────────────────────────────────────────────────

function coordinationHeadline(o: CommercialOffer): string {
  switch (o.kind) {
    case 'personal': return '*Tu tratamiento 2×1 LÜMA Teeth está listo 🦷✨*'
    case 'familiar': return '*Tu Tratamiento Familiar LÜMA Teeth está listo 🦷✨*'
    case 'trio':     return '*Tu tratamiento LÜMA Teeth está listo 🦷✨*'
    default:         return '*Tu pedido está listo 📦*'
  }
}

function coordinationIncludes(o: CommercialOffer): string | null {
  if (o.kind === 'personal') {
    if (!o.brushMentioned) return null
    return o.brushFree ? '🎁 Incluye tu *cepillo antibacterial GRATIS*' : '🎁 Incluye tu *cepillo antibacterial*'
  }
  if (o.kind === 'familiar' || o.kind === 'trio') {
    const c = offerContentsLine(o)
    return c ? `🎁 Incluye *${c}*` : null
  }
  return o.productSummary ? `🛍️ ${o.productSummary}` : null
}

export function renderCoordinationMessage(v: PreviewVariables): string {
  const o = resolveCommercialOffer(v.product_summary, v.cod_amount)
  return [
    `Hola, ${firstName(v.customer_name)} 😊`,
    '',
    coordinationHeadline(o),
    ...(coordinationIncludes(o) ? ['', coordinationIncludes(o)!] : []),
    '',
    `💵 Total: *RD$${formatCodAmount(v.cod_amount)}*`,
    shippingLine(o),
    '',
    '*¿Coordinamos tu entrega?*',
  ].join('\n')
}

// ── Recompra (B.2.1) ─────────────────────────────────────────────────────────
// Oferta estándar propia de la campaña (REPURCHASE_OFFER): 2 LÜMA Teeth, sin
// cepillo, 10% de descuento. NO usa la compra histórica del cliente (ni su
// precio ni su composición). Copy aprobado conceptualmente para
// sd_broadcast_repurchase.

export function renderRepurchaseMessage(v: Pick<PreviewVariables, 'customer_name'>): string {
  const o = REPURCHASE_OFFER
  return [
    '🎁 Tenemos una oferta especial para ti!', '',
    `Hola, ${firstName(v.customer_name)} 😊`, '',
    'Por ser cliente LÜMA, tienes un beneficio especial para renovar tu tratamiento 🦷✨', '',
    `${o.pasteQty} LÜMA Teeth — ${o.discountPct}% de descuento`,
    `Antes: RD$${formatCodAmount(o.listPrice)}`,
    `💙 Ahora: RD$${formatCodAmount(o.price)}`, '',
    '🚚 Envío gratis',
    '💵 Pagas al recibir', '',
    '¿Quieres aprovechar tu precio especial?',
  ].join('\n')
}

/** Compat B/B.1: el preview estándar es la coordinación. */
export function renderBroadcastPreview(v: PreviewVariables): string {
  return renderCoordinationMessage(v)
}
