// Sprint Broadcast B.2.2 — lookup canónico findActiveSdOrdersByPhone.
//
// Determinístico, DB en memoria (el operador `match` se emula con RegExp —
// el patrón generado es compatible con regex POSIX de Postgres).
// NO toca la DB real, NO envía nada.
//
// Corre con: npx tsx scripts/test-active-sd-orders-lookup.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FakeDb, type Row } from './lib/broadcast-fake-db'
import { findActiveSdOrdersByPhone, phoneSuffixPattern } from '../src/lib/deliveries/active-sd-orders-by-phone'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

const S1 = 'store-1', S2 = 'store-2'
const WA = '18095551234'   // msg.from normalizado (normalizePhoneRD)
const DAY = 86_400_000
let n = 0
function mk(o: Partial<Row> = {}): Row {
  n++
  return {
    id: randomUUID(), store_id: S1, customer_phone: '809-555-1234', city: 'Santo Domingo Este', province: 'Santo Domingo',
    customer_address: 'Calle 3', tracking_number: null, normalized_status: 'pending', confirmation_status: 'pending',
    payment_status: 'pending', is_test: false, archived_at: null,
    created_at: new Date(Date.now() - (1000 - n) * 60_000).toISOString(), ...o,
  }
}
const ids = (r: Array<{ id: string }>) => r.map(x => x.id)

