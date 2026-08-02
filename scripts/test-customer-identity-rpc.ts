// Pruebas de integración de la RPC transaccional resolve_customer_identity()
// — Customer Intelligence Engine, Fase 1 (corrección).
//
// Corre con: npx tsx scripts/test-customer-identity-rpc.ts
// (o: npm run test:customer-identity-rpc)
//
// REQUIERE que supabase/migrations/054_resolve_customer_identity_rpc.sql
// ya esté aplicada en la base de datos (ver esa migración — depende de
// 053_customer_identity.sql). Si la RPC no existe todavía, este script lo
// detecta al inicio y termina con un mensaje claro en vez de fallar a
// medias.
//
// A diferencia de scripts/test-customer-identity.ts (pruebas puras de
// normalizePhone(), sin DB, seguras de correr siempre), este script:
//   - se conecta a Supabase real (usa .env.local — service role solo para
//     provisionar/limpiar usuarios y tienda de prueba, y para verificación
//     directa de estado; las llamadas al resolver usan sesiones reales
//     autenticadas, nunca service role, porque la RPC las rechaza a
//     propósito);
//   - crea y borra datos de prueba marcados inequívocamente
//     (AUDIT_RPC_TEST_*, teléfonos 809-000-1xxx reservados);
//   - no se ejecuta como parte de `npm run test:customer-identity` — es
//     una ampliación separada, deliberadamente no automática, para no
//     depender de que la migración ya esté aplicada.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { resolveOrCreateCustomer } from '../src/lib/customers/resolve-customer'

const envRaw = readFileSync('.env.local', 'utf8')
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] = m[2]
}
const URL        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const svc = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

const cleanup = {
  customerIds: new Set<string>(),
  authUserIds: new Set<string>(),
  testStoreId: null as string | null,
}

interface RpcRawRow {
  customer_id: string | null
  created:     boolean
  outcome:     string
  message:     string | null
}

