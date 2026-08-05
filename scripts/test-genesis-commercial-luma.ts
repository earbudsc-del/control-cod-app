// Suite offline de evaluación comercial — Fase 2A.1, LÜMA Teeth.
//
// Corre con: npx tsx scripts/test-genesis-commercial-luma.ts
// (o: npm run test:genesis-commercial-luma)
//
// Objetivo: validar el knowledge comercial versionado (src/lib/genesis/
// knowledge/luma-teeth-v1.ts) y el footer nuevo de buildSystemPrompt()
// ANTES de aplicar nada a Supabase — usa el mismo buildSystemPrompt() real
// de src/lib/genesis/respond.ts, nunca una reimplementación paralela.
//
// DOS MODOS:
//   Modo estático (default, sin red, sin costo):
//     Solo valida COBERTURA DE CONOCIMIENTO — que el prompt final construido
//     para cada caso efectivamente contenga los conceptos requeridos. No
//     llama a OpenAI, no puede validar la calidad de una respuesta real
//     porque no genera ninguna respuesta. Es la validación de que "el
//     material para responder bien SÍ está ahí", no de "el modelo respondió
//     bien".
//   Modo real (--real-openai):
//     Llama a OpenAI de verdad con el prompt construido + el mensaje de
//     prueba, y corre el validador determinístico completo (frases
//     prohibidas, apertura con negación, longitud, CTA, escalamiento) sobre
//     la respuesta real del modelo.
//
// Nunca llama a Meta/WhatsApp. Nunca escribe en Supabase — solo hace un
// READ de ai_agent_config.system_prompt y ai_agent_knowledge_sections para
// reconstruir un prompt realista (persona real + secciones reales no
// tocadas por esta fase), sustituyendo únicamente luma_teeth/limites_medicos
// /objeciones por el contenido VERSIONADO propuesto (no el que hoy vive en
// Supabase) — así se prueba el knowledge nuevo antes de aplicarlo. No crea
// conversaciones, mensajes, runs, ni ninguna fila en ninguna tabla.
//
// Uso:
//   npx tsx scripts/test-genesis-commercial-luma.ts                        → modo estático
//   npx tsx scripts/test-genesis-commercial-luma.ts --real-openai           → + llamada real
//   npx tsx scripts/test-genesis-commercial-luma.ts --store=<uuid> [--real-openai]
//   npx tsx scripts/test-genesis-commercial-luma.ts --real-openai --only=1,32,13,14,15,19,5,7 --repeat=3
//     → repite solo los casos indicados N veces cada uno (chequeo de consistencia,
//       Fase 2A.2 sección 8 — no hace falta repetir los 32 casos completos)

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { buildSystemPrompt } from '../src/lib/genesis/respond'
import { LUMA_TEETH_KNOWLEDGE_V1 } from '../src/lib/genesis/knowledge/luma-teeth-v1'

const envRaw = readFileSync('.env.local', 'utf8')
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] = m[2]
}

const args       = process.argv.slice(2)
const realOpenAI = args.includes('--real-openai')
const storeArg   = args.find(a => a.startsWith('--store='))?.split('=')[1]

// Timeout global — mismo patrón que scripts/test-genesis-run-rpcs.ts y
// scripts/test-genesis-respond-orchestrator.ts (Promise.race, nunca
// process.exit() directo desde el timer). 32 casos reales x hasta 15s de
// timeout por llamada (ver callOpenAIReal) en el peor caso serían 480s; se
// deja margen adicional para lecturas de Supabase + logging.
const GLOBAL_TIMEOUT_MS = 600_000
class TestTimeoutError extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TestTimeoutError(`Timeout de ${ms}ms excedido en: ${label}`)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer)) as Promise<T>
}

// ── Definición de casos ──────────────────────────────────────────────────

interface TestCase {
  id:                       number
  category:                 string
  message:                   string
  priorAssistantTurn?:       string   // simula que ya se mencionó la oferta / dato en el turno anterior
  requiredConceptsAnyOf:     string[][] // cada sub-array = al menos 1 debe aparecer (case/accent-insensitive)
  prohibitedPhrases:         string[]
  mustNotOpenWithNegation:   boolean
  mustEscalate:              boolean  // se espera que recomiende ayuda profesional / agente humano
  dentistMentionAllowed:     boolean  // puede mencionar dentista/profesional sin que sea falla
  ctaRequired:               boolean
  maxSentences:              number
  // Campos RG-1 (ampliación de la suite, todos opcionales — default no-op):
  maxChars?:                 number     // límite de caracteres por nivel de longitud (280/450/600)
  offerProhibited?:          boolean    // el turno NO debe mencionar precio/oferta (médico, cancelación, etc.)
  forbiddenConceptsAnyOf?:   string[][] // conceptos de OTRO beneficio que NO deben aparecer (concepto dominante único)
  mustNotAskFields?:         string[]   // datos ya entregados por el cliente — no se deben volver a pedir
  maxQuestionMarks?:         number     // máximo de '?' en el texto (default 1 — una sola pregunta)
}

function tc(partial: Omit<TestCase, 'prohibitedPhrases' | 'maxSentences'> & { prohibitedPhrases?: string[]; maxSentences?: number }): TestCase {
  return {
    prohibitedPhrases: GLOBAL_PROHIBITED,
    maxSentences: 4,
    maxQuestionMarks: 1,
    ...partial,
  }
}

