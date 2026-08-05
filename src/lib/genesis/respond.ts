// Responder automático de Génesis — FASE 7B.2 (prueba controlada, número
// todavía no abierto a clientes reales).
//
// Se invoca desde el webhook de WhatsApp después de guardar un mensaje
// inbound. Nunca debe lanzar — todo error se loguea y se ignora para no
// romper el webhook (Meta espera 200 en <5s).
//
// FASE 1B — integración con genesis_message_runs (Fase 1A/1A.1, migraciones
// 055-059): el flujo ahora pasa por claim_genesis_run() → renew_genesis_run()
// (dos checkpoints) → begin_genesis_send() → finish_genesis_run(), en vez de
// los chequeos manuales sueltos de assigned_to/ai_enabled/is_active/mode que
// existían antes. Esta fase es únicamente una reestructuración de
// infraestructura — el prompt, la base de conocimiento, el modelo y el
// comportamiento comercial de Génesis no cambian.
//
// Condiciones para responder (todas deben cumplirse):
//   - provider = 'openai' (gemini queda como TODO controlado) — chequeo
//     previo al claim, claim_genesis_run no conoce el proveedor
//   - api_key_ref configurado y la env var correspondiente existe — idem
//   - ai_agent_config.is_active = true / mode = 'auto' / wa_conversations
//     .ai_enabled = true / assigned_to IS NULL / genesis_status elegible —
//     verificados atómicamente por claim_genesis_run()
//
// Guardrails de esta fase:
//   - No cambia normalized_status/confirmation_status de ningún pedido.
//   - No confirma ni cancela pedidos — esa lógica sigue siendo exclusiva
//     de los botones de template (applyConfirmationAction), sin tocar.
//   - No reintenta OpenAI ni Meta automáticamente — un solo intento, igual
//     que hoy; un fallo transiciona el run a failed_retryable/failed_terminal
//     /send_unknown según corresponda, sin reintento inline.
//   - No conecta escalate_genesis_conversation/take_genesis_conversation/
//     release_genesis_conversation — quedan fuera de esta fase.
//
// Validación real (post-Fase-1A.1): callOpenAI/sendWhatsAppText son
// inyectables vía el 5º parámetro `deps` — únicamente para permitir pruebas
// del orquestador con dobles de prueba (scripts/test-genesis-respond-
// orchestrator.ts), sin llamar a OpenAI/Meta reales. El webhook (único
// caller de producción) nunca pasa `deps` — usa siempre las implementaciones
// reales, comportamiento idéntico a como estaba antes de este cambio.

import { createServiceClient } from '@/lib/supabase/server'
import { sendWhatsAppText as sendWhatsAppTextReal } from '@/lib/whatsapp/send-text'
import { randomUUID } from 'node:crypto'

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>

const HISTORY_LIMIT = 20
const MAX_TOKENS     = 300

// TTL/checkpoints — R1.5.3 del documento de diseño (docs/GENESIS_COMMERCIAL_BRAIN_V1.md).
const CLAIM_TTL_SECONDS            = 60
const RENEW_BEFORE_OPENAI_SECONDS  = 60
const RENEW_AFTER_OPENAI_SECONDS   = 30

// Timeouts — R1.5.2 del documento de diseño. Antes no existía ningún
// timeout explícito en la llamada a OpenAI (hallazgo H14 de la auditoría).
const OPENAI_TIMEOUT_MS = 15_000

// Estados de genesis_message_runs.status que cuentan como "todavía activo"
// para decidir si begin_genesis_send fue rechazado por una causa que este
// proceso debe cerrar él mismo, o si otra RPC (take/escalate) ya lo cerró.
const RUN_ACTIVE_STATUSES = ['claimed', 'processing', 'generated', 'sending', 'failed_retryable']

interface KnowledgeSectionRow {
  label:   string
  content: string | null
}

interface HistoryRow {
  direction:    'inbound' | 'outbound'
  body:         string | null
  message_type: string
  sent_at:      string | null
}

interface ClaimGenesisRunRow {
  run_id:        string | null
  outcome:       string
  attempt_count: number
  message:       string | null
}

interface RenewGenesisRunRow {
  outcome: string
  message: string | null
}

interface BeginGenesisSendRow {
  allowed: boolean
  outcome: string
  message: string | null
}

interface FinishGenesisRunRow {
  outcome: string
  message: string | null
}

export type CallOpenAIResult =
  | { ok: true; text: string }
  | { ok: false; kind: 'timeout' | 'error' }

