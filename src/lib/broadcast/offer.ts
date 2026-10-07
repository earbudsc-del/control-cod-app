// Sprint Broadcast B.2 — oferta comercial + media a partir del pedido REAL.
//
// Fuente: orders.product_summary (texto de Shopify) + orders.cod_amount.
// Auditoría de producción (B.2): los formatos reales son, p.ej.
//   "LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita - x2, + 1 Cepillo GRATIS"   (2100)
//   "LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita - x2, Cepillo Antibacterial" (2100, sin "GRATIS")
//   "LÜMA Teeth™ — Pasta Dental Restauradora - x4, + 2 Cepillos GRATIS - x2"      (3400)
//   "LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita - x3, + 2 Cepillos GRATIS"   (2700)
//   "..., Envio prioritario" (+RD$100)  ·  "" (vacío)  ·  "LÜMA Brush™ CEPILLO…"  ·  "SteriClean™…"
//
// Reglas: nunca inventar. Solo se afirma lo que el pedido respalda:
//   - cantidad de pastas: solo si aparece "- xN" en el ítem LÜMA Teeth;
//   - cepillos: cantidad solo si aparece "+ N cepillo(s)";
//   - cepillo GRATIS (B.2.2): si el texto dice GRATIS, O si el pedido es con
//     seguridad el bundle Personal 2×1 — composición exacta (x2 LÜMA Teeth +
//     un único cepillo, nada más) Y monto del bundle (RD$2,100, o 2,200 con
//     envío prioritario). En ese bundle el cepillo es regalo aunque Shopify
//     escriba solo "Cepillo Antibacterial". Nunca por monto solo.
//   - envío (estricto, sin cambios): cobrado si el texto dice "envío
//     prioritario" o si el monto de un Personal supera el bundle → jamás
//     "Envío gratis".
// Si no se reconoce → kind='unknown' y el copy usa el product_summary tal cual.
//
// Puro / client-safe. No hay URLs ni binarios aquí (ver MEDIA_ASSETS).

import { PERSONAL_BUNDLE_PRICE, PRIORITY_SHIPPING_SURCHARGE } from './catalog'

export type OfferKind = 'personal' | 'familiar' | 'trio' | 'unknown'

export type BroadcastMediaAssetKey = 'luma_2x1_personal' | 'luma_familiar' | 'luma_generic' | 'luma_repurchase'

export interface BroadcastMediaSpec {
  type:      'image'
  asset_key: BroadcastMediaAssetKey
}

export interface MediaAssetInfo {
  label:       string
  // approved: creatividad aprobada (existe, aún no subida a Meta).
  // pending_asset: no existe todavía — Sprint C NO puede enviar con ella.
  status:      'approved' | 'pending_asset'
  description: string
}

// Registro de assets. La URL pública estable / media handle de Meta se
// resuelve en Sprint C (mismo patrón que WA_ORDER_CONFIRMATION_IMAGE_URL:
// variable de entorno por asset_key, o media handle subido a Meta). Nunca
// se hardcodea URL temporal ni base64 en el código.
export const MEDIA_ASSETS: Record<BroadcastMediaAssetKey, MediaAssetInfo> = {
  luma_2x1_personal: {
    label: 'LÜMA 2×1 Personal', status: 'approved',
    description: '2 tubos LÜMA Teeth + cepillo antibacterial negro · 2x1 · cepillo GRATIS · envío gratis · pagas al recibir · producto original',
  },
  luma_familiar: {
    label: 'LÜMA Tratamiento Familiar', status: 'pending_asset',
    description: 'Pendiente de crear — no reutilizar la imagen 2×1 (contradice el pedido familiar)',
  },
  // B.2.1 — imagen propia de sd_broadcast_repurchase (ya existe): un tubo
  // LÜMA, "REPARA TU ESMALTE", 7.5% nano-hidroxiapatita. NO promete cepillo.
  luma_repurchase: {
    label: 'LÜMA Recompra (repara tu esmalte)', status: 'approved',
    description: '1 tubo LÜMA · "REPARA TU ESMALTE" · 7.5% nano-hidroxiapatita · envío gratis · pago contra entrega · sin cepillo',
  },
  luma_generic: {
    label: 'LÜMA genérica', status: 'pending_asset',
    description: 'Pendiente de crear — visual LÜMA sin oferta específica (fallback)',
  },
}

