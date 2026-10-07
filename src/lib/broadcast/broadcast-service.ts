// Sprint Broadcast B / B.1 — resolución de audiencia, preview y creación de DRAFT.
//
// SERVER-ONLY. El browser solo describe la selección (selection.ts); aquí se
// resuelven los candidatos, se cargan los datos y se decide elegibilidad con
// sd_standard_v1 (sd-broadcast-eligibility.ts). La UI nunca decide.
//
// ── Frontera de audiencia: revalidar REDUCE, nunca AMPLÍA ──────────────────
// Un draft registra "esta audiencia era elegible cuando se preparó". NO
// persiste recipients ni inserta nada en wa_template_queue. Antes de
// encolar/enviar (Sprint C) se re-ejecuta TODA la elegibilidad con
// revalidateDraftAudience(), que respeta la frontera guardada:
//   - selected_ids: los order_ids guardados SON la frontera. Revalidar puede
//     quitar IDs que dejaron de ser elegibles; nunca agrega otros.
//   - filtered:     selection_filter.resolved_at es el cutoff. Solo pueden
//     pertenecer pedidos con orders.created_at <= resolved_at. Pedidos que
//     entren después y cumplan el filtro NO pertenecen al draft.
// Cutoff = orders.created_at: DEFAULT now() al insertar, ningún flujo lo
// escribe ni lo actualiza (el trigger de orders solo toca updated_at). Es el
// instante en que el pedido empezó a existir en Control COD. No se usa
// updated_at ni shopify_created_at (fecha comercial: un pedido recuperado de
// Shopify después del draft trae una fecha comercial anterior, pero no existía
// para nosotros al preparar el draft → queda fuera, que es lo correcto).
//
// Recompra (B.2): misma frontera, por cliente — ver computeRepurchaseAudience.
//
// Preview, create y revalidación usan EXACTAMENTE la misma función
// (computeBroadcastAudience) — no hay segunda implementación.
//
// Este módulo no importa nada de Meta, del processor ni del cron, y la única
// escritura que hace es INSERT en wa_broadcasts (status='draft').

import { isSantoDomingoOrder } from '@/lib/alert-helpers'
import {
  activeCoordinationPhone,
  classifyBroadcastCandidates,
  normalizeBroadcastPhone,
  type BroadcastCandidateOrder,
  type BroadcastExcludedReason,
  type BroadcastWarning,
  type ExistingBroadcastQueueRow,
} from './sd-broadcast-eligibility'
import { renderCoordinationMessage, renderRepurchaseMessage } from './message-preview'
import { MEDIA_ASSETS, resolveCommercialOffer, type BroadcastMediaAssetKey, type OfferKind } from './offer'
import {
  campaignButtons, campaignCanCreateDraft, campaignRuleVersion, campaignTemplateName,
  type BroadcastCampaign,
} from './campaign'
import { parseBroadcastSelection, type BroadcastFilters, type BroadcastSelection } from './selection'

export const DRAFT_REQUIRES_REVALIDATION_BEFORE_SEND = true

const PAGE_SIZE      = 1000
const MAX_SCAN_ROWS  = 10_000
const ID_CHUNK       = 100
export const PREVIEW_LIST_LIMIT = 300

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface BroadcastAdminContext {
  userId:  string
  storeId: string
}

export class BroadcastSelectionTooBroadError extends Error {}

export const BROADCAST_ORDER_COLUMNS = [
  'id', 'store_id', 'order_number', 'source', 'shopify_order_id', 'is_test', 'archived_at',
  'customer_name', 'customer_phone', 'city', 'province', 'customer_address',
  'product_summary', 'cod_amount', 'confirmation_status', 'confirmation_attempts',
  'normalized_status', 'payment_status', 'tracking_number', 'sd_location_received_at',
  'shopify_created_at', 'paid_at', 'created_at',
].join(', ')

export interface BroadcastOrderRow extends BroadcastCandidateOrder {
  order_number:          string | null
  customer_name:         string | null
  product_summary:       string | null
  cod_amount:            number | null
  confirmation_attempts: number | null
  shopify_created_at:    string | null
  paid_at:               string | null
  created_at:            string | null
}

// ── Lectura paginada ──────────────────────────────────────────────────────────

