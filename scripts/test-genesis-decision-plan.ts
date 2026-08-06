// Pruebas unitarias puras — Decision Plan V1.
//
// Corre con: npx tsx scripts/test-genesis-decision-plan.ts
// (o: npm run test:genesis-decision-plan)
//
// Sin red, sin Supabase, sin OpenAI — valida únicamente la lógica
// determinística de src/lib/genesis/decision-plan.ts y
// src/lib/genesis/response-validator.ts. Complementa a
// scripts/test-genesis-respond-orchestrator.ts (que sí prueba la
// integración end-to-end contra Supabase real con dobles de OpenAI/Meta).

import {
  parseDecisionPlanJson,
  validateDecisionPlanShape,
  derivePlanConstraints,
  type DecisionPlan,
} from '../src/lib/genesis/decision-plan'
import { validateResponse } from '../src/lib/genesis/response-validator'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

const VALID_PLAN = {
  stage: 'interesado', concept: 'esmalte', objection: null,
  goal: 'responder_duda', safety_signal: 'ninguna',
}

console.log('=== Decision Plan V1 — pruebas unitarias puras ===\n')

// ── parseDecisionPlanJson / validateDecisionPlanShape ─────────────────────

console.log('--- Parser + validador de forma ---')
{
  const r = parseDecisionPlanJson(JSON.stringify(VALID_PLAN))
  check('1. Plan válido → ok:true', r.ok === true, r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, objection: 'precio', goal: 'resolver_objecion' }))
  check('2. Plan válido con objection no-null → ok:true', r.ok === true, r)
}
{
  const r = parseDecisionPlanJson('esto no es JSON')
  check('3. Texto no-JSON → ok:false, reason menciona "JSON válido"', r.ok === false && r.reason.includes('JSON válido'), r)
}
{
  const r = parseDecisionPlanJson('```json\n' + JSON.stringify(VALID_PLAN) + '\n```')
  check('4. JSON envuelto en fences de markdown → se parsea igual (ok:true)', r.ok === true, r)
}
{
  const { stage: _stage, ...missing } = VALID_PLAN
  const r = parseDecisionPlanJson(JSON.stringify(missing))
  check('5. Falta campo requerido (stage) → ok:false', r.ok === false, r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, concept: ['esmalte'] }))
  check('6. Campo con array en vez de escalar → ok:false ("no debe ser un array")', r.ok === false && r.reason.includes('array'), r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, stage: 'furioso' }))
  check('7. "stage" fuera de enum → ok:false', r.ok === false, r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, concept: 'dientes_de_oro' }))
  check('8. "concept" fuera de enum → ok:false', r.ok === false, r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, objection: 'no_le_gusta_el_color' }))
  check('9. "objection" fuera de enum (y no null) → ok:false', r.ok === false, r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, goal: 'venderle_lo_que_sea' }))
  check('10. "goal" fuera de enum → ok:false', r.ok === false, r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, safety_signal: 'tal_vez' }))
  check('11. "safety_signal" fuera de enum → ok:false', r.ok === false, r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, goal: 'resolver_objecion', objection: null }))
  check('12. Regla cruzada: goal=resolver_objecion + objection=null → ok:false', r.ok === false, r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, safety_signal: 'reaccion_adversa', goal: 'presentar_oferta' }))
  check('13. Regla cruzada: safety_signal=reaccion_adversa + goal=presentar_oferta → ok:false', r.ok === false, r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, safety_signal: 'revision_medica', goal: 'cerrar' }))
  check('14. Regla cruzada: safety_signal=revision_medica + goal=cerrar → ok:false', r.ok === false, r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, stage: 'riesgo_cancelacion', goal: 'presentar_oferta' }))
  check('15. Regla cruzada: stage=riesgo_cancelacion + goal=presentar_oferta → ok:false', r.ok === false, r)
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, stage: 'riesgo_cancelacion', goal: 'cerrar' }))
  check('16. Regla cruzada: stage=riesgo_cancelacion + goal=cerrar → ok:false', r.ok === false, r)
}
{
  const r = parseDecisionPlanJson('x'.repeat(1500))
  check('17. Texto crudo > 1000 caracteres → ok:false, reason menciona "demasiado larga"', r.ok === false && r.reason.includes('demasiado larga'), r)
}
{
  const rArray = validateDecisionPlanShape(['no', 'es', 'un', 'objeto'])
  const rString = validateDecisionPlanShape('tampoco')
  const rNull = validateDecisionPlanShape(null)
  check('18. Root no es objeto (array/string/null) → ok:false en los 3 casos',
    rArray.ok === false && rString.ok === false && rNull.ok === false, { rArray, rString, rNull })
}
{
  const r = parseDecisionPlanJson(JSON.stringify({ ...VALID_PLAN, extra_field_no_reconocido: 'lo que sea' }))
  check('19. Campo extra no reconocido → se ignora, ok:true (tolerancia hacia adelante)', r.ok === true, r)
}

