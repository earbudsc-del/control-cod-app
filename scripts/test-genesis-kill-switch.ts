// Pruebas del kill switch de Génesis — Sprint G2.0.
//
// Corre con: npx tsx scripts/test-genesis-kill-switch.ts
// (o: npm run test:genesis-kill-switch)
//
// 100% offline: NO lee .env.local, NO conecta a Supabase, NO llama a
// OpenAI ni a Meta. maybeGenesisRespond recibe un cliente Supabase falso
// en memoria (simula claim/renew/begin_send/finish con la misma semántica
// relevante de la migración 058) y dobles de callOpenAI/sendWhatsAppText.
//
// Casos dinámicos:
//   A. GENESIS_ENABLED ausente → no responde (cero llamadas a la DB)
//   B. GENESIS_ENABLED='false' (y 'TRUE', '1', '') → no responde
//   C. flag true + ai_agent_config.is_active=false → no responde
//   D. flag true + configuración activa → flujo existente envía 1 vez
//   E. is_active=false durante la generación → no envía, run failed_terminal
//   F. flag quitado durante la generación → no envía
//   G. error leyendo config en la puerta → no envía (fail-closed)
// Casos estáticos (aislamiento): WhatsApp manual, Broadcast, simulador,
// pedidos, independencia de WA_AUTOMATIONS_ENABLED.

import { readFileSync } from 'node:fs'
import { maybeGenesisRespond, type CallOpenAIFn, type SendWhatsAppTextFn } from '../src/lib/genesis/respond'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

// ============================================================
// Cliente Supabase falso
// ============================================================
interface FakeState {
  config:        { is_active: boolean; mode: string } | null
  configError:   boolean          // la relectura de la puerta devuelve error
  configReads:   number
  calls:         string[]         // log de tablas/RPCs tocadas
  runStatus:     string | null
  finish:        { outcome: string; detail: unknown } | null
  outboundRows:  number
  ordersTouched: number
}

function newState(): FakeState {
  return {
    config: { is_active: true, mode: 'auto' }, configError: false, configReads: 0,
    calls: [], runStatus: null, finish: null, outboundRows: 0, ordersTouched: 0,
  }
}

const STORE = 'store-1'
const CONV  = 'conv-1'
const INB   = 'msg-in-1'

function makeFakeSupabase(st: FakeState) {
  function query(table: string) {
    const q = { table, op: 'select' as string, cols: '' }
    const resolve = (mode: 'many' | 'one') => {
      st.calls.push(`${table}:${q.op}`)
      if (table === 'orders') st.ordersTouched++
      if (table === 'wa_conversations' && q.op === 'select') {
        return { data: { id: CONV, contact: { wa_id: '18090000000', phone_normalized: '8090000000' } }, error: null }
      }
      if (table === 'wa_conversations' && q.op === 'update') return { data: null, error: null }
      if (table === 'ai_agent_config') {
        if (q.cols.includes('agent_name')) {
          return { data: { agent_name: 'Génesis', provider: 'openai', model: 'gpt-4o-mini', api_key_ref: 'FAKE_OPENAI_KEY', system_prompt: null }, error: null }
        }
        st.configReads++
        if (st.configError) return { data: null, error: { message: 'fake read error' } }
        return { data: st.config, error: null }
      }
      if (table === 'ai_agent_knowledge_sections') return { data: [], error: null }
      if (table === 'wa_messages' && q.op === 'insert') {
        st.outboundRows++
        return { data: { id: 'msg-out-1' }, error: null }
      }
      if (table === 'wa_messages' && mode === 'one') return { data: { body: '¿Cuánto cuesta?' }, error: null }
      if (table === 'wa_messages') {
        return { data: [{ direction: 'inbound', body: '¿Cuánto cuesta?', message_type: 'text', sent_at: new Date().toISOString() }], error: null }
      }
      if (table === 'genesis_message_runs') return { data: { status: st.runStatus }, error: null }
      return { data: null, error: null }
    }
    const builder: Record<string, unknown> = {
      select(cols?: string) { if (q.op === 'select') q.cols = cols ?? ''; return builder },
      insert() { q.op = 'insert'; return builder },
      update() { q.op = 'update'; return builder },
      eq() { return builder }, order() { return builder }, limit() { return builder },
      maybeSingle() { return Promise.resolve(resolve('one')) },
      single() { return Promise.resolve(resolve('one')) },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) { return Promise.resolve(resolve('many')).then(onF, onR) },
    }
    return builder
  }

  function rpc(name: string, args: Record<string, unknown>) {
    const run = () => {
      st.calls.push(`rpc:${name}`)
      if (name === 'claim_genesis_run') {
        // Misma semántica relevante de 058: is_active/mode verificados al reclamar.
        if (st.config?.is_active !== true || st.config?.mode !== 'auto') {
          return { data: { run_id: null, outcome: 'disabled', attempt_count: 0, message: 'is_active=false' }, error: null }
        }
        st.runStatus = 'claimed'
        return { data: { run_id: 'run-1', outcome: 'claimed', attempt_count: 1, message: null }, error: null }
      }
      if (name === 'renew_genesis_run') {
        if (args.p_new_status) st.runStatus = args.p_new_status as string
        return { data: { outcome: 'renewed', message: null }, error: null }
      }
      if (name === 'begin_genesis_send') {
        // 058 NO relee ai_agent_config aquí — solo la conversación.
        if (st.runStatus !== 'generated') return { data: { allowed: false, outcome: 'not_generated', message: null }, error: null }
        st.runStatus = 'sending'
        return { data: { allowed: true, outcome: 'allowed', message: null }, error: null }
      }
      if (name === 'finish_genesis_run') {
        st.runStatus = args.p_outcome as string
        st.finish = { outcome: args.p_outcome as string, detail: args.p_failure_detail }
        return { data: { outcome: args.p_outcome, message: null }, error: null }
      }
      if (name === 'escalate_genesis_conversation') return { data: { escalation_id: null, outcome: 'escalated', message: null }, error: null }
      return { data: null, error: null }
    }
    return { single: () => Promise.resolve(run()) }
  }

  return { from: query, rpc } as unknown as Parameters<typeof maybeGenesisRespond>[0]
}

