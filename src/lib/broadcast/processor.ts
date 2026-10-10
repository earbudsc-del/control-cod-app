// Sprint C.1 — processor de la cola de Broadcast.
//
// SEPARADO del processor de automations (src/app/api/cron/wa-template-queue):
//   - solo toma filas con broadcast_id = campaña activa + template de
//     broadcast + status 'pending' (broadcastQueueSelector, B.2);
//   - el processor de automations sigue ignorando filas con broadcast_id
//     (barreras de automation-queue.ts) — ninguno puede tomar filas del otro.
//
// Garantías por destinatario:
//   1. Claim atómico (UPDATE … WHERE status='pending'): dos workers nunca
//      envían la misma fila.
//   2. Revalidación del pedido inmediatamente antes de enviar (elegibilidad
//      sd_* del segmento, oferta compatible, teléfono, baja promocional).
//   3. WA_BROADCAST_ENABLED y estado de la campaña (pausa) se releen JUSTO
//      antes de llamar a Meta.
//   4. Resultado de Meta:
//        accepted     → 'sent' + wa_message_id (ACEPTADO; entrega/lectura
//                       llegan por webhook de status a wa_messages)
//        rate_limited → vuelve a 'pending' con espera; corta el lote
//        server_error → vuelve a 'pending' con espera (máx. MAX_ATTEMPTS)
//        rejected     → 'failed' (permanente) con meta_error_code
//        ambiguous    → 'send_unknown' — NUNCA se reintenta solo
//   5. Fila 'processing' abandonada (worker muerto a mitad de envío) →
//      'send_unknown', nunca se reenvía automáticamente.
//
// Nada de esto confirma, cancela ni modifica pedidos.

import { isWaBroadcastEnabled } from '@/lib/config/wa-broadcast'
import { evaluateOrderEligibility, type BroadcastCandidateOrder } from './sd-broadcast-eligibility'
import { audienceFromDraft, BROADCAST_ORDER_COLUMNS } from './broadcast-service'
import { campaignTemplateName, type BroadcastTemplateName } from './campaign'
import {
  buildConfirmationBodyParams, buildTemplateComponents, renderConfirmationTemplateBody, resolveTemplateConfig,
  type ConfirmationOrderFields, type TemplateSendConfig,
} from './templates'
import { loadOptedOutPhones } from './suppression'
import { ensureContactAndConversation } from '@/lib/whatsapp/ensure-conversation'
import { sendWhatsAppTemplate, type SendTemplateRequest, type SendTemplateResult } from '@/lib/whatsapp/send-template'

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const BROADCAST_BATCH_LIMIT = 20
export const MAX_ATTEMPTS = 3
export const STALE_PROCESSING_MINUTES = 10
export const SEND_SPACING_MS = 300

export interface ProcessorDeps {
  db:         SupabaseLike
  env?:       Record<string, string | undefined>
  isEnabled?: () => boolean
  send?:      (req: SendTemplateRequest) => Promise<SendTemplateResult>
  now?:       () => Date
  sleep?:     (ms: number) => Promise<void>
}

export interface ProcessorSummary {
  disabled?:   true
  broadcasts:  number
  claimed:     number
  sent:        number
  skipped:     number
  failed:      number
  send_unknown: number
  retried:     number
  reaped:      number
  completed:   string[]
  stopped_reason?: string
}

interface QueueRow {
  id: string; store_id: string; order_id: string; template_name: string; phone_normalized: string
  status: string; attempt_count: number; broadcast_id: string
}

interface BroadcastRow {
  id: string; store_id: string; status: string; template_name: string
  selection_filter: Record<string, unknown>; started_at: string | null
}

function backoffSeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempt - 1), 15 * 60)
}

async function readBroadcastStatus(db: SupabaseLike, id: string): Promise<string | null> {
  const { data } = await db.from('wa_broadcasts').select('status').eq('id', id).maybeSingle()
  return (data as { status: string } | null)?.status ?? null
}

