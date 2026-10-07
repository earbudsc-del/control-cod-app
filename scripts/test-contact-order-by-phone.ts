// Sprint B.2.3 — resolución contacto WhatsApp → pedido (wa_contacts.order_id).
//
// Determinístico, DB en memoria. NO toca la DB real, NO envía nada.
//
// Corre con: npx tsx scripts/test-contact-order-by-phone.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FakeDb, type Row } from './lib/broadcast-fake-db'
import {
  decideContactOrderLink, isActiveOrderForContact, isLinkedOrderStillActive, resolveContactOrderByPhone,
} from '../src/lib/whatsapp/contact-order'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

const S1 = 'store-1', S2 = 'store-2'
const WA = '18095551234'
const DAY = 86_400_000
let n = 0
function mk(o: Partial<Row> = {}): Row {
  n++
  return {
    id: randomUUID(), store_id: S1, customer_phone: '809-555-1234', confirmation_status: 'pending',
    normalized_status: 'pending', payment_status: 'pending', is_test: false, archived_at: null,
    tracking_number: null, city: 'Santo Domingo Este', province: 'Santo Domingo',
    created_at: new Date(Date.now() - (1000 - n) * 60_000).toISOString(), ...o,
  }
}
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()
const resolve = (db: FakeDb, store = S1, phone = WA) => resolveContactOrderByPhone(db, store, phone)

