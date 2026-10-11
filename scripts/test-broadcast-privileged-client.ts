// Parche RLS de Broadcast — cliente service role real en las 9 rutas de Broadcast.
// Uso: npx tsx scripts/test-broadcast-privileged-client.ts
//
// Offline: sin red ni Supabase (fetch interceptado, DB en memoria).
//   P1 — createPrivilegedServiceClient envía la service key en Authorization aunque
//        exista una sesión; createServerClient (@supabase/ssr) con cookies envía el JWT
//        del usuario (causa del "new row violates row-level security policy").
//   P2 — las 9 rutas validan permisos ANTES de crear el cliente privilegiado y ya no
//        usan createServiceClient; fuera del alcance nada cambia.
//   P3 — aislamiento por tienda: un admin de otra tienda no lee, modifica, lanza ni cancela.
//   P4 — roles sin permiso no pasan la validación de admin.

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServerClient } from '@supabase/ssr'
import { C1FakeDb, type Row } from './lib/c1-fake-db'
import { createPrivilegedServiceClient } from '../src/lib/supabase/server'
import { createBroadcastDraft, listBroadcasts, type BroadcastAdminContext } from '../src/lib/broadcast/broadcast-service'
import { parseBroadcastSelection } from '../src/lib/broadcast/selection'
import { computeLaunchPreview, launchBroadcast, pauseBroadcast, resumeBroadcast } from '../src/lib/broadcast/launch'
import { cancelBroadcast } from '../src/lib/broadcast/cancel'
import { getBroadcastMetrics } from '../src/lib/broadcast/metrics'
import { buildBroadcastInboxContext, markBroadcastResponsesHandled } from '../src/lib/broadcast/inbox-context'
import { getBroadcastAdminContext } from '../src/lib/broadcast/admin-context'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`)
}

const URL_ = 'https://abcdefghijklmnop.supabase.co'
const SERVICE_KEY = 'service-role-key-TEST'
const ANON_KEY = 'anon-key-TEST'
const USER_JWT = 'user.jwt.TEST'

/** Intercepta fetch global y devuelve las cabeceras de la primera petición a /rest/v1. */
async function captureRestHeaders(run: () => Promise<unknown>): Promise<Record<string, string>> {
  const realFetch = globalThis.fetch
  let headers: Record<string, string> = {}
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/rest/v1/') && Object.keys(headers).length === 0) {
      headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries())
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-range': '0-0/0' } })
  }) as typeof fetch
  try { await run() } finally { globalThis.fetch = realFetch }
  return headers
}

const S1 = 'store-1', S2 = 'store-2'
const ADMIN1: BroadcastAdminContext = { userId: 'admin-1', storeId: S1 }
const ADMIN2: BroadcastAdminContext = { userId: 'admin-2', storeId: S2 }
const ENV = { WA_BROADCAST_CONFIRMATION_IMAGE_URL: 'https://cdn.example.com/luma-2x1.jpg' }
const PERSONAL = 'LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita - x2, + 1 Cepillo GRATIS'
let seq = 0
function mkOrder(store: string): Row {
  seq++
  return {
    id: randomUUID(), store_id: store, order_number: `#${5000 + seq}`, source: 'shopify_webhook', shopify_order_id: `shp-${seq}`,
    is_test: false, archived_at: null, customer_name: `Cliente ${seq}`, customer_phone: `809-555-${String(2000 + seq)}`,
    city: 'Santo Domingo Este', province: 'Santo Domingo', customer_address: 'Calle 1', product_summary: PERSONAL, cod_amount: 2100,
    confirmation_status: 'pending', confirmation_attempts: 0, normalized_status: 'pending', payment_status: 'pending',
    tracking_number: null, sd_location_received_at: null, shopify_created_at: '2026-10-01T12:00:00.000Z', paid_at: null,
    customer_confirmed_at: null, created_at: '2026-10-01T00:00:00.000Z',
  }
}

