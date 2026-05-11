import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

type Supabase = Awaited<ReturnType<typeof createClient>>
type Level = 'Excelente' | 'Bueno' | 'Riesgo' | 'Deficiente'

// ── Public types (sent to agents — NO money fields) ───────────────────────────

export interface BreakdownItem {
  orderId:      string
  orderNumber:  string | null
  customerName: string | null
  resultado:    string
  reason:       string
}

export interface ScoreData {
  role:      'confirmation_agent' | 'novelty_agent' | 'delivery_agent'
  score:     number
  level:     Level
  metrics:   Record<string, number | null>
  breakdown: BreakdownItem[]
  coaching:  string[]
  trends: {
    confirmacionesDelta: number | null
    entregasDelta:       number | null
    devolucionesDelta:   number | null
    scoreDelta:          number | null
    thisPeriod:          Record<string, number>
    lastPeriod:          Record<string, number>
  }
}

// ── Internal type (payment kept private — for admin endpoint) ─────────────────

export interface BreakdownItemInternal extends BreakdownItem {
  pago: number
}

// ── Date helpers (RD timezone = UTC-4, sin DST) ───────────────────────────────

function rdDayISO(offsetDays = 0): string {
  const rdStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = rdStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + offsetDays, 4, 0, 0, 0)).toISOString()
}

// ── Score / level helpers ─────────────────────────────────────────────────────

function levelFromScore(score: number): Level {
  if (score >= 90) return 'Excelente'
  if (score >= 75) return 'Bueno'
  if (score >= 60) return 'Riesgo'
  return 'Deficiente'
}

function deltaPct(current: number, prev: number): number | null {
  if (prev === 0) return null
  return Math.round(((current - prev) / prev) * 100)
}

// ── Payment rules (private — not sent to agents) ──────────────────────────────
// Confirmation:  Entregado +25 · Recuperado+entregado +35 · Devuelto +5 · Sin resp. courier +10
// Novelty:       Entregado +25 · Recuperado+entregado +35 · 2+ intentos +10 · Devuelto +5
// Delivery:      Entregado +25 · Recuperado+entregado +35 · Seguimiento activo +10 · Devuelto +5

// ── Confirmation Agent ────────────────────────────────────────────────────────

type ConfirmOrder = {
  id: string
  order_number: string | null
  customer_name: string | null
  normalized_status: string
  confirmation_status: string | null
  delivery_attempts: number | null
  last_confirmation_attempt: string | null
}