async function fetchAll<T>(build: () => any, label: string): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`${label}: ${error.message ?? String(error)}`)
    out.push(...((data ?? []) as T[]))
    if (out.length > MAX_SCAN_ROWS) throw new BroadcastSelectionTooBroadError(label)
    if (!data || data.length < PAGE_SIZE) return out
  }
}

// ── Filtros (misma semántica que la pestaña Sto. Domingo de /confirmacion,
//    salvo la geografía: aquí manda isSantoDomingoOrder) ───────────────────

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// Comparación de instantes por valor, no por string (Postgres devuelve
// '...+00:00' y el cliente '...Z'). null/inválido → no cumple (fail-closed).
function ms(v: string | null | undefined): number | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/** ¿El pedido ya existía en Control COD en el instante `cutoff`? */
export function existedAt(o: { created_at: string | null }, cutoff: string): boolean {
  const c = ms(o.created_at), lim = ms(cutoff)
  return c !== null && lim !== null && c <= lim
}

export function matchesBroadcastFilters(o: BroadcastOrderRow, f: BroadcastFilters, audienceCutoff: string): boolean {
  if (!existedAt(o, audienceCutoff)) return false

  const attempts = o.confirmation_attempts ?? 0
  const cs = o.confirmation_status ?? 'pending'
  switch (f.status) {
    case 'pending':     if (!(cs === 'pending' && attempts === 0)) return false; break
    case 'reintentar':  if (!(cs === 'pending' && attempts > 0))   return false; break
    case 'confirmed':
    case 'cancelled':
    case 'no_coverage': if (cs !== f.status) return false; break
    case 'unreachable': if (cs !== 'unreachable' && cs !== 'wrong_number') return false; break
  }
  if (f.payment === 'pagado'    && o.payment_status !== 'paid') return false
  if (f.payment === 'pendiente' && o.payment_status === 'paid') return false

  const d = ms(f.payment === 'pagado' ? o.paid_at : o.shopify_created_at)
  const from = ms(f.date_from), to = ms(f.date_to)
  if (from !== null && !(d !== null && d >= from)) return false
  if (to   !== null && !(d !== null && d <  to))   return false

  if (f.search) {
    const needle = norm(f.search)
    const hay = norm([o.customer_name, o.customer_phone, o.order_number, o.tracking_number, o.city, o.province, o.customer_address]
      .filter(Boolean).join(' '))
    if (!hay.includes(needle)) return false
  }
  return isSantoDomingoOrder(o.city, o.province, o.customer_address)
}

export interface ResolvedCandidates {
  orders:        BroadcastOrderRow[]
  not_found_ids: string[]
}

/**
 * Resuelve candidatos dentro de la frontera de audiencia.
 * `resolvedAt`: instante de resolución del draft. En filtered es el cutoff
 * (created_at <= resolvedAt). En selected_ids la frontera son los ids.
 */
export async function resolveBroadcastCandidates(
  db: SupabaseLike,
  storeId: string,
  selection: BroadcastSelection,
  resolvedAt: string,
): Promise<ResolvedCandidates> {
  if (selection.mode === 'selected_ids') {
    const found: BroadcastOrderRow[] = []
    for (let i = 0; i < selection.order_ids.length; i += ID_CHUNK) {
      const chunk = selection.order_ids.slice(i, i + ID_CHUNK)
      const { data, error } = await db.from('orders').select(BROADCAST_ORDER_COLUMNS)
        .eq('store_id', storeId).in('id', chunk)
      if (error) throw new Error(`orders(selected): ${error.message ?? String(error)}`)
      found.push(...((data ?? []) as BroadcastOrderRow[]))
    }
    const foundIds = new Set(found.map(o => o.id))
    return { orders: found, not_found_ids: selection.order_ids.filter(id => !foundIds.has(id)) }
  }

  const f = selection.filters
  // Prefiltro SQL: igualdad/rango simples + cutoff de audiencia. Geografía,
  // intentos, pago pendiente y búsqueda (y de nuevo el cutoff) se aplican en TS.
  const rows = await fetchAll<BroadcastOrderRow>(() => {
    let q = db.from('orders').select(BROADCAST_ORDER_COLUMNS)
      .eq('store_id', storeId).eq('source', 'shopify_webhook')
      .lte('created_at', resolvedAt)
    if (f.status === 'pending' || f.status === 'reintentar') q = q.eq('confirmation_status', 'pending')
    else if (f.status === 'unreachable') q = q.in('confirmation_status', ['unreachable', 'wrong_number'])
    else if (f.status) q = q.eq('confirmation_status', f.status)
    if (f.payment === 'pagado') q = q.eq('payment_status', 'paid')
    const dateCol = f.payment === 'pagado' ? 'paid_at' : 'shopify_created_at'
    if (f.date_from) q = q.gte(dateCol, f.date_from)
    if (f.date_to)   q = q.lt(dateCol, f.date_to)
    return q
  }, 'orders(filtered)')

  return { orders: rows.filter(o => matchesBroadcastFilters(o, f, resolvedAt)), not_found_ids: [] }
}

