// Decision Plan V1 — Validador de respuesta (última puerta antes de Meta).
//
// Hoy (pre-Decision Plan) el texto de OpenAI viaja directo a
// sendWhatsAppText() sin ningún chequeo. Este módulo es el primer punto de
// validación determinística de la historia de Génesis.
//
// Dos niveles, deliberadamente distintos:
//   - Auto-fix (simple): normalización de formato que NUNCA puede cambiar el
//     significado — espacios, saludo repetido, negrita de markdown. Se
//     corrige en el momento, sin gastar una llamada nueva a OpenAI.
//   - Grave (bloquea el envío): claims prohibidos, urgencia falsa, ataque a
//     competencia, oferta cuando el plan la prohíbe, protocolo de reacción
//     adversa incumplido, exceso de preguntas. Nunca se "arregla" texto con
//     una violación grave — mutar una frase con un claim médico prohibido
//     arriesga dejar una versión igual de riesgosa. El caller cierra el run
//     con finishRun() y no envía nada.
//
// No llama a OpenAI, no llama a Supabase, no envía nada — función pura.

import type { DecisionPlan, PlanConstraints } from './decision-plan'

export interface ResponseValidationContext {
  hasHistory:           boolean
  previousAssistantText: string | null
}

export interface ResponseValidationResult {
  finalText:        string
  warnings:         string[]
  graveViolations:  string[]
}

// Mismo espíritu que GLOBAL_PROHIBITED en scripts/test-genesis-commercial-
// luma.ts — pero esta es la copia de PRODUCCIÓN, evaluada en runtime contra
// respuestas reales, no en un test offline. Las dos listas se mantienen
// alineadas a mano (no se importa una desde la otra: el script de test vive
// fuera del bundle de producción a propósito).
const PROHIBITED_PHRASES = [
  'cura caries', 'elimina caries existentes', 'reemplaza al dentista',
  'resultados garantizados', 'garantiza resultados', '100% seguro para cualquier persona',
  'como modelo de ia', 'soy un bot', 'soy una ia', 'como modelo de lenguaje',
  'como asistente virtual', 'como ia', 'te informo que', 'le informamos que',
  'procedemos a', 'estimado cliente',
  'solo por hoy', 'última oportunidad', 'se están agotando', 'quedan pocas unidades',
]

// Heurística acotada de "no atacar competencia" — lista corta de marcas
// mencionadas en el footer/knowledge aprobados. No es exhaustiva: una marca
// nueva no listada aquí no se detecta. Limitación conocida, documentada.
const COMPETITOR_BRANDS = ['sensodyne', 'colgate', 'oral-b', 'oral b', 'crest']
const ATTACK_PATTERNS = ['no sirve', 'es mala', 'es malo', 'peor que']

const OFFER_MARKERS = ['2,100', '2100', '2,700', '2700', '3,780', '3780', 'cepillo']
const ESCALATION_WORDS = ['agente', 'profesional', 'especialista', 'médico', 'medico', 'dentista']
// "¡?" — el español abre exclamaciones con el signo invertido ("¡Hola!"),
// que no es \s y por lo tanto no lo consumía la versión anterior de este
// regex (bug encontrado por scripts/test-genesis-respond-orchestrator.ts,
// escenario 18).
const GREETING_RE = /^\s*¡?\s*(hola|buenas|buen[oa]s\s+(d[ií]as|tardes|noches)|saludos)[!,.\s]*/i

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// ── Auto-fix (simple, nunca cambia significado) ────────────────────────────

function autoFix(text: string, constraints: PlanConstraints): { text: string; fixed: string[] } {
  const fixed: string[] = []
  let out = text

  // Colapsa múltiples saltos de línea/espacios — Génesis responde en un
  // solo párrafo (Sales Copy Engine, sección "Cómo escribir para WhatsApp").
  const collapsed = out.replace(/\n{2,}/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
  if (collapsed !== out) { out = collapsed; fixed.push('espacios/saltos de línea colapsados') }

  // Quita negrita de markdown (**texto**) — el footer prohíbe markdown
  // explícitamente; quitar los símbolos no cambia ni una palabra del texto.
  const noBold = out.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
  if (noBold !== out) { out = noBold; fixed.push('negrita de markdown removida') }

  // Saludo repetido en conversación en curso — quitar el saludo inicial no
  // cambia el contenido de la respuesta, solo su apertura.
  if (!constraints.greetingAllowed && GREETING_RE.test(out)) {
    const stripped = out.replace(GREETING_RE, '').trim()
    if (stripped) {
      out = stripped.charAt(0).toUpperCase() + stripped.slice(1)
      fixed.push('saludo repetido removido (conversación en curso)')
    }
  }

  return { text: out, fixed }
}

// ── Validación grave (bloquea el envío) ────────────────────────────────────

function findGraveViolations(
  text: string,
  plan: DecisionPlan,
  constraints: PlanConstraints,
): string[] {
  const norm = normalize(text)
  const violations: string[] = []

  for (const phrase of PROHIBITED_PHRASES) {
    if (norm.includes(normalize(phrase))) violations.push(`frase prohibida: "${phrase}"`)
  }

  const questionMarks = (text.match(/\?/g) ?? []).length
  if (questionMarks > constraints.maxQuestions) {
    violations.push(`${questionMarks} signos "?" — máximo permitido ${constraints.maxQuestions}`)
  }

  const mentionsOffer = OFFER_MARKERS.some(m => norm.includes(normalize(m)))
  if (mentionsOffer && !constraints.offerAllowed) {
    violations.push('menciona oferta/precio en un turno donde el plan lo prohíbe')
  }

  if (constraints.mustEscalate) {
    const escalates = ESCALATION_WORDS.some(w => norm.includes(w))
    if (!escalates) violations.push(`safety_signal="${plan.safety_signal}" pero la respuesta no deriva a un humano/profesional`)
  }

  for (const brand of COMPETITOR_BRANDS) {
    if (!norm.includes(brand)) continue
    const idx = norm.indexOf(brand)
    const window = norm.slice(Math.max(0, idx - 25), idx + brand.length + 25)
    if (ATTACK_PATTERNS.some(p => window.includes(p))) {
      violations.push(`posible ataque a competencia cerca de "${brand}"`)
    }
  }

  return violations
}

// ── Advertencias (se registran, no bloquean) ───────────────────────────────

function findWarnings(text: string, ctx: ResponseValidationContext): string[] {
  const warnings: string[] = []

  if (ctx.previousAssistantText && text.trim() === ctx.previousAssistantText.trim()) {
    warnings.push('la respuesta repite literalmente el turno anterior de Génesis')
  }

  const opensWithNegation = /^\s*(no|pero|sin embargo)\b/i.test(text.trim())
  if (opensWithNegation) warnings.push('la respuesta abre con negación/limitación')

  return warnings
}

export function validateResponse(
  rawText:      string,
  plan:         DecisionPlan,
  constraints:  PlanConstraints,
  ctx:          ResponseValidationContext,
): ResponseValidationResult {
  const { text: fixedText, fixed } = autoFix(rawText, constraints)

  const graveViolations = findGraveViolations(fixedText, plan, constraints)
  const warnings = [...fixed.map(f => `auto-fix aplicado: ${f}`), ...findWarnings(fixedText, ctx)]

  return { finalText: fixedText, warnings, graveViolations }
}