export interface CommercialOffer {
  kind:          OfferKind
  pasteQty:      number | null
  brushCount:    number | null    // null = no hay cantidad explícita
  brushMentioned: boolean
  brushFree:     boolean          // cepillo gratis: texto GRATIS o bundle Personal confirmado
  brushFreeSource: 'text' | 'personal_bundle' | null
  personalBundleConfirmed: boolean // composición + monto coinciden con el bundle 2×1
  priorityShipping: boolean        // el texto dice "envío prioritario"
  shippingCharged:  boolean        // hay evidencia de cargo de envío (texto o monto)
  shippingChargeEvidence: 'priority_text' | 'amount_above_bundle' | null
  productSummary: string | null
  media:         BroadcastMediaSpec
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/™/g, '')
}

export function resolveCommercialOffer(productSummary: string | null | undefined, codAmount?: number | string | null): CommercialOffer {
  const raw = (productSummary ?? '').trim()
  const s = norm(raw)
  const parts = s.split(',').map(p => p.trim()).filter(Boolean)

  const teethIdx = parts.findIndex(p => p.includes('luma teeth'))
  const qtyMatch = teethIdx >= 0 ? parts[teethIdx].match(/\s-\s*x(\d+)\s*$/) : null
  const pasteQty = qtyMatch ? Number(qtyMatch[1]) : null

  const brushParts = parts.filter((p, i) => i !== teethIdx && /cepillo/.test(p))
  const countMatch = brushParts.map(p => p.match(/^\+?\s*(\d+)\s*cepillos?/)).find(Boolean)
  const brushCount = countMatch ? Number(countMatch[1]) : null
  const brushMentioned = brushParts.length > 0
  const brushFreeText = brushParts.some(p => /gratis/.test(p))
  const priorityShipping = parts.some(p => /envio prioritario/.test(p))

  // Cualquier ítem que no sea LÜMA Teeth / cepillo / envío → no reconocido.
  const foreign = parts.some((p, i) => i !== teethIdx && !/cepillo/.test(p) && !/envio prioritario/.test(p))

  let kind: OfferKind = 'unknown'
  if (teethIdx >= 0 && pasteQty !== null && !foreign) {
    if (pasteQty === 2) kind = 'personal'
    else if (pasteQty === 3) kind = 'trio'
    else if (pasteQty === 4) kind = 'familiar'
  }

  const amount = codAmount == null || codAmount === '' ? null : Number(codAmount)
  const validAmount = amount !== null && Number.isFinite(amount) ? amount : null

  const personalBundleConfirmed = kind === 'personal' && brushParts.length === 1
    && (brushCount === null || brushCount === 1)
    && (validAmount === PERSONAL_BUNDLE_PRICE || validAmount === PERSONAL_BUNDLE_PRICE + PRIORITY_SHIPPING_SURCHARGE)
  const brushFree = brushFreeText || personalBundleConfirmed
  const brushFreeSource = brushFreeText ? 'text' as const : personalBundleConfirmed ? 'personal_bundle' as const : null

  const amountAboveBundle = kind === 'personal' && validAmount !== null && validAmount > PERSONAL_BUNDLE_PRICE
  const shippingCharged = priorityShipping || amountAboveBundle
  const shippingChargeEvidence = priorityShipping ? 'priority_text' as const : amountAboveBundle ? 'amount_above_bundle' as const : null

  const asset_key: BroadcastMediaAssetKey =
    kind === 'personal' ? 'luma_2x1_personal' : kind === 'familiar' ? 'luma_familiar' : 'luma_generic'

  return {
    kind, pasteQty, brushCount, brushMentioned, brushFree, brushFreeSource, personalBundleConfirmed,
    priorityShipping, shippingCharged, shippingChargeEvidence,
    productSummary: raw || null,
    media: { type: 'image', asset_key },
  }
}

/** "4 LÜMA Teeth + 2 cepillos antibacteriales GRATIS" — solo lo que el texto respalda. */
export function offerContentsLine(o: CommercialOffer): string | null {
  if (o.kind === 'unknown' || o.pasteQty === null) return null
  let brush = ''
  if (o.brushMentioned) {
    if (o.brushCount && o.brushCount > 1) brush = ` + ${o.brushCount} cepillos antibacteriales`
    else if (o.brushCount === 1)          brush = ' + 1 cepillo antibacterial'
    else                                   brush = ' + cepillo antibacterial'
    if (o.brushFree) brush += ' GRATIS'
  }
  return `${o.pasteQty} LÜMA Teeth${brush}`
}
