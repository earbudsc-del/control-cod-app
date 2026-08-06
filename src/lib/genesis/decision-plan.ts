// Decision Plan V1 — tipo mínimo, parser y validador determinístico.
//
// Separa DECISIÓN (qué debe lograr este turno — requiere entender la
// conversación) de REDACCIÓN (cómo se escribe — pura habilidad de lenguaje).
// Este archivo no llama a OpenAI ni a Supabase — es lógica pura, sin red.
//
// Principio de diseño: cada campo debe justificar su existencia. Un campo
// derivable de otro (o de datos que el código ya tiene, como si hay
// historial) NO vive aquí — vive en derivePlanConstraints(), calculado por
// código, nunca pedido al LLM.
//
// "escalar" NO es un valor de `goal` — durante el diseño se detectó que
// goal='escalar' era 1:1 redundante con safety_signal !== 'ninguna' (el
// footer solo escala ante señal médica real, nunca por otra razón). Se
// fusionaron: el generador deriva "hay que escalar" de safety_signal, no de
// goal. Esto deja el plan en 5 campos, no 6.

export const STAGES = [
  'curioso', 'interesado', 'esceptico', 'comparando', 'indeciso',
  'confundido', 'ansioso', 'frustrado', 'listo_comprar',
  'cliente_existente', 'riesgo_cancelacion',
] as const
export type Stage = (typeof STAGES)[number]

export const CONCEPTS = [
  'esmalte', 'sensibilidad', 'caries', 'blanqueamiento', 'salud_bucal', 'ninguno',
] as const
export type Concept = (typeof CONCEPTS)[number]

export const OBJECTIONS = [
  'precio', 'confianza', 'efectividad', 'ingredientes', 'competencia', 'entrega', 'dinero',
] as const
export type Objection = (typeof OBJECTIONS)[number]

export const GOALS = [
  'responder_duda', 'construir_confianza', 'resolver_objecion',
  'presentar_oferta', 'cerrar', 'tranquilizar', 'servicio',
] as const
export type Goal = (typeof GOALS)[number]

export const SAFETY_SIGNALS = ['ninguna', 'revision_medica', 'reaccion_adversa'] as const
export type SafetySignal = (typeof SAFETY_SIGNALS)[number]

export interface DecisionPlan {
  stage:         Stage
  concept:       Concept
  objection:     Objection | null
  goal:          Goal
  safety_signal: SafetySignal
}

const STAGE_SET  = new Set<string>(STAGES)
const CONCEPT_SET = new Set<string>(CONCEPTS)
const OBJECTION_SET = new Set<string>(OBJECTIONS)
const GOAL_SET = new Set<string>(GOALS)
const SAFETY_SET = new Set<string>(SAFETY_SIGNALS)

const REQUIRED_FIELDS = ['stage', 'concept', 'objection', 'goal', 'safety_signal'] as const

// Límite defensivo sobre el texto crudo devuelto por el planner — un plan
// real serializado pesa ~120-180 caracteres. Cualquier cosa por encima de
// esto indica que el modelo no siguió la instrucción de "solo JSON, sin
// texto adicional" (ej. agregó explicación) — se rechaza antes de intentar
// parsear, sin gastar el esfuerzo del JSON.parse.
const MAX_RAW_PLAN_CHARS = 1000

export type PlanValidationResult =
  | { ok: true; plan: DecisionPlan }
  | { ok: false; reason: string }

// Quita fences de markdown (```json ... ```) si el modelo los agregó pese a
// la instrucción de no usarlos — normalización defensiva, no un fix “mágico”:
// solo remueve delimitadores, nunca altera el contenido entre ellos.
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}

export function parseDecisionPlanJson(rawText: string): PlanValidationResult {
  if (rawText.length > MAX_RAW_PLAN_CHARS) {
    return { ok: false, reason: `respuesta del planner demasiado larga (${rawText.length} caracteres) — no parece JSON puro` }
  }

  const cleaned = stripCodeFences(rawText)

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return { ok: false, reason: 'no es JSON válido' }
  }

  return validateDecisionPlanShape(parsed)
}

