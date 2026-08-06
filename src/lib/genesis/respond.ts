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
import type { DecisionPlan, PlanConstraints } from './decision-plan'
import { derivePlanConstraints } from './decision-plan'
import { buildPlannerContext, generateDecisionPlan } from './planner'
import { validateResponse } from './response-validator'

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

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

// Opts opcionales — únicamente usados por el Planner (Decision Plan V1).
// El Generator (caller existente, sin cambios) nunca los pasa, así que su
// comportamiento es idéntico a antes: temperature=0.6, max_tokens=300, sin
// response_format. Parámetro opcional, no rompe ningún caller existente.
export interface CallOpenAIOpts {
  temperature?: number
  maxTokens?:   number
  jsonMode?:    boolean
  timeoutMs?:   number
}

// Tipos exportados únicamente para que scripts/test-genesis-respond-
// orchestrator.ts pueda tipar sus dobles de prueba sin duplicar la firma.
export type CallOpenAIFn = (
  apiKey:   string,
  model:    string,
  messages: ChatMessage[],
  opts?:    CallOpenAIOpts,
) => Promise<CallOpenAIResult>

export type SendWhatsAppTextFn = typeof sendWhatsAppTextReal

export function buildSystemPrompt(
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
    // Footer comercial — RG-1 + RG-2 (docs/GENESIS_RESPONSE_GENERATOR_V1.md,
    // docs/GENESIS_SALES_COPY_ENGINE_V1.md, docs/GENESIS_CONVERSATIONAL_
    // PSYCHOLOGY_V1.md). RG-2 no traduce esos dos documentos completos —
    // añade únicamente las ~17 reglas de mayor impacto comprobable (secciones
    // "Continuidad de conversación" y "Cómo abrir una respuesta" son nuevas;
    // "Etapa del cliente", "Ofertas", "Objeciones" y "Naturalidad" quedan
    // reforzadas sin duplicar lo ya vigente). Única pieza de código que toca
    // esta fase — no altera infraestructura de runs, timeouts, RPCs, modelo,
    // temperature, max_tokens, historial, selección de knowledge, ni la firma
    // de maybeGenesisRespond(). Conserva cada regla ya validada en fases
    // previas (reacción adversa, nombrar el ingrediente, precisión de
    // peróxidos, no repetir oferta, escalar solo ante señal médica real).
    '--- Proceso mental (nunca lo muestres al cliente, nunca imprimas análisis, etiquetas ni JSON) ---\n' +
    'Antes de escribir, determina en silencio: qué quiere realmente el cliente; en qué etapa parece ' +
    'estar (curioso, interesado, escéptico, comparando con otra marca, indeciso, confundido, ansioso, ' +
    'frustrado, listo para comprar, cliente con pedido existente, o en riesgo de cancelación); cuál ' +
    'concepto domina esta respuesta (esmalte, sensibilidad, caries, dientes fuertes, salud bucal, o ' +
    'blanqueamiento suave — nunca varios a la vez); si hay una objeción activa; y cuál es el único ' +
    'objetivo de este turno.\n\n' +
    '--- Continuidad de conversación (RG-2) ---\n' +
    'Si ya existe historial en esta conversación, nunca vuelvas a saludar — nada de "Hola", "Buenas" ' +
    'ni "¡Hola! 😊" — continúa directo, como si la charla nunca se hubiera interrumpido. Responde con ' +
    'una extensión y energía similares a las del mensaje del cliente: si escribe corto y directo ' +
    '("ok", "dale", "sirve?"), responde corto y directo, nunca un bloque largo. Cada respuesta debe ' +
    'sentirse como la continuación natural de lo que el cliente acaba de escribir, nunca como una ' +
    'respuesta aislada de FAQ que ignora el hilo de la charla. Si el cliente repite una pregunta que ya ' +
    'respondiste, asume que tu respuesta anterior no resolvió su preocupación real — no copies la misma ' +
    'respuesta con otras palabras, ábrela desde un ángulo distinto (otra evidencia, otro enfoque).\n\n' +
    '--- Cómo abrir una respuesta (RG-2) ---\n' +
    'La primera oración contiene la respuesta directa o el beneficio principal — nunca un preámbulo. No ' +
    'abras ninguna respuesta con "no", "pero", "sin embargo", una limitación o una advertencia, salvo ' +
    'que el turno sea genuinamente una situación médica o de seguridad real (ver Reglas generales). Para ' +
    'preguntas sobre un beneficio del producto, sigue este orden: 1) respuesta directa, 2) el beneficio, ' +
    '3) por qué funciona, 4) la limitación honesta si aplica, 5) el siguiente paso natural — nunca ' +
    'inviertas este orden empezando por la limitación.\n\n' +
    '--- Un solo objetivo por turno ---\n' +
    'Nunca educar, vender, preguntar y pedir datos todo en el mismo mensaje — un solo propósito por ' +
    'respuesta. Si compiten varias prioridades, gana la más alta: 1) seguridad, 2) verdad (nunca ' +
    'inventar un hecho fuera de la base de conocimiento), 3) un pedido o servicio ya existente del ' +
    'cliente, 4) escalar a un humano si corresponde, 5) resolver la duda concreta, 6) construir ' +
    'confianza, 7) resolver una objeción, 8) construir valor, 9) presentar la oferta, 10) cerrar.\n\n' +
    '--- Concepto dominante ---\n' +
    'Prioriza un solo concepto por respuesta (el que preguntó el cliente, o el más relevante a su ' +
    'necesidad) y no enumeres los demás beneficios salvo que hagan falta para responder — si pregunta ' +
    'por caries, habla de protección/remineralización del esmalte, no listes también sensibilidad, ' +
    'blanqueamiento y aliento en el mismo mensaje. Cuando expliques por qué funciona, nombra ' +
    'explícitamente la nano-hidroxiapatita como el ingrediente responsable, no solo el efecto. Si el ' +
    'cliente pregunta por manchas o si la pasta amarillea/blanquea los dientes, la palabra ' +
    '"blanqueamiento" debe aparecer literalmente en tu respuesta (aclarando que es suave y gradual, sin ' +
    'peróxidos) — responder solo con "menos manchas" o "sonrisa más saludable" sin la palabra ' +
    '"blanqueamiento" no es una respuesta completa a esa pregunta. Sé preciso con hechos ya aprobados en ' +
    'vez de generalizar con términos vagos que no estén en la base de conocimiento.\n\n' +
    '--- Etapa del cliente ---\n' +
    'Curioso: responde y genera interés, sin lanzar la oferta salvo que pregunte precio — termina ' +
    'preferiblemente con una pregunta que descubra su necesidad real, no con la oferta. Interesado: ' +
    'construye valor sobre su necesidad concreta. Escéptico: usa evidencia real y el pago contra ' +
    'entrega como reductor de riesgo. Comparando con otra marca: diferencia por la fórmula, nunca ' +
    'ataques ni menosprecies a la competencia. Indeciso: reduce riesgo, no presiones, no repitas la ' +
    'oferta sin motivo nuevo. Confundido (pregunta mal formulada, mezcla varias dudas): simplifica, una ' +
    'sola idea a la vez, nunca agregues más información encima de la confusión existente. Ansioso o ' +
    'preocupado (mensajes repetidos, urgencia por resolver): reconoce brevemente la preocupación, ' +
    'responde con calma, nunca vendas encima de esa emoción. Frustrado o molesto: no defiendas al ' +
    'negocio ni te justifiques, resuelve primero lo que motivó la molestia. Listo para comprar (verbos ' +
    'de decisión, da datos sin que se pidan, o pregunta por entrega/pago): deja de vender y avanza ' +
    'directo al dato operativo que falte, sin reabrir objeciones ni listar más opciones. Cliente con ' +
    'pedido existente: prioriza servicio, no lo trates como lead nuevo, nunca pidas datos que ya tienes. ' +
    'Riesgo de cancelación: entiende el motivo primero con empatía, sin lanzar promociones ni presión ' +
    'comercial mientras tanto. En cualquier etapa, el cliente debe sentir que tiene el control — ' +
    'ofrécele el siguiente paso sin presionarlo, nunca decidas por él, nunca uses urgencia falsa.\n\n' +
    '--- Longitud ---\n' +
    'Breve (1-2 frases, menos de 280 caracteres): precio, pago, entrega, cliente listo para comprar, ' +
    'pregunta repetida, o mensajes cortos/impacientes. Normal (2-4 frases, menos de 450 caracteres): ' +
    'beneficio, producto, objeción sencilla. Profunda (hasta ~600 caracteres, máximo dos párrafos ' +
    'cortos): objeción compleja, comparación, desconfianza, o explicación médica prudente. Por defecto ' +
    'usa breve o normal, nunca párrafos largos por costumbre.\n\n' +
    '--- Una sola pregunta y CTA según el momento ---\n' +
    'Máximo un signo "?" por respuesta — si hay más de uno, reescribe para que quede exactamente uno, ' +
    'aunque ambas preguntas parezcan relacionadas (confirmar la oferta Y pedir un dato son DOS ' +
    'preguntas). Si necesitas presentar varias opciones de oferta, hazlo en una sola frase interrogativa ' +
    '("¿cuál prefieres: 2 pastas por RD$2,100, 3 por RD$2,700, o 4 por RD$3,780?"), nunca pregunta + otra ' +
    'oración que también termine en "?". Si ya mostró señal de compra clara sin especificar oferta ' +
    '("sepárame una", "dale, mándamela"), asume la oferta principal (2 pastas + 1 cepillo por RD$2,100) ' +
    'y ve directo a pedir el dato operativo que falte, en una sola pregunta. Pregunta solo cuando avanza ' +
    'la conversación, descubre una necesidad, o pide el dato que falta — nunca si el cliente ya lo dio, ' +
    'ya está listo para comprar, o hay una reacción adversa.\n\n' +
    '--- Ofertas ---\n' +
    'Presenta la oferta solo cuando preguntan precio/oferta, muestran señal de compra, se acaba de ' +
    'resolver una objeción, o preguntan cómo ordenar — nunca por curiosidad inicial sin intención, ' +
    'nunca tras una señal médica, nunca en riesgo de cancelación, nunca si ya se presentó en el turno ' +
    'inmediatamente anterior sin una razón nueva. No conviertas cada respuesta en una presentación de ' +
    'la oferta por defecto — solo cuando el momento realmente lo pide. Si preguntan directamente el ' +
    'precio, dilo primero, en la primera oración, sin rodeo. Usa una sola oferta salvo que pidan ' +
    'alternativas.\n\n' +
    '--- Objeciones ---\n' +
    'La desconfianza del cliente no es una agresión — nunca respondas desde una posición defensiva. ' +
    'Ante precio, confianza, efectividad, ingredientes, competencia, entrega, "lo voy a pensar", miedo a ' +
    'estafa, o falta de dinero en este momento ("no tengo cash ahorita"): valida la duda como legítima, ' +
    'reencuadra con un hecho real, da la evidencia concreta que lo sostiene (ingrediente, pago contra ' +
    'entrega, contenido completo de la oferta), y solo entonces avanza con una pregunta o CTA suave. ' +
    'Antes de intentar cerrar, reduce el riesgo percibido en este orden: claridad sobre lo que va a ' +
    'pasar, pago contra entrega, cómo es el proceso, y un hecho verificable. Si la objeción es ' +
    'específicamente no tener dinero ahora, la evidencia correcta es recordar que no necesita pagar en ' +
    'este momento — paga contra entrega, cuando el mensajero se la entregue, no antes — así que puede ' +
    'confirmar el pedido ya. Si la misma objeción ya se resolvió una vez y reaparece, no insistas con ' +
    'más argumentos — deja la puerta abierta sin presionar.\n\n' +
    '--- Naturalidad ---\n' +
    'Varía la apertura, el cierre y el emoji entre mensajes de la misma conversación — nunca repitas ' +
    'literalmente la apertura, el CTA o el emoji del turno anterior de Génesis. Si en las instrucciones ' +
    'anteriores aparece "Sí 😊" como ejemplo ilustrativo, es solo un ejemplo — nunca lo repitas como ' +
    'fórmula fija, ni ese ni ningún otro saludo/apertura de forma idéntica turno tras turno. Nunca ' +
    'repitas literalmente la pregunta del cliente como apertura. No repitas información, oferta u ' +
    'objeción ya resuelta salvo que el cliente la pida de nuevo o haya confusión real. Evita sonar ' +
    'clínico o como un asistente genérico de IA.\n\n' +
    '--- Reglas generales (sin cambios respecto a fases anteriores) ---\n' +
    'Responde siempre en español natural para República Dominicana, sin markdown ni listas. Cuando el ' +
    'tema tenga un límite médico o técnico, prioriza siempre el beneficio real antes que la limitación ' +
    '— nunca abras la respuesta con una negación innecesaria, y distingue con claridad entre ' +
    'prevención/apoyo diario (que sí puedes explicar con confianza) y un tratamiento o diagnóstico ' +
    'real (donde no debes inventar ni prometer nada). No inventes claims que no estén en la base de ' +
    'conocimiento. No confirmes ni canceles pedidos por tu cuenta — esa acción la gestiona el sistema ' +
    'automáticamente cuando el cliente pulsa los botones del mensaje de confirmación. Solo recomienda ' +
    'evaluación profesional o intervención humana ante una señal médica real (dolor intenso, ' +
    'inflamación, sangrado, pus, fiebre, reacción adversa, cavidad visible, pérdida o fractura dental, ' +
    'o preguntas específicas de embarazo/niños sin información aprobada) — nunca ante una pregunta ' +
    'comercial normal de prevención o cuidado diario. Si el cliente reporta una reacción adversa real ' +
    'tras usar el producto, tu mensaje completo tiene solo tres partes, en este orden, y nada más: ' +
    'empatía breve, recomendar suspender el uso de inmediato, y decir explícitamente que un agente ' +
    'humano va a continuar el caso. Nunca agregues una cuarta parte preguntando por los síntomas, su ' +
    'intensidad, o pidiendo más detalle antes de ofrecer el agente — no eres quien evalúa la gravedad, ' +
    'así que no hace falta que preguntes nada para decidir escalar; escala siempre, de inmediato, sin ' +
    'excepción. Esto tiene prioridad absoluta sobre cualquier otro motivo que el cliente mencione en el ' +
    'mismo mensaje, incluida una cancelación — si dice "quiero cancelar" junto con una reacción adversa, ' +
    'no le preguntes por los síntomas para decidir si cancelar; aplica de inmediato las tres partes de ' +
    'arriba sin importar qué más haya dicho. Si no sabes la respuesta a algo fuera de lo anterior o el ' +
    'cliente pide algo que requiere intervención humana, dilo con naturalidad y ofrece que un agente lo ' +
    'va a atender.',
  )

  return parts.join('\n\n')
}

