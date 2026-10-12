// Sprint C.1 — lanzamiento de una campaña (draft → queued) + pausa/reanudación.
//
// SERVER-ONLY. Reutiliza B.2 sin duplicarlo:
//   - la audiencia se REVALIDA con revalidateDraftAudience() (misma función
//     que preview/create, con la frontera congelada del draft: solo puede
//     reducirse, nunca ampliarse);
//   - sobre esa audiencia se aplican las exclusiones propias del ENVÍO real:
//       offer_incompatible      — su oferta no calza con el texto fijo del template
//       media_asset_pending     — la imagen de su oferta no existe
//       marketing_opt_out       — pidió no recibir mensajes promocionales
//       phone_already_contacted — ese número ya recibió (o tiene en curso) este template
//   - el lote se acota con send_limit (piloto 10–20) y el admin debe
//     confirmar EXACTAMENTE la cantidad calculada en el servidor.
//
// C.1.4 (F1/F5) — PREPARAR antes de ENCOLAR:
//   1. Reserva: el borrador queda asociado a launch_request_key (UPDATE
//      condicional, sigue en 'draft'). launched_at marca el inicio del intento.
//   2. Preparación: las filas de cola se insertan por bloques MIENTRAS la
//      campaña sigue en 'draft'. El processor solo mira campañas
//      queued/processing → no puede verlas ni declarar la campaña
//      'completed' a medio insertar (carrera de C.1 eliminada por diseño, sin
//      depender de queued_count).
//   3. Encolado: draft → queued (UPDATE condicional a status='draft' + misma
//      clave) solo cuando TODAS las filas del lote existen. Después del
//      encolado nunca se insertan más filas.
//   Lote CONGELADO: al reservar, los order_ids confirmados por el admin se
//   guardan en selection_filter.launch_order_ids. Desde ese momento toda
//   vista previa / reintento / retoma de ese borrador queda limitada a ese
//   conjunto: un pedido que deja de ser elegible se excluye, pero nunca se
//   sustituye por otro, y el lote nunca supera lo confirmado (≤ send_limit).
//   Interrupciones: si se agota el presupuesto de tiempo, se devuelve
//   `partial` y el cliente repite con la MISMA clave; si la función muere,
//   repetir con la misma clave continúa donde quedó. Una preparación
//   abandonada (otra clave, > LAUNCH_PREP_STALE_MS) puede retomarse con una
//   clave nueva tras una nueva confirmación. Las filas de intentos anteriores
//   que ya no están en el lote (dejaron de ser enviables) se eliminan antes
//   de encolar: nunca se procesaron.
//
// Idempotencia:
//   - launch_request_key (UNIQUE por tienda, 066): reintentar con la misma
//     clave devuelve el mismo lanzamiento;
//   - filas de cola: UNIQUE(order_id, template_name) (033) y
//     UNIQUE(broadcast_id, phone_normalized) (066) — un 23505 se absorbe.
//   - idx_wa_broadcasts_one_running: una sola campaña activa por tienda (se
//     comprueba también ANTES de preparar filas).
//
// WA_BROADCAST_ENABLED se exige para lanzar y reanudar (aquí) y de nuevo en
// el processor justo antes de cada envío. Pausar y cancelar siempre están
// permitidos.

import {
  revalidateDraftAudience,
  type BroadcastAdminContext,
  type BroadcastDraftRow,
  type BroadcastPreview,
} from './broadcast-service'
import { audienceFromDraft, computeBroadcastAudience } from './broadcast-service'
import {
  MAX_LAUNCH_SIZE, PILOT_DEFAULT_LIMIT, campaignLabel, campaignGroup, templateCompatibility, type BroadcastGroup, type BroadcastTemplateName,
} from './campaign'
import { buildBodyParamsFor, buildConfirmationBodyParams, resolveTemplateConfig } from './templates'
import { selectionTemplate, type BroadcastSelection } from './selection'
import { loadOptedOutPhones } from './suppression'
import { loadPhoneStatuses, type PhoneRestriction } from './phone-rules'
import { releaseUnsentRecipients } from './cancel'

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

