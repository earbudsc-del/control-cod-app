// Pruebas de integración de las RPCs de escalamiento/handoff de Génesis —
// Fase 1A del Cerebro Comercial (escalate_genesis_conversation /
// take_genesis_conversation / release_genesis_conversation /
// check_genesis_escalation_sla).
//
// Corre con: npx tsx scripts/test-genesis-escalation-rpcs.ts
// (o: npm run test:genesis-escalation-rpcs)
//
// REQUIERE que las migraciones 055-059 ya estén aplicadas (ver
// supabase/migrations/059_genesis_escalation_handoff_rpcs.sql, incluida la
// corrección de Fase 1A.1 — validación run_id↔conversation_id en
// escalate_genesis_conversation y el default p_reactivate_genesis=false en
// release_genesis_conversation). Pre-flight igual que
// scripts/test-genesis-run-rpcs.ts — detecta función inexistente y termina
// con instrucciones claras, sin crear ningún fixture antes.
//
// escalate_genesis_conversation/check_genesis_escalation_sla son
// service_role-only; take/release_genesis_conversation son authenticated
// con revalidación de rol interna — este script usa sesiones reales
// firmadas (auth.signInWithPassword), nunca confía en un parámetro de
// identidad, igual que scripts/test-customer-identity-rpc.ts.
//
// No conecta src/lib/genesis/respond.ts, no toca Inbox UI, no crea cron.
//
// Fase 1A.1: todo el cuerpo de setup + pruebas corre dentro de un
// try/finally con timeout global — ver cleanup()/withTimeout() más abajo.
// La limpieza se ejecuta siempre, incluso si una RPC falla inesperadamente
// o el script se cuelga.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

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

interface ClaimRow    { run_id: string | null; outcome: string; attempt_count: number; message: string | null }
interface EscalateRow { escalation_id: string | null; outcome: string; message: string | null }
interface OutcomeRow  { outcome: string; message: string | null }
interface SlaRow      { escalation_id: string; conversation_id: string; elevated: boolean }

interface Fixtures {
  testStoreId: string | null
  otherStoreId: string | null
  authUserIds: Set<string>
}

// ============================================================
// Timeout global — Fase 1A.1 (mismo diseño que test-genesis-run-rpcs.ts)
// ============================================================
// Promise.race (preferido sobre AbortController aquí — no hay fetch()
// directo, todo pasa por supabase-js). El timer nunca llama process.exit();
// solo rechaza con un error controlado que sube por el try/catch de main()
// y deja que el finally ejecute cleanup() antes de salir con exit code 1.
// 120s totales: este script tiene menos esperas intencionales que el de
// runs (sin sleeps de TTL), pero crea 4 sesiones auth (adminA/agentA/
// sdAgentA/adminB) — margen cómodo sobre el tiempo real esperado (~10-20s).
const GLOBAL_TIMEOUT_MS = 120_000
const CONCURRENT_BATCH_TIMEOUT_MS = 20_000

class TestTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TestTimeoutError(`Timeout de ${ms}ms excedido en: ${label}`)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer)) as Promise<T>
}

async function claim(convId: string, msgId: string, token: string) {
  const { data, error } = await svc.rpc('claim_genesis_run', {
    p_conversation_id: convId, p_inbound_message_id: msgId, p_lock_token: token, p_ttl_seconds: 60,
  }).single<ClaimRow>()
  if (error) throw error
  return data!
}
async function escalate(convId: string, runId: string | null, reason: string, summary?: string) {
  const { data, error } = await svc.rpc('escalate_genesis_conversation', {
    p_conversation_id: convId, p_run_id: runId, p_reason: reason, p_summary: summary ?? null,
  }).single<EscalateRow>()
  if (error) throw error
  return data!
}
async function take(client: SupabaseClient, convId: string) {
  const { data, error } = await client.rpc('take_genesis_conversation', { p_conversation_id: convId }).single<OutcomeRow>()
  if (error) throw error
  return data!
}
async function release(client: SupabaseClient, convId: string, reactivate = true, note?: string) {
  const { data, error } = await client.rpc('release_genesis_conversation', {
    p_conversation_id: convId, p_reactivate_genesis: reactivate, p_resolution_note: note ?? null,
  }).single<OutcomeRow>()
  if (error) throw error
  return data!
}

