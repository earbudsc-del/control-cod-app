// Sprint Broadcast B.2 — segmentación comercial + copy + media.
//
// Determinístico, DB en memoria (scripts/lib/broadcast-fake-db.ts).
// NO toca la DB real, NO llama a Meta, NO envía nada.
//
// Corre con: npx tsx scripts/test-broadcast-segments.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { FakeDb, type Row } from './lib/broadcast-fake-db'
import {
  audienceFromDraft,
  computeBroadcastAudience,
  createBroadcastDraft,
  revalidateDraftAudience,
  type BroadcastAdminContext,
} from '../src/lib/broadcast/broadcast-service'
import { parseBroadcastSelection, REPURCHASE_AUDIENCE_BASE, type BroadcastSelection } from '../src/lib/broadcast/selection'
import {
  BROADCAST_TEMPLATES, MAX_RECOVERY_DISCOUNT_PCT, REPURCHASE_OFFER, campaignTemplateName, recoveryDiscountDecision,
  type BroadcastCampaign,
} from '../src/lib/broadcast/campaign'
import { planConfirmationResponse, planRepurchaseResponse, recoveryDiscountedAmount } from '../src/lib/broadcast/response-plan'
import { MEDIA_ASSETS, resolveCommercialOffer } from '../src/lib/broadcast/offer'
import { renderCoordinationMessage, renderRepurchaseMessage } from '../src/lib/broadcast/message-preview'

let failures = 0
function check(label: string, pass: boolean, detail?: unknown) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}${!pass && detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}

const S1 = 'store-1'
const ctx: BroadcastAdminContext = { userId: 'admin-1', storeId: S1 }
const DAY = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()
const NOW = new Date().toISOString()
const PERSONAL = 'LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita - x2, + 1 Cepillo Antibacterial GRATIS'
const FAMILIAR = 'LÜMA Teeth™ — Pasta Dental Restauradora - x4, + 2 Cepillos GRATIS - x2'

let n = 0
function mkOrder(o: Partial<Row> = {}): Row {
  n++
  return {
    id: randomUUID(), store_id: S1, order_number: `#${7000 + n}`, source: 'shopify_webhook', shopify_order_id: `shp-${n}`,
    is_test: false, archived_at: null, customer_name: `Cliente ${n}`, customer_phone: `809-600-${String(1000 + n)}`,
    city: 'Santo Domingo Este', province: 'Santo Domingo', customer_address: 'Calle 2', product_summary: PERSONAL, cod_amount: 2100,
    confirmation_status: 'pending', confirmation_attempts: 0, normalized_status: 'pending', payment_status: 'pending',
    tracking_number: null, sd_location_received_at: null, shopify_created_at: ago(200), paid_at: null,
    created_at: ago(200), ...o,
  }
}
const paidOrder = (paidDaysAgo: number, o: Partial<Row> = {}) =>
  mkOrder({ confirmation_status: 'confirmed', normalized_status: 'delivered', payment_status: 'paid', paid_at: ago(paidDaysAgo), ...o })

const sel = (campaign: BroadcastCampaign, ids?: string[]): BroadcastSelection => ids
  ? { mode: 'selected_ids', order_ids: ids, campaign }
  : campaign.type === 'repurchase'
    ? { ...REPURCHASE_AUDIENCE_BASE, campaign }
    : { mode: 'filtered', filters: { scope: 'santo_domingo', status: '', payment: 'todos', date_from: null, date_to: null, search: null }, campaign }

const PENDING   = { type: 'coordination', segment: 'pending' } as const
const CONFIRMED = { type: 'coordination', segment: 'confirmed_unpaid' } as const
const R = (window_days: 30 | 45 | 60) => ({ type: 'repurchase', window_days } as const)

type Preview = Awaited<ReturnType<typeof computeBroadcastAudience>>
const reasonOf = (p: Preview, id: string) =>
  p.excluded.find(x => x.order_id === id)?.excluded_reason ?? (p.eligible.some(e => e.order_id === id) ? 'ELIGIBLE' : 'ABSENT')