export function validateDecisionPlanShape(raw: unknown): PlanValidationResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'el JSON no es un objeto' }
  }
  const obj = raw as Record<string, unknown>

  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) return { ok: false, reason: `falta el campo requerido "${field}"` }
    // Un array en cualquiera de estos campos es un error de formato del
    // modelo (ej. devolvió ["precio"] en vez de "precio") — se rechaza
    // explícitamente en vez de intentar adivinar cuál elemento usar.
    if (Array.isArray(obj[field])) return { ok: false, reason: `el campo "${field}" no debe ser un array` }
  }

  const stage = obj.stage
  if (typeof stage !== 'string' || !STAGE_SET.has(stage)) {
    return { ok: false, reason: `"stage" inválido: ${JSON.stringify(stage)}` }
  }

  const concept = obj.concept
  if (typeof concept !== 'string' || !CONCEPT_SET.has(concept)) {
    return { ok: false, reason: `"concept" inválido: ${JSON.stringify(concept)}` }
  }

  const objectionRaw = obj.objection
  if (objectionRaw !== null && (typeof objectionRaw !== 'string' || !OBJECTION_SET.has(objectionRaw))) {
    return { ok: false, reason: `"objection" inválido: ${JSON.stringify(objectionRaw)}` }
  }
  const objection = objectionRaw as Objection | null

  const goal = obj.goal
  if (typeof goal !== 'string' || !GOAL_SET.has(goal)) {
    return { ok: false, reason: `"goal" inválido: ${JSON.stringify(goal)}` }
  }

  const safetySignal = obj.safety_signal
  if (typeof safetySignal !== 'string' || !SAFETY_SET.has(safetySignal)) {
    return { ok: false, reason: `"safety_signal" inválido: ${JSON.stringify(safetySignal)}` }
  }

  // ── Reglas cruzadas (coherencia entre campos) ──────────────────────────
  // Un plan internamente contradictorio es una señal de que la clasificación
  // no es confiable — se rechaza en vez de intentar adivinar cuál campo
  // tiene razón. Coherente con "prefiero perder un turno antes que responder
  // con una decisión incorrecta".
  if (goal === 'resolver_objecion' && objection === null) {
    return { ok: false, reason: 'goal="resolver_objecion" pero objection=null — incoherente' }
  }
  if (safetySignal !== 'ninguna' && (goal === 'presentar_oferta' || goal === 'cerrar')) {
    return { ok: false, reason: `safety_signal="${safetySignal}" pero goal="${goal}" — nunca se vende ante una señal médica` }
  }
  if (stage === 'riesgo_cancelacion' && (goal === 'presentar_oferta' || goal === 'cerrar')) {
    return { ok: false, reason: `stage="riesgo_cancelacion" pero goal="${goal}" — nunca se vende en riesgo de cancelación` }
  }

  return {
    ok: true,
    plan: { stage: stage as Stage, concept: concept as Concept, objection, goal: goal as Goal, safety_signal: safetySignal as SafetySignal },
  }
}

// ── Constraints derivados — nunca pedidos al LLM, siempre calculados ──────
// por código a partir del plan + datos que el orquestador ya tiene (si hay
// historial). Esto es lo que el response-validator y el generador consultan
// para saber qué está prohibido en este turno específico.

export interface PlanConstraints {
  offerAllowed:     boolean
  maxQuestions:     number
  mustEscalate:     boolean
  greetingAllowed:  boolean
  prohibitedActions: string[]
}

export function derivePlanConstraints(plan: DecisionPlan, hasHistory: boolean): PlanConstraints {
  const mustEscalate = plan.safety_signal !== 'ninguna'
  // Solo "reaccion_adversa" activa el protocolo estricto de 3 partes (Reglas
  // generales del footer): empatía, suspender uso, escalar — sin preguntas,
  // sin excepción. "revision_medica" (embarazo/niños/condición sin info
  // aprobada) también escala y también prohíbe la oferta, pero SÍ puede
  // cerrar con una pregunta natural — así se diseñó originalmente en RG-1/
  // RG-2 (ver casos 13/14 de scripts/test-genesis-commercial-luma.ts, que
  // nunca exigieron 0 preguntas para este caso). Encontrado durante la
  // comparación real Decision Plan vs RG-2 de esta fase — el primer diseño
  // igualaba ambas señales y rechazaba de más.
  const strictProtocol = plan.safety_signal === 'reaccion_adversa'
  const offerAllowed = !mustEscalate && (plan.goal === 'presentar_oferta' || plan.goal === 'cerrar')
  const greetingAllowed = !hasHistory

  const prohibitedActions: string[] = []
  if (!offerAllowed)     prohibitedActions.push('presentar_oferta')
  if (mustEscalate)      prohibitedActions.push('vender', 'presionar', 'preguntar_sintomas')
  if (!greetingAllowed)  prohibitedActions.push('saludar')
  if (plan.stage === 'riesgo_cancelacion') prohibitedActions.push('presionar', 'urgencia')

  return {
    offerAllowed,
    maxQuestions: strictProtocol ? 0 : 1,
    mustEscalate,
    greetingAllowed,
    prohibitedActions,
  }
}
