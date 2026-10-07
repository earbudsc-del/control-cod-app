// Sprint Broadcast A — tests determinísticos de elegibilidad, deduplicación
// por teléfono, aislamiento del backlog y flag WA_BROADCAST_ENABLED.
//
// Puro: no toca DB, no llama a Meta, no envía nada.
//
// Corre con: npx tsx scripts/test-sd-broadcast-eligibility.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SD_BROADCAST_TEMPLATE_NAME,
  broadcastQueueSelector,
  classifyBroadcastCandidates,
  evaluateOrderEligibility,
  isSelectableByBroadcastProcessor,
  type BroadcastCandidateOrder,
  type QueueRowLike,
} from '../src/lib/broadcast/sd-broadcast-eligibility'
import { isWaBroadcastEnabled } from '../src/lib/config/wa-broadcast'
import { isWaAutomationsEnabled } from '../src/lib/config/wa-automations'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

let seq = 0
function order(overrides: Partial<BroadcastCandidateOrder> = {}): BroadcastCandidateOrder {
  seq++
  return {
    id:                      `order-${seq}`,
    store_id:                'store-1',
    source:                  'shopify_webhook',
    shopify_order_id:        `shp-${seq}`,
    is_test:                 false,
    archived_at:             null,
    customer_phone:          `809-555-${String(1000 + seq).padStart(4, '0')}`,
    city:                    'Santo Domingo Este',
    province:                'Santo Domingo',
    customer_address:        'Calle 1 #5, Los Mina',
    confirmation_status:     'pending',
    normalized_status:       'pending',
    payment_status:          'pending',
    tracking_number:         null,
    sd_location_received_at: null,
    ...overrides,
  }
}

function reasonOf(o: BroadcastCandidateOrder, existing: { order_id: string; status: string } | null = null) {
  const r = evaluateOrderEligibility(o, existing)
  return r.eligible ? 'ELIGIBLE' : r.reason
}

console.log('=== Elegibilidad individual ===\n')

{
  const o = order({ customer_phone: '(809) 555-1234' })
  const r = evaluateOrderEligibility(o, null)
  check('A. SD pending normal → elegible', r.eligible === true, r)
  check('A. phone_normalized en formato de cola (1 + 10 dígitos)', r.eligible && r.phone_normalized === '18095551234', r)
}
check('B. confirmed → excluido', reasonOf(order({ confirmation_status: 'confirmed' })) === 'confirmed')
check('C. cancelled → excluido', reasonOf(order({ confirmation_status: 'cancelled' })) === 'cancelled')
check('D. delivered → excluido', reasonOf(order({ normalized_status: 'delivered' })) === 'delivered')
check('E. returned → excluido',  reasonOf(order({ normalized_status: 'returned' })) === 'returned')
check('F. paid → excluido',      reasonOf(order({ payment_status: 'paid' })) === 'paid')
check('G. tracking externo → excluido', reasonOf(order({ tracking_number: 'EFI123456' })) === 'external_tracking')
check('G. Novedad con tracking → excluido',
  reasonOf(order({ normalized_status: 'novedad', tracking_number: 'EFI999' })) === 'external_tracking')
check('H. teléfono vacío → excluido',       reasonOf(order({ customer_phone: null })) === 'invalid_phone')
check('H. teléfono corto → excluido',       reasonOf(order({ customer_phone: '55512' })) === 'invalid_phone')
check('H. teléfono NANP no-RD → excluido',  reasonOf(order({ customer_phone: '305-555-1234' })) === 'invalid_phone')
check('H. teléfono internacional → excluido', reasonOf(order({ customer_phone: '+34 612 345 678' })) === 'invalid_phone')
check('H. +1 849 válido → elegible',        reasonOf(order({ customer_phone: '+1 849 555 0001' })) === 'ELIGIBLE')

{
  const o = order()
  check('J. broadcast pending existente → excluido (activo)',
    reasonOf(o, { order_id: o.id, status: 'pending' }) === 'broadcast_already_active')
  check('J. broadcast processing existente → excluido (activo)',
    reasonOf(o, { order_id: o.id, status: 'processing' }) === 'broadcast_already_active')
  check('J. broadcast sent existente → excluido (enviado)',
    reasonOf(o, { order_id: o.id, status: 'sent' }) === 'broadcast_already_sent')
  check('J. broadcast failed previo → excluido (UNIQUE impide reinsertar)',
    reasonOf(o, { order_id: o.id, status: 'failed' }) === 'broadcast_previous_attempt')
}

check('L. Zona SD válida (Boca Chica, province vacía) → elegible',
  reasonOf(order({ city: 'Boca Chica', province: null, customer_address: 'Calle 2' })) === 'ELIGIBLE')
check('L. Zona SD válida (Pantoja, province texto libre) → elegible',
  reasonOf(order({ city: 'Pantoja', province: 'SDO zona oeste x', customer_address: 'Calle 3' })) === 'ELIGIBLE')