export async function processBroadcastQueue(deps: ProcessorDeps): Promise<ProcessorSummary> {
  const db = deps.db
  const env = deps.env ?? process.env
  const enabled = deps.isEnabled ?? isWaBroadcastEnabled
  const send = deps.send ?? ((req: SendTemplateRequest) => sendWhatsAppTemplate(req, env))
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))

  const summary: ProcessorSummary = { broadcasts: 0, claimed: 0, sent: 0, skipped: 0, failed: 0, send_unknown: 0, retried: 0, reaped: 0, completed: [] }

  // Flag fail-closed ANTES de cualquier lectura/escritura de la cola.
  if (!enabled()) return { ...summary, disabled: true }

  const { data: active, error } = await db.from('wa_broadcasts')
    .select('id, store_id, status, template_name, selection_filter, started_at')
    .in('status', ['queued', 'processing']).order('created_at', { ascending: true })
  if (error) throw new Error(`wa_broadcasts(active): ${error.message ?? String(error)}`)

  for (const b of (active ?? []) as BroadcastRow[]) {
    summary.broadcasts++
    const stop = await processOneBroadcast(db, b, { env, enabled, send, now, sleep }, summary)
    if (stop) { summary.stopped_reason = stop; break }
  }
  return summary
}

async function processOneBroadcast(
  db: SupabaseLike, b: BroadcastRow,
  d: { env: Record<string, string | undefined>; enabled: () => boolean; send: (r: SendTemplateRequest) => Promise<SendTemplateResult>; now: () => Date; sleep: (ms: number) => Promise<void> },
  summary: ProcessorSummary,
): Promise<string | null> {
  const { selection } = audienceFromDraft(b.selection_filter)
  const template = campaignTemplateName(selection.campaign) as BroadcastTemplateName
  if (selection.campaign.type !== 'coordination' || template !== b.template_name) {
    await db.from('wa_broadcasts').update({ last_error: 'campaña no habilitada para envío en C.1' }).eq('id', b.id)
    return null
  }
  const segment = selection.campaign.segment

  // 1. Filas 'processing' abandonadas → send_unknown (jamás se reenvían).
  const staleBefore = new Date(d.now().getTime() - STALE_PROCESSING_MINUTES * 60_000).toISOString()
  const { data: stale } = await db.from('wa_template_queue').select('id, last_attempted_at')
    .eq('broadcast_id', b.id).eq('status', 'processing').lt('last_attempted_at', staleBefore)
  for (const r of (stale ?? []) as Array<{ id: string }>) {
    const { data: reaped } = await db.from('wa_template_queue').update({
      status: 'send_unknown', processed_at: d.now().toISOString(),
      error_message: 'Worker interrumpido durante el envío — sin confirmación de Meta. Revisar antes de reintentar.',
    }).eq('id', r.id).eq('status', 'processing').select('id').maybeSingle()
    if (reaped) summary.reaped++
  }

  // 2. Configuración del template — fail-closed (nada se reclama sin ella).
  const tpl = resolveTemplateConfig(template, d.env)
  if (!tpl.ok) {
    await db.from('wa_broadcasts').update({ last_error: `Template sin configurar: ${[...tpl.missing, ...tpl.invalid].join(', ')}` }).eq('id', b.id)
    return 'template_not_configured'
  }

  if (b.status === 'queued') {
    await db.from('wa_broadcasts').update({ status: 'processing', started_at: b.started_at ?? d.now().toISOString(), last_error: null })
      .eq('id', b.id).eq('status', 'queued')
  }

  // 3. Lote de pendientes de ESTA campaña (selector B.2).
  const { data: rows, error } = await db.from('wa_template_queue')
    .select('id, store_id, order_id, template_name, phone_normalized, status, attempt_count, broadcast_id')
    .eq('broadcast_id', b.id).eq('template_name', template).eq('status', 'pending')
    .lte('scheduled_at', d.now().toISOString()).order('scheduled_at', { ascending: true }).limit(BROADCAST_BATCH_LIMIT)
  if (error) throw new Error(`wa_template_queue(batch): ${error.message ?? String(error)}`)

  let stopReason: string | null = null
  for (const row of (rows ?? []) as QueueRow[]) {
    if (!d.enabled()) { stopReason = 'disabled_mid_batch'; break }
    if (await readBroadcastStatus(db, b.id) !== 'processing') { stopReason = 'paused'; break }

    const result = await processRow(db, b, row, tpl.config, segment, d, summary)
    if (result === 'stop_rate_limited' || result === 'stop_server_error' || result === 'stop_paused' || result === 'stop_disabled') {
      stopReason = result.replace('stop_', '')
      break
    }
    await d.sleep(SEND_SPACING_MS)
  }

  // 4. ¿Terminó? Sin pending/processing → completed.
  const { data: open } = await db.from('wa_template_queue').select('id')
    .eq('broadcast_id', b.id).in('status', ['pending', 'processing']).limit(1)
  if (!open || open.length === 0) {
    const { data: done } = await db.from('wa_broadcasts').update({ status: 'completed', completed_at: d.now().toISOString() })
      .eq('id', b.id).eq('status', 'processing').select('id').maybeSingle()
    if (done) summary.completed.push(b.id)
  }
  return stopReason === 'rate_limited' || stopReason === 'disabled_mid_batch' || stopReason === 'disabled' ? stopReason : null
}

