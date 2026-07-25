// Sistema de compactación progresiva del Sticker COD — v3 (2026-07-25).
//
// v2 comprimía TODO permanentemente (logo, tipografía, paddings, footer) para
// garantizar que ningún pedido desbordara 4x6in — pero eso dejaba pedidos
// normales (la gran mayoría) con ~55-60% de la etiqueta ocupada, con aspecto
// "encogido" en vez de una etiqueta de courier profesional.
//
// v3 usa TIER 0 (espacioso, casi el template original) como el caso normal,
// y solo activa compactación cuando el contenido real de UN pedido concreto
// no cabe en 576px — medido en el navegador (ver useFittedLabelTier), nunca
// asumido de antemano. La compactación es progresiva y ACUMULATIVA en el
// orden pedido: interlineado → paddings → logo → instrucciones → productos
// → dirección. El número de orden y el monto NUNCA se reducen — deben
// mantener protagonismo visual en cualquier tier (ver OrderCodLabel.tsx).
export type LabelTier = 0 | 1 | 2 | 3 | 4 | 5 | 6

export const MAX_LABEL_TIER: LabelTier = 6

export interface LabelTierConfig {
  lineHeight: number
  labelPadding: number // px, padding del contenedor .label
  sectionPadding: number // px, padding vertical de cada .section
  logoMaxWidth: number // px
  footerLong: boolean // true = texto completo de instrucciones, false = versión compacta
  maxDisplayedItems: number // productos mostrados antes de resumir "+N adicionales"
  addressMaxChars: number // truncateAddress() — alto = prácticamente nunca trunca
}

// tier 6 replica exactamente los valores de v2 (probados empíricamente con
// los casos reales más extremos — pedido #8751 dirección de 210 caracteres,
// pedido #9999 con 5 productos) — es el piso de seguridad garantizado.
const TIER_6: LabelTierConfig = {
  lineHeight: 1.15,
  labelPadding: 8,
  sectionPadding: 6,
  logoMaxWidth: 85,
  footerLong: false,
  maxDisplayedItems: 3,
  addressMaxChars: 130,
}

export const LABEL_TIER_CONFIGS: Record<LabelTier, LabelTierConfig> = {
  0: {
    lineHeight: 1.3,
    labelPadding: 12,
    sectionPadding: 9,
    logoMaxWidth: 105,
    footerLong: true,
    maxDisplayedItems: 4,
    addressMaxChars: 999,
  },
  1: {
    lineHeight: 1.15, // 1. interlineado
    labelPadding: 12,
    sectionPadding: 9,
    logoMaxWidth: 105,
    footerLong: true,
    maxDisplayedItems: 4,
    addressMaxChars: 999,
  },
  2: {
    lineHeight: 1.15,
    labelPadding: 9, // 2. paddings
    sectionPadding: 7,
    logoMaxWidth: 105,
    footerLong: true,
    maxDisplayedItems: 4,
    addressMaxChars: 999,
  },
  3: {
    lineHeight: 1.15,
    labelPadding: 9,
    sectionPadding: 7,
    logoMaxWidth: 85, // 3. logo
    footerLong: true,
    maxDisplayedItems: 4,
    addressMaxChars: 999,
  },
  4: {
    lineHeight: 1.15,
    labelPadding: 9,
    sectionPadding: 7,
    logoMaxWidth: 85,
    footerLong: false, // 4. instrucciones
    maxDisplayedItems: 4,
    addressMaxChars: 999,
  },
  5: {
    lineHeight: 1.15,
    labelPadding: 8,
    sectionPadding: 6,
    logoMaxWidth: 85,
    footerLong: false,
    maxDisplayedItems: 3, // 5. productos
    addressMaxChars: 999,
  },
  6: TIER_6, // 6. dirección (+ resto ya al piso de v2)
}