check('M. Santiago → excluido (no SD)',
  reasonOf(order({ city: 'Santiago', province: 'Santiago', customer_address: 'Calle del Sol' })) === 'not_santo_domingo')
check('M. San Cristóbal → excluido (no SD)',
  reasonOf(order({ city: 'San Cristóbal', province: 'San Cristóbal', customer_address: 'Calle 4' })) === 'not_santo_domingo')
check('M. Villa Hermosa, La Romana → excluido (guardia de provincia)',
  reasonOf(order({ city: 'Villa Hermosa', province: 'La Romana', customer_address: 'Calle 5' })) === 'not_santo_domingo')

console.log('\n=== Reglas adicionales ===\n')
check('unreachable → excluido del broadcast estándar', reasonOf(order({ confirmation_status: 'unreachable' })) === 'unreachable')
check('no_coverage → excluido', reasonOf(order({ confirmation_status: 'no_coverage' })) === 'confirmation_not_pending')
check('source ≠ shopify_webhook → excluido', reasonOf(order({ source: 'manual' })) === 'not_shopify_order')
check('sin shopify_order_id → excluido', reasonOf(order({ shopify_order_id: null })) === 'not_shopify_order')
check('is_test → excluido', reasonOf(order({ is_test: true })) === 'test_or_archived')
check('archivado → excluido', reasonOf(order({ archived_at: '2026-09-01T00:00:00Z' })) === 'test_or_archived')
{
  // Pedido viejo: NO se excluye por antigüedad (no hay regla de fecha).
  check('pedido viejo → sigue elegible (no se excluye por edad)', reasonOf(order()) === 'ELIGIBLE')
}
{
  // CASO MARCADO: ubicación recibida + pending. Permitido por ahora, pero
  // normalmente debió auto-confirmarse — se emite warning para revisión.
  const r = evaluateOrderEligibility(order({ sd_location_received_at: '2026-10-01T12:00:00Z' }), null)
  check('⚠ ubicación recibida + pending → elegible CON warning location_received_but_pending',
    r.eligible === true && r.warnings.includes('location_received_but_pending'), r)
}

console.log('\n=== I. Múltiples pedidos del mismo teléfono ===\n')
{
  const a = order({ customer_phone: '809-111-2222' })
  const b = order({ customer_phone: '+1 (809) 111-2222' }) // mismo número, otro formato
  const c = order({ customer_phone: '829-333-4444' })
  const res = classifyBroadcastCandidates([a, b, c], [])
  const exA = res.excluded.find(x => x.order_id === a.id)
  const exB = res.excluded.find(x => x.order_id === b.id)
  check('I. mismo teléfono + 2 elegibles → AMBOS excluidos (ninguno elegido arbitrariamente)',
    exA?.excluded_reason === 'multiple_active_orders_same_phone' && exB?.excluded_reason === 'multiple_active_orders_same_phone', res)
  check('I. ningún mensaje para ese teléfono', !res.eligible.some(e => e.phone_normalized === '18091112222'))
  check('I. el otro teléfono sigue elegible', res.eligible.length === 1 && res.eligible[0].order_id === c.id)
  check('I. conteo por razón', res.excluded_by_reason.multiple_active_orders_same_phone === 2, res.excluded_by_reason)

  // Mismo teléfono pero solo UNO elegible (el otro confirmado) → se envía el elegible.
  const d = order({ customer_phone: '809-777-8888' })
  const e = order({ customer_phone: '809-777-8888', confirmation_status: 'confirmed' })
  const res2 = classifyBroadcastCandidates([d, e], [])
  check('I. mismo teléfono, solo 1 elegible → ese 1 se envía, el otro excluido por su propia razón',
    res2.eligible.length === 1 && res2.eligible[0].order_id === d.id
      && res2.excluded[0]?.excluded_reason === 'confirmed', res2)

  // Mismo order_id repetido en la entrada → no se cuenta como "2 pedidos".
  const f = order({ customer_phone: '809-999-0000' })
  const res3 = classifyBroadcastCandidates([f, f], [])
  check('I. order_id duplicado en entrada → 1 elegible, no falso conflicto', res3.eligible.length === 1 && res3.excluded.length === 0, res3)
}