type RowOutcome = 'sent' | 'skipped' | 'failed' | 'send_unknown' | 'retry' | 'unclaimed'
  | 'stop_rate_limited' | 'stop_server_error' | 'stop_paused' | 'stop_disabled'

async function processRow(
  db: SupabaseLike, b: BroadcastRow, row: QueueRow, cfg: TemplateSendConfig, segment: 'pending' | 'confirmed_unpaid',
  d: { enabled: () => boolean; send: (r: SendTemplateRequest) => Promise<SendTemplateResult>; now: () => Date },
  summary: ProcessorSummary,
): Promise<RowOutcome> {
  const nowIso = d.now().toISOString()
  const prevAttempts = row.attempt_count ?? 0   // DEFAULT 0 en DB; defensivo ante null
  const attempt = prevAttempts + 1

  // Claim atómico.
  const { data: claimed } = await db.from('wa_template_queue')
    .update({ status: 'processing', attempt_count: attempt, last_attempted_at: nowIso })
    .eq('id', row.id).eq('status', 'pending').select('id').maybeSingle()
  if (!claimed) return 'unclaimed'
  summary.claimed++

  const finish = async (patch: Record<string, unknown>) => {
    await db.from('wa_template_queue').update(patch).eq('id', row.id).eq('status', 'processing')
  }
  const release = async () => {   // devolver sin penalizar (pausa / flag apagado)
    await db.from('wa_template_queue').update({ status: 'pending', attempt_count: prevAttempts })
      .eq('id', row.id).eq('status', 'processing')
  }
  const skip = async (reason: string) => {
    await finish({ status: 'skipped', skip_reason: reason, processed_at: nowIso })
    summary.skipped++
    return 'skipped' as const
  }

  // Revalidación del pedido — estado canónico, ahora.
  const { data: order } = await db.from('orders').select(BROADCAST_ORDER_COLUMNS)
    .eq('id', row.order_id).eq('store_id', b.store_id).maybeSingle()
  if (!order) return skip('order_not_found')
  const elig = evaluateOrderEligibility(order as BroadcastCandidateOrder, null, { segment })
  if (!elig.eligible) return skip(`no_longer_eligible:${elig.reason}`)
  if (elig.phone_normalized !== row.phone_normalized) return skip('phone_changed')
  // Parámetros del texto aprobado (5 variables) — solo si el pedido es
  // exactamente la oferta anunciada; si no, no se envía.
  const bodyParams = buildConfirmationBodyParams(order as ConfirmationOrderFields)
  if (!bodyParams.ok) return skip(bodyParams.reason)
  const optedOut = await loadOptedOutPhones(db, b.store_id, [row.phone_normalized])
  if (optedOut.has(row.phone_normalized)) return skip('marketing_opt_out')

  // Última barrera justo antes de Meta: flag + pausa.
  if (!d.enabled()) { await release(); return 'stop_disabled' }
  if (await readBroadcastStatus(db, b.id) !== 'processing') { await release(); return 'stop_paused' }

  const o = order as { customer_name: string | null; cod_amount: number | null; product_summary: string | null; order_number: string | null }
  const res = await d.send({
    to: row.phone_normalized, name: cfg.metaName, language: cfg.language,
    components: buildTemplateComponents(cfg, bodyParams.params, row.id),
  })

  switch (res.kind) {
    case 'accepted': {
      const sentAt = d.now().toISOString()
      // Prueba durable de aceptación ANTES de cualquier otra escritura.
      await finish({ status: 'sent', wa_message_id: res.wamid, processed_at: sentAt, error_message: null, meta_error_code: null })
      summary.sent++
      try {
        await recordOutboundMessage(db, b, row, cfg, o, bodyParams.params, res.wamid, sentAt)
      } catch (err) {
        // El mensaje YA salió: nunca se reintenta. Solo falta el registro en Inbox.
        console.error('[broadcast] enviado pero no se pudo registrar en Inbox — queue:', row.id, err instanceof Error ? err.message : err)
      }
      return 'sent'
    }
    case 'rate_limited':
    case 'server_error': {
      const exhausted = attempt >= MAX_ATTEMPTS
      await finish(exhausted
        ? { status: 'failed', processed_at: nowIso, error_message: res.error, meta_error_code: res.metaCode }
        : { status: 'pending', scheduled_at: new Date(d.now().getTime() + backoffSeconds(attempt) * 1000).toISOString(),
            error_message: res.error, meta_error_code: res.metaCode })
      if (exhausted) summary.failed++; else summary.retried++
      return res.kind === 'rate_limited' ? 'stop_rate_limited' : 'stop_server_error'
    }
    case 'rejected':
      await finish({ status: 'failed', processed_at: nowIso, error_message: res.error, meta_error_code: res.metaCode })
      summary.failed++
      return 'failed'
    case 'ambiguous':
      await finish({ status: 'send_unknown', processed_at: nowIso, error_message: res.error })
      summary.send_unknown++
      return 'send_unknown'
    case 'not_configured':
      await release()
      await db.from('wa_broadcasts').update({ last_error: res.error }).eq('id', b.id)
      return 'stop_disabled'
  }
}