// Tope duro por lanzamiento: la lista de elegibles de la revalidación se
// entrega completa hasta PREVIEW_LIST_LIMIT (300); nunca se lanza más.
// Definidos en campaign.ts (client-safe) para que el asistente use los mismos.
export { MAX_LAUNCH_SIZE, PILOT_DEFAULT_LIMIT }

// F5 — preparación por bloques dentro del presupuesto de la función.
// La ruta de lanzamiento declara maxDuration = 60 s (válido en todos los
// planes de Vercel); la preparación se corta a los 40 s (contados desde el
// inicio de launchBroadcast) y devuelve `partial` con margen para responder.
export const LAUNCH_INSERT_CHUNK = 50
export const LAUNCH_TIME_BUDGET_MS = 40_000
// Una preparación sin actividad por más de esto (> maxDuration) está muerta
// y puede retomarse con otra clave.
export const LAUNCH_PREP_STALE_MS = 2 * 60_000

export type LaunchExcludedReason =
  | 'offer_incompatible' | 'media_asset_pending' | 'marketing_opt_out' | 'phone_already_contacted'
  | PhoneRestriction

export interface LaunchRecipient {
  order_id: string; order_number: string | null; customer_name: string | null
  phone_normalized: string; warnings: string[]
  body_params: string[]                       // variables EXACTAS del template para este destinatario
}

export interface LaunchExcludedItem {
  order_id: string; order_number: string | null; customer_name: string | null; reason: LaunchExcludedReason
}

export interface LaunchPreview {
  broadcast_id:   string
  template_name:  BroadcastTemplateName
  group:          BroadcastGroup
  campaign_label: string
  header_image_url: string | null           // imagen pública del encabezado (null si falta configurar)
  launch_excluded: LaunchExcludedItem[]      // detalle de exclusiones propias del envío (máx. 300)
  // C.2: destinatarios de la selección que dejaron de ser elegibles al revalidar
  // (p.ej. un cliente elegido a mano que ya pagó). Se excluyen, nunca se sustituyen.
  audience_excluded: Array<{ order_id: string; order_number: string | null; customer_name: string | null; reason: string }>
  revalidated:    Pick<BroadcastPreview, 'candidate_count' | 'eligible_count' | 'excluded_count' | 'excluded_by_reason' | 'resolved_at'>
  launch_excluded_by_reason: Partial<Record<LaunchExcludedReason, number>>
  sendable_count: number
  send_limit:     number
  batch:          LaunchRecipient[]          // exactamente lo que se encolaría
  not_in_batch:   number                     // elegibles que quedan para una fase posterior
  template_ready: boolean
  template_missing: string[]
  eligible_list_truncated: boolean
  // F1/F5 — destinatarios ya preparados por un intento anterior de lanzamiento
  // de este borrador (van primero en `batch`), y estado de esa preparación.
  prepared_count: number
  // Tamaño del lote congelado al confirmar (null = aún no confirmado).
  frozen_count: number | null
  preparation: 'none' | 'in_progress' | 'interrupted'
}

export type LaunchPreviewResult =
  | { ok: true; preview: LaunchPreview }
  | { ok: false; status: number; error: string }

/**
 * Oferta compatible con el template de coordinación: única fuente de verdad
 * es buildConfirmationBodyParams (templates.ts) — si no se pueden construir
 * los 5 parámetros del texto aprobado, el pedido no se envía.
 */
export function orderFitsConfirmationTemplate(o: { product_summary: string | null; cod_amount: number | string | null }): boolean {
  return buildConfirmationBodyParams({ customer_name: null, product_summary: o.product_summary, cod_amount: o.cod_amount }).ok
}

async function loadDraft(db: SupabaseLike, storeId: string, id: string): Promise<BroadcastDraftRow & Record<string, unknown> | null> {
  const { data, error } = await db.from('wa_broadcasts').select('*').eq('id', id).eq('store_id', storeId).maybeSingle()
  if (error) throw new Error(`wa_broadcasts: ${error.message ?? String(error)}`)
  return data ?? null
}

type OwnRow = { id: string; order_id: string; status: string }

