// Pruebas del orquestador de Génesis (maybeGenesisRespond) — Fase 1B,
// validación real post-integración.
//
// Corre con: npx tsx scripts/test-genesis-respond-orchestrator.ts
// (o: npm run test:genesis-respond-orchestrator)
//
// Objetivo: probar el flujo completo de src/lib/genesis/respond.ts
// (claim → renew → OpenAI → renew → begin_send → Meta → INSERT → finish)
// SIN llamar nunca a OpenAI ni a Meta reales. maybeGenesisRespond acepta un
// 5º parámetro opcional `deps` (callOpenAI/sendWhatsAppText inyectables)
// agregado exclusivamente para esto — el webhook (único caller de
// producción) nunca lo pasa, así que el comportamiento en producción es
// idéntico a antes de este cambio.
//
// Las RPCs (claim/renew/begin_send/finish_genesis_run) SÍ se ejecutan
// reales contra Supabase — no se mockean — porque son la infraestructura
// que Fase 1A/1A.1 ya validó por separado (scripts/test-genesis-run-rpcs.ts)
// y el objetivo aquí es probar que el ORQUESTADOR las invoca en el orden y
// con los datos correctos, no reprobar las RPCs en sí.
//
// REQUIERE que las migraciones 055-059 (con la corrección de attempt_count)
// ya estén aplicadas. Datos de prueba: tienda dedicada
// (AUDIT_GENESIS_RESPOND_TEST_STORE_DELETE_ME), todo con prefijo
// AUDIT_GENESIS_TEST, limpiado en cleanup() dentro de un try/finally con
// timeout global — mismo patrón que los otros 2 scripts de esta familia.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { maybeGenesisRespond, type CallOpenAIFn, type SendWhatsAppTextFn } from '../src/lib/genesis/respond'

const envRaw = readFileSync('.env.local', 'utf8')
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] = m[2]
}
const URL         = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const svc = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

interface Fixtures {
  testStoreId:  string | null
  authUserIds:  Set<string>
}

const GLOBAL_TIMEOUT_MS = 120_000
class TestTimeoutError extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TestTimeoutError(`Timeout de ${ms}ms excedido en: ${label}`)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer)) as Promise<T>
}

// ============================================================
// Helpers de fixtures — mismo patrón que los otros 2 scripts de esta familia
// ============================================================
async function makeConversation(storeId: string, label: string) {
  const phone = `1849000${Math.floor(Math.random() * 9000 + 1000)}`
  const { data: contact, error: cErr } = await svc.from('wa_contacts').insert({
    store_id: storeId, phone_normalized: phone, wa_id: phone, display_name: `AUDIT_GENESIS_TEST ${label}`,
  }).select('id').single()
  if (cErr) throw cErr
  const { data: conv, error: convErr } = await svc.from('wa_conversations').insert({
    store_id: storeId, contact_id: contact!.id, status: 'open',
  }).select('id').single()
  if (convErr) throw convErr
  return conv!.id as string
}

async function makeMessage(storeId: string, conversationId: string, direction: 'inbound' | 'outbound', label: string) {
  const waMsgId = `AUDIT_GENESIS_TEST.${label}.${randomUUID()}`
  const { data, error } = await svc.from('wa_messages').insert({
    store_id: storeId, conversation_id: conversationId, wa_msg_id: waMsgId,
    direction, message_type: 'text', body: `AUDIT_GENESIS_TEST ${label}`, status: direction === 'inbound' ? 'received' : 'sent',
    sent_at: new Date().toISOString(),
  }).select('id').single()
  if (error) throw error
  return data!.id as string
}

