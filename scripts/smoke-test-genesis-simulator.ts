// Smoke test multi-turno del Laboratorio de Génesis — validación final.
//
// Ejecuta la MISMA secuencia de funciones que
// src/app/api/admin/genesis-simulator/message/route.ts (buildSystemPrompt,
// callOpenAI, validateResponse, detectHardEscalationSignal) turno por turno,
// acumulando el historial exactamente como lo haría el frontend real
// (GenesisSimulator.tsx) enviándolo de vuelta en cada request.
//
// Deliberadamente NO pasa por HTTP/Next.js — el endpoint real exige una
// sesión de admin autenticada (cookies de Supabase), que este script no
// puede simular sin credenciales reales. Lo que SÍ valida, 1:1, es el motor
// que el endpoint invoca: mismo system prompt real, mismo modelo real, mismo
// validador, mismo detector de escalamiento. La capa de auth/HTTP ya está
// cubierta por scripts/test-genesis-simulator-isolation.ts (verificación
// estática) y por la prueba manual del usuario en la UI real.
//
// NUNCA llama a sendWhatsAppText, NUNCA toca wa_messages/wa_conversations/
// wa_template_queue/genesis_message_runs/orders/agent_actions — solo lee
// ai_agent_config + ai_agent_knowledge_sections (mismas tablas que el
// endpoint) y llama a OpenAI. NO ejecuta escalate_genesis_conversation real
// — solo reporta si se habría requerido.
//
// Corre con: npx tsx scripts/smoke-test-genesis-simulator.ts
// Consume OpenAI real (8 llamadas cortas, mismo modelo que producción).

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { buildSystemPrompt, callOpenAI, type ChatMessage } from '../src/lib/genesis/respond'
import type { DecisionPlan, PlanConstraints } from '../src/lib/genesis/decision-plan'
import { validateResponse } from '../src/lib/genesis/response-validator'
import { detectHardEscalationSignal, detectInboundAdverseReactionSignal } from '../src/lib/genesis/hard-escalation'

const envRaw = readFileSync('.env.local', 'utf8')
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] = m[2]
}
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } })

const HISTORY_LIMIT = 20

const TURNS = [
  'Hola, cuánto cuesta?',
  'Y llega a Santiago?',
  'Está muy caro.',
  '¿Cómo sé que es original?',
  '¿Tiene código QR?',
  'Sí, quiero pedirlo.',
  'En realidad ya no lo quiero.',
  'Me provocó una reacción extraña y me duele mucho.',
]

interface SimMessage { role: 'user' | 'assistant'; content: string }

