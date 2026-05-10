import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const ALLOWED_ROLES = ['admin', 'ia_supervisor']

function rdDayBounds(): { start: string; end: string } {
  const dateStrRD = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = dateStrRD.split('-').map(Number)
  const startUTC = new Date(Date.UTC(y, m - 1, d, 4, 0, 0, 0))
  const endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { start: startUTC.toISOString(), end: endUTC.toISOString() }
}

interface OrderAudit {
  id: string
  tracking_number: string
  order_number: string | null
  customer_name: string | null
  customer_phone: string | null
  city: string | null
  province: string | null
  delivery_attempts: number
  last_attempt_reason: string | null
  raw_status: string | null
  normalized_status: string
  status_since: string | null
  last_tracking_update: string | null
  shipment_created_at: string | null
  shopify_created_at: string | null
  cod_amount: number | null
  confirmation_status: string | null
}

// ─── Lógica de falsos positivos ───────────────────────────────────────────

function detectFalsePositive(order: Pick<OrderAudit, 'last_attempt_reason' | 'confirmation_status' | 'delivery_attempts'>): { isFP: boolean; reason: string } {
  const r = (order.last_attempt_reason ?? '').toLowerCase()

  // Cliente canceló explícitamente
  if ((r.includes('cancel') && (r.includes('cliente') || r.includes('client'))) || r.includes('canceló el pedido'))
    return { isFP: true, reason: 'Cliente canceló explícitamente' }

  // Cliente rechazó / no quiso recibir
  if (r.includes('rechaz') || r.includes('no quiso') || r.includes('no quería') || r.includes('no queria'))
    return { isFP: true, reason: 'Cliente rechazó o no quiso recibir' }

  // Teléfono / número incorrecto (datos de contacto erróneos)
  if ((r.includes('tel') || r.includes('número') || r.includes('numero')) &&
      (r.includes('incorr') || r.includes('equivoc') || r.includes('erron')))
    return { isFP: true, reason: 'Teléfono/número incorrecto registrado' }

  // Cliente solicitó devolución activamente
  if ((r.includes('pide') || r.includes('solicit') || r.includes('pidió')) &&
      (r.includes('devoluci') || r.includes('retorno')))
    return { isFP: true, reason: 'Cliente solicitó devolución' }

  // Fuera de cobertura confirmado en origen (no sólo dicho por el courier)
  if (order.confirmation_status === 'no_coverage' &&
      !r.includes('cobertura') && !r.includes('zona') && !r.trim())
    return { isFP: true, reason: 'Fuera de cobertura confirmado al crear pedido' }

  return { isFP: false, reason: '' }
}

// ─── Razón principal IA (texto auditeable) ────────────────────────────────

function getIAReason(signals: string[], order: Pick<OrderAudit, 'delivery_attempts' | 'last_attempt_reason'>): string {
  const r = (order.last_attempt_reason ?? '').toLowerCase()

  if (order.delivery_attempts >= 3) {
    if (signals.includes('Posible intento falso')) return '3 intentos con documentación insuficiente'
    return '3 intentos fallidos sin entrega documentada'
  }
  if (signals.includes('Fuera cobertura dudoso')) return 'Cobertura posiblemente válida según zona'
  if (r.includes('direcci') || r.includes('domicil')) return 'Reprogramación por dirección — verificar si era correcta'
  if (signals.includes('Reprogramación sospechosa')) return 'Reprogramación sospechosa sin justificación'
  if (signals.includes('Retraso excesivo') && signals.includes('Courier posiblemente falló'))
    return 'Novedad prolongada antes de devolución'
  if (signals.includes('Courier posiblemente falló')) return 'Courier posiblemente inconsistente'
  if (order.delivery_attempts >= 2) return 'Múltiples intentos sin entrega exitosa'
  if (order.delivery_attempts === 0) return 'Devuelto sin ningún intento registrado'
  return 'Posible devolución injustificada'
}

// ─── Confidence score (probabilidad indemnización 0-95) ───────────────────

function calcConfidenceScore(score: number, isFP: boolean): number {
  if (isFP) return 0
  return Math.min(95, Math.round(score * 0.95 + 5))
}