/**
 * Pool de pedidos ACTIVOS coordinables de la tienda (pending o confirmed, sin
 * pagar, sin tracking). Se usa para la ambigüedad de teléfono entre segmentos
 * y, en recompra, para no ofrecer recompra a quien tiene un pedido en curso.
 */
async function loadActivePool(db: SupabaseLike, storeId: string): Promise<BroadcastOrderRow[]> {
  return fetchAll<BroadcastOrderRow>(() => db.from('orders').select(BROADCAST_ORDER_COLUMNS)
    .eq('store_id', storeId).eq('source', 'shopify_webhook')
    .in('confirmation_status', ['pending', 'confirmed']).eq('payment_status', 'pending')
    .is('tracking_number', null), 'orders(pool)')
}

/** Pedidos Pagados de la tienda (compras completadas para recompra). */
async function loadPaidOrders(db: SupabaseLike, storeId: string): Promise<BroadcastOrderRow[]> {
  return fetchAll<BroadcastOrderRow>(() => db.from('orders').select(BROADCAST_ORDER_COLUMNS)
    .eq('store_id', storeId).eq('source', 'shopify_webhook').eq('payment_status', 'paid'), 'orders(paid)')
}

type QueueRowWithTemplate = ExistingBroadcastQueueRow & { template_name: string }

async function loadExistingBroadcastRows(db: SupabaseLike, storeId: string, templateName: string): Promise<QueueRowWithTemplate[]> {
  return fetchAll<QueueRowWithTemplate>(() => db.from('wa_template_queue').select('id, order_id, status, template_name')
    .eq('store_id', storeId).eq('template_name', templateName), 'wa_template_queue(broadcast)')
}

// ── Audiencia (única implementación: preview, create y revalidación) ─────────

export type BroadcastPreviewExcludedReason =
  | BroadcastExcludedReason
  | 'not_found'
  | 'recent_purchase'               // recompra: pagó dentro de la ventana
  | 'active_order_in_progress'      // recompra: tiene un pedido activo en curso
  | 'repurchase_already_contacted'  // recompra: ya contactado por esta compra
  | 'route_filter_mismatch'         // confirmed_unpaid: fuera del sub-filtro de ruta elegido

// requires_template_variables: el copy real del pedido no calza con el texto
// fijo del template aprobado (2×1 + cepillo GRATIS + envío gratis). Sprint C
// debe registrar variables en el template o excluir ese pedido — nunca enviar
// el texto fijo a un pedido incompatible.
export type BroadcastPreviewWarning = BroadcastWarning | 'media_asset_pending' | 'requires_template_variables'

export interface BroadcastPreviewMedia {
  type:      'image'
  asset_key: BroadcastMediaAssetKey
  label:     string
  status:    'approved' | 'pending_asset'
}

export interface BroadcastPreview {
  campaign:                 BroadcastCampaign
  template_name:            string
  eligibility_rule_version: string
  buttons:                  [string, string]
  can_create_draft:         boolean
  resolved_at:              string
  candidate_count:          number
  eligible_count:           number
  excluded_count:           number
  excluded_by_reason:       Partial<Record<BroadcastPreviewExcludedReason, number>>
  eligible: Array<{
    order_id: string; order_number: string | null; customer_name: string | null
    phone_normalized: string; warnings: BroadcastPreviewWarning[]; message_preview: string
    offer_kind: OfferKind | 'repurchase_standard'; media: BroadcastPreviewMedia
  }>
  excluded: Array<{
    order_id: string; order_number: string | null; customer_name: string | null
    excluded_reason: BroadcastPreviewExcludedReason
  }>
  eligible_truncated: boolean
  excluded_truncated: boolean
  revalidation_required_before_send: boolean
}