// ── derivePlanConstraints ──────────────────────────────────────────────────

console.log('\n--- derivePlanConstraints ---')
{
  const plan: DecisionPlan = { stage: 'interesado', concept: 'esmalte', objection: null, goal: 'presentar_oferta', safety_signal: 'ninguna' }
  const c = derivePlanConstraints(plan, false)
  check('20. goal=presentar_oferta, safety=ninguna, sin historial → offerAllowed=true, maxQuestions=1, mustEscalate=false, greetingAllowed=true',
    c.offerAllowed === true && c.maxQuestions === 1 && c.mustEscalate === false && c.greetingAllowed === true, c)
}
{
  const plan: DecisionPlan = { stage: 'frustrado', concept: 'ninguno', objection: null, goal: 'tranquilizar', safety_signal: 'reaccion_adversa' }
  const c = derivePlanConstraints(plan, true)
  check('21. safety_signal=reaccion_adversa → mustEscalate=true, maxQuestions=0, offerAllowed=false, prohibitedActions incluye "vender"',
    c.mustEscalate === true && c.maxQuestions === 0 && c.offerAllowed === false && c.prohibitedActions.includes('vender'), c)
}
{
  const plan: DecisionPlan = { ...VALID_PLAN as unknown as DecisionPlan }
  const c = derivePlanConstraints(plan, true)
  check('22. hasHistory=true → greetingAllowed=false, prohibitedActions incluye "saludar"',
    c.greetingAllowed === false && c.prohibitedActions.includes('saludar'), c)
}
{
  const plan: DecisionPlan = { stage: 'riesgo_cancelacion', concept: 'ninguno', objection: null, goal: 'servicio', safety_signal: 'ninguna' }
  const c = derivePlanConstraints(plan, true)
  check('23. stage=riesgo_cancelacion → prohibitedActions incluye "presionar" y "urgencia"',
    c.prohibitedActions.includes('presionar') && c.prohibitedActions.includes('urgencia'), c)
}
{
  const plan: DecisionPlan = { ...VALID_PLAN as unknown as DecisionPlan, goal: 'responder_duda' }
  const c = derivePlanConstraints(plan, false)
  check('24. goal=responder_duda (no oferta/cierre) → offerAllowed=false aunque safety_signal=ninguna',
    c.offerAllowed === false, c)
}

// ── validateResponse ────────────────────────────────────────────────────

console.log('\n--- validateResponse (validador de respuesta) ---')
const NEUTRAL_PLAN: DecisionPlan = { stage: 'interesado', concept: 'esmalte', objection: null, goal: 'responder_duda', safety_signal: 'ninguna' }
const NEUTRAL_CONSTRAINTS = derivePlanConstraints(NEUTRAL_PLAN, false)
const NO_CTX = { hasHistory: false, previousAssistantText: null }