async function loadOwnRows(db: SupabaseLike, broadcastId: string): Promise<OwnRow[]> {
  const { data, error } = await db.from('wa_template_queue').select('id, order_id, status').eq('broadcast_id', broadcastId)
  if (error) throw new Error(`wa_template_queue(own): ${error.message ?? String(error)}`)
  return (data ?? []) as OwnRow[]
}

function preparationState(draft: Record<string, unknown>, ownCount: number, nowMs: number): LaunchPreview['preparation'] {
  if (draft.status !== 'draft' || !draft.launch_request_key) return 'none'
  return isPreparationStale(draft, nowMs) ? (ownCount > 0 ? 'interrupted' : 'none') : 'in_progress'
}

/** Lote confirmado y congelado al reservar (null si el borrador no se ha lanzado). */
function frozenLaunchIds(draft: Record<string, unknown>): Set<string> | null {
  const sf = draft.selection_filter as Record<string, unknown> | null | undefined
  const ids = sf?.launch_order_ids
  return Array.isArray(ids) ? new Set(ids.filter((x): x is string => typeof x === 'string')) : null
}

function isPreparationStale(draft: Record<string, unknown>, nowMs: number): boolean {
  const t = typeof draft.launched_at === 'string' ? Date.parse(draft.launched_at) : NaN
  return Number.isNaN(t) || nowMs - t > LAUNCH_PREP_STALE_MS
}

async function loadOfferFields(db: SupabaseLike, storeId: string, ids: string[]): Promise<Map<string, { product_summary: string | null; cod_amount: number | string | null }>> {
  const out = new Map<string, { product_summary: string | null; cod_amount: number | string | null }>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('orders').select('id, product_summary, cod_amount')
      .eq('store_id', storeId).in('id', ids.slice(i, i + 100))
    if (error) throw new Error(`orders(offer): ${error.message ?? String(error)}`)
    for (const r of (data ?? []) as Array<{ id: string; product_summary: string | null; cod_amount: number | string | null }>) out.set(r.id, r)
  }
  return out
}

async function phonesAlreadyContacted(db: SupabaseLike, storeId: string, template: string, phones: string[], excludeBroadcastId?: string): Promise<Set<string>> {
  const out = new Set<string>()
  const unique = [...new Set(phones)]
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await db.from('wa_template_queue').select('phone_normalized, broadcast_id, status')
      .eq('store_id', storeId).eq('template_name', template).in('phone_normalized', unique.slice(i, i + 100))
    if (error) throw new Error(`wa_template_queue(phones): ${error.message ?? String(error)}`)
    for (const r of (data ?? []) as Array<{ phone_normalized: string; broadcast_id: string | null; status: string }>) {
      if (excludeBroadcastId && r.broadcast_id === excludeBroadcastId) continue
      // skipped = nunca se envió (p.ej. revalidación); no cuenta como contactado.
      if (r.status !== 'skipped') out.add(r.phone_normalized)
    }
  }
  return out
}

export interface SendableResult {
  template:                  BroadcastTemplateName
  group:                     BroadcastGroup
  audience:                  BroadcastPreview
  sendable:                  LaunchRecipient[]
  launch_excluded_by_reason: Partial<Record<LaunchExcludedReason, number>>
  launch_excluded:           LaunchExcludedItem[]
  template_ready:            boolean
  template_missing:          string[]
  header_image_url:          string | null
}

/**
 * Enviables de una selección para su template — ÚNICA implementación, usada por
 * la vista previa de lanzamiento (con borrador) y por el asistente (sin borrador).
 * READ ONLY. Sobre la audiencia ya revalidada aplica, en orden:
 *   1. regla comercial del template (recuperación: oferta 2×1 exacta; recompra:
 *      la audiencia ya exige compra completada) e imagen aprobada;
 *   2. baja promocional;
 *   3. teléfono ya contactado con ESE template;
 *   4. reglas por teléfono de todos los templates (131026, 131049, 7 días).
 */