async function recordOutboundMessage(
  db: SupabaseLike, b: BroadcastRow, row: QueueRow, cfg: TemplateSendConfig,
  o: { customer_name: string | null; cod_amount: number | null; product_summary: string | null },
  bodyParams: string[], wamid: string, sentAt: string,
): Promise<void> {
  const { conversationId } = await ensureContactAndConversation(db, {
    storeId: b.store_id, phoneNormalized: row.phone_normalized, displayName: o.customer_name, orderId: row.order_id,
  })
  // Copia de auditoría del texto aprobado con los parámetros enviados
  // (Meta compone el mensaje real; este string no se transmite).
  const body = renderConfirmationTemplateBody(bodyParams)
  const { error } = await db.from('wa_messages').insert({
    store_id: b.store_id, conversation_id: conversationId, wa_msg_id: wamid,
    direction: 'outbound', message_type: 'template', body, status: 'sent', sent_at: sentAt,
    metadata: {
      template_name: cfg.name, meta_template_name: cfg.metaName, language: cfg.language,
      header_image_url: cfg.headerImageUrl, body_params: bodyParams,
      buttons: cfg.buttons, customer_name: o.customer_name, cod_amount: o.cod_amount != null ? String(o.cod_amount) : null,
      product_summary: o.product_summary, order_id: row.order_id,
      broadcast_id: b.id, broadcast_queue_id: row.id, sender_type: 'system',
    },
  })
  if (error && error.code !== '23505') throw new Error(`wa_messages(insert): ${error.message ?? String(error)}`)
  // C.1.2 — la conversación queda bajo atención humana: ai_enabled=false
  // (claim_genesis_run la rechaza aunque Génesis se active en el futuro).
  // Liberarla tampoco la reactiva (ver conversation-guard.ts).
  await db.from('wa_conversations').update({
    last_message_at: sentAt, last_message_preview: body.length > 150 ? body.slice(0, 150) + '…' : body,
    ai_enabled: false,
  }).eq('id', conversationId)
}