async function main() {
  const { data: configs } = await svc.from('ai_agent_config').select('store_id')
  if (!configs || configs.length !== 1) {
    console.error('✖ Esperaba exactamente 1 fila en ai_agent_config, encontré:', configs?.length)
    process.exit(1)
  }
  const storeId = configs[0].store_id as string

  const { data: config } = await svc
    .from('ai_agent_config')
    .select('agent_name, provider, model, api_key_ref, system_prompt')
    .eq('store_id', storeId)
    .maybeSingle()
  if (!config || config.provider !== 'openai' || !config.api_key_ref) {
    console.error('✖ ai_agent_config inválida para esta prueba:', config)
    process.exit(1)
  }
  const apiKey = process.env[config.api_key_ref]
  if (!apiKey) { console.error(`✖ Env var ${config.api_key_ref} no definida`); process.exit(1) }

  const { data: sections } = await svc
    .from('ai_agent_knowledge_sections')
    .select('label, content')
    .eq('store_id', storeId)
    .eq('is_active', true)
    .order('priority', { ascending: false })

  const systemPrompt = buildSystemPrompt(config.agent_name, config.system_prompt, (sections ?? []) as { label: string; content: string | null }[])
  const model = config.model?.trim() || 'gpt-4o-mini'

  console.log('=== Smoke test multi-turno — Laboratorio de Génesis ===')
  console.log(`Modelo: ${model} | Turnos: ${TURNS.length}\n`)

  const history: SimMessage[] = []
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalLatencyMs = 0

  for (let i = 0; i < TURNS.length; i++) {
    const userMessage = TURNS[i]
    const cappedHistory = history.slice(-HISTORY_LIMIT)

    const chatMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...cappedHistory.map(h => ({ role: h.role, content: h.content }) as ChatMessage),
      { role: 'user', content: userMessage },
    ]

    const startedAt = Date.now()
    const result = await callOpenAI(apiKey, model, chatMessages)
    const latencyMs = Date.now() - startedAt
    totalLatencyMs += latencyMs

    console.log(`--- Turno ${i + 1} ---`)
    console.log(`Cliente:  ${userMessage}`)

    if (!result.ok) {
      console.log(`❌ OpenAI falló (${result.kind}) — turno abortado`)
      continue
    }

    if (result.usage) {
      totalInputTokens += result.usage.promptTokens
      totalOutputTokens += result.usage.completionTokens
    }

    const hasHistory = cappedHistory.length > 0
    const inboundAdverse = detectInboundAdverseReactionSignal(userMessage)
    const neutralPlan: DecisionPlan = {
      stage: 'interesado', concept: 'ninguno', objection: null,
      goal: 'servicio', safety_signal: inboundAdverse ? 'reaccion_adversa' : 'ninguna',
    }
    const neutralConstraints: PlanConstraints = {
      offerAllowed: !inboundAdverse, maxQuestions: inboundAdverse ? 0 : 1,
      mustEscalate: inboundAdverse, greetingAllowed: !hasHistory, prohibitedActions: [],
    }
    const previousAssistantText = [...cappedHistory].reverse().find(m => m.role === 'assistant')?.content ?? null

    const validation = validateResponse(result.text, neutralPlan, neutralConstraints, { hasHistory, previousAssistantText })
    const blocked = validation.graveViolations.length > 0
    const escalation = !blocked
      ? detectHardEscalationSignal(validation.finalText, userMessage)
      : { required: false, reason: null, source: null }

    console.log(`Génesis:  ${blocked ? '(BLOQUEADO — no se enviaría nada)' : validation.finalText}`)
    if (validation.warnings.length > 0) console.log(`  ⚠ warnings: ${validation.warnings.join(' | ')}`)
    if (blocked) console.log(`  ❌ blockReasons: ${validation.graveViolations.join(' | ')}`)
    if (escalation.required) console.log(`  🚨 [Escalamiento requerido] reason=${escalation.reason} (NO se ejecuta RPC real en este smoke test)`)
    console.log(`  (latency=${latencyMs}ms, tokens in/out=${result.usage?.promptTokens ?? '?'}/${result.usage?.completionTokens ?? '?'})`)
    console.log('')

    history.push({ role: 'user', content: userMessage })
    if (!blocked) history.push({ role: 'assistant', content: validation.finalText })
  }

  console.log('=== RESUMEN (8 turnos) ===')
  console.log(`Latencia total: ${totalLatencyMs} ms | promedio: ${Math.round(totalLatencyMs / TURNS.length)} ms/turno`)
  console.log(`Tokens de entrada (acumulado): ${totalInputTokens}`)
  console.log(`Tokens de salida (acumulado): ${totalOutputTokens}`)

  // ── Test 9 — conversación NUEVA e independiente, un solo turno ──────────
  // Confirma que el detector INBOUND marca [Escalamiento requerido] aunque
  // Génesis redacte el protocolo con palabras distintas a las esperadas por
  // el detector OUTBOUND (señal secundaria).
  console.log('\n=== Test 9 (separado) — detector inbound, conversación nueva ===')
  const sarpullidoMessage = 'Me salió un sarpullido después de usarla.'
  const chatMessages9: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: sarpullidoMessage },
  ]
  const result9 = await callOpenAI(apiKey, model, chatMessages9)
  console.log(`Cliente:  ${sarpullidoMessage}`)
  if (!result9.ok) {
    console.log(`❌ OpenAI falló (${result9.kind})`)
  } else {
    const inboundAdverse9 = detectInboundAdverseReactionSignal(sarpullidoMessage)
    const plan9: DecisionPlan = { stage: 'interesado', concept: 'ninguno', objection: null, goal: 'servicio', safety_signal: inboundAdverse9 ? 'reaccion_adversa' : 'ninguna' }
    const constraints9: PlanConstraints = { offerAllowed: !inboundAdverse9, maxQuestions: inboundAdverse9 ? 0 : 1, mustEscalate: inboundAdverse9, greetingAllowed: true, prohibitedActions: [] }
    const validation9 = validateResponse(result9.text, plan9, constraints9, { hasHistory: false, previousAssistantText: null })
    const blocked9 = validation9.graveViolations.length > 0
    const escalation9 = !blocked9
      ? detectHardEscalationSignal(validation9.finalText, sarpullidoMessage)
      : { required: false, reason: null, source: null }

    console.log(`Génesis:  ${blocked9 ? '(BLOQUEADO — no se enviaría nada)' : validation9.finalText}`)
    console.log(`  detectInboundAdverseReactionSignal("${sarpullidoMessage}") = ${inboundAdverse9}`)
    if (validation9.warnings.length > 0) console.log(`  ⚠ warnings: ${validation9.warnings.join(' | ')}`)
    if (blocked9) console.log(`  ❌ blockReasons: ${validation9.graveViolations.join(' | ')}`)
    console.log(`  ${escalation9.required ? '🚨 [Escalamiento requerido]' : '(sin escalamiento)'} reason=${escalation9.reason} source=${escalation9.source}`)
  }
}

main()