export async function computeSendable(
  db: SupabaseLike, ctx: BroadcastAdminContext, selection: BroadcastSelection, audience: BroadcastPreview,
  o: { broadcastId?: string; frozen?: Set<string> | null } = {},
  env: Record<string, string | undefined> = process.env, nowMs: () => number = Date.now,
): Promise<SendableResult> {
  const template = selectionTemplate(selection)
  const phones = audience.eligible.map(e => e.phone_normalized)
  const [optedOut, contacted, offers, phoneStatus] = await Promise.all([
    loadOptedOutPhones(db, ctx.storeId, phones),
    phonesAlreadyContacted(db, ctx.storeId, template, phones, o.broadcastId),
    loadOfferFields(db, ctx.storeId, audience.eligible.map(e => e.order_id)),
    loadPhoneStatuses(db, ctx.storeId, phones, { nowMs: nowMs(), excludeBroadcastId: o.broadcastId }),
  ])

  const launchExcluded: Partial<Record<LaunchExcludedReason, number>> = {}
  const excludedItems: LaunchExcludedItem[] = []
  const sendable: LaunchRecipient[] = []
  for (const e of audience.eligible) {
    if (o.frozen && !o.frozen.has(e.order_id)) continue   // fuera del lote confirmado: nunca entra
    const exclude = (reason: LaunchExcludedReason) => {
      launchExcluded[reason] = (launchExcluded[reason] ?? 0) + 1
      if (excludedItems.length < 300) excludedItems.push({ order_id: e.order_id, order_number: e.order_number, customer_name: e.customer_name, reason })
    }
    const offerRow = offers.get(e.order_id)
    if (template === 'sd_broadcast_confirmation'
        && (e.warnings.includes('requires_template_variables') || !offerRow || !orderFitsConfirmationTemplate(offerRow))) {
      exclude('offer_incompatible'); continue
    }
    if (e.media.status !== 'approved')                 { exclude('media_asset_pending'); continue }
    if (optedOut.has(e.phone_normalized))              { exclude('marketing_opt_out'); continue }
    if (contacted.has(e.phone_normalized))             { exclude('phone_already_contacted'); continue }
    const restriction = phoneStatus.get(e.phone_normalized)?.restriction
    if (restriction)                                   { exclude(restriction); continue }
    const params = buildBodyParamsFor(template, {
      customer_name: e.customer_name, product_summary: offerRow?.product_summary ?? null, cod_amount: offerRow?.cod_amount ?? null,
    })
    if (!params.ok)                                    { exclude('offer_incompatible'); continue }
    sendable.push({ order_id: e.order_id, order_number: e.order_number, customer_name: e.customer_name,
                    phone_normalized: e.phone_normalized, warnings: e.warnings, body_params: params.params })
  }

  const tpl = resolveTemplateConfig(template, env)
  return {
    template, group: campaignGroup(selection.campaign), audience, sendable,
    launch_excluded_by_reason: launchExcluded, launch_excluded: excludedItems,
    template_ready: tpl.ok, template_missing: tpl.ok ? [] : [...tpl.missing, ...tpl.invalid],
    header_image_url: tpl.ok ? tpl.config.headerImageUrl : null,
  }
}

/**
 * Lo que se enviaría AHORA para un borrador. READ ONLY. Mismo cálculo que usa
 * launchBroadcast (que lo vuelve a ejecutar en el momento de lanzar).
 */