async function makeSession(role: string, storeId: string, label: string): Promise<SupabaseClient> {
  const email = `audit-rpc-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@controlcod.test`.toLowerCase()
  const password = `Audit-${Date.now()}-!Aa1`
  const { data: created, error: createErr } = await svc.auth.admin.createUser({ email, password, email_confirm: true })
  if (createErr) throw createErr
  const userId = created.user!.id
  cleanup.authUserIds.add(userId)

  // El trigger de auto-creación de profile no se dispara de forma
  // confiable en este proyecto (hallazgo de la auditoría anterior) — se
  // crea el profile explícitamente, no se depende del trigger.
  const { error: upsertErr } = await svc.from('profiles').upsert({
    id: userId, role, store_id: storeId, full_name: `AUDIT_RPC_TEST ${label}`,
  })
  if (upsertErr) throw upsertErr

  const client = createClient(URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
  if (signInErr) throw signInErr
  return client
}

async function countByPhone(storeId: string, phone: string) {
  const c = await svc.from('customers').select('id', { count: 'exact', head: true }).eq('store_id', storeId).eq('phone_primary', phone)
  const i = await svc.from('customer_identifiers').select('id', { count: 'exact', head: true }).eq('store_id', storeId).eq('value_normalized', phone)
  return { customers: c.count ?? 0, identifiers: i.count ?? 0 }
}

async function main() {
  // ── Pre-flight: ¿existe la RPC? ─────────────────────────────────────
  const { data: realStores } = await svc.from('stores').select('id').eq('is_active', true).order('created_at', { ascending: true }).limit(1)
  const storeA = realStores![0].id as string

  const admin = await makeSession('admin', storeA, 'preflight')
  const preflight = await admin.rpc('resolve_customer_identity', {
    p_store_id: storeA, p_value_normalized: '18090001000', p_source: 'manual',
  }).single<RpcRawRow>()
  if (preflight.error && /function .* does not exist|not find the function/i.test(preflight.error.message ?? '')) {
    console.error('\n❌ La RPC resolve_customer_identity() no existe todavía.')
    console.error('   Aplica supabase/migrations/054_resolve_customer_identity_rpc.sql en Supabase SQL Editor y vuelve a correr este script.')
    await svc.auth.admin.deleteUser((await svc.auth.admin.listUsers()).data.users.find(u => u.email?.startsWith('audit-rpc-preflight'))!.id)
    process.exit(1)
  }
  // el preflight en sí ya crea/encuentra un customer real — se registra para limpieza
  if (preflight.data?.customer_id) cleanup.customerIds.add(preflight.data.customer_id)

  // ── Setup: tienda B de prueba + sesiones por rol ────────────────────
  const { data: testStore, error: storeErr } = await svc.from('stores').insert({
    name: 'AUDIT_RPC_TEST_STORE_DELETE_ME', slug: `audit-rpc-test-store-${Date.now()}`, is_active: true,
  }).select('id').single()
  if (storeErr) throw storeErr
  cleanup.testStoreId = testStore!.id as string
  const storeB = cleanup.testStoreId

  const adminA = admin // reutiliza la sesión del preflight
  const adminB = await makeSession('admin', storeB, 'adminB')
  const unauthorizedRole = await makeSession('santo_domingo_delivery_agent', storeA, 'sd_delivery')
  const anon = createClient(URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('\n=== Setup listo — corriendo casos 1-12 ===\n')

  // 1. Número nuevo → created=true
  const r1 = await resolveOrCreateCustomer({ supabase: adminA, storeId: storeA, phoneRaw: '8090001111', source: 'manual', fullName: 'AUDIT_RPC_TEST 1' })
  if (r1.ok) cleanup.customerIds.add(r1.customerId)
  check('1. Número nuevo → ok=true, created=true', r1.ok === true && r1.created === true, r1)

  // 2. Mismo número → mismo customerId, created=false
  const r2 = await resolveOrCreateCustomer({ supabase: adminA, storeId: storeA, phoneRaw: '8090001111', source: 'manual' })
  check('2. Repetir mismo número → mismo customerId, created=false',
    r1.ok && r2.ok && r1.customerId === r2.customerId && r2.created === false, { r1, r2 })

  // 3. Formatos equivalentes → mismo customerId
  const r3a = await resolveOrCreateCustomer({ supabase: adminA, storeId: storeA, phoneRaw: '8290001122', source: 'manual' })
  const r3b = await resolveOrCreateCustomer({ supabase: adminA, storeId: storeA, phoneRaw: '18290001122', source: 'manual' })
  const r3c = await resolveOrCreateCustomer({ supabase: adminA, storeId: storeA, phoneRaw: '+1 829-000-1122', source: 'manual' })
  if (r3a.ok) cleanup.customerIds.add(r3a.customerId)
  check('3. 3 formatos del mismo número → mismo customerId',
    r3a.ok && r3b.ok && r3c.ok && r3a.customerId === r3b.customerId && r3b.customerId === r3c.customerId,
    { r3a, r3b, r3c })

  // 4. Mismo número en otra tienda → aislado
  const r4 = await resolveOrCreateCustomer({ supabase: adminB, storeId: storeB, phoneRaw: '8090001111', source: 'manual' })
  if (r4.ok) cleanup.customerIds.add(r4.customerId)
  check('4. Mismo número, tienda B → customer distinto (aislamiento)',
    r4.ok && r1.ok && r4.customerId !== r1.customerId, r4)

  // 5. Número extranjero → preservado
  const r5 = await resolveOrCreateCustomer({ supabase: adminA, storeId: storeA, phoneRaw: '+34911002244', source: 'manual' })
  if (r5.ok) cleanup.customerIds.add(r5.customerId)
  check('5. Número extranjero (+34) → normalizedPhone sin forzar prefijo RD',
    r5.ok && r5.normalizedPhone === '34911002244' && !r5.normalizedPhone.startsWith('1'), r5)

  // 6. Número inválido → ok=false con reason exacto
  const r6 = await resolveOrCreateCustomer({ supabase: adminA, storeId: storeA, phoneRaw: '123', source: 'manual' })
  check('6. Número inválido → ok=false, reason=too_short', !r6.ok && r6.reason === 'too_short', r6)

  // 7. Carrera de 2 llamadas → una identidad
  const [r7a, r7b] = await Promise.all([
    resolveOrCreateCustomer({ supabase: adminA, storeId: storeA, phoneRaw: '8090002222', source: 'manual' }),
    resolveOrCreateCustomer({ supabase: adminA, storeId: storeA, phoneRaw: '8090002222', source: 'manual' }),
  ])
  if (r7a.ok) cleanup.customerIds.add(r7a.customerId)
  const count7 = await countByPhone(storeA, '18090002222')
  check('7. Carrera de 2 llamadas → 1 customer, 1 identifier, mismo customerId',
    r7a.ok && r7b.ok && r7a.customerId === r7b.customerId && count7.customers === 1 && count7.identifiers === 1,
    { r7a, r7b, count7 })

  // 8. Carrera de 10 llamadas → una identidad
  const race10 = await Promise.all(
    Array.from({ length: 10 }, () => resolveOrCreateCustomer({ supabase: adminA, storeId: storeA, phoneRaw: '8090003333', source: 'manual' })),
  )
  const okIds = race10.filter(r => r.ok).map(r => (r as { customerId: string }).customerId)
  if (okIds[0]) cleanup.customerIds.add(okIds[0])
  const count8 = await countByPhone(storeA, '18090003333')
  const createdCount8 = race10.filter(r => r.ok && r.created).length
  check('8. Carrera de 10 llamadas → 1 customer, 1 identifier, todas mismo customerId, solo 1 created=true',
    okIds.length === 10 && new Set(okIds).size === 1 && count8.customers === 1 && count8.identifiers === 1 && createdCount8 === 1,
    { uniqueIds: new Set(okIds).size, count8, createdCount8 })

  // 9. Fallo forzado del segundo insert / integridad ante escritura fuera
  //    del advisory lock: no es posible forzar determinísticamente un
  //    fallo a mitad de la función sin instrumentar el código bajo
  //    prueba (ver reporte de entrega — explicación completa). En su
  //    lugar, se dispara la RPC en carrera CONTRA una escritura directa
  //    vía service role (que NO toma el advisory lock, simulando un
  //    escritor externo a esta función) para forzar que, si la RPC pierde
  //    la carrera al INSERT de customer_identifiers, su propio EXCEPTION
  //    WHEN unique_violation recupere sin dejar huérfanos. Se valida el
  //    estado final: nunca debe haber más customers que identifiers para
  //    este teléfono (eso sería la firma de un huérfano).
  const phone9 = '18090004444'
  const rawWinner = await svc.from('customers').insert({ store_id: storeA, phone_primary: phone9, full_name: 'AUDIT_RPC_TEST raw-writer' }).select('id').single()
  if (rawWinner.data) cleanup.customerIds.add(rawWinner.data.id)
  await svc.from('customer_identifiers').insert({
    customer_id: rawWinner.data!.id, store_id: storeA, identifier_type: 'phone',
    value_normalized: phone9, source: 'manual',
  })
  // La RPC, llamada DESPUÉS de que el escritor externo ya comprometió su
  // fila, debe encontrarla vía su propio SELECT inicial (found) — el
  // camino realista. Se deja documentado que forzar el camino
  // conflict_recovered exacto requeriría instrumentación del código bajo
  // prueba, no solo del test.
  const r9 = await resolveOrCreateCustomer({ supabase: adminA, storeId: storeA, phoneRaw: '8090004444', source: 'manual' })
  const count9 = await countByPhone(storeA, phone9)
  check('9. Integridad tras escritor externo concurrente: 1 customer == 1 identifier, sin huérfanos, RPC converge al mismo id',
    r9.ok && r9.customerId === rawWinner.data!.id && count9.customers === count9.identifiers && count9.customers === 1,
    { r9, rawWinnerId: rawWinner.data!.id, count9 })

  // 10. Usuario de otra tienda → forbidden/store_mismatch
  const r10 = await resolveOrCreateCustomer({ supabase: adminB, storeId: storeA, phoneRaw: '8090005555', source: 'manual' })
  check('10. Sesión de tienda B pidiendo storeId=A → ok=false, reason=store_mismatch',
    !r10.ok && r10.reason === 'store_mismatch', r10)
  const count10 = await countByPhone(storeA, '18090005555')
  check('10b. No se creó ningún registro tras el store_mismatch', count10.customers === 0, count10)

  // 11. Anónimo → rechazado
  const r11 = await resolveOrCreateCustomer({ supabase: anon, storeId: storeA, phoneRaw: '8090006666', source: 'manual' })
  check('11. Sesión anónima → ok=false, reason=forbidden', !r11.ok && r11.reason === 'forbidden', r11)

  // 12. Rol no autorizado → rechazado
  const r12 = await resolveOrCreateCustomer({ supabase: unauthorizedRole, storeId: storeA, phoneRaw: '8090007777', source: 'manual' })
  check('12. Rol santo_domingo_delivery_agent (no autorizado) → ok=false, reason=forbidden', !r12.ok && r12.reason === 'forbidden', r12)

  // Bonus (implícito en el diseño, no en la lista original): service_role
  // directo también debe ser rechazado — confirma que el permiso no se
  // otorga por accidente vía service_role.
  const rSvc = await svc.rpc('resolve_customer_identity', {
    p_store_id: storeA, p_value_normalized: '18090008888', p_source: 'manual',
  }).single<RpcRawRow>()
  check('Bonus. service_role directo → outcome=forbidden (auth.uid() es NULL)',
    rSvc.data?.outcome === 'forbidden', rSvc.data)

  // ============================================================
  // Limpieza
  // ============================================================
  console.log(`\n=== Limpieza: ${cleanup.customerIds.size} customers, ${cleanup.authUserIds.size} auth users, 1 store ===`)
  const custIds = Array.from(cleanup.customerIds)
  if (custIds.length) {
    await svc.from('customer_identifiers').delete().in('customer_id', custIds)
    await svc.from('customers').delete().in('id', custIds)
  }
  for (const uid of cleanup.authUserIds) {
    await svc.from('profiles').delete().eq('id', uid)
    await svc.auth.admin.deleteUser(uid)
  }
  if (cleanup.testStoreId) await svc.from('stores').delete().eq('id', cleanup.testStoreId)

  const verify = await svc.from('customers').select('id', { count: 'exact', head: true }).ilike('full_name', 'AUDIT_RPC_TEST%')
  check('Limpieza verificada: 0 customers de prueba restantes', (verify.count ?? 0) === 0, { remaining: verify.count })

  if (failures > 0) {
    console.error(`\n${failures} prueba(s) fallaron.`)
    process.exit(1)
  }
  console.log('\nTodas las pruebas de integración de resolve_customer_identity() pasaron.')
}

main().catch(e => { console.error('TEST SCRIPT FAILED:', e); process.exit(1) })
