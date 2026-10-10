// Sprint C.1.4 — tests de las correcciones previas al piloto (F1, F2, F3, F5).
// Uso: npx tsx scripts/test-broadcast-c1-pilot-safety.ts
//
// Offline: DB en memoria (C1FakeDb, mismos UNIQUE/índices parciales que
// 033/064/065/066) y `send` simulado. Sin red, sin Supabase, sin Meta.
//
//   F1 — el processor nunca ve una campaña a medio preparar; ninguna fila
//        pending queda abandonada (carrera, fallo parcial, reintento).
//   F2 — cancelación manual: conserva enviados/fallidos/inciertos, libera
//        pendientes con rastro, desbloquea destinatarios, idempotente.
//   F3 — vista previa con el flag OFF; lanzar/reanudar siguen bloqueados.
//   F5 — inserción por bloques, presupuesto de tiempo, continuación idempotente.

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { C1FakeDb, type Row } from './lib/c1-fake-db'
import { createBroadcastDraft, type BroadcastAdminContext } from '../src/lib/broadcast/broadcast-service'
import { parseBroadcastSelection } from '../src/lib/broadcast/selection'
import {
  computeLaunchPreview, launchBroadcast, pauseBroadcast, resumeBroadcast,
  LAUNCH_INSERT_CHUNK, LAUNCH_PREP_STALE_MS, LAUNCH_TIME_BUDGET_MS,
} from '../src/lib/broadcast/launch'
import { processBroadcastQueue } from '../src/lib/broadcast/processor'
import { cancelBroadcast } from '../src/lib/broadcast/cancel'
import type { SendTemplateRequest, SendTemplateResult } from '../src/lib/whatsapp/send-template'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : ''}`)
}

// ── Fixtures (mismo formato que test-broadcast-c1.ts) ────────────────────────

const S1 = 'store-1', S2 = 'store-2'
const ADMIN: BroadcastAdminContext = { userId: 'admin-1', storeId: S1 }
const ENV = { WA_BROADCAST_CONFIRMATION_IMAGE_URL: 'https://cdn.example.com/luma-2x1.jpg' }
const PERSONAL = 'LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita - x2, + 1 Cepillo GRATIS'
let seq = 0

function mkOrder(o: Partial<Row> = {}): Row {
  seq++
  return {
    id: randomUUID(), store_id: S1, order_number: `#${7000 + seq}`, source: 'shopify_webhook', shopify_order_id: `shp-${seq}`,
    is_test: false, archived_at: null, customer_name: `Cliente ${seq}`, customer_phone: `809-555-${String(1000 + seq)}`,
    city: 'Santo Domingo Este', province: 'Santo Domingo', customer_address: 'Calle 1', product_summary: PERSONAL, cod_amount: 2100,
    confirmation_status: 'pending', confirmation_attempts: 0, normalized_status: 'pending', payment_status: 'pending',
    tracking_number: null, sd_location_received_at: null, shopify_created_at: '2026-10-01T12:00:00.000Z', paid_at: null,
    customer_confirmed_at: null, created_at: '2026-10-01T00:00:00.000Z', ...o,
  }
}
const many = (n: number) => Array.from({ length: n }, () => mkOrder())
const phoneOfOrder = (o: Row) => `1${String(o.customer_phone).replace(/\D/g, '')}`

function seedDb(orders: Row[]): C1FakeDb {
  const db = new C1FakeDb()
  db.tables.orders = orders
  db.tables.wa_template_queue = []
  db.tables.wa_broadcasts = []
  db.tables.order_history = []
  return db
}

async function mkDraft(db: C1FakeDb, orders: Row[]) {
  const sel = parseBroadcastSelection({ mode: 'selected_ids', order_ids: orders.map(o => o.id), campaign: { type: 'coordination', segment: 'pending' } })
  if (!sel.ok) throw new Error(sel.error)
  const r = await createBroadcastDraft(db, ADMIN, sel.selection, randomUUID())
  if (!r.ok) throw new Error(r.error)
  return r.broadcast.id
}

type SendMock = { calls: SendTemplateRequest[]; fn: (r: SendTemplateRequest) => Promise<SendTemplateResult> }
function sender(hook?: (callIdx: number) => Promise<SendTemplateResult | void>): SendMock {
  const calls: SendTemplateRequest[] = []
  return {
    calls,
    fn: async (r) => {
      calls.push(r)
      const forced = hook ? await hook(calls.length) : undefined
      return forced ?? { kind: 'accepted', wamid: `wamid.${randomUUID()}` }
    },
  }
}
const deps = (db: C1FakeDb, s: SendMock, enabled = () => true) =>
  ({ db, env: ENV, isEnabled: enabled, send: s.fn, now: () => new Date(), sleep: async () => {} })

/** Ejecuta el processor hasta que no quede nada por enviar (20 por corrida). */
async function drain(db: C1FakeDb, s: SendMock) {
  for (let i = 0; i < 30; i++) {
    const r = await processBroadcastQueue(deps(db, s))
    if (r.claimed === 0) return
  }
}

const rowsOf = (db: C1FakeDb, id: string) => db.t('wa_template_queue').filter(r => r.broadcast_id === id)
const bc = (db: C1FakeDb, id: string) => db.t('wa_broadcasts').find(b => b.id === id)!
const queueInserts = (db: C1FakeDb) => db.log.filter(l => l.table === 'wa_template_queue' && l.op === 'insert').length