async function makeAuthedSession(role: string, storeId: string, label: string, fixtures: Fixtures): Promise<SupabaseClient> {
  const email = `audit-genesis-orch-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@controlcod.test`.toLowerCase()
  const password = `Audit-${Date.now()}-!Aa1`
  const { data: created, error: createErr } = await svc.auth.admin.createUser({ email, password, email_confirm: true })
  if (createErr) throw createErr
  const userId = created.user!.id
  fixtures.authUserIds.add(userId)
  const { error: upsertErr } = await svc.from('profiles').upsert({
    id: userId, role, store_id: storeId, full_name: `AUDIT_GENESIS_TEST ${label}`,
  })
  if (upsertErr) throw upsertErr
  const client = createClient(URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
  if (signInErr) throw signInErr
  return client
}

async function getRun(conversationId: string) {
  const { data } = await svc
    .from('genesis_message_runs')
    .select('id, status, failure_code, outbound_message_id, meta_message_id, lock_token')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data as { id: string; status: string; failure_code: string | null; outbound_message_id: string | null; meta_message_id: string | null; lock_token: string | null } | null
}

// Fábricas de dobles de prueba — nunca llaman a OpenAI/Meta reales.
function fakeOpenAI(
  result: Awaited<ReturnType<CallOpenAIFn>>,
  sideEffect?: () => Promise<void>,
): { fn: CallOpenAIFn; calls: number[] } {
  const calls: number[] = []
  const fn: CallOpenAIFn = async () => {
    calls.push(Date.now())
    if (sideEffect) await sideEffect()
    return result
  }
  return { fn, calls }
}

function fakeSend(
  result: Awaited<ReturnType<SendWhatsAppTextFn>>,
): { fn: SendWhatsAppTextFn; calls: number[] } {
  const calls: number[] = []
  const fn: SendWhatsAppTextFn = async () => {
    calls.push(Date.now())
    return result
  }
  return { fn, calls }
}

// ============================================================
// Limpieza — mismo diseño que los otros 2 scripts
// ============================================================
async function safeDelete(label: string, fn: () => PromiseLike<{ error: { message: string } | null }>, errors: string[]) {
  try {
    const { error } = await fn()
    if (error) errors.push(`${label}: ${error.message}`)
  } catch (e) {
    errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function cleanup(fixtures: Fixtures) {
  console.log('\n=== Limpieza ===')
  const errors: string[] = []

  if (fixtures.testStoreId) {
    const storeId = fixtures.testStoreId
    // Romper el ciclo de FK genesis_escalations ↔ genesis_message_runs
    // antes de borrar cualquiera de las dos (no se usan escalamientos en
    // este script, pero el orden se mantiene por consistencia/seguridad).
    await safeDelete('genesis_message_runs.escalation_id → NULL', () => svc.from('genesis_message_runs').update({ escalation_id: null }).eq('store_id', storeId), errors)
    await safeDelete('genesis_escalations', () => svc.from('genesis_escalations').delete().eq('store_id', storeId), errors)
    await safeDelete('genesis_message_runs', () => svc.from('genesis_message_runs').delete().eq('store_id', storeId), errors)
    await safeDelete('wa_messages', () => svc.from('wa_messages').delete().eq('store_id', storeId), errors)
    await safeDelete('wa_conversations', () => svc.from('wa_conversations').delete().eq('store_id', storeId), errors)
    await safeDelete('wa_contacts', () => svc.from('wa_contacts').delete().eq('store_id', storeId), errors)
    await safeDelete('ai_agent_config', () => svc.from('ai_agent_config').delete().eq('store_id', storeId), errors)
  }

  for (const uid of fixtures.authUserIds) {
    await safeDelete(`profiles ${uid}`, () => svc.from('profiles').delete().eq('id', uid), errors)
    await safeDelete(`auth.users ${uid}`, async () => {
      const { error } = await svc.auth.admin.deleteUser(uid)
      return { error }
    }, errors)
  }

  if (fixtures.testStoreId) {
    await safeDelete('stores', () => svc.from('stores').delete().eq('id', fixtures.testStoreId!), errors)
  }

  if (errors.length > 0) {
    console.error(`⚠️  ${errors.length} error(es) durante la limpieza (no fatal, reportado para diagnóstico manual):`)
    for (const e of errors) console.error(`   - ${e}`)
  }

  if (fixtures.testStoreId) {
    const verify = await svc.from('genesis_message_runs').select('id', { count: 'exact', head: true }).eq('store_id', fixtures.testStoreId)
    check('Limpieza verificada: 0 runs de prueba restantes', (verify.count ?? 0) === 0, { remaining: verify.count })
  }
}

// ============================================================
// Setup + escenarios
// ============================================================
async function runScenarios(fixtures: Fixtures) {
  const { data: testStore, error: storeErr } = await svc.from('stores').insert({
    name: 'AUDIT_GENESIS_RESPOND_TEST_STORE_DELETE_ME', slug: `audit-genesis-respond-test-${Date.now()}`, is_active: true,
  }).select('id').single()
  if (storeErr) throw storeErr
  fixtures.testStoreId = testStore!.id as string
  const storeA = fixtures.testStoreId

  const { error: cfgErr } = await svc.from('ai_agent_config').insert({
    store_id: storeA, is_active: true, mode: 'auto', provider: 'openai', api_key_ref: 'AUDIT_FAKE_OPENAI_KEY', agent_name: 'AUDIT_GENESIS_TEST',
  })
  if (cfgErr) throw cfgErr
  // api_key_ref apunta a una env var que sí existe (con cualquier valor) —
  // maybeGenesisRespond exige que exista, pero como callOpenAI está
  // inyectado con un doble de prueba, el valor real de la key es
  // irrelevante — nunca se usa para llamar a OpenAI de verdad.
  process.env.AUDIT_FAKE_OPENAI_KEY = 'sk-fake-not-a-real-key'

  console.log('\n=== Setup listo — corriendo escenarios del orquestador ===\n')

  // 1. OpenAI éxito + Meta éxito + INSERT éxito → sent
  {
    const conv = await makeConversation(storeA, 'orch1')
    const msg = await makeMessage(storeA, conv, 'inbound', 'orch1')
    const wamid = `AUDIT_GENESIS_TEST.wamid.${randomUUID()}`
    const openai = fakeOpenAI({ ok: true, text: 'Respuesta de prueba AUDIT_GENESIS_TEST' })
    const send = fakeSend({ ok: true, wamid })
    await maybeGenesisRespond(svc, storeA, conv, msg, { callOpenAI: openai.fn, sendWhatsAppText: send.fn })
    const run = await getRun(conv)
    check('1. OpenAI+Meta+INSERT éxito → status=sent, outbound_message_id y meta_message_id poblados',
      run?.status === 'sent' && !!run.outbound_message_id && run.meta_message_id === wamid, run)
  }

  // 2. OpenAI falla → failed_retryable, failure_code=openai_error
  {
    const conv = await makeConversation(storeA, 'orch2')
    const msg = await makeMessage(storeA, conv, 'inbound', 'orch2')
    const openai = fakeOpenAI({ ok: false, kind: 'error' })
    const send = fakeSend({ ok: true, wamid: 'unused' })
    await maybeGenesisRespond(svc, storeA, conv, msg, { callOpenAI: openai.fn, sendWhatsAppText: send.fn })
    const run = await getRun(conv)
    check('2. OpenAI falla → status=failed_retryable, failure_code=openai_error, Meta nunca llamado',
      run?.status === 'failed_retryable' && run.failure_code === 'openai_error' && send.calls.length === 0, run)
  }

  // 3. OpenAI timeout → failed_retryable, failure_code=openai_timeout
  {
    const conv = await makeConversation(storeA, 'orch3')
    const msg = await makeMessage(storeA, conv, 'inbound', 'orch3')
    const openai = fakeOpenAI({ ok: false, kind: 'timeout' })
    const send = fakeSend({ ok: true, wamid: 'unused' })
    await maybeGenesisRespond(svc, storeA, conv, msg, { callOpenAI: openai.fn, sendWhatsAppText: send.fn })
    const run = await getRun(conv)
    check('3. OpenAI timeout → status=failed_retryable, failure_code=openai_timeout, Meta nunca llamado',
      run?.status === 'failed_retryable' && run.failure_code === 'openai_timeout' && send.calls.length === 0, run)
  }

  // 4. Meta HTTP error → failed_retryable, failure_code=meta_http_error
  {
    const conv = await makeConversation(storeA, 'orch4')
    const msg = await makeMessage(storeA, conv, 'inbound', 'orch4')
    const openai = fakeOpenAI({ ok: true, text: 'Respuesta AUDIT_GENESIS_TEST' })
    const send = fakeSend({ ok: false, kind: 'http_error', error: 'Meta API error 400: bad request (simulado)' })
    await maybeGenesisRespond(svc, storeA, conv, msg, { callOpenAI: openai.fn, sendWhatsAppText: send.fn })
    const run = await getRun(conv)
    check('4. Meta http_error → status=failed_retryable, failure_code=meta_http_error',
      run?.status === 'failed_retryable' && run.failure_code === 'meta_http_error', run)
  }

  // 5. Meta network error/timeout → send_unknown, nunca reintenta
  {
    const conv = await makeConversation(storeA, 'orch5')
    const msg = await makeMessage(storeA, conv, 'inbound', 'orch5')
    const openai = fakeOpenAI({ ok: true, text: 'Respuesta AUDIT_GENESIS_TEST' })
    const send = fakeSend({ ok: false, kind: 'network_error', error: 'Timeout tras 10000ms (simulado)' })
    await maybeGenesisRespond(svc, storeA, conv, msg, { callOpenAI: openai.fn, sendWhatsAppText: send.fn })
    const run = await getRun(conv)
    check('5. Meta network_error/timeout → status=send_unknown',
      run?.status === 'send_unknown', run)
  }

  // 6. Humano toma el chat antes de begin_send → skipped_human_active
  //    (fijado por take_genesis_conversation directamente, NO por finishRun
  //    — finish_genesis_run no acepta 'skipped_human_active' como outcome).
  {
    const conv = await makeConversation(storeA, 'orch6')
    const msg = await makeMessage(storeA, conv, 'inbound', 'orch6')
    const agentSession = await makeAuthedSession('admin', storeA, 'orch6agent', fixtures)
    const openai = fakeOpenAI({ ok: true, text: 'Respuesta AUDIT_GENESIS_TEST' }, async () => {
      // Efecto lateral dentro de la "generación" — simula que un humano
      // toma la conversación mientras OpenAI está pensando.
      const { error } = await agentSession.rpc('take_genesis_conversation', { p_conversation_id: conv })
      if (error) throw error
    })
    const send = fakeSend({ ok: true, wamid: 'unused' })
    await maybeGenesisRespond(svc, storeA, conv, msg, { callOpenAI: openai.fn, sendWhatsAppText: send.fn })
    const run = await getRun(conv)
    check('6. Humano toma el chat antes de begin_send → status=skipped_human_active, Meta nunca llamado',
      run?.status === 'skipped_human_active' && send.calls.length === 0, run)
  }

  // 7. Escalamiento invalida el run antes de begin_send → escalated
  {
    const conv = await makeConversation(storeA, 'orch7')
    const msg = await makeMessage(storeA, conv, 'inbound', 'orch7')
    const openai = fakeOpenAI({ ok: true, text: 'Respuesta AUDIT_GENESIS_TEST' }, async () => {
      const { error } = await svc.rpc('escalate_genesis_conversation', {
        p_conversation_id: conv, p_run_id: null, p_reason: 'fraud', p_summary: 'AUDIT_GENESIS_TEST — escalamiento simulado durante generación',
      })
      if (error) throw error
    })
    const send = fakeSend({ ok: true, wamid: 'unused' })
    await maybeGenesisRespond(svc, storeA, conv, msg, { callOpenAI: openai.fn, sendWhatsAppText: send.fn })
    const run = await getRun(conv)
    check('7. Escalamiento durante generación → status=escalated, Meta nunca llamado',
      run?.status === 'escalated' && send.calls.length === 0, run)
  }

  // 8. Lock perdido — otra ejecución reclama el mismo run (retry_claimed)
  //    mientras el nuestro sigue "generando". Se detecta en el checkpoint 2
  //    (renew a 'generated', inmediatamente después de que OpenAI devuelve
  //    texto) — antes de llegar a begin_genesis_send. Mismo resultado
  //    funcional que perderlo justo antes de Meta: nunca se llama a Meta,
  //    el run no se sobrescribe con datos de nuestra ejecución.
  {
    const conv = await makeConversation(storeA, 'orch8')
    const msg = await makeMessage(storeA, conv, 'inbound', 'orch8')
    const openai = fakeOpenAI({ ok: true, text: 'Respuesta AUDIT_GENESIS_TEST' }, async () => {
      const run = await getRun(conv)
      if (!run) throw new Error('orch8: run no encontrado antes del robo de lock')
      await svc.from('genesis_message_runs').update({ lock_expires_at: new Date(Date.now() - 5000).toISOString() }).eq('id', run.id)
      const { error } = await svc.rpc('claim_genesis_run', {
        p_conversation_id: conv, p_inbound_message_id: msg, p_lock_token: randomUUID(), p_ttl_seconds: 60,
      })
      if (error) throw error
    })
    const send = fakeSend({ ok: true, wamid: 'unused' })
    await maybeGenesisRespond(svc, storeA, conv, msg, { callOpenAI: openai.fn, sendWhatsAppText: send.fn })
    const run = await getRun(conv)
    check('8. Lock robado por otra ejecución (retry_claimed) → Meta nunca llamado, run no queda sent',
      send.calls.length === 0 && run?.status !== 'sent', run)
  }

  // 9. INSERT outbound falla después de Meta (wa_msg_id duplicado) →
  //    meta_message_id queda poblado, run NO queda 'sent', no hay reenvío.
  {
    const conv = await makeConversation(storeA, 'orch9')
    const msg = await makeMessage(storeA, conv, 'inbound', 'orch9')
    const dupWamid = `AUDIT_GENESIS_TEST.dup.${randomUUID()}`
    // Pre-insertar un mensaje con ESE wa_msg_id — el INSERT real del
    // outbound de maybeGenesisRespond chocará con UNIQUE(wa_msg_id).
    await svc.from('wa_messages').insert({
      store_id: storeA, conversation_id: conv, wa_msg_id: dupWamid, direction: 'outbound',
      message_type: 'text', body: 'AUDIT_GENESIS_TEST preexistente', status: 'sent', sent_at: new Date().toISOString(),
    })
    const openai = fakeOpenAI({ ok: true, text: 'Respuesta AUDIT_GENESIS_TEST' })
    const send = fakeSend({ ok: true, wamid: dupWamid })
    await maybeGenesisRespond(svc, storeA, conv, msg, { callOpenAI: openai.fn, sendWhatsAppText: send.fn })
    const run = await getRun(conv)
    check('9. INSERT outbound falla (wa_msg_id duplicado) → meta_message_id poblado, status≠sent',
      run?.meta_message_id === dupWamid && run.status !== 'sent', run)
    const { count: outboundCount } = await svc.from('wa_messages').select('id', { count: 'exact', head: true }).eq('conversation_id', conv).eq('wa_msg_id', dupWamid)
    check('9b. Solo existe 1 fila con ese wa_msg_id (no se duplicó el outbound)', outboundCount === 1, { outboundCount })
  }

  // 10. UPDATE de wa_conversations (preview) falla después del INSERT —
  //     NO se prueba dinámicamente: el UPDATE de preview no está detrás de
  //     una dependencia inyectable (solo callOpenAI/sendWhatsAppText lo
  //     están, por diseño mínimo — inyectar el cliente de Supabase completo
  //     hubiera sido un refactor mayor, fuera de alcance). Verificado por
  //     auditoría de código en su lugar: respond.ts captura `updateConvErr`
  //     de ese UPDATE, lo loguea como advertencia, y CONTINÚA sin
  //     condicionar el paso 10 (finish_genesis_run) a su resultado — ver
  //     el bloque inmediatamente posterior al INSERT de wa_messages en
  //     src/lib/genesis/respond.ts. No se reenvía nada en ningún caso.
  console.log('⚠️  10. UPDATE de conversación tras INSERT — verificado por auditoría de código, no dinámicamente (ver comentario arriba). No cuenta como ✅/❌.')

  // 11. Webhook duplicado del mismo inbound — segunda invocación con el
  //     MISMO mensaje tras completar la primera → already_sent, sin volver
  //     a llamar a OpenAI ni a Meta.
  {
    const conv = await makeConversation(storeA, 'orch11')
    const msg = await makeMessage(storeA, conv, 'inbound', 'orch11')
    const openai1 = fakeOpenAI({ ok: true, text: 'Respuesta AUDIT_GENESIS_TEST' })
    const send1 = fakeSend({ ok: true, wamid: `AUDIT_GENESIS_TEST.wamid.${randomUUID()}` })
    await maybeGenesisRespond(svc, storeA, conv, msg, { callOpenAI: openai1.fn, sendWhatsAppText: send1.fn })
    const runAfterFirst = await getRun(conv)
    check('11a. Primera invocación → status=sent', runAfterFirst?.status === 'sent', runAfterFirst)

    const openai2 = fakeOpenAI({ ok: true, text: 'NO DEBERÍA LLEGAR A GENERARSE' })
    const send2 = fakeSend({ ok: true, wamid: 'NO DEBERÍA LLEGAR A ENVIARSE' })
    await maybeGenesisRespond(svc, storeA, conv, msg, { callOpenAI: openai2.fn, sendWhatsAppText: send2.fn })
    check('11b. Segunda invocación (mismo inbound, retry de webhook) → NUNCA llama OpenAI ni Meta',
      openai2.calls.length === 0 && send2.calls.length === 0, { openaiCalls: openai2.calls.length, sendCalls: send2.calls.length })
    const { count: runCount11 } = await svc.from('genesis_message_runs').select('id', { count: 'exact', head: true }).eq('conversation_id', conv)
    check('11c. Sigue existiendo exactamente 1 run para esta conversación (no se creó uno segundo)', runCount11 === 1, { runCount11 })
  }

  // 12. Dos inbound DISTINTOS en la misma conversación, concurrentes → el
  //     segundo recibe conversation_busy en claim_genesis_run y nunca
  //     invoca sus propios dobles de OpenAI/Meta.
  {
    const conv = await makeConversation(storeA, 'orch12')
    const msgA = await makeMessage(storeA, conv, 'inbound', 'orch12a')
    const msgB = await makeMessage(storeA, conv, 'inbound', 'orch12b')

    let releaseA: () => void = () => {}
    const gateA = new Promise<void>(resolve => { releaseA = resolve })
    const openaiA = fakeOpenAI({ ok: true, text: 'Respuesta A AUDIT_GENESIS_TEST' }, async () => { await gateA })
    const sendA = fakeSend({ ok: true, wamid: `AUDIT_GENESIS_TEST.wamid.${randomUUID()}` })

    const openaiB = fakeOpenAI({ ok: true, text: 'NO DEBERÍA LLEGAR A GENERARSE' })
    const sendB = fakeSend({ ok: true, wamid: 'NO DEBERÍA LLEGAR A ENVIARSE' })

    // A empieza y se queda "pensando" (gateA aún no liberado) — B se lanza
    // mientras A sigue activo con el run reclamado.
    const promiseA = maybeGenesisRespond(svc, storeA, conv, msgA, { callOpenAI: openaiA.fn, sendWhatsAppText: sendA.fn })
    // Pequeño margen para asegurar que A ya reclamó (claim) antes de B —
    // sin esto la carrera sería válida igual (ambos protegidos por el lock
    // de wa_conversations), pero así el resultado es determinístico para
    // el assert.
    await new Promise(res => setTimeout(res, 300))
    const promiseB = maybeGenesisRespond(svc, storeA, conv, msgB, { callOpenAI: openaiB.fn, sendWhatsAppText: sendB.fn })
    await promiseB
    check('12a. Mensaje B (mismo conv, mientras A sigue activo) → NUNCA llama su propio OpenAI ni Meta',
      openaiB.calls.length === 0 && sendB.calls.length === 0, { openaiBCalls: openaiB.calls.length, sendBCalls: sendB.calls.length })

    releaseA()
    await promiseA
    const runA = await getRun(conv)
    check('12b. Mensaje A completa normalmente → status=sent', runA?.status === 'sent', runA)

    const { count: activeRunsConv12 } = await svc.from('genesis_message_runs')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conv)
      .in('status', ['claimed', 'processing', 'generated', 'sending'])
    check('12c. Cero runs activos tras completar A (B nunca creó uno propio)', activeRunsConv12 === 0, { activeRunsConv12 })
  }
}

// ============================================================
// Entrypoint
// ============================================================
async function main() {
  const fixtures: Fixtures = { testStoreId: null, authUserIds: new Set<string>() }
  let fatalError: unknown = null

  try {
    await withTimeout(runScenarios(fixtures), GLOBAL_TIMEOUT_MS, 'ejecución completa de los 12 escenarios del orquestador')
  } catch (e) {
    fatalError = e
    console.error('\n❌ Excepción no controlada durante los escenarios:', e)
  } finally {
    await cleanup(fixtures)
  }

  if (fatalError) {
    console.error('\nEl script abortó por una excepción (ver arriba). La limpieza ya se ejecutó.')
    process.exit(1)
  }
  if (failures > 0) {
    console.error(`\n${failures} escenario(s) fallaron.`)
    process.exit(1)
  }
  console.log('\nTodos los escenarios del orquestador pasaron (sin llamar a OpenAI ni Meta reales).')
}

main().catch(e => { console.error('TEST SCRIPT FAILED (fuera del try/finally esperado):', e); process.exit(1) })