async function main() {
  // ── Coordinar pedido ──────────────────────────────────────────────────────
  console.log('=== A–C, I, J. Coordinar pedido ===\n')
  {
    const db = new FakeDb()
    const o = {
      pending:      mkOrder(),
      confirmed:    mkOrder({ confirmation_status: 'confirmed' }),
      inRoute:      mkOrder({ confirmation_status: 'confirmed', normalized_status: 'en_reparto' }),
      confPaid:     mkOrder({ confirmation_status: 'confirmed', normalized_status: 'delivered', payment_status: 'paid', paid_at: ago(3) }),
      delivNotPaid: mkOrder({ confirmation_status: 'confirmed', normalized_status: 'delivered' }),
      cancelled:    mkOrder({ confirmation_status: 'cancelled' }),
      xA:           mkOrder({ customer_phone: '829-111-0001' }),                                      // pending
      xB:           mkOrder({ customer_phone: '+1 829 111 0001', confirmation_status: 'confirmed' }), // confirmed mismo tel
    }
    db.tables.orders.push(...Object.values(o))
    const ids = Object.values(o).map(x => x.id)
    const pP = await computeBroadcastAudience(db, ctx, sel(PENDING, ids), NOW)
    const pC = await computeBroadcastAudience(db, ctx, sel(CONFIRMED, ids), NOW)

    check('A. pending válido → elegible en Pendientes', reasonOf(pP, o.pending.id) === 'ELIGIBLE')
    check('A. confirmed en segmento Pendientes → excluido "confirmed"', reasonOf(pP, o.confirmed.id) === 'confirmed')
    check('B. confirmed + no paid → elegible en Confirmados sin pagar', reasonOf(pC, o.confirmed.id) === 'ELIGIBLE')
    check('B. confirmed en_reparto → elegible con warning already_in_route',
      pC.eligible.find(e => e.order_id === o.inRoute.id)?.warnings.includes('already_in_route') === true)
    check('B. pending en segmento Confirmados → excluido "confirmation_pending"', reasonOf(pC, o.pending.id) === 'confirmation_pending')
    check('C. confirmed + Pagado → NO elegible para coordinación (paid)', reasonOf(pC, o.confPaid.id) === 'paid')
    check('I. delivered sin Pagado → NO elegible para coordinación (delivered)', reasonOf(pC, o.delivNotPaid.id) === 'delivered')
    check('F. cancelled → excluido en ambos segmentos', reasonOf(pP, o.cancelled.id) === 'cancelled' && reasonOf(pC, o.cancelled.id) === 'cancelled')
    check('J. mismo teléfono con pedido pendiente + confirmado → ambiguo en AMBOS segmentos',
      reasonOf(pP, o.xA.id) === 'multiple_active_orders_same_phone' && reasonOf(pC, o.xB.id) === 'multiple_active_orders_same_phone')
    // Aunque solo se seleccione uno, el otro (de otro segmento) está en el pool.
    const pOnly = await computeBroadcastAudience(db, ctx, sel(CONFIRMED, [o.xB.id]), NOW)
    check('J. ambigüedad entre segmentos aunque solo se seleccione uno', reasonOf(pOnly, o.xB.id) === 'multiple_active_orders_same_phone')
    check('A/B. copy de coordinación en ambos segmentos', pP.eligible[0]?.message_preview.includes('*¿Coordinamos tu entrega?*') === true
      && pC.eligible[0]?.message_preview.includes('*¿Coordinamos tu entrega?*') === true)
    check('9. botones coordinación: SOLO dos, sin ubicación',
      JSON.stringify(pC.buttons) === JSON.stringify(['Sí, confirmar', 'Ya no lo deseo']) && !/ubicaci/i.test(pC.buttons.join(' ')))
  }

  // ── Recompra ──────────────────────────────────────────────────────────────
  console.log('\n=== D–J. Recompra ===\n')
  {
    const db = new FakeDb()
    const o = {
      old61:        paidOrder(61, { customer_phone: '809-700-0001' }),
      recent20:     paidOrder(20, { customer_phone: '809-700-0002' }),
      cancelledOnly: mkOrder({ confirmation_status: 'cancelled', customer_phone: '809-700-0003' }),
      histPaid:     paidOrder(90, { customer_phone: '809-700-0004' }),
      laterCancel:  mkOrder({ confirmation_status: 'cancelled', customer_phone: '809-700-0004', created_at: ago(40) }),
      paidReturned: mkOrder({ confirmation_status: 'confirmed', normalized_status: 'returned', payment_status: 'paid', paid_at: ago(80), customer_phone: '809-700-0005' }),
      delivNoPay:   mkOrder({ confirmation_status: 'confirmed', normalized_status: 'delivered', customer_phone: '809-700-0006' }),
      twoA:         paidOrder(120, { customer_phone: '809-700-0007', product_summary: FAMILIAR, cod_amount: 3400 }),
      twoB:         paidOrder(70,  { customer_phone: '+1 (809) 700-0007' }),
      withActive:   paidOrder(90, { customer_phone: '809-700-0008' }),
      activeOrder:  mkOrder({ customer_phone: '809-700-0008' }),
      santiago:     paidOrder(90, { customer_phone: '809-700-0009', city: 'Santiago', province: 'Santiago' }),
      testPaid:     paidOrder(90, { customer_phone: '809-700-0010', is_test: true }),
    }
    db.tables.orders.push(...Object.values(o))
    const p30 = await computeBroadcastAudience(db, ctx, sel(R(30)), NOW)
    const p60 = await computeBroadcastAudience(db, ctx, sel(R(60)), NOW)

    check('D. pagado hace 61 días → elegible para 60+', reasonOf(p60, o.old61.id) === 'ELIGIBLE')
    check('E. pagado hace 20 días → recent_purchase en 30+', reasonOf(p30, o.recent20.id) === 'recent_purchase')
    check('F. cancelled sin compra previa → no es candidato', reasonOf(p30, o.cancelledOnly.id) === 'ABSENT')
    check('G. compra Pagada histórica + cancelled posterior → sigue elegible (cancelled no veta)',
      reasonOf(p30, o.histPaid.id) === 'ELIGIBLE')
    check('H. Pagado + devuelto NO es compra completada → no candidato', reasonOf(p30, o.paidReturned.id) === 'ABSENT')
    check('I. delivered sin Pagado → no es compra completada → no candidato', reasonOf(p30, o.delivNoPay.id) === 'ABSENT')
    const twoEntries = [...p60.eligible, ...p60.excluded].filter(x => x.order_id === o.twoA.id || x.order_id === o.twoB.id)
    check('J. cliente con 2 compras → UN solo contacto, anclado a la última compra',
      twoEntries.length === 1 && twoEntries[0].order_id === o.twoB.id, twoEntries)
    check('J. recompra con pedido activo en curso → active_order_in_progress', reasonOf(p30, o.withActive.id) === 'active_order_in_progress')
    check('recompra fuera de SD → not_santo_domingo', reasonOf(p30, o.santiago.id) === 'not_santo_domingo')
    check('recompra ignora compras de test', reasonOf(p30, o.testPaid.id) === 'ABSENT')
    const phones = p30.eligible.map(e => e.phone_normalized)
    check('J. nunca dos contactos al mismo teléfono', new Set(phones).size === phones.length)
    const msg = p60.eligible.find(e => e.order_id === o.old61.id)?.message_preview ?? ''
    check('7. copy de recompra: reconoce cliente, no habla de pedido pendiente ni de coordinar',
      msg.includes('Por ser cliente LÜMA') && !/pendiente|Coordinamos/i.test(msg) && msg.includes('¿Quieres aprovechar tu precio especial?'))
    check('7. botones recompra', JSON.stringify(p60.buttons) === JSON.stringify(['Sí, quiero aprovechar', 'Ahora no']))
    const famAnchor = p60.eligible.find(e => e.order_id === o.twoB.id)
    check('B.2.1 recompra NO reutiliza precio/composición histórica (ancla 3400/Familiar → RD$1,890, sin cepillo)',
      !!famAnchor && famAnchor.message_preview.includes('RD$1,890') && !famAnchor.message_preview.includes('3,400')
        && !/cepillo/i.test(famAnchor.message_preview))
    check('B.2.1 recompra: sin advertencia de precio histórico; media luma_repurchase; oferta estándar',
      p60.eligible.every(e => e.warnings.length === 0 && e.media.asset_key === 'luma_repurchase' && e.media.status === 'approved'
        && e.offer_kind === 'repurchase_standard'))
    check('7. recompra: can_create_draft=false (requiere 066)', p60.can_create_draft === false && p60.template_name === 'sd_broadcast_repurchase')
  }

  // ── R. Audiencia congelada ────────────────────────────────────────────────
  console.log('\n=== R. Revalidación nunca amplía ===\n')
  {
    const db = new FakeDb()
    const T0 = NOW
    const o = {
      eligible: paidOrder(45, { customer_phone: '809-710-0001' }),
      almost:   paidOrder(29, { customer_phone: '809-710-0002' }),  // cruzará 30 días "mañana"
      buysAgain: paidOrder(50, { customer_phone: '809-710-0003' }),
    }
    db.tables.orders.push(...Object.values(o))
    const v0 = await computeBroadcastAudience(db, ctx, sel(R(30)), T0)
    const v0Ids = new Set([...v0.eligible, ...v0.excluded].map(x => x.order_id))
    check('R. T0: elegible el de 45 días, reciente el de 29', reasonOf(v0, o.eligible.id) === 'ELIGIBLE' && reasonOf(v0, o.almost.id) === 'recent_purchase')

    // Después de T0: nuevo cliente pagado, y otro cliente vuelve a comprar.
    const newcomer = paidOrder(0, { customer_phone: '809-710-0009', created_at: new Date(Date.parse(T0) + 3_600_000).toISOString(),
      paid_at: new Date(Date.parse(T0) + 7_200_000).toISOString() })
    const rebuy = paidOrder(0, { customer_phone: '809-710-0003', created_at: new Date(Date.parse(T0) + 3_600_000).toISOString(),
      paid_at: new Date(Date.parse(T0) + 7_200_000).toISOString() })
    db.tables.orders.push(newcomer, rebuy)

    // Revalidar con la frontera de T0 (como haría Sprint C con el draft).
    const v1 = await computeBroadcastAudience(db, ctx, sel(R(30)), T0)
    const v1Ids = [...v1.eligible, ...v1.excluded].map(x => x.order_id)
    check('R. cliente nuevo posterior a T0 NO aparece', !v1Ids.includes(newcomer.id))
    check('R. ventana anclada a T0: el de 29 días sigue sin ser elegible', reasonOf(v1, o.almost.id) === 'recent_purchase')
    check('R. quien volvió a comprar después de T0 sale (reduce)', !v1.eligible.some(e => e.phone_normalized === '18097100003'))
    check('R. elegibles revalidados <= T0', v1.eligible_count <= v0.eligible_count)
    check('R. candidatos revalidados ⊆ clientes de T0 (por teléfono)',
      v1.eligible.every(e => v0.eligible.some(x => x.phone_normalized === e.phone_normalized)) && v0Ids.size > 0)

    // Coordinación confirmed_unpaid con draft real.
    const db2 = new FakeDb()
    const c1 = mkOrder({ confirmation_status: 'confirmed', customer_phone: '809-720-0001' })
    const c2 = mkOrder({ confirmation_status: 'confirmed', customer_phone: '809-720-0002' })
    db2.tables.orders.push(c1, c2)
    const d = await createBroadcastDraft(db2, ctx, sel(CONFIRMED), randomUUID())
    if (!d.ok) throw new Error('draft')
    db2.tables.orders.push(mkOrder({ confirmation_status: 'confirmed', customer_phone: '809-720-0003', created_at: new Date(Date.now() + 60_000).toISOString() }))
    db2.tables.orders.find(x => x.id === c1.id)!.payment_status = 'paid'
    const rv = await revalidateDraftAudience(db2, ctx, d.broadcast)
    check('R. confirmed_unpaid: revalidar quita el que pagó y no agrega el posterior',
      rv.eligible_count === 1 && rv.eligible[0].order_id === c2.id && rv.candidate_count === 2, rv)
  }

  // ── K–O. Copy y media ─────────────────────────────────────────────────────
  console.log('\n=== K–O. Oferta, copy y media ===\n')
  {
    const personal = renderCoordinationMessage({ customer_name: 'María', product_summary: PERSONAL, cod_amount: 2100 })
    check('K. Personal: copy exacto aprobado', personal === [
      'Hola, María 😊', '',
      '*Tu tratamiento 2×1 LÜMA Teeth está listo 🦷✨*', '',
      '🎁 Incluye tu *cepillo antibacterial GRATIS*', '',
      '💵 Total: *RD$2,100*',
      '🚚 Envío gratis — pagas al recibir', '',
      '*¿Coordinamos tu entrega?*',
    ].join('\n'), personal)
    const BUNDLE_NO_WORD = 'LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita - x2, Cepillo Antibacterial'
    const bundle = renderCoordinationMessage({ customer_name: 'A', product_summary: BUNDLE_NO_WORD, cod_amount: 2100 })
    check('B.2.2-A. 2×1 + "Cepillo Antibacterial" sin "GRATIS" (monto del bundle) → cepillo GRATIS',
      bundle.includes('🎁 Incluye tu *cepillo antibacterial GRATIS*') && bundle.includes('Envío gratis'), bundle)
    check('B.2.2-A. fuente del GRATIS = bundle Personal confirmado',
      resolveCommercialOffer(BUNDLE_NO_WORD, 2100).brushFreeSource === 'personal_bundle' && resolveCommercialOffer(BUNDLE_NO_WORD, 2100).personalBundleConfirmed)
    const offPrice = renderCoordinationMessage({ customer_name: 'A', product_summary: BUNDLE_NO_WORD, cod_amount: 1999 })
    check('B.2.2-A. composición 2×1 con monto fuera del bundle → conservador, no afirma GRATIS',
      !offPrice.includes('GRATIS') && offPrice.includes('cepillo antibacterial*'))
    check('B.2.2-A. sin monto → conservador', !renderCoordinationMessage({ customer_name: 'A', product_summary: BUNDLE_NO_WORD, cod_amount: null }).includes('GRATIS'))
    check('B.2.2-A. no clasifica por monto solo (2100 sin composición LÜMA x2)',
      resolveCommercialOffer('', 2100).kind === 'unknown' && !resolveCommercialOffer('', 2100).brushFree
        && !resolveCommercialOffer('LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita - x2', 2100).brushFree)
    check('B.2.2-A. bundle con un ítem extra no se confirma',
      !resolveCommercialOffer(BUNDLE_NO_WORD + ', SteriClean™ X', 2100).personalBundleConfirmed)
    const prioBundle = renderCoordinationMessage({ customer_name: 'A', product_summary: BUNDLE_NO_WORD + ', Envio prioritario', cod_amount: 2200 })
    check('B.2.2-B. bundle + envío prioritario (2,200) → cepillo GRATIS pero NUNCA "Envío gratis"',
      prioBundle.includes('cepillo antibacterial GRATIS') && !/env[ií]o gratis/i.test(prioBundle) && prioBundle.includes('Envío prioritario'))
    const hiddenCharge = renderCoordinationMessage({ customer_name: 'A', product_summary: PERSONAL, cod_amount: 2200 })
    check('B.2.2-B. monto sobre el bundle sin texto de prioritario → cargo de envío, NO "Envío gratis"',
      !/env[ií]o gratis/i.test(hiddenCharge) && resolveCommercialOffer(PERSONAL, 2200).shippingChargeEvidence === 'amount_above_bundle', hiddenCharge)
    const unk = renderCoordinationMessage({ customer_name: 'A', product_summary: 'LÜMA Brush™ CEPILLO Antibacterial', cod_amount: 499 })
    check('B.2.2-C. oferta desconocida → no inventa GRATIS ni envío gratis', !/gratis/i.test(unk))
    const prio = renderCoordinationMessage({ customer_name: 'A', product_summary: PERSONAL + ', Envio prioritario', cod_amount: 2200 })
    check('K. envío prioritario → no se dice "Envío gratis"', prio.includes('Envío prioritario') && !prio.includes('Envío gratis') && prio.includes('RD$2,200'))
    check('K. precio dinámico (cod_amount)', renderCoordinationMessage({ customer_name: 'A', product_summary: PERSONAL, cod_amount: 1999 }).includes('RD$1,999'))

    const familiar = renderCoordinationMessage({ customer_name: 'Luis', product_summary: FAMILIAR, cod_amount: 3400 })
    check('L. Familiar: titular Familiar + contenido 4 + 2 GRATIS + RD$3,400, sin 2×1',
      familiar.includes('*Tu Tratamiento Familiar LÜMA Teeth está listo 🦷✨*') && familiar.includes('*4 LÜMA Teeth + 2 cepillos antibacteriales GRATIS*')
        && familiar.includes('RD$3,400') && !familiar.includes('2×1'), familiar)

    const unknownEmpty = renderCoordinationMessage({ customer_name: 'X', product_summary: '', cod_amount: 2100 })
    check('M. desconocida (vacía): no inventa 2×1/GRATIS/cepillo ni envío gratis',
      !/2×1|cepillo/i.test(unknownEmpty) && !/gratis/i.test(unknownEmpty) && unknownEmpty.includes('*Tu pedido está listo 📦*')
        && unknownEmpty.includes('🚚 Pagas al recibir'), unknownEmpty)
    const steri = renderCoordinationMessage({ customer_name: 'X', product_summary: 'SteriClean™ Mantiene tu cepillo libre de bacterias', cod_amount: 2049.99 })
    check('M. desconocida (SteriClean): usa el product_summary real, sin beneficios inventados',
      steri.includes('🛍️ SteriClean™') && !/2×1|gratis/i.test(steri) && resolveCommercialOffer('SteriClean™ Mantiene tu cepillo libre de bacterias').kind === 'unknown')
    check('M. solo cepillo → desconocida', resolveCommercialOffer('LÜMA Brush™ CEPILLO Antibacterial').kind === 'unknown')
    check('M. LÜMA sin "- xN" → desconocida (no adivina cantidad)', resolveCommercialOffer('LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita, Envio prioritario').kind === 'unknown')
    const trio = renderCoordinationMessage({ customer_name: 'X', product_summary: 'LÜMA Teeth™ Pasta Dental de Nano-Hidroxiapatita - x3, + 2 Cepillos GRATIS', cod_amount: 2700 })
    check('M. trío (3 pastas) reconocido sin decir 2×1', trio.includes('*3 LÜMA Teeth + 2 cepillos antibacteriales GRATIS*') && !trio.includes('2×1') && trio.includes('RD$2,700'))
    const repA = renderRepurchaseMessage({ customer_name: 'X' })
    check('B.2.1 recompra: copy exacto con oferta estándar', repA === [
      '🎁 Tenemos una oferta especial para ti!', '',
      'Hola, X 😊', '',
      'Por ser cliente LÜMA, tienes un beneficio especial para renovar tu tratamiento 🦷✨', '',
      '2 LÜMA Teeth — 10% de descuento',
      'Antes: RD$2,100',
      '💙 Ahora: RD$1,890', '',
      '🚚 Envío gratis',
      '💵 Pagas al recibir', '',
      '¿Quieres aprovechar tu precio especial?',
    ].join('\n'), repA)

    check('N. Personal → asset luma_2x1_personal (aprobado)',
      resolveCommercialOffer(PERSONAL).media.asset_key === 'luma_2x1_personal' && MEDIA_ASSETS.luma_2x1_personal.status === 'approved')
    check('O. Familiar → luma_familiar, NUNCA el 2×1 Personal', resolveCommercialOffer(FAMILIAR).media.asset_key === 'luma_familiar')
    check('O. trío y desconocida → genérica', resolveCommercialOffer('LÜMA Teeth™ X - x3, + 2 Cepillos GRATIS').media.asset_key === 'luma_generic'
      && resolveCommercialOffer('').media.asset_key === 'luma_generic')
    check('O. assets inexistentes marcados pending_asset', MEDIA_ASSETS.luma_familiar.status === 'pending_asset' && MEDIA_ASSETS.luma_generic.status === 'pending_asset')

    const db = new FakeDb()
    const f = mkOrder({ product_summary: FAMILIAR, cod_amount: 3400, customer_phone: '809-730-0001' })
    db.tables.orders.push(f)
    const p = await computeBroadcastAudience(db, ctx, sel(PENDING, [f.id]), NOW)
    check('O. preview Familiar: media familiar pendiente + warning, no 2×1',
      p.eligible[0]?.media.asset_key === 'luma_familiar' && p.eligible[0].warnings.includes('media_asset_pending') && !p.eligible[0].message_preview.includes('2×1'))
  }

  // ── P / Q. Preview = create; +0 cola ──────────────────────────────────────
  console.log('\n=== P/Q. Preview y create usan la misma regla ===\n')
  {
    const db = new FakeDb()
    db.tables.orders.push(
      mkOrder({ confirmation_status: 'confirmed', customer_phone: '809-740-0001' }),
      mkOrder({ confirmation_status: 'confirmed', normalized_status: 'en_reparto', customer_phone: '809-740-0002' }),
      mkOrder({ confirmation_status: 'confirmed', payment_status: 'paid', paid_at: ago(1), normalized_status: 'delivered', customer_phone: '809-740-0003' }),
      mkOrder({ customer_phone: '809-740-0004' }),
    )
    db.tables.wa_template_queue.push({ id: randomUUID(), store_id: S1, order_id: randomUUID(), template_name: 'order_confirmation_cod', status: 'pending', broadcast_id: null })
    const s = sel(CONFIRMED)
    const preview = await computeBroadcastAudience(db, ctx, s, NOW)
    const queueBefore = db.tables.wa_template_queue.length
    const bcBefore = db.tables.wa_broadcasts.length
    const d = await createBroadcastDraft(db, ctx, s, randomUUID())
    check('P. create = preview (mismos conteos y razones)', d.ok && d.broadcast.candidate_count === preview.candidate_count
      && d.broadcast.eligible_count === preview.eligible_count
      && JSON.stringify(d.broadcast.excluded_by_reason) === JSON.stringify(preview.excluded_by_reason), { d, preview: preview.excluded_by_reason })
    if (d.ok) {
      const sf = d.broadcast.selection_filter as Row
      check('P. draft guarda campaign en selection_filter + rule v2 + template coordinación',
        sf.campaign?.type === 'coordination' && sf.campaign?.segment === 'confirmed_unpaid'
          && d.broadcast.eligibility_rule_version === 'sd_coordination_v2' && d.broadcast.template_name === 'sd_broadcast_confirmation')
      const back = audienceFromDraft(sf)
      check('P. audienceFromDraft reconstruye la misma campaña', back.selection.campaign.type === 'coordination'
        && (back.selection.campaign as { segment: string }).segment === 'confirmed_unpaid')
    }
    check('Q. +1 wa_broadcasts', db.tables.wa_broadcasts.length === bcBefore + 1)
    check('Q. +0 wa_template_queue', db.tables.wa_template_queue.length === queueBefore)

    const rep = await createBroadcastDraft(db, ctx, sel(R(30)), randomUUID())
    check('Q. recompra: create → 422 sin insertar (requiere 066)', !rep.ok && rep.status === 422 && db.tables.wa_broadcasts.length === bcBefore + 1)
    check('Q. ninguna escritura distinta de 1 insert en wa_broadcasts',
      db.writes.length === 1 && db.writes[0].table === 'wa_broadcasts', db.writes)

    // Draft B/B.1 sin campaign → se interpreta como coordinación/pendientes.
    const legacy = audienceFromDraft({ mode: 'selected_ids', order_ids: [randomUUID()], resolved_at: NOW })
    check('P. compat: draft sin campaign → coordinación/pendientes',
      legacy.selection.campaign.type === 'coordination' && (legacy.selection.campaign as { segment: string }).segment === 'pending')
  }

  // ── Validación del DTO ────────────────────────────────────────────────────
  console.log('\n=== DTO de campaña ===\n')
  {
    const neutral = REPURCHASE_AUDIENCE_BASE
    check('recompra con ids → rechazada', !parseBroadcastSelection({ mode: 'selected_ids', order_ids: [randomUUID()], campaign: R(30) }).ok)
    check('recompra con filtros de la pestaña → rechazada',
      !parseBroadcastSelection({ mode: 'filtered', filters: { scope: 'santo_domingo', status: 'pending' }, campaign: R(30) }).ok)
    check('recompra neutra → ok', parseBroadcastSelection({ ...neutral, campaign: R(45) }).ok)
    check('ventana 40 → rechazada', !parseBroadcastSelection({ ...neutral, campaign: { type: 'repurchase', window_days: 40 } }).ok)
    check('segmento desconocido → rechazado', !parseBroadcastSelection({ ...neutral, campaign: { type: 'coordination', segment: 'paid' } }).ok)
    check('clave extra en campaign → rechazada', !parseBroadcastSelection({ ...neutral, campaign: { type: 'coordination', segment: 'pending', sql: 1 } }).ok)
    check('clave extra en selection → rechazada', !parseBroadcastSelection({ ...neutral, campaign: PENDING, include_confirmed: true }).ok)
  }

  // ── B.2.1: dos templates, oferta estándar, semántica de botones ──────────
  console.log('\n=== B.2.1 Templates / respuestas / recovery ===\n')
  {
    check('dos templates: confirmation (pending y confirmed_unpaid) + repurchase',
      campaignTemplateName(PENDING) === 'sd_broadcast_confirmation' && campaignTemplateName(CONFIRMED) === 'sd_broadcast_confirmation'
        && campaignTemplateName(R(30)) === 'sd_broadcast_repurchase'
        && JSON.stringify(BROADCAST_TEMPLATES) === JSON.stringify(['sd_broadcast_confirmation', 'sd_broadcast_repurchase']))
    const all = execSync('grep -rl "sd_broadcast_coordination" src/lib/broadcast src/components/broadcast src/app/api/admin/broadcasts || true',
      { cwd: join(__dirname, '..') }).toString().trim().split('\n').filter(Boolean)
      .filter(f => readFileSync(join(__dirname, '..', f), 'utf8').split('\n')
        .some(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && l.includes('sd_broadcast_coordination')))
    check('no existe sd_broadcast_coordination en el código (solo en comentarios que lo descartan)', all.length === 0, all)
    check('oferta recompra: 2 pastas, sin cepillo, 10%, 2100 → 1890',
      REPURCHASE_OFFER.pasteQty === 2 && !REPURCHASE_OFFER.includesBrush && REPURCHASE_OFFER.discountPct === 10 && REPURCHASE_OFFER.price === 1890)
    const msgs = ['', PERSONAL, FAMILIAR, 'SteriClean™ X', PERSONAL + ', Envio prioritario'].map(ps =>
      renderRepurchaseMessage({ customer_name: 'Z', ...({ product_summary: ps } as object) }))
    check('recompra idéntica sin importar la compra histórica', new Set(msgs).size === 1)
    check('media: confirmation → luma_2x1_personal; repurchase → luma_repurchase (aprobada, sin cepillo)',
      resolveCommercialOffer(PERSONAL).media.asset_key === 'luma_2x1_personal' && MEDIA_ASSETS.luma_repurchase.status === 'approved'
        && /sin cepillo/.test(MEDIA_ASSETS.luma_repurchase.description))

    const st = (o: Partial<Row> = {}) => ({ confirmation_status: 'pending', payment_status: 'pending', normalized_status: 'pending',
      tracking_number: null, sd_location_status: null, sd_location_lat: null, sd_location_lng: null, ...o })
    const loc = { sd_location_status: 'received', sd_location_lat: 18.48, sd_location_lng: -69.9 }
    const p1 = planConfirmationResponse('Sí, confirmar', st())
    check('"Sí, confirmar" + pending → applyConfirmationAction(confirmed) + pide ubicación si falta',
      p1.canonicalAction === 'apply_confirmation_confirmed' && p1.location === 'request_location' && !p1.genesisHandoff)
    check('"Sí, confirmar" + pending con ubicación válida → NO la pide',
      planConfirmationResponse('Sí, confirmar', st(loc)).location === 'skip_already_known')
    const p2 = planConfirmationResponse('Sí, confirmar', st({ confirmation_status: 'confirmed', normalized_status: 'en_reparto' }))
    check('"Sí, confirmar" + confirmed sin pagar → NO reconfirma (solo intención positiva)',
      p2.canonicalAction === 'record_positive_intent_only' && p2.location === 'request_location')
    check('"Sí, confirmar" + confirmed con ubicación → NO la pide',
      planConfirmationResponse('Sí, confirmar', st({ confirmation_status: 'confirmed', ...loc })).location === 'skip_already_known')
    check('ubicación "ambiguous" no cuenta como válida → se pide',
      planConfirmationResponse('Sí, confirmar', st({ ...loc, sd_location_status: 'ambiguous' })).location === 'request_location')
    const p3 = planConfirmationResponse('Ya no lo deseo', st({ confirmation_status: 'confirmed' }))
    check('"Ya no lo deseo" → recovery con Génesis, NO cancelación inmediata, sin descuento',
      p3.canonicalAction === 'start_genesis_recovery' && p3.genesisHandoff && p3.cancelsImmediately === false && p3.offersDiscount === false)
    check('pedido Pagado/entregado → ninguna acción sobre el pedido',
      planConfirmationResponse('Sí, confirmar', st({ payment_status: 'paid' })).canonicalAction === 'none'
        && planConfirmationResponse('Ya no lo deseo', st({ normalized_status: 'delivered' })).canonicalAction === 'none')
    const r1 = planRepurchaseResponse('Sí, quiero aprovechar', false)
    check('"Sí, quiero aprovechar" → pedido NUEVO de recompra, sin tocar el histórico, sin re-preguntar',
      r1.canonicalAction === 'create_new_repurchase_order' && r1.touchesHistoricalOrder === false && /No volver a preguntar/.test(r1.notes))
    check('"Sí, quiero aprovechar" con ubicación conocida → no la pide', planRepurchaseResponse('Sí, quiero aprovechar', true).location === 'skip_already_known')
    const r2 = planRepurchaseResponse('Ahora no', true)
    check('"Ahora no" → solo auditoría de campaña, sin recovery, sin tocar histórico',
      r2.canonicalAction === 'record_campaign_declined' && !r2.genesisHandoff && r2.touchesHistoricalOrder === false)

    // Ningún plan pide ubicación cuando ya hay una válida.
    const states = [st(loc), st({ confirmation_status: 'confirmed', ...loc }), st({ confirmation_status: 'confirmed', normalized_status: 'en_reparto', ...loc })]
    const plans = states.flatMap(x => [planConfirmationResponse('Sí, confirmar', x), planConfirmationResponse('Ya no lo deseo', x)])
      .concat([planRepurchaseResponse('Sí, quiero aprovechar', true), planRepurchaseResponse('Ahora no', true)])
    check('ningún flujo pide ubicación si ya existe una válida', plans.every(pl => pl.location !== 'request_location'))
    check('ningún botón cancela ni ofrece descuento por sí solo', plans.every(pl => pl.cancelsImmediately === false && pl.offersDiscount === false))

    const dec = (o: Partial<Parameters<typeof recoveryDiscountDecision>[0]>) => recoveryDiscountDecision({
      campaign: PENDING, stage: 'objection_unresolved_price', discountAlreadyOffered: false, orderAlreadyDiscounted: false, requestedPct: 10, ...o })
    check('recovery: NO descuento al pulsar "Ya no lo deseo"', !dec({ stage: 'button_declined' }).allowed)
    check('recovery: NO descuento antes de trabajar la objeción', !dec({ stage: 'objection_identified' }).allowed)
    check('recovery: descuento solo con objeción de precio no resuelta', dec({}).allowed && dec({}).pct === 10)
    check('recovery: máximo 10% (pide 15 → 10)', dec({ requestedPct: 15 }).pct === MAX_RECOVERY_DISCOUNT_PCT && MAX_RECOVERY_DISCOUNT_PCT === 10)
    check('recovery: no se repite', !dec({ discountAlreadyOffered: true }).allowed)
    check('recovery: no se acumula con recompra', !dec({ campaign: R(30) }).allowed && !dec({ orderAlreadyDiscounted: true }).allowed)
    check('recovery: monto con tope 10% (2100 → 1890 aun pidiendo 25%)', recoveryDiscountedAmount(2100, 25) === 1890 && recoveryDiscountedAmount(2100, 5) === 1995)

    // Sub-filtro de ruta (confirmed_unpaid).
    const db = new FakeDb()
    const inR = mkOrder({ confirmation_status: 'confirmed', normalized_status: 'en_reparto', customer_phone: '809-750-0001' })
    const noR = mkOrder({ confirmation_status: 'confirmed', normalized_status: 'pending', customer_phone: '809-750-0002' })
    db.tables.orders.push(inR, noR)
    const ids = [inR.id, noR.id]
    const pAll = await computeBroadcastAudience(db, ctx, sel({ type: 'coordination', segment: 'confirmed_unpaid', route: 'all' }, ids), NOW)
    const pIn  = await computeBroadcastAudience(db, ctx, sel({ type: 'coordination', segment: 'confirmed_unpaid', route: 'in_route' }, ids), NOW)
    const pOut = await computeBroadcastAudience(db, ctx, sel({ type: 'coordination', segment: 'confirmed_unpaid', route: 'not_in_route' }, ids), NOW)
    check('ruta: Todos → ambos', pAll.eligible_count === 2)
    check('ruta: Ya en ruta → solo en_reparto', pIn.eligible_count === 1 && pIn.eligible[0].order_id === inR.id && reasonOf(pIn, noR.id) === 'route_filter_mismatch')
    check('ruta: Sin ruta → solo no despachados', pOut.eligible_count === 1 && pOut.eligible[0].order_id === noR.id && reasonOf(pOut, inR.id) === 'route_filter_mismatch')
    check('ruta: inválida o en pendientes → rechazada',
      !parseBroadcastSelection({ ...REPURCHASE_AUDIENCE_BASE, campaign: { type: 'coordination', segment: 'confirmed_unpaid', route: 'x' } }).ok
        && !parseBroadcastSelection({ ...REPURCHASE_AUDIENCE_BASE, campaign: { type: 'coordination', segment: 'pending', route: 'all' } }).ok)

    // Ajuste al texto fijo del template aprobado.
    const db2 = new FakeDb()
    const okP = mkOrder({ customer_phone: '809-760-0001' })
    const fam = mkOrder({ customer_phone: '809-760-0002', product_summary: FAMILIAR, cod_amount: 3400 })
    const pri = mkOrder({ customer_phone: '809-760-0003', product_summary: PERSONAL + ', Envio prioritario', cod_amount: 2200 })
    db2.tables.orders.push(okP, fam, pri)
    const pf = await computeBroadcastAudience(db2, ctx, sel(PENDING, [okP.id, fam.id, pri.id]), NOW)
    const w = (id: string) => pf.eligible.find(e => e.order_id === id)?.warnings ?? []
    check('template fijo: Personal 2×1 GRATIS sin prioritario calza (sin warning)', !w(okP.id).includes('requires_template_variables'))
    check('template fijo: Familiar y prioritario marcados "requiere variables"',
      w(fam.id).includes('requires_template_variables') && w(pri.id).includes('requires_template_variables'))
  }

  // ── S / T. Sin Meta, sin flags ────────────────────────────────────────────
  console.log('\n=== S/T. Sin envío ni flags ===\n')
  {
    const files = ['src/lib/broadcast/offer.ts', 'src/lib/broadcast/campaign.ts', 'src/lib/broadcast/message-preview.ts', 'src/lib/broadcast/response-plan.ts',
      'src/lib/broadcast/broadcast-service.ts', 'src/lib/broadcast/selection.ts', 'src/lib/broadcast/labels.ts',
      'src/lib/broadcast/sd-broadcast-eligibility.ts', 'src/components/broadcast/BroadcastPrepareModal.tsx',
      'src/components/broadcast/BroadcastHistoryModal.tsx']
    const strip = (t: string) => t.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    const code = files.map(f => strip(readFileSync(join(__dirname, '..', f), 'utf8'))).join('\n')
    check('S. sin Meta / graph.facebook / tokens WA', !/graph\.facebook|WA_ACCESS_TOKEN|WA_PHONE_NUMBER_ID|sendTemplate|sendWhatsApp/i.test(code))
    check('S. sin escrituras en wa_template_queue', !/from\('wa_template_queue'\)[\s\S]{0,200}?\.(insert|upsert|update|delete)\(/.test(code))
    check('S. sin fetch en lógica de servidor B.2', !/fetch\(/.test(['offer.ts', 'campaign.ts', 'message-preview.ts', 'broadcast-service.ts', 'selection.ts']
      .map(f => strip(readFileSync(join(__dirname, '..', 'src/lib/broadcast', f), 'utf8'))).join('\n')))
    check('S. sin URLs/base64 de imágenes', !/https?:\/\/|data:image|base64/.test(code))
    check('T. no lee ni activa flags', !/WA_BROADCAST_ENABLED|WA_AUTOMATIONS_ENABLED|process\.env/.test(code))
    check('T. sin precios hardcodeados fuera de catalog.ts', !/RD\$ ?\d|2[,.]?100|3[,.]?400|2[,.]?700|1[,.]?890|2[,.]?200/.test(code))
    const cat = strip(readFileSync(join(__dirname, '..', 'src/lib/broadcast/catalog.ts'), 'utf8'))
    check('T. catalog.ts es la única fuente (bundle 2100 + recargo 100), recompra derivada (sin 1890 literal)',
      /PERSONAL_BUNDLE_PRICE = 2100/.test(cat) && /PRIORITY_SHIPPING_SURCHARGE = 100/.test(cat) && !/1890/.test(cat))
  }

  console.log(`\n${failures === 0 ? '✅ TODOS LOS TESTS PASAN' : `❌ ${failures} FALLO(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