function classifyConfirm(o: ConfirmOrder, isRecovered: boolean): BreakdownItemInternal {
  const ns = o.normalized_status ?? 'pending'
  const cs = o.confirmation_status ?? ''

  if (isRecovered && ns === 'delivered')
    return { orderId: o.id, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Recuperado + entregado', pago: 35, reason: 'Recuperación de carrito + entrega exitosa' }
  if (ns === 'delivered')
    return { orderId: o.id, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Entregado', pago: 25, reason: 'Entrega exitosa confirmada por courier' }
  if (ns === 'returned' && cs === 'confirmed')
    return { orderId: o.id, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Devuelto', pago: 5, reason: 'Confirmado pero devuelto' }
  if (cs === 'no_coverage')
    return { orderId: o.id, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Fuera cobertura', pago: 0, reason: 'Zona sin cobertura' }
  if (cs === 'cancelled')
    return { orderId: o.id, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Cancelado', pago: 0, reason: 'Cancelado por el cliente' }
  if (cs === 'confirmed' && ['en_reparto', 'novedad', 'in_transit'].includes(ns) && (o.delivery_attempts ?? 0) >= 1)
    return { orderId: o.id, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Sin respuesta al courier', pago: 10, reason: 'Cliente confirmó pero no atendió al courier' }

  return { orderId: o.id, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Pendiente', pago: 0, reason: 'En proceso de entrega' }
}

function calcConfirmScore(params: {
  deliveryRate: number
  recuperados:  number
  devueltos:    number
  confirmados:  number
  fueraCobertura: number
}): number {
  const { deliveryRate, recuperados, devueltos, confirmados, fueraCobertura } = params
  const base           = 40
  const deliveryScore  = (deliveryRate / 100) * 36
  const recoveryBonus  = Math.min(recuperados / 5, 1) * 12
  const devPenalty     = confirmados > 0 ? (devueltos / confirmados) * 20 : 0
  const coberPenalty   = confirmados > 0 ? Math.min((fueraCobertura / confirmados) * 10, 4) : 0
  return Math.max(0, Math.min(100, Math.round(base + deliveryScore + recoveryBonus - devPenalty - coberPenalty)))
}

async function getConfirmacionScore(supabase: Supabase): Promise<ScoreData> {
  const week1   = rdDayISO(-7)
  const week2   = rdDayISO(-14)
  const month30 = rdDayISO(-30)

  const { data: rawOrders } = await supabase
    .from('orders')
    .select('id, order_number, customer_name, normalized_status, confirmation_status, delivery_attempts, last_confirmation_attempt')
    .gte('last_confirmation_attempt', month30)
    .in('confirmation_status', ['confirmed', 'no_coverage', 'cancelled', 'unreachable'])
    .order('last_confirmation_attempt', { ascending: false })
    .limit(200)

  const orders: ConfirmOrder[] = rawOrders ?? []

  let recoveredSet = new Set<string>()
  if (orders.length > 0) {
    const { data: carts } = await supabase
      .from('abandoned_carts')
      .select('recovered_order_id')
      .in('recovered_order_id', orders.map(o => o.id))
    recoveredSet = new Set(
      (carts ?? []).map((c: { recovered_order_id: string | null }) => c.recovered_order_id).filter((id): id is string => !!id)
    )
  }

  const fullBreakdown: BreakdownItemInternal[] = orders.map(o => classifyConfirm(o, recoveredSet.has(o.id)))

  function metricsFor(list: ConfirmOrder[]) {
    const confirmados    = list.filter(o => o.confirmation_status === 'confirmed').length
    const entregados     = list.filter(o => o.normalized_status === 'delivered').length
    const devueltos      = list.filter(o => o.normalized_status === 'returned' && o.confirmation_status === 'confirmed').length
    const fueraCobertura = list.filter(o => o.confirmation_status === 'no_coverage').length
    const recuperados    = list.filter(o => o.normalized_status === 'delivered' && recoveredSet.has(o.id)).length
    const cancelados     = list.filter(o => o.confirmation_status === 'cancelled').length
    const deliveryRate   = confirmados > 0 ? Math.round((entregados / confirmados) * 100) : 0
    return { confirmados, entregados, devueltos, fueraCobertura, recuperados, cancelados, deliveryRate }
  }

  const thisWeek = orders.filter(o => o.last_confirmation_attempt && o.last_confirmation_attempt >= week1)
  const lastWeek = orders.filter(o => o.last_confirmation_attempt && o.last_confirmation_attempt >= week2 && o.last_confirmation_attempt < week1)

  const m  = metricsFor(thisWeek)
  const ml = metricsFor(lastWeek)

  const scoreThis = calcConfirmScore(m)
  const scoreLast = calcConfirmScore(ml)
  const entDelta  = deltaPct(m.entregados, ml.entregados)
  const devDelta  = deltaPct(m.devueltos, ml.devueltos)

  const coaching: string[] = []
  if (entDelta !== null && entDelta > 5)      coaching.push(`Tu delivery rate mejoró ${entDelta}% esta semana. ¡Excelente progreso!`)
  if (devDelta !== null && devDelta < -10)    coaching.push(`Las devoluciones bajaron ${Math.abs(devDelta)}% vs la semana pasada.`)
  if (m.recuperados > 0)                      coaching.push(`¡Buen trabajo! ${m.recuperados} recuperaciones de carrito esta semana — priorizarlas mejora el delivery rate.`)
  if (m.confirmados > 0 && m.devueltos / m.confirmados > 0.2) coaching.push('Las confirmaciones con llamada tienen mejor conversión. Intenta llamar antes de WhatsApp.')
  if (m.fueraCobertura > 3)                   coaching.push(`Tienes ${m.fueraCobertura} pedidos fuera de cobertura esta semana. Verifica las zonas antes de confirmar.`)
  if (m.entregados >= 15)                     coaching.push(`¡Buen trabajo! ${m.entregados} pedidos entregados esta semana.`)
  if (coaching.length === 0)                   coaching.push('Continúa confirmando pedidos con calidad. Cada confirmación impacta tu score y el rendimiento del equipo.')

  // Strip pago before sending to agent
  const breakdown: BreakdownItem[] = fullBreakdown.map(({ pago: _p, ...rest }) => rest).slice(0, 50)

  return {
    role: 'confirmation_agent',
    score: scoreThis,
    level: levelFromScore(scoreThis),
    metrics: {
      confirmadosSemana:    m.confirmados,
      entregadosSemana:     m.entregados,
      devueltosSemana:      m.devueltos,
      fueraCoberturaSemana: m.fueraCobertura,
      recuperadosSemana:    m.recuperados,
      canceladosSemana:     m.cancelados,
      deliveryRate:         m.deliveryRate,
    },
    breakdown,
    coaching: coaching.slice(0, 4),
    trends: {
      confirmacionesDelta: deltaPct(m.confirmados, ml.confirmados),
      entregasDelta:       entDelta,
      devolucionesDelta:   devDelta,
      scoreDelta:          ml.confirmados > 0 ? scoreThis - scoreLast : null,
      thisPeriod: { confirmaciones: m.confirmados, entregas: m.entregados, devoluciones: m.devueltos },
      lastPeriod: { confirmaciones: ml.confirmados, entregas: ml.entregados, devoluciones: ml.devueltos },
    },
  }
}

// ── Novelty Agent ─────────────────────────────────────────────────────────────

type AgentAction = { order_id: string; action_type: string; created_at: string }
type OrderMinimal = { id: string; order_number: string | null; customer_name: string | null; normalized_status: string; delivery_attempts: number | null }

async function getNovedadScore(supabase: Supabase, agentId: string): Promise<ScoreData> {
  const week1   = rdDayISO(-7)
  const week2   = rdDayISO(-14)
  const month30 = rdDayISO(-30)

  const { data: rawActions } = await supabase
    .from('agent_actions')
    .select('order_id, action_type, created_at')
    .eq('agent_id', agentId)
    .gte('created_at', month30)
    .in('action_type', ['rescheduled', 'recovered', 'contacted', 'returned'])

  const actions: AgentAction[] = rawActions ?? []
  const orderIds = [...new Set(actions.map(a => a.order_id))]

  let ordersMap: Record<string, OrderMinimal> = {}
  let recoveredSet = new Set<string>()

  if (orderIds.length > 0) {
    const { data: rawOrders } = await supabase
      .from('orders')
      .select('id, order_number, customer_name, normalized_status, delivery_attempts')
      .in('id', orderIds)
    for (const o of (rawOrders ?? [])) ordersMap[o.id] = o

    const { data: carts } = await supabase
      .from('abandoned_carts')
      .select('recovered_order_id')
      .in('recovered_order_id', orderIds)
    recoveredSet = new Set(
      (carts ?? []).map((c: { recovered_order_id: string | null }) => c.recovered_order_id).filter((id): id is string => !!id)
    )
  }

  const { count: novedadesVencidas } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('normalized_status', 'novedad')
    .lt('updated_at', rdDayISO(-7))

  const latestPerOrder: Record<string, AgentAction> = {}
  for (const a of actions) {
    if (!latestPerOrder[a.order_id] || a.created_at > latestPerOrder[a.order_id].created_at) {
      latestPerOrder[a.order_id] = a
    }
  }

  function classifyNovedad(orderId: string): BreakdownItemInternal {
    const o = ordersMap[orderId]
    const isRec = recoveredSet.has(orderId)
    if (!o) return { orderId, orderNumber: null, customerName: null, resultado: 'Desconocido', pago: 0, reason: 'Sin datos disponibles' }

    if (isRec && o.normalized_status === 'delivered')
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Recuperado + entregado', pago: 35, reason: 'Novedad recuperada + entrega exitosa' }
    if (o.normalized_status === 'delivered')
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Entregado', pago: 25, reason: 'Novedad resuelta — entrega exitosa' }
    if (o.normalized_status === 'returned')
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Devuelto', pago: 5, reason: 'Novedad trabajada, devuelta por courier' }
    if (o.normalized_status === 'novedad' && (o.delivery_attempts ?? 0) >= 2)
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: '2+ intentos trabajados', pago: 10, reason: '2+ intentos gestionados activamente' }

    return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'En gestión', pago: 0, reason: 'Novedad en proceso de resolución' }
  }

  const fullBreakdown: BreakdownItemInternal[] = Object.keys(latestPerOrder).map(classifyNovedad)

  function metricsFor(acts: AgentAction[]) {
    const oids      = new Set(acts.map(a => a.order_id))
    const myOrders  = Object.values(ordersMap).filter(o => oids.has(o.id))
    const trabajados   = oids.size
    const recuperadas  = myOrders.filter(o => o.normalized_status === 'delivered').length
    const dosIntentos  = myOrders.filter(o => (o.delivery_attempts ?? 0) >= 2 && o.normalized_status === 'novedad').length
    const tasaRec      = trabajados > 0 ? Math.round((recuperadas / trabajados) * 100) : 0
    return { trabajados, recuperadas, dosIntentos, tasaRec }
  }

  const thisWeekActs = actions.filter(a => a.created_at >= week1)
  const lastWeekActs = actions.filter(a => a.created_at >= week2 && a.created_at < week1)
  const m  = metricsFor(thisWeekActs)
  const ml = metricsFor(lastWeekActs)
  const vencidas = novedadesVencidas ?? 0

  const scoreThis = Math.max(0, Math.min(100, Math.round(
    40 +
    (m.tasaRec / 100) * 36 +
    Math.min(m.trabajados / 10, 1) * 12 +
    (m.dosIntentos === 0 ? 8 : Math.max(0, 8 - m.dosIntentos * 2)) -
    Math.min(vencidas * 2, 20)
  )))
  const scoreLast = Math.max(0, Math.min(100, Math.round(
    40 + (ml.tasaRec / 100) * 36 + Math.min(ml.trabajados / 10, 1) * 12
  )))

  const recDelta  = deltaPct(m.recuperadas, ml.recuperadas)
  const trabDelta = deltaPct(m.trabajados,  ml.trabajados)

  const coaching: string[] = []
  if (recDelta !== null && recDelta > 0)         coaching.push(`Tus recuperaciones aumentaron ${recDelta}% vs la semana pasada. ¡Sigue así!`)
  if (m.dosIntentos > 5)                         coaching.push(`Tienes ${m.dosIntentos} novedades con 2+ intentos. Priorízalas hoy — cada una mejora tu tasa de recuperación.`)
  if (vencidas > 3)                              coaching.push(`${vencidas} novedades con más de 7 días sin resolver. Escala las críticas al supervisor.`)
  if (m.recuperadas >= 5)                        coaching.push(`¡Excelente! ${m.recuperadas} novedades recuperadas esta semana.`)
  if (coaching.length === 0)                     coaching.push('Sigue trabajando las novedades. Cada caso resuelto mejora el delivery rate global.')

  const breakdown: BreakdownItem[] = fullBreakdown.map(({ pago: _p, ...rest }) => rest).slice(0, 50)

  return {
    role: 'novelty_agent',
    score: scoreThis,
    level: levelFromScore(scoreThis),
    metrics: {
      trabajadosSemana:   m.trabajados,
      recuperadasSemana:  m.recuperadas,
      dosIntentosActivos: m.dosIntentos,
      tasaRecuperacion:   m.tasaRec,
      novedadesVencidas:  vencidas,
    },
    breakdown,
    coaching: coaching.slice(0, 4),
    trends: {
      confirmacionesDelta: trabDelta,
      entregasDelta:       recDelta,
      devolucionesDelta:   null,
      scoreDelta:          ml.trabajados > 0 ? scoreThis - scoreLast : null,
      thisPeriod: { trabajados: m.trabajados, recuperadas: m.recuperadas, tasaRecuperacion: m.tasaRec },
      lastPeriod: { trabajados: ml.trabajados, recuperadas: ml.recuperadas, tasaRecuperacion: ml.tasaRec },
    },
  }
}

// ── Delivery Agent ────────────────────────────────────────────────────────────

async function getRepartoScore(supabase: Supabase, agentId: string): Promise<ScoreData> {
  const week1   = rdDayISO(-7)
  const week2   = rdDayISO(-14)
  const month30 = rdDayISO(-30)
  const cutoff48 = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

  const { data: rawActions } = await supabase
    .from('agent_actions')
    .select('order_id, action_type, created_at')
    .eq('agent_id', agentId)
    .gte('created_at', month30)
    .in('action_type', ['delivered', 'contacted', 'courier_claim', 'returned'])

  const actions: AgentAction[] = rawActions ?? []
  const orderIds = [...new Set(actions.map(a => a.order_id))]

  let ordersMap: Record<string, OrderMinimal> = {}
  let recoveredSet = new Set<string>()

  if (orderIds.length > 0) {
    const { data: rawOrders } = await supabase
      .from('orders')
      .select('id, order_number, customer_name, normalized_status, delivery_attempts')
      .in('id', orderIds)
    for (const o of (rawOrders ?? [])) ordersMap[o.id] = o

    const { data: carts } = await supabase
      .from('abandoned_carts')
      .select('recovered_order_id')
      .in('recovered_order_id', orderIds)
    recoveredSet = new Set(
      (carts ?? []).map((c: { recovered_order_id: string | null }) => c.recovered_order_id).filter((id): id is string => !!id)
    )
  }

  const { count: criticosActivos } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('normalized_status', 'en_reparto')
    .lt('status_since', cutoff48)

  const latestPerOrder: Record<string, AgentAction> = {}
  for (const a of actions) {
    if (!latestPerOrder[a.order_id] || a.created_at > latestPerOrder[a.order_id].created_at) {
      latestPerOrder[a.order_id] = a
    }
  }

  function classifyReparto(orderId: string, action: AgentAction): BreakdownItemInternal {
    const o = ordersMap[orderId]
    const isRec = recoveredSet.has(orderId)
    if (!o) return { orderId, orderNumber: null, customerName: null, resultado: 'Desconocido', pago: 0, reason: 'Sin datos disponibles' }

    if (isRec && o.normalized_status === 'delivered')
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Recuperado + entregado', pago: 35, reason: 'Entrega de recuperación de carrito' }
    if (o.normalized_status === 'delivered')
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Entregado', pago: 25, reason: 'Entrega exitosa' }
    if (action.action_type === 'contacted' && o.normalized_status === 'en_reparto')
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Seguimiento activo', pago: 10, reason: 'Cliente contactado — pedido en ruta' }
    if (o.normalized_status === 'returned')
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Devuelto', pago: 5, reason: 'Devuelto al almacén' }

    return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'En proceso', pago: 0, reason: 'En gestión de reparto' }
  }

  const fullBreakdown: BreakdownItemInternal[] = Object.entries(latestPerOrder).map(([oid, action]) => classifyReparto(oid, action))

  function metricsFor(acts: AgentAction[]) {
    const oids       = new Set(acts.map(a => a.order_id))
    const myOrders   = Object.values(ordersMap).filter(o => oids.has(o.id))
    const entregados = myOrders.filter(o => o.normalized_status === 'delivered').length
    const contactados = acts.filter(a => a.action_type === 'contacted').length
    const tasaEntrega = contactados > 0 ? Math.round((entregados / contactados) * 100) : 0
    return { entregados, contactados, tasaEntrega }
  }

  const thisWeekActs = actions.filter(a => a.created_at >= week1)
  const lastWeekActs = actions.filter(a => a.created_at >= week2 && a.created_at < week1)
  const m  = metricsFor(thisWeekActs)
  const ml = metricsFor(lastWeekActs)
  const criticos = criticosActivos ?? 0

  const scoreThis = Math.max(0, Math.min(100, Math.round(
    40 +
    (m.tasaEntrega / 100) * 36 +
    Math.min(m.contactados / 10, 1) * 12 +
    (criticos === 0 ? 8 : 0) -
    Math.min(criticos * 3, 20)
  )))
  const scoreLast = Math.max(0, Math.min(100, Math.round(
    40 + (ml.tasaEntrega / 100) * 36 + Math.min(ml.contactados / 10, 1) * 12
  )))

  const entDelta = deltaPct(m.entregados, ml.entregados)

  const coaching: string[] = []
  if (entDelta !== null && entDelta > 5)           coaching.push(`Tus entregas aumentaron ${entDelta}% esta semana. ¡Excelente!`)
  if (criticos > 5)                                coaching.push(`Tienes ${criticos} pedidos críticos +48h en reparto. Escala los más antiguos con Effi.`)
  if (m.entregados >= 10)                          coaching.push(`¡Buen trabajo! ${m.entregados} entregas exitosas esta semana.`)
  if (criticos === 0 && m.entregados > 0)          coaching.push('Sin pedidos críticos. Excelente seguimiento operativo.')
  if (coaching.length === 0)                       coaching.push('Registra cada contacto con el cliente para mejorar tu score de seguimiento.')

  const breakdown: BreakdownItem[] = fullBreakdown.map(({ pago: _p, ...rest }) => rest).slice(0, 50)

  return {
    role: 'delivery_agent',
    score: scoreThis,
    level: levelFromScore(scoreThis),
    metrics: {
      entregadosSemana:  m.entregados,
      contactadosSemana: m.contactados,
      criticosActivos:   criticos,
      tasaEntrega:       m.tasaEntrega,
    },
    breakdown,
    coaching: coaching.slice(0, 4),
    trends: {
      confirmacionesDelta: null,
      entregasDelta:       entDelta,
      devolucionesDelta:   null,
      scoreDelta:          ml.contactados > 0 ? scoreThis - scoreLast : null,
      thisPeriod: { entregas: m.entregados, contactados: m.contactados, tasaEntrega: m.tasaEntrega },
      lastPeriod: { entregas: ml.entregados, contactados: ml.contactados, tasaEntrega: ml.tasaEntrega },
    },
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    const role = profile?.role
    if (!role || !['confirmation_agent', 'novelty_agent', 'delivery_agent'].includes(role)) {
      return NextResponse.json({ error: 'Acceso denegado' }, { status: 403 })
    }

    let data: ScoreData
    if (role === 'confirmation_agent') data = await getConfirmacionScore(supabase)
    else if (role === 'novelty_agent') data = await getNovedadScore(supabase, user.id)
    else                               data = await getRepartoScore(supabase, user.id)

    return NextResponse.json(data)
  } catch (err) {
    console.error('[GET /api/my-performance/score]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
