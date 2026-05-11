/**
 * GET /api/admin/agent-payments
 *
 * Endpoint privado — solo admin.
 * Devuelve estimados de pago por agente con breakdown monetario, fórmula, score y recomendación.
 *
 * Seguridad:
 *   - 401 sin sesión
 *   - 403 para confirmation_agent, novelty_agent, delivery_agent, ia_supervisor, viewer, agent
 *   - 200 solo para admin
 *
 * Limitación conocida:
 *   - Las órdenes de confirmation_agent no tienen agent_id en la tabla orders,
 *     por lo que el pago de confirmación se computa como pool global.
 *     Si hay más de un confirmation_agent, se muestra el mismo total para todos.
 *
 * Reglas monetarias (privadas — no enviadas a agentes):
 *   Confirmation: Entregado +25 · Recuperado+entregado +35 · Devuelto +5 · Sin resp. courier +10
 *   Novelty:      Entregado +25 · Recuperado+entregado +35 · 2+ intentos +10 · Devuelto +5
 *   Delivery:     Entregado +25 · Recuperado+entregado +35 · Seguimiento activo +10 · Devuelto +5
 */

import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

type Supabase = Awaited<ReturnType<typeof createClient>>
type Level = 'Excelente' | 'Bueno' | 'Riesgo' | 'Deficiente'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PaymentBreakdownItem {
  orderId:      string
  orderNumber:  string | null
  customerName: string | null
  resultado:    string
  pago:         number
  reason:       string
}

interface AgentPayment {
  agentId:         string
  agentName:       string | null
  role:            string
  score:           number
  level:           Level
  paymentEstimate: number
  breakdown:       PaymentBreakdownItem[]
  recomendacion:   'pagar_completo' | 'pagar_con_bono' | 'revisar' | 'posible_sobrepago'
  explicacion:     string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rdDayISO(offsetDays = 0): string {
  const rdStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = rdStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + offsetDays, 4, 0, 0, 0)).toISOString()
}

function levelFromScore(score: number): Level {
  if (score >= 90) return 'Excelente'
  if (score >= 75) return 'Bueno'
  if (score >= 60) return 'Riesgo'
  return 'Deficiente'
}

function recomendacionFromLevel(level: Level, paymentEstimate: number): AgentPayment['recomendacion'] {
  if (level === 'Excelente') return paymentEstimate > 500 ? 'pagar_con_bono' : 'pagar_completo'
  if (level === 'Bueno')     return 'pagar_completo'
  if (level === 'Riesgo')    return 'revisar'
  return 'posible_sobrepago'
}

// ── Confirmation Agent payment pool ──────────────────────────────────────────

type ConfirmOrder = {
  id: string
  order_number: string | null
  customer_name: string | null
  normalized_status: string
  confirmation_status: string | null
  delivery_attempts: number | null
}

async function computeConfirmationPayment(supabase: Supabase): Promise<{
  breakdown: PaymentBreakdownItem[]
  metrics: { entregados: number; recuperados: number; devueltos: number; confirmados: number }
  score: number
}> {
  const month30 = rdDayISO(-30)
  const week1   = rdDayISO(-7)

  const { data: rawOrders } = await supabase
    .from('orders')
    .select('id, order_number, customer_name, normalized_status, confirmation_status, delivery_attempts, last_confirmation_attempt')
    .gte('last_confirmation_attempt', month30)
    .in('confirmation_status', ['confirmed', 'no_coverage', 'cancelled', 'unreachable'])
    .order('last_confirmation_attempt', { ascending: false })
    .limit(200)

  const orders: (ConfirmOrder & { last_confirmation_attempt: string | null })[] = rawOrders ?? []

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

  const breakdown: PaymentBreakdownItem[] = orders.map(o => {
    const ns = o.normalized_status ?? 'pending'
    const cs = o.confirmation_status ?? ''
    const isRec = recoveredSet.has(o.id)

    if (isRec && ns === 'delivered')
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
  })

  const thisWeek = orders.filter(o => o.last_confirmation_attempt && o.last_confirmation_attempt >= week1)
  const confirmados    = thisWeek.filter(o => o.confirmation_status === 'confirmed').length
  const entregados     = thisWeek.filter(o => o.normalized_status === 'delivered').length
  const devueltos      = thisWeek.filter(o => o.normalized_status === 'returned' && o.confirmation_status === 'confirmed').length
  const fueraCobertura = thisWeek.filter(o => o.confirmation_status === 'no_coverage').length
  const recuperados    = thisWeek.filter(o => o.normalized_status === 'delivered' && recoveredSet.has(o.id)).length
  const deliveryRate   = confirmados > 0 ? Math.round((entregados / confirmados) * 100) : 0

  const score = Math.max(0, Math.min(100, Math.round(
    40 +
    (deliveryRate / 100) * 36 +
    Math.min(recuperados / 5, 1) * 12 -
    (confirmados > 0 ? (devueltos / confirmados) * 20 : 0) -
    (confirmados > 0 ? Math.min((fueraCobertura / confirmados) * 10, 4) : 0)
  )))

  return {
    breakdown: breakdown.slice(0, 50),
    metrics: { entregados, recuperados, devueltos, confirmados },
    score,
  }
}

