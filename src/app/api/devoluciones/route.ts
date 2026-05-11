import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

const ALLOWED_ROLES = ['admin', 'ia_supervisor', 'novelty_agent']

// ─── Helpers de timezone RD ────────────────────────────────────────────────

function rdDayBounds(offsetDays = 0): { start: string; end: string } {
  const now = new Date(Date.now() + offsetDays * 86400000)
  const dateStrRD = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  const [y, m, d] = dateStrRD.split('-').map(Number)
  const startUTC = new Date(Date.UTC(y, m - 1, d, 4, 0, 0, 0))
  const endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { start: startUTC.toISOString(), end: endUTC.toISOString() }
}

// ─── Tipos internos ────────────────────────────────────────────────────────

interface DevolucionRow {
  id: string
  tracking_number: string | null
  order_number: string | null
  customer_name: string | null
  customer_phone: string | null
  city: string | null
  province: string | null
  raw_status: string | null
  normalized_status: string
  delivery_attempts: number
  last_attempt_reason: string | null
  status_since: string | null
  shipment_created_at: string | null
  shopify_created_at: string | null
  created_at: string
  cod_amount: number | null
  confirmation_status: string | null
  return_review_status: string | null
}

// ─── Lógica de falsos positivos ────────────────────────────────────────────

function detectFalsePositive(order: Pick<DevolucionRow, 'last_attempt_reason' | 'confirmation_status'>): { isFP: boolean; reason: string } {
  const r = (order.last_attempt_reason ?? '').toLowerCase()

  if ((r.includes('cancel') && (r.includes('cliente') || r.includes('client'))) || r.includes('canceló el pedido'))
    return { isFP: true, reason: 'Cliente canceló explícitamente' }

  if (r.includes('rechaz') || r.includes('no quiso') || r.includes('no quería') || r.includes('no queria'))
    return { isFP: true, reason: 'Cliente rechazó o no quiso recibir' }

  if ((r.includes('tel') || r.includes('número') || r.includes('numero')) &&
      (r.includes('incorr') || r.includes('equivoc') || r.includes('erron')))
    return { isFP: true, reason: 'Teléfono/número incorrecto' }

  if ((r.includes('pide') || r.includes('solicit') || r.includes('pidió')) &&
      (r.includes('devoluci') || r.includes('retorno')))
    return { isFP: true, reason: 'Cliente solicitó devolución' }

  if (order.confirmation_status === 'no_coverage' && !r.includes('cobertura') && !r.includes('zona') && !r.trim())
    return { isFP: true, reason: 'Fuera de cobertura confirmado en origen' }

  return { isFP: false, reason: '' }
}

// ─── Motor de scoring de indemnización ────────────────────────────────────