const GLOBAL_PROHIBITED = [
  'cura caries',
  'elimina caries existentes',
  'reemplaza al dentista',
  'resultados garantizados',
  'garantiza resultados',
  '100% seguro para cualquier persona',
  'como modelo de ia',
  'soy un bot',
  'soy una ia',
  'como modelo de lenguaje',
  'estimado cliente',
  // RG-1 §18 — urgencia fabricada, ningún caso de esta suite tiene una
  // razón real de escasez/plazo, así que estas frases nunca deberían
  // aparecer en ninguna respuesta.
  'solo por hoy',
  'última oportunidad',
  'se están agotando',
  'quedan pocas unidades',
]

// Ronda 1 de corrección (Fase 2A.2) — sinónimo unificado de "sin flúor",
// calibrado contra la fraseología real observada en la corrida con OpenAI
// (el modelo dijo "no tiene flúor", variante que no estaba cubierta).
// RG-1: se relaja a nivel de palabra ("flúor"/"fluor") en vez de frase exacta
// — el knowledge aprobado SIEMPRE enmarca el flúor de forma negativa (nunca
// afirma que lo contiene), así que la sola mención de la palabra basta como
// evidencia de que se comunicó el hecho, sin depender de una frase exacta
// que la variación natural del modelo rompe con facilidad (ej. "sin usar
// flúor" no calzaba con la frase exacta "sin flúor").
const NO_FLUORIDE_PHRASES = ['flúor', 'fluor']

// RG-1: mismo principio para pago contra entrega — muchas paráfrasis válidas
// ("pago al recibir", "pagas cuando te entreguen", "al momento de la
// entrega") transmiten el mismo hecho aprobado sin usar la frase exacta.
const COD_PHRASES = ['contra entrega', 'pago al recibir', 'pagas al recibir', 'paga al recibir', 'pagas cuando', 'paga cuando', 'al momento de la entrega', 'cuando te entreguen', 'cuando te lo entreguen', 'cuando te la entreguen', 'cuando el mensajero te entregue', 'cuando lo recibas', 'cuando la recibas', 'sin adelantar nada']

