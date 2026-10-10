// Sprint C.1 / C.1.2 — contrato de envío de los templates de Broadcast en Meta.
//
// VERIFICADO contra la Graph API real (GET /{WABA}/message_templates,
// 2026-10-09, C.1.1) — ver scripts/verify-broadcast-templates.ts:
//
//   interno                    → template en Meta            idioma  header  body
//   sd_broadcast_confirmation  → sd_broadcast_confirmation   en      IMAGE   5 vars
//   sd_broadcast_repurchase    → sd_broadcast_coordination   es_DO   IMAGE   1 var
//
//   sd_broadcast_confirmation (texto aprobado):
//     Hola, {{1}} 😊 / Tu tratamiento *{{2}} LÜMA Teeth* está listo 🦷✨ /
//     🎁 *{{3}}* / 💵 Total: *RD${{4}}* / 🚚 {{5}} — pagas al recibir /
//     *¿Coordinamos tu entrega?*
//     ejemplo aprobado: ["Juan","2x1","Incluye tu cepillo antibacterial GRATIS","2,100","Envío gratis"]
//   sd_broadcast_coordination (recompra, precios fijos en el texto): Hola, {{1}} 😊 …
//
// El identificador INTERNO (DB: wa_broadcasts / wa_template_queue, botones,
// intenciones) no cambia; solo el nombre que se envía a Meta se mapea aquí.
// Idioma y cantidad de variables son constantes verificadas — no se
// configuran por entorno (una configuración errónea haría que Meta rechace
// cada envío). Solo la URL pública del header de imagen viene del entorno y
// es FAIL-CLOSED: sin ella el template se considera no configurado y el
// processor no reclama ni envía nada.
//
// Valores de las variables: SIEMPRE derivados de la oferta real del pedido
// (resolveCommercialOffer) y del catálogo (catalog.ts). Solo se envía si el
// pedido es exactamente la oferta del texto aprobado (bundle Personal 2×1,
// cepillo GRATIS, sin cargo de envío, monto = PERSONAL_BUNDLE_PRICE).
//
// Botones: payload propio por quick reply (bc1:<queue_id>:<índice>) —
// permitido por Meta para quick replies sin re-aprobar el template.
//
// Puro (sin I/O).

import { TEMPLATE_BUTTONS, type BroadcastTemplateName } from './campaign'
import { PERSONAL_BUNDLE_PRICE } from './catalog'
import { resolveCommercialOffer } from './offer'
import { formatCodAmount } from './message-preview'

export type ButtonIntent = 'confirm_interest' | 'decline_order' | 'repurchase_interest' | 'repurchase_decline'

// Mismo orden que TEMPLATE_BUTTONS (índice del quick reply en el template).
export const TEMPLATE_BUTTON_INTENTS: Record<BroadcastTemplateName, [ButtonIntent, ButtonIntent]> = {
  sd_broadcast_confirmation: ['confirm_interest', 'decline_order'],
  sd_broadcast_repurchase:   ['repurchase_interest', 'repurchase_decline'],
}

export interface MetaTemplateContract {
  metaName:       string
  language:       string
  header:         'image'
  bodyParamCount: number
  imageEnv:       string
}

export const META_TEMPLATE_CONTRACTS: Record<BroadcastTemplateName, MetaTemplateContract> = {
  sd_broadcast_confirmation: {
    metaName: 'sd_broadcast_confirmation', language: 'en', header: 'image', bodyParamCount: 5,
    imageEnv: 'WA_BROADCAST_CONFIRMATION_IMAGE_URL',
  },
  sd_broadcast_repurchase: {
    metaName: 'sd_broadcast_coordination', language: 'es_DO', header: 'image', bodyParamCount: 1,
    imageEnv: 'WA_BROADCAST_REPURCHASE_IMAGE_URL',
  },
}

export interface TemplateSendConfig {
  name:           BroadcastTemplateName   // identificador interno
  metaName:       string                  // nombre real en Meta
  language:       string
  headerImageUrl: string
  bodyParamCount: number
  buttons:        [string, string]
}

export type TemplateConfigResult =
  | { ok: true; config: TemplateSendConfig }
  | { ok: false; missing: string[]; invalid: string[] }

type Env = Record<string, string | undefined>

export function resolveTemplateConfig(name: BroadcastTemplateName, env: Env = process.env): TemplateConfigResult {
  const c = META_TEMPLATE_CONTRACTS[name]
  const image = env[c.imageEnv]?.trim()
  if (!image) return { ok: false, missing: [c.imageEnv], invalid: [] }
  if (!/^https:\/\/\S+$/.test(image)) return { ok: false, missing: [], invalid: [c.imageEnv] }
  return {
    ok: true,
    config: { name, metaName: c.metaName, language: c.language, headerImageUrl: image,
              bodyParamCount: c.bodyParamCount, buttons: TEMPLATE_BUTTONS[name] },
  }
}

