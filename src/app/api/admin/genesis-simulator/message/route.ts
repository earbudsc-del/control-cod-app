import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { buildSystemPrompt, callOpenAI, type ChatMessage } from '@/lib/genesis/respond'
import type { DecisionPlan, PlanConstraints } from '@/lib/genesis/decision-plan'
import { validateResponse } from '@/lib/genesis/response-validator'
import { detectHardEscalationSignal, detectInboundAdverseReactionSignal } from '@/lib/genesis/hard-escalation'

// POST /api/admin/genesis-simulator/message — Laboratorio de Génesis (Sprint 1).
//
// SANDBOX CONVERSACIONAL PURO. Reutiliza el motor real de producción
// (buildSystemPrompt, callOpenAI, response-validator, hard-escalation) con la
// MISMA configuración/knowledge de la tienda, pero NUNCA toca:
//   - WhatsApp / Meta (nunca importa sendWhatsAppText)
//   - wa_template_queue (nunca la lee ni escribe)
//   - genesis_message_runs / claim_genesis_run / finish_genesis_run (no hay
//     conversación real que reclamar — el historial vive en el frontend)
//   - escalate_genesis_conversation (nunca se ejecuta la RPC real — solo se
//     reporta en la respuesta JSON qué habría pasado, ver `escalation`)
//   - applyConfirmationAction / agent_actions / orders / dispatch-local /
//     Ruta COD — ninguno de estos módulos se importa aquí.
// Ver scripts/test-genesis-simulator-isolation.ts para la verificación
// estática de este aislamiento.

const HISTORY_LIMIT      = 20   // misma filosofía que producción (respond.ts)
const MAX_MESSAGE_CHARS  = 4000
const ALLOWED_ROLES      = new Set(['user', 'assistant'])

interface SimulatorHistoryItem {
  role:    'user' | 'assistant'
  content: string
}

function validateHistory(raw: unknown): { ok: true; history: SimulatorHistoryItem[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, history: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'history debe ser un array' }

  const out: SimulatorHistoryItem[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { ok: false, error: 'cada item de history debe ser un objeto' }
    const { role, content } = item as Record<string, unknown>
    if (typeof role !== 'string' || !ALLOWED_ROLES.has(role)) {
      return { ok: false, error: `role inválido: "${String(role)}" — solo se acepta "user" o "assistant" (nunca "system")` }
    }
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: 'content debe ser un string no vacío' }
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, error: `content excede el máximo de ${MAX_MESSAGE_CHARS} caracteres` }
    }
    out.push({ role: role as 'user' | 'assistant', content })
  }
  // Últimos N mensajes — misma filosofía que producción (HISTORY_LIMIT).
  return { ok: true, history: out.slice(-HISTORY_LIMIT) }
}

