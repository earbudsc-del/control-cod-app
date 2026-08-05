// Pruebas de integración de las RPCs de runs de Génesis — Fase 1A del
// Cerebro Comercial (claim_genesis_run / renew_genesis_run /
// begin_genesis_send / finish_genesis_run).
//
// Corre con: npx tsx scripts/test-genesis-run-rpcs.ts
// (o: npm run test:genesis-run-rpcs)
//
// REQUIERE que las migraciones 055-058 ya estén aplicadas en la base de
// datos (ver supabase/migrations/055_genesis_conversation_lock.sql,
// 056_genesis_message_runs.sql, 057_genesis_escalations.sql,
// 058_genesis_run_rpcs.sql, incluida la corrección de Fase 1A.1 —
// idx_genesis_runs_one_active_per_conversation y el outcome
// conversation_busy). Si las RPCs no existen todavía, este script lo
// detecta en el pre-flight y termina con un mensaje claro en vez de fallar
// a medias — mismo patrón que scripts/test-customer-identity-rpc.ts ya
// estableció en este proyecto.
//
// Las 4 RPCs de este archivo son GRANT EXECUTE exclusivamente a
// service_role (ver 058_genesis_run_rpcs.sql) — todas las llamadas de este
// script usan el cliente de service role, nunca una sesión de usuario. La
// única excepción es el caso 24 (RLS directo), que deliberadamente usa una
// sesión autenticada normal para confirmar que NO puede escribir la tabla
// directamente.
//
// No conecta src/lib/genesis/respond.ts — es un script de infraestructura
// pura, sin ningún cambio de comportamiento del sistema en producción.
//
// Datos de prueba: tienda dedicada (AUDIT_GENESIS_TEST_STORE_DELETE_ME),
// contactos/conversaciones/mensajes con prefijo AUDIT_GENESIS_TEST, todo se
// limpia al final — ver cleanup() más abajo. Fase 1A.1: todo el cuerpo de
// setup + pruebas corre dentro de un try/finally con timeout global — la
// limpieza se ejecuta SIEMPRE, incluso si una RPC falla inesperadamente o
// el script se cuelga.

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

interface ClaimRow  { run_id: string | null; outcome: string; attempt_count: number; message: string | null }
interface RenewRow  { outcome: string; message: string | null }
interface BeginRow  { allowed: boolean; outcome: string; message: string | null }
interface FinishRow { outcome: string; message: string | null }

interface Fixtures {
  testStoreId: string | null
  otherStoreId: string | null
  authUserIds: Set<string>
}

// ============================================================
// Timeout global — Fase 1A.1
// ============================================================
// Preferencia del encargo: Promise.race sobre AbortController (más simple,
// suficiente aquí — no hacemos fetch() directo, todo pasa por supabase-js).
// El timer NUNCA llama process.exit() — solo rechaza la promesa con un
// error controlado (TestTimeoutError), que sube por el try/catch normal de
// main() y deja que el finally ejecute cleanup() antes de salir con
// exit code 1. Documentado: 120s totales es margen cómodo para ~30 llamadas
// RPC + 2 esperas intencionales de 1.5s (casos 6/8) + creación de sesiones
// auth — muy por encima del tiempo real esperado (~15-30s), pero acotado.
const GLOBAL_TIMEOUT_MS = 120_000
// Timeout por grupo de llamadas concurrentes (Promise.all) — más corto que
// el global para poder señalar CUÁL grupo se colgó sin esperar los 120s
// completos.
const CONCURRENT_BATCH_TIMEOUT_MS = 20_000

class TestTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TestTimeoutError(`Timeout de ${ms}ms excedido en: ${label}`)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer)) as Promise<T>
}

