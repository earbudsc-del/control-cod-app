// Sprint Broadcast A.1 — aislamiento del processor de AUTOMATIONS respecto
// de Broadcast.
//
// Determinístico: NO toca DB real, NO llama a Meta, NO cambia estados.
//   - La query se captura con un builder falso que registra cada llamada.
//   - El GET real del processor se ejecuta solo con WA_AUTOMATIONS_ENABLED
//     apagado y con globalThis.fetch interceptado (cualquier fetch = fallo).
//
// Corre con: npx tsx scripts/test-wa-processor-isolation.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTOMATION_TEMPLATE_NAMES,
  fetchAutomationJobs,
  getAutomationTemplate,
  isAutomationQueueCandidate,
  type AutomationQueueRowLike,
} from '../src/lib/wa-queue/automation-queue'
import {
  SD_BROADCAST_TEMPLATE_NAME,
  isSelectableByBroadcastProcessor,
} from '../src/lib/broadcast/sd-broadcast-eligibility'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

// Builder falso estilo PostgREST: registra [método, ...args] y es thenable.
type Call = [string, ...unknown[]]
function fakeSupabase() {
  const calls: Call[] = []
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'in', 'lte', 'order', 'limit']) {
    builder[m] = (...args: unknown[]) => { calls.push([m, ...args]); return builder }
  }
  return {
    calls,
    client: { from: (t: string) => { calls.push(['from', t]); return builder } },
  }
}

const routeSrc = readFileSync(join(__dirname, '..', 'src/app/api/cron/wa-template-queue/route.ts'), 'utf8')
const BID = '11111111-1111-1111-1111-111111111111'

