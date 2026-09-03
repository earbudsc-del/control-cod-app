// Pruebas de regresión — loadAgentActionsForOrders (chunking + filtro `since`
// opcional retrocompatible). src/lib/deliveries/load-agent-actions.ts
//
// Corre con: npx tsx scripts/test-load-agent-actions.ts
//
// Motivo: se extendió el helper (Sprint Crítico 3, ya probado en producción)
// para aceptar `options.since` opcional, de forma que
// POST /api/v1/deliveries/routes/[id]/complete pueda dejar de usar su propio
// .in('order_id', orderIds) sin chunking y reutilizar este helper sin perder
// su corte de 7 días. Estas pruebas demuestran que:
//   - sin `since`: comportamiento IDÉNTICO al de antes de este cambio.
//   - con `since`: cada chunk agrega .gte('created_at', since).
//   - el chunking (100 IDs por chunk) sigue funcionando con 250 IDs.
//   - el resultado combinado de varios chunks queda globalmente ordenado
//     por created_at DESC, sin importar el orden en que cada chunk responda.
//   - un error en cualquier chunk sigue propagándose de inmediato (no se
//     traga silenciosamente).
//
// Sin conexión a Supabase real — mock determinista del query builder
// encadenado (.from().select().in().in()[.gte()].order()), como pide la
// tarea. loadAgentActionsForOrders es agnóstico del cliente real: solo
// necesita que cada método de la cadena devuelva `this` y que `.order()`
// resuelva `{ data, error }`.
//
// tsconfig de este repo compila a CJS (a diferencia de ruta-cod) — sin
// top-level await, todo corre dentro de main().

import { loadAgentActionsForOrders, AGENT_ACTIONS_CHUNK_SIZE, type AgentActionRow } from '../src/lib/deliveries/load-agent-actions'

let failures = 0

