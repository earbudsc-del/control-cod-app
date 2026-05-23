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

export interface SupervisorAnalysis {
  resumen: string
  senalesAFavor: string[]
  senalesEnContra: string[]
  razonamiento: string
  recomendacion: string
  checklistEvidencia: string[]
}

interface ScoreResult {
  score: number
  signals: string[]
  signalsFor: string[]
  signalsAgainst: string[]
  possibleCompensation: boolean
  compensationReason: string
  compensationPriority: 'low' | 'medium' | 'high' | 'critical'
  confidenceScore: number
  lifecycleRisk: string
  courierFlag: string
  indemnCat: 'excluido' | 'probablemente_no' | 'revisar_manual' | 'posible' | 'probable'
  supervisorAnalysis: SupervisorAnalysis
}

// ─── Keywords de cobertura ─────────────────────────────────────────────────

const COVERAGE_KEYWORDS = [
  'fuera de cobertura', 'fuera cobertura', 'zona no cubierta', 'no cubierta',
  'destino especial', 'cobertura restringida', 'sin cobertura', 'no cubre',
  'zona no cubierta', 'no está en cobertura', 'no está en zona',
]

function hasCoverageText(text: string): boolean {
  return COVERAGE_KEYWORDS.some(kw => text.includes(kw))
}

// ─── Detección de exclusiones ──────────────────────────────────────────────

function detectExclusion(order: DevolucionRow): { excluded: boolean; reason: string; category: string } {
  const r = (order.last_attempt_reason ?? '').toLowerCase()
  const raw = (order.raw_status ?? '').toLowerCase()
  const combined = r + ' ' + raw

  // Cliente canceló
  if ((r.includes('cancel') && (r.includes('cliente') || r.includes('client'))) || r.includes('canceló el pedido'))
    return { excluded: true, reason: 'Cliente canceló explícitamente', category: 'cliente_cancelo' }

  // Cliente rechazó o no quiso
  if (r.includes('rechaz') || r.includes('no quiso') || r.includes('no quería') || r.includes('no queria') || r.includes('no desea'))
    return { excluded: true, reason: 'Cliente rechazó o no quiso recibir', category: 'cliente_rechazo' }

  // Teléfono incorrecto
  if ((r.includes('tel') || r.includes('número') || r.includes('numero')) &&
      (r.includes('incorr') || r.includes('equivoc') || r.includes('erron')))
    return { excluded: true, reason: 'Teléfono/número incorrecto', category: 'tel_incorrecto' }

  // Dirección incorrecta confirmada
  if ((r.includes('direcci') || r.includes('domicil')) &&
      (r.includes('incorr') || r.includes('equivoc') || r.includes('erron') || r.includes('no exist')))
    return { excluded: true, reason: 'Dirección incorrecta confirmada', category: 'dir_incorrecta' }

  // Cliente solicitó devolución
  if ((r.includes('pide') || r.includes('solicit') || r.includes('pidió') || r.includes('pidio')) &&
      (r.includes('devoluci') || r.includes('retorno')))
    return { excluded: true, reason: 'Cliente solicitó devolución', category: 'cliente_solicito' }

  // Fuera de cobertura confirmado: keyword presente Y confirmation_status = 'no_coverage'
  const hasCoverage = hasCoverageText(combined)
  if (hasCoverage && order.confirmation_status === 'no_coverage')
    return { excluded: true, reason: 'Fuera de cobertura confirmado', category: 'fuera_cobertura' }

  // Fuera de cobertura confirmado: confirmation_status = 'no_coverage' Y razón vacía (señal en origen)
  if (order.confirmation_status === 'no_coverage' && !r.trim())
    return { excluded: true, reason: 'Fuera de cobertura confirmado en origen (sin razón adicional)', category: 'fuera_cobertura' }

  return { excluded: false, reason: '', category: '' }
}

// ─── Análisis del Supervisor IA ────────────────────────────────────────────

