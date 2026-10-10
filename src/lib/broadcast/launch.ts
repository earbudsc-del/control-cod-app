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
// Idempotencia:
//   - draft → queued es un UPDATE condicional (status='draft'): un doble
//     clic o dos pestañas no pueden lanzar dos veces;
//   - launch_request_key (UNIQUE por tienda, 066): reintentar con la misma
//     clave devuelve el mismo lanzamiento y completa filas faltantes sin
//     superar send_limit;
//   - filas de cola: UNIQUE(order_id, template_name) (033) y
//     UNIQUE(broadcast_id, phone_normalized) (066) — un 23505 se absorbe.
//   - idx_wa_broadcasts_one_running: una sola campaña activa por tienda.
//
// WA_BROADCAST_ENABLED se exige para lanzar y reanudar (aquí) y de nuevo en
// el processor justo antes de cada envío. Pausar siempre está permitido.

import {
  revalidateDraftAudience,
  type BroadcastAdminContext,
  type BroadcastDraftRow,
  type BroadcastPreview,
} from './broadcast-service'
import { audienceFromDraft } from './broadcast-service'
import { campaignTemplateName, type BroadcastTemplateName } from './campaign'
import { buildConfirmationBodyParams, resolveTemplateConfig } from './templates'
import { loadOptedOutPhones } from './suppression'

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

// Tope duro por lanzamiento: la lista de elegibles de la revalidación se
// entrega completa hasta PREVIEW_LIST_LIMIT (300); nunca se lanza más.
export const MAX_LAUNCH_SIZE = 300
export const PILOT_DEFAULT_LIMIT = 10

export type LaunchExcludedReason =
  | 'offer_incompatible' | 'media_asset_pending' | 'marketing_opt_out' | 'phone_already_contacted'

export interface LaunchRecipient {
  order_id: string; order_number: string | null; customer_name: string | null
  phone_normalized: string; warnings: string[]
}