console.log('\n=== K. Aislamiento del backlog histórico ===\n')
{
  const BROADCAST_ID = '11111111-1111-1111-1111-111111111111'
  // Las 3 pending históricas pre-deploy: broadcast_id NULL, template histórico.
  const historicalPending: QueueRowLike[] = [
    { broadcast_id: null, template_name: 'order_confirmation_cod', status: 'pending' },
    { broadcast_id: null, template_name: 'order_confirmation_cod', status: 'pending' },
    { broadcast_id: null, template_name: 'order_confirmation_cod', status: 'pending' },
  ]
  const others: QueueRowLike[] = [
    { broadcast_id: null, template_name: 'order_confirmation_cod', status: 'skipped' },
    { broadcast_id: null, template_name: 'sd_location_request',    status: 'pending' },
    // Hipotético: template de broadcast pero sin broadcast_id (la migración lo prohíbe, igual se prueba).
    { broadcast_id: null, template_name: SD_BROADCAST_TEMPLATE_NAME, status: 'pending' },
    // Fila de OTRO broadcast.
    { broadcast_id: '22222222-2222-2222-2222-222222222222', template_name: SD_BROADCAST_TEMPLATE_NAME, status: 'pending' },
  ]
  const own: QueueRowLike = { broadcast_id: BROADCAST_ID, template_name: SD_BROADCAST_TEMPLATE_NAME, status: 'pending' }

  check('K. las 3 pending históricas NO son seleccionables',
    historicalPending.every(r => !isSelectableByBroadcastProcessor(r, BROADCAST_ID)))
  check('K. skipped / sd_location_request / broadcast_id NULL / otro broadcast → NO seleccionables',
    others.every(r => !isSelectableByBroadcastProcessor(r, BROADCAST_ID)))
  check('K. solo la fila del broadcast actual con template de broadcast es seleccionable',
    isSelectableByBroadcastProcessor(own, BROADCAST_ID))

  const sel = broadcastQueueSelector(BROADCAST_ID)
  check('K. selector exige broadcast_id + template_name + status',
    sel.broadcast_id === BROADCAST_ID && sel.template_name === 'sd_broadcast_confirmation' && sel.status === 'pending', sel)
  let threw = 0
  for (const bad of ['', '   ', null as unknown as string, undefined as unknown as string]) {
    try { broadcastQueueSelector(bad) } catch { threw++ }
  }
  check('K. selector sin broadcast_id → lanza (nunca degrada a status=pending a secas)', threw === 4)

  // Verificación estática de la migración: el CHECK y el trigger existen.
  const sql = readFileSync(join(__dirname, '..', 'supabase/migrations/064_wa_broadcasts.sql'), 'utf8')
  check('K. migración: broadcast_id nullable (sin NOT NULL)',
    /ADD COLUMN broadcast_id UUID REFERENCES wa_broadcasts\(id\) ON DELETE RESTRICT;/.test(sql))
  check('K. migración: CHECK broadcast_id NOT NULL ⇔ template de broadcast',
    sql.includes("CHECK ((broadcast_id IS NOT NULL) = (template_name = 'sd_broadcast_confirmation'))"))
  check('K. migración: trigger de inmutabilidad de broadcast_id',
    sql.includes('BEFORE UPDATE OF broadcast_id ON wa_template_queue'))
  const sqlNoComments = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  check('K. migración: no hace UPDATE/INSERT/DELETE sobre filas existentes',
    !/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+wa_template_queue\b/i.test(sqlNoComments))
}

console.log('\n=== WA_BROADCAST_ENABLED ===\n')
{
  const savedB = process.env.WA_BROADCAST_ENABLED
  const savedA = process.env.WA_AUTOMATIONS_ENABLED

  delete process.env.WA_BROADCAST_ENABLED
  check('flag ausente → false', isWaBroadcastEnabled() === false)
  for (const v of ['', 'false', 'TRUE', 'True', '1', 'yes', ' true']) {
    process.env.WA_BROADCAST_ENABLED = v
    check(`flag = ${JSON.stringify(v)} → false`, isWaBroadcastEnabled() === false)
  }
  process.env.WA_BROADCAST_ENABLED = 'true'
  check('flag = "true" → true', isWaBroadcastEnabled() === true)

  // Independencia en ambos sentidos.
  delete process.env.WA_AUTOMATIONS_ENABLED
  process.env.WA_BROADCAST_ENABLED = 'true'
  check('BROADCAST=true NO enciende AUTOMATIONS', isWaAutomationsEnabled() === false)
  process.env.WA_AUTOMATIONS_ENABLED = 'true'
  delete process.env.WA_BROADCAST_ENABLED
  check('AUTOMATIONS=true NO enciende BROADCAST', isWaBroadcastEnabled() === false)

  if (savedB === undefined) delete process.env.WA_BROADCAST_ENABLED; else process.env.WA_BROADCAST_ENABLED = savedB
  if (savedA === undefined) delete process.env.WA_AUTOMATIONS_ENABLED; else process.env.WA_AUTOMATIONS_ENABLED = savedA

  const flagSrc = readFileSync(join(__dirname, '..', 'src/lib/config/wa-broadcast.ts'), 'utf8')
  check('flag no referencia WA_AUTOMATIONS_ENABLED en código', !flagSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n').includes('WA_AUTOMATIONS_ENABLED'))
}

console.log(`\n${failures === 0 ? '✅ TODOS LOS TESTS PASAN' : `❌ ${failures} FALLO(S)`}`)
process.exit(failures === 0 ? 0 : 1)