function generateSupervisorAnalysis(
  order: DevolucionRow,
  ctx: {
    signalsFor: string[]
    signalsAgainst: string[]
    indemnCat: string
    confidence: number
    strongSignals: number
    hoursTotal: number
    excluded: boolean
    exclusionReason: string
  }
): SupervisorAnalysis {
  const { signalsFor, signalsAgainst, indemnCat, confidence, strongSignals } = ctx
  const location = order.city ?? order.province ?? 'ubicación no registrada'

  const resumen =
    `Guía #${order.tracking_number ?? 'N/A'} — ` +
    `${order.customer_name ?? 'Cliente desconocido'} — ` +
    `${order.delivery_attempts} intento(s) — ` +
    `${location}` +
    (order.last_attempt_reason ? ` — Motivo: ${order.last_attempt_reason}` : '')

  let razonamiento: string
  let recomendacion: string

  if (ctx.excluded) {
    razonamiento = `La devolución fue excluida del análisis de indemnización: ${ctx.exclusionReason}. Esta condición invalida cualquier señal positiva que pudiera existir.`
    recomendacion = `❌ No indemnizable: ${ctx.exclusionReason}.`
  } else if (indemnCat === 'probable') {
    razonamiento = `Con ${strongSignals} señal(es) fuerte(s) y confianza de ${confidence}%, hay evidencia sólida de posible mala gestión del courier. Se recomienda preparar reclamo con documentación.`
    recomendacion = '✅ Alta probabilidad: Preparar reclamo. Recopilar capturas del courier y confirmación del cliente.'
  } else if (indemnCat === 'posible') {
    razonamiento = `Hay señales moderadas (${signalsFor.length} a favor, ${signalsAgainst.length} en contra) con confianza ${confidence}%. Se recomienda revisar la documentación antes de decidir.`
    recomendacion = '⚠️ Posible: Revisar documentación del courier y contactar al cliente antes de iniciar reclamo.'
  } else if (order.delivery_attempts >= 4) {
    razonamiento = `Con ${order.delivery_attempts} intentos documentados, el courier superó la obligación estándar de 3 intentos. Esto reduce significativamente la probabilidad de indemnización. La transportadora normalmente no está obligada más allá de 3 intentos — si hizo más, difícilmente proceda el reclamo salvo que haya irregularidades adicionales.`
    recomendacion = `❌ Probablemente no indemnizable: ${order.delivery_attempts} intentos indican gestión extendida del courier. Revisar manualmente si hay irregularidades.`
  } else if (indemnCat === 'revisar_manual') {
    razonamiento = `Las señales disponibles son mixtas o débiles. Confianza de ${confidence}%. No se puede determinar automáticamente sin revisar la documentación adicional.`
    recomendacion = '📋 Revisar manualmente: Recopilar evidencia antes de tomar decisión.'
  } else {
    razonamiento = `Las señales disponibles (confianza ${confidence}%) no son suficientes para recomendar un reclamo. Sin evidencia clara de mala gestión del courier.`
    recomendacion = '❌ Sin señales suficientes para reclamo. Considerar descartar o marcar como revisado.'
  }

  const checklistEvidencia = [
    'Revisar historial de WhatsApp con el cliente',
    'Solicitar captura de pantalla del courier (tracking con intentos)',
    'Verificar historial completo de tracking en EFI',
    'Revisar notas internas previas al caso',
    location !== 'ubicación no registrada'
      ? `Confirmar que ${location} está en zona de cobertura`
      : 'Verificar dirección completa y cobertura de la zona',
  ]

  return {
    resumen,
    senalesAFavor: signalsFor,
    senalesEnContra: signalsAgainst,
    razonamiento,
    recomendacion,
    checklistEvidencia,
  }
}

// ─── Motor de scoring conservador ─────────────────────────────────────────