async function main() {
  console.log('=== Query del processor de automation ===\n')
  const { calls, client } = fakeSupabase()
  fetchAutomationJobs(client, '2026-10-06T00:00:00.000Z')
  const has = (m: string, ...args: unknown[]) =>
    calls.some(c => c[0] === m && JSON.stringify(c.slice(1)) === JSON.stringify(args))

  check('E. query exige broadcast_id IS NULL (barrera 1)', has('is', 'broadcast_id', null), calls)
  check('query exige template_name IN allowlist (barrera 2)',
    has('in', 'template_name', ['order_confirmation_cod', 'sd_location_request']))
  check('query exige status = pending', has('eq', 'status', 'pending'))
  check('query solo sobre wa_template_queue', has('from', 'wa_template_queue'))
  check('query SELECT incluye broadcast_id (para la barrera de dispatch)',
    calls.some(c => c[0] === 'select' && String(c[1]).split(',').map(s => s.trim()).includes('broadcast_id')))
  check('processor usa fetchAutomationJobs (no una query propia)',
    routeSrc.includes('fetchAutomationJobs(supabase') && !/\.select\('id, store_id, order_id, template_name/.test(routeSrc))

  console.log('\n=== Allowlist / dispatch ===\n')
  check('allowlist exacta = [order_confirmation_cod, sd_location_request]',
    JSON.stringify(AUTOMATION_TEMPLATE_NAMES) === JSON.stringify(['order_confirmation_cod', 'sd_location_request']))

  const ocAuto: AutomationQueueRowLike = { broadcast_id: null, template_name: 'order_confirmation_cod', status: 'pending' }
  const sdAuto: AutomationQueueRowLike = { broadcast_id: null, template_name: 'sd_location_request', status: 'pending' }
  check('A. order_confirmation_cod + broadcast_id NULL → candidato',
    isAutomationQueueCandidate(ocAuto) && getAutomationTemplate('order_confirmation_cod') === 'order_confirmation_cod')
  check('B. sd_location_request + broadcast_id NULL → candidato',
    isAutomationQueueCandidate(sdAuto) && getAutomationTemplate('sd_location_request') === 'sd_location_request')

  check('C. sd_broadcast_confirmation NO está en la allowlist',
    getAutomationTemplate(SD_BROADCAST_TEMPLATE_NAME) === null)
  check('C. sd_broadcast_confirmation con broadcast_id NULL (bug) → NO candidato',
    !isAutomationQueueCandidate({ broadcast_id: null, template_name: SD_BROADCAST_TEMPLATE_NAME, status: 'pending' }))
  check('C. sd_broadcast_confirmation con broadcast_id → NO candidato',
    !isAutomationQueueCandidate({ broadcast_id: BID, template_name: SD_BROADCAST_TEMPLATE_NAME, status: 'pending' }))

  for (const t of ['unknown_template', 'ORDER_CONFIRMATION_COD', 'order_confirmation_cod ', '', 'sd_location_request_v2']) {
    check(`D. template ${JSON.stringify(t)} → sin handler (null), no candidato`,
      getAutomationTemplate(t) === null && !isAutomationQueueCandidate({ broadcast_id: null, template_name: t, status: 'pending' }))
  }
  // Estático: no queda el fallback histórico "cualquier otro → runOrderConfirmationJob".
  const dispatchBlock = routeSrc.slice(routeSrc.indexOf('async function processJob'), routeSrc.indexOf('async function runOrderConfirmationJob'))
  check('D. dispatch: switch explícito por allowlist, sin default',
    /switch \(template\)/.test(dispatchBlock) && !/default\s*:/.test(dispatchBlock))
  check('D. dispatch: runOrderConfirmationJob solo bajo case order_confirmation_cod',
    (dispatchBlock.match(/runOrderConfirmationJob\(/g) ?? []).length === 1
      && /case 'order_confirmation_cod':\s*return runOrderConfirmationJob\(/.test(dispatchBlock))
  check('D. dispatch: fila desconocida/broadcast se ignora ANTES del claim (sin cambio de estado)',
    dispatchBlock.indexOf("return 'ignored'") !== -1
      && dispatchBlock.indexOf("return 'ignored'") < dispatchBlock.indexOf(".update({"))

  check('E. fila con broadcast_id (template histórico) → NO candidata',
    !isAutomationQueueCandidate({ broadcast_id: BID, template_name: 'order_confirmation_cod', status: 'pending' }))
  check('E. broadcast_id ausente del SELECT (undefined) → NO candidata (fail-closed)',
    !isAutomationQueueCandidate({ template_name: 'order_confirmation_cod', status: 'pending' }))
  check('E. dispatch: chequea broadcast_id !== null antes del claim',
    /job\.broadcast_id !== null \|\| !template/.test(dispatchBlock))

  console.log('\n=== F. Las 3 pending históricas ===\n')
  // Supuesto (del script de backlog Sprint 0B): order_confirmation_cod,
  // broadcast_id NULL tras 064. No se leen ni se tocan aquí.
  const historical: AutomationQueueRowLike[] = [0, 1, 2].map(() =>
    ({ broadcast_id: null, template_name: 'order_confirmation_cod', status: 'pending' }))
  check('F. siguen siendo candidatas SOLO del processor de automation',
    historical.every(r => isAutomationQueueCandidate(r)))
  check('F. NO son seleccionables por el processor de Broadcast',
    historical.every(r => !isSelectableByBroadcastProcessor({ broadcast_id: r.broadcast_id ?? null, template_name: r.template_name, status: r.status }, BID)))

  console.log('\n=== G/H. Flags — GET real del processor, sin red ===\n')
  const savedFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => { fetchCalls++; throw new Error('fetch bloqueado en test') }) as typeof fetch
  const saved = {
    a: process.env.WA_AUTOMATIONS_ENABLED, b: process.env.WA_BROADCAST_ENABLED, c: process.env.CRON_SECRET,
  }
  try {
    process.env.CRON_SECRET = 'test-secret'
    const { GET } = await import('../src/app/api/cron/wa-template-queue/route')
    const req = () => new Request('http://localhost/api/cron/wa-template-queue', { headers: { authorization: 'Bearer test-secret' } })

    delete process.env.WA_AUTOMATIONS_ENABLED
    delete process.env.WA_BROADCAST_ENABLED
    let body = await (await GET(req())).json()
    check('G. AUTOMATIONS ausente → early-return disabled, processed=0', body.disabled === true && body.processed === 0, body)

    process.env.WA_AUTOMATIONS_ENABLED = 'false'
    body = await (await GET(req())).json()
    check('G. AUTOMATIONS=false → early-return disabled', body.disabled === true && body.processed === 0, body)

    process.env.WA_BROADCAST_ENABLED = 'true'
    body = await (await GET(req())).json()
    check('H. BROADCAST=true + AUTOMATIONS=false → sigue disabled (BROADCAST no enciende automation)',
      body.disabled === true && body.processed === 0, body)

    check('G/H. 0 llamadas de red (Meta) durante los GET', fetchCalls === 0, { fetchCalls })
  } finally {
    globalThis.fetch = savedFetch
    for (const [k, v] of [['WA_AUTOMATIONS_ENABLED', saved.a], ['WA_BROADCAST_ENABLED', saved.b], ['CRON_SECRET', saved.c]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
  check('H. processor no referencia WA_BROADCAST_ENABLED ni isWaBroadcastEnabled',
    !routeSrc.includes('WA_BROADCAST_ENABLED') && !routeSrc.includes('isWaBroadcastEnabled'))
  check('G. guard de AUTOMATIONS sigue antes de fetchAutomationJobs',
    routeSrc.indexOf('if (!isWaAutomationsEnabled())') !== -1
      && routeSrc.indexOf('if (!isWaAutomationsEnabled())') < routeSrc.indexOf('fetchAutomationJobs(supabase'))

  console.log(`\n${failures === 0 ? '✅ TODOS LOS TESTS PASAN' : `❌ ${failures} FALLO(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