// ── Novelty / Delivery agent payment (per-agent via agent_actions) ─────────────

type AgentAction = { order_id: string; action_type: string; created_at: string }
type OrderMin    = { id: string; order_number: string | null; customer_name: string | null; normalized_status: string; delivery_attempts: number | null }

async function computeAgentPayment(
  supabase: Supabase,
  agentId: string,
  role: 'novelty_agent' | 'delivery_agent',
): Promise<{ breakdown: PaymentBreakdownItem[]; metrics: { entregados: number; recuperados: number; devueltos: number; trabajados: number }; score: number }> {
  const month30  = rdDayISO(-30)
  const week1    = rdDayISO(-7)
  const cutoff48 = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

  const actionTypes = role === 'novelty_agent'
    ? ['rescheduled', 'recovered', 'contacted', 'returned']
    : ['delivered', 'contacted', 'courier_claim', 'returned']

  const { data: rawActions } = await supabase
    .from('agent_actions')
    .select('order_id, action_type, created_at')
    .eq('agent_id', agentId)
    .gte('created_at', month30)
    .in('action_type', actionTypes)

  const actions: AgentAction[] = rawActions ?? []
  const orderIds = [...new Set(actions.map(a => a.order_id))]

  let ordersMap: Record<string, OrderMin> = {}
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

  // Latest action per order
  const latestPerOrder: Record<string, AgentAction> = {}
  for (const a of actions) {
    if (!latestPerOrder[a.order_id] || a.created_at > latestPerOrder[a.order_id].created_at) {
      latestPerOrder[a.order_id] = a
    }
  }

  const breakdown: PaymentBreakdownItem[] = Object.entries(latestPerOrder).map(([orderId, action]) => {
    const o = ordersMap[orderId]
    const isRec = recoveredSet.has(orderId)
    if (!o) return { orderId, orderNumber: null, customerName: null, resultado: 'Desconocido', pago: 0, reason: 'Sin datos disponibles' }

    if (isRec && o.normalized_status === 'delivered')
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Recuperado + entregado', pago: 35, reason: 'Recuperación de carrito + entrega exitosa' }
    if (o.normalized_status === 'delivered')
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Entregado', pago: 25, reason: 'Entrega exitosa' }
    if (o.normalized_status === 'returned')
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Devuelto', pago: 5, reason: 'Devuelto trabajado' }

    if (role === 'novelty_agent' && o.normalized_status === 'novedad' && (o.delivery_attempts ?? 0) >= 2)
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: '2+ intentos trabajados', pago: 10, reason: '2+ intentos gestionados activamente' }

    if (role === 'delivery_agent' && action.action_type === 'contacted' && o.normalized_status === 'en_reparto')
      return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'Seguimiento activo', pago: 10, reason: 'Cliente contactado — pedido en ruta' }

    return { orderId, orderNumber: o.order_number, customerName: o.customer_name, resultado: 'En proceso', pago: 0, reason: 'En gestión' }
  })

  // Score computation
  const thisWeekActs = actions.filter(a => a.created_at >= week1)
  const thisWeekOids = new Set(thisWeekActs.map(a => a.order_id))
  const thisOrders   = Object.values(ordersMap).filter(o => thisWeekOids.has(o.id))
  const entregados   = thisOrders.filter(o => o.normalized_status === 'delivered').length
  const devueltos    = thisOrders.filter(o => o.normalized_status === 'returned').length
  const recuperados  = thisOrders.filter(o => o.normalized_status === 'delivered' && recoveredSet.has(o.id)).length
  const trabajados   = thisWeekOids.size

  let score = 40
  if (role === 'novelty_agent') {
    const tasaRec   = trabajados > 0 ? (entregados / trabajados) * 100 : 0
    const dosInt    = thisOrders.filter(o => (o.delivery_attempts ?? 0) >= 2 && o.normalized_status === 'novedad').length
    const { count: vencidas } = await supabase
      .from('orders').select('*', { count: 'exact', head: true })
      .eq('normalized_status', 'novedad').lt('updated_at', rdDayISO(-7))
    score = Math.max(0, Math.min(100, Math.round(
      40 + (tasaRec / 100) * 36 + Math.min(trabajados / 10, 1) * 12 +
      (dosInt === 0 ? 8 : Math.max(0, 8 - dosInt * 2)) - Math.min((vencidas ?? 0) * 2, 20)
    )))
  } else {
    const contactados = thisWeekActs.filter(a => a.action_type === 'contacted').length
    const tasaEntrega = contactados > 0 ? (entregados / contactados) * 100 : 0
    const { count: criticos } = await supabase
      .from('orders').select('*', { count: 'exact', head: true })
      .eq('normalized_status', 'en_reparto').lt('status_since', cutoff48)
    score = Math.max(0, Math.min(100, Math.round(
      40 + (tasaEntrega / 100) * 36 + Math.min(contactados / 10, 1) * 12 +
      ((criticos ?? 0) === 0 ? 8 : 0) - Math.min((criticos ?? 0) * 3, 20)
    )))
  }

  return {
    breakdown: breakdown.slice(0, 50),
    metrics: { entregados, recuperados, devueltos, trabajados },
    score,
  }
}