type EligibleItem = BroadcastPreview['eligible'][number]
type ExcludedItem = BroadcastPreview['excluded'][number]

function mediaOf(asset_key: BroadcastMediaAssetKey): BroadcastPreviewMedia {
  const info = MEDIA_ASSETS[asset_key]
  return { type: 'image', asset_key, label: info.label, status: info.status }
}

function mediaFor(o: BroadcastOrderRow): { offer_kind: OfferKind; media: BroadcastPreviewMedia; fitsFixedTemplate: boolean } {
  const offer = resolveCommercialOffer(o.product_summary, o.cod_amount)
  // Texto fijo aprobado: "Tu tratamiento 2×1… cepillo antibacterial GRATIS… Envío gratis".
  const fitsFixedTemplate = offer.kind === 'personal' && offer.brushMentioned && offer.brushFree
    && (offer.brushCount === null || offer.brushCount === 1) && !offer.shippingCharged
  return { offer_kind: offer.kind, media: mediaOf(offer.media.asset_key), fitsFixedTemplate }
}

function routeMatches(c: BroadcastCampaign, o: BroadcastOrderRow): boolean {
  if (c.type !== 'coordination' || c.segment !== 'confirmed_unpaid') return true
  const r = c.route ?? 'all'
  if (r === 'in_route')     return o.normalized_status === 'en_reparto'
  if (r === 'not_in_route') return o.normalized_status !== 'en_reparto'
  return true
}

function packPreview(
  campaign: BroadcastCampaign, resolvedAt: string, candidate_count: number,
  eligibleAll: EligibleItem[], excludedAll: ExcludedItem[],
): BroadcastPreview {
  const excluded_by_reason: Partial<Record<BroadcastPreviewExcludedReason, number>> = {}
  for (const x of excludedAll) excluded_by_reason[x.excluded_reason] = (excluded_by_reason[x.excluded_reason] ?? 0) + 1
  return {
    campaign,
    template_name:            campaignTemplateName(campaign),
    eligibility_rule_version: campaignRuleVersion(campaign),
    buttons:                  campaignButtons(campaign),
    can_create_draft:         campaignCanCreateDraft(campaign),
    resolved_at:              resolvedAt,
    candidate_count,
    eligible_count:           eligibleAll.length,
    excluded_count:           excludedAll.length,
    excluded_by_reason,
    eligible:                 eligibleAll.slice(0, PREVIEW_LIST_LIMIT),
    excluded:                 excludedAll.slice(0, PREVIEW_LIST_LIMIT),
    eligible_truncated:       eligibleAll.length > PREVIEW_LIST_LIMIT,
    excluded_truncated:       excludedAll.length > PREVIEW_LIST_LIMIT,
    revalidation_required_before_send: DRAFT_REQUIRES_REVALIDATION_BEFORE_SEND,
  }
}

function withMediaWarning(w: BroadcastPreviewWarning[], m: BroadcastPreviewMedia): BroadcastPreviewWarning[] {
  return m.status === 'pending_asset' ? [...w, 'media_asset_pending'] : w
}