/**
 * Invariante de F1: ninguna fila 'pending' pertenece a una campaña que el
 * processor ya no va a mirar (completed/cancelled) o a un borrador sin
 * preparación asociada.
 */
function orphanPending(db: C1FakeDb): Row[] {
  return db.t('wa_template_queue').filter(r => {
    if (r.status !== 'pending' || !r.broadcast_id) return false
    const b = bc(db, r.broadcast_id)
    if (['queued', 'processing', 'paused'].includes(b.status)) return false
    if (b.status === 'draft' && b.launch_request_key) return false   // preparación en curso/interrumpida (invisible al processor)
    return true
  })
}

const tick = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
// Cancelación con espera real pero corta (poll cada 5 ms, tope 400 ms).
const fastCancel = { sleep: (ms: number) => tick(Math.min(ms, 5)), maxWaitMs: 400 }

/** Borrador con selección explícita (selected_ids) de ESTOS pedidos. */
async function mkSelectedDraft(db: C1FakeDb, selected: Row[]) { return mkDraft(db, selected) }
const frozenOf = (db: C1FakeDb, id: string): string[] | null => {
  const ids = (bc(db, id).selection_filter as Row | undefined)?.launch_order_ids
  return Array.isArray(ids) ? ids as string[] : null
}

/** Reloj controlable para el presupuesto de la preparación (F5). */
function controlledClock() {
  const c = { t: Date.now(), msNow: () => c.t, budgetMs: 1_000 }
  return c
}

async function confirmAndLaunch(db: C1FakeDb, id: string, limit: number, key = randomUUID(), clock?: ReturnType<typeof controlledClock>) {
  const p = await computeLaunchPreview(db, ADMIN, id, limit, ENV, clock?.msNow)
  if (!p.ok) throw new Error(p.error)
  const r = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: key, sendLimit: limit, confirmCount: p.preview.batch.length },
    true, ENV, undefined, clock ? { msNow: clock.msNow, budgetMs: clock.budgetMs } : {})
  return { r, key, preview: p.preview }
}

/**
 * Reproducción determinista de la carrera de C.1: ejecuta el processor
 * COMPLETO después de cada escritura del lanzamiento en wa_broadcasts /
 * wa_template_queue (incluido el instante entre "encolar" e "insertar" del
 * código anterior, que dejaba la campaña completed con todas sus filas
 * pending abandonadas).
 */
function cronAfterEveryLaunchWrite(db: C1FakeDb, s: SendMock): { runs: () => number } {
  const orig = db.from.bind(db)
  let running = false, runs = 0
  db.from = ((table: string) => {
    const b = orig(table)
    if (table !== 'wa_broadcasts' && table !== 'wa_template_queue') return b
    for (const m of ['insert', 'update', 'delete'] as const) {
      const fn = b[m]
      b[m] = (...args: unknown[]) => {
        const then = b.then
        b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => then(async (v: unknown) => {
          if (!running) { running = true; runs++; try { await processBroadcastQueue(deps(db, s)) } finally { running = false } }
          return res(v)
        }, rej)
        return fn(...args)
      }
    }
    return b
  }) as typeof db.from
  return { runs: () => runs }
}

