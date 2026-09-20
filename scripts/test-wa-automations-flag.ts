// Validación explícita del feature flag WA_AUTOMATIONS_ENABLED — ambos
// estados (Sprint 0, ronda de validación final).
//
// Parte A (unitaria, pura): isWaAutomationsEnabled() en los dos estados.
// Parte B (estática): confirma que AMBOS puntos de encolado del webhook y el
// processor llaman a la función ANTES de cualquier escritura/lectura de
// wa_template_queue — para que quede demostrado que CASE B (flag=true) no
// "destruyó" el path normal, solo lo gatea.
//
// NO ejecuta contra producción, NO envía nada — solo lee el código fuente y
// llama a la función pura con distintos valores de env var.
//
// Corre con: npx tsx scripts/test-wa-automations-flag.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

console.log('=== CASE A: WA_AUTOMATIONS_ENABLED ausente/false ===\n')

async function freshIsEnabled(): Promise<typeof import('../src/lib/config/wa-automations').isWaAutomationsEnabled> {
  // Import dinámico + cache-bust no es trivial con ESM cacheado por Node;
  // en su lugar, como la función solo lee process.env en el momento de la
  // llamada (no en el momento del import), un import normal es suficiente:
  // cada llamada a isWaAutomationsEnabled() relee process.env.WA_AUTOMATIONS_ENABLED.
  const mod = await import('../src/lib/config/wa-automations')
  return mod.isWaAutomationsEnabled
}

async function main() {
  const isWaAutomationsEnabled = await freshIsEnabled()

  delete process.env.WA_AUTOMATIONS_ENABLED
  check('1. Variable ausente → false (fail-closed)', isWaAutomationsEnabled() === false)

  process.env.WA_AUTOMATIONS_ENABLED = 'false'
  check('2. Variable = "false" → false', isWaAutomationsEnabled() === false)

  process.env.WA_AUTOMATIONS_ENABLED = 'TRUE'
  check('3. Variable = "TRUE" (mayúsculas, typo común) → false (estricto, evita reactivación accidental)', isWaAutomationsEnabled() === false)

  process.env.WA_AUTOMATIONS_ENABLED = ''
  check('4. Variable = "" (vacío) → false', isWaAutomationsEnabled() === false)

  console.log('\n=== CASE B: WA_AUTOMATIONS_ENABLED=true ===\n')
  process.env.WA_AUTOMATIONS_ENABLED = 'true'
  check('5. Variable = "true" (exacto) → true — el enqueue/processor VUELVEN a estar habilitados', isWaAutomationsEnabled() === true)

  // Restaurar estado seguro para el resto del proceso.
  delete process.env.WA_AUTOMATIONS_ENABLED

  console.log('\n=== Verificación estática — flag conectado en AMBOS puntos, en la posición correcta ===\n')

  const webhookSrc = readFileSync(join(__dirname, '..', 'src/app/api/webhooks/shopify/orders/route.ts'), 'utf8')
  const cronSrc     = readFileSync(join(__dirname, '..', 'src/app/api/cron/wa-template-queue/route.ts'), 'utf8')

  // Webhook: ambos bloques de encolado (order_confirmation_cod y
  // sd_location_request) deben condicionar el upsert a isWaAutomationsEnabled().
  const webhookGuardCount = (webhookSrc.match(/isWaAutomationsEnabled\(\)/g) ?? []).length
  check('6. Webhook: isWaAutomationsEnabled() referenciado en los 2 puntos de encolado (paso 11 y 11b)', webhookGuardCount >= 2, { occurrences: webhookGuardCount })

  // Cada bloque de upsert a wa_template_queue debe estar precedido en el
  // archivo por una referencia a isWaAutomationsEnabled() (el `if` que lo
  // envuelve aparece antes del `.upsert(`).
  const upsertIndices = [...webhookSrc.matchAll(/\.from\('wa_template_queue'\)\s*\n\s*\.upsert\(/g)].map(m => m.index ?? -1)
  const guardIndices  = [...webhookSrc.matchAll(/isWaAutomationsEnabled\(\)/g)].map(m => m.index ?? -1)
  // 600 chars de margen — el bloque 11b tiene un `if` multilínea
  // (isSdLocationRequestEligible con un objeto literal de varias líneas)
  // entre el guard y el .upsert(), más largo que el bloque 11 simple.
  const allUpsertsGuarded = upsertIndices.every(upsertIdx => guardIndices.some(guardIdx => guardIdx < upsertIdx && upsertIdx - guardIdx < 600))
  check('7. Webhook: cada upsert a wa_template_queue tiene un guard isWaAutomationsEnabled() inmediatamente antes (mismo bloque if)', allUpsertsGuarded, { upsertCount: upsertIndices.length })

  // Processor: el guard debe estar ANTES de crear el service client / leer jobs.
  const cronGuardIdx   = cronSrc.indexOf('isWaAutomationsEnabled()')
  const cronServiceIdx = cronSrc.indexOf('createServiceClient()')
  const cronSelectIdx  = cronSrc.indexOf(".from('wa_template_queue')")
  check(
    '8. Processor: guard isWaAutomationsEnabled() aparece ANTES de createServiceClient() y de leer wa_template_queue',
    cronGuardIdx !== -1 && cronGuardIdx < cronServiceIdx && cronGuardIdx < cronSelectIdx,
    { cronGuardIdx, cronServiceIdx, cronSelectIdx },
  )

  // Processor: cuando el guard dispara, retorna ANTES de tocar la DB (early return).
  const guardBlockMatch = /if\s*\(!isWaAutomationsEnabled\(\)\)\s*\{[\s\S]*?return NextResponse\.json/.exec(cronSrc)
  check('9. Processor: el guard hace early-return (NextResponse.json) sin llegar a procesar jobs', !!guardBlockMatch)

  console.log(`\n${failures === 0 ? '✅ Todas las verificaciones pasaron — el flag pausa el sistema sin desconectar el path normal' : `❌ ${failures} verificación(es) fallaron`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
