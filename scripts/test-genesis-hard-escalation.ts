// Pruebas unitarias puras — hard-escalation.ts (Sprint 2, ronda de validación
// final). Cubre las dos señales independientes (inbound/outbound) y su
// combinación OR.
// Corre con: npx tsx scripts/test-genesis-hard-escalation.ts
// Sin red, sin Supabase — funciones puras.

import {
  detectInboundAdverseReactionSignal,
  detectOutboundAdverseReactionSignal,
  detectHardEscalationSignal,
} from '../src/lib/genesis/hard-escalation'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

console.log('=== detectInboundAdverseReactionSignal — TRUE POSITIVES ===\n')

const TRUE_POSITIVES = [
  'Me salió un sarpullido después de usarla.',
  'Desde que uso la pasta me arden las encías.',
  'Me dio una reacción con la pasta.',
  'La usé y ahora tengo la boca hinchada.',
  'Después de usarla me empezó a doler mucho.',
  'Me irritó las encías.',
  'ME SALIÓ UN SARPULLIDO DESPUÉS DE USARLA.',      // 7. mayúsculas
  'Despues de usarla me salio un sarpullido',        // 8. sin tildes (error ortográfico razonable)
]
TRUE_POSITIVES.forEach((msg, i) => {
  check(`${i + 1}. "${msg}" → true`, detectInboundAdverseReactionSignal(msg) === true)
})

console.log('\n=== detectInboundAdverseReactionSignal — TRUE NEGATIVES ===\n')

const TRUE_NEGATIVES = [
  '¿Puede causar alergia?',
  '¿Eso da sensibilidad?',
  'Tengo dientes sensibles.',
  'Me duele una muela.',
  '¿Sirve para las encías?',
  'Soy alérgico a algunos productos.',
  '¿Qué pasa si me irrita?',
  'Hola, cuánto cuesta la oferta de 2 pastas?',       // 16. conversación comercial normal
]
TRUE_NEGATIVES.forEach((msg, i) => {
  check(`${i + 9}. "${msg}" → false`, detectInboundAdverseReactionSignal(msg) === false)
})

console.log('\n=== detectOutboundAdverseReactionSignal — señal secundaria (sin cambios de comportamiento) ===\n')

check(
  'Protocolo completo (suspender + agente) → true',
  detectOutboundAdverseReactionSignal('Lamento mucho esa reacción. Suspende el uso de inmediato — un agente humano va a continuar tu caso.') === true,
)
check(
  'Respuesta comercial normal → false',
  detectOutboundAdverseReactionSignal('Sí, LÜMA Teeth ayuda a fortalecer el esmalte. ¿Quieres la oferta de RD$2,100?') === false,
)

console.log('\n=== detectHardEscalationSignal — combinación OR (outbound fallback) ===\n')

{
  // 17. inbound ambiguo (no dispara) + outbound con protocolo completo → debe escalar igual.
  const r = detectHardEscalationSignal(
    'Lamento mucho eso. Suspende el uso de inmediato — un agente humano va a continuar tu caso.',
    'tengo una consulta rara',
  )
  check('17. Inbound ambiguo + outbound con protocolo completo → required=true, source=outbound', r.required === true && r.source === 'outbound', r)
}

{
  // 18. inbound claro (dispara) + outbound SIN protocolo → debe escalar igual.
  const r = detectHardEscalationSignal(
    'Entiendo, vamos a revisar tu caso pronto.',
    'Me salió un sarpullido después de usarla.',
  )
  check('18. Inbound claro + outbound sin protocolo → required=true, source=inbound', r.required === true && r.source === 'inbound', r)
}

{
  // Ambas señales presentes a la vez → source='both'.
  const r = detectHardEscalationSignal(
    'Lamento mucho eso. Suspende el uso de inmediato — un agente humano va a continuar tu caso.',
    'Me salió un sarpullido después de usarla.',
  )
  check('19. Ambas señales presentes → required=true, source=both', r.required === true && r.source === 'both', r)
}

{
  // Ninguna señal presente → false, source=null.
  const r = detectHardEscalationSignal(
    'Sí, LÜMA Teeth ayuda a fortalecer el esmalte con el uso diario. ¿Quieres la oferta?',
    'sirve para el esmalte?',
  )
  check('20. Ninguna señal presente → required=false, source=null', r.required === false && r.source === null, r)
}

{
  // Sin customerMessage (compatibilidad hacia atrás — caller no lo pasa) → solo evalúa outbound.
  const r = detectHardEscalationSignal('Suspende el uso de inmediato, un agente te va a contactar.')
  check('21. Sin customerMessage (undefined) → sigue evaluando outbound solamente', r.required === true && r.source === 'outbound', r)
}

console.log(`\n${failures === 0 ? '✅ Todas las pruebas pasaron' : `❌ ${failures} prueba(s) fallaron`}`)
process.exit(failures === 0 ? 0 : 1)