async function main() {
  console.log('\n=== F1 — carrera lanzamiento vs processor ===')
  {
    const orders = many(20)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    const p = await computeLaunchPreview(db, ADMIN, id, 20, ENV)
    // Ningún envío puede ocurrir antes de que exista el lote completo.
    let sentBeforeFullBatch = 0
    const s = sender(async () => { if (rowsOf(db, id).length !== 20) sentBeforeFullBatch++ })
    const cron = cronAfterEveryLaunchWrite(db, s)
    const r = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: randomUUID(), sendLimit: 20, confirmCount: p.ok ? p.preview.batch.length : 0 }, true, ENV)
    await drain(db, s)
    check('F1.0 cron tras CADA escritura del lanzamiento (reproducción de la carrera): 20/20 enviados, completed, 0 huérfanas',
      r.ok && cron.runs() >= 3 && sentBeforeFullBatch === 0 && s.calls.length === 20 && new Set(s.calls.map(c => c.to)).size === 20
      && bc(db, id).status === 'completed' && orphanPending(db).length === 0,
      { r, runs: cron.runs(), sentBeforeFullBatch, sent: s.calls.length, status: bc(db, id).status, orphans: orphanPending(db).length })
  }
  {
    // Reproducción determinista: la preparación se corta tras el 1er bloque
    // (presupuesto agotado) y el processor corre COMPLETO en ese hueco.
    const orders = many(120)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    const clock = controlledClock()
    db.afterInsert = (t) => { if (t === 'wa_template_queue') clock.t += 5_000 }
    const s = sender()
    const { r, key } = await confirmAndLaunch(db, id, 120, randomUUID(), clock)
    check('F1.1 preparación cortada → partial, campaña sigue en draft', r.ok && 'partial' in r && r.partial === true && bc(db, id).status === 'draft', r)
    check('F1.2 bloque ya insertado (50) invisible para el processor', rowsOf(db, id).length === LAUNCH_INSERT_CHUNK, rowsOf(db, id).length)
    const mid = await processBroadcastQueue(deps(db, s))
    check('F1.3 processor en el hueco: no envía, no toca la campaña, no la completa',
      s.calls.length === 0 && mid.broadcasts === 0 && bc(db, id).status === 'draft' && !bc(db, id).completed_at, mid)
    db.afterInsert = undefined
    const r2 = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: key, sendLimit: 120, confirmCount: 0 }, true, ENV)
    check('F1.4 continuar con la misma clave → encola con las 120 filas', r2.ok && !('partial' in r2 && r2.partial) && bc(db, id).status === 'queued'
      && rowsOf(db, id).length === 120 && bc(db, id).queued_count === 120, { r2, n: rowsOf(db, id).length })
    await drain(db, s)
    const tos = s.calls.map(c => c.to)
    check('F1.5 se envían las 120, cada una una vez, y la campaña se completa sin pendientes',
      tos.length === 120 && new Set(tos).size === 120 && bc(db, id).status === 'completed'
      && rowsOf(db, id).every(x => x.status === 'sent'), { sent: tos.length, status: bc(db, id).status })
    check('F1.6 invariante: 0 filas pending abandonadas', orphanPending(db).length === 0, orphanPending(db))
  }
  {
    // Variante concurrente: el processor arranca justo después del 1er INSERT
    // y corre en paralelo con el resto de la preparación.
    const orders = many(120)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    const s = sender()
    const workers: Promise<unknown>[] = []
    let fired = false
    db.afterInsert = (t) => { if (t === 'wa_template_queue' && !fired) { fired = true; workers.push(processBroadcastQueue(deps(db, s))) } }
    const { r } = await confirmAndLaunch(db, id, 120)
    await Promise.all(workers)
    db.afterInsert = undefined
    check('F1.7 processor concurrente con la preparación: nunca la completa a medias',
      r.ok && fired && bc(db, id).status === 'queued' && rowsOf(db, id).length === 120, { r, status: bc(db, id).status, n: rowsOf(db, id).length })
    await drain(db, s)
    check('F1.8 tras drenar: 120 enviados, completed, 0 huérfanas',
      s.calls.length === 120 && bc(db, id).status === 'completed' && orphanPending(db).length === 0, { sent: s.calls.length })
  }
  {
    // Fallo parcial de INSERT (error no-UNIQUE en el 2º bloque) + reintento.
    const orders = many(120)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    let inserts = 0
    db.failInsert = (t) => (t === 'wa_template_queue' && ++inserts === 2) ? { code: '08006', message: 'connection reset' } : null
    let threw = false
    const p = await computeLaunchPreview(db, ADMIN, id, 120, ENV)
    const key = randomUUID()
    try {
      await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: key, sendLimit: 120, confirmCount: p.ok ? p.preview.batch.length : 0 }, true, ENV)
    } catch { threw = true }
    db.failInsert = undefined
    const s = sender()
    await processBroadcastQueue(deps(db, s))
    check('F1.9 INSERT falla a mitad → error, campaña en draft con 50 preparadas, nada enviado',
      threw && bc(db, id).status === 'draft' && rowsOf(db, id).length === 50 && s.calls.length === 0, { threw, status: bc(db, id).status, n: rowsOf(db, id).length })
    const r2 = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: key, sendLimit: 120, confirmCount: 0 }, true, ENV)
    check('F1.10 reintento con la misma clave completa sin duplicar', r2.ok && rowsOf(db, id).length === 120
      && new Set(rowsOf(db, id).map(x => x.order_id)).size === 120 && bc(db, id).status === 'queued', r2)
    await drain(db, s)
    check('F1.11 tras reintento: 120 enviados una vez, 0 huérfanas', s.calls.length === 120 && new Set(s.calls.map(c => c.to)).size === 120
      && orphanPending(db).length === 0 && bc(db, id).status === 'completed', s.calls.length)
  }
  {
    // Preparación abandonada (otra clave) → bloqueo temporal → retomar tras expirar.
    const orders = many(80)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    const clock = controlledClock()
    db.afterInsert = (t) => { if (t === 'wa_template_queue') clock.t += 5_000 }
    const first = await confirmAndLaunch(db, id, 80, randomUUID(), clock)
    db.afterInsert = undefined
    const blocked = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: randomUUID(), sendLimit: 80, confirmCount: 80 },
      true, ENV, undefined, { msNow: clock.msNow })
    check('F1.12 otra clave mientras la preparación está viva → 409', first.r.ok && !blocked.ok && blocked.status === 409, blocked)
    clock.t += LAUNCH_PREP_STALE_MS + 1_000
    const p = await computeLaunchPreview(db, ADMIN, id, 80, ENV, clock.msNow)
    const prepared = new Set(rowsOf(db, id).map(x => x.order_id))
    check('F1.13 vista previa: preparación interrumpida, preparados primero en el lote',
      p.ok && p.preview.preparation === 'interrupted' && p.preview.prepared_count === 50
      && p.preview.batch.slice(0, 50).every(b => prepared.has(b.order_id)) && p.preview.batch.length === 80, p.ok && p.preview.preparation)
    const take = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: randomUUID(), sendLimit: 80, confirmCount: p.ok ? p.preview.batch.length : 0 },
      true, ENV, undefined, { msNow: clock.msNow })
    check('F1.14 retomar con clave nueva tras expirar → encola exactamente el lote confirmado', take.ok && bc(db, id).status === 'queued'
      && rowsOf(db, id).length === 80 && new Set(rowsOf(db, id).map(x => x.phone_normalized)).size === 80, take)
  }
  {
    // Reconciliación: un pedido ya preparado deja de ser elegible antes de encolar.
    const orders = many(60)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    const clock = controlledClock()
    db.afterInsert = (t) => { if (t === 'wa_template_queue') clock.t += 5_000 }
    const { key } = await confirmAndLaunch(db, id, 60, randomUUID(), clock)
    db.afterInsert = undefined
    const preparedOrder = rowsOf(db, id)[0].order_id
    orders.find(o => o.id === preparedOrder)!.payment_status = 'paid'
    const r = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: key, sendLimit: 60, confirmCount: 0 }, true, ENV)
    check('F1.15 fila preparada que dejó de ser enviable se retira antes de encolar',
      r.ok && !rowsOf(db, id).some(x => x.order_id === preparedOrder) && rowsOf(db, id).length === 59 && bc(db, id).queued_count === 59, { r, n: rowsOf(db, id).length })
  }
  {
    // Otra campaña activa: se rechaza ANTES de preparar filas.
    const a = many(3), b = many(3)
    const db = seedDb([...a, ...b])
    const idA = await mkDraft(db, a)
    await confirmAndLaunch(db, idA, 10)
    await pauseBroadcast(db, ADMIN, idA)
    const idB = await mkDraft(db, b)
    const before = rowsOf(db, idB).length
    const { r } = await confirmAndLaunch(db, idB, 10)
    check('F1.16 otra campaña pausada en la tienda → 409 sin preparar filas', !r.ok && r.status === 409 && before === 0 && rowsOf(db, idB).length === 0
      && !bc(db, idB).launch_request_key, r)
  }

  console.log('\n=== F5 — preparación por bloques ===')
  {
    const orders = many(120)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    const before = queueInserts(db)
    await confirmAndLaunch(db, id, 120)
    check(`F5.1 120 destinatarios = 3 INSERT de hasta ${LAUNCH_INSERT_CHUNK}`, queueInserts(db) - before === 3, queueInserts(db) - before)
  }
  {
    // Choque UNIQUE dentro de un bloque → reintento fila a fila absorbiendo 23505.
    const orders = many(10)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    let first = true
    db.failInsert = (t, payloads) => {
      if (t !== 'wa_template_queue' || !first || payloads.length < 2) return null
      first = false
      return { code: '23505', message: 'duplicate key value violates unique constraint "idx_wa_template_queue_broadcast_phone"' }
    }
    const { r } = await confirmAndLaunch(db, id, 10)
    db.failInsert = undefined
    check('F5.2 23505 en un bloque → fallback fila a fila, lote completo', r.ok && rowsOf(db, id).length === 10 && bc(db, id).status === 'queued', r)
  }
  {
    // Doble clic con la MISMA clave en paralelo (incl. ambos preparando).
    const orders = many(70)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    const p = await computeLaunchPreview(db, ADMIN, id, 70, ENV)
    const input = { broadcastId: id, launchRequestKey: randomUUID(), sendLimit: 70, confirmCount: p.ok ? p.preview.batch.length : 0 }
    const [r1, r2] = await Promise.all([launchBroadcast(db, ADMIN, input, true, ENV), launchBroadcast(db, ADMIN, input, true, ENV)])
    check('F5.3 doble clic misma clave → ambos ok, 70 filas sin duplicar', r1.ok && r2.ok && rowsOf(db, id).length === 70
      && bc(db, id).status === 'queued', [r1, r2])
  }
  {
    const route = readFileSync('src/app/api/admin/broadcasts/[id]/launch/route.ts', 'utf8')
    check('F5.4 ruta de lanzamiento: maxDuration = 60 y 202 para parcial',
      /export const maxDuration = 60\b/.test(route) && /status: 202/.test(route))
    check('F5.5 presupuesto < maxDuration < expiración de preparación',
      LAUNCH_TIME_BUDGET_MS < 60_000 && LAUNCH_PREP_STALE_MS > 60_000, { LAUNCH_TIME_BUDGET_MS, LAUNCH_PREP_STALE_MS })
    const modal = readFileSync('src/components/broadcast/BroadcastLaunchModal.tsx', 'utf8')
    check('F5.6 modal: repite con la misma clave ante 202', /r\.status !== 202/.test(modal) && /launch_request_key: launchKey/.test(modal))
  }

  console.log('\n=== F2 — cancelación ===')
  {
    // Campaña pausada con enviados, fallido, incierto y pendientes.
    const orders = many(7)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    await confirmAndLaunch(db, id, 7)
    const results: Array<SendTemplateResult['kind']> = ['accepted', 'accepted', 'rejected', 'ambiguous']
    let paused = false
    const s = sender(async (n) => {
      const k = results[n - 1]
      if (n === 4 && !paused) { paused = true; await pauseBroadcast(db, ADMIN, id) }
      if (k === 'rejected') return { kind: 'rejected', httpStatus: 400, metaCode: '131026', error: 'x' }
      if (k === 'ambiguous') return { kind: 'ambiguous', error: 'timeout' }
    })
    await processBroadcastQueue(deps(db, s))
    const byStatus = (st: string) => rowsOf(db, id).filter(x => x.status === st)
    const kept = rowsOf(db, id).filter(x => x.status !== 'pending').map(x => ({ ...x }))
    const pendingOrders = byStatus('pending').map(x => x.order_id)
    check('F2.0 escenario: pausada con 2 sent, 1 failed, 1 send_unknown, 3 pending', bc(db, id).status === 'paused'
      && byStatus('sent').length === 2 && byStatus('failed').length === 1 && byStatus('send_unknown').length === 1 && pendingOrders.length === 3,
      rowsOf(db, id).map(x => x.status))

    const c = await cancelBroadcast(db, ADMIN, id)
    check('F2.1 cancelar pausada → cancelled + cancelled_at, 3 liberados', c.ok && c.released === 3 && bc(db, id).status === 'cancelled'
      && !!bc(db, id).cancelled_at && !bc(db, id).completed_at, c)
    check('F2.2 enviados / fallido / incierto intactos (historial)',
      JSON.stringify(rowsOf(db, id).filter(x => x.status !== 'pending')) === JSON.stringify(kept) && byStatus('pending').length === 0)
    const hist = db.t('order_history')
    check('F2.3 rastro por pedido liberado en order_history (quién, campaña)', hist.length === 3
      && hist.every(h => h.changed_by === ADMIN.userId && h.field === 'whatsapp_broadcast' && String(h.old_value).includes(id.slice(0, 8)))
      && pendingOrders.every(o => hist.some(h => h.order_id === o)), hist)
    const again = await cancelBroadcast(db, ADMIN, id)
    check('F2.4 cancelar de nuevo → idempotente (already_cancelled, 0 liberados, sin rastro duplicado)',
      again.ok && again.already_cancelled && again.released === 0 && db.t('order_history').length === 3, again)

    // Desbloqueo: una campaña nueva puede incluir a los liberados, nunca a los ya contactados.
    const id2 = await mkDraft(db, orders)
    const p2 = await computeLaunchPreview(db, ADMIN, id2, 50, ENV)
    const batch2 = new Set(p2.ok ? p2.preview.batch.map(b => b.order_id) : [])
    const contacted = kept.map(x => x.order_id)
    check('F2.5 liberados vuelven a ser enviables en una campaña nueva', p2.ok && pendingOrders.every(o => batch2.has(o)), p2.ok && p2.preview.batch.length)
    check('F2.6 enviados/fallidos/inciertos NO se vuelven a contactar', contacted.every(o => !batch2.has(o)))
    const { r: r2 } = await confirmAndLaunch(db, id2, 50)
    check('F2.7 cupo de campaña activa liberado al cancelar (se puede lanzar otra)', r2.ok && bc(db, id2).status === 'queued', r2)
  }
  {
    const o = many(2)
    const db = seedDb(o)
    const id = await mkDraft(db, o)
    await confirmAndLaunch(db, id, 5)
    await drain(db, sender())
    const done = await cancelBroadcast(db, ADMIN, id)
    const foreign = await cancelBroadcast(db, { userId: 'x', storeId: S2 }, id)
    check('F2.8 completada → 409; otra tienda → 404', !done.ok && done.status === 409 && !foreign.ok && foreign.status === 404, [done, foreign])
  }
  {
    // Cancelación con el processor en pleno envío: la fila en vuelo termina
    // (sent), el resto se libera, no hay más envíos. La cancelación corre en
    // paralelo al envío (como en producción) y solo se confirma al terminar.
    const orders = many(6)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    await confirmAndLaunch(db, id, 6)
    let cancelP: Promise<unknown> | null = null
    const s = sender(async (n) => {
      if (n === 2) { cancelP = cancelBroadcast(db, ADMIN, id, undefined, fastCancel); await tick(30) }
    })
    await processBroadcastQueue(deps(db, s))
    await cancelP
    await processBroadcastQueue(deps(db, s))
    check('F2.9 cancelar durante el envío: en vuelo → sent, no se envía nada más, 0 pending',
      s.calls.length === 2 && rowsOf(db, id).filter(x => x.status === 'sent').length === 2
      && rowsOf(db, id).every(x => x.status !== 'pending') && orphanPending(db).length === 0, rowsOf(db, id).map(x => x.status))
  }
  {
    // Cancelación mientras Meta responde 429: la fila vuelve a pending y se
    // libera (no queda huérfana).
    const orders = many(3)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    await confirmAndLaunch(db, id, 3)
    let cancelP: Promise<unknown> | null = null
    const s = sender(async () => {
      cancelP = cancelBroadcast(db, ADMIN, id, undefined, fastCancel)
      await tick(30)
      return { kind: 'rate_limited', httpStatus: 429, metaCode: '130429', error: 'rate' }
    })
    await processBroadcastQueue(deps(db, s))
    await cancelP
    check('F2.10 cancelar durante un 429 → la fila reprogramada se libera, 0 huérfanas',
      s.calls.length === 1 && rowsOf(db, id).length === 0 && orphanPending(db).length === 0
      && db.t('order_history').length === 3, { rows: rowsOf(db, id), hist: db.t('order_history').length })
  }
  {
    // Cancelar un borrador con preparación interrumpida.
    const orders = many(80)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    const clock = controlledClock()
    db.afterInsert = (t) => { if (t === 'wa_template_queue') clock.t += 5_000 }
    const { key } = await confirmAndLaunch(db, id, 80, randomUUID(), clock)
    db.afterInsert = undefined
    const c = await cancelBroadcast(db, ADMIN, id)
    const replay = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: key, sendLimit: 80, confirmCount: 0 }, true, ENV)
    check('F2.11 cancelar borrador a medio preparar → libera las 50 y el reintento responde 409',
      c.ok && c.released === 50 && rowsOf(db, id).length === 0 && !replay.ok && replay.status === 409, { c, replay })
  }
  {
    // Sin rastro no se elimina nada.
    const orders = many(3)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    await confirmAndLaunch(db, id, 3)
    await pauseBroadcast(db, ADMIN, id)
    db.failInsert = (t) => t === 'order_history' ? { code: '42501', message: 'denied' } : null
    let threw = false
    try { await cancelBroadcast(db, ADMIN, id) } catch { threw = true }
    check('F2.12 si order_history falla → no se elimina ninguna fila', threw && rowsOf(db, id).length === 3)
    db.failInsert = undefined
    const retry = await cancelBroadcast(db, ADMIN, id)
    check('F2.13 reintentar la cancelación completa la liberación', retry.ok && retry.already_cancelled && retry.released === 3 && rowsOf(db, id).length === 0, retry)
  }
  {
    const strip = (p: string) => readFileSync(p, 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const auto = ['src/lib/broadcast/processor.ts', 'src/app/api/cron/wa-broadcast-queue/route.ts', 'src/lib/broadcast/launch.ts'].map(strip).join('\n')
    check('F2.14 ningún camino automático cancela campañas (processor/cron/launch)',
      !/cancelBroadcast\(/.test(auto) && !/status:\s*'cancelled'/.test(auto))
    const route = strip('src/app/api/admin/broadcasts/[id]/cancel/route.ts')
    check('F2.15 endpoint de cancelación: admin + confirmación explícita, sin depender del flag',
      /getBroadcastAdminContext/.test(route) && /acknowledge_cancel !== true/.test(route) && !/isWaBroadcastEnabled/.test(route))
  }

  console.log('\n=== R1 — destinatarios exactos del piloto (selected_ids) ===')
  {
    // 10 seleccionados, límite 10 + otro pedido elegible FUERA de la selección.
    const sel = many(10), outside = mkOrder()
    const db = seedDb([...sel, outside])
    const id = await mkSelectedDraft(db, sel)
    const { r } = await confirmAndLaunch(db, id, 10)
    const selIds = new Set(sel.map(o => o.id))
    check('R1.1 lote = exactamente los 10 seleccionados (nunca uno ajeno)', r.ok && rowsOf(db, id).length === 10
      && rowsOf(db, id).every(x => selIds.has(x.order_id)) && !rowsOf(db, id).some(x => x.order_id === outside.id), r)
    check('R1.2 lote congelado en selection_filter.launch_order_ids (solo IDs)',
      frozenOf(db, id)?.length === 10 && frozenOf(db, id)!.every(x => selIds.has(x)))
    sel[3].payment_status = 'paid'                 // deja de ser elegible tras encolar
    const s = sender()
    await drain(db, s)
    const sentTo = new Set(s.calls.map(c => c.to))
    check('R1.3 el que dejó de ser elegible se omite y NO se sustituye (9 envíos, todos de la selección)',
      s.calls.length === 9 && !sentTo.has(phoneOfOrder(sel[3])) && !sentTo.has(phoneOfOrder(outside))
      && rowsOf(db, id).find(x => x.order_id === sel[3].id)?.status === 'skipped', s.calls.length)
  }
  {
    // 60 seleccionados, límite 55 (> un bloque, para forzar preparación
    // parcial): reintento con la misma clave con un confirmado ya inelegible.
    const sel = many(60)
    const db = seedDb(sel)
    const id = await mkSelectedDraft(db, sel)
    const clock = controlledClock()
    db.afterInsert = (t) => { if (t === 'wa_template_queue') clock.t += 5_000 }
    const { r, key, preview } = await confirmAndLaunch(db, id, 55, randomUUID(), clock)
    db.afterInsert = undefined
    const confirmed = new Set(preview.batch.map(b => b.order_id))
    const notInBatch = preview.batch.length === 55 ? sel.filter(o => !confirmed.has(o.id)) : []
    // Un confirmado AÚN NO preparado deja de ser elegible.
    const prepared = new Set(rowsOf(db, id).map(x => x.order_id))
    const victim = preview.batch.find(b => !prepared.has(b.order_id))!
    sel.find(o => o.id === victim.order_id)!.tracking_number = 'EFI-1'
    const r2 = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: key, sendLimit: 55, confirmCount: 0 }, true, ENV)
    const final = rowsOf(db, id).map(x => x.order_id)
    check('R1.4 reintento misma clave: ninguno fuera de lo confirmado entra, el inelegible se excluye, ≤ send_limit',
      r.ok && 'partial' in r && r.partial === true && r2.ok && notInBatch.length === 5
      && final.length === 54 && final.every(o => confirmed.has(o)) && !final.includes(victim.order_id)
      && notInBatch.every(o => !final.includes(o.id)) && bc(db, id).status === 'queued', { r2, n: final.length })
  }
  {
    // INSERT falla por completo en el primer intento; reintento misma clave.
    const sel = many(15)
    const db = seedDb(sel)
    const id = await mkSelectedDraft(db, sel)
    const p = await computeLaunchPreview(db, ADMIN, id, 10, ENV)
    const confirmed = new Set(p.ok ? p.preview.batch.map(b => b.order_id) : [])
    const key = randomUUID()
    db.failInsert = (t) => t === 'wa_template_queue' ? { code: '08006', message: 'connection reset' } : null
    let threw = false
    try { await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: key, sendLimit: 10, confirmCount: 10 }, true, ENV) } catch { threw = true }
    db.failInsert = undefined
    const victim = [...confirmed][0]
    sel.find(o => o.id === victim)!.confirmation_status = 'cancelled'
    const r2 = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: key, sendLimit: 10, confirmCount: 0 }, true, ENV)
    const final = rowsOf(db, id).map(x => x.order_id)
    check('R1.5 tras fallo total de INSERT: el reintento usa el lote congelado (9), sin sustitutos',
      threw && r2.ok && final.length === 9 && final.every(o => confirmed.has(o)) && !final.includes(victim), { r2, n: final.length })
  }
  {
    // Retoma con clave nueva tras abandono, pidiendo un límite MAYOR.
    const sel = many(70)
    const db = seedDb(sel)
    const id = await mkSelectedDraft(db, sel)
    const clock = controlledClock()
    db.afterInsert = (t) => { if (t === 'wa_template_queue') clock.t += 5_000 }
    const { preview } = await confirmAndLaunch(db, id, 60, randomUUID(), clock)
    db.afterInsert = undefined
    const confirmed = new Set(preview.batch.map(b => b.order_id))
    clock.t += LAUNCH_PREP_STALE_MS + 1_000
    const p2 = await computeLaunchPreview(db, ADMIN, id, 70, ENV, clock.msNow)
    const take = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: randomUUID(), sendLimit: 70, confirmCount: p2.ok ? p2.preview.batch.length : 0 },
      true, ENV, undefined, { msNow: clock.msNow })
    const final = rowsOf(db, id).map(x => x.order_id)
    check('R1.6 retoma con límite mayor: sigue limitada al lote confirmado (60) y send_limit no sube',
      p2.ok && p2.preview.batch.length === 60 && p2.preview.frozen_count === 60 && take.ok
      && final.length === 60 && final.every(o => confirmed.has(o)) && bc(db, id).send_limit === 60, { take, n: final.length, limit: bc(db, id).send_limit })
  }
  {
    // Doble clic misma clave en paralelo sobre selección > límite.
    const sel = many(15)
    const db = seedDb(sel)
    const id = await mkSelectedDraft(db, sel)
    const p = await computeLaunchPreview(db, ADMIN, id, 10, ENV)
    const input = { broadcastId: id, launchRequestKey: randomUUID(), sendLimit: 10, confirmCount: p.ok ? p.preview.batch.length : 0 }
    const [a, b] = await Promise.all([launchBroadcast(db, ADMIN, input, true, ENV), launchBroadcast(db, ADMIN, input, true, ENV)])
    const frozen = new Set(frozenOf(db, id) ?? [])
    check('R1.7 doble clic: ≤ 10 filas, todas del lote congelado', a.ok && b.ok && rowsOf(db, id).length === 10
      && rowsOf(db, id).every(x => frozen.has(x.order_id)), [a, b])
    const s = sender()
    await drain(db, s)
    check('R1.8 envíos totales nunca superan send_limit', s.calls.length <= 10 && s.calls.length === 10, s.calls.length)
  }

  console.log('\n=== R2 — cancelación concurrente y no duplicados ===')
  {
    // Cancelación en paralelo con el processor: ningún envío DESPUÉS de que
    // la cancelación se confirma; el envío en vuelo termina antes de confirmar.
    const orders = many(8)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    await confirmAndLaunch(db, id, 8)
    let cancelConfirmed = false, sendsAfterConfirm = 0, inFlightDoneBeforeConfirm = false
    let cancelP: Promise<{ ok: boolean; in_flight_unsettled?: number }> | null = null
    const s = sender(async (n) => {
      if (cancelConfirmed) sendsAfterConfirm++
      if (n === 3) {
        cancelP = cancelBroadcast(db, ADMIN, id, undefined, fastCancel).then(r => { cancelConfirmed = true; return r as { ok: boolean; in_flight_unsettled?: number } })
        await tick(40)                        // latencia de Meta con la cancelación ya en curso
        inFlightDoneBeforeConfirm = !cancelConfirmed
      }
    })
    await Promise.all([processBroadcastQueue(deps(db, s)), processBroadcastQueue(deps(db, s))])
    const cr = await cancelP!
    await processBroadcastQueue(deps(db, s))
    const kept = rowsOf(db, id).filter(x => x.status !== 'pending')
    check('R2.1 la cancelación solo se confirma cuando el envío en vuelo terminó', inFlightDoneBeforeConfirm && cr.ok && cr.in_flight_unsettled === 0, cr)
    check('R2.2 cero envíos después de confirmada la cancelación (2 workers)', sendsAfterConfirm === 0 && s.calls.length <= 4, { sendsAfterConfirm, calls: s.calls.length })
    check('R2.3 filas enviadas conservadas; 0 pending', kept.length === s.calls.length && kept.every(x => x.status === 'sent') && orphanPending(db).length === 0)
  }
  {
    // Envío que no termina dentro del tope: se informa, la fila NO se borra
    // y el teléfono queda excluido de campañas futuras.
    const orders = many(3)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    await confirmAndLaunch(db, id, 3)
    let release: () => void = () => {}
    let cancelR: { ok: boolean; in_flight_unsettled?: number } | null = null
    const s = sender(async (n) => {
      if (n === 1) {
        const c = await cancelBroadcast(db, ADMIN, id, undefined, { ...fastCancel, maxWaitMs: 60 })
        cancelR = c as typeof cancelR
        await new Promise<void>(r => { release = r; setTimeout(r, 10) })
      }
    })
    await processBroadcastQueue(deps(db, s))
    release()
    const row = rowsOf(db, id)[0]
    check('R2.4 en vuelo que no termina a tiempo → in_flight_unsettled=1 y la fila no se elimina',
      cancelR !== null && (cancelR as { in_flight_unsettled?: number }).in_flight_unsettled === 1 && !!row, { cancelR, rows: rowsOf(db, id).map(x => x.status) })
  }
  {
    // Nunca se borran sent / send_unknown / failed / processing (aceptado por
    // Meta sin registro final) y todos siguen excluidos en campañas futuras.
    const orders = many(6)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    await confirmAndLaunch(db, id, 6)
    await pauseBroadcast(db, ADMIN, id)
    const rs = rowsOf(db, id)
    const old = new Date(Date.now() - 30 * 60_000).toISOString()
    rs[0].status = 'sent';         rs[0].wa_message_id = 'wamid.A'
    rs[1].status = 'send_unknown'
    rs[2].status = 'failed'
    rs[3].status = 'processing';   rs[3].last_attempted_at = old   // Meta aceptó, el worker murió antes de registrar
    const before = rs.slice(0, 4).map(x => ({ ...x }))
    const c = await cancelBroadcast(db, ADMIN, id, undefined, fastCancel)
    const after = rowsOf(db, id)
    check('R2.5 cancelar conserva sent / send_unknown / failed / processing; libera solo pending',
      c.ok && c.released === 2 && after.length === 4 && JSON.stringify(after) === JSON.stringify(before), { c, after: after.map(x => x.status) })
    const id2 = await mkDraft(db, orders)
    const p2 = await computeLaunchPreview(db, ADMIN, id2, 50, ENV)
    const batch2 = new Set(p2.ok ? p2.preview.batch.map(b => b.order_id) : [])
    check('R2.6 esos 4 destinatarios siguen excluidos de campañas futuras; los 2 liberados no',
      p2.ok && before.every(x => !batch2.has(x.order_id)) && batch2.size === 2, p2.ok && [...batch2].length)
  }

  console.log('\n=== F3 — vista previa con flag OFF ===')
  {
    const orders = many(4)
    const db = seedDb(orders)
    const id = await mkDraft(db, orders)
    const p = await computeLaunchPreview(db, ADMIN, id, 10, ENV)
    check('F3.1 vista previa disponible y con template_ready (flag no interviene)', p.ok && p.preview.batch.length === 4 && p.preview.template_ready, p)
    const writesBefore = db.log.filter(l => l.op !== 'select').length
    const off = await launchBroadcast(db, ADMIN, { broadcastId: id, launchRequestKey: randomUUID(), sendLimit: 10, confirmCount: 4 }, false, ENV)
    check('F3.2 lanzar con flag OFF → 403 y CERO escrituras', !off.ok && off.status === 403
      && db.log.filter(l => l.op !== 'select').length === writesBefore && bc(db, id).status === 'draft' && !bc(db, id).launch_request_key, off)
    await confirmAndLaunch(db, id, 10)
    await pauseBroadcast(db, ADMIN, id)
    const res = await resumeBroadcast(db, ADMIN, id, false)
    const s = sender()
    const proc = await processBroadcastQueue(deps(db, s, () => false))
    check('F3.3 reanudar con flag OFF → 403; processor OFF → no envía', !res.ok && res.status === 403 && proc.disabled === true && s.calls.length === 0)
    const panel = readFileSync('src/components/broadcast/BroadcastCampaignPanel.tsx', 'utf8')
    const modal = readFileSync('src/components/broadcast/BroadcastLaunchModal.tsx', 'utf8')
    check('F3.4 panel: con flag OFF ofrece "Ver vista previa" (antes: botón deshabilitado)',
      /Ver vista previa del envío/.test(panel) && !/disabled=\{!d\.broadcast_enabled\}\s*\n\s*title=/.test(panel))
    check('F3.5 modal: el botón de envío y la confirmación solo existen con el flag ON',
      /\{preview\?\.broadcast_enabled && \(\s*\n\s*<button onClick=\{launch\}/.test(modal)
      && /\{preview\.broadcast_enabled && \(\s*\n\s*<div className="rounded-lg border border-red-200/.test(modal)
      && /preview\.broadcast_enabled && preview\.template_ready && count > 0/.test(modal))
  }

  console.log(failures === 0 ? '\n✅ TODO OK' : `\n❌ ${failures} FALLOS`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