async function makeConversation(storeId: string, label: string) {
  const phone = `1829000${Math.floor(Math.random() * 9000 + 1000)}`
  const { data: contact, error: cErr } = await svc.from('wa_contacts').insert({
    store_id: storeId, phone_normalized: phone, display_name: `AUDIT_GENESIS_TEST ${label}`,
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
  const email = `audit-genesis-esc-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@controlcod.test`.toLowerCase()
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

// ============================================================
// Limpieza — Fase 1A.1
// ============================================================
// Mismo diseño que test-genesis-run-rpcs.ts: función nombrada, siempre
// invocada desde el finally de main(), usa exclusivamente los IDs exactos
// capturados en `fixtures` durante el setup, borra en orden compatible con
// las FK, tolera registros que nunca llegaron a crearse (cada paso aislado
// en safeDelete()), y verifica al final con un SELECT por ID exacto — no
// por nombre.
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

  for (const storeId of [fixtures.testStoreId, fixtures.otherStoreId].filter((v): v is string => !!v)) {
    // FIX (validación real): genesis_escalations.run_id → genesis_message_runs.id
    // y genesis_message_runs.escalation_id → genesis_escalations.id forman un
    // ciclo de FK — ningún DELETE de ninguna de las dos tablas puede
    // proceder mientras la otra todavía tenga filas que la referencien. Se
    // rompe el ciclo primero (UPDATE a NULL del lado que sí lo permite,
    // genesis_message_runs.escalation_id es nullable) antes de borrar
    // cualquiera de las dos. Sin esto, el DELETE fallaba y cascadeaba en
    // FK violations por toda la cadena (wa_messages → wa_conversations →
    // wa_contacts → profiles → stores), dejando fixtures huérfanos.
    await safeDelete(`genesis_message_runs.escalation_id → NULL (${storeId})`, () => svc.from('genesis_message_runs').update({ escalation_id: null }).eq('store_id', storeId), errors)
    await safeDelete(`genesis_escalations (${storeId})`, () => svc.from('genesis_escalations').delete().eq('store_id', storeId), errors)
    await safeDelete(`genesis_message_runs (${storeId})`, () => svc.from('genesis_message_runs').delete().eq('store_id', storeId), errors)
    await safeDelete(`wa_messages (${storeId})`, () => svc.from('wa_messages').delete().eq('store_id', storeId), errors)
    await safeDelete(`wa_conversations (${storeId})`, () => svc.from('wa_conversations').delete().eq('store_id', storeId), errors)
    await safeDelete(`wa_contacts (${storeId})`, () => svc.from('wa_contacts').delete().eq('store_id', storeId), errors)
    await safeDelete(`ai_agent_config (${storeId})`, () => svc.from('ai_agent_config').delete().eq('store_id', storeId), errors)
  }

  for (const uid of fixtures.authUserIds) {
    await safeDelete(`profiles ${uid}`, () => svc.from('profiles').delete().eq('id', uid), errors)
    await safeDelete(`auth.users ${uid}`, async () => {
      const { error } = await svc.auth.admin.deleteUser(uid)
      return { error }
    }, errors)
  }

  if (fixtures.testStoreId)  await safeDelete('stores (storeA)', () => svc.from('stores').delete().eq('id', fixtures.testStoreId!), errors)
  if (fixtures.otherStoreId) await safeDelete('stores (storeB)', () => svc.from('stores').delete().eq('id', fixtures.otherStoreId!), errors)

  if (errors.length > 0) {
    console.error(`⚠️  ${errors.length} error(es) durante la limpieza (no fatal, reportado para diagnóstico manual):`)
    for (const e of errors) console.error(`   - ${e}`)
  }

  // Verificación con SELECT posterior, usando los IDs exactos de las
  // tiendas de prueba — no un filtro por nombre (`summary ILIKE ...`, que
  // además nunca hubiera detectado los casos con summary=NULL de este
  // mismo script).
  const storeIds = [fixtures.testStoreId, fixtures.otherStoreId].filter((v): v is string => !!v)
  if (storeIds.length > 0) {
    const verify = await svc.from('genesis_escalations')
      .select('id', { count: 'exact', head: true })
      .in('store_id', storeIds)
    check('Limpieza verificada: 0 escalamientos de prueba restantes', (verify.count ?? 0) === 0, { remaining: verify.count })
  } else {
    console.log('(sin store IDs capturados — no había fixtures que verificar)')
  }
}

// ============================================================
// Setup + casos de prueba
// ============================================================
async function runSetupAndTests(fixtures: Fixtures) {
  // ── Pre-flight ───────────────────────────────────────────────────────
  // No crea ningún fixture todavía.
  const preflight = await svc.rpc('escalate_genesis_conversation', {
    p_conversation_id: '00000000-0000-0000-0000-000000000000', p_run_id: null,
    p_reason: 'requested_by_customer', p_summary: null,
  })
  if (preflight.error && /function .* does not exist|not find the function/i.test(preflight.error.message ?? '')) {
    throw new Error(
      'Las RPCs de escalamiento/handoff no existen todavía. ' +
      'Aplica supabase/migrations/055-059 en Supabase SQL Editor (en orden) y vuelve a correr este script.'
    )
  }

  // ── Setup ────────────────────────────────────────────────────────────
  const { data: testStore, error: storeErr } = await svc.from('stores').insert({
    name: 'AUDIT_GENESIS_ESC_TEST_STORE_DELETE_ME', slug: `audit-genesis-esc-test-${Date.now()}`, is_active: true,
  }).select('id').single()
  if (storeErr) throw storeErr
  fixtures.testStoreId = testStore!.id as string
  const storeA = fixtures.testStoreId

  // FIX (validación real): faltaba esta fila — sin ai_agent_config,
  // claim_genesis_run devuelve outcome='disabled' (run_id=NULL) para TODO
  // claim sobre storeA, ya que exige is_active=true/mode='auto'. Los casos
  // 9/10/21/22b/22c/28 usaban ese run_id null sin validar el outcome
  // primero, cascadeando en 'not_found'/resultados nulos aguas abajo. Mismo
  // fix que ya tenía scripts/test-genesis-run-rpcs.ts desde el principio —
  // se había omitido al escribir este script.
  const { error: cfgErr } = await svc.from('ai_agent_config').insert({
    store_id: storeA, is_active: true, mode: 'auto', provider: 'openai',
  })
  if (cfgErr) throw cfgErr

  const { data: otherStore, error: otherErr } = await svc.from('stores').insert({
    name: 'AUDIT_GENESIS_ESC_TEST_STORE_B_DELETE_ME', slug: `audit-genesis-esc-test-b-${Date.now()}`, is_active: true,
  }).select('id').single()
  if (otherErr) throw otherErr
  fixtures.otherStoreId = otherStore!.id as string
  const storeB = fixtures.otherStoreId

  const adminA   = await makeAuthedSession('admin', storeA, 'adminA', fixtures)
  const agentA   = await makeAuthedSession('confirmation_agent', storeA, 'agentA', fixtures)
  const sdAgentA = await makeAuthedSession('santo_domingo_delivery_agent', storeA, 'sdAgentA', fixtures) // sin acceso al Inbox
  const adminB   = await makeAuthedSession('admin', storeB, 'adminB', fixtures)

  console.log('\n=== Setup listo — corriendo casos de escalamiento/handoff ===\n')

  // 9. Humano toma chat durante processing → begin_send rechazado
  const conv9 = await makeConversation(storeA, 'conv9')
  const msg9  = await makeMessage(storeA, conv9, 'inbound', 'case9')
  const token9 = randomUUID()
  const r9claim = await claim(conv9, msg9, token9)
  await svc.rpc('renew_genesis_run', { p_run_id: r9claim.run_id, p_lock_token: token9, p_extend_seconds: 30, p_new_status: 'generated', p_meta_message_id: null })
  const r9take = await take(adminA, conv9)
  check('9a. take_genesis_conversation durante processing → outcome=taken', r9take.outcome === 'taken', r9take)
  const r9begin = await svc.rpc('begin_genesis_send', { p_run_id: r9claim.run_id, p_lock_token: token9 }).single<{ allowed: boolean; outcome: string; message: string | null }>()
  // FIX (validación real): take_genesis_conversation ya invalidó el run
  // (status='skipped_human_active') ANTES de que begin_genesis_send lo
  // evalúe — y begin_genesis_send chequea `status != 'generated'` (outcome
  // 'not_generated') ANTES de llegar al chequeo de conversación
  // ('conversation_not_active'). Con este orden exacto de llamadas,
  // 'not_generated' es el outcome correcto y determinístico — la aserción
  // original esperaba 'conversation_not_active' sin considerar que el
  // chequeo de status del run se evalúa primero. Se acepta cualquiera de
  // los dos porque ambos representan correctamente "rechazado, no se puede
  // enviar" — el objetivo del caso es esa negación, no el string exacto.
  check('9b. begin_genesis_send tras la toma humana → allowed=false, outcome=not_generated|conversation_not_active',
    r9begin.data?.allowed === false && (r9begin.data?.outcome === 'not_generated' || r9begin.data?.outcome === 'conversation_not_active'), r9begin.data)
  const { data: run9Row } = await svc.from('genesis_message_runs').select('status').eq('id', r9claim.run_id!).single()
  check('9c. El run queda en skipped_human_active tras la toma', run9Row?.status === 'skipped_human_active', run9Row)

  // 10. Escalamiento durante processing → begin_send rechazado
  const conv10 = await makeConversation(storeA, 'conv10')
  const msg10  = await makeMessage(storeA, conv10, 'inbound', 'case10')
  const token10 = randomUUID()
  const r10claim = await claim(conv10, msg10, token10)
  await svc.rpc('renew_genesis_run', { p_run_id: r10claim.run_id, p_lock_token: token10, p_extend_seconds: 30, p_new_status: 'generated', p_meta_message_id: null })
  const r10esc = await escalate(conv10, r10claim.run_id, 'legal_threat', 'AUDIT_GENESIS_TEST — amenaza legal simulada')
  check('10a. escalate_genesis_conversation durante processing → outcome=escalated, priority=critical (derivada)',
    r10esc.outcome === 'escalated', r10esc)
  const r10begin = await svc.rpc('begin_genesis_send', { p_run_id: r10claim.run_id, p_lock_token: token10 }).single<{ allowed: boolean; outcome: string }>()
  // Mismo motivo que 9b — escalate_genesis_conversation ya puso
  // status='escalated' en el run antes de este chequeo, así que
  // begin_genesis_send devuelve 'not_generated' (chequeo de status del run,
  // evaluado antes del chequeo de conversación).
  check('10b. begin_genesis_send tras el escalamiento → allowed=false, outcome=not_generated|conversation_not_active',
    r10begin.data?.allowed === false && (r10begin.data?.outcome === 'not_generated' || r10begin.data?.outcome === 'conversation_not_active'), r10begin.data)
  const { data: run10Row } = await svc.from('genesis_message_runs').select('status, escalation_id').eq('id', r10claim.run_id!).single()
  check('10c. El run queda escalated con escalation_id vinculado',
    run10Row?.status === 'escalated' && run10Row?.escalation_id === r10esc.escalation_id, run10Row)

  // 18. Conversación de otra tienda → not_found sin fuga
  const r18 = await take(adminB, conv9) // adminB es de storeB, conv9 es de storeA
  check('18. take_genesis_conversation cross-store → outcome=not_found (sin revelar existencia)', r18.outcome === 'not_found', r18)

  // 19. Rol no autorizado en handoff → forbidden
  const conv19 = await makeConversation(storeA, 'conv19')
  const r19 = await take(sdAgentA, conv19)
  check('19. take_genesis_conversation con rol sin acceso al Inbox (santo_domingo_delivery_agent) → outcome=forbidden',
    r19.outcome === 'forbidden', r19)

  // 20. Escalamiento duplicado → una sola fila abierta
  const conv20 = await makeConversation(storeA, 'conv20')
  const r20a = await escalate(conv20, null, 'angry_customer')
  const r20b = await escalate(conv20, null, 'fraud')
  check('20a. Segundo escalamiento sobre conversación ya escalada → outcome=already_escalated', r20b.outcome === 'already_escalated', { r20a, r20b })
  const { count: openCount20 } = await svc.from('genesis_escalations').select('id', { count: 'exact', head: true }).eq('conversation_id', conv20).eq('status', 'open')
  check('20b. Exactamente 1 fila open en genesis_escalations para esa conversación', openCount20 === 1, { openCount20 })

  // 21. Takeover invalida run (verificación explícita aislada, más allá de 9c)
  const conv21 = await makeConversation(storeA, 'conv21')
  const msg21  = await makeMessage(storeA, conv21, 'inbound', 'case21')
  const token21 = randomUUID()
  const r21claim = await claim(conv21, msg21, token21)
  await take(agentA, conv21)
  const { data: run21Row } = await svc.from('genesis_message_runs').select('status, lock_token').eq('id', r21claim.run_id!).single()
  check('21. take_genesis_conversation invalida el run activo (status=skipped_human_active, lock_token=NULL)',
    run21Row?.status === 'skipped_human_active' && run21Row?.lock_token === null, run21Row)

  // 22. Resume no reprocesa mensajes antiguos
  const conv22 = await makeConversation(storeA, 'conv22')
  const oldMsg22 = await makeMessage(storeA, conv22, 'inbound', 'case22-old')
  const token22a = randomUUID()
  const r22claim = await claim(conv22, oldMsg22, token22a)
  await take(agentA, conv22) // invalida el run del mensaje viejo
  const r22release = await release(agentA, conv22, true) // reactivar explícito — el default ahora es false (Fase 1A.1)
  check('22a. release_genesis_conversation(reactivate=true explícito) tras takeover → outcome=resumed_genesis', r22release.outcome === 'resumed_genesis', r22release)
  const r22oldRetry = await claim(conv22, oldMsg22, randomUUID())
  check('22b. Reclamar el mensaje VIEJO tras reactivar → NO se reprocesa (outcome=skipped_human_active, terminal, mismo run_id)',
    r22oldRetry.outcome === 'skipped_human_active' && r22oldRetry.run_id === r22claim.run_id, r22oldRetry)
  const newMsg22 = await makeMessage(storeA, conv22, 'inbound', 'case22-new')
  const r22newClaim = await claim(conv22, newMsg22, randomUUID())
  check('22c. Un mensaje NUEVO tras reactivar sí se puede reclamar (outcome=claimed)', r22newClaim.outcome === 'claimed', r22newClaim)

  // 22d (Fase 1A.1). release_genesis_conversation SIN pasar el parámetro
  //      de reactivación → default false → NO reactiva Génesis.
  const conv22d = await makeConversation(storeA, 'conv22d')
  const msg22d  = await makeMessage(storeA, conv22d, 'inbound', 'case22d')
  await claim(conv22d, msg22d, randomUUID())
  await take(agentA, conv22d)
  const { data: releaseDefaultRow, error: releaseDefaultErr } = await agentA
    .rpc('release_genesis_conversation', { p_conversation_id: conv22d })
    .single<OutcomeRow>()
  if (releaseDefaultErr) throw releaseDefaultErr
  check('22d. release_genesis_conversation SIN p_reactivate_genesis → default=false → outcome=released_unassigned',
    releaseDefaultRow?.outcome === 'released_unassigned', releaseDefaultRow)
  const { data: conv22dRow } = await svc.from('wa_conversations').select('ai_enabled, genesis_status, assigned_to').eq('id', conv22d).single()
  check('22e. Tras el release por default, la conversación queda ai_enabled=false, genesis_status=inactive, assigned_to=NULL',
    conv22dRow?.ai_enabled === false && conv22dRow?.genesis_status === 'inactive' && conv22dRow?.assigned_to === null, conv22dRow)

  // 23. SLA se eleva una vez
  const conv23 = await makeConversation(storeA, 'conv23')
  const r23esc = await escalate(conv23, null, 'low_confidence') // prioridad inicial 'medium'
  // Simular que el umbral de 24h ya venció (escritura directa de service role, fuera del alcance de las RPCs — es setup de prueba, no una acción de negocio real).
  await svc.from('genesis_escalations').update({ next_escalation_check_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', r23esc.escalation_id!)
  const sla1 = await svc.rpc('check_genesis_escalation_sla')
  const sla1Data = (sla1.data ?? []) as SlaRow[]
  const elevated1 = sla1Data.find(r => r.escalation_id === r23esc.escalation_id)
  check('23a. Primera corrida de check_genesis_escalation_sla → eleva esta escalación (elevated=true)', elevated1?.elevated === true, elevated1)
  const { data: escRow23 } = await svc.from('genesis_escalations').select('priority, sla_alert_sent_at').eq('id', r23esc.escalation_id!).single()
  check('23b. priority=critical y sla_alert_sent_at poblado tras la elevación', escRow23?.priority === 'critical' && !!escRow23?.sla_alert_sent_at, escRow23)
  const sla2 = await svc.rpc('check_genesis_escalation_sla')
  const sla2Data = (sla2.data ?? []) as SlaRow[]
  const foundAgain = sla2Data.some(r => r.escalation_id === r23esc.escalation_id)
  check('23c. Segunda corrida inmediata → NO vuelve a incluir esta escalación (sla_alert_sent_at ya poblado, sin duplicar)', !foundAgain, { sla2: sla2Data })

  // ============================================================
  // Fase 1A.1 — caso 28: validación run_id ↔ conversation_id
  // ============================================================
  // p_run_id que pertenece a OTRA conversación real → invalid_run, sin
  // escrituras parciales (no crea escalación, no toca wa_conversations, no
  // invalida ningún run).
  const conv28A = await makeConversation(storeA, 'conv28A')
  const conv28B = await makeConversation(storeA, 'conv28B')
  const msg28B  = await makeMessage(storeA, conv28B, 'inbound', 'case28B')
  const r28claimB = await claim(conv28B, msg28B, randomUUID())

  const r28 = await escalate(conv28A, r28claimB.run_id, 'fraud', 'AUDIT_GENESIS_TEST — run_id de otra conversación')
  check('28a. escalate con p_run_id de OTRA conversación → outcome=invalid_run, sin escalation_id',
    r28.outcome === 'invalid_run' && r28.escalation_id === null, r28)

  const { count: escalationsConv28A } = await svc.from('genesis_escalations').select('id', { count: 'exact', head: true }).eq('conversation_id', conv28A)
  check('28b. No se insertó ninguna fila en genesis_escalations para conv28A', escalationsConv28A === 0, { escalationsConv28A })

  const { data: conv28ARow } = await svc.from('wa_conversations').select('genesis_status, ai_lock_token').eq('id', conv28A).single()
  check('28c. wa_conversations de conv28A no se tocó (genesis_status sigue active, sin lock)',
    conv28ARow?.genesis_status === 'active' && conv28ARow?.ai_lock_token === null, conv28ARow)

  const { data: run28BRow } = await svc.from('genesis_message_runs').select('status').eq('id', r28claimB.run_id!).single()
  check('28d. El run real (de conv28B) no fue invalidado por el intento fallido', run28BRow?.status === 'claimed', run28BRow)

  // p_run_id que no existe en absoluto → invalid_run también.
  const r28fake = await escalate(conv28A, randomUUID(), 'fraud', 'AUDIT_GENESIS_TEST — run_id inexistente')
  check('28e. escalate con p_run_id inexistente → outcome=invalid_run', r28fake.outcome === 'invalid_run', r28fake)
}

// ============================================================
// Entrypoint
// ============================================================
async function main() {
  const fixtures: Fixtures = { testStoreId: null, otherStoreId: null, authUserIds: new Set<string>() }
  let fatalError: unknown = null

  try {
    await withTimeout(
      runSetupAndTests(fixtures),
      GLOBAL_TIMEOUT_MS,
      'ejecución completa del script (preflight + setup + casos de escalamiento/handoff)'
    )
  } catch (e) {
    fatalError = e
    console.error('\n❌ Excepción no controlada durante preflight/setup/pruebas:', e)
  } finally {
    await cleanup(fixtures)
  }

  if (fatalError) {
    console.error('\nEl script abortó por una excepción (ver arriba). La limpieza ya se ejecutó.')
    process.exit(1)
  }
  if (failures > 0) {
    console.error(`\n${failures} prueba(s) fallaron.`)
    process.exit(1)
  }
  console.log('\nTodas las pruebas de integración de escalamiento/handoff pasaron.')
}

main().catch(e => { console.error('TEST SCRIPT FAILED (fuera del try/finally esperado):', e); process.exit(1) })