function calcCompensationScore(order: DevolucionRow): {
  score: number
  signals: string[]
  possibleCompensation: boolean
  compensationReason: string
  compensationPriority: 'low' | 'medium' | 'high' | 'critical'
  confidenceScore: number
  lifecycleRisk: string
  courierFlag: string
} {
  let score = 0
  const signals = new Set<string>()
  const now = Date.now()

  const sinceTs = order.status_since ?? order.shipment_created_at ?? order.shopify_created_at ?? order.created_at
  const hoursTotal = (now - new Date(order.created_at).getTime()) / (1000 * 3600)
  const hoursInStatus = sinceTs ? (now - new Date(sinceTs).getTime()) / (1000 * 3600) : null
  const reason = (order.last_attempt_reason ?? '').toLowerCase()

  // Intentos
  if (order.delivery_attempts >= 3) {
    score += 35
    signals.add('3+ intentos fallidos')
    signals.add('Posible intento falso del courier')
    signals.add('Cliente probablemente quería recibir')
  } else if (order.delivery_attempts === 2) {
    score += 25
    signals.add('2 intentos sin entrega exitosa')
    signals.add('Cliente probablemente quería recibir')
  } else if (order.delivery_attempts === 0) {
    score += 30
    signals.add('Devuelto sin ningún intento registrado')
    signals.add('Courier posiblemente no intentó entrega')
  } else {
    score += 10
  }

  // Retraso antes de devolución
  if (hoursTotal > 240) { // +10 días
    score += 15
    signals.add('Devolución tardía — +10 días desde generación')
  } else if (hoursTotal > 168) { // +7 días
    score += 10
    signals.add('Devolución tardía — +7 días desde generación')
  }

  // Devolución sospechosamente rápida (menos de 24h desde que salió)
  if (hoursInStatus !== null && hoursInStatus < 24 && order.delivery_attempts > 0) {
    score += 15
    signals.add('Devolución muy rápida — menos de 24h en reparto')
  }

  // Razón: cobertura / zona (courier dice fuera de cobertura, pero quizás sí cubre)
  if (reason.includes('cobertura') || reason.includes('zona')) {
    score += 20
    signals.add('Cobertura dudosa — zona posiblemente cubierta')
    signals.add('Courier posiblemente falló')
  }

  // Razón: dirección / domicilio
  if (reason.includes('direcci') || reason.includes('domicil')) {
    score += 15
    signals.add('Dirección como excusa — verificar si era correcta')
  }

  // Sin razón de devolución registrada
  if (!reason.trim() && order.delivery_attempts >= 2) {
    score += 10
    signals.add('Sin razón de devolución documentada')
  }

  // SLA roto +72h en reparto antes de devolver
  if (hoursInStatus !== null && hoursInStatus > 72) {
    score += 10
    signals.add('SLA roto — +72h antes de devolución')
  }

  // Estado de confirmación
  if (order.confirmation_status === 'no_coverage') {
    score += 5
    signals.add('Fuera de cobertura en confirmación')
  }

  const fp = detectFalsePositive(order)
  if (fp.isFP) score = 0

  const finalScore = Math.min(100, score)
  const confidence = fp.isFP ? 0 : Math.min(95, Math.round(finalScore * 0.95 + 5))
  const possibleCompensation = confidence >= 30

  let compensationReason = 'Sin señales suficientes'
  if (fp.isFP) {
    compensationReason = fp.reason
  } else if (order.delivery_attempts >= 3 && signals.has('Posible intento falso del courier')) {
    compensationReason = '3+ intentos con documentación insuficiente del courier'
  } else if (order.delivery_attempts >= 3) {
    compensationReason = '3 intentos fallidos sin entrega documentada'
  } else if (order.delivery_attempts === 0) {
    compensationReason = 'Devuelto sin ningún intento de entrega registrado'
  } else if (signals.has('Cobertura dudosa — zona posiblemente cubierta')) {
    compensationReason = 'Courier alegó falta de cobertura pero zona posiblemente cubierta'
  } else if (signals.has('Dirección como excusa — verificar si era correcta')) {
    compensationReason = 'Reprogramación por dirección — verificar si era correcta'
  } else if (signals.has('Devolución muy rápida — menos de 24h en reparto')) {
    compensationReason = 'Devolución sospechosamente rápida — menos de 24h en reparto'
  } else if (order.delivery_attempts === 2) {
    compensationReason = 'Múltiples intentos sin entrega exitosa'
  }

  let compensationPriority: 'low' | 'medium' | 'high' | 'critical' = 'low'
  if (confidence >= 80) compensationPriority = 'critical'
  else if (confidence >= 65) compensationPriority = 'high'
  else if (confidence >= 45) compensationPriority = 'medium'

  // Riesgo de ciclo de vida
  let lifecycleRisk = 'normal'
  if (hoursTotal > 240 || order.delivery_attempts >= 3) lifecycleRisk = 'alto'
  else if (hoursTotal > 168 || order.delivery_attempts >= 2) lifecycleRisk = 'medio'

  // Flag de gestión courier
  let courierFlag = 'sin_señales'
  if (order.delivery_attempts === 0 || signals.has('Cobertura dudosa — zona posiblemente cubierta')) {
    courierFlag = 'sospechoso'
  } else if (order.delivery_attempts >= 3 && signals.has('Posible intento falso del courier')) {
    courierFlag = 'posiblemente_falló'
  } else if (signals.has('SLA roto — +72h antes de devolución')) {
    courierFlag = 'sla_roto'
  }

  return {
    score: finalScore,
    signals: Array.from(signals),
    possibleCompensation,
    compensationReason,
    compensationPriority,
    confidenceScore: confidence,
    lifecycleRisk,
    courierFlag,
  }
}