export async function computeLaunchPreview(
  db: SupabaseLike, ctx: BroadcastAdminContext, broadcastId: string, requestedLimit: number | null,
  env: Record<string, string | undefined> = process.env, nowMs: () => number = Date.now,
): Promise<LaunchPreviewResult> {
  const draft = await loadDraft(db, ctx.storeId, broadcastId)
  if (!draft) return { ok: false, status: 404, error: 'Campaña no encontrada' }

  const { selection } = audienceFromDraft(draft.selection_filter)
  const template = selectionTemplate(selection)
  if (template !== draft.template_name) return { ok: false, status: 422, error: 'El template del borrador no coincide con su selección' }
  const compat = templateCompatibility(template, selection.campaign)
  if (!compat.ok) return { ok: false, status: 422, error: compat.reason }
  const limit = Math.min(Math.max(1, Math.floor(requestedLimit ?? PILOT_DEFAULT_LIMIT)), MAX_LAUNCH_SIZE)

  // Las filas que ESTE borrador ya preparó no lo excluyen de su revalidación.
  const [audience, own] = await Promise.all([
    revalidateDraftAudience(db, ctx, draft, { ignoreQueueRowsOfBroadcast: draft.id, fullLists: true }),
    loadOwnRows(db, draft.id),
  ])
  const frozen = frozenLaunchIds(draft)
  const r = await computeSendable(db, ctx, selection, audience, { broadcastId: draft.id, frozen }, env, nowMs)
  const sendable = r.sendable

  // Ya preparados primero (orden estable): retomar un lanzamiento converge
  // al mismo lote en vez de sumar destinatarios nuevos.
  const ownOrders = new Set(own.map(x => x.order_id))
  sendable.sort((a, b) => Number(ownOrders.has(b.order_id)) - Number(ownOrders.has(a.order_id)))

  return {
    ok: true,
    preview: {
      broadcast_id: draft.id,
      template_name: template,
      group: r.group,
      campaign_label: campaignLabel(selection.campaign),
      header_image_url: r.header_image_url,
      launch_excluded: r.launch_excluded,
      audience_excluded: audience.excluded.slice(0, 300).map(x => ({
        order_id: x.order_id, order_number: x.order_number, customer_name: x.customer_name, reason: x.excluded_reason,
      })),
      revalidated: {
        candidate_count: audience.candidate_count, eligible_count: audience.eligible_count,
        excluded_count: audience.excluded_count, excluded_by_reason: audience.excluded_by_reason, resolved_at: audience.resolved_at,
      },
      launch_excluded_by_reason: r.launch_excluded_by_reason,
      sendable_count: sendable.length,
      send_limit: limit,
      batch: sendable.slice(0, limit),
      not_in_batch: Math.max(0, sendable.length - limit),
      template_ready: r.template_ready,
      template_missing: r.template_missing,
      eligible_list_truncated: audience.eligible_truncated,
      prepared_count: own.length,
      frozen_count: frozen ? frozen.size : null,
      preparation: preparationState(draft, own.length, nowMs()),
    },
  }
}

/** Asistente (sin borrador): enviables de una selección ahora mismo. READ ONLY. */
export async function computeSelectionSendable(
  db: SupabaseLike, ctx: BroadcastAdminContext, selection: BroadcastSelection,
  env: Record<string, string | undefined> = process.env, nowMs: () => number = Date.now,
): Promise<SendableResult> {
  const audience = await computeBroadcastAudience(db, ctx, selection, new Date(nowMs()).toISOString(), { fullLists: true })
  return computeSendable(db, ctx, selection, audience, {}, env, nowMs)
}

export interface LaunchInput {
  broadcastId:      string
  launchRequestKey: string
  sendLimit:        number
  confirmCount:     number      // el admin confirma la cantidad exacta que vio
}

export type LaunchResult =
  | { ok: true; replay: boolean; queued: number; broadcast_id: string; partial?: false }
  // F5: presupuesto de tiempo agotado a mitad de la preparación. La campaña
  // sigue en 'draft' (nada se envía); el cliente repite con la MISMA clave.
  | { ok: true; replay: boolean; partial: true; prepared: number; target: number; broadcast_id: string }
  | { ok: false; status: number; error: string; current_count?: number }

export interface LaunchClock {
  msNow?:    () => number
  budgetMs?: number
}

async function countBroadcastRows(db: SupabaseLike, broadcastId: string): Promise<number> {
  const { data, error } = await db.from('wa_template_queue').select('id').eq('broadcast_id', broadcastId)
  if (error) throw new Error(`wa_template_queue(count): ${error.message ?? String(error)}`)
  return (data ?? []).length
}

async function activeCampaignOf(db: SupabaseLike, storeId: string, exceptId: string): Promise<string | null> {
  const { data, error } = await db.from('wa_broadcasts').select('id')
    .eq('store_id', storeId).in('status', ['queued', 'processing', 'paused']).neq('id', exceptId).limit(1)
  if (error) throw new Error(`wa_broadcasts(active): ${error.message ?? String(error)}`)
  return (data ?? [])[0]?.id ?? null
}