async function main() {
  console.log('\n=== P1 — cabecera Authorization ===')
  {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
    const priv = await captureRestHeaders(async () => { await createPrivilegedServiceClient().from('wa_broadcasts').select('id') })
    check('P1.1 cliente privilegiado: Authorization = Bearer <service key>', priv.authorization === `Bearer ${SERVICE_KEY}` && priv.apikey === SERVICE_KEY, priv)

    // Mismo patrón que createServiceClient(): @supabase/ssr + cookies con una sesión de usuario.
    const session = { access_token: USER_JWT, refresh_token: 'r', token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'admin-1', aud: 'authenticated', role: 'authenticated' } }
    const cookieName = 'sb-abcdefghijklmnop-auth-token'
    const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
    const ssrHeaders = await captureRestHeaders(async () => {
      const c = createServerClient(URL_, SERVICE_KEY, { cookies: { getAll: () => [{ name: cookieName, value: cookieValue }], setAll: () => {} } })
      await c.from('wa_broadcasts').select('id')
    })
    check('P1.2 patrón anterior (ssr + cookies de sesión) envía el JWT del usuario → RLS (causa del error)',
      ssrHeaders.authorization === `Bearer ${USER_JWT}` && ssrHeaders.apikey === SERVICE_KEY, ssrHeaders)

    // El cliente privilegiado no lee cookies: aunque haya sesión en la petición, no la usa.
    check('P1.3 el cliente privilegiado no recibe cookies ni persiste sesión',
      !/cookies|next\/headers/.test(readFileSync('src/lib/supabase/server.ts', 'utf8').split('export function createPrivilegedServiceClient')[1])
      && /persistSession:\s*false/.test(readFileSync('src/lib/supabase/server.ts', 'utf8')))

    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    let threw = false
    try { createPrivilegedServiceClient() } catch { threw = true }
    check('P1.4 sin SUPABASE_SERVICE_ROLE_KEY → error (nunca cae a anon)', threw)
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
    void ANON_KEY
  }

  console.log('\n=== P2 — rutas: autorización antes del cliente privilegiado ===')
  {
    const ADMIN_ROUTES = [
      'src/app/api/admin/broadcasts/route.ts', 'src/app/api/admin/broadcasts/preview/route.ts',
      'src/app/api/admin/broadcasts/[id]/route.ts', 'src/app/api/admin/broadcasts/[id]/launch-preview/route.ts',
      'src/app/api/admin/broadcasts/[id]/launch/route.ts', 'src/app/api/admin/broadcasts/[id]/pause/route.ts',
      'src/app/api/admin/broadcasts/[id]/resume/route.ts', 'src/app/api/admin/broadcasts/[id]/cancel/route.ts',
    ]
    const INBOX_ROUTE = 'src/app/api/whatsapp/conversations/[id]/broadcast-context/route.ts'
    const bad: string[] = []
    let handlers = 0
    for (const f of [...ADMIN_ROUTES, INBOX_ROUTE]) {
      const src = readFileSync(f, 'utf8')
      if (/createServiceClient/.test(src)) bad.push(`${f}: usa createServiceClient`)
      const authCall = f === INBOX_ROUTE ? 'getInboxAgentContext(' : 'getBroadcastAdminContext('
      for (const body of src.split(/export async function (?:GET|POST|PATCH)\b/).slice(1)) {
        handlers++
        const a = body.indexOf(authCall), g = body.indexOf('if (!auth.ok) return'), p = body.indexOf('createPrivilegedServiceClient()')
        if (p === -1) { bad.push(`${f}: handler sin cliente privilegiado`); continue }
        if (!(a > -1 && g > a && p > g)) bad.push(`${f}: el cliente privilegiado se crea antes de validar permisos`)
      }
    }
    check(`P2.1 ${handlers} handlers en 9 rutas: validación de permisos → return si falla → recién entonces cliente privilegiado`, bad.length === 0 && handlers === 11, bad)
    const detail = readFileSync('src/app/api/admin/broadcasts/[id]/route.ts', 'utf8')
    check('P2.2 detalle de campaña filtra por id + store_id del perfil', /\.eq\('id', id\)\.eq\('store_id', auth\.ctx\.storeId\)/.test(detail))
    const changed = execSync('git diff --name-only 30af2ed -- src', { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort()
    const expected = [...ADMIN_ROUTES, INBOX_ROUTE, 'src/lib/supabase/server.ts'].sort()
    check('P2.3 solo cambian las 9 rutas + server.ts (nada fuera del alcance)', JSON.stringify(changed) === JSON.stringify(expected), changed)
    const serverDiff = execSync('git diff 30af2ed -- src/lib/supabase/server.ts', { encoding: 'utf8' })
    check('P2.4 server.ts: solo añadidos (createClient y createServiceClient intactos)',
      !serverDiff.split('\n').some(l => l.startsWith('-') && !l.startsWith('---')), serverDiff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')))
    const remaining = execSync("grep -rl 'createServiceClient()' src || true", { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    check('P2.5 createServiceClient se conserva en los usos fuera del alcance (cron, webhooks y otros módulos)',
      remaining.includes('src/app/api/cron/wa-broadcast-queue/route.ts') && remaining.includes('src/app/api/webhooks/whatsapp/route.ts') && remaining.length >= 38, remaining.length)
  }

  console.log('\n=== P3 — aislamiento por tienda ===')
  {
    const o1 = [mkOrder(S1), mkOrder(S1)], o2 = [mkOrder(S2)]
    const db = new C1FakeDb()
    db.tables.orders = [...o1, ...o2]; db.tables.wa_template_queue = []; db.tables.wa_broadcasts = []; db.tables.order_history = []
    const sel1 = parseBroadcastSelection({ mode: 'selected_ids', order_ids: o1.map(o => o.id), campaign: { type: 'coordination', segment: 'pending' } })
    if (!sel1.ok) throw new Error(sel1.error)
    const d1 = await createBroadcastDraft(db, ADMIN1, sel1.selection, randomUUID())
    if (!d1.ok) throw new Error(d1.error)
    const id1 = d1.broadcast.id

    // S2 intenta crear un borrador con pedidos de S1 → ninguno resuelve.
    const d2 = await createBroadcastDraft(db, ADMIN2, sel1.selection, randomUUID())
    check('P3.1 borrador de S2 con pedidos de S1 → rechazado (no resuelve ningún pedido ajeno)', !d2.ok && d2.status === 422, d2)
    const list2 = await listBroadcasts(db, S2) as Row[]
    check('P3.2 historial de S2 no incluye campañas de S1', list2.every(b => b.store_id !== S1) && list2.length === 0, list2.length)
    const p2 = await computeLaunchPreview(db, ADMIN2, id1, 10, ENV)
    check('P3.3 vista previa de lanzamiento de una campaña ajena → 404', !p2.ok && p2.status === 404, p2)
    const l2 = await launchBroadcast(db, ADMIN2, { broadcastId: id1, launchRequestKey: randomUUID(), sendLimit: 10, confirmCount: 2 }, true, ENV)
    check('P3.4 lanzar una campaña ajena → 404 y sin cambios', !l2.ok && l2.status === 404 && db.t('wa_broadcasts').find(b => b.id === id1)!.status === 'draft'
      && db.t('wa_template_queue').length === 0, l2)
    // S1 la lanza de verdad; S2 intenta pausar / reanudar / cancelar / leer métricas.
    const pv = await computeLaunchPreview(db, ADMIN1, id1, 10, ENV)
    await launchBroadcast(db, ADMIN1, { broadcastId: id1, launchRequestKey: randomUUID(), sendLimit: 10, confirmCount: pv.ok ? pv.preview.batch.length : 0 }, true, ENV)
    const before = JSON.stringify(db.t('wa_broadcasts'))
    const pz = await pauseBroadcast(db, ADMIN2, id1)
    const rs = await resumeBroadcast(db, ADMIN2, id1, true)
    const cn = await cancelBroadcast(db, ADMIN2, id1)
    check('P3.5 pausar / reanudar / cancelar una campaña ajena → rechazado y sin cambios',
      !pz.ok && !rs.ok && !cn.ok && cn.status === 404 && JSON.stringify(db.t('wa_broadcasts')) === before, { pz, rs, cn })
    const m2 = await getBroadcastMetrics(db, S2, id1)
    check('P3.6 métricas de una campaña ajena → vacías (no se filtran filas de S1)', m2.queued === 0 && m2.responded === 0, m2.queued)
    const queueBefore = db.t('wa_template_queue').length
    check('P3.7 la cola de S1 sigue intacta', queueBefore === 2)

    // Inbox: conversación de S1 consultada / modificada desde S2.
    const conv = { id: randomUUID(), store_id: S1, contact_id: 'c1', status: 'open' }
    db.tables.wa_contacts = [{ id: 'c1', store_id: S1, phone_normalized: '18095552001' }]
    db.tables.wa_conversations = [conv]
    db.tables.wa_broadcast_responses = [{ id: randomUUID(), store_id: S1, conversation_id: conv.id, inbound_message_id: 'in-1',
      broadcast_id: id1, intent: 'confirm_interest', association: 'payload', handled_at: null, created_at: new Date().toISOString() }]
    const ctx2 = await buildBroadcastInboxContext(db, S2, conv.id)
    check('P3.8 contexto de Inbox de una conversación ajena → null (404)', ctx2 === null)
    const n = await markBroadcastResponsesHandled(db, S2, conv.id, 'agent-2')
    check('P3.9 marcar atendidas respuestas ajenas → 0 filas y sin cambios', n === 0 && db.t('wa_broadcast_responses')[0].handled_at === null, n)
    const ctx1 = await buildBroadcastInboxContext(db, S1, conv.id)
    check('P3.10 la tienda propietaria sí ve su contexto', ctx1 !== null && ctx1.unhandled === 1)
  }

  console.log('\n=== P4 — solo admins activos con tienda ===')
  {
    const session = (user: { id: string } | null, profile: Row | null) => ({
      auth: { getUser: async () => ({ data: { user } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile }) }) }) }),
    })
    const roles = ['confirmation_agent', 'novelty_agent', 'delivery_agent', 'santo_domingo_delivery_agent', 'agent', 'viewer', 'ia_supervisor']
    const denied: string[] = []
    for (const role of roles) {
      const r = await getBroadcastAdminContext(session({ id: 'u' }, { role, store_id: S1, is_active: true }))
      if (r.ok || r.status !== 403) denied.push(role)
    }
    check(`P4.1 roles sin permiso (${roles.length}) → 403`, denied.length === 0, denied)
    const noUser = await getBroadcastAdminContext(session(null, null))
    const inactive = await getBroadcastAdminContext(session({ id: 'u' }, { role: 'admin', store_id: S1, is_active: false }))
    const noStore = await getBroadcastAdminContext(session({ id: 'u' }, { role: 'admin', store_id: null, is_active: true }))
    const ok = await getBroadcastAdminContext(session({ id: 'u' }, { role: 'admin', store_id: S1, is_active: true }))
    check('P4.2 sin sesión → 401; admin inactivo → 403; admin sin tienda → 403', !noUser.ok && noUser.status === 401
      && !inactive.ok && inactive.status === 403 && !noStore.ok && noStore.status === 403)
    check('P4.3 admin activo → store_id tomado del PERFIL, no del navegador', ok.ok && ok.ctx.storeId === S1 && ok.ctx.userId === 'u')
    const inbox = readFileSync('src/lib/whatsapp/inbox-auth.ts', 'utf8')
    check('P4.4 Inbox: rol de inbox + perfil activo + store_id del perfil', /INBOX_ROLES\.has\(profile\.role\)/.test(inbox)
      && /is_active === false/.test(inbox) && /storeId: profile\.store_id/.test(inbox))
  }

  console.log(failures === 0 ? '\n✅ TODO OK' : `\n❌ ${failures} FALLOS`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