function assertEqual(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label} — esperado=${JSON.stringify(expected)} obtenido=${JSON.stringify(actual)}`)
}

function assertTrue(label: string, cond: boolean) {
  if (!cond) failures++
  console.log(`${cond ? '✅' : '❌'} ${label}`)
}

interface CapturedCall {
  orderIds: string[]
  actionTypes: string[]
  since?: string
}

type Responder = (call: CapturedCall, callIndex: number) => { data: AgentActionRow[] | null; error: { message: string } | null }

// Mock mínimo del query builder de Supabase — encadenable, estado compartido
// entre pasos de UNA sola invocación (correcto porque loadAgentActionsForOrders
// es secuencial: cada chunk se resuelve con `await` antes de iniciar el
// siguiente, nunca hay dos invocaciones en vuelo al mismo tiempo).
function createMockSupabase(responder: Responder) {
  const calls: CapturedCall[] = []
  let pending: Partial<CapturedCall> = {}

  const builder: any = {
    from(_table: string) { pending = {}; return builder },
    select(_cols: string) { return builder },
    in(col: string, vals: string[]) {
      if (col === 'order_id') pending.orderIds = vals
      if (col === 'action_type') pending.actionTypes = vals
      return builder
    },
    gte(col: string, val: string) {
      if (col === 'created_at') pending.since = val
      return builder
    },
    order(_col: string, _opts: unknown) {
      const call: CapturedCall = { orderIds: pending.orderIds ?? [], actionTypes: pending.actionTypes ?? [], since: pending.since }
      calls.push(call)
      const result = responder(call, calls.length - 1)
      return Promise.resolve(result)
    },
  }
  return { client: builder, calls }
}

function row(orderId: string, actionType: string, createdAt: string): AgentActionRow {
  return { order_id: orderId, action_type: actionType, contact_result: null, created_at: createdAt }
}

async function main() {
  // ── CASO A: sin `since` → comportamiento idéntico al de siempre ──────────
  {
    const { client, calls } = createMockSupabase(() => ({
      data: [row('o1', 'route_confirmed', '2026-09-01T10:00:00Z')],
      error: null,
    }))

    // sin options en absoluto (forma en que llaman los 3 endpoints ya migrados)
    const rowsNoArg = await loadAgentActionsForOrders(client, ['o1'])
    assertEqual('A: sin since → no se agrega .gte (call.since undefined)', calls[0].since, undefined)
    assertEqual('A: sin since → devuelve las filas del mock sin filtrar', rowsNoArg.length, 1)

    // con options={} explícito → debe comportarse igual
    const rowsEmptyOptions = await loadAgentActionsForOrders(client, ['o1'], {})
    assertEqual('A2: options={} → tampoco agrega .gte', calls[1].since, undefined)
    assertEqual('A2: mismo resultado que sin options', rowsEmptyOptions.length, rowsNoArg.length)
    assertEqual('A: action_type filtrado sigue siendo el mismo set de 4', calls[0].actionTypes, ['route_confirmed', 'rescheduled', 'customer_declined', 'contacted'])
  }

  // ── CASO B: con `since` → filtra por fecha en cada chunk ─────────────────
  {
    const since = '2026-08-25T00:00:00Z'
    const { client, calls } = createMockSupabase(() => ({ data: [], error: null }))

    await loadAgentActionsForOrders(client, ['o1', 'o2'], { since })
    assertEqual('B: .gte(created_at, since) se agrega cuando since está presente', calls[0].since, since)
  }

  // ── CASO C: 250 orderIds + since → 3 chunks (100/100/50), since en los 3 ─
  {
    const since = '2026-08-01T00:00:00Z'
    const orderIds = Array.from({ length: 250 }, (_, i) => `order-${i}`)
    const { client, calls } = createMockSupabase(() => ({ data: [], error: null }))

    await loadAgentActionsForOrders(client, orderIds, { since })

    assertEqual('C: 250 IDs producen exactamente 3 chunks', calls.length, 3)
    assertEqual('C: chunk 1 tiene 100 ids', calls[0].orderIds.length, AGENT_ACTIONS_CHUNK_SIZE)
    assertEqual('C: chunk 2 tiene 100 ids', calls[1].orderIds.length, AGENT_ACTIONS_CHUNK_SIZE)
    assertEqual('C: chunk 3 tiene 50 ids (resto)', calls[2].orderIds.length, 50)
    assertTrue('C: since presente en los 3 chunks', calls.every(c => c.since === since))
    // Ningún id se pierde ni se duplica entre chunks
    const allIdsSeen = calls.flatMap(c => c.orderIds)
    assertEqual('C: unión de ids de los 3 chunks = 250 sin duplicados', new Set(allIdsSeen).size, 250)
  }

  // ── CASO D: resultado combinado queda globalmente ordenado created_at DESC
  {
    // Cada chunk responde ya ordenado desc INTERNAMENTE, pero el chunk 2
    // (llamado después) trae filas más RECIENTES que el chunk 1 — simula el
    // caso real donde el orden entre chunks no está garantizado.
    const { client } = createMockSupabase((_call, callIndex) => {
      if (callIndex === 0) {
        return { data: [row('a', 'contacted', '2026-09-01T08:00:00Z'), row('b', 'contacted', '2026-09-01T07:00:00Z')], error: null }
      }
      return { data: [row('c', 'contacted', '2026-09-02T09:00:00Z')], error: null } // más reciente, llega en el chunk 2
    })

    // Fuerza 2 chunks con chunkSize=1 explícito (no cambia AGENT_ACTIONS_CHUNK_SIZE global)
    const rows = await loadAgentActionsForOrders(client, ['x', 'y'], { chunkSize: 1 })
    const timestamps = rows.map(r => r.created_at)
    const sortedDesc = [...timestamps].sort((a, b) => new Date(b).getTime() - new Date(a).getTime())
    assertEqual('D: resultado combinado queda ordenado created_at DESC globalmente', timestamps, sortedDesc)
    assertEqual('D: la fila más reciente (chunk 2) queda primera', rows[0].order_id, 'c')
  }

  // ── CASO E: fallo de cualquier chunk → sigue lanzando error de inmediato ─
  {
    const { client } = createMockSupabase((_call, callIndex) => {
      if (callIndex === 1) return { data: null, error: { message: 'boom simulado' } }
      return { data: [row('ok', 'contacted', '2026-09-01T08:00:00Z')], error: null }
    })

    let threw = false
    let message = ''
    try {
      await loadAgentActionsForOrders(client, ['x', 'y'], { chunkSize: 1 }) // 2 chunks: el 2do falla
    } catch (err) {
      threw = true
      message = err instanceof Error ? err.message : String(err)
    }
    assertTrue('E: un chunk fallido hace que la función lance (no se traga el error)', threw)
    assertTrue('E: el mensaje de error incluye el motivo del chunk', message.includes('boom simulado'))
  }

  if (failures > 0) {
    console.error(`\n${failures} prueba(s) fallaron.`)
    process.exit(1)
  }
  console.log('\nTodas las pruebas de loadAgentActionsForOrders pasaron.')
}

main().catch(err => {
  console.error('Error inesperado ejecutando las pruebas:', err)
  process.exit(1)
})