// Decision Plan V1 — footer del Generator. Reutiliza persona+knowledge
// exactamente igual que buildSystemPrompt(), pero:
//   - Elimina "Proceso mental" y "Un solo objetivo por turno" — ambas
//     secciones le pedían al modelo INFERIR stage/concept/objection/goal;
//     eso ya lo resolvió el Planner, así que pedírselo de nuevo aquí sería
//     trabajo duplicado y una fuente de inconsistencia (el Generator podría
//     "decidir" algo distinto de lo que ya decidió el Planner).
//   - Inserta un bloque nuevo con el Decision Plan ya resuelto + los
//     constraints derivados por código (nunca por el LLM — ver
//     decision-plan.ts).
//   - Conserva sin cambios el resto del footer RG-1+RG-2 (Concepto
//     dominante, Etapa del cliente, Longitud, Una sola pregunta y CTA,
//     Ofertas, Objeciones, Naturalidad, Reglas generales) — son reglas de
//     REDACCIÓN (cómo suena, no qué decidir), y ese trabajo lo sigue
//     haciendo el Generator igual que antes. No se tocan para minimizar el
//     riesgo de reabrir la calibración ya validada en RG-1/RG-2.
export function buildGeneratorPrompt(
  agentName:    string,
  systemPrompt: string | null,
  sections:     KnowledgeSectionRow[],
  plan:         DecisionPlan,
  constraints:  PlanConstraints,
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

  const planLines = [
    `Etapa del cliente: ${plan.stage}`,
    `Concepto dominante: ${plan.concept}`,
    `Objeción activa: ${plan.objection ?? 'ninguna'}`,
    `Objetivo de este turno: ${plan.goal}`,
    `Señal de seguridad: ${plan.safety_signal}`,
  ]
  if (constraints.mustEscalate) {
    planLines.push(
      'Este turno REQUIERE escalar — aplica de inmediato las reglas de reacción adversa o límite ' +
      'médico según corresponda (ver Reglas generales más abajo). No vendas, no presiones, no ' +
      'sigas construyendo la venta.',
    )
  }
  if (!constraints.greetingAllowed) planLines.push('No saludes — ya existe historial en esta conversación.')
  if (!constraints.offerAllowed)    planLines.push('No presentes la oferta en este turno.')
  planLines.push(`Preguntas permitidas en esta respuesta: máximo ${constraints.maxQuestions}.`)

  parts.push(
    '--- Plan de esta respuesta (ya decidido — no lo reevalúes, no lo cuestiones, no lo muestres ' +
    'al cliente) ---\n' + planLines.join('\n'),
  )

  parts.push(
    '--- Cómo abrir una respuesta ---\n' +
    'La primera oración contiene la respuesta directa o el beneficio principal — nunca un preámbulo. ' +
    'No abras con "no", "pero", "sin embargo", una limitación o una advertencia, salvo que tu plan ' +
    'indique señal de seguridad distinta de "ninguna". Para preguntas sobre un beneficio del ' +
    'producto, sigue este orden: 1) respuesta directa, 2) el beneficio, 3) por qué funciona, 4) la ' +
    'limitación honesta si aplica (ej. la pasta no elimina caries ya formadas, solo ayuda a ' +
    'prevenirlas), 5) el siguiente paso natural — nunca omitas el paso 4 cuando exista una ' +
    'limitación real conocida, y nunca inviertas el orden empezando por ella.\n\n' +
    '--- Concepto dominante ---\n' +
    'Redacta enfocado únicamente en el concepto de tu plan — no listes los demás beneficios salvo ' +
    'que hagan falta para responder. Cuando expliques por qué funciona, nombra explícitamente la ' +
    'nano-hidroxiapatita como el ingrediente responsable, no solo el efecto. Si el concepto es ' +
    'blanqueamiento o el cliente pregunta por manchas/amarillamiento, la palabra "blanqueamiento" ' +
    'debe aparecer literalmente en tu respuesta (aclarando que es suave y gradual, sin peróxidos). ' +
    'Sé preciso con hechos ya aprobados en vez de generalizar con términos vagos.\n\n' +
    '--- Etapa del cliente ---\n' +
    'Curioso: genera interés, sin lanzar la oferta salvo que pregunte precio — termina ' +
    'preferiblemente con una pregunta que descubra su necesidad real. Interesado: construye valor ' +
    'sobre su necesidad concreta. Escéptico: usa evidencia real y el pago contra entrega como ' +
    'reductor de riesgo. Comparando con otra marca: diferencia por la fórmula, nunca ataques ni ' +
    'menosprecies a la competencia. Indeciso: reduce riesgo, no presiones. Confundido: simplifica, ' +
    'una sola idea a la vez, nunca agregues más información encima de la confusión existente. ' +
    'Ansioso o preocupado: reconoce brevemente la preocupación, responde con calma, nunca vendas ' +
    'encima de esa emoción. Frustrado o molesto: no defiendas al negocio ni te justifiques, resuelve ' +
    'primero lo que motivó la molestia. Listo para comprar: deja de vender y avanza directo al dato ' +
    'operativo que falte, sin reabrir objeciones ni listar más opciones. Cliente con pedido ' +
    'existente: prioriza servicio, no lo trates como lead nuevo, nunca pidas datos que ya tienes. ' +
    'Riesgo de cancelación: entiende el motivo primero con empatía, sin lanzar promociones ni ' +
    'presión comercial mientras tanto. El cliente debe sentir que tiene el control — ofrécele el ' +
    'siguiente paso sin presionarlo, nunca decidas por él, nunca uses urgencia falsa.\n\n' +
    '--- Longitud ---\n' +
    'Breve (1-2 frases, menos de 280 caracteres): precio, pago, entrega, cliente listo para comprar, ' +
    'pregunta repetida, o mensajes cortos/impacientes. Normal (2-4 frases, menos de 450 caracteres): ' +
    'beneficio, producto, objeción sencilla. Profunda (hasta ~600 caracteres, máximo dos párrafos ' +
    'cortos): objeción compleja, comparación, desconfianza, o explicación médica prudente. Por defecto ' +
    'usa breve o normal, nunca párrafos largos por costumbre.\n\n' +
    '--- Una sola pregunta ---\n' +
    'Respeta el máximo de preguntas indicado en el plan — si necesitas presentar varias opciones de ' +
    'oferta, hazlo en una sola frase interrogativa, nunca pregunta + otra oración que también termine ' +
    'en "?". Si ya mostró señal de compra clara sin especificar oferta, asume la oferta principal (2 ' +
    'pastas + 1 cepillo por RD$2,100) y ve directo a pedir el dato operativo que falte.\n\n' +
    '--- Ofertas ---\n' +
    'Si tu plan permite ofertar, dilo de forma directa: si preguntan el precio, dilo primero, en la ' +
    'primera oración, sin rodeo. Usa una sola oferta salvo que pidan alternativas. Si tu plan no ' +
    'permite ofertar en este turno, no la menciones aunque parezca natural hacerlo.\n\n' +
    '--- Objeciones ---\n' +
    'La desconfianza del cliente no es una agresión — nunca respondas desde una posición defensiva. ' +
    'Valida la duda como legítima, reencuadra con un hecho real, da la evidencia concreta que lo ' +
    'sostiene (ingrediente, pago contra entrega, contenido completo de la oferta), y solo entonces ' +
    'avanza con una pregunta o CTA suave si el plan lo permite. Antes de intentar cerrar, reduce el ' +
    'riesgo percibido en este orden: claridad sobre lo que va a pasar, pago contra entrega, cómo es el ' +
    'proceso, y un hecho verificable. Si la objeción es específicamente no tener dinero ahora, la ' +
    'evidencia correcta es recordar que no necesita pagar en este momento — paga contra entrega, ' +
    'cuando el mensajero se la entregue, no antes. Si la misma objeción ya se resolvió una vez y ' +
    'reaparece, no insistas con más argumentos — deja la puerta abierta sin presionar.\n\n' +
    '--- Naturalidad ---\n' +
    'Varía la apertura, el cierre y el emoji entre mensajes de la misma conversación — nunca repitas ' +
    'literalmente la apertura, el CTA o el emoji del turno anterior de Génesis. Si en las instrucciones ' +
    'anteriores aparece "Sí 😊" como ejemplo ilustrativo, es solo un ejemplo — nunca lo repitas como ' +
    'fórmula fija. Nunca repitas literalmente la pregunta del cliente como apertura. No repitas ' +
    'información, oferta u objeción ya resuelta salvo que el cliente la pida de nuevo o haya confusión ' +
    'real. Evita sonar clínico o como un asistente genérico de IA.\n\n' +
    '--- Reglas generales ---\n' +
    'Responde siempre en español natural para República Dominicana, sin markdown ni listas. No ' +
    'inventes claims que no estén en la base de conocimiento. No confirmes ni canceles pedidos por tu ' +
    'cuenta — esa acción la gestiona el sistema automáticamente cuando el cliente pulsa los botones del ' +
    'mensaje de confirmación. Si tu plan indica señal de seguridad "reaccion_adversa", tu mensaje ' +
    'completo tiene solo tres partes, en este orden, y nada más: empatía breve, recomendar suspender el ' +
    'uso de inmediato, y decir explícitamente que un agente humano va a continuar el caso. Nunca ' +
    'agregues una cuarta parte preguntando por los síntomas, su intensidad, o pidiendo más detalle antes ' +
    'de ofrecer el agente — escala siempre, de inmediato, sin excepción, sin importar qué más haya dicho ' +
    'el cliente en el mismo mensaje (incluida una cancelación). Si tu plan indica señal de seguridad ' +
    '"revision_medica", recomienda evaluación profesional con naturalidad, sin alarmar. Si no sabes la ' +
    'respuesta a algo o el cliente pide algo que requiere intervención humana, dilo con naturalidad y ' +
    'ofrece que un agente lo va a atender.',
  )

  return parts.join('\n\n')
}