export interface LaunchPreview {
  broadcast_id:   string
  template_name:  BroadcastTemplateName
  campaign_label: string
  revalidated:    Pick<BroadcastPreview, 'candidate_count' | 'eligible_count' | 'excluded_count' | 'excluded_by_reason' | 'resolved_at'>
  launch_excluded_by_reason: Partial<Record<LaunchExcludedReason, number>>
  sendable_count: number
  send_limit:     number
  batch:          LaunchRecipient[]          // exactamente lo que se encolaría
  not_in_batch:   number                     // elegibles que quedan para una fase posterior
  template_ready: boolean
  template_missing: string[]
  eligible_list_truncated: boolean
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

/**
 * Lo que se enviaría AHORA. READ ONLY. Mismo cálculo que usa launchBroadcast
 * (que lo vuelve a ejecutar en el momento de lanzar).
 */
export async function computeLaunchPreview(
  db: SupabaseLike, ctx: BroadcastAdminContext, broadcastId: string, requestedLimit: number | null,
  env: Record<string, string | undefined> = process.env,
): Promise<LaunchPreviewResult> {
  const draft = await loadDraft(db, ctx.storeId, broadcastId)
  if (!draft) return { ok: false, status: 404, error: 'Campaña no encontrada' }

  const { selection } = audienceFromDraft(draft.selection_filter)
  if (selection.campaign.type !== 'coordination') {
    return { ok: false, status: 422, error: 'Recompra preparada pero no habilitada para envío en C.1' }
  }
  const template = campaignTemplateName(selection.campaign)
  const limit = Math.min(Math.max(1, Math.floor(requestedLimit ?? PILOT_DEFAULT_LIMIT)), MAX_LAUNCH_SIZE)

  const audience = await revalidateDraftAudience(db, ctx, draft)
  const phones = audience.eligible.map(e => e.phone_normalized)
  const [optedOut, contacted, offers] = await Promise.all([
    loadOptedOutPhones(db, ctx.storeId, phones),
    phonesAlreadyContacted(db, ctx.storeId, template, phones, draft.id),
    loadOfferFields(db, ctx.storeId, audience.eligible.map(e => e.order_id)),
  ])

  const launchExcluded: Partial<Record<LaunchExcludedReason, number>> = {}
  const bump = (r: LaunchExcludedReason) => { launchExcluded[r] = (launchExcluded[r] ?? 0) + 1 }
  const sendable: LaunchRecipient[] = []
  for (const e of audience.eligible) {
    const offerRow = offers.get(e.order_id)
    if (e.warnings.includes('requires_template_variables') || !offerRow || !orderFitsConfirmationTemplate(offerRow)) {
      bump('offer_incompatible'); continue
    }
    if (e.media.status !== 'approved')                       { bump('media_asset_pending'); continue }
    if (optedOut.has(e.phone_normalized))                    { bump('marketing_opt_out'); continue }
    if (contacted.has(e.phone_normalized))                   { bump('phone_already_contacted'); continue }
    sendable.push({ order_id: e.order_id, order_number: e.order_number, customer_name: e.customer_name,
                    phone_normalized: e.phone_normalized, warnings: e.warnings })
  }

  const tpl = resolveTemplateConfig(template, env)
  return {
    ok: true,
    preview: {
      broadcast_id: draft.id,
      template_name: template,
      campaign_label: selection.campaign.type === 'coordination' && selection.campaign.segment === 'confirmed_unpaid'
        ? 'Coordinar pedido · Confirmados sin pagar' : 'Coordinar pedido · Pendientes',
      revalidated: {
        candidate_count: audience.candidate_count, eligible_count: audience.eligible_count,
        excluded_count: audience.excluded_count, excluded_by_reason: audience.excluded_by_reason, resolved_at: audience.resolved_at,
      },
      launch_excluded_by_reason: launchExcluded,
      sendable_count: sendable.length,
      send_limit: limit,
      batch: sendable.slice(0, limit),
      not_in_batch: Math.max(0, sendable.length - limit),
      template_ready: tpl.ok,
      template_missing: tpl.ok ? [] : [...tpl.missing, ...tpl.invalid],
      eligible_list_truncated: audience.eligible_truncated,
    },
  }
}

export interface LaunchInput {
  broadcastId:      string
  launchRequestKey: string
  sendLimit:        number
  confirmCount:     number      // el admin confirma la cantidad exacta que vio
}

export type LaunchResult =
  | { ok: true; replay: boolean; queued: number; broadcast_id: string }
  | { ok: false; status: number; error: string; current_count?: number }

async function insertRecipients(
  db: SupabaseLike, storeId: string, broadcastId: string, template: string, recipients: LaunchRecipient[], now: string,
): Promise<number> {
  let inserted = 0
  for (const r of recipients) {
    const { error } = await db.from('wa_template_queue').insert({
      store_id: storeId, order_id: r.order_id, template_name: template, phone_normalized: r.phone_normalized,
      scheduled_at: now, status: 'pending', broadcast_id: broadcastId,
    })
    if (!error) { inserted++; continue }
    if (error.code === '23505') continue        // ya existe (reintento / mismo pedido / mismo teléfono)
    throw new Error(`wa_template_queue(insert): ${error.message ?? String(error)}`)
  }
  return inserted
}

async function countBroadcastRows(db: SupabaseLike, broadcastId: string): Promise<number> {
  const { data, error } = await db.from('wa_template_queue').select('id').eq('broadcast_id', broadcastId)
  if (error) throw new Error(`wa_template_queue(count): ${error.message ?? String(error)}`)
  return (data ?? []).length
}

export async function launchBroadcast(
  db: SupabaseLike, ctx: BroadcastAdminContext, input: LaunchInput, flagEnabled: boolean,
  env: Record<string, string | undefined> = process.env, nowFn: () => string = () => new Date().toISOString(),
): Promise<LaunchResult> {
  if (!flagEnabled) return { ok: false, status: 403, error: 'Broadcast desactivado (WA_BROADCAST_ENABLED)' }

  const draft = await loadDraft(db, ctx.storeId, input.broadcastId)
  if (!draft) return { ok: false, status: 404, error: 'Campaña no encontrada' }

  const isReplay = draft.status !== 'draft'
  if (isReplay) {
    if (draft.launch_request_key !== input.launchRequestKey) {
      return { ok: false, status: 409, error: `La campaña ya no es un borrador (estado: ${draft.status})` }
    }
    if (draft.status !== 'queued' && draft.status !== 'processing') {
      return { ok: true, replay: true, queued: await countBroadcastRows(db, draft.id), broadcast_id: draft.id }
    }
  }

  const pre = await computeLaunchPreview(db, ctx, draft.id, isReplay ? Number(draft.send_limit ?? input.sendLimit) : input.sendLimit, env)
  if (!pre.ok) return pre
  const p = pre.preview
  if (!p.template_ready) {
    return { ok: false, status: 422, error: `Template sin configurar: ${p.template_missing.join(', ')}` }
  }

  const now = nowFn()
  if (!isReplay) {
    if (p.batch.length === 0) return { ok: false, status: 422, error: 'No hay destinatarios enviables tras revalidar' }
    if (input.confirmCount !== p.batch.length) {
      return { ok: false, status: 409, error: 'La audiencia cambió desde la vista previa — revisa y confirma de nuevo', current_count: p.batch.length }
    }

    const { data: moved, error: moveErr } = await db.from('wa_broadcasts').update({
      status: 'queued', launch_request_key: input.launchRequestKey, launched_by: ctx.userId, launched_at: now,
      started_at: now, send_limit: p.send_limit, queued_count: p.batch.length,
      launch_excluded_by_reason: p.launch_excluded_by_reason,
    }).eq('id', draft.id).eq('store_id', ctx.storeId).eq('status', 'draft').select('id').maybeSingle()

    if (moveErr) {
      if (moveErr.code === '23505') {
        return { ok: false, status: 409, error: 'Ya hay otra campaña en curso o pausada en esta tienda' }
      }
      throw new Error(`wa_broadcasts(launch): ${moveErr.message ?? String(moveErr)}`)
    }
    if (!moved) {
      // Otra request ganó la transición: replay solo con la MISMA clave.
      const fresh = await loadDraft(db, ctx.storeId, draft.id)
      if (fresh?.launch_request_key === input.launchRequestKey) {
        return { ok: true, replay: true, queued: await countBroadcastRows(db, draft.id), broadcast_id: draft.id }
      }
      return { ok: false, status: 409, error: 'La campaña ya fue lanzada' }
    }
  }

  // Inserta (o completa, en replay) sin superar send_limit.
  const existing = await countBroadcastRows(db, draft.id)
  const room = Math.max(0, p.send_limit - existing)
  await insertRecipients(db, ctx.storeId, draft.id, p.template_name, p.batch.slice(0, room), now)
  const queued = await countBroadcastRows(db, draft.id)
  return { ok: true, replay: isReplay, queued, broadcast_id: draft.id }
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