{
  const r = validateResponse('Ayuda a fortalecer el esmalte con el uso diario. ¿Quieres que te cuente de la oferta?', NEUTRAL_PLAN, NEUTRAL_CONSTRAINTS, NO_CTX)
  check('25. Texto limpio, sin violaciones → graveViolations vacío', r.graveViolations.length === 0, r)
}
{
  const r = validateResponse('Sí, esta pasta cura caries de forma definitiva.', NEUTRAL_PLAN, NEUTRAL_CONSTRAINTS, NO_CTX)
  check('26. Frase prohibida presente → graveViolations no vacío', r.graveViolations.length > 0, r)
}
{
  const r = validateResponse('¿Cuál prefieres? ¿La de 2 o la de 3?', NEUTRAL_PLAN, NEUTRAL_CONSTRAINTS, NO_CTX)
  check('27. Más "?" que el máximo permitido (1) → graveViolations no vacío', r.graveViolations.length > 0, r)
}
{
  const dudaConstraints = derivePlanConstraints({ ...NEUTRAL_PLAN, goal: 'responder_duda' }, false)
  const r = validateResponse('La oferta de 2 pastas por RD$2,100 te puede interesar.', NEUTRAL_PLAN, dudaConstraints, NO_CTX)
  check('28. Menciona oferta cuando el plan no lo permite → graveViolations no vacío', r.graveViolations.length > 0, r)
}
{
  const adversePlan: DecisionPlan = { stage: 'frustrado', concept: 'ninguno', objection: null, goal: 'tranquilizar', safety_signal: 'reaccion_adversa' }
  const c = derivePlanConstraints(adversePlan, false)
  const r = validateResponse('Lamento escuchar eso, esperamos que te mejores pronto.', adversePlan, c, NO_CTX)
  check('29. safety_signal=reaccion_adversa sin palabra de escalamiento → graveViolations no vacío', r.graveViolations.length > 0, r)
}
{
  const adversePlan: DecisionPlan = { stage: 'frustrado', concept: 'ninguno', objection: null, goal: 'tranquilizar', safety_signal: 'reaccion_adversa' }
  const c = derivePlanConstraints(adversePlan, false)
  const r = validateResponse('Lamento escuchar eso. Por favor suspende el uso — un agente humano va a continuar tu caso.', adversePlan, c, NO_CTX)
  check('30. safety_signal=reaccion_adversa CON escalamiento correcto → sin esa violación específica',
    !r.graveViolations.some(v => v.includes('deriva a un humano')), r)
}
{
  const r = validateResponse('Sensodyne no sirve tan bien como nosotros para la sensibilidad.', NEUTRAL_PLAN, NEUTRAL_CONSTRAINTS, NO_CTX)
  check('31. Ataque a competencia detectado ("Sensodyne no sirve") → graveViolations no vacío', r.graveViolations.length > 0, r)
}
{
  const r = validateResponse('  Hola\n\n\ncon   espacios raros  ', NEUTRAL_PLAN, NEUTRAL_CONSTRAINTS, NO_CTX)
  check('32. Auto-fix — espacios/saltos de línea colapsados', r.finalText === 'Hola con espacios raros', r)
}
{
  const r = validateResponse('Esto **es importante** de verdad', NEUTRAL_PLAN, NEUTRAL_CONSTRAINTS, NO_CTX)
  check('33. Auto-fix — negrita de markdown removida', r.finalText === 'Esto es importante de verdad', r)
}
{
  const withHistoryConstraints = derivePlanConstraints(NEUTRAL_PLAN, true)
  const r = validateResponse('¡Hola! 😊 Sí, ayuda con eso.', NEUTRAL_PLAN, withHistoryConstraints, { hasHistory: true, previousAssistantText: null })
  check('34. Auto-fix — saludo removido en conversación en curso', !/^\s*¡?\s*(hola|buenas)/i.test(r.finalText), r)
}
{
  const r = validateResponse('Perfecto, dale.', NEUTRAL_PLAN, NEUTRAL_CONSTRAINTS, { hasHistory: true, previousAssistantText: 'Perfecto, dale.' })
  check('35. Repite literalmente el turno anterior → warning presente, no grave',
    r.warnings.some(w => w.includes('repite literalmente')) && r.graveViolations.length === 0, r)
}
{
  const r = validateResponse('Pero eso no siempre funciona así.', NEUTRAL_PLAN, NEUTRAL_CONSTRAINTS, NO_CTX)
  check('36. Abre con negación/limitación → warning presente', r.warnings.some(w => w.includes('negación')), r)
}

console.log('\n=== RESUMEN ===')
console.log(`❌ Fallaron: ${failures}`)
if (failures === 0) console.log('✅ Todas las pruebas unitarias del Decision Plan pasaron.')

if (failures > 0) process.exit(1)