async function main() {
  console.log('=== Resolución dirigida ===\n')
  {
    const db = new FakeDb()
    const old = mk({ created_at: ago(150) })
    db.tables.orders.push(old)
    for (let i = 0; i < 300; i++) db.tables.orders.push(mk({ customer_phone: `829-${String(100 + i).padStart(3, '0')}-${String(2000 + i)}` }))
    const r = await resolve(db)
    check('A. pedido relevante más viejo que 300 pedidos globales → encontrado', r.status === 'single' && r.orderId === old.id, r)
    const q = db.queries.find(x => x.table === 'orders')!
    check('A. consulta dirigida: store + match de teléfono (sin "últimos N" de la tienda)',
      q.filters.some(f => f.op === 'match' && f.col === 'customer_phone') && q.filters.some(f => f.op === 'eq' && f.col === 'store_id'))
  }
  {
    const db = new FakeDb()
    const paidHist = mk({ confirmation_status: 'confirmed', normalized_status: 'delivered', payment_status: 'paid', created_at: ago(60) })
    const pending = mk()
    db.tables.orders.push(paidHist, pending)
    const r = await resolve(db)
    check('B. pending actual + pagado histórico → pending', r.status === 'single' && r.orderId === pending.id, r)
  }
  {
    const db = new FakeDb()
    const deliv = mk({ confirmation_status: 'confirmed', normalized_status: 'delivered', created_at: ago(90) })
    const conf = mk({ confirmation_status: 'confirmed', normalized_status: 'in_transit', tracking_number: 'EFI9' })
    db.tables.orders.push(deliv, conf)
    const r = await resolve(db)
    check('C. confirmed actual (EFI en tránsito) + entregado histórico → el confirmado', r.status === 'single' && r.orderId === conf.id, r)
  }
  {
    const db = new FakeDb()
    db.tables.orders.push(mk(), mk({ confirmation_status: 'confirmed', normalized_status: 'en_reparto' }))
    const r = await resolve(db)
    check('D. dos activos → ambiguous, sin selección', r.status === 'ambiguous' && r.orderId === null, r)
    const db2 = new FakeDb()
    db2.tables.orders.push(mk(), mk({ city: 'Santiago', province: 'Santiago', created_at: ago(5) }))
    const r2 = await resolve(db2)
    check('D. dos activos en provincias distintas → también ambiguous (el contacto no filtra geografía)', r2.status === 'ambiguous', r2)
  }
  {
    const db = new FakeDb()
    db.tables.orders.push(mk({ confirmation_status: 'confirmed', normalized_status: 'delivered', payment_status: 'paid' }))
    const r = await resolve(db)
    check('E. solo pagado histórico → none (no se asocia un histórico)', r.status === 'none' && r.orderId === null, r)
  }
  {
    const db = new FakeDb()
    db.tables.orders.push(mk({ confirmation_status: 'cancelled' }), mk({ normalized_status: 'returned' }))
    const r = await resolve(db)
    check('F. solo cancelado / devuelto → none', r.status === 'none', r)
    const db2 = new FakeDb()
    const pend = mk()
    db2.tables.orders.push(mk({ confirmation_status: 'cancelled', created_at: ago(20) }), pend)
    const r2 = await resolve(db2)
    check('F. cancelado antiguo + pending → pending (el cancelado no compite)', r2.status === 'single' && r2.orderId === pend.id, r2)
  }
  {
    const db = new FakeDb()
    db.tables.orders.push(mk({ store_id: S2 }))
    check('G. aislado por tienda', (await resolve(db, S1)).status === 'none' && (await resolve(db, S2)).status === 'single')
  }
  for (const [wa, stored] of [['18095551234', '809-555-1234'], ['18294440001', '(829) 444-0001'], ['18497770002', '+1 849 777 0002'],
                              ['18295551234', '8295551234'], ['18495551234', '18495551234']] as const) {
    const db = new FakeDb()
    db.tables.orders.push(mk({ customer_phone: stored }))
    check(`H. ${wa} ↔ ${JSON.stringify(stored)}`, (await resolve(db, S1, wa)).status === 'single')
  }
  {
    const db = new FakeDb()
    db.tables.orders.push(mk({ customer_phone: '829-555-1234' }))
    check('H. 809 vs 829 con mismos 7 dígitos finales → NO coinciden (el número completo más corto debe ser sufijo)',
      (await resolve(db, S1, '18095551234')).status === 'none')
    check('H. teléfono corto → none', (await resolve(db, S1, '55512')).status === 'none')
  }
  {
    check('test/archivado no es activo', !isActiveOrderForContact({ confirmation_status: 'pending', normalized_status: 'pending', payment_status: 'pending', is_test: true, archived_at: null })
      && !isActiveOrderForContact({ confirmation_status: 'pending', normalized_status: 'pending', payment_status: 'pending', is_test: false, archived_at: ago(1) }))
    check('no_coverage / unreachable siguen siendo pedido en curso del contacto',
      isActiveOrderForContact({ confirmation_status: 'no_coverage', normalized_status: 'pending', payment_status: 'pending', is_test: false, archived_at: null })
        && isActiveOrderForContact({ confirmation_status: 'unreachable', normalized_status: 'pending', payment_status: 'pending', is_test: false, archived_at: null }))
  }

  console.log('\n=== Re-vinculación de wa_contacts.order_id ===\n')
  {
    const single = { status: 'single', orderId: 'new' } as const
    const amb = { status: 'ambiguous', orderId: null, candidates: 2 } as const
    const none = { status: 'none', orderId: null } as const
    check('sin vínculo + 1 activo → vincula', decideContactOrderLink(null, false, single) === 'new')
    check('sin vínculo + ambiguous/none → no vincula', decideContactOrderLink(null, false, amb) === null && decideContactOrderLink(null, false, none) === null)
    check('vínculo activo → se respeta aunque aparezca otro', decideContactOrderLink('cur', true, single) === null)
    check('vínculo histórico (entregado) + 1 activo nuevo → re-vincula al activo', decideContactOrderLink('old', false, single) === 'new')
    check('vínculo histórico + ambiguous/none → se conserva (no se borra)', decideContactOrderLink('old', false, amb) === null && decideContactOrderLink('old', false, none) === null)

    const db = new FakeDb()
    const deliv = mk({ normalized_status: 'delivered', payment_status: 'paid' })
    const act = mk()
    db.tables.orders.push(deliv, act)
    check('isLinkedOrderStillActive: entregado → false, pending → true',
      (await isLinkedOrderStillActive(db, deliv.id)) === false && (await isLinkedOrderStillActive(db, act.id)) === true)
  }

  console.log('\n=== I. Webhook ===\n')
  {
    const webhook = readFileSync(join(__dirname, '..', 'src/app/api/webhooks/whatsapp/route.ts'), 'utf8')
    const code = webhook.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    check('I. webhook ya no tiene findOrderByPhone ni limit(200)', !/findOrderByPhone/.test(code) && !/limit\(200\)/.test(code))
    check('I. contacto nuevo usa resolveContactOrderByPhone', /order_id:\s+orderId/.test(code) && code.includes('(await resolveContactOrderByPhone(supabase, storeId, phoneNormalized)).orderId'))
    check('I. contacto existente re-vincula vía decideContactOrderLink', code.includes('decideContactOrderLink(contact.order_id, stillActive, resolution)'))
    check('I. bloque 4b (ubicación) sigue con findActiveSdOrdersByPhone',
      code.includes('await findActiveSdOrdersByPhone(supabase, storeId, phoneNormalized)'))
  }

  console.log(`\n${failures === 0 ? '✅ TODOS LOS TESTS PASAN' : `❌ ${failures} FALLO(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
