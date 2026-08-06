// Decision Plan V1 — Planner.
//
// Responsabilidad única: dado el historial de la conversación, decidir
// stage/concept/objection/goal/safety_signal (ver decision-plan.ts) y nada
// más. No redacta, no escribe en Supabase, no envía mensajes, no conoce
// wa_conversations ni genesis_message_runs — es una función pura de
// "historial + contexto de producto → Decision Plan | error", reutilizando
// callOpenAI() de respond.ts para la llamada HTTP real.

// Solo tipos desde respond.ts — nunca un import de valor. respond.ts importa
// generateDecisionPlan()/buildPlannerContext() de este archivo, así que un
// import de valor en sentido contrario crearía una dependencia circular en
// runtime. callOpenAIFn se recibe como parámetro obligatorio (lo resuelve
// siempre el caller, que ya tiene su propia referencia a callOpenAI real o
// al doble de prueba inyectado) en vez de importarlo con un default aquí.
import type { ChatMessage, CallOpenAIFn } from './respond'
import { parseDecisionPlanJson, type DecisionPlan } from './decision-plan'

interface KnowledgeSectionRow {
  label:   string
  content: string | null
}

// Timeout propio, menor que el del Generator (OPENAI_TIMEOUT_MS=15s en
// respond.ts) — la tarea del planner es más simple (clasificación, no
// redacción) y su salida es un JSON corto, así que no necesita el mismo
// margen.
const PLANNER_TIMEOUT_MS  = 10_000
const PLANNER_MAX_TOKENS  = 150
const PLANNER_TEMPERATURE = 0.2 // baja — clasificación, no creatividad

export function buildPlannerContext(
  agentName:    string,
  systemPrompt: string | null,
  sections:     KnowledgeSectionRow[],
): string {
  const parts: string[] = []

  parts.push(
    systemPrompt?.trim() ||
    `Eres ${agentName || 'Génesis'}, un asistente de atención al cliente por WhatsApp para una ` +
    'tienda de e-commerce con pago contra entrega (COD) en República Dominicana.',
  )

  const active = sections.filter(s => s.content?.trim())
  if (active.length > 0) {
    parts.push('--- Base de conocimiento ---')
    for (const s of active) parts.push(`## ${s.label}\n${s.content}`)
  }

  parts.push(
    '--- Tu única tarea en este turno ---\n' +
    'No vas a redactar una respuesta para el cliente. Otro proceso se encarga de redactar. Tu ' +
    'única tarea es analizar el mensaje más reciente del cliente (y el historial de la ' +
    'conversación) y devolver EXCLUSIVAMENTE un objeto JSON, sin texto antes ni después, sin ' +
    'explicación, sin markdown, con esta forma exacta:\n\n' +
    '{"stage": "...", "concept": "...", "objection": "..." | null, "goal": "...", "safety_signal": "..."}\n\n' +
    '"stage" — uno de: curioso, interesado, esceptico, comparando, indeciso, confundido, ansioso, ' +
    'frustrado, listo_comprar, cliente_existente, riesgo_cancelacion.\n\n' +
    '"concept" — el concepto del producto más relevante para este turno, uno de: esmalte, ' +
    'sensibilidad, caries, blanqueamiento, salud_bucal, ninguno.\n\n' +
    '"objection" — si hay una objeción activa en el mensaje del cliente, exactamente una de: ' +
    'precio, confianza, efectividad, ingredientes, competencia, entrega, dinero. Si no hay ' +
    'ninguna objeción activa, usa null (no una cadena vacía, no "ninguna").\n\n' +
    '"goal" — el único objetivo que debería perseguir la respuesta de este turno, uno de: ' +
    'responder_duda, construir_confianza, resolver_objecion, presentar_oferta, cerrar, ' +
    'tranquilizar, servicio. Nunca uses presentar_oferta ni cerrar si stage=riesgo_cancelacion o ' +
    'si safety_signal no es "ninguna".\n\n' +
    '"safety_signal" — uno de: ninguna, revision_medica (el cliente pregunta específicamente por ' +
    'embarazo, niños, o una condición médica particular sin información aprobada para responderla ' +
    'con seguridad), reaccion_adversa (el cliente reporta una reacción adversa REAL tras usar el ' +
    'producto — dolor, inflamación, sangrado, pus, fiebre, sarpullido, alergia, irritación). Nunca ' +
    'marques revision_medica ni reaccion_adversa ante una pregunta comercial normal de prevención o ' +
    'cuidado diario (ej. "¿es segura?", "¿sirve para sensibilidad?") — eso es safety_signal=ninguna.\n\n' +
    'Responde ÚNICAMENTE el objeto JSON. Nada de texto adicional, nada de comentarios, nada de ' +
    'formato markdown, ni siquiera una palabra antes o después del JSON.',
  )

  return parts.join('\n\n')
}

export type DecisionPlanOutcome =
  | { ok: true;  plan: DecisionPlan; rawText: string }
  | { ok: false; kind: 'timeout' | 'api_error' | 'invalid_json' | 'validation_failed'; reason?: string }

export async function generateDecisionPlan(
  apiKey:               string,
  model:                string,
  plannerSystemPrompt:  string,
  history:              ChatMessage[],
  callOpenAIFn:         CallOpenAIFn,
): Promise<DecisionPlanOutcome> {
  const messages: ChatMessage[] = [
    { role: 'system', content: plannerSystemPrompt },
    ...history,
  ]

  const result = await callOpenAIFn(apiKey, model, messages, {
    temperature: PLANNER_TEMPERATURE,
    maxTokens:   PLANNER_MAX_TOKENS,
    jsonMode:    true,
    timeoutMs:   PLANNER_TIMEOUT_MS,
  })

  if (!result.ok) {
    return { ok: false, kind: result.kind === 'timeout' ? 'timeout' : 'api_error' }
  }

  const parsed = parseDecisionPlanJson(result.text)
  if (!parsed.ok) {
    // "no es JSON válido" / "demasiado larga" → problema de formato puro.
    // Cualquier otro motivo (enum inválido, campo faltante, regla cruzada
    // incoherente) → el JSON parseó pero su contenido no es válido.
    const isFormatIssue = parsed.reason.includes('JSON válido') || parsed.reason.includes('demasiado larga')
    return {
      ok:     false,
      kind:   isFormatIssue ? 'invalid_json' : 'validation_failed',
      reason: parsed.reason,
    }
  }

  return { ok: true, plan: parsed.plan, rawText: result.text }
}