export async function POST(request: Request) {
  try {
    // ── Auth: solo admin ───────────────────────────────────────────────────
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await authClient
      .from('profiles').select('role, store_id').eq('id', user.id).single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admin puede usar el Laboratorio de Génesis' }, { status: 403 })
    }
    if (!profile.store_id) {
      return NextResponse.json({ error: 'Sin tienda asignada' }, { status: 400 })
    }
    const storeId = profile.store_id as string

    // ── Input ────────────────────────────────────────────────────────────
    const body = await request.json().catch(() => null) as { history?: unknown; message?: unknown } | null
    if (!body) return NextResponse.json({ error: 'Body inválido — se esperaba JSON' }, { status: 400 })

    const historyResult = validateHistory(body.history)
    if (!historyResult.ok) return NextResponse.json({ error: historyResult.error }, { status: 422 })

    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message) return NextResponse.json({ error: 'El campo message es requerido' }, { status: 422 })
    if (message.length > MAX_MESSAGE_CHARS) {
      return NextResponse.json({ error: `message excede el máximo de ${MAX_MESSAGE_CHARS} caracteres` }, { status: 422 })
    }

    const history = historyResult.history

    // ── Config + knowledge reales (service client — mismo patrón de
    //    wa-test-send: identidad ya validada arriba con authClient, datos
    //    leídos con service client explícitamente filtrado por storeId) ────
    const supabase = await createServiceClient()

    const { data: config } = await supabase
      .from('ai_agent_config')
      .select('agent_name, provider, model, api_key_ref, system_prompt')
      .eq('store_id', storeId)
      .maybeSingle()

    if (!config) return NextResponse.json({ error: 'ai_agent_config no encontrada para esta tienda' }, { status: 404 })
    if (config.provider !== 'openai') {
      return NextResponse.json({ error: `Proveedor no soportado en el Laboratorio: ${config.provider ?? '(sin definir)'}` }, { status: 422 })
    }
    if (!config.api_key_ref) {
      return NextResponse.json({ error: 'api_key_ref no configurado en ai_agent_config' }, { status: 422 })
    }
    const apiKey = process.env[config.api_key_ref]
    if (!apiKey) {
      return NextResponse.json({ error: `Env var ${config.api_key_ref} no definida en este entorno` }, { status: 500 })
    }

    const { data: sections } = await supabase
      .from('ai_agent_knowledge_sections')
      .select('label, content')
      .eq('store_id', storeId)
      .eq('is_active', true)
      .order('priority', { ascending: false })

    // ── Construir el mismo system prompt real (RG-2) ───────────────────────
    const systemPrompt = buildSystemPrompt(
      config.agent_name,
      config.system_prompt,
      (sections ?? []) as { label: string; content: string | null }[],
    )

    const chatMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role, content: h.content }) as ChatMessage),
      { role: 'user', content: message },
    ]

    const model = config.model?.trim() || 'gpt-4o-mini'
    const startedAt = Date.now()
    const openaiResult = await callOpenAI(apiKey, model, chatMessages)
    const latencyMs = Date.now() - startedAt

    if (!openaiResult.ok) {
      return NextResponse.json({
        error:     'OpenAI falló',
        kind:      openaiResult.kind,
        model,
        latencyMs,
      }, { status: 502 })
    }

    // ── Validador determinístico — MISMO plan/constraints dinámico que RG-2
    //    conectado en producción (ver respond.ts, Sprint 1B/2). Sin Planner. ──
    // `message` es el mensaje real del turno actual tal como lo escribió el
    // admin en el chat del Laboratorio — es el equivalente exacto del body
    // inbound real que respond.ts busca por inboundMessageId en producción
    // (aquí no hay fila en wa_messages que buscar: el propio parámetro YA es
    // ese texto). Mismo detector inbound (hard-escalation.ts), sin inventar
    // una segunda heurística para el sandbox.
    const hasHistory = history.length > 0
    const inboundAdverse = detectInboundAdverseReactionSignal(message)
    const neutralPlan: DecisionPlan = {
      stage: 'interesado', concept: 'ninguno', objection: null,
      goal: 'servicio', safety_signal: inboundAdverse ? 'reaccion_adversa' : 'ninguna',
    }
    const neutralConstraints: PlanConstraints = {
      offerAllowed: !inboundAdverse,
      maxQuestions: inboundAdverse ? 0 : 1,
      mustEscalate: inboundAdverse,
      greetingAllowed: !hasHistory,
      prohibitedActions: [],
    }
    const previousAssistantText = [...history].reverse().find(m => m.role === 'assistant')?.content ?? null

    const validation = validateResponse(openaiResult.text, neutralPlan, neutralConstraints, {
      hasHistory,
      previousAssistantText,
    })

    const blocked = validation.graveViolations.length > 0

    // Escalamiento: solo se SIMULA/REPORTA — NUNCA se ejecuta
    // escalate_genesis_conversation ni ninguna otra mutación real (no hay
    // conversación real que escalar en el sandbox). Se evalúa con AMBAS
    // señales (inbound del mensaje actual + outbound de la respuesta ya
    // validada), igual que en producción.
    const escalation = !blocked
      ? detectHardEscalationSignal(validation.finalText, message)
      : { required: false, reason: null, source: null }

    return NextResponse.json({
      reply:        blocked ? null : validation.finalText,
      blocked,
      blockReasons: validation.graveViolations,
      warnings:     validation.warnings,
      escalation,
      model,
      latencyMs,
      usage: openaiResult.usage
        ? { inputTokens: openaiResult.usage.promptTokens, outputTokens: openaiResult.usage.completionTokens }
        : null,
    })
  } catch (err) {
    console.error('[POST /api/admin/genesis-simulator/message]', err)
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: 'Error interno', detail: msg }, { status: 500 })
  }
}
