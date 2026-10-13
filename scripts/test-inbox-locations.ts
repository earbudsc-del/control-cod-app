// Inbox WhatsApp — tarjeta de ubicación, enlace de Maps, vista previa y pedido vinculado.
// Uso: npx tsx scripts/test-inbox-locations.ts
//
// Offline: DB en memoria (C1FakeDb). Sin red, sin Supabase, sin Meta.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { C1FakeDb } from './lib/c1-fake-db'
import {
  attachLinkedOrders, displayPreview, formatCoordinates, googleMapsUrl, messagePreview, parseLocation,
} from '../src/lib/whatsapp/location-message'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`)
}

async function main() {
  console.log('\n=== L1 — datos de ubicación ===')
  // Caso real (Fernando tineo, #12446): solo coordenadas, sin nombre ni dirección.
  const fernando = parseLocation({ latitude: 18.5020447, longitude: -69.917864, name: null, address: null })
  check('L1.1 coordenadas reales sin nombre/dirección', !!fernando && fernando.latitude === 18.5020447 && fernando.name === null && fernando.address === null)
  check('L1.2 enlace directo a Google Maps con las coordenadas', !!fernando && googleMapsUrl(fernando) === 'https://www.google.com/maps?q=18.5020447,-69.917864')
  const named = parseLocation({ latitude: '18.47', longitude: '-69.89', name: '  Ágora Mall ', address: 'Av. Abraham Lincoln' })
  check('L1.3 nombre y dirección cuando existen (y coordenadas en texto)', named?.name === 'Ágora Mall' && named.address === 'Av. Abraham Lincoln' && named.latitude === 18.47)
  check('L1.4 sin coordenadas o fuera de rango → sin tarjeta', parseLocation({ name: 'x' }) === null
    && parseLocation({ latitude: 91, longitude: 0 }) === null && parseLocation({ latitude: 'abc', longitude: 1 }) === null
    && parseLocation(null) === null)
  check('L1.5 coordenadas legibles (6 decimales)', !!fernando && formatCoordinates(fernando) === '18.502045, -69.917864')

  console.log('\n=== L2 — vista previa en la lista ===')
  check('L2.1 "[location]" → "📍 Ubicación"', displayPreview('[location]') === '📍 Ubicación')
  check('L2.2 otros textos y tipos sin cambio', displayPreview('Sí, confirmar') === 'Sí, confirmar' && displayPreview('[image]') === '[image]' && displayPreview(null) === null)
  check('L2.3 tiempo real: ubicación sin texto → "[location]" (mismo criterio que el webhook)',
    messagePreview({ body: null, message_type: 'location' }) === '[location]' && displayPreview(messagePreview({ body: null, message_type: 'location' })) === '📍 Ubicación'
    && messagePreview({ body: ' hola ', message_type: 'text' }) === 'hola')

  console.log('\n=== L3 — pedido vinculado (sin consultas innecesarias) ===')
  {
    const db = new C1FakeDb()
    db.tables.orders = [
      { id: randomUUID(), store_id: 'store-1', order_number: '#12446', sd_location_wa_msg_id: 'wamid.LOC1' },
      { id: randomUUID(), store_id: 'store-2', order_number: '#99999', sd_location_wa_msg_id: 'wamid.LOC2' },
    ]
    const msgs = [
      { id: '1', message_type: 'text', wa_msg_id: 'wamid.T1', body: 'Sí, confirmar' },
      { id: '2', message_type: 'location', wa_msg_id: 'wamid.LOC1', body: null },
      { id: '3', message_type: 'location', wa_msg_id: 'wamid.LOC2', body: null },
      { id: '4', message_type: 'location', wa_msg_id: 'wamid.LOC3', body: null },
    ]
    db.log = []
    const out = await attachLinkedOrders(db as never, 'store-1', msgs)
    check('L3.1 vinculada al pedido correcto', out[1].linked_order_number === '#12446')
    check('L3.2 nunca muestra pedidos de otra tienda', out[2].linked_order_number === null)
    check('L3.3 pin sin pedido → sin marca', out[3].linked_order_number === null)
    check('L3.4 una sola consulta para toda la página', db.log.filter(l => l.table === 'orders').length === 1)
    db.log = []
    await attachLinkedOrders(db as never, 'store-1', [msgs[0]])
    check('L3.5 página sin ubicaciones → 0 consultas', db.log.length === 0)
    check('L3.6 mensajes que no son ubicación no se alteran', !('linked_order_number' in out[0]))
    const failing = { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: 'x' } }) }) }) }) }
    const safe = await attachLinkedOrders(failing as never, 'store-1', msgs)
    check('L3.7 si la consulta falla, los mensajes se devuelven igual', safe.length === 4 && safe[1].wa_msg_id === 'wamid.LOC1')
  }

  console.log('\n=== L4 — interfaz y alcance ===')
  {
    const pane = readFileSync('src/components/whatsapp/WaMessagePane.tsx', 'utf8')
    const list = readFileSync('src/components/whatsapp/WaConversationList.tsx', 'utf8')
    const route = readFileSync('src/app/api/whatsapp/conversations/[id]/messages/route.ts', 'utf8')
    check('L4.1 tarjeta para message_type=location', /message_type === 'location' && parseLocation\(msg\.metadata\)/.test(pane) && /<LocationCard msg=\{msg\} \/>/.test(pane))
    check('L4.2 botones "Abrir en Google Maps" y "Copiar enlace"', /Abrir en Google Maps/.test(pane) && /Copiar enlace/.test(pane) && /navigator\.clipboard\.writeText\(url\)/.test(pane))
    check('L4.3 marca "Vinculada al pedido"', /Vinculada al pedido \{msg\.linked_order_number\}/.test(pane))
    check('L4.4 lista usa la vista previa legible', /displayPreview\(conv\.last_message_preview\)/.test(list))
    check('L4.5 API de mensajes agrega el pedido vinculado con el store_id de la conversación',
      /attachLinkedOrders\(supabase, conv\.store_id/.test(route) && /select\('id, store_id'\)/.test(route))
    const webhook = readFileSync('src/app/api/webhooks/whatsapp/route.ts', 'utf8')
    const assign = readFileSync('src/lib/whatsapp/inbound-location.ts', 'utf8')
    check('L4.6 webhook y asignación de ubicaciones intactos', !/location-message/.test(webhook) && !/location-message/.test(assign))
  }

  console.log(failures === 0 ? '\n✅ TODO OK' : `\n❌ ${failures} FALLOS`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