// ── Explicación humanizada ────────────────────────────────────────────────────

function buildExplicacion(
  role: string,
  metrics: { entregados: number; recuperados: number; devueltos: number; confirmados?: number; trabajados?: number },
  paymentEstimate: number,
): string {
  const partes: string[] = []
  if (metrics.entregados > 0)  partes.push(`${metrics.entregados} entregas`)
  if (metrics.recuperados > 0) partes.push(`${metrics.recuperados} recuperaciones`)
  if (metrics.devueltos > 0)   partes.push(`${metrics.devueltos} devoluciones`)
  if (role === 'confirmation_agent' && metrics.confirmados) partes.push(`${metrics.confirmados} confirmaciones`)
  if (role !== 'confirmation_agent' && metrics.trabajados) partes.push(`${metrics.trabajados} casos trabajados`)
  const resumen = partes.length > 0 ? partes.join(', ') : 'sin actividad registrada'
  return `Pago de RD$${paymentEstimate.toLocaleString()} sugerido por: ${resumen}.`
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

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins pueden ver pagos de agentes' }, { status: 403 })
    }

    // Get all active agent profiles
    const { data: agentProfiles } = await supabase
      .from('profiles')
      .select('id, full_name, role')
      .in('role', ['confirmation_agent', 'novelty_agent', 'delivery_agent'])

    const profiles = agentProfiles ?? []
    const results: AgentPayment[] = []

    // Compute confirmation pool once (shared across all confirmation_agents)
    const confirmAgents = profiles.filter(p => p.role === 'confirmation_agent')
    let confirmPool: Awaited<ReturnType<typeof computeConfirmationPayment>> | null = null
    if (confirmAgents.length > 0) {
      confirmPool = await computeConfirmationPayment(supabase)
    }

    // Process each agent
    for (const agent of profiles) {
      let breakdown: PaymentBreakdownItem[] = []
      let metrics: { entregados: number; recuperados: number; devueltos: number; confirmados?: number; trabajados?: number } = { entregados: 0, recuperados: 0, devueltos: 0 }
      let score = 40

      if (agent.role === 'confirmation_agent' && confirmPool) {
        breakdown = confirmPool.breakdown
        metrics   = { ...confirmPool.metrics, confirmados: confirmPool.metrics.confirmados }
        score     = confirmPool.score
      } else if (agent.role === 'novelty_agent' || agent.role === 'delivery_agent') {
        const result = await computeAgentPayment(supabase, agent.id, agent.role)
        breakdown = result.breakdown
        metrics   = result.metrics
        score     = result.score
      }

      const paymentEstimate = breakdown.reduce((s, b) => s + b.pago, 0)
      const level           = levelFromScore(score)
      const recomendacion   = recomendacionFromLevel(level, paymentEstimate)
      const explicacion     = buildExplicacion(agent.role, metrics, paymentEstimate)

      results.push({
        agentId:         agent.id,
        agentName:       agent.full_name,
        role:            agent.role,
        score,
        level,
        paymentEstimate,
        breakdown,
        recomendacion,
        explicacion,
      })
    }

    // Sort by paymentEstimate desc
    results.sort((a, b) => b.paymentEstimate - a.paymentEstimate)

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      totalPago:   results.reduce((s, r) => s + r.paymentEstimate, 0),
      agents:      results,
      nota: 'Los pagos son estimados experimentales basados en actividad registrada. No reflejan pago real hasta revisión del admin.',
    })
  } catch (err) {
    console.error('[GET /api/admin/agent-payments]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