// Tipos exportados únicamente para que scripts/test-genesis-respond-
// orchestrator.ts pueda tipar sus dobles de prueba sin duplicar la firma.
export type CallOpenAIFn = (
  apiKey:   string,
  model:    string,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
) => Promise<CallOpenAIResult>

export type SendWhatsAppTextFn = typeof sendWhatsAppTextReal

function buildSystemPrompt(
  agentName:     string,
  systemPrompt:  string | null,
  sections:      KnowledgeSectionRow[],
): string {
  const parts: string[] = []

  parts.push(
    systemPrompt?.trim() ||
    `Eres ${agentName || 'Génesis'}, un asistente de atención al cliente por WhatsApp para una ` +
    'tienda de e-commerce con pago contra entrega (COD) en República Dominicana. Responde de ' +
    'forma breve, natural, cordial y útil. No inventes información que no esté en la base de ' +
    'conocimiento provista.',
  )

  const active = sections.filter(s => s.content?.trim())
  if (active.length > 0) {
    parts.push('--- Base de conocimiento ---')
    for (const s of active) parts.push(`## ${s.label}\n${s.content}`)
  }

  parts.push(
    '--- Instrucciones de respuesta ---\n' +
    'Responde siempre en español, de forma breve (máximo 2-3 frases), natural y directa, sin ' +
    'markdown ni listas. No confirmes ni canceles pedidos por tu cuenta — esa acción la gestiona ' +
    'el sistema automáticamente cuando el cliente pulsa los botones del mensaje de confirmación. ' +
    'Si no sabes la respuesta o el cliente pide algo que requiere intervención humana, dilo con ' +
    'naturalidad y ofrece que un agente lo va a atender.',
  )

  return parts.join('\n\n')
}

// Timeout explícito vía AbortController (antes no existía — hallazgo H14).
// Un abort produce kind='timeout', distinguible de cualquier otro fallo
// (kind='error') para poder registrar failure_code='openai_timeout' en vez
// de 'openai_error' genérico. Mismo modelo/max_tokens/temperature que
// siempre — cero cambio de comportamiento comercial.
const callOpenAI: CallOpenAIFn = async (apiKey, model, messages) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens:  MAX_TOKENS,
        temperature: 0.6,
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      const errText = await res.text()
      console.error('[genesis] OpenAI error', res.status, errText)
      return { ok: false, kind: 'error' }
    }

    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const text = data.choices?.[0]?.message?.content?.trim()
    if (!text) return { ok: false, kind: 'error' }
    return { ok: true, text }
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof Error && err.name === 'AbortError') {
      console.error('[genesis] OpenAI timeout tras', OPENAI_TIMEOUT_MS, 'ms')
      return { ok: false, kind: 'timeout' }
    }
    console.error('[genesis] OpenAI fetch threw', err)
    return { ok: false, kind: 'error' }
  }
}

// Cierre del run — único punto que llama a finish_genesis_run(), usado desde
// los 3 caminos de salida terminal (fallo de OpenAI, rechazo de
// begin_genesis_send, resultado de sendWhatsAppText) y el camino de éxito.
// No lanza — un fallo de transporte de la RPC misma solo se loguea, el
// llamador ya está en su propio camino de salida de todas formas.
async function finishRun(
  supabase: ServiceClient,
  runId:    string,
  lockToken: string,
  outcome:  'sent' | 'send_unknown' | 'failed_retryable' | 'failed_terminal',
  opts: Partial<{
    meta_message_id:     string
    outbound_message_id: string
    failure_code:        string
  }> = {},
): Promise<void> {
  const { data, error } = await supabase
    .rpc('finish_genesis_run', {
      p_run_id:              runId,
      p_lock_token:          lockToken,
      p_outcome:             outcome,
      p_meta_message_id:     opts.meta_message_id ?? null,
      p_outbound_message_id: opts.outbound_message_id ?? null,
      p_failure_code:        opts.failure_code ?? null,
      p_failure_detail:      null,
    })
    .single<FinishGenesisRunRow>()

  if (error) {
    console.error('[genesis] finish_genesis_run error de transporte:', error.message, '| run:', runId, '| outcome:', outcome)
    return
  }
  // data.outcome puede diferir del solicitado (ej. 'lost_lock',
  // 'already_finished', 'invalid_transition') — nunca se asume éxito solo
  // porque la llamada no lanzó. Se loguea siempre el valor REAL devuelto.
  const matched = data?.outcome === outcome
  console.log(`[genesis] finish_genesis_run → ${data?.outcome ?? '(sin resultado)'}${matched ? '' : ' ⚠ distinto del solicitado (' + outcome + ')'} | run: ${runId}`)
}