async function stillPreparing(db: SupabaseLike, broadcastId: string, key: string): Promise<boolean> {
  const { data } = await db.from('wa_broadcasts').select('status, launch_request_key').eq('id', broadcastId).maybeSingle()
  const b = data as { status: string; launch_request_key: string | null } | null
  return !!b && b.status === 'draft' && b.launch_request_key === key
}

/** Un bloque = un INSERT. Si choca con un UNIQUE, se reintenta fila a fila absorbiendo 23505. */
async function insertChunk(db: SupabaseLike, storeId: string, broadcastId: string, template: string, recipients: LaunchRecipient[], scheduledAt: string): Promise<void> {
  const toRow = (r: LaunchRecipient) => ({
    store_id: storeId, order_id: r.order_id, template_name: template, phone_normalized: r.phone_normalized,
    scheduled_at: scheduledAt, status: 'pending', broadcast_id: broadcastId,
  })
  const { error } = await db.from('wa_template_queue').insert(recipients.map(toRow))
  if (!error) return
  if (error.code !== '23505') throw new Error(`wa_template_queue(insert): ${error.message ?? String(error)}`)
  for (const r of recipients) {
    const { error: e } = await db.from('wa_template_queue').insert(toRow(r))
    if (e && e.code !== '23505') throw new Error(`wa_template_queue(insert): ${e.message ?? String(e)}`)
  }
}

type PrepOutcome = { state: 'done' | 'partial' | 'aborted'; count: number }

async function prepareRecipients(
  db: SupabaseLike, storeId: string, broadcastId: string, key: string, template: string, batch: LaunchRecipient[],
  scheduledAt: string, deadline: number, msNow: () => number,
): Promise<PrepOutcome> {
  const own = await loadOwnRows(db, broadcastId)
  const wanted = new Set(batch.map(r => r.order_id))

  // Reconciliación: filas de intentos anteriores que ya no están en el lote.
  // La campaña sigue en 'draft' → el processor nunca las tomó.
  const obsolete = own.filter(r => r.status === 'pending' && !wanted.has(r.order_id)).map(r => r.id)
  for (let i = 0; i < obsolete.length; i += 100) {
    const { error } = await db.from('wa_template_queue').delete()
      .in('id', obsolete.slice(i, i + 100)).eq('broadcast_id', broadcastId).eq('status', 'pending')
    if (error) throw new Error(`wa_template_queue(reconcile): ${error.message ?? String(error)}`)
  }

  const have = new Set(own.map(r => r.order_id))
  const missing = batch.filter(r => !have.has(r.order_id))
  for (let i = 0; i < missing.length; i += LAUNCH_INSERT_CHUNK) {
    if (msNow() > deadline) return { state: 'partial', count: await countBroadcastRows(db, broadcastId) }
    // Cancelada o retomada por otra clave entre bloques → se deja de insertar.
    if (!(await stillPreparing(db, broadcastId, key))) return { state: 'aborted', count: 0 }
    await insertChunk(db, storeId, broadcastId, template, missing.slice(i, i + LAUNCH_INSERT_CHUNK), scheduledAt)
  }
  return { state: 'done', count: await countBroadcastRows(db, broadcastId) }
}

/** La campaña ya no es borrador (o fue cancelada): replay solo con la MISMA clave. */
async function settledLaunch(db: SupabaseLike, b: Record<string, unknown>, key: string, nowIso: string): Promise<LaunchResult> {
  if (b.status === 'cancelled') {
    // Filas que un intento en vuelo pudo insertar tras la cancelación.
    await releaseUnsentRecipients(db, String(b.store_id), String(b.id), null, nowIso)
    return { ok: false, status: 409, error: 'La campaña fue cancelada' }
  }
  if (b.status === 'draft') return { ok: false, status: 409, error: 'Otra preparación de este envío está en curso — espera unos minutos y vuelve a abrir la vista previa' }
  if (b.launch_request_key !== key) {
    return { ok: false, status: 409, error: `La campaña ya no es un borrador (estado: ${b.status})` }
  }
  return { ok: true, replay: true, queued: await countBroadcastRows(db, String(b.id)), broadcast_id: String(b.id) }
}