async function claim(convId: string, msgId: string, token: string, ttl = 60) {
  const { data, error } = await svc.rpc('claim_genesis_run', {
    p_conversation_id: convId, p_inbound_message_id: msgId, p_lock_token: token, p_ttl_seconds: ttl,
  }).single<ClaimRow>()
  if (error) throw error
  return data!
}
async function renew(runId: string, token: string, extend = 30, newStatus: string | null = null, metaId: string | null = null) {
  const { data, error } = await svc.rpc('renew_genesis_run', {
    p_run_id: runId, p_lock_token: token, p_extend_seconds: extend, p_new_status: newStatus, p_meta_message_id: metaId,
  }).single<RenewRow>()
  if (error) throw error
  return data!
}
async function beginSend(runId: string, token: string) {
  const { data, error } = await svc.rpc('begin_genesis_send', { p_run_id: runId, p_lock_token: token }).single<BeginRow>()
  if (error) throw error
  return data!
}
async function finish(runId: string, token: string, outcome: string, opts: Partial<{
  meta_message_id: string; outbound_message_id: string; failure_code: string; failure_detail: object
}> = {}) {
  const { data, error } = await svc.rpc('finish_genesis_run', {
    p_run_id: runId, p_lock_token: token, p_outcome: outcome,
    p_meta_message_id: opts.meta_message_id ?? null,
    p_outbound_message_id: opts.outbound_message_id ?? null,
    p_failure_code: opts.failure_code ?? null,
    p_failure_detail: opts.failure_detail ?? null,
  }).single<FinishRow>()
  if (error) throw error
  return data!
}

async function makeConversation(storeId: string, label: string) {
  const phone = `1809000${Math.floor(Math.random() * 9000 + 1000)}`
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
  const email = `audit-genesis-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@controlcod.test`.toLowerCase()
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
// Diseño: función nombrada, siempre invocada desde el finally de main().
// Usa exclusivamente los IDs exactos capturados en `fixtures` durante el
// setup (nunca un filtro amplio por nombre) — borra en orden compatible
// con las FK (runs → messages/conversations → contacts/config → store,
// luego profiles/auth.users por separado). Cada paso está aislado en
// safeDelete(): si un registro nunca llegó a crearse (fixtures quedó a
// medias porque una excepción cortó el setup antes de tiempo), el DELETE
// simplemente afecta 0 filas — no es un error. Si un paso individual sí
// falla (red, permisos, etc.), se registra y se continúa con el resto en
// vez de abortar la limpieza completa.
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
    await safeDelete('genesis_message_runs (storeA)', () => svc.from('genesis_message_runs').delete().eq('store_id', storeId), errors)
    await safeDelete('wa_messages (storeA)', () => svc.from('wa_messages').delete().eq('store_id', storeId), errors)
    await safeDelete('wa_conversations (storeA)', () => svc.from('wa_conversations').delete().eq('store_id', storeId), errors)
    await safeDelete('wa_contacts (storeA)', () => svc.from('wa_contacts').delete().eq('store_id', storeId), errors)
    await safeDelete('ai_agent_config (storeA)', () => svc.from('ai_agent_config').delete().eq('store_id', storeId), errors)
  }

  for (const uid of fixtures.authUserIds) {
    await safeDelete(`profiles ${uid}`, () => svc.from('profiles').delete().eq('id', uid), errors)
    await safeDelete(`auth.users ${uid}`, async () => {
      const { error } = await svc.auth.admin.deleteUser(uid)
      return { error }
    }, errors)
  }

  if (fixtures.testStoreId) {
    await safeDelete('stores (storeA)', () => svc.from('stores').delete().eq('id', fixtures.testStoreId!), errors)
  }
  if (fixtures.otherStoreId) {
    await safeDelete('stores (storeB)', () => svc.from('stores').delete().eq('id', fixtures.otherStoreId!), errors)
  }

  if (errors.length > 0) {
    console.error(`⚠️  ${errors.length} error(es) durante la limpieza (no fatal, reportado para diagnóstico manual):`)
    for (const e of errors) console.error(`   - ${e}`)
  }

  // Verificación con SELECT posterior, usando el ID exacto de la tienda —
  // no un filtro por nombre.
  if (fixtures.testStoreId) {
    const verify = await svc.from('genesis_message_runs')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', fixtures.testStoreId)
    check('Limpieza verificada: 0 runs de prueba restantes', (verify.count ?? 0) === 0, { remaining: verify.count })
  } else {
    console.log('(sin testStoreId capturado — no había fixtures que verificar)')
  }
}