function getIndemnCat(confidence: number): 'altamente_probable' | 'posible' | 'excluido' {
  if (confidence >= 65) return 'altamente_probable'
  if (confidence >= 30) return 'posible'
  return 'excluido'
}

// ─── Motor de scoring ──────────────────────────────────────────────────────

const SIGNAL_LABELS = {
  CLIENT_WANTED: 'Cliente probablemente sí quería recibir',
  COURIER_FAILED: 'Courier posiblemente falló',
  COVERAGE_DOUBT: 'Fuera cobertura dudoso',
  EXCESSIVE_DELAY: 'Retraso excesivo',
  FALSE_ATTEMPT: 'Posible intento falso',
  SUSPICIOUS_REPROG: 'Reprogramación sospechosa',
  HIGH_RETURN_RISK: 'Riesgo alto devolución injusta',
  INDEMNIZABLE: 'Caso potencialmente indemnizable',
} as const

function calcRiskScore(order: OrderAudit): { score: number; level: string; signals: string[] } {
  let score = 0
  const signals = new Set<string>()
  const reason = (order.last_attempt_reason ?? '').toLowerCase()
  const now = Date.now()

  // Calcular horas estancado (misma lógica que transit-helpers.ts)
  const sinceTs = order.status_since ?? order.shipment_created_at ?? order.shopify_created_at
  const hoursStuck = sinceTs ? (now - new Date(sinceTs).getTime()) / (1000 * 3600) : null

  // ── Intentos de entrega ──
  if (order.delivery_attempts >= 3) {
    score += 30
    signals.add(SIGNAL_LABELS.FALSE_ATTEMPT)
    signals.add(SIGNAL_LABELS.HIGH_RETURN_RISK)
    signals.add(SIGNAL_LABELS.CLIENT_WANTED)
  } else if (order.delivery_attempts >= 2) {
    score += 20
    signals.add(SIGNAL_LABELS.CLIENT_WANTED)
  }

  // ── Estado devuelto ──
  if (order.normalized_status === 'returned') {
    if (order.delivery_attempts >= 2) {
      score += 20
      signals.add(SIGNAL_LABELS.INDEMNIZABLE)
      signals.add(SIGNAL_LABELS.HIGH_RETURN_RISK)
    } else if (order.delivery_attempts === 0) {
      // Devuelto sin ningún intento registrado — muy sospechoso
      score += 25
      signals.add(SIGNAL_LABELS.HIGH_RETURN_RISK)
      signals.add(SIGNAL_LABELS.COURIER_FAILED)
    } else {
      score += 10
      signals.add(SIGNAL_LABELS.HIGH_RETURN_RISK)
    }
  }

  // ── Retraso excesivo ──
  if (hoursStuck !== null && hoursStuck > 72) {
    score += 20
    signals.add(SIGNAL_LABELS.EXCESSIVE_DELAY)
    if (['en_reparto', 'in_transit', 'novedad'].includes(order.normalized_status)) {
      signals.add(SIGNAL_LABELS.COURIER_FAILED)
    }
  } else if (hoursStuck !== null && hoursStuck > 48) {
    score += 10
    signals.add(SIGNAL_LABELS.EXCESSIVE_DELAY)
  }

  // ── Razón: cobertura / zona ──
  if (reason.includes('cobertura') || reason.includes('zona')) {
    score += 15
    signals.add(SIGNAL_LABELS.COVERAGE_DOUBT)
    signals.add(SIGNAL_LABELS.COURIER_FAILED)
  }

  // ── Razón: dirección / domicilio ──
  if (reason.includes('direcci') || reason.includes('domicil')) {
    score += 10
    signals.add(SIGNAL_LABELS.SUSPICIOUS_REPROG)
  }

  // ── Novedad sin razón + múltiples intentos ──
  if (order.normalized_status === 'novedad' && order.delivery_attempts >= 2 && !reason.trim()) {
    score += 10
    signals.add(SIGNAL_LABELS.SUSPICIOUS_REPROG)
  }

  // ── Novedad muy antigua (>7 días) ──
  if (order.normalized_status === 'novedad' && hoursStuck !== null && hoursStuck > 168) {
    score += 10
    signals.add(SIGNAL_LABELS.SUSPICIOUS_REPROG)
    signals.add(SIGNAL_LABELS.EXCESSIVE_DELAY)
  }

  // ── Sin cobertura confirmada ──
  if (order.confirmation_status === 'no_coverage') {
    score += 10
    signals.add(SIGNAL_LABELS.COVERAGE_DOUBT)
  }

  const finalScore = Math.min(100, score)

  let level: string
  if (finalScore >= 76)      level = 'Crítico'
  else if (finalScore >= 51) level = 'Alto'
  else if (finalScore >= 26) level = 'Medio'
  else                       level = 'Bajo'

  return { score: finalScore, level, signals: [...signals] }
}