async function computeCoordinationAudience(
  db: SupabaseLike, ctx: BroadcastAdminContext, selection: BroadcastSelection & { campaign: { type: 'coordination' } }, resolvedAt: string,
): Promise<BroadcastPreview> {
  const campaign = selection.campaign
  const [{ orders, not_found_ids }, pool, existing] = await Promise.all([
    resolveBroadcastCandidates(db, ctx.storeId, selection, resolvedAt),
    loadActivePool(db, ctx.storeId),
    loadExistingBroadcastRows(db, ctx.storeId, campaignTemplateName(campaign)),
  ])

  const cls = classifyBroadcastCandidates(orders, existing, pool, { segment: campaign.segment, crossSegmentAmbiguity: true })
  const byId = new Map(orders.map(o => [o.id, o]))

  // Sub-filtro de ruta (confirmed_unpaid): se aplica DESPUÉS de la
  // elegibilidad y de la ambigüedad — nunca relaja reglas, solo acota.
  const routeOut = cls.eligible.filter(e => !routeMatches(campaign, byId.get(e.order_id)!))
  const eligibleAll: EligibleItem[] = cls.eligible.filter(e => routeMatches(campaign, byId.get(e.order_id)!)).map(e => {
    const o = byId.get(e.order_id)!
    const { offer_kind, media, fitsFixedTemplate } = mediaFor(o)
    const warnings = withMediaWarning(e.warnings, media)
    return {
      order_id: e.order_id, order_number: o.order_number, customer_name: o.customer_name,
      phone_normalized: e.phone_normalized,
      warnings: fitsFixedTemplate ? warnings : [...warnings, 'requires_template_variables'],
      message_preview: renderCoordinationMessage(o), offer_kind, media,
    }
  })
  const excludedAll: ExcludedItem[] = [
    ...routeOut.map(e => {
      const o = byId.get(e.order_id)!
      return { order_id: e.order_id, order_number: o.order_number, customer_name: o.customer_name, excluded_reason: 'route_filter_mismatch' as const }
    }),
    ...cls.excluded.map(x => {
      const o = byId.get(x.order_id)
      return { order_id: x.order_id, order_number: o?.order_number ?? null, customer_name: o?.customer_name ?? null,
               excluded_reason: x.excluded_reason as BroadcastPreviewExcludedReason }
    }),
    ...not_found_ids.map(id => ({ order_id: id, order_number: null, customer_name: null, excluded_reason: 'not_found' as const })),
  ]
  return packPreview(campaign, resolvedAt, orders.length + not_found_ids.length, eligibleAll, excludedAll)
}

/** Compra completada = Pagado (payment_status='paid'), no devuelta, Shopify real. */
export function isCompletedPurchase(o: BroadcastOrderRow): boolean {
  return o.payment_status === 'paid' && !!o.paid_at && o.normalized_status !== 'returned'
    && o.source === 'shopify_webhook' && !!o.shopify_order_id && o.is_test !== true && o.archived_at == null
}

/**
 * RECOMPRA — unidad = cliente (teléfono normalizado). Frontera congelada:
 *   - candidatos: clientes con ≥1 compra completada que ya existía y estaba
 *     pagada en resolved_at (created_at <= T0 y paid_at <= T0);
 *   - ventana anclada a T0: la última compra debe ser <= T0 − window_days.
 *     Revalidar mañana NO hace cruzar la ventana a nadie nuevo.
 *   - el estado ACTUAL solo puede excluir: una compra nueva posterior →
 *     recent_purchase; un pedido activo en curso → active_order_in_progress.
 * Un pedido cancelled NO veta al cliente (solo cuentan compras completadas y
 * pedidos activos). Pedido ancla = última compra completada (identidad para
 * UNIQUE(order_id, template_name) en Sprint C). El ancla NO define la oferta:
 * B.2.1 usa la oferta estándar REPURCHASE_OFFER para todos.
 */
async function computeRepurchaseAudience(
  db: SupabaseLike, ctx: BroadcastAdminContext, campaign: BroadcastCampaign & { type: 'repurchase' }, resolvedAt: string,
): Promise<BroadcastPreview> {
  const [paid, pool, existing] = await Promise.all([
    loadPaidOrders(db, ctx.storeId),
    loadActivePool(db, ctx.storeId),
    loadExistingBroadcastRows(db, ctx.storeId, campaignTemplateName(campaign)),
  ])
  const t0 = Date.parse(resolvedAt)
  const windowLimit = t0 - campaign.window_days * 24 * 60 * 60 * 1000
  const contactedAnchors = new Set(existing.map(r => r.order_id))
  const activePhones = new Set(pool.map(activeCoordinationPhone).filter((p): p is string => !!p))

  const completed = paid.filter(isCompletedPurchase)
  const atT0 = completed.filter(o => existedAt(o, resolvedAt) && Date.parse(o.paid_at!) <= t0)

  const byPhone = new Map<string, BroadcastOrderRow[]>()   // todas las compras completadas actuales
  for (const o of completed) {
    const phone = normalizeBroadcastPhone(o.customer_phone)
    if (!phone) continue
    byPhone.set(phone, [...(byPhone.get(phone) ?? []), o])
  }

  const eligibleAll: EligibleItem[] = []
  const excludedAll: ExcludedItem[] = []
  const candidatePhones = new Set<string>()
  let candidates = 0

  for (const o of atT0) {
    const phone = normalizeBroadcastPhone(o.customer_phone)
    if (!phone) {
      candidates++
      excludedAll.push({ order_id: o.id, order_number: o.order_number, customer_name: o.customer_name, excluded_reason: 'invalid_phone' })
      continue
    }
    if (candidatePhones.has(phone)) continue
    candidatePhones.add(phone)
    candidates++

    const anchor = [...byPhone.get(phone)!].sort((a, b) => Date.parse(b.paid_at!) - Date.parse(a.paid_at!))[0]
    const ex = (reason: BroadcastPreviewExcludedReason) =>
      excludedAll.push({ order_id: anchor.id, order_number: anchor.order_number, customer_name: anchor.customer_name, excluded_reason: reason })

    if (!isSantoDomingoOrder(anchor.city, anchor.province, anchor.customer_address)) { ex('not_santo_domingo'); continue }
    if (Date.parse(anchor.paid_at!) > windowLimit) { ex('recent_purchase'); continue }
    if (activePhones.has(phone)) { ex('active_order_in_progress'); continue }
    if (contactedAnchors.has(anchor.id)) { ex('repurchase_already_contacted'); continue }

    // Oferta estándar de recompra (no la compra histórica) + su imagen propia.
    const media = mediaOf('luma_repurchase')
    eligibleAll.push({
      order_id: anchor.id, order_number: anchor.order_number, customer_name: anchor.customer_name,
      phone_normalized: phone, warnings: withMediaWarning([], media),
      message_preview: renderRepurchaseMessage(anchor), offer_kind: 'repurchase_standard', media,
    })
  }
  return packPreview(campaign, resolvedAt, candidates, eligibleAll, excludedAll)
}