// ============================================================
// Setup + casos de prueba
// ============================================================
async function runSetupAndTests(fixtures: Fixtures) {
  // ── Pre-flight: ¿existen las 4 RPCs? ────────────────────────────────
  // No crea ningún fixture todavía — si esto falla, cleanup() se ejecuta
  // igual desde el finally de main() pero no tiene nada que borrar.
  const preflight = await svc.rpc('claim_genesis_run', {
    p_conversation_id: '00000000-0000-0000-0000-000000000000',
    p_inbound_message_id: '00000000-0000-0000-0000-000000000000',
    p_lock_token: randomUUID(),
  })
  if (preflight.error && /function .* does not exist|not find the function/i.test(preflight.error.message ?? '')) {
    throw new Error(
      'Las RPCs de runs (claim/renew/begin/finish_genesis_run) no existen todavía. ' +
      'Aplica supabase/migrations/055-058 en Supabase SQL Editor (en orden) y vuelve a correr este script.'
    )
  }
  // preflight con IDs cero → not_found esperado, no es un fallo del script en sí.

  // ── Setup: tienda de prueba dedicada + 2 conversaciones (A, B) ──────
  const { data: testStore, error: storeErr } = await svc.from('stores').insert({
    name: 'AUDIT_GENESIS_TEST_STORE_DELETE_ME', slug: `audit-genesis-test-${Date.now()}`, is_active: true,
  }).select('id').single()
  if (storeErr) throw storeErr
  fixtures.testStoreId = testStore!.id as string
  const storeA = fixtures.testStoreId

  // ai_agent_config no se backfillea automáticamente para una tienda creada
  // manualmente en este script (el backfill de 036_ai_agent_genesis.sql
  // solo corrió una vez, para las tiendas que existían en ese momento) — se
  // crea explícitamente en modo 'auto'/is_active=true para que
  // claim_genesis_run no rechace todo con outcome='disabled'.
  const { error: cfgErr } = await svc.from('ai_agent_config').insert({
    store_id: storeA, is_active: true, mode: 'auto', provider: 'openai',
  })
  if (cfgErr) throw cfgErr

  const { data: otherStore, error: otherStoreErr } = await svc.from('stores').insert({
    name: 'AUDIT_GENESIS_TEST_STORE_B_DELETE_ME', slug: `audit-genesis-test-b-${Date.now()}`, is_active: true,
  }).select('id').single()
  if (otherStoreErr) throw otherStoreErr
  fixtures.otherStoreId = otherStore!.id as string
  const storeB = fixtures.otherStoreId

  const convA = await makeConversation(storeA, 'convA')
  const convB = await makeConversation(storeA, 'convB')

  console.log('\n=== Setup listo — corriendo casos 1-27 (subconjunto de runs) ===\n')

  // 1. Mensaje nuevo → claimed
  const msg1 = await makeMessage(storeA, convA, 'inbound', 'case1')
  const token1 = randomUUID()
  const r1 = await claim(convA, msg1, token1)
  check('1. Mensaje nuevo → outcome=claimed, attempt_count=1', r1.outcome === 'claimed' && r1.attempt_count === 1, r1)
  await finish(r1.run_id!, token1, 'failed_terminal', { failure_code: 'crashed' }) // limpia el lock para no interferir con casos siguientes

  // 2. Webhook duplicado del mismo mensaje → misma ejecución lógica (nunca dos filas)
  const msg2 = await makeMessage(storeA, convA, 'inbound', 'case2')
  const token2a = randomUUID()
  const r2a = await claim(convA, msg2, token2a)
  const { count: runsForMsg2 } = await svc.from('genesis_message_runs').select('id', { count: 'exact', head: true }).eq('inbound_message_id', msg2)
  check('2. Un solo run por inbound_message_id tras el primer claim', runsForMsg2 === 1, { runsForMsg2 })
  const r2b = await claim(convA, msg2, randomUUID()) // "duplicado" reintentando con lock vigente
  check('2b. Segundo intento sobre el mismo mensaje con lock vigente → already_processing, mismo run_id',
    r2b.outcome === 'already_processing' && r2b.run_id === r2a.run_id, { r2a, r2b })
  await finish(r2a.run_id!, token2a, 'failed_terminal', { failure_code: 'crashed' })

  // 3. Dos claims simultáneos (mismo mensaje) → un solo owner
  // FIX (validación real post-Fase-1A.1): antes los tokens se generaban
  // inline dentro de Promise.all sin capturarlos, así que el finish() de
  // limpieza no podía saber cuál token pertenecía al ganador — usaba uno
  // equivocado, fallaba en silencio (lost_lock) y dejaba el run activo.
  // Con "un solo run activo por conversación" ya vigente, ese run dangling
  // bloqueaba TODOS los casos siguientes que comparten convA (4, 6, 8, 11).
  // Se nombran los tokens explícitamente para poder cerrar el run correcto.
  const msg3 = await makeMessage(storeA, convA, 'inbound', 'case3')
  const token3a = randomUUID()
  const token3b = randomUUID()
  const [r3a, r3b] = await withTimeout(
    Promise.all([claim(convA, msg3, token3a), claim(convA, msg3, token3b)]),
    CONCURRENT_BATCH_TIMEOUT_MS,
    'caso 3 — 2 claims concurrentes, mismo mensaje'
  )
  const claimedCount3 = [r3a, r3b].filter(r => r.outcome === 'claimed').length
  check('3. Dos claims simultáneos, mismo mensaje → exactamente 1 outcome=claimed',
    claimedCount3 === 1, { r3a, r3b })
  const r3aWon = r3a.outcome === 'claimed'
  const winner3 = r3aWon ? r3a : r3b
  const winnerToken3 = r3aWon ? token3a : token3b
  await finish(winner3.run_id!, winnerToken3, 'failed_terminal', { failure_code: 'crashed' })

  // 4. Diez claims simultáneos (mismo mensaje) → un solo owner
  // Mismo fix: se nombran los 10 tokens para poder cerrar el ganador.
  const msg4 = await makeMessage(storeA, convA, 'inbound', 'case4')
  const tokens4 = Array.from({ length: 10 }, () => randomUUID())
  const race4 = await withTimeout(
    Promise.all(tokens4.map(token => claim(convA, msg4, token))),
    CONCURRENT_BATCH_TIMEOUT_MS,
    'caso 4 — 10 claims concurrentes, mismo mensaje'
  )
  const claimedCount4 = race4.filter(r => r.outcome === 'claimed').length
  const runIds4 = new Set(race4.map(r => r.run_id).filter(Boolean))
  check('4. Diez claims simultáneos, mismo mensaje → exactamente 1 claimed, 1 solo run_id',
    claimedCount4 === 1 && runIds4.size === 1, { claimedCount4, uniqueRunIds: runIds4.size })
  const winnerIdx4 = race4.findIndex(r => r.outcome === 'claimed')
  if (winnerIdx4 !== -1) {
    await finish(race4[winnerIdx4].run_id!, tokens4[winnerIdx4], 'failed_terminal', { failure_code: 'crashed' })
  }

  // 5. Lock vigente → already_processing (ya cubierto en 2b, se repite aislado para trazabilidad del reporte)
  check('5. Lock vigente → already_processing (ver caso 2b)', r2b.outcome === 'already_processing', r2b)

  // 6. Lock stale → retry_claimed
  const msg6 = await makeMessage(storeA, convA, 'inbound', 'case6')
  const token6 = randomUUID()
  const r6a = await claim(convA, msg6, token6, 1) // TTL de 1s
  await new Promise(res => setTimeout(res, 1500)) // dejar vencer
  const token6b = randomUUID()
  const r6b = await claim(convA, msg6, token6b)
  check('6. Lock vencido (TTL=1s, esperado >1.5s) → outcome=retry_claimed, attempt_count=2, mismo run_id',
    r6b.outcome === 'retry_claimed' && r6b.attempt_count === 2 && r6b.run_id === r6a.run_id, { r6a, r6b })

  // 7. Token incorrecto → renovación rechazada
  const r7 = await renew(r6b.run_id!, randomUUID())
  check('7. renew_genesis_run con token incorrecto → outcome=lost_lock', r7.outcome === 'lost_lock', r7)
  // Cierra el run de msg6 (con el token real, token6b) antes de seguir —
  // sigue activo tras el caso 7 y bloquearía el caso 8 si no se libera.
  await finish(r6b.run_id!, token6b, 'failed_terminal', { failure_code: 'crashed' })

  // 8. Token expirado → begin_send rechazado
  const msg8 = await makeMessage(storeA, convA, 'inbound', 'case8')
  const token8 = randomUUID()
  const r8claim = await claim(convA, msg8, token8, 1)
  await renew(r8claim.run_id!, token8, 30, 'generated') // llega a 'generated' antes de expirar
  await new Promise(res => setTimeout(res, 1500)) // ahora forzamos vencer manualmente vía SQL directo, ver nota abajo
  await svc.from('genesis_message_runs').update({ lock_expires_at: new Date(Date.now() - 5000).toISOString() }).eq('id', r8claim.run_id!)
  const r8begin = await beginSend(r8claim.run_id!, token8)
  check('8. lock_expires_at vencido → begin_genesis_send outcome=lost_lock, allowed=false',
    !r8begin.allowed && r8begin.outcome === 'lost_lock', r8begin)
  // Cierra el run de msg8 (token8 real) — sigue en 'generated' tras el
  // rechazo de begin_send y bloquearía el caso 11 si no se libera.
  await finish(r8claim.run_id!, token8, 'failed_terminal', { failure_code: 'lock_lost' })

  // 11. Éxito → sent exactamente una vez
  const msg11 = await makeMessage(storeA, convA, 'inbound', 'case11')
  const token11 = randomUUID()
  const r11claim = await claim(convA, msg11, token11)
  await renew(r11claim.run_id!, token11, 30, 'generated')
  const r11begin = await beginSend(r11claim.run_id!, token11)
  check('11a. begin_genesis_send en flujo feliz → allowed=true', r11begin.allowed === true, r11begin)
  const out11 = await makeMessage(storeA, convA, 'outbound', 'case11-out')
  const r11finish = await finish(r11claim.run_id!, token11, 'sent', { meta_message_id: 'wamid.AUDIT11', outbound_message_id: out11 })
  check('11b. finish_genesis_run(sent) → outcome=sent', r11finish.outcome === 'sent', r11finish)
  const { data: run11Row } = await svc.from('genesis_message_runs').select('status, sent_at, meta_message_id, outbound_message_id').eq('id', r11claim.run_id!).single()
  check('11c. Fila final: status=sent, sent_at/meta_message_id/outbound_message_id poblados',
    run11Row?.status === 'sent' && !!run11Row?.sent_at && !!run11Row?.meta_message_id && !!run11Row?.outbound_message_id, run11Row)

  // 12. Segundo finish success → idempotente, sin duplicar
  const r12 = await finish(r11claim.run_id!, token11, 'sent', { meta_message_id: 'wamid.AUDIT11', outbound_message_id: out11 })
  check('12. Segundo finish(sent) sobre el mismo run → outcome=already_finished, no-op', r12.outcome === 'already_finished', r12)

  // 13. failed_retryable → puede reclamarse de nuevo (retry_claimed)
  const msg13 = await makeMessage(storeA, convA, 'inbound', 'case13')
  const token13a = randomUUID()
  const r13claim = await claim(convA, msg13, token13a)
  await finish(r13claim.run_id!, token13a, 'failed_retryable', { failure_code: 'openai_error' })
  const token13retry = randomUUID()
  const r13retry = await claim(convA, msg13, token13retry)
  check('13. failed_retryable → un nuevo claim tiene éxito (retry_claimed), attempt_count=2',
    r13retry.outcome === 'retry_claimed' && r13retry.attempt_count === 2, { r13claim: r13claim.run_id, r13retry })
  // El retry queda 'claimed' (activo) tras este caso — cerrarlo para no
  // bloquear los casos 14/15 que comparten convA.
  await finish(r13retry.run_id!, token13retry, 'failed_terminal', { failure_code: 'crashed' })

  // 14. failed_terminal → no puede reclamarse
  const msg14 = await makeMessage(storeA, convA, 'inbound', 'case14')
  const token14 = randomUUID()
  const r14claim = await claim(convA, msg14, token14)
  await finish(r14claim.run_id!, token14, 'failed_terminal', { failure_code: 'max_attempts_exceeded' })
  const r14retry = await claim(convA, msg14, randomUUID())
  check('14. failed_terminal → un nuevo claim NO reclama (outcome=failed_terminal, mismo run_id, sin nueva fila)',
    r14retry.outcome === 'failed_terminal' && r14retry.run_id === r14claim.run_id, r14retry)

  // 15. send_unknown → no puede reenviarse
  const msg15 = await makeMessage(storeA, convA, 'inbound', 'case15')
  const token15 = randomUUID()
  const r15claim = await claim(convA, msg15, token15)
  await finish(r15claim.run_id!, token15, 'send_unknown')
  const r15retry = await claim(convA, msg15, randomUUID())
  check('15. send_unknown → un nuevo claim NO reclama (outcome=send_unknown, sin reenvío posible)',
    r15retry.outcome === 'send_unknown' && r15retry.run_id === r15claim.run_id, r15retry)

  // 16. inbound que no pertenece a la conversación indicada → invalid_message
  const msgOfB = await makeMessage(storeA, convB, 'inbound', 'case16-msgB')
  const r16 = await claim(convA, msgOfB, randomUUID()) // conv=A, mensaje real de B
  check('16. inbound_message_id de otra conversación → outcome=invalid_message', r16.outcome === 'invalid_message', r16)

  // 17. outbound usado como inbound_message_id → invalid_message
  const outbound17 = await makeMessage(storeA, convA, 'outbound', 'case17')
  const r17 = await claim(convA, outbound17, randomUUID())
  check('17. outbound_message_id pasado como inbound → outcome=invalid_message', r17.outcome === 'invalid_message', r17)

  // 24. RLS directo bloquea INSERT/UPDATE sobre genesis_message_runs
  const agentSession = await makeAuthedSession('admin', storeA, 'rls24', fixtures)
  const directInsert = await agentSession.from('genesis_message_runs').insert({
    store_id: storeA, conversation_id: convA, inbound_message_id: msg1,
  })
  check('24. INSERT directo a genesis_message_runs desde sesión autenticada → bloqueado por RLS',
    directInsert.error !== null, { error: directInsert.error?.message })

  // ============================================================
  // Fase 1A.1 — casos 25-27: un solo run activo por conversación
  // ============================================================

  // 25. Mensaje A reclama; mensaje B (mismo conv, msg distinto) llega
  //     mientras A sigue activo → B recibe conversation_busy, no crea run,
  //     no toca el ai_lock_token de A.
  const convBusy = await makeConversation(storeA, 'convBusy')
  const msgBusyA = await makeMessage(storeA, convBusy, 'inbound', 'busyA')
  const tokenBusyA = randomUUID()
  const rBusyA = await claim(convBusy, msgBusyA, tokenBusyA)
  check('25a. Mensaje A reclama una conversación nueva → outcome=claimed', rBusyA.outcome === 'claimed', rBusyA)

  const msgBusyB = await makeMessage(storeA, convBusy, 'inbound', 'busyB')
  const rBusyB = await claim(convBusy, msgBusyB, randomUUID())
  check('25b. Mensaje B (mismo conv, msg DISTINTO) mientras A sigue activo → outcome=conversation_busy, run_id=el de A',
    rBusyB.outcome === 'conversation_busy' && rBusyB.run_id === rBusyA.run_id, { rBusyA, rBusyB })

  const { count: runsForConvBusy } = await svc.from('genesis_message_runs')
    .select('id', { count: 'exact', head: true }).eq('conversation_id', convBusy)
  check('25c. B no creó una segunda fila — solo existe 1 run para esta conversación', runsForConvBusy === 1, { runsForConvBusy })

  const { data: convBusyRow } = await svc.from('wa_conversations').select('ai_lock_token').eq('id', convBusy).single()
  check('25d. B no sobreescribió ai_lock_token — sigue siendo el de A', convBusyRow?.ai_lock_token === tokenBusyA, convBusyRow)

  await finish(rBusyA.run_id!, tokenBusyA, 'failed_terminal', { failure_code: 'crashed' })

  // 26. Diez mensajes DISTINTOS intentan reclamar la MISMA conversación
  //     concurrentemente → exactamente uno activo, los otros 9
  //     conversation_busy, exactamente 1 run activo en la base.
  const convBusy10 = await makeConversation(storeA, 'convBusy10')
  const msgsBusy10 = await Promise.all(
    Array.from({ length: 10 }, (_, i) => makeMessage(storeA, convBusy10, 'inbound', `busy10-${i}`))
  )
  const attempts26 = msgsBusy10.map(msgId => ({ msgId, token: randomUUID() }))
  const race26 = await withTimeout(
    Promise.all(attempts26.map(a => claim(convBusy10, a.msgId, a.token))),
    CONCURRENT_BATCH_TIMEOUT_MS,
    'caso 26 — 10 claims concurrentes, misma conversación, 10 mensajes distintos'
  )
  const claimedCount26 = race26.filter(r => r.outcome === 'claimed').length
  const busyCount26 = race26.filter(r => r.outcome === 'conversation_busy').length
  check('26a. Diez mensajes DISTINTOS, misma conversación → exactamente 1 outcome=claimed',
    claimedCount26 === 1, { claimedCount26, busyCount26 })
  check('26b. Los otros 9 reciben outcome=conversation_busy (ninguno crea run propio)',
    busyCount26 === 9, { claimedCount26, busyCount26 })

  const { count: activeRunsConvBusy10 } = await svc.from('genesis_message_runs')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', convBusy10)
    .in('status', ['claimed', 'processing', 'generated', 'sending'])
  check('26c. Exactamente 1 run activo en la base para esta conversación tras la carrera',
    activeRunsConvBusy10 === 1, { activeRunsConvBusy10 })

  const winnerIdx26 = race26.findIndex(r => r.outcome === 'claimed')
  const winnerToken26 = attempts26[winnerIdx26].token
  const winnerRunId26 = race26[winnerIdx26].run_id!

  // 27. El run activo se vuelve terminal → un mensaje NUEVO sí puede
  //     reclamar la misma conversación después (el "busy" no es permanente,
  //     solo mientras hay un run realmente activo).
  await finish(winnerRunId26, winnerToken26, 'failed_terminal', { failure_code: 'crashed' })
  const msgAfter27 = await makeMessage(storeA, convBusy10, 'inbound', 'after-terminal')
  const token27 = randomUUID()
  const r27 = await claim(convBusy10, msgAfter27, token27)
  check('27. Tras terminar el run activo, un mensaje NUEVO sí puede reclamar la conversación → outcome=claimed',
    r27.outcome === 'claimed', r27)
  await finish(r27.run_id!, token27, 'failed_terminal', { failure_code: 'crashed' })
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
      'ejecución completa del script (preflight + setup + casos 1-27)'
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
  console.log('\nTodas las pruebas de integración de las RPCs de runs pasaron.')
}

main().catch(e => { console.error('TEST SCRIPT FAILED (fuera del try/finally esperado):', e); process.exit(1) })