function sumCod(arr: Array<{ cod_amount: number | null }> | null): number {
  return (arr ?? []).reduce((s, o) => s + (o.cod_amount ?? 0), 0)
}

// ─── Handler ───────────────────────────────────────────────────────────────

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

    const role = profile?.role ?? 'agent'
    if (!ALLOWED_ROLES.includes(role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const now        = new Date()
    const cutoff48h  = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
    const cutoff72h  = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString()
    const cutoff14d  = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const hoyRD      = rdDayBounds()

    const repOrFilter72 = `status_since.lt.${cutoff72h},and(status_since.is.null,last_tracking_update.lt.${cutoff72h}),and(status_since.is.null,last_tracking_update.is.null,updated_at.lt.${cutoff72h})`
    const repOrFilter48 = `status_since.lt.${cutoff48h},and(status_since.is.null,last_tracking_update.lt.${cutoff48h}),and(status_since.is.null,last_tracking_update.is.null,updated_at.lt.${cutoff48h})`

    const [
      casosNovRet,
      casosRepartoRisk,
      courierTotalRes,
      courierEntregadosRes,
      courierDevueltosRes,
      courierNovedadesRes,
      courierRet72RepartoRes,
      courierIntentosRes,
      courierCoberturaRes,
      courierAnuladasSospRes,
      confConfHoyRes,
      confInalcanzablesRes,
      confCanceladosRes,
      confPendientesRes,
      confFueraCobRes,
      novRecuperadasHoyRes,
      novDosIntentosRes,
      novMas14diasRes,
      novIndemnRes,
      novActivasRes,
      delivEntregadosHoyRes,
      delivRepartoCriticoRes,
      delivClaimsRes,
      delivEnRepartoTotalRes,
      returnedCodsRes,
      novedadRiskCodsRes,
      repartoRetrasoCodsRes,
      returnedDetailRes,
    ] = await Promise.all([

      // 1 — Casos auditoria A: novedad + returned (todos, ordenados por intentos)
      supabase.from('orders')
        .select('id, tracking_number, order_number, customer_name, customer_phone, city, province, delivery_attempts, last_attempt_reason, raw_status, normalized_status, status_since, last_tracking_update, shipment_created_at, shopify_created_at, cod_amount, confirmation_status')
        .in('normalized_status', ['novedad', 'returned'])
        .order('delivery_attempts', { ascending: false })
        .limit(60),

      // 2 — Casos auditoria B: en_reparto + in_transit con 2+ intentos o retrasados
      supabase.from('orders')
        .select('id, tracking_number, order_number, customer_name, customer_phone, city, province, delivery_attempts, last_attempt_reason, raw_status, normalized_status, status_since, last_tracking_update, shipment_created_at, shopify_created_at, cod_amount, confirmation_status')
        .in('normalized_status', ['en_reparto', 'in_transit'])
        .gte('delivery_attempts', 2)
        .order('delivery_attempts', { ascending: false })
        .limit(40),

      // 3 — Courier: total procesados
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null),

      // 4 — Courier: entregados total
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered'),

      // 5 — Courier: devueltos total
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'returned'),

      // 6 — Courier: novedades activas
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'novedad'),

      // 7 — Courier: retrasos +72h (reparto)
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'en_reparto')
        .or(repOrFilter72),

      // 8 — Courier: intentos sospechosos (2+ intentos, no entregados)
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .gte('delivery_attempts', 2)
        .not('normalized_status', 'in', '(delivered,cancelled)'),

      // 9 — Courier: cobertura dudosa
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'no_coverage'),

      // 10 — Courier: anuladas sospechosas (returned + 2+ intentos)
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'returned')
        .gte('delivery_attempts', 2),

      // 11 — Agent confirmation: confirmados hoy
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'confirmed')
        .gte('last_confirmation_attempt', hoyRD.start)
        .lte('last_confirmation_attempt', hoyRD.end),

      // 12 — Agent confirmation: inalcanzables total
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'unreachable'),

      // 13 — Agent confirmation: cancelados total
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'cancelled'),

      // 14 — Agent confirmation: pendientes en cola
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'pending')
        .is('tracking_number', null),

      // 15 — Agent confirmation: fuera de cobertura
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'no_coverage'),

      // 16 — Agent novedad: recuperadas hoy
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .gt('delivery_attempts', 0)
        .gte('last_tracking_update', hoyRD.start)
        .lte('last_tracking_update', hoyRD.end),

      // 17 — Agent novedad: 2+ intentos activos
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'novedad')
        .gte('delivery_attempts', 2),

      // 18 — Agent novedad: +14 días
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'novedad')
        .or(`status_since.lt.${cutoff14d},and(status_since.is.null,updated_at.lt.${cutoff14d})`),

      // 19 — Agent novedad: indemnizaciones detectadas (returned + 2+)
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'returned')
        .gte('delivery_attempts', 2),

      // 20 — Agent novedad: novedades activas total
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'novedad'),

      // 21 — Agent delivery: entregados hoy
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .gte('last_tracking_update', hoyRD.start)
        .lte('last_tracking_update', hoyRD.end),

      // 22 — Agent delivery: reparto crítico +48h
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'en_reparto')
        .or(repOrFilter48),

      // 23 — Agent delivery: courier_claim actions
      supabase.from('agent_actions').select('id', { count: 'exact', head: true })
        .eq('action_type', 'courier_claim'),

      // 24 — Agent delivery: total en reparto
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'en_reparto'),

      // 25 — Dinero en riesgo: returned + 2+ intentos
      supabase.from('orders').select('cod_amount')
        .eq('normalized_status', 'returned')
        .gte('delivery_attempts', 2),

      // 26 — Dinero en riesgo: novedad + 2+ intentos
      supabase.from('orders').select('cod_amount')
        .eq('normalized_status', 'novedad')
        .gte('delivery_attempts', 2),

      // 27 — Dinero en riesgo: en_reparto + 72h
      supabase.from('orders').select('cod_amount')
        .eq('normalized_status', 'en_reparto')
        .or(repOrFilter72),

      // 28 — Detalle indemnizables: returned + 2+ intentos (lista auditeable completa)
      supabase.from('orders')
        .select('id, tracking_number, order_number, customer_name, customer_phone, city, province, delivery_attempts, last_attempt_reason, raw_status, normalized_status, status_since, last_tracking_update, shipment_created_at, shopify_created_at, cod_amount, confirmation_status')
        .eq('normalized_status', 'returned')
        .gte('delivery_attempts', 2)
        .order('delivery_attempts', { ascending: false })
        .limit(120),
    ])

    // ── Score y merge de casos ──
    const allCasos: OrderAudit[] = [
      ...((casosNovRet.data ?? []) as OrderAudit[]),
      ...((casosRepartoRisk.data ?? []) as OrderAudit[]),
    ]
    // Deduplicar por id
    const seenIds = new Set<string>()
    const deduped = allCasos.filter(o => {
      if (seenIds.has(o.id)) return false
      seenIds.add(o.id)
      return true
    })

    const casosAuditoria = deduped
      .map(order => {
        const { score, level, signals } = calcRiskScore(order)
        return { ...order, score, level, signals }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 80) // top 80 por score

    // ── Courier metrics ──
    const total      = courierTotalRes.count      ?? 0
    const entregados = courierEntregadosRes.count ?? 0
    const devueltos  = courierDevueltosRes.count  ?? 0
    const novedades  = courierNovedadesRes.count  ?? 0
    const retrasos72h = courierRet72RepartoRes.count ?? 0

    const courier = {
      totalProcesados:    total,
      entregados,
      devueltos,
      novedades,
      retrasos72h,
      intentosSospechosos: courierIntentosRes.count    ?? 0,
      coberturaDudosa:     courierCoberturaRes.count   ?? 0,
      anuladasSospechosas: courierAnuladasSospRes.count ?? 0,
      tasaEntrega:    total > 0 ? Math.round((entregados  / total) * 100) : 0,
      tasaDevolucion: total > 0 ? Math.round((devueltos   / total) * 100) : 0,
      tasaRetraso72h: total > 0 ? Math.round((retrasos72h / total) * 100) : 0,
      tasaNovedades:  total > 0 ? Math.round((novedades   / total) * 100) : 0,
    }

    // ── Agent metrics ──
    const agentes = {
      confirmation: {
        confirmadosHoy:     confConfHoyRes.count       ?? 0,
        inalcanzablesTotal: confInalcanzablesRes.count ?? 0,
        canceladosTotal:    confCanceladosRes.count    ?? 0,
        pendientesEnCola:   confPendientesRes.count    ?? 0,
        fueraCobertura:     confFueraCobRes.count      ?? 0,
      },
      novedad: {
        novedadesActivas:         novActivasRes.count        ?? 0,
        recuperadasHoy:           novRecuperadasHoyRes.count ?? 0,
        dosIntentosActivos:       novDosIntentosRes.count    ?? 0,
        masViejas14dias:          novMas14diasRes.count      ?? 0,
        indemnizacionesDetectadas: novIndemnRes.count        ?? 0,
      },
      delivery: {
        enRepartoTotal:    delivEnRepartoTotalRes.count  ?? 0,
        entregadosHoy:     delivEntregadosHoyRes.count   ?? 0,
        repartoCritico48h: delivRepartoCriticoRes.count  ?? 0,
        claimsRegistrados: delivClaimsRes.count          ?? 0,
      },
    }

    // ── Casos indemnizables detallados (query 28) ──────────────────────────
    const casosIndemnizablesDetalle = ((returnedDetailRes.data ?? []) as OrderAudit[])
      .map(order => {
        const { score, level, signals } = calcRiskScore(order)
        const { isFP, reason: fpReason } = detectFalsePositive(order)
        const iaReason = getIAReason(signals, order)
        const confidenceScore = calcConfidenceScore(score, isFP)
        const indemnCat = getIndemnCat(confidenceScore)
        return { ...order, score, level, signals, iaReason, confidenceScore, isFalsePositive: isFP, falsePositiveReason: fpReason, indemnCat }
      })
      .sort((a, b) => b.confidenceScore - a.confidenceScore)

    // ── Dinero en riesgo ──
    const devolucionesIndemnizables = sumCod(returnedCodsRes.data as Array<{ cod_amount: number | null }>)
    const pedidosEnRiesgoNovedad    = sumCod(novedadRiskCodsRes.data as Array<{ cod_amount: number | null }>)
    const repartoRetraso72h         = sumCod(repartoRetrasoCodsRes.data as Array<{ cod_amount: number | null }>)

    const altamenteProbables = casosIndemnizablesDetalle.filter(c => c.indemnCat === 'altamente_probable')
    const posibles           = casosIndemnizablesDetalle.filter(c => c.indemnCat === 'posible')
    const excluidos          = casosIndemnizablesDetalle.filter(c => c.indemnCat === 'excluido' || c.isFalsePositive)

    const dineroRiesgo = {
      devolucionesIndemnizables,
      pedidosEnRiesgoNovedad,
      repartoRetraso72h,
      totalEnRiesgo: devolucionesIndemnizables + pedidosEnRiesgoNovedad + repartoRetraso72h,
      devolucionesAltamenteProbables: sumCod(altamenteProbables),
      devolucionesPosibles:           sumCod(posibles),
      devolucionesExcluidasCount:     excluidos.length,
    }

    return NextResponse.json({
      generatedAt: now.toISOString(),
      casosAuditoria,
      casosIndemnizablesDetalle,
      courier,
      agentes,
      dineroRiesgo,
    })

  } catch (err) {
    console.error('[GET /api/supervisor-ia/auditoria]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