// ============================================================
// Dobles OpenAI / Meta
// ============================================================
function makeDeps(st: FakeState, onGenerate?: () => void) {
  const counters = { openai: 0, send: 0 }
  const callOpenAI: CallOpenAIFn = async () => {
    counters.openai++
    onGenerate?.()
    return { ok: true, text: 'Sí, paga contra entrega cuando el mensajero se la lleve.' }
  }
  const sendWhatsAppText = (async () => {
    counters.send++
    return { ok: true, wamid: 'wamid.fake' }
  }) as unknown as SendWhatsAppTextFn
  return { counters, deps: { callOpenAI, sendWhatsAppText } }
}

let totalOrdersTouched = 0

async function runCase(setup: (st: FakeState) => void, onGenerate?: (st: FakeState) => void) {
  const st = newState()
  setup(st)
  const { counters, deps } = makeDeps(st, onGenerate ? () => onGenerate(st) : undefined)
  await maybeGenesisRespond(makeFakeSupabase(st), STORE, CONV, INB, deps)
  totalOrdersTouched += st.ordersTouched
  return { st, counters }
}

const savedFlag = process.env.GENESIS_ENABLED
const savedAuto = process.env.WA_AUTOMATIONS_ENABLED
process.env.FAKE_OPENAI_KEY = 'sk-fake'