export async function computeBroadcastAudience(
  db: SupabaseLike,
  ctx: BroadcastAdminContext,
  selection: BroadcastSelection,
  resolvedAt: string,
): Promise<BroadcastPreview> {
  if (selection.campaign.type === 'repurchase') {
    return computeRepurchaseAudience(db, ctx, selection.campaign, resolvedAt)
  }
  return computeCoordinationAudience(db, ctx, selection as BroadcastSelection & { campaign: { type: 'coordination' } }, resolvedAt)
}

// ── Draft ────────────────────────────────────────────────────────────────────

export interface BroadcastDraftRow {
  id: string; store_id: string; template_name: string; status: string; created_by: string
  request_key: string
  selection_filter: Record<string, unknown>; eligibility_rule_version: string
  candidate_count: number; eligible_count: number; excluded_count: number
  excluded_by_reason: Record<string, number>; created_at: string
}

export type CreateDraftResult =
  | { ok: true;  broadcast: BroadcastDraftRow; replay: boolean }
  | { ok: false; status: number; error: string }

/**
 * selection_filter: reproduce/audita cómo nació el draft y define su frontera
 * de audiencia (ids o filtros allowlisted + resolved_at). Nunca datos del pedido.
 * request_key NO va aquí: es columna propia con UNIQUE (065).
 */
export function buildSelectionFilter(selection: BroadcastSelection, resolvedAt: string) {
  return selection.mode === 'selected_ids'
    ? { mode: 'selected_ids', order_ids: selection.order_ids, campaign: selection.campaign, resolved_at: resolvedAt }
    : { mode: 'filtered', filters: selection.filters, campaign: selection.campaign, resolved_at: resolvedAt }
}

/** Reconstruye la selección + cutoff guardados en un draft (validados de nuevo). */
export function audienceFromDraft(selectionFilter: Record<string, unknown>): { selection: BroadcastSelection; resolvedAt: string } {
  const resolvedAt = selectionFilter.resolved_at
  if (typeof resolvedAt !== 'string' || Number.isNaN(Date.parse(resolvedAt))) {
    throw new Error('draft sin resolved_at válido')
  }
  // Drafts B/B.1 no tienen campaign → coordinación/pendientes.
  const parsed = parseBroadcastSelection(
    selectionFilter.mode === 'selected_ids'
      ? { mode: 'selected_ids', order_ids: selectionFilter.order_ids, campaign: selectionFilter.campaign }
      : { mode: selectionFilter.mode, filters: selectionFilter.filters, campaign: selectionFilter.campaign },
  )
  if (!parsed.ok) throw new Error(`selection_filter inválido: ${parsed.error}`)
  return { selection: parsed.selection, resolvedAt }
}