// ── Valores de las variables ─────────────────────────────────────────────────

/**
 * Meta rechaza parámetros con saltos de línea, tabs o más de 4 espacios
 * seguidos. Además el texto aprobado ya envuelve {{2}}/{{3}} en *…*: un
 * asterisco u otro marcador de formato dentro del valor rompería el estilo.
 */
export function sanitizeTemplateParam(raw: string | null | undefined, maxLen = 60): string {
  return String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLen)
    .trim()
}

function customerNameParam(name: string | null | undefined): string {
  return sanitizeTemplateParam(name) || 'Cliente'
}

export interface ConfirmationOrderFields {
  customer_name:   string | null
  product_summary: string | null
  cod_amount:      number | string | null
}

export type BodyParamsResult =
  | { ok: true; params: string[] }
  | { ok: false; reason: 'offer_incompatible' }

// Textos de la oferta Personal 2×1 — idénticos al ejemplo aprobado en Meta.
const PERSONAL_OFFER_LABEL    = '2x1'
const PERSONAL_GIFT_LINE      = 'Incluye tu cepillo antibacterial GRATIS'
const FREE_SHIPPING_LABEL     = 'Envío gratis'

/**
 * {{1}} nombre · {{2}} oferta · {{3}} regalo · {{4}} monto (sin "RD$": el
 * texto aprobado ya lo trae) · {{5}} envío. Solo para el bundle Personal
 * exacto; cualquier otra composición → offer_incompatible (no se envía).
 */
export function buildConfirmationBodyParams(o: ConfirmationOrderFields): BodyParamsResult {
  const offer = resolveCommercialOffer(o.product_summary, o.cod_amount)
  const amount = o.cod_amount == null || o.cod_amount === '' ? NaN : Number(o.cod_amount)
  const exact = offer.kind === 'personal' && offer.personalBundleConfirmed && offer.brushMentioned && offer.brushFree
    && (offer.brushCount === null || offer.brushCount === 1) && !offer.shippingCharged && !offer.priorityShipping
    && amount === PERSONAL_BUNDLE_PRICE
  if (!exact) return { ok: false, reason: 'offer_incompatible' }
  return {
    ok: true,
    params: [
      customerNameParam(o.customer_name),
      PERSONAL_OFFER_LABEL,
      PERSONAL_GIFT_LINE,
      formatCodAmount(PERSONAL_BUNDLE_PRICE),
      FREE_SHIPPING_LABEL,
    ],
  }
}

/** sd_broadcast_coordination: {{1}} nombre (precios fijos en el texto aprobado). */
export function buildRepurchaseBodyParams(o: { customer_name: string | null }): BodyParamsResult {
  return { ok: true, params: [customerNameParam(o.customer_name)] }
}

/** Copia de auditoría del texto que Meta compone (no se transmite). */
export function renderConfirmationTemplateBody(params: string[]): string {
  const [n, offer, gift, amount, shipping] = params
  return [
    `Hola, ${n} 😊`, '',
    `Tu tratamiento *${offer} LÜMA Teeth* está listo 🦷✨`, '',
    `🎁 *${gift}*`, '',
    `💵 Total: *RD$${amount}*`,
    `🚚 ${shipping} — pagas al recibir`, '',
    '*¿Coordinamos tu entrega?*',
  ].join('\n')
}

// ── Payload de botones ───────────────────────────────────────────────────────

const PAYLOAD_RE = /^bc1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([01])$/i

export function buildButtonPayload(queueId: string, index: 0 | 1): string {
  return `bc1:${queueId}:${index}`
}

export function parseButtonPayload(payload: string | null | undefined): { queueId: string; index: 0 | 1 } | null {
  const m = typeof payload === 'string' ? payload.match(PAYLOAD_RE) : null
  return m ? { queueId: m[1].toLowerCase(), index: Number(m[2]) as 0 | 1 } : null
}

// ── Componentes del request a Meta ───────────────────────────────────────────

export function buildTemplateComponents(cfg: TemplateSendConfig, bodyParams: string[], queueId: string): unknown[] {
  if (bodyParams.length !== cfg.bodyParamCount) {
    throw new Error(`${cfg.metaName}: se esperaban ${cfg.bodyParamCount} parámetros de cuerpo, llegaron ${bodyParams.length}`)
  }
  if (bodyParams.some(p => !p || /[\r\n\t]| {5,}/.test(p))) {
    throw new Error(`${cfg.metaName}: parámetro vacío o con formato no admitido por Meta`)
  }
  return [
    { type: 'header', parameters: [{ type: 'image', image: { link: cfg.headerImageUrl } }] },
    { type: 'body', parameters: bodyParams.map(text => ({ type: 'text', text })) },
    ...([0, 1] as const).map(index => ({
      type: 'button', sub_type: 'quick_reply', index: String(index),
      parameters: [{ type: 'payload', payload: buildButtonPayload(queueId, index) }],
    })),
  ]
}