// ─── KPIs de devoluciones ─────────────────────────────────────────────────

interface DevolucionesKpis {
  totalDevueltas: number
  devueltasHoy: number
  devueltasAyer: number
  posiblesIndemnizaciones: number
  altaProbabilidad: number
  tresMasIntentos: number
  slaVencido72h: number
  courierSospechoso: number
  reclamadas: number
  pendientesRevisar: number
}

// ─── GET handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single()
  const role = profile?.role ?? 'agent'
  if (!ALLOWED_ROLES.includes(role)) return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })

  const isAdmin = role === 'admin' || role === 'ia_supervisor'

  const sp = request.nextUrl.searchParams
  const page    = Math.max(1, parseInt(sp.get('page') ?? '1'))
  const limit   = 50
  const offset  = (page - 1) * limit

  // Filtros
  const filter       = sp.get('filter')     // tab activo
  const search       = sp.get('search')     // búsqueda libre
  const dateFrom     = sp.get('from')       // ISO date
  const dateTo       = sp.get('to')         // ISO date
  const cityFilter   = sp.get('city')
  const provFilter   = sp.get('province')
  const intentosFilt = sp.get('intentos')   // '2' | '3'
  const motivoFilt   = sp.get('motivo')     // raw_status substring

  // ── Bounds de hoy/ayer ─────────────────────────────────────────────────
  const today     = rdDayBounds(0)
  const yesterday = rdDayBounds(-1)
  const cutoff72h = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()

  // ── KPIs (queries paralelas) ───────────────────────────────────────────
  const [
    { count: totalDevueltas },
    { count: devueltasHoy },
    { count: devueltasAyer },
    { count: tresMasIntentos },
    { count: slaVencido72h },
    { count: reclamadas },
    { count: pendientesRevisar },
  ] = await Promise.all([
    supabase.from('orders').select('*', { count: 'exact', head: true })
      .eq('normalized_status', 'returned').not('tracking_number', 'is', null),
    supabase.from('orders').select('*', { count: 'exact', head: true })
      .eq('normalized_status', 'returned').not('tracking_number', 'is', null)
      .gte('updated_at', today.start).lte('updated_at', today.end),
    supabase.from('orders').select('*', { count: 'exact', head: true })
      .eq('normalized_status', 'returned').not('tracking_number', 'is', null)
      .gte('updated_at', yesterday.start).lte('updated_at', yesterday.end),
    supabase.from('orders').select('*', { count: 'exact', head: true })
      .eq('normalized_status', 'returned').gte('delivery_attempts', 3),
    supabase.from('orders').select('*', { count: 'exact', head: true })
      .eq('normalized_status', 'returned').not('tracking_number', 'is', null)
      .lt('status_since', cutoff72h),
    supabase.from('orders').select('*', { count: 'exact', head: true })
      .eq('normalized_status', 'returned').eq('return_review_status', 'reclamado'),
    supabase.from('orders').select('*', { count: 'exact', head: true })
      .eq('normalized_status', 'returned').is('return_review_status', null),
  ])

  // ── Query principal ────────────────────────────────────────────────────
  let query = supabase.from('orders')
    .select(`
      id, tracking_number, order_number, customer_name, customer_phone,
      city, province, raw_status, normalized_status, delivery_attempts,
      last_attempt_reason, status_since, shipment_created_at,
      shopify_created_at, created_at, cod_amount, confirmation_status,
      return_review_status
    `)
    .eq('normalized_status', 'returned')
    .not('tracking_number', 'is', null)
    .order('delivery_attempts', { ascending: false })
    .order('created_at', { ascending: false })

  // Aplicar filtros de tab
  if (filter === '2-intentos') {
    query = query.eq('delivery_attempts', 2)
  } else if (filter === '3mas-intentos') {
    query = query.gte('delivery_attempts', 3)
  } else if (filter === 'devueltas-hoy') {
    query = query.gte('updated_at', today.start).lte('updated_at', today.end)
  } else if (filter === 'devueltas-ayer') {
    query = query.gte('updated_at', yesterday.start).lte('updated_at', yesterday.end)
  } else if (filter === 'sla-vencido') {
    query = query.lt('status_since', cutoff72h)
  } else if (filter === 'reclamadas') {
    query = query.eq('return_review_status', 'reclamado')
  }

  // Filtros adicionales
  if (search) {
    query = query.or(
      `tracking_number.ilike.%${search}%,order_number.ilike.%${search}%,customer_name.ilike.%${search}%,customer_phone.ilike.%${search}%`
    )
  }
  if (dateFrom) query = query.gte('created_at', dateFrom)
  if (dateTo)   query = query.lte('created_at', dateTo)
  if (cityFilter) query = query.ilike('city', `%${cityFilter}%`)
  if (provFilter) query = query.ilike('province', `%${provFilter}%`)
  if (intentosFilt === '2') query = query.eq('delivery_attempts', 2)
  if (intentosFilt === '3') query = query.gte('delivery_attempts', 3)
  if (motivoFilt) query = query.ilike('raw_status', `%${motivoFilt}%`)

  const { data: rawData, error } = await query.range(offset, offset + limit - 1)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const orders = (rawData ?? []) as DevolucionRow[]

  // Calcular compensation score por orden
  const enriched = orders.map(order => {
    const comp = calcCompensationScore(order)
    return {
      ...order,
      // No exponer cod_amount a novelty_agent
      cod_amount: isAdmin ? order.cod_amount : undefined,
      ...comp,
    }
  })

  // Para tabs de indemnización, filtrar después del scoring
  let finalData = enriched
  if (filter === 'posible-indemnizacion') {
    finalData = enriched.filter(o => o.confidenceScore >= 30 && o.confidenceScore < 65)
  } else if (filter === 'alta-indemnizacion') {
    finalData = enriched.filter(o => o.confidenceScore >= 65)
  } else if (filter === 'courier-sospechoso') {
    finalData = enriched.filter(o => o.courierFlag === 'sospechoso' || o.courierFlag === 'posiblemente_falló')
  }

  // KPIs de indemnización (requieren scoring)
  let allForKpis: typeof enriched = enriched
  if (filter && filter !== 'todas') {
    // Para KPIs globales necesitamos calcular sobre todos los returned
    const { data: allRaw } = await supabase.from('orders')
      .select('id,delivery_attempts,last_attempt_reason,status_since,shipment_created_at,shopify_created_at,created_at,confirmation_status,normalized_status,cod_amount,return_review_status')
      .eq('normalized_status', 'returned')
      .not('tracking_number', 'is', null)
      .limit(500)
    allForKpis = (allRaw ?? []).map(o => ({ ...(o as DevolucionRow), ...calcCompensationScore(o as DevolucionRow) }))
  }

  const posiblesIndemnizaciones = allForKpis.filter(o => o.confidenceScore >= 30).length
  const altaProbabilidad = allForKpis.filter(o => o.confidenceScore >= 65).length
  const courierSospechoso = allForKpis.filter(o => o.courierFlag === 'sospechoso' || o.courierFlag === 'posiblemente_falló').length

  const kpis: DevolucionesKpis = {
    totalDevueltas:      totalDevueltas ?? 0,
    devueltasHoy:        devueltasHoy ?? 0,
    devueltasAyer:       devueltasAyer ?? 0,
    posiblesIndemnizaciones,
    altaProbabilidad,
    tresMasIntentos:     tresMasIntentos ?? 0,
    slaVencido72h:       slaVencido72h ?? 0,
    courierSospechoso,
    reclamadas:          reclamadas ?? 0,
    pendientesRevisar:   pendientesRevisar ?? 0,
  }

  // Monto potencial reclamable (solo admin/ia_supervisor)
  let montoReclamable: number | null = null
  if (isAdmin) {
    const altaCandidatos = allForKpis.filter(o => o.confidenceScore >= 65)
    montoReclamable = altaCandidatos.reduce((acc, o) => acc + (o.cod_amount ?? 0), 0)
  }

  return NextResponse.json({
    data: finalData,
    kpis,
    montoReclamable,
    page,
    limit,
    generatedAt: new Date().toISOString(),
  })
}