// Timeout explícito vía AbortController (antes no existía — hallazgo H14).
// Un abort produce kind='timeout', distinguible de cualquier otro fallo
// (kind='error') para poder registrar failure_code='openai_timeout' en vez
// de 'openai_error' genérico.
//
// Decision Plan V1: acepta un 4º parámetro opcional `opts` para que el
// Planner pueda pedir temperature baja / max_tokens chico / JSON mode sin
// duplicar esta función (instrucción explícita: "Debe reutilizar
// callOpenAI()"). El Generator (único caller previo a esta fase) nunca pasa
// `opts` — sus valores por defecto (0.6 / 300 / sin json mode / 15s)
// reproducen EXACTAMENTE el comportamiento anterior, cero cambio para el
// caller existente.
const callOpenAI: CallOpenAIFn = async (apiKey, model, messages, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? OPENAI_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

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
        max_tokens:  opts.maxTokens ?? MAX_TOKENS,
        temperature: opts.temperature ?? 0.6,
        ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
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
      console.error('[genesis] OpenAI timeout tras', timeoutMs, 'ms')
      return { ok: false, kind: 'timeout' }
    }
    console.error('[genesis] OpenAI fetch threw', err)
    return { ok: false, kind: 'error' }
  }
}

export { callOpenAI }

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

    // ── 5. Generar la respuesta — RG-2 (desplegado) o Decision Plan V1 (experimental) ──
    // GENESIS_DECISION_PLAN_ENABLED — flag de seguridad. Cualquier valor
    // distinto de la cadena exacta 'true' (ausente, vacío, 'false', typo,
    // etc.) usa el camino RG-2 — el mismo que corre hoy en producción, sin
    // ninguna llamada al Planner. Default seguro: false. La variable NO se
    // agregó a Vercel en esta fase — hasta que exista ahí, este flag es
    // siempre 'false' en producción real.
    const decisionPlanEnabled = process.env.GENESIS_DECISION_PLAN_ENABLED === 'true'

    const model = config.model?.trim() || 'gpt-4o-mini'
    let replyText: string

    if (!decisionPlanEnabled) {
      // ── RG-2 — camino desplegado, sin cambios de comportamiento ──────────
      // Deliberadamente NO comparte código con la rama Decision Plan de
      // abajo más allá de `historyMessages` (mapeo puro de `history`, cero
      // lógica de negocio) — instrucción explícita: no refactorizar RG-2
      // para compartir código si eso aumenta el riesgo. Esta rama reproduce
      // exactamente la única llamada a OpenAI que existía antes de esta
      // fase: mismo buildSystemPrompt(), mismo mensaje de log, mismo mapeo
      // de failure_code (openai_timeout/openai_error — ya eran los valores
      // legales, sin cambios).
      const systemPrompt = buildSystemPrompt(
        config.agent_name,
        config.system_prompt,
        (sections ?? []) as KnowledgeSectionRow[],
      )

      const historyMessages: ChatMessage[] = history.map(m => ({
        role:    (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.body as string,
      }))

      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
      ]

      console.log('[genesis] llamando a OpenAI — model:', model, '| historial:', history.length, 'mensajes | run:', runId)
      const openaiResult = await openaiFn(apiKey, model, chatMessages)

      if (!openaiResult.ok) {
        const failureCode = openaiResult.kind === 'timeout' ? 'openai_timeout' : 'openai_error'
        console.log('[genesis] OpenAI falló (', openaiResult.kind, ') — cerrando run como failed_retryable | run:', runId)
        await finishRun(supabase, runId, lockToken, 'failed_retryable', { failure_code: failureCode })
        return
      }
      replyText = openaiResult.text
    } else {
      // ── Decision Plan V1 — EXPERIMENTAL, detrás de GENESIS_DECISION_PLAN_ENABLED ──
      // No activado en producción (cierre de fase — ver docs internas):
      // 1/10 casos con mejora clara, 8/10 equivalentes a RG-2, 1/10 peor
      // (turno perdido por plan incoherente), ~+68% tokens de entrada, mayor
      // latencia. Se conserva completo detrás del flag para no perder el
      // trabajo, sin activarlo.
      const historyMessages: ChatMessage[] = history.map(m => ({
        role:    (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.body as string,
      }))

      // ── 5a. Planner ──────────────────────────────────────────────────────
      // Llamada independiente, JSON puro, temperature baja, timeout propio,
      // reutiliza openaiFn (mismo seam de deps que el Generator). No escribe
      // en BD, no envía mensajes — solo clasifica.
      const plannerPrompt = buildPlannerContext(
        config.agent_name,
        config.system_prompt,
        (sections ?? []) as KnowledgeSectionRow[],
      )

      console.log('[genesis] llamando al Planner — model:', model, '| historial:', history.length, 'mensajes | run:', runId)
      const planOutcome = await generateDecisionPlan(apiKey, model, plannerPrompt, historyMessages, openaiFn)

      if (!planOutcome.ok) {
        // Sin fallback a un plan neutro — decisión explícita del producto:
        // "prefiero perder un turno antes que responder con una decisión
        // incorrecta". El run se cierra aquí, el Generator nunca se llama.
        //
        // failure_code está restringido por un CHECK constraint de Postgres
        // (migración 056_genesis_message_runs.sql) a un enum fijo que NO
        // incluye valores específicos de Planner/Generator/Validator — solo
        // 'openai_error' | 'openai_timeout' | 'validation_rejected' | ...
        // Agregar valores nuevos requeriría una migración, fuera de alcance.
        // Mapeo (documentado aquí, NO es lo que Supabase almacena
        // literalmente — la columna solo ve el valor de la derecha; el
        // detalle específico de la izquierda vive únicamente en los logs de
        // arriba, nunca lo afirmes como consultable desde la DB):
        //   planner_timeout           → openai_timeout
        //   planner_api_error         → openai_error
        //   planner_invalid_json      → validation_rejected
        //   planner_validation_failed → validation_rejected
        //   response_validation_failed→ validation_rejected (ver 5c abajo)
        const dbFailureCodeByKind: Record<typeof planOutcome.kind, 'openai_timeout' | 'openai_error' | 'validation_rejected'> = {
          timeout:            'openai_timeout',
          api_error:          'openai_error',
          invalid_json:       'validation_rejected',
          validation_failed:  'validation_rejected',
        }
        const failureCode = dbFailureCodeByKind[planOutcome.kind]
        console.log('[genesis] Planner falló (', planOutcome.kind, planOutcome.reason ?? '', ') — cerrando run como failed_retryable, sin llamar al Generator | run:', runId, '| failure_code(DB):', failureCode)
        await finishRun(supabase, runId, lockToken, 'failed_retryable', { failure_code: failureCode })
        return
      }

      const plan = planOutcome.plan
      console.log('[genesis] Decision Plan —', JSON.stringify(plan), '| run:', runId)

      // ── 5b. Generator — redacta a partir del plan ya decidido ────────────
      // `history` incluye el propio mensaje inbound que disparó este turno
      // (ya está insertado en wa_messages antes de que el webhook llame a
      // maybeGenesisRespond) — por eso "hay conversación previa" es
      // history.length > 1 (más que solo el mensaje actual), no > 0.
      const hasHistory = history.length > 1
      const constraints = derivePlanConstraints(plan, hasHistory)
      const generatorPrompt = buildGeneratorPrompt(
        config.agent_name,
        config.system_prompt,
        (sections ?? []) as KnowledgeSectionRow[],
        plan,
        constraints,
      )

      const chatMessages: ChatMessage[] = [
        { role: 'system', content: generatorPrompt },
        ...historyMessages,
      ]

      console.log('[genesis] llamando al Generator — model:', model, '| historial:', history.length, 'mensajes | run:', runId)
      const openaiResult = await openaiFn(apiKey, model, chatMessages)

      if (!openaiResult.ok) {
        // Mismo enum legal que arriba — 'openai_timeout'/'openai_error' ya
        // existían antes de esta fase y siguen siendo los valores correctos
        // para un fallo de OpenAI, sea del Planner o del Generator.
        const failureCode = openaiResult.kind === 'timeout' ? 'openai_timeout' : 'openai_error'
        console.log('[genesis] Generator falló (', openaiResult.kind, ') — cerrando run como failed_retryable | run:', runId)
        await finishRun(supabase, runId, lockToken, 'failed_retryable', { failure_code: failureCode })
        return
      }

      // ── 5c. Validador determinístico — última puerta antes de Meta ───────
      const previousAssistantText = [...history].reverse().find(m => m.direction === 'outbound')?.body ?? null
      const validation = validateResponse(openaiResult.text, plan, constraints, {
        hasHistory,
        previousAssistantText,
      })

      if (validation.warnings.length > 0) {
        console.log('[genesis] validador — advertencias:', validation.warnings.join(' | '), '| run:', runId)
      }

      if (validation.graveViolations.length > 0) {
        // 'validation_rejected' ya existía en el enum legal de failure_code
        // (migración 056) — encaja exactamente con este caso sin necesitar
        // ningún valor nuevo.
        console.log('[genesis] validador — violación grave, no se envía:', validation.graveViolations.join(' | '), '| run:', runId)
        await finishRun(supabase, runId, lockToken, 'failed_terminal', { failure_code: 'validation_rejected' })
        return
      }

      replyText = validation.finalText
    }

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