export async function launchBroadcast(
  db: SupabaseLike, ctx: BroadcastAdminContext, input: LaunchInput, flagEnabled: boolean,
  env: Record<string, string | undefined> = process.env, nowFn: () => string = () => new Date().toISOString(),
  clock: LaunchClock = {},
): Promise<LaunchResult> {
  if (!flagEnabled) return { ok: false, status: 403, error: 'Broadcast desactivado (WA_BROADCAST_ENABLED)' }
  const msNow = clock.msNow ?? Date.now
  const deadline = msNow() + (clock.budgetMs ?? LAUNCH_TIME_BUDGET_MS)
  const key = input.launchRequestKey

  const draft = await loadDraft(db, ctx.storeId, input.broadcastId)
  if (!draft) return { ok: false, status: 404, error: 'Campaña no encontrada' }
  if (draft.status !== 'draft') return settledLaunch(db, draft, key, nowFn())

  const ownsKey = draft.launch_request_key === key
  if (draft.launch_request_key && !ownsKey && !isPreparationStale(draft, msNow())) {
    return { ok: false, status: 409, error: 'Otra preparación de este envío está en curso — espera unos minutos y vuelve a abrir la vista previa' }
  }
  // Otra campaña activa: se rechaza ANTES de preparar filas (el índice
  // one_running lo impediría igual al encolar, pero dejaría filas preparadas).
  if (await activeCampaignOf(db, ctx.storeId, draft.id)) {
    return { ok: false, status: 409, error: 'Ya hay otra campaña en curso o pausada en esta tienda' }
  }

  const limit = ownsKey ? Number(draft.send_limit ?? input.sendLimit) : input.sendLimit
  const pre = await computeLaunchPreview(db, ctx, draft.id, limit, env, msNow)
  if (!pre.ok) return pre
  const p = pre.preview
  if (!p.template_ready) {
    return { ok: false, status: 422, error: `Template sin configurar: ${p.template_missing.join(', ')}` }
  }
  // Clave nueva (primer intento o retomar uno abandonado) = confirmación nueva.
  // Misma clave = continuación de lo ya confirmado.
  if (!ownsKey) {
    if (p.batch.length === 0) return { ok: false, status: 422, error: 'No hay destinatarios enviables tras revalidar' }
    if (input.confirmCount !== p.batch.length) {
      return { ok: false, status: 409, error: 'La audiencia cambió desde la vista previa — revisa y confirma de nuevo', current_count: p.batch.length }
    }
  }

  // 1. Reserva del borrador para esta clave (sigue en 'draft'). La primera
  // reserva congela el lote confirmado; las siguientes no lo amplían.
  const alreadyFrozen = frozenLaunchIds(draft) !== null
  const claimQ = db.from('wa_broadcasts').update({
    launch_request_key: key, launched_by: ctx.userId, launched_at: nowFn(),
    send_limit: alreadyFrozen ? Math.min(p.send_limit, Number(draft.send_limit ?? p.send_limit)) : p.send_limit,
    queued_count: p.batch.length, launch_excluded_by_reason: p.launch_excluded_by_reason,
    ...(alreadyFrozen ? {} : { selection_filter: { ...(draft.selection_filter as Record<string, unknown>), launch_order_ids: p.batch.map(r => r.order_id) } }),
  }).eq('id', draft.id).eq('store_id', ctx.storeId).eq('status', 'draft')
  const { data: claimed, error: claimErr } = await (draft.launch_request_key
    ? claimQ.eq('launch_request_key', draft.launch_request_key)
    : claimQ.is('launch_request_key', null)).select('id').maybeSingle()
  if (claimErr) {
    if (claimErr.code === '23505') return { ok: false, status: 409, error: 'launch_request_key ya utilizada' }
    throw new Error(`wa_broadcasts(claim): ${claimErr.message ?? String(claimErr)}`)
  }
  let batch = p.batch
  if (!claimed) {
    const fresh = await loadDraft(db, ctx.storeId, draft.id)
    if (!fresh) return { ok: false, status: 404, error: 'Campaña no encontrada' }
    if (fresh.status !== 'draft' || fresh.launch_request_key !== key) return settledLaunch(db, fresh, key, nowFn())
    // La misma clave ganó en paralelo (doble clic): se continúa con el lote
    // que congeló la petición ganadora, nunca con el calculado aquí.
    const again = await computeLaunchPreview(db, ctx, draft.id, Number(fresh.send_limit ?? p.send_limit), env, msNow)
    if (!again.ok) return again
    batch = again.preview.batch
  }

  // 2. Preparación por bloques (campaña invisible para el processor).
  const prep = await prepareRecipients(db, ctx.storeId, draft.id, key, p.template_name, batch, nowFn(), deadline, msNow)
  if (prep.state === 'aborted') {
    const fresh = await loadDraft(db, ctx.storeId, draft.id)
    return fresh ? settledLaunch(db, fresh, key, nowFn()) : { ok: false, status: 404, error: 'Campaña no encontrada' }
  }
  if (prep.state === 'partial') {
    return { ok: true, replay: ownsKey, partial: true, prepared: prep.count, target: batch.length, broadcast_id: draft.id }
  }
  if (prep.count === 0) return { ok: false, status: 422, error: 'No hay destinatarios enviables tras revalidar' }

  // 3. Encolado: solo ahora el processor puede ver la campaña.
  const now = nowFn()
  const { data: moved, error: moveErr } = await db.from('wa_broadcasts').update({
    status: 'queued', launched_at: now, started_at: now, queued_count: prep.count,
  }).eq('id', draft.id).eq('store_id', ctx.storeId).eq('status', 'draft').eq('launch_request_key', key).select('id').maybeSingle()
  if (moveErr) {
    if (moveErr.code === '23505') {
      // Las filas quedan preparadas en el borrador (invisibles al processor):
      // se puede reintentar cuando termine la otra campaña, o cancelar.
      return { ok: false, status: 409, error: 'Ya hay otra campaña en curso o pausada en esta tienda' }
    }
    throw new Error(`wa_broadcasts(launch): ${moveErr.message ?? String(moveErr)}`)
  }
  if (!moved) {
    const fresh = await loadDraft(db, ctx.storeId, draft.id)
    return fresh ? settledLaunch(db, fresh, key, nowFn()) : { ok: false, status: 404, error: 'Campaña no encontrada' }
  }
  return { ok: true, replay: ownsKey, queued: prep.count, broadcast_id: draft.id }
}