async function main() {
  console.log('=== Lookup dirigido ===\n')
  {
    const db = new FakeDb()
    const old = mk({ created_at: new Date(Date.now() - 120 * DAY).toISOString() })
    db.tables.orders.push(old)
    // 300 pedidos más recientes de OTROS teléfonos (antes: solo se miraban los últimos 200 de la tienda).
    for (let i = 0; i < 300; i++) db.tables.orders.push(mk({ customer_phone: `829-${String(100 + i).padStart(3, '0')}-${String(1000 + i)}` }))
    const r = await findActiveSdOrdersByPhone(db, S1, WA)
    check('D. pedido activo más viejo que 200 pedidos globales → encontrado', r.length === 1 && r[0].id === old.id, ids(r))
    const q = db.queries.find(x => x.table === 'orders')!
    check('D. la consulta filtra por teléfono en la DB (match), tienda y estados activos',
      q.filters.some(f => f.op === 'match' && f.col === 'customer_phone')
        && q.filters.some(f => f.op === 'eq' && f.col === 'store_id' && f.val === S1)
        && q.filters.some(f => f.op === 'in' && f.col === 'confirmation_status')
        && q.filters.some(f => f.op === 'is' && f.col === 'tracking_number'))
  }
  {
    const db = new FakeDb()
    const cancelledOld = mk({ confirmation_status: 'cancelled', created_at: new Date(Date.now() - 40 * DAY).toISOString() })
    const pending = mk()
    db.tables.orders.push(cancelledOld, pending)
    const r = await findActiveSdOrdersByPhone(db, S1, WA)
    check('E. cancelled antiguo + pending actual → solo pending (no ambiguous)', r.length === 1 && r[0].id === pending.id, ids(r))
  }
  {
    const db = new FakeDb()
    const hist = mk({ confirmation_status: 'confirmed', normalized_status: 'delivered', payment_status: 'paid' })
    const paidNotDelivered = mk({ confirmation_status: 'confirmed', normalized_status: 'en_reparto', payment_status: 'paid' })
    const pending = mk()
    db.tables.orders.push(hist, paidNotDelivered, pending)
    const r = await findActiveSdOrdersByPhone(db, S1, WA)
    check('F. delivered/paid histórico + pending → solo pending (no ambiguous)', r.length === 1 && r[0].id === pending.id, ids(r))
  }
  {
    const db = new FakeDb()
    const a = mk({ created_at: new Date(Date.now() - 2 * DAY).toISOString() })
    const b = mk({ confirmation_status: 'confirmed', normalized_status: 'en_reparto', customer_phone: '+1 (809) 555-1234' })
    db.tables.orders.push(a, b)
    const r = await findActiveSdOrdersByPhone(db, S1, WA)
    check('G. dos activos reales mismo teléfono → ambos (el llamador marca ambiguous), más reciente primero',
      r.length === 2 && r[0].id === b.id && r[1].id === a.id, ids(r))
  }
  {
    const db = new FakeDb()
    db.tables.orders.push(mk({ customer_phone: '809-999-0000' }))
    check('H. teléfono sin pedido activo → []', (await findActiveSdOrdersByPhone(db, S1, WA)).length === 0)
    check('H. teléfono demasiado corto → []', (await findActiveSdOrdersByPhone(db, S1, '12345')).length === 0)
  }
  {
    const db = new FakeDb()
    const other = mk({ store_id: S2 })
    db.tables.orders.push(other)
    check('I. aislado por tienda (mismo teléfono en otra tienda → no)', (await findActiveSdOrdersByPhone(db, S1, WA)).length === 0)
    check('I. en su tienda sí', (await findActiveSdOrdersByPhone(db, S2, WA)).length === 1)
  }

  console.log('\n=== Estados y formatos ===\n')
  {
    const db = new FakeDb()
    const o = {
      unreachable: mk({ confirmation_status: 'unreachable' }),
      noCoverage:  mk({ confirmation_status: 'no_coverage' }),
      tracking:    mk({ tracking_number: 'EFI1' }),
      returned:    mk({ normalized_status: 'returned' }),
      testOrder:   mk({ is_test: true }),
      archived:    mk({ archived_at: new Date().toISOString() }),
      santiago:    mk({ city: 'Santiago', province: 'Santiago' }),
    }
    db.tables.orders.push(...Object.values(o))
    const r = ids(await findActiveSdOrdersByPhone(db, S1, WA))
    check('unreachable participa (cliente que reaparece)', r.includes(o.unreachable.id))
    check('no_coverage / tracking / returned / test / archivado / fuera de SD NO participan',
      ![o.noCoverage, o.tracking, o.returned, o.testOrder, o.archived, o.santiago].some(x => r.includes(x.id)), r)
  }
  for (const fmt of ['809-555-1234', '(809) 555-1234', '+1 809 555 1234', '8095551234', '18095551234', '809 555 1234 ']) {
    const db = new FakeDb()
    db.tables.orders.push(mk({ customer_phone: fmt }))
    check(`formato ${JSON.stringify(fmt)} → encontrado`, (await findActiveSdOrdersByPhone(db, S1, WA)).length === 1)
  }
  {
    const db = new FakeDb()
    db.tables.orders.push(mk({ customer_phone: '809-555-1239' }), mk({ customer_phone: '809-551-2340' }))
    check('no confunde números parecidos', (await findActiveSdOrdersByPhone(db, S1, WA)).length === 0)
    check('patrón: últimos 7 dígitos con cualquier separador', phoneSuffixPattern('18095551234') === '5\\D*5\\D*5\\D*1\\D*2\\D*3\\D*4\\D*$')
  }

  console.log('\n=== J. Flujo location existente ===\n')
  {
    const webhook = readFileSync(join(__dirname, '..', 'src/app/api/webhooks/whatsapp/route.ts'), 'utf8')
    const lib = readFileSync(join(__dirname, '..', 'src/lib/deliveries/active-sd-orders-by-phone.ts'), 'utf8')
    check('J. webhook usa el lookup canónico (import) y no conserva copia local',
      webhook.includes("import { findActiveSdOrdersByPhone } from '@/lib/deliveries/active-sd-orders-by-phone'")
        && !/async function findActiveSdOrdersByPhone/.test(webhook))
    check('J. bloque 4b intacto: candidates[0] + ambiguous si > 1 + confirma solo si received',
      webhook.includes('await findActiveSdOrdersByPhone(supabase, storeId, phoneNormalized)')
        && webhook.includes("const locationStatus = candidates.length > 1 ? 'ambiguous' : 'received'")
        && webhook.includes("if (locationStatus === 'received') {"))
    const libCode = lib.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    check('J. sin límite global de tienda (.limit(200))', !/limit\(200\)/.test(libCode))
  }

  console.log(`\n${failures === 0 ? '✅ TODOS LOS TESTS PASAN' : `❌ ${failures} FALLO(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