async function main() {
  // Génesis nunca debe depender de este flag: se fija en 'true' para
  // demostrar que no lo sustituye.
  process.env.WA_AUTOMATIONS_ENABLED = 'true'

  console.log('\n=== A. GENESIS_ENABLED ausente ===')
  delete process.env.GENESIS_ENABLED
  {
    const { st, counters } = await runCase(() => {})
    check('A1. no envía', counters.send === 0)
    check('A2. no llama a OpenAI', counters.openai === 0)
    check('A3. no toca la DB (ni claim)', st.calls.length === 0, st.calls)
    check('A4. WA_AUTOMATIONS_ENABLED=true no lo sustituye', counters.send === 0)
  }

  console.log('\n=== B. GENESIS_ENABLED no exacto ===')
  for (const v of ['false', 'TRUE', '1', '', ' true']) {
    process.env.GENESIS_ENABLED = v
    const { st, counters } = await runCase(() => {})
    check(`B. '${v}' → no envía y no reclama`, counters.send === 0 && !st.calls.includes('rpc:claim_genesis_run'))
  }

  process.env.GENESIS_ENABLED = 'true'

  console.log('\n=== C. flag true + configuración inactiva ===')
  {
    const { st, counters } = await runCase(s => { s.config = { is_active: false, mode: 'auto' } })
    check('C1. no envía', counters.send === 0)
    check('C2. no llama a OpenAI', counters.openai === 0)
    check('C3. claim devuelve disabled, no se crea run', st.runStatus === null)
  }
  {
    const { counters } = await runCase(s => { s.config = null })
    check('C4. sin fila ai_agent_config → no envía', counters.send === 0)
  }

  console.log('\n=== D. flag true + configuración activa ===')
  {
    const { st, counters } = await runCase(() => {})
    check('D1. envía exactamente 1 vez', counters.send === 1, counters)
    check('D2. run cerrado como sent', st.finish?.outcome === 'sent', st.finish)
    check('D3. outbound persistido', st.outboundRows === 1)
    check('D4. puerta releyó la config antes de Meta', st.configReads === 1)
  }

  console.log('\n=== E. is_active=false durante la generación ===')
  {
    const { st, counters } = await runCase(() => {}, s => { s.config = { is_active: false, mode: 'auto' } })
    check('E1. OpenAI sí corrió (run ya reclamado)', counters.openai === 1)
    check('E2. NO envía', counters.send === 0)
    check('E3. run cerrado failed_terminal', st.finish?.outcome === 'failed_terminal', st.finish)
    check('E4. motivo config_inactive en failure_detail', (st.finish?.detail as { reason?: string })?.reason === 'config_inactive')
    check('E5. no persiste outbound', st.outboundRows === 0)
  }
  {
    const { st, counters } = await runCase(() => {}, s => { s.config = { is_active: true, mode: 'manual' } })
    check('E6. mode≠auto durante la generación → no envía', counters.send === 0 && st.finish?.outcome === 'failed_terminal')
  }

  console.log('\n=== F. flag quitado durante la generación ===')
  {
    const { st, counters } = await runCase(() => {}, () => { process.env.GENESIS_ENABLED = 'false' })
    check('F1. NO envía', counters.send === 0)
    check('F2. motivo genesis_flag_off', (st.finish?.detail as { reason?: string })?.reason === 'genesis_flag_off', st.finish)
    process.env.GENESIS_ENABLED = 'true'
  }

  console.log('\n=== G. error leyendo config en la puerta ===')
  {
    const { st, counters } = await runCase(() => {}, s => { s.configError = true })
    check('G1. NO envía (fail-closed)', counters.send === 0)
    check('G2. run failed_retryable', st.finish?.outcome === 'failed_retryable', st.finish)
  }

  console.log('\n=== H. Aislamiento (estático) ===')
  const strip = (p: string) => readFileSync(p, 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const flagSrc      = strip('src/lib/config/genesis.ts')
  const respondSrc   = strip('src/lib/genesis/respond.ts')
  const manualWa     = strip('src/app/api/whatsapp/conversations/[id]/messages/route.ts')
  const broadcastCfg = strip('src/lib/config/wa-broadcast.ts')
  const simulator    = strip('src/app/api/admin/genesis-simulator/message/route.ts')
  check('H1. flag no lee WA_AUTOMATIONS_ENABLED', !flagSrc.includes('WA_AUTOMATIONS_ENABLED'))
  check('H2. flag exige el string exacto true', /process\.env\.GENESIS_ENABLED === 'true'/.test(flagSrc))
  check('H3. WhatsApp manual no usa GENESIS_ENABLED ni maybeGenesisRespond', !/GENESIS_ENABLED|isGenesisEnabled|maybeGenesisRespond/.test(manualWa))
  check('H4. Broadcast no usa GENESIS_ENABLED', !/GENESIS_ENABLED|isGenesisEnabled/.test(broadcastCfg))
  check('H5. simulador no usa GENESIS_ENABLED ni maybeGenesisRespond', !/GENESIS_ENABLED|isGenesisEnabled|maybeGenesisRespond/.test(simulator))
  check('H6. respond.ts no toca la tabla orders', !/from\(['"]orders['"]\)/.test(respondSrc))
  check('H7. ningún caso dinámico tocó orders', totalOrdersTouched === 0, totalOrdersTouched)
}

main()
  .catch(err => { failures++; console.error('❌ error inesperado:', err) })
  .finally(() => {
    if (savedFlag === undefined) delete process.env.GENESIS_ENABLED; else process.env.GENESIS_ENABLED = savedFlag
    if (savedAuto === undefined) delete process.env.WA_AUTOMATIONS_ENABLED; else process.env.WA_AUTOMATIONS_ENABLED = savedAuto
    console.log(`\n${failures === 0 ? '✅ TODO OK' : `❌ ${failures} fallo(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
  })