function calcCompensationScore(order: DevolucionRow): ScoreResult {
  const now = Date.now()
  const sinceTs = order.status_since ?? order.shipment_created_at ?? order.shopify_created_at ?? order.created_at
  const hoursTotal = (now - new Date(order.created_at).getTime()) / (1000 * 3600)
  const hoursInStatus = sinceTs ? (now - new Date(sinceTs).getTime()) / (1000 * 3600) : null
  const r = (order.last_attempt_reason ?? '').toLowerCase()
  const raw = (order.raw_status ?? '').toLowerCase()
  const combined = r + ' ' + raw

  const signalsFor: string[] = []
  const signalsAgainst: string[] = []

  // ── Verificar exclusiones primero ────────────────────────────────────────
  const exclusion = detectExclusion(order)
  if (exclusion.excluded) {
    signalsAgainst.push(exclusion.reason)
    const analysis = generateSupervisorAnalysis(order, {
      signalsFor: [],
      signalsAgainst,
      indemnCat: 'excluido',
      confidence: 0,
      strongSignals: 0,
      hoursTotal,
      excluded: true,
      exclusionReason: exclusion.reason,
    })
    return {
      score: 0,
      signals: [],
      signalsFor: [],
      signalsAgainst,
      possibleCompensation: false,
      compensationReason: `Excluida: ${exclusion.reason}`,
      compensationPriority: 'low',
      confidenceScore: 0,
      lifecycleRisk: 'normal',
      courierFlag: 'sin_señales',
      indemnCat: 'excluido',
      supervisorAnalysis: analysis,
    }
  }

  // ── Cobertura dudosa (keyword presente pero NO confirmation_status=no_coverage) ──
  const coverageDoubtful = hasCoverageText(combined) && order.confirmation_status !== 'no_coverage'

  let score = 0
  let strongSignals = 0

  // ── SEÑALES A FAVOR ───────────────────────────────────────────────────────

  // Sin intentos: courier nunca intentó (señal fuerte)
  if (order.delivery_attempts === 0) {
    score += 30
    strongSignals++
    signalsFor.push('Sin intentos registrados — courier posiblemente no intentó la entrega')
  }

  // SLA roto +72h en reparto antes de devolver (señal fuerte)
  if (hoursInStatus !== null && hoursInStatus > 72) {
    score += 25
    strongSignals++
    signalsFor.push('SLA roto — más de 72h en reparto antes de devolver')
  }

  // Devolución sospechosamente rápida: < 24h en reparto (señal fuerte)
  if (hoursInStatus !== null && hoursInStatus < 24 && order.delivery_attempts > 0) {
    score += 20
    strongSignals++
    signalsFor.push('Devolución sospechosamente rápida — menos de 24h en reparto')
  }

  // Cobertura dudosa: courier dijo fuera de zona pero NO confirmado en origen (señal fuerte)
  if (coverageDoubtful) {
    score += 20
    strongSignals++
    signalsFor.push('Fuera de cobertura dudoso — zona posiblemente cubierta, verificar')
  }

  // Tiempo prolongado desde creación (señales medias)
  if (hoursTotal > 240) { // +10 días
    score += 15
    signalsFor.push('Devolución tardía — +10 días desde generación de la guía')
  } else if (hoursTotal > 168) { // +7 días
    score += 10
    signalsFor.push('Devolución tardía — +7 días desde generación de la guía')
  }

  // Sin razón documentada + múltiples intentos (señal media)
  if (!r.trim() && order.delivery_attempts >= 2) {
    score += 10
    signalsFor.push('Sin razón de devolución documentada — courier no registró motivo')
  }

  // Dirección alegada pero no confirmada como incorrecta (señal débil)
  if ((r.includes('direcci') || r.includes('domicil')) &&
      !r.includes('incorr') && !r.includes('equivoc') && !r.includes('erron') && !r.includes('no exist')) {
    score += 10
    signalsFor.push('Dirección alegada como motivo — verificar si era correcta')
  }

  // 2–3 intentos: señal débil positiva
  if (order.delivery_attempts === 2) {
    score += 8
    signalsFor.push('2 intentos sin entrega exitosa — verificar documentación')
  } else if (order.delivery_attempts === 3) {
    score += 5
    signalsFor.push('3 intentos sin entrega — courier alcanzó el mínimo requerido')
  }

  // ── SEÑALES EN CONTRA ─────────────────────────────────────────────────────

  // 4+ intentos: courier superó su obligación estándar
  if (order.delivery_attempts >= 6) {
    score -= 35
    signalsAgainst.push(`${order.delivery_attempts} intentos documentados — gestión muy extendida del courier`)
    signalsAgainst.push('La obligación estándar es 3 intentos; este courier la triplicó')
  } else if (order.delivery_attempts >= 4) {
    score -= 20
    signalsAgainst.push(`${order.delivery_attempts} intentos documentados — courier realizó gestión extendida`)
    signalsAgainst.push('La obligación estándar es 3 intentos; el courier la superó')
  }

  // confirmation_status = no_coverage sin keyword de cobertura (exclusión parcial ya verificada arriba)
  // Si llegamos aquí, confirmation_status=no_coverage solo sin razón — pero detectExclusion ya lo captura.
  // Este caso no debería darse si detectExclusion funciona correctamente.

  // ── Cálculo final ─────────────────────────────────────────────────────────

  const rawScore = Math.max(0, Math.min(100, score))

  // Confianza: alta probabilidad requiere >= 2 señales fuertes
  let confidence = rawScore > 0 ? Math.min(95, Math.round(rawScore * 0.93 + 5)) : 0

  // Cap: si no hay 2+ señales fuertes, máximo 64% (no puede ser "alta probabilidad")
  if (strongSignals < 2 && confidence >= 65) {
    confidence = 64
  }

  const possibleCompensation = confidence >= 30

  // Categoría de indemnización
  let indemnCat: ScoreResult['indemnCat']
  if (confidence >= 65) {
    indemnCat = 'probable'
  } else if (confidence >= 45) {
    indemnCat = 'posible'
  } else if (order.delivery_attempts >= 4 && strongSignals < 1) {
    indemnCat = 'probablemente_no'
  } else if (confidence >= 30) {
    indemnCat = 'revisar_manual'
  } else {
    indemnCat = 'probablemente_no'
  }

  // Razón legible
  let compensationReason: string
  if (order.delivery_attempts >= 4 && indemnCat !== 'probable') {
    compensationReason = `Revisar manual: ${order.delivery_attempts} intentos indica gestión extendida del courier`
  } else if (indemnCat === 'probablemente_no') {
    compensationReason = 'Sin señales suficientes para indemnización'
  } else if (signalsFor.length > 0) {
    compensationReason = signalsFor[0]
  } else {
    compensationReason = 'Sin señales suficientes'
  }

  // Prioridad de compensación
  let compensationPriority: ScoreResult['compensationPriority'] = 'low'
  if (confidence >= 80) compensationPriority = 'critical'
  else if (confidence >= 65) compensationPriority = 'high'
  else if (confidence >= 45) compensationPriority = 'medium'

  // Riesgo de ciclo de vida
  let lifecycleRisk = 'normal'
  if (hoursTotal > 240 || (order.delivery_attempts === 0 && hoursTotal > 72)) lifecycleRisk = 'alto'
  else if (hoursTotal > 168 || order.delivery_attempts >= 2) lifecycleRisk = 'medio'

  // Flag de gestión courier
  let courierFlag = 'sin_señales'
  if (order.delivery_attempts === 0 || coverageDoubtful) {
    courierFlag = 'sospechoso'
  } else if (strongSignals >= 1 && order.delivery_attempts >= 2 && order.delivery_attempts <= 3) {
    courierFlag = 'posiblemente_falló'
  } else if (hoursInStatus !== null && hoursInStatus > 72) {
    courierFlag = 'sla_roto'
  }

  const supervisorAnalysis = generateSupervisorAnalysis(order, {
    signalsFor,
    signalsAgainst,
    indemnCat,
    confidence,
    strongSignals,
    hoursTotal,
    excluded: false,
    exclusionReason: '',
  })

  return {
    score: rawScore,
    signals: signalsFor, // backward compat
    signalsFor,
    signalsAgainst,
    possibleCompensation,
    compensationReason,
    compensationPriority,
    confidenceScore: confidence,
    lifecycleRisk,
    courierFlag,
    indemnCat,
    supervisorAnalysis,
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
  const filter       = sp.get('filter')
  const search       = sp.get('search')
  const dateFrom     = sp.get('from')
  const dateTo       = sp.get('to')
  const cityFilter   = sp.get('city')
  const provFilter   = sp.get('province')
  const intentosFilt = sp.get('intentos')
  const motivoFilt   = sp.get('motivo')

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
      .not('status_since', 'is', null)
      .gte('status_since', today.start).lte('status_since', today.end),
    supabase.from('orders').select('*', { count: 'exact', head: true })
      .eq('normalized_status', 'returned').not('tracking_number', 'is', null)
      .not('status_since', 'is', null)
      .gte('status_since', yesterday.start).lte('status_since', yesterday.end),
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
    query = query.not('status_since', 'is', null).gte('status_since', today.start).lte('status_since', today.end)
  } else if (filter === 'devueltas-ayer') {
    query = query.not('status_since', 'is', null).gte('status_since', yesterday.start).lte('status_since', yesterday.end)
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

  // KPIs de indemnización (requieren scoring — calcular sobre todos los returned)
  let allForKpis: typeof enriched = enriched
  if (filter && filter !== 'todas') {
    const { data: allRaw } = await supabase.from('orders')
      .select('id,delivery_attempts,last_attempt_reason,status_since,shipment_created_at,shopify_created_at,created_at,confirmation_status,normalized_status,cod_amount,return_review_status,raw_status')
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

  // Monto potencial (solo admin/ia_supervisor, solo alta probabilidad, con disclaimer)
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