// Punto de entrada. Recibe el cliente de servicio ya creado por el webhook
// (evita crear una segunda conexión), el id de la conversación recién
// actualizada con el mensaje inbound, el id del propio mensaje inbound
// (requerido por claim_genesis_run — antes no se pasaba), y opcionalmente
// dobles de prueba para OpenAI/Meta (solo usados por el orquestador de
// pruebas — el webhook nunca los pasa).
export async function maybeGenesisRespond(
  supabase:         ServiceClient,
  storeId:          string,
  conversationId:   string,
  inboundMessageId: string,
  deps: {
    callOpenAI?:       CallOpenAIFn
    sendWhatsAppText?: SendWhatsAppTextFn
  } = {},
): Promise<void> {
  const openaiFn   = deps.callOpenAI ?? callOpenAI
  const sendTextFn = deps.sendWhatsAppText ?? sendWhatsAppTextReal

  try {
    console.log('[genesis] inicio — conversationId:', conversationId, '| storeId:', storeId, '| inboundMessageId:', inboundMessageId)

    // ── 1. Pre-chequeos existentes (conversación, config, provider, api_key, waId) ──
    // assigned_to/ai_enabled/is_active/mode ya NO se chequean aquí — los
    // verifica atómicamente claim_genesis_run() más abajo.
    const { data: conv } = await supabase
      .from('wa_conversations')
      .select('id, contact:wa_contacts(wa_id, phone_normalized)')
      .eq('id', conversationId)
      .maybeSingle()

    if (!conv) {
      console.log('[genesis] abortado — conversación no encontrada:', conversationId)
      return
    }

    const { data: config } = await supabase
      .from('ai_agent_config')
      .select('agent_name, provider, model, api_key_ref, system_prompt')
      .eq('store_id', storeId)
      .maybeSingle()

    if (!config) {
      console.log('[genesis] abortado — ai_agent_config no encontrada para store:', storeId)
      return
    }

    if (config.provider !== 'openai') {
      if (config.provider === 'gemini') {
        console.warn('[genesis] provider=gemini configurado pero no implementado todavía — sin respuesta')
      } else {
        console.log('[genesis] abortado — provider no soportado:', config.provider)
      }
      return
    }

    if (!config.api_key_ref) {
      console.error('[genesis] abortado — api_key_ref no configurado | store:', storeId)
      return
    }
    const apiKey = process.env[config.api_key_ref]
    if (!apiKey) {
      console.error('[genesis] abortado — env var', config.api_key_ref, 'no definida en este entorno | store:', storeId)
      return
    }

    type ContactRel = { wa_id: string | null; phone_normalized: string | null }
    const contactRaw = conv.contact as ContactRel | ContactRel[] | null
    const contact = Array.isArray(contactRaw) ? contactRaw[0] : contactRaw
    const waId = contact?.wa_id ?? contact?.phone_normalized
    if (!waId) {
      console.error('[genesis] conversación sin wa_id ni teléfono — sin respuesta', conversationId)
      return
    }

    // ── 2. claim_genesis_run() ──────────────────────────────────────────────
    const lockToken = randomUUID()
    const { data: claimData, error: claimError } = await supabase
      .rpc('claim_genesis_run', {
        p_conversation_id:    conversationId,
        p_inbound_message_id: inboundMessageId,
        p_lock_token:         lockToken,
        p_ttl_seconds:        CLAIM_TTL_SECONDS,
      })
      .single<ClaimGenesisRunRow>()

    if (claimError) {
      console.error('[genesis] claim_genesis_run error de transporte:', claimError.message, '| conv:', conversationId)
      return
    }
    if (!claimData) {
      console.error('[genesis] claim_genesis_run no devolvió resultado | conv:', conversationId)
      return
    }

    if (claimData.outcome !== 'claimed' && claimData.outcome !== 'retry_claimed') {
      // already_sent / already_processing / conversation_busy /
      // skipped_human_active / skipped_escalated / disabled / not_found /
      // invalid_message / db_error — ninguno de estos crea un run
      // reclamado por esta invocación; no hay nada más que hacer.
      console.log('[genesis] claim_genesis_run →', claimData.outcome, '| conv:', conversationId, '| detalle:', claimData.message ?? '(sin detalle)')
      return
    }

    const runId = claimData.run_id
    if (!runId) {
      console.error('[genesis] claim_genesis_run devolvió outcome=', claimData.outcome, 'sin run_id — abortando', conversationId)
      return
    }
    console.log('[genesis] run reclamado — run:', runId, '| outcome:', claimData.outcome, '| attempt_count:', claimData.attempt_count, '| conv:', conversationId)

    // ── 3. Cargar knowledge + historial ─────────────────────────────────────
    const { data: sections } = await supabase
      .from('ai_agent_knowledge_sections')
      .select('label, content')
      .eq('store_id', storeId)
      .eq('is_active', true)
      .order('priority', { ascending: false })

    const { data: historyRows } = await supabase
      .from('wa_messages')
      .select('direction, body, message_type, sent_at')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: false })
      .limit(HISTORY_LIMIT)

    const history = ((historyRows ?? []) as HistoryRow[])
      .slice()
      .reverse()
      .filter(m => m.body?.trim())

    // ── 4. renew_genesis_run(status='processing') — checkpoint 1, antes de OpenAI ──
    const { data: renew1, error: renew1Error } = await supabase
      .rpc('renew_genesis_run', {
        p_run_id:            runId,
        p_lock_token:        lockToken,
        p_extend_seconds:    RENEW_BEFORE_OPENAI_SECONDS,
        p_new_status:        'processing',
        p_meta_message_id:   null,
      })
      .single<RenewGenesisRunRow>()

    if (renew1Error || renew1?.outcome !== 'renewed') {
      console.error('[genesis] renew_genesis_run (checkpoint 1) falló — outcome:', renew1?.outcome ?? renew1Error?.message, '| run:', runId)
      return
    }

    // ── 5. Llamar OpenAI ─────────────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(
      config.agent_name,
      config.system_prompt,
      (sections ?? []) as KnowledgeSectionRow[],
    )

    const chatMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({
        role:    (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.body as string,
      })),
    ]

    const model = config.model?.trim() || 'gpt-4o-mini'
    console.log('[genesis] llamando a OpenAI — model:', model, '| historial:', history.length, 'mensajes | run:', runId)
    const openaiResult = await openaiFn(apiKey, model, chatMessages)

    if (!openaiResult.ok) {
      const failureCode = openaiResult.kind === 'timeout' ? 'openai_timeout' : 'openai_error'
      console.log('[genesis] OpenAI falló (', openaiResult.kind, ') — cerrando run como failed_retryable | run:', runId)
      await finishRun(supabase, runId, lockToken, 'failed_retryable', { failure_code: failureCode })
      return
    }
    const replyText = openaiResult.text

    // ── 6. renew_genesis_run(status='generated') — checkpoint 2, tras OpenAI ──
    const { data: renew2, error: renew2Error } = await supabase
      .rpc('renew_genesis_run', {
        p_run_id:            runId,
        p_lock_token:        lockToken,
        p_extend_seconds:    RENEW_AFTER_OPENAI_SECONDS,
        p_new_status:        'generated',
        p_meta_message_id:   null,
      })
      .single<RenewGenesisRunRow>()

    if (renew2Error || renew2?.outcome !== 'renewed') {
      console.error('[genesis] renew_genesis_run (checkpoint 2) falló — outcome:', renew2?.outcome ?? renew2Error?.message, '| run:', runId)
      return
    }

    // ── 7. begin_genesis_send() — segundo chequeo atómico, justo antes de Meta ──
    const { data: beginData, error: beginError } = await supabase
      .rpc('begin_genesis_send', { p_run_id: runId, p_lock_token: lockToken })
      .single<BeginGenesisSendRow>()

    if (beginError) {
      console.error('[genesis] begin_genesis_send error de transporte:', beginError.message, '| run:', runId)
      return
    }
    if (!beginData?.allowed) {
      console.log('[genesis] begin_genesis_send → no permitido, outcome:', beginData?.outcome, '| run:', runId, '| detalle:', beginData?.message ?? '(sin detalle)')

      if (beginData?.outcome === 'already_sent') {
        // Ya cerrado (sent) por otra ejecución — no-op.
        return
      }

      // not_generated / conversation_not_active / lost_lock / not_found:
      // take_genesis_conversation o escalate_genesis_conversation pueden
      // haber invalidado este run DIRECTAMENTE (status=skipped_human_active/
      // escalated, fuera de finish_genesis_run — R1.10.2) antes de llegar
      // aquí. Releer el estado real antes de decidir: si ya es un estado
      // terminal correcto, no se sobrescribe con failed_terminal.
      const { data: runRow } = await supabase
        .from('genesis_message_runs')
        .select('status')
        .eq('id', runId)
        .maybeSingle()

      const stillOpen = !!runRow?.status && RUN_ACTIVE_STATUSES.includes(runRow.status)

      if (!stillOpen) {
        console.log('[genesis] run ya fue cerrado por otra vía (take/escalate) — status actual:', runRow?.status ?? '(desconocido)', '| run:', runId)
        return
      }

      // El run sigue genuinamente activo (nadie más lo cerró) pero
      // begin_genesis_send lo rechazó de todas formas — lock realmente
      // perdido/expirado. Lo cerramos nosotros.
      await finishRun(supabase, runId, lockToken, 'failed_terminal', { failure_code: 'lock_lost' })
      return
    }

    // ── 8. sendWhatsAppText() ────────────────────────────────────────────────
    console.log('[genesis] enviando respuesta vía Meta — run:', runId, '| waId:', waId)
    const sendResult = await sendTextFn(waId, replyText)

    if (!sendResult.ok) {
      console.error('[genesis] error enviando respuesta vía Meta:', sendResult.kind, sendResult.error, '| run:', runId)
      if (sendResult.kind === 'network_error') {
        // Ambiguo (incluye timeout de Meta) — no se sabe si Meta procesó el
        // mensaje. Nunca reintentar automáticamente (R1.8.3).
        await finishRun(supabase, runId, lockToken, 'send_unknown')
      } else if (sendResult.kind === 'credentials_missing') {
        await finishRun(supabase, runId, lockToken, 'failed_terminal', { failure_code: 'meta_http_error' })
      } else {
        // http_error — rechazo inequívoco de Meta.
        await finishRun(supabase, runId, lockToken, 'failed_retryable', { failure_code: 'meta_http_error' })
      }
      return
    }

    // Meta confirmó el envío — grabar meta_message_id de inmediato, antes de
    // intentar persistir el outbound (secuencia exacta de R1.4.2: si el
    // INSERT de abajo falla, la prueba de que Meta ya envió no se pierde).
    await supabase
      .rpc('renew_genesis_run', {
        p_run_id:            runId,
        p_lock_token:        lockToken,
        p_extend_seconds:    RENEW_AFTER_OPENAI_SECONDS,
        p_new_status:        null,
        p_meta_message_id:   sendResult.wamid,
      })
      .single<RenewGenesisRunRow>()

    // ── 9. Guardar wa_messages outbound ──────────────────────────────────────
    const sentAt = new Date().toISOString()
    const preview = replyText.length > 150 ? replyText.slice(0, 150) + '…' : replyText

    const { data: outboundMsg, error: insertErr } = await supabase
      .from('wa_messages')
      .insert({
        store_id:        storeId,
        conversation_id: conversationId,
        wa_msg_id:       sendResult.wamid,
        direction:       'outbound',
        message_type:    'text',
        body:            replyText,
        status:          'sent',
        sent_at:         sentAt,
        metadata: {
          generated_by: 'genesis',
          provider:     config.provider,
          model,
          sender_type:  'genesis',
          sender_name:  'Génesis IA',
          genesis_run_id: runId,
        },
      })
      .select('id')
      .single()

    if (insertErr || !outboundMsg) {
      // Meta ya envió el mensaje real al cliente (meta_message_id ya
      // grabado arriba) pero no se pudo persistir el outbound — caso D de
      // R1.7, riesgo conocido y aceptado en esta fase (sin job de
      // reconciliación todavía). No se marca el run como 'sent' — queda en
      // 'generated'/'sending' con meta_message_id poblado, nunca se
      // reintenta el envío.
      console.error('[genesis] ✖ Meta envió el mensaje pero el INSERT del outbound falló — run:', runId, '| wamid:', sendResult.wamid, '| error:', insertErr?.message)
      return
    }

    const { error: updateConvErr } = await supabase
      .from('wa_conversations')
      .update({ last_message_at: sentAt, last_message_preview: preview })
      .eq('id', conversationId)

    if (updateConvErr) {
      // El mensaje ya se envió y persistió correctamente — este UPDATE es
      // solo el preview del Inbox. Su fallo es un error secundario: no debe
      // impedir marcar el run como 'sent' (paso 10), y nunca provoca reenvío.
      console.error('[genesis] ⚠ UPDATE wa_conversations (preview) falló — no bloquea el cierre del run:', updateConvErr.message, '| run:', runId)
    }

    // ── 10. finish_genesis_run(status='sent') ────────────────────────────────
    await finishRun(supabase, runId, lockToken, 'sent', {
      meta_message_id:     sendResult.wamid,
      outbound_message_id: outboundMsg.id,
    })

    console.log('[genesis] ✓ respuesta automática enviada — run:', runId, '| conv:', conversationId)
  } catch (err) {
    console.error('[genesis] error inesperado en maybeGenesisRespond:', err)
  }
}