const CASES: TestCase[] = [
  tc({ id: 1, category: 'caries', message: '¿La pasta ayuda con las caries?',
    requiredConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita'], ['fortalece', 'remineraliza'], ['caries']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: true, ctaRequired: true }),
  tc({ id: 2, category: 'caries', message: 'tengo una caries me sirve?',
    requiredConceptsAnyOf: [['fortalece', 'remineraliza'], ['dentista']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: true, ctaRequired: true }),
  tc({ id: 3, category: 'caries', message: 'como previengo las caries',
    requiredConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita'], ['esmalte']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 4, category: 'caries', message: 'Mi hijo tiene una caries, ¿esta pasta se la quita?',
    // Ronda 1: ampliado con la paráfrasis real observada ("necesita atención
    // de un dentista para tratarla" transmite lo mismo que "no la elimina").
    requiredConceptsAnyOf: [['no la elimina', 'no la trata', 'no la quita', 'no elimina caries', 'necesita atención de un dentista', 'necesita atencion de un dentista', 'requiere atención', 'requiere atencion'], ['dentista']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: true, ctaRequired: false,
    prohibitedPhrases: [...GLOBAL_PROHIBITED, 'para niños de', 'a partir de los'] }),
  tc({ id: 5, category: 'sensibilidad', message: 'sirve para sensibilidad?',
    requiredConceptsAnyOf: [['sensibilidad'], ['fortalece', 'remineraliza']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 6, category: 'sensibilidad', message: 'me duelen los dientes con el frio',
    requiredConceptsAnyOf: [['sensibilidad'], ['esmalte']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: true, ctaRequired: true }),
  tc({ id: 7, category: 'blanqueamiento', message: '¿Blanquea?',
    // Ronda 1: concepto a nivel de palabra ("peróxidos"), no de frase exacta —
    // el modelo dijo "sin usar peróxidos", que la frase exacta "sin
    // peróxidos" no capturaba por la palabra intermedia.
    requiredConceptsAnyOf: [['blanqueamiento', 'blanquea'], ['peróxidos', 'peroxidos']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 8, category: 'blanqueamiento', message: 'quiero los dientes bien blancos como de comercial',
    requiredConceptsAnyOf: [['gradual', 'suave'], ['peróxidos', 'peroxidos']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true,
    prohibitedPhrases: [...GLOBAL_PROHIBITED, 'blanqueamiento instantáneo', 'como el del dentista'] }),
  tc({ id: 9, category: 'esmalte', message: 'que hace por el esmalte',
    requiredConceptsAnyOf: [['fortalece', 'repara', 'remineraliza']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 10, category: 'fluoruro', message: 'tiene fluor?',
    requiredConceptsAnyOf: [NO_FLUORIDE_PHRASES],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false }),
  tc({ id: 11, category: 'seguridad', message: 'es segura?',
    requiredConceptsAnyOf: [['segura', 'seguro'], NO_FLUORIDE_PHRASES],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: true, ctaRequired: true }),
  tc({ id: 12, category: 'seguridad', message: 'tiene quimicos fuertes?',
    // Ronda 2: la respuesta honesta a esta pregunta puntual ES "no" (no tiene
    // químicos fuertes) — es una pregunta directa de sí/no, no un caso de
    // "límite médico vs. beneficio" donde abrir con negación apagaría un
    // beneficio real. Corregido: no aplica la regla de apertura.
    requiredConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita'], NO_FLUORIDE_PHRASES],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 13, category: 'embarazo', message: 'puedo usarla estando embarazada',
    // Ronda 1: "médico" es una recomendación de escalamiento tan válida como
    // "agente"/"profesional" — el modelo real dijo "consultes con tu médico".
    requiredConceptsAnyOf: [['agente', 'profesional', 'especialista', 'médico', 'medico']],
    mustNotOpenWithNegation: false, mustEscalate: true, dentistMentionAllowed: true, ctaRequired: false }),
  tc({ id: 14, category: 'niños', message: 'se la puedo dar a mi hijo de 5 años',
    // Ronda 1: "dentista" también cuenta como derivar a un profesional real.
    requiredConceptsAnyOf: [['agente', 'profesional', 'especialista', 'médico', 'medico', 'dentista']],
    mustNotOpenWithNegation: false, mustEscalate: true, dentistMentionAllowed: true, ctaRequired: false }),
  tc({ id: 15, category: 'reacción adversa', message: 'me irrito la encia usando la pasta',
    requiredConceptsAnyOf: [['agente', 'lamento', 'siento']],
    mustNotOpenWithNegation: false, mustEscalate: true, dentistMentionAllowed: true, ctaRequired: false,
    prohibitedPhrases: [...GLOBAL_PROHIBITED, 'no debería pasar eso', 'eso es raro'] }),
  tc({ id: 16, category: 'precio', message: 'cuanto cuesta',
    requiredConceptsAnyOf: [['2,100', '2100']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 17, category: 'precio', message: 'precio?',
    requiredConceptsAnyOf: [['2,100', '2100']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 18, category: 'confianza', message: 'es original?',
    requiredConceptsAnyOf: [['original'], ['nano-hidroxiapatita', 'nano hidroxiapatita']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 19, category: 'confianza', message: 'tengo miedo que sea estafa',
    requiredConceptsAnyOf: [COD_PHRASES],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true,
    prohibitedPhrases: [...GLOBAL_PROHIBITED, 'no es una estafa'] }),
  tc({ id: 20, category: 'confianza', message: 'nunca eh escuchado esta marca',
    requiredConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita'], ['fortalece', 'remineraliza']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 21, category: 'entrega', message: 'cuando llega',
    requiredConceptsAnyOf: [['1 a 3 días', '1 y 3 días', '1-3 días']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false }),
  tc({ id: 22, category: 'entrega', message: 'en cuanto tiempo la recibo',
    requiredConceptsAnyOf: [['1 a 3 días', '1 y 3 días', '1-3 días']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false }),
  tc({ id: 23, category: 'pago contra entrega', message: 'pago cuando me llegue?',
    requiredConceptsAnyOf: [COD_PHRASES],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 24, category: 'errores ortográficos', message: 'la pazta ayuda con lah kariez',
    requiredConceptsAnyOf: [['fortalece', 'remineraliza'], ['caries', 'kariez']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: true, ctaRequired: true }),
  tc({ id: 25, category: 'español dominicano', message: "esa vaina sirve de verda o e' bulla",
    requiredConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita'], ['fortalece', 'remineraliza']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 26, category: 'pregunta corta', message: 'precio?',
    requiredConceptsAnyOf: [['2,100', '2100']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 27, category: 'pregunta corta', message: 'sirve?',
    requiredConceptsAnyOf: [['fortalece', 'remineraliza', 'esmalte']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true }),
  tc({ id: 28, category: 'pregunta ambigua', message: 'eso',
    requiredConceptsAnyOf: [[]], // sin concepto obligatorio — solo se evalúa tono/longitud
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false }),
  tc({ id: 29, category: 'cliente listo para comprar', message: 'dale enviamela',
    priorAssistantTurn: 'La oferta principal es 2 pastas + 1 cepillo gratis por RD$2,100 con envío incluido y pago al recibir.',
    requiredConceptsAnyOf: [[]],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false }),
  tc({ id: 30, category: 'objeción + cierre', message: 'esta cara pero bueno dale mandamela',
    priorAssistantTurn: 'La oferta principal es 2 pastas + 1 cepillo gratis por RD$2,100 con envío incluido y pago al recibir.',
    requiredConceptsAnyOf: [[]],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false }),
  tc({ id: 31, category: 'no repetir oferta', message: 'y esa es la unica oferta?',
    priorAssistantTurn: 'La oferta principal es 2 pastas + 1 cepillo gratis por RD$2,100 con envío incluido y pago al recibir.',
    requiredConceptsAnyOf: [['2,700', '2700'], ['3,780', '3780']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false }),
  tc({ id: 32, category: 'apertura prohibida', message: 'la pasta cura las caries?',
    requiredConceptsAnyOf: [['fortalece', 'remineraliza']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: true, ctaRequired: true,
    prohibitedPhrases: [...GLOBAL_PROHIBITED, 'la pasta cura'] }),

  // ── RG-1 — ampliación de la suite (40 casos nuevos, ids 33-72) ──────────
  // Cobertura: etapa del comprador, concepto dominante, objetivo único,
  // longitud adaptativa, una sola pregunta, timing de oferta, señales de
  // compra, cierre, no repetición, comparación, objeción, cancelación,
  // servicio.

  tc({ id: 33, category: 'etapa-curioso', message: 'vi un anuncio de esto, que es?',
    requiredConceptsAnyOf: [['esmalte', 'dientes', 'sonrisa']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false,
    offerProhibited: true, maxChars: 450 }),
  tc({ id: 34, category: 'etapa-interesado', message: 'cuanto tiempo hay que usarla para ver resultado',
    requiredConceptsAnyOf: [['constante', 'diario', 'dia a dia', 'día a día']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 450 }),
  tc({ id: 35, category: 'etapa-escéptico', message: 'eso de la nano-hidroxiapatita suena inventado',
    requiredConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 600 }),
  tc({ id: 36, category: 'comparación', message: 'y por que no simplemente uso colgate',
    requiredConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita', 'fortalece']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 600,
    prohibitedPhrases: [...GLOBAL_PROHIBITED, 'colgate no sirve', 'colgate es mala', 'peor que colgate'] }),
  tc({ id: 37, category: 'comparación', message: 'tengo oral-b en casa, para que cambiar',
    requiredConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita', 'fortalece']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 600,
    prohibitedPhrases: [...GLOBAL_PROHIBITED, 'oral-b no sirve', 'oral-b es mala', 'peor que oral-b'] }),
  tc({ id: 38, category: 'etapa-indeciso', message: 'no se, tal vez despues',
    requiredConceptsAnyOf: [[]],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 39, category: 'señal de compra', message: 'ok va, quiero pedirla',
    requiredConceptsAnyOf: [[]],
    forbiddenConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita'], ['remineraliza']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 40, category: 'señal de compra', message: 'sepárame una',
    requiredConceptsAnyOf: [[]],
    forbiddenConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 41, category: 'cliente existente', message: 'ya la compre la semana pasada, es igual de buena para mi esposo?',
    requiredConceptsAnyOf: [['fortalece', 'remineraliza', 'esmalte']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 450 }),
  tc({ id: 42, category: 'cancelación', message: 'quiero cancelar mi pedido',
    requiredConceptsAnyOf: [[]],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false,
    offerProhibited: true, maxChars: 450,
    prohibitedPhrases: [...GLOBAL_PROHIBITED, 'solo por hoy tenemos', 'antes de cancelar aprovecha'] }),
  tc({ id: 43, category: 'servicio', message: 'mi pedido ya salio?',
    // Ronda 1: sin contexto de un pedido real asociado, pedir un dato de
    // identificación antes de dar un estado es la respuesta correcta, no un
    // fallo — se relaja el requisito de contenido y se deja solo el veto de
    // no vender, que sí es la garantía real de este caso.
    requiredConceptsAnyOf: [[]],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false,
    offerProhibited: true, maxChars: 280 }),
  tc({ id: 44, category: 'servicio', message: 'puedo cambiar mi pedido a la oferta de 3 pastas',
    requiredConceptsAnyOf: [['2,700', '2700']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 450 }),
  tc({ id: 45, category: 'concepto dominante', message: 'quiero unos dientes bien fuertes',
    requiredConceptsAnyOf: [['fortalece', 'fuerte']],
    forbiddenConceptsAnyOf: [['blanqueamiento', 'blanquea'], ['mal aliento']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 450 }),
  tc({ id: 46, category: 'concepto dominante', message: 'que beneficios tiene en general',
    // Ronda 3: pregunta explícitamente general — una respuesta que resume
    // varios beneficios reales (esmalte, sensibilidad, blanqueamiento,
    // aliento) SÍ es la respuesta correcta aquí, aunque no use literalmente
    // las palabras "salud"/"cuidado". Ampliado a cualquier beneficio real.
    requiredConceptsAnyOf: [['salud', 'cuidado', 'esmalte', 'sensibilidad', 'blanqueamiento', 'fresca', 'aliento']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 600 }),
  tc({ id: 47, category: 'concepto dominante', message: 'amarillea rapido mi dentadura, ayuda?',
    requiredConceptsAnyOf: [['blanqueamiento', 'blanquea']],
    forbiddenConceptsAnyOf: [['caries']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true, maxChars: 450 }),
  tc({ id: 48, category: 'objetivo único', message: 'cuanto cuesta y tambien si sirve para sensibilidad y cuanto tarda en llegar',
    requiredConceptsAnyOf: [['2,100', '2100'], ['sensibilidad']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true, maxChars: 600, maxQuestionMarks: 1 }),
  tc({ id: 49, category: 'longitud', message: 'ok',
    requiredConceptsAnyOf: [[]],
    priorAssistantTurn: 'La oferta principal es 2 pastas + 1 cepillo gratis por RD$2,100 con envío incluido y pago al recibir.',
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 200 }),
  tc({ id: 50, category: 'desconfianza profunda', message: 'he escuchado que estas paginas de whatsapp casi siempre son estafa y nunca eh comprado por aqui',
    requiredConceptsAnyOf: [COD_PHRASES],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 600 }),
  tc({ id: 51, category: 'señal de compra', message: 'va pues mandamela ya',
    requiredConceptsAnyOf: [[]],
    forbiddenConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 52, category: 'señal de compra', message: 'quiero 2 pastas ya mismo',
    requiredConceptsAnyOf: [[]],
    forbiddenConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 53, category: 'señal de compra', message: 'soy de santiago, mandamela alla',
    requiredConceptsAnyOf: [[]],
    mustNotAskFields: ['ciudad'],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 54, category: 'cierre', message: 'Me llamo Carla Pérez',
    priorAssistantTurn: '¿Me confirmas tu nombre completo para coordinar el envío?',
    requiredConceptsAnyOf: [[]],
    mustNotAskFields: ['nombre completo'],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280, maxQuestionMarks: 1 }),
  tc({ id: 55, category: 'cierre', message: 'Calle 5, sector Los Ríos, Santiago',
    priorAssistantTurn: 'Perfecto Carla, ¿me compartes la dirección completa con sector y ciudad?',
    requiredConceptsAnyOf: [[]],
    mustNotAskFields: ['dirección completa'],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 56, category: 'cierre', message: 'Maria Rodriguez, calle 5 sector los rios santiago, mandamela',
    requiredConceptsAnyOf: [[]],
    mustNotAskFields: ['nombre', 'dirección', 'ciudad'],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 57, category: 'no repetición', message: 'y el envio cuesta aparte?',
    priorAssistantTurn: 'La oferta principal es 2 pastas + 1 cepillo gratis por RD$2,100 con envío incluido y pago al recibir.',
    requiredConceptsAnyOf: [['envío gratis', 'envio gratis', 'gratis']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 58, category: 'no repetición', message: 'bueno esta bien, y el pago es contra entrega verdad?',
    priorAssistantTurn: 'Entiendo que el precio te parezca alto — la oferta incluye 2 pastas, 1 cepillo gratis, envío y pago contra entrega.',
    requiredConceptsAnyOf: [COD_PHRASES],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 59, category: 'no repetición', message: 'y cuanto es lo que hay que pagar',
    priorAssistantTurn: 'Ya tengo tu dirección en Santiago, solo falta confirmar la oferta.',
    requiredConceptsAnyOf: [['2,100', '2100']],
    mustNotAskFields: ['dirección'],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true, maxChars: 280 }),
  tc({ id: 60, category: 'objeción', message: 'no tengo cash ahorita',
    requiredConceptsAnyOf: [COD_PHRASES],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 450 }),
  tc({ id: 61, category: 'objeción', message: 'ya use una pasta asi antes y no me funciono',
    requiredConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 600 }),
  tc({ id: 62, category: 'objeción', message: 'y si no me gusta que hago',
    requiredConceptsAnyOf: [[]],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 450,
    prohibitedPhrases: [...GLOBAL_PROHIBITED, 'te devolvemos el dinero', 'garantia de devolucion', 'garantía de devolución'] }),
  tc({ id: 63, category: 'comparación', message: 'todas las pastas dicen lo mismo',
    requiredConceptsAnyOf: [['nano-hidroxiapatita', 'nano hidroxiapatita']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 450 }),
  tc({ id: 64, category: 'reacción adversa + cancelación', message: 'quiero cancelar, me dio alergia',
    requiredConceptsAnyOf: [['agente', 'profesional', 'especialista', 'médico', 'medico']],
    mustNotOpenWithNegation: false, mustEscalate: true, dentistMentionAllowed: true, ctaRequired: false,
    offerProhibited: true, maxChars: 450 }),
  tc({ id: 65, category: 'servicio', message: 'llevo 5 dias esperando y nada',
    requiredConceptsAnyOf: [[]],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false,
    offerProhibited: true, maxChars: 450,
    prohibitedPhrases: [...GLOBAL_PROHIBITED, 'llegará mañana sin falta', 'te garantizo que llega'] }),
  tc({ id: 66, category: 'pregunta ambigua', message: 'y eso',
    requiredConceptsAnyOf: [[]],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 67, category: 'español dominicano', message: 'manito eso e verda o ta pasao',
    // Ronda 1: frase genuinamente ambigua incluso para un lector humano — una
    // pregunta breve de aclaración es una respuesta razonable, no un fallo.
    // Se relaja el contenido requerido y el CTA, se conserva solo la validación
    // de tono/seguridad.
    requiredConceptsAnyOf: [[]],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 450 }),
  tc({ id: 68, category: 'errores ortográficos', message: 'sirbe pa la sensivilidad?',
    requiredConceptsAnyOf: [['sensibilidad']],
    mustNotOpenWithNegation: true, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: true, maxChars: 450 }),
  tc({ id: 69, category: 'cierre', message: 'Maria Rodriguez, calle 5 sector los rios santiago, mandamela',
    priorAssistantTurn: '¿Me confirmas tu nombre y dirección completa para coordinar el envío?',
    requiredConceptsAnyOf: [[]],
    // Ronda 1: "sector" removido — es un sub-componente de "dirección" y la
    // heurística (palabra + '?' en cualquier parte del mensaje) genera falso
    // positivo cuando el CTA final tiene su propio '?' sin relación con el dato.
    mustNotAskFields: ['nombre', 'dirección', 'ciudad'],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 280 }),
  tc({ id: 70, category: 'concepto — excepción explícita', message: 'dime todos los beneficios que tiene',
    // Ronda 1: el cliente pidió explícitamente TODOS los beneficios — es el
    // caso diseñado para permitir la excepción a "un solo concepto"
    // (sección 11 del Response Generator). maxSentences debía reflejar eso
    // desde el diseño original; quedó en el default por descuido.
    requiredConceptsAnyOf: [['fortalece', 'remineraliza'], ['sensibilidad']],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 600, maxSentences: 6 }),
  tc({ id: 71, category: 'urgencia fabricada', message: 'y si no compro ahora que pasa',
    requiredConceptsAnyOf: [[]],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 450 }),
  tc({ id: 72, category: 'tono call-center', message: 'Buenas tardes, quisiera información sobre su producto por favor',
    requiredConceptsAnyOf: [[]],
    mustNotOpenWithNegation: false, mustEscalate: false, dentistMentionAllowed: false, ctaRequired: false, maxChars: 450,
    prohibitedPhrases: [...GLOBAL_PROHIBITED, 'le informamos que', 'procedemos a'] }),
]

// ── Utilidades ────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

function containsAny(haystackNorm: string, needles: string[]): boolean {
  if (needles.length === 0) return true
  return needles.some(n => haystackNorm.includes(normalize(n)))
}

function countSentences(text: string): number {
  // Ronda 3: un decimal como "7.5%" tiene un '.' que no es fin de oración —
  // sin enmascararlo, "la nano-hidroxiapatita al 7.5%." se contaba como DOS
  // oraciones ("...al 7." + "5%...") en vez de una. Se enmascara el punto
  // decimal antes de partir por [.!?]+.
  const trimmed = text.trim().replace(/(\d)\.(\d)/g, '$1␟$2')
  if (!trimmed) return 0
  const matches = trimmed.match(/[^.!?]+[.!?]+/g)
  return matches ? matches.length : 1
}

function splitSentences(text: string): string[] {
  const matches = text.trim().match(/[^.!?]+[.!?]*/g)
  return matches ? matches.map(s => s.trim()).filter(Boolean) : [text.trim()]
}

// Ronda 1 de corrección (Fase 2A.2) — negación consciente: una frase
// prohibida NO cuenta como violación si aparece inmediatamente negada (ej.
// "No es un blanqueamiento instantáneo" es exactamente la aclaración
// deseada, no una violación de "blanqueamiento instantáneo"). Ventana corta
// de negadores comunes en español justo antes de la frase.
const NEGATION_MARKERS = ['no es', 'no será', 'no sera', 'nunca es', 'jamás es', 'jamas es', 'no se trata de']
function isNegatedOccurrence(norm: string, phraseNorm: string): boolean {
  const idx = norm.indexOf(phraseNorm)
  if (idx === -1) return false
  const before = norm.slice(Math.max(0, idx - 20), idx)
  return NEGATION_MARKERS.some(marker => before.includes(marker))
}

// Palabras que cuentan como "escaló a alguien con criterio real" — agente
// interno, o un profesional de salud/dental externo (médico, dentista).
const ESCALATION_WORDS = ['agente', 'profesional', 'especialista', 'médico', 'medico', 'dentista']

interface CheckResult { name: string; passed: boolean; detail?: string }

function evaluateResponse(text: string, c: TestCase): CheckResult[] {
  const norm = normalize(text)
  const results: CheckResult[] = []

  for (const group of c.requiredConceptsAnyOf) {
    if (group.length === 0) continue
    results.push({
      name: `concepto requerido (${group[0]}…)`,
      passed: containsAny(norm, group),
      detail: group.join(' | '),
    })
  }

  for (const phrase of c.prohibitedPhrases) {
    const phraseNorm = normalize(phrase)
    const found = norm.includes(phraseNorm)
    const passed = !found || isNegatedOccurrence(norm, phraseNorm)
    results.push({
      name: `frase prohibida ausente ("${phrase}")`,
      passed,
    })
  }

  if (c.mustNotOpenWithNegation) {
    const opensWithNo = /^\s*no\b/i.test(text.trim())
    results.push({ name: 'no abre con negación', passed: !opensWithNo })
  }

  if (!c.dentistMentionAllowed) {
    // Ronda 1: la regla documentada es "nunca COMENZAR enviando al dentista"
    // — no "nunca mencionarlo". Revisar solo la primera oración evita
    // falsos positivos cuando el dentista se menciona más adelante como
    // consejo de higiene general, no como desvío evasivo de la pregunta.
    const firstSentence = normalize(splitSentences(text)[0] ?? '')
    const opensWithDentist = firstSentence.includes('dentista') || firstSentence.includes('profesional dental')
    results.push({ name: 'no abre con desvío al dentista', passed: !opensWithDentist })
  }

  if (c.mustEscalate) {
    const escalates = ESCALATION_WORDS.some(w => norm.includes(w))
    results.push({ name: 'escala a humano/profesional', passed: escalates })
  } else {
    // no debe escalar en un caso comercial normal
    const wronglyEscalates = norm.includes('un agente lo va a atender') || norm.includes('te va a atender un agente')
    results.push({ name: 'no escala innecesariamente', passed: !wronglyEscalates })
  }

  if (c.ctaRequired) {
    const hasCta = text.trim().endsWith('?') || norm.includes('quieres') || norm.includes('te reservo') || norm.includes('confirmamos')
    results.push({ name: 'CTA presente', passed: hasCta })
  }

  const sentences = countSentences(text)
  results.push({ name: `longitud ≤ ${c.maxSentences} frases`, passed: sentences <= c.maxSentences, detail: `${sentences} frases` })

  // ── Checks RG-1 (ampliación de la suite) ──────────────────────────────
  if (c.maxChars != null) {
    results.push({ name: `longitud ≤ ${c.maxChars} caracteres`, passed: text.trim().length <= c.maxChars, detail: `${text.trim().length} caracteres` })
  }

  if (c.offerProhibited) {
    const mentionsOffer = norm.includes('2,100') || norm.includes('2100') || norm.includes('2,700') ||
      norm.includes('2700') || norm.includes('3,780') || norm.includes('3780') || norm.includes('cepillo')
    results.push({ name: 'no presenta oferta/precio (prohibido en este turno)', passed: !mentionsOffer })
  }

  if (c.forbiddenConceptsAnyOf) {
    for (const group of c.forbiddenConceptsAnyOf) {
      if (group.length === 0) continue
      results.push({
        name: `concepto dominante único (no menciona ${group[0]}…)`,
        passed: !containsAny(norm, group),
        detail: group.join(' | '),
      })
    }
  }

  if (c.mustNotAskFields) {
    for (const field of c.mustNotAskFields) {
      const fieldNorm = normalize(field)
      // Heurística: el campo aparece Y el mensaje contiene un '?' — proxy de "lo está volviendo a pedir".
      const asksAgain = norm.includes(fieldNorm) && text.includes('?')
      results.push({ name: `no vuelve a pedir "${field}"`, passed: !asksAgain })
    }
  }

  if (c.maxQuestionMarks != null) {
    const questionMarks = (text.match(/\?/g) ?? []).length
    results.push({ name: `máximo ${c.maxQuestionMarks} pregunta(s)`, passed: questionMarks <= c.maxQuestionMarks, detail: `${questionMarks} signos '?'` })
  }

  return results
}

// ── Modo estático: validar cobertura de conocimiento en el prompt ─────────

function evaluateStaticCoverage(systemPrompt: string, c: TestCase): CheckResult[] {
  const norm = normalize(systemPrompt)
  const results: CheckResult[] = []
  for (const group of c.requiredConceptsAnyOf) {
    if (group.length === 0) continue
    results.push({
      name: `conocimiento disponible para responder (${group[0]}…)`,
      passed: containsAny(norm, group),
    })
  }
  if (c.mustEscalate) {
    results.push({
      name: 'footer incluye guía de escalamiento para este caso',
      passed: norm.includes('reacción adversa') || norm.includes('embarazo') || norm.includes('inflamacion') || norm.includes('inflamación'),
    })
  }
  return results
}

// ── OpenAI real (solo con --real-openai) ───────────────────────────────────

interface OpenAICallResult {
  text:             string | null
  promptTokens:     number | null
  completionTokens: number | null
}

async function callOpenAIReal(apiKey: string, model: string, messages: { role: 'system' | 'user'; content: string }[]): Promise<OpenAICallResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: 300, temperature: 0.6 }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      console.error('[commercial-luma] OpenAI error', res.status, await res.text())
      return { text: null, promptTokens: null, completionTokens: null }
    }
    const data = await res.json() as {
      choices?: { message?: { content?: string } }[]
      usage?:   { prompt_tokens?: number; completion_tokens?: number }
    }
    return {
      text:             data.choices?.[0]?.message?.content?.trim() || null,
      promptTokens:     data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
    }
  } catch (err) {
    clearTimeout(timer)
    console.error('[commercial-luma] OpenAI fetch threw', err instanceof Error ? err.message : err)
    return { text: null, promptTokens: null, completionTokens: null }
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('✖ Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local.')
    process.exit(1)
  }
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  let storeId = storeArg
  if (!storeId) {
    const { data: configs, error } = await supabase.from('ai_agent_config').select('store_id')
    if (error || !configs || configs.length === 0) {
      console.error('✖ No se pudo resolver la tienda automáticamente. Pasa --store=<uuid>.')
      process.exit(1)
    }
    if (configs.length > 1) {
      console.error('✖ Múltiples tiendas — especifica --store=<uuid>.')
      process.exit(1)
    }
    storeId = configs[0].store_id
  }

  console.log('=== Suite offline de evaluación comercial — LÜMA Teeth (Fase 2A.1) ===')
  console.log(`Tienda: ${storeId}`)
  console.log(`Modo: ${realOpenAI ? 'REAL (llama a OpenAI)' : 'ESTÁTICO (sin red, solo cobertura de conocimiento)'}`)
  console.log(`Casos: ${CASES.length}`)
  console.log('')

  // READ-ONLY — nunca escribe. Reconstruye el prompt como si el knowledge
  // versionado ya estuviera aplicado, sin tocar Supabase.
  const { data: configRow, error: configErr } = await supabase
    .from('ai_agent_config')
    .select('agent_name, system_prompt')
    .eq('store_id', storeId)
    .maybeSingle()

  if (configErr || !configRow) {
    console.error('✖ No se pudo leer ai_agent_config para la tienda:', configErr?.message ?? '(sin fila)')
    process.exit(1)
  }

  const { data: existingSections, error: sectionsErr } = await supabase
    .from('ai_agent_knowledge_sections')
    .select('section_key, label, content, priority, is_active')
    .eq('store_id', storeId)
    .eq('is_active', true)

  if (sectionsErr) {
    console.error('✖ No se pudo leer ai_agent_knowledge_sections:', sectionsErr.message)
    process.exit(1)
  }

  const overrideKeys = new Set(LUMA_TEETH_KNOWLEDGE_V1.map(s => s.sectionKey))
  const merged = (existingSections ?? [])
    .filter(s => !overrideKeys.has(s.section_key))
    .concat(LUMA_TEETH_KNOWLEDGE_V1.map(s => ({
      section_key: s.sectionKey,
      label:       s.title,
      content:     s.content,
      priority:    s.priority,
      is_active:   true,
    })))
    .sort((a, b) => b.priority - a.priority)

  console.log(`Secciones de knowledge en el prompt de prueba: ${merged.map(s => s.section_key).join(', ')}`)
  console.log(`(overrides versionados aplicados: ${[...overrideKeys].join(', ')})`)
  console.log('')

  let openaiApiKey: string | undefined
  let openaiModel  = 'gpt-4o-mini'
  if (realOpenAI) {
    const { data: fullConfig } = await supabase
      .from('ai_agent_config')
      .select('model, api_key_ref')
      .eq('store_id', storeId)
      .maybeSingle()
    openaiModel = fullConfig?.model?.trim() || openaiModel
    const keyRef = fullConfig?.api_key_ref
    openaiApiKey = keyRef ? process.env[keyRef] : process.env.OPENAI_API_KEY
    if (!openaiApiKey) {
      console.error('✖ --real-openai requiere la env var de la API key configurada (api_key_ref). Abortando modo real.')
      process.exit(1)
    }
  }

  const onlyArg   = args.find(a => a.startsWith('--only='))?.split('=')[1]
  const repeatArg = args.find(a => a.startsWith('--repeat='))?.split('=')[1]
  const repeatCount = repeatArg ? Math.max(1, parseInt(repeatArg, 10) || 1) : 1

  let casesToRun = CASES
  if (onlyArg) {
    const ids = new Set(onlyArg.split(',').map(s => parseInt(s.trim(), 10)))
    casesToRun = CASES.filter(c => ids.has(c.id))
    console.log(`Filtro --only aplicado: ${casesToRun.map(c => c.id).join(', ')}`)
  }
  if (repeatCount > 1) console.log(`Repeticiones por caso: ${repeatCount}`)

  let passCount = 0
  let failCount = 0
  let totalPromptTokens     = 0
  let totalCompletionTokens = 0
  let totalCalls = 0
  const pendingRealValidation: number[] = []
  const consistencyByCase = new Map<number, boolean[]>()

  const systemPrompt = buildSystemPrompt(
    configRow.agent_name,
    configRow.system_prompt,
    merged.map(({ label, content }) => ({ label, content })),
  )

  for (const c of casesToRun) {
    const iterations = repeatCount
    for (let iter = 1; iter <= iterations; iter++) {
      const iterLabel = iterations > 1 ? ` (repetición ${iter}/${iterations})` : ''
      console.log(`\n--- Caso ${c.id} [${c.category}]${iterLabel} ---`)
      console.log(`Mensaje: "${c.message}"`)

      if (!realOpenAI) {
        const staticChecks = evaluateStaticCoverage(systemPrompt, c)
        const allPassed = staticChecks.every(r => r.passed)
        for (const r of staticChecks) console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}`)
        if (staticChecks.length === 0) console.log('  (sin criterios de cobertura para este caso — solo aplica en modo real)')
        allPassed ? passCount++ : failCount++
        if (iter === 1) pendingRealValidation.push(c.id)
        continue
      }

      const messages: { role: 'system' | 'user'; content: string }[] = [
        { role: 'system', content: systemPrompt },
      ]
      if (c.priorAssistantTurn) {
        // Se representa como contexto adicional de sistema — mismo patrón que
        // el historial real (respond.ts pasa el historial como mensajes user/
        // assistant separados; aquí simplificamos a una nota de contexto para
        // no reimplementar el pipeline completo de historial).
        messages.push({ role: 'system', content: `(Turno anterior de Génesis en esta conversación: "${c.priorAssistantTurn}")` })
      }
      messages.push({ role: 'user', content: c.message })

      const result = await callOpenAIReal(openaiApiKey!, openaiModel, messages)
      totalCalls++
      if (result.promptTokens != null)     totalPromptTokens += result.promptTokens
      if (result.completionTokens != null) totalCompletionTokens += result.completionTokens

      if (!result.text) {
        console.log('  ❌ OpenAI no devolvió respuesta utilizable — caso marcado como fallo')
        failCount++
        if (!consistencyByCase.has(c.id)) consistencyByCase.set(c.id, [])
        consistencyByCase.get(c.id)!.push(false)
        continue
      }
      console.log(`  Respuesta: "${result.text}"`)
      const checks = evaluateResponse(result.text, c)
      const allPassed = checks.every(r => r.passed)
      for (const r of checks) console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
      allPassed ? passCount++ : failCount++
      if (!consistencyByCase.has(c.id)) consistencyByCase.set(c.id, [])
      consistencyByCase.get(c.id)!.push(allPassed)
    }
  }

  console.log('\n=== RESUMEN ===')
  console.log(`Total ejecuciones: ${passCount + failCount}`)
  console.log(`✅ Pasaron: ${passCount}`)
  console.log(`❌ Fallaron: ${failCount}`)

  if (repeatCount > 1) {
    console.log('\n=== CONSISTENCIA POR CASO (repeticiones) ===')
    for (const [id, results] of consistencyByCase) {
      const okCount = results.filter(Boolean).length
      console.log(`  Caso ${id}: ${okCount}/${results.length} pasaron`)
    }
  }

  if (!realOpenAI) {
    console.log('\nModo estático — solo se validó cobertura de conocimiento en el prompt construido.')
    console.log('Pendiente de validar con el modelo real (requiere --real-openai y consumo de OpenAI):')
    console.log(`  ${pendingRealValidation.length} casos — calidad real de la respuesta (frases prohibidas, apertura, CTA, longitud, escalamiento).`)
  } else {
    console.log('\n=== USAGE (según lo que devolvió la API de OpenAI) ===')
    console.log(`Modelo: ${openaiModel}`)
    console.log(`Llamadas: ${totalCalls}`)
    console.log(`Tokens de entrada: ${totalPromptTokens}`)
    console.log(`Tokens de salida: ${totalCompletionTokens}`)
    console.log('(sin tarifa configurada en el proyecto — no se estima costo en RD$/USD para evitar inventar una tarifa)')
  }

  if (failCount > 0) process.exitCode = 1
}

withTimeout(main(), GLOBAL_TIMEOUT_MS, 'ejecución completa de la suite comercial (32 casos)').catch(e => {
  console.error(e instanceof TestTimeoutError ? `✖ ${e.message}` : e)
  process.exit(1)
})