export async function pauseBroadcast(db: SupabaseLike, ctx: BroadcastAdminContext, id: string, nowFn = () => new Date().toISOString()) {
  const { data, error } = await db.from('wa_broadcasts')
    .update({ status: 'paused', paused_at: nowFn(), paused_by: ctx.userId })
    .eq('id', id).eq('store_id', ctx.storeId).in('status', ['queued', 'processing']).select('id, status').maybeSingle()
  if (error) throw new Error(`wa_broadcasts(pause): ${error.message ?? String(error)}`)
  return data ? { ok: true as const } : { ok: false as const, status: 409, error: 'Solo se puede pausar una campaña en cola o en proceso' }
}

export async function resumeBroadcast(db: SupabaseLike, ctx: BroadcastAdminContext, id: string, flagEnabled: boolean, nowFn = () => new Date().toISOString()) {
  if (!flagEnabled) return { ok: false as const, status: 403, error: 'Broadcast desactivado (WA_BROADCAST_ENABLED)' }
  const { data, error } = await db.from('wa_broadcasts')
    .update({ status: 'queued', resumed_at: nowFn(), resumed_by: ctx.userId })
    .eq('id', id).eq('store_id', ctx.storeId).eq('status', 'paused').select('id, status').maybeSingle()
  if (error) throw new Error(`wa_broadcasts(resume): ${error.message ?? String(error)}`)
  return data ? { ok: true as const } : { ok: false as const, status: 409, error: 'Solo se puede reanudar una campaña pausada' }
}
