// Sprint 1C/2 — Auto-escalamiento real, detección de señal dura.
//
// Dos señales INDEPENDIENTES, combinadas con OR — ninguna reemplaza a la otra:
//
//   1. INBOUND (primaria, nueva en esta ronda): analiza el mensaje del
//      cliente que disparó el turno. Determinística, sin LLM. Detecta
//      combinaciones de (a) un síntoma/reacción y (b) evidencia de que
//      ocurrió en relación al uso del producto (o un verbo de causación que
//      ya implica ambas cosas a la vez, ej. "me irritó").
//   2. OUTBOUND (secundaria, se conserva): analiza si la RESPUESTA que
//      Génesis ya generó siguió ella misma el protocolo de reacción
//      adversa que el footer le exige (suspender uso + derivar a un
//      agente/profesional).
//
// Por qué dos señales: si Génesis redacta el protocolo perfecto, OUTBOUND
// ya lo detecta. Si Génesis falla en seguir el protocolo al pie de la letra
// (parafrasea, omite una parte, o directamente no reconoce la situación),
// INBOUND sigue protegiendo el flujo con una señal que no depende de que el
// modelo haya acertado su propia redacción.
//
// NUNCA usa una llamada a OpenAI adicional. NUNCA activa el Planner. NO es
// un clasificador de intención genérico — cubre EXCLUSIVAMENTE el patrón
// "el cliente reporta que el producto le causó una reacción/síntoma", con
// evidencia lingüística de dos partes exigida (símbolo de uso/causación +
// símbolo de síntoma), nunca un síntoma aislado ni una pregunta hipotética.

const HANDOFF_MARKERS = ['agente', 'profesional', 'especialista', 'médico', 'medico', 'dentista']

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export interface HardEscalationSignal {
  required: boolean
  reason:   'adverse_reaction' | null
  source:   'inbound' | 'outbound' | 'both' | null
}

// ── Señal OUTBOUND (existente, sin cambios de comportamiento) ──────────────

const SUSPEND_MARKERS = [
  'suspende el uso', 'suspender el uso', 'suspende su uso', 'suspender su uso',
  'deja de usar', 'deje de usar', 'detén el uso', 'detener el uso',
  'interrumpe el uso', 'interrumpir el uso',
]

export function detectOutboundAdverseReactionSignal(finalReplyText: string): boolean {
  const norm = normalize(finalReplyText)
  const mentionsSuspend = SUSPEND_MARKERS.some(m => norm.includes(normalize(m)))
  const mentionsHandoff = HANDOFF_MARKERS.some(m => norm.includes(m))
  return mentionsSuspend && mentionsHandoff
}

// ── Señal INBOUND (nueva) ───────────────────────────────────────────────
//
// Todos los patrones están escritos SIN tildes porque siempre se evalúan
// contra texto ya normalizado (normalize() aplica NFD + strip de diacríticos
// antes de cualquier test) — esto también cubre gratis errores ortográficos
// comunes por caída de acentos ("despues", "salio", "reaccion").

// Verbos donde el propio verbo YA ES el síntoma+causación fusionados — no
// necesitan un sustantivo de síntoma aparte ni contexto de uso explícito,
// porque en una conversación comercial sobre el producto, "me irritó/hinchó/
// inflamó [parte del cuerpo]" solo tiene un referente causal posible.
const FUSED_REACTION_VERBS: RegExp[] = [
  /\bme\s+irrito\b/, /\bme\s+hincho\b/, /\bme\s+inflamo\b/,
  /\bse\s+me\s+irrito\b/, /\bse\s+me\s+hincho\b/, /\bse\s+me\s+inflamo\b/,
]

// Verbos de causación genéricos — "algo me hizo esto", pero necesitan un
// sustantivo de síntoma (o el patrón de dolor) para ser significativos,
// porque solos son ambiguos ("me salió mal el pedido" no es una reacción).
const GENERIC_CAUSATION_VERBS: RegExp[] = [
  /\bme\s+(salio|dio|provoco|causo)\b/,
  /\bme\s+esta\s+causando\b/,
  /\bme\s+empezo\s+a\b/,
]

// Evidencia explícita de que el producto fue usado — contexto de uso.
const USE_CONTEXT_PATTERNS: RegExp[] = [
  /despues de usar/, /desde que (la |lo |)?uso\b/, /desde que (la |lo )?use\b/,
  /\bal usar(la|lo)?\b/, /\bla use\b/, /\blo use\b/,
  /\bcon la pasta\b/, /\bcon el producto\b/, /\bcon luma\b/,
  /me la (puse|aplique)\b/, /me lo (puse|aplique)\b/,
  /usando la pasta/, /usando el producto/,
]

// Sustantivos/adjetivos de síntoma real — reacción dermatológica/dolorosa
// concreta. Deliberadamente NO incluye "sensibilidad"/"alergia" bare (son
// temas comerciales normales del producto o condiciones preexistentes, no
// evidencia de una reacción ya ocurrida) — solo formas que describen que
// algo YA pasó.
const SYMPTOM_NOUN_PATTERNS: RegExp[] = [
  /sarpullido/, /\bronchas?\b/, /urticaria/,
  /\barden\b/, /\bardor\b/,
  /hinchad[oa]s?\b/, /inflamad[oa]s?\b/, /inflamacion\b/,
  /irritad[oa]s?\b/,
  /\breaccion\b/,
  /\bpus\b/, /\bsangrad[oa]\b/, /\bsangre\b/,
  /quemazon\b/,
]

// Dolor — solo cuenta si coexiste con causación/uso (bare "me duele una
// muela" es una dolencia preexistente no relacionada al producto).
const PAIN_PATTERN = /\bdol(er|iendo)\b|\bduele\b/

export function detectInboundAdverseReactionSignal(customerMessage: string): boolean {
  const norm = normalize(customerMessage)

  const hasFusedReaction    = FUSED_REACTION_VERBS.some(p => p.test(norm))
  const hasGenericCausation = GENERIC_CAUSATION_VERBS.some(p => p.test(norm))
  const hasUseContext       = USE_CONTEXT_PATTERNS.some(p => p.test(norm))
  const hasSymptomNoun      = SYMPTOM_NOUN_PATTERNS.some(p => p.test(norm))
  const hasPain             = PAIN_PATTERN.test(norm)

  if (hasFusedReaction) return true
  if (hasGenericCausation && (hasSymptomNoun || hasPain)) return true
  if (hasSymptomNoun && hasUseContext) return true
  if (hasPain && (hasUseContext || hasGenericCausation)) return true
  return false
}

// ── Combinación — punto de entrada usado por respond.ts y el Laboratorio ──
//
// `customerMessage` es opcional únicamente por compatibilidad de firma; los
// dos call sites reales (respond.ts, endpoint del Laboratorio) SIEMPRE lo
// pasan — ver comentarios en cada uno sobre de dónde sale ese texto.
export function detectHardEscalationSignal(
  finalReplyText:  string,
  customerMessage?: string | null,
): HardEscalationSignal {
  const outbound = detectOutboundAdverseReactionSignal(finalReplyText)
  const inbound  = customerMessage ? detectInboundAdverseReactionSignal(customerMessage) : false

  if (!outbound && !inbound) return { required: false, reason: null, source: null }

  const source = outbound && inbound ? 'both' : outbound ? 'outbound' : 'inbound'
  return { required: true, reason: 'adverse_reaction', source }
}