/**
 * Revalidación de un draft (lo usará Sprint C antes de encolar). READ ONLY.
 * Misma función que preview/create, con la frontera ORIGINAL del draft:
 * nunca amplía la audiencia, solo puede reducirla.
 */
export async function revalidateDraftAudience(
  db: SupabaseLike,
  ctx: BroadcastAdminContext,
  draft: Pick<BroadcastDraftRow, 'store_id' | 'selection_filter'>,
): Promise<BroadcastPreview> {
  if (draft.store_id !== ctx.storeId) throw new Error('draft de otra tienda')
  const { selection, resolvedAt } = audienceFromDraft(draft.selection_filter)
  return computeBroadcastAudience(db, ctx, selection, resolvedAt)
}

async function findDraftByRequestKey(db: SupabaseLike, storeId: string, requestKey: string): Promise<BroadcastDraftRow | null> {
  const { data, error } = await db.from('wa_broadcasts').select('*')
    .eq('store_id', storeId).eq('request_key', requestKey).maybeSingle()
  if (error) throw new Error(`wa_broadcasts(request_key): ${error.message ?? String(error)}`)
  return (data as BroadcastDraftRow | null) ?? null
}

function replayOf(prior: BroadcastDraftRow, ctx: BroadcastAdminContext): CreateDraftResult {
  // Misma key de otro admin de la tienda: no se le entrega un draft ajeno.
  if (prior.created_by !== ctx.userId) return { ok: false, status: 409, error: 'request_key ya utilizada' }
  return { ok: true, broadcast: prior, replay: true }
}

/**
 * Crea UN draft por (store_id, request_key). Idempotente también ante
 * concurrencia: el UNIQUE de la DB (065) decide; la request que pierde recibe
 * 23505 y devuelve el draft ganador. Recalcula todo en el servidor.
 */
export async function createBroadcastDraft(
  db: SupabaseLike,
  ctx: BroadcastAdminContext,
  selection: BroadcastSelection,
  requestKey: string,
): Promise<CreateDraftResult> {
  // Recompra: solo preview en B.2 — los CHECK de 064 aún no aceptan
  // 'sd_broadcast_repurchase' (propuesta migración 066, Sprint C).
  if (!campaignCanCreateDraft(selection.campaign)) {
    return { ok: false, status: 422, error: 'Recompra: solo preview por ahora — crear borrador requiere la migración 066 (Sprint C)' }
  }

  const prior = await findDraftByRequestKey(db, ctx.storeId, requestKey)
  if (prior) return replayOf(prior, ctx)

  // resolved_at se fija ANTES de resolver: el propio cálculo ya respeta el cutoff.
  const resolvedAt = new Date().toISOString()
  const audience = await computeBroadcastAudience(db, ctx, selection, resolvedAt)
  if (audience.eligible_count === 0) {
    return { ok: false, status: 422, error: 'No hay pedidos elegibles en esta selección' }
  }

  const { data, error } = await db.from('wa_broadcasts').insert({
    store_id:                 ctx.storeId,
    created_by:               ctx.userId,
    request_key:              requestKey,
    template_name:            campaignTemplateName(selection.campaign),
    status:                   'draft',
    selection_filter:         buildSelectionFilter(selection, resolvedAt),
    eligibility_rule_version: campaignRuleVersion(selection.campaign),
    candidate_count:          audience.candidate_count,
    eligible_count:           audience.eligible_count,
    excluded_count:           audience.excluded_count,
    excluded_by_reason:       audience.excluded_by_reason,
  }).select('*').single()

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const winner = await findDraftByRequestKey(db, ctx.storeId, requestKey)
      if (winner) return replayOf(winner, ctx)
    }
    throw new Error(`wa_broadcasts(insert): ${error.message ?? String(error)}`)
  }

  return { ok: true, broadcast: data as BroadcastDraftRow, replay: false }
}

export async function listBroadcasts(db: SupabaseLike, storeId: string, limit = 50) {
  const { data, error } = await db.from('wa_broadcasts')
    .select('id, template_name, status, created_by, created_at, candidate_count, eligible_count, excluded_count, excluded_by_reason, selection_filter, eligibility_rule_version, creator:profiles(full_name)')
    .eq('store_id', storeId).order('created_at', { ascending: false }).limit(limit)
  if (error) throw new Error(`wa_broadcasts(list): ${error.message ?? String(error)}`)
  return data ?? []
}
