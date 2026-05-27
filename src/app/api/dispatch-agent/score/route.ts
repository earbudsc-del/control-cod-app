import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  DISPATCH_META_DIARIA,
  DISPATCH_META_SEMANAL,
  DISPATCH_SLA_HORAS,
  type DispatchScoreData,
  type DispatchLevel,
} from '@/lib/dispatch-agent'

// Re-exportar para que código server pueda importar del route si lo necesita,
// pero los Client Components deben importar desde @/lib/dispatch-agent directamente.

// ── Helpers de fecha RD (UTC-4, sin DST) ───────────────────────────────────────

function rdDayISO(offsetDays = 0): string {
  const rdStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = rdStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + offsetDays, 4, 0, 0, 0)).toISOString()
}

function rdDayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('es-DO', {
    timeZone: 'America/Santo_Domingo',
    weekday: 'short',
  }).replace('.', '')   // 'lun.' → 'lun'
}

function rdDayKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', {
    timeZone: 'America/Santo_Domingo',
  })
}

function levelFromScore(score: number): DispatchLevel {
  if (score >= 90) return 'Excelente'
  if (score >= 75) return 'Bueno'
  if (score >= 60) return 'Riesgo'
  return 'Deficiente'
}

// ── Fórmula de score operativo ────────────────────────────────────────────────
// Dimensiones:
//   base      = 10  (siempre, por presentarse)
//   volumen   = min(confirmadosSemana / META_SEMANAL, 1) × 40   → max 40
//   velocidad = según avgDispatchTimeMinutes                      → max 20
//   backlog   = max(0, 30 − min(backlog24h, 10) × 3)            → max 30
// Total max   = 100

function calcDispatchScore(params: {
  confirmadosSemana:      number
  avgDispatchTimeMinutes: number | null
  backlog24h:             number
}): { score: number; scoreVolumen: number; scoreVelocidad: number; scoreBacklog: number; scoreBase: number } {
  const { confirmadosSemana, avgDispatchTimeMinutes, backlog24h } = params

  const scoreBase      = 10
  const scoreVolumen   = Math.round(Math.min(confirmadosSemana / DISPATCH_META_SEMANAL, 1) * 40)

  let scoreVelocidad: number
  if (avgDispatchTimeMinutes === null) {
    scoreVelocidad = 15   // neutral — sin datos suficientes
  } else if (avgDispatchTimeMinutes < 120) {
    scoreVelocidad = 20   // < 2h — excelente
  } else if (avgDispatchTimeMinutes < 240) {
    scoreVelocidad = 16   // < 4h — dentro del SLA
  } else if (avgDispatchTimeMinutes < 480) {
    scoreVelocidad = 10   // < 8h — aceptable
  } else if (avgDispatchTimeMinutes < 720) {
    scoreVelocidad = 5    // < 12h — lento
  } else {
    scoreVelocidad = 0    // ≥ 12h — crítico
  }

  const scoreBacklog = Math.max(0, 30 - Math.min(backlog24h, 10) * 3)

  const score = Math.min(100, Math.max(0, scoreBase + scoreVolumen + scoreVelocidad + scoreBacklog))

  return { score, scoreVolumen, scoreVelocidad, scoreBacklog, scoreBase }
}

// ── Main handler ───────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, role, full_name, store_id')
      .eq('id', user.id)
      .single()

    const canView = profile?.role === 'dispatch_agent' || profile?.role === 'admin'
    if (!canView) return NextResponse.json({ error: 'Acceso denegado' }, { status: 403 })

    const agentId   = user.id
    const agentName = (profile?.full_name as string | null) ?? 'Agente de despacho'
    const storeId   = profile?.store_id as string | null

    // ── Rangos de tiempo ──────────────────────────────────────────────────────
    const todayIso     = rdDayISO(0)
    const yesterdayIso = rdDayISO(-1)
    const weekIso      = rdDayISO(-7)
    const h24Ago       = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    // ── Queries paralelas ─────────────────────────────────────────────────────
    const [
      { count: guiasEFIHoy },
      { count: guiasEFIAyer },
      { count: guiasEFISemana },
      { count: despachosLocalesHoy },
      { count: despachosLocalesAyer },
      { count: despachosLocalesSemana },
      { count: pendientesSinGuia },
      { count: backlog24h },
    ] = await Promise.all([
      // Guías EFI asignadas hoy
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'tracking_assigned')
        .gte('created_at', todayIso),
      // Guías EFI asignadas ayer
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'tracking_assigned')
        .gte('created_at', yesterdayIso).lt('created_at', todayIso),
      // Guías EFI asignadas esta semana
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'tracking_assigned')
        .gte('created_at', weekIso),
      // Despachos locales hoy
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'local_dispatched')
        .gte('created_at', todayIso),
      // Despachos locales ayer
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'local_dispatched')
        .gte('created_at', yesterdayIso).lt('created_at', todayIso),
      // Despachos locales esta semana
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'local_dispatched')
        .gte('created_at', weekIso),
      // Backlog total: confirmados sin guía, no despachados
      (() => {
        let q = supabase.from('orders').select('*', { count: 'exact', head: true })
          .eq('confirmation_status', 'confirmed')
          .is('tracking_number', null)
          .not('normalized_status', 'in', '("en_reparto","delivered","returned")')
        if (storeId) q = q.eq('store_id', storeId)
        return q
      })(),
      // Backlog >24h: confirmados hace más de 24h sin guía
      (() => {
        let q = supabase.from('orders').select('*', { count: 'exact', head: true })
          .eq('confirmation_status', 'confirmed')
          .is('tracking_number', null)
          .not('normalized_status', 'in', '("en_reparto","delivered","returned")')
          .lt('last_confirmation_attempt', h24Ago)
        if (storeId) q = q.eq('store_id', storeId)
        return q
      })(),
    ])

    const gEFIHoy      = guiasEFIHoy      ?? 0
    const gEFIAyer     = guiasEFIAyer     ?? 0
    const gEFISemana   = guiasEFISemana   ?? 0
    const dLocHoy      = despachosLocalesHoy    ?? 0
    const dLocAyer     = despachosLocalesAyer   ?? 0
    const dLocSemana   = despachosLocalesSemana ?? 0
    const pSinGuia     = pendientesSinGuia ?? 0
    const b24h         = backlog24h        ?? 0

    const confirmadosProcesadosHoy  = gEFIHoy  + dLocHoy
    const confirmadosProcesadosAyer = gEFIAyer + dLocAyer
    const confirmadosSemana         = gEFISemana + dLocSemana

    // ── Actividad semanal + recent activity ───────────────────────────────────
    const { data: weekActions } = await supabase
      .from('agent_actions')
      .select('order_id, action_type, created_at, notes')
      .eq('agent_id', agentId)
      .in('action_type', ['tracking_assigned', 'local_dispatched'])
      .gte('created_at', weekIso)
      .order('created_at', { ascending: false })
      .limit(300)

    const allActions = weekActions ?? []

    // Agrupar por día RD para el chart semanal
    const dayMap: Record<string, number> = {}
    for (const action of allActions) {
      const dk = rdDayKey(action.created_at)
      dayMap[dk] = (dayMap[dk] ?? 0) + 1
    }

    const weeklyActivity = Array.from({ length: 7 }, (_, i) => {
      const iso    = rdDayISO(-6 + i)
      const dk     = rdDayKey(iso)
      const label  = rdDayLabel(iso)
      return { dayLabel: label.charAt(0).toUpperCase() + label.slice(1), dateKey: dk, processed: dayMap[dk] ?? 0 }
    })

    // Últimas 8 acciones para "Actividad reciente"
    const recentRaw = allActions.slice(0, 8)
    const recentOrderIds = [...new Set(recentRaw.map(a => a.order_id).filter(Boolean))]

    let orderNumberMap: Record<string, string | null> = {}
    if (recentOrderIds.length > 0) {
      const { data: recentOrders } = await supabase
        .from('orders')
        .select('id, order_number')
        .in('id', recentOrderIds)
      for (const o of recentOrders ?? []) {
        orderNumberMap[o.id] = o.order_number ?? null
      }
    }

    const recentActivity: DispatchScoreData['recentActivity'] = recentRaw.map(a => ({
      orderId:     a.order_id,
      orderNumber: orderNumberMap[a.order_id] ?? null,
      actionType:  a.action_type as 'tracking_assigned' | 'local_dispatched',
      createdAt:   a.created_at,
      notes:       a.notes ?? null,
    }))

    // ── Tiempo promedio confirmado → despachado ────────────────────────────────
    // Usamos las acciones local_dispatched (+ tracking_assigned) de esta semana
    // y las cruzamos con la fecha de confirmación del pedido
    let avgDispatchTimeMinutes: number | null = null

    const tracedActions = allActions.filter(a => a.order_id)
    const tracedIds = [...new Set(tracedActions.map(a => a.order_id))]

    if (tracedIds.length > 0) {
      const { data: ordersForTimes } = await supabase
        .from('orders')
        .select('id, last_confirmation_attempt')
        .in('id', tracedIds)
        .not('last_confirmation_attempt', 'is', null)

      const confirmMap: Record<string, string> = {}
      for (const o of ordersForTimes ?? []) {
        if (o.last_confirmation_attempt) confirmMap[o.id] = o.last_confirmation_attempt
      }

      const timeDiffs: number[] = []
      for (const action of tracedActions) {
        const confirmAt = confirmMap[action.order_id]
        if (!confirmAt) continue
        const diffMs = new Date(action.created_at).getTime() - new Date(confirmAt).getTime()
        if (diffMs > 0) timeDiffs.push(diffMs / 60000)   // ms → minutos
      }
      if (timeDiffs.length > 0) {
        avgDispatchTimeMinutes = Math.round(timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length)
      }
    }

    // ── Score ─────────────────────────────────────────────────────────────────
    const { score, scoreVolumen, scoreVelocidad, scoreBacklog, scoreBase } = calcDispatchScore({
      confirmadosSemana,
      avgDispatchTimeMinutes,
      backlog24h: b24h,
    })
    const level = levelFromScore(score)

    // ── Progreso metas ────────────────────────────────────────────────────────
    const progresoMetaDiaria  = Math.min(Math.round((confirmadosProcesadosHoy  / DISPATCH_META_DIARIA)  * 100), 100)
    const progresoMetaSemanal = Math.min(Math.round((confirmadosSemana / DISPATCH_META_SEMANAL) * 100), 100)

    // ── Alertas operativas ────────────────────────────────────────────────────
    const alerts: DispatchScoreData['alerts'] = []

    if (b24h >= 10) {
      alerts.push({ type: 'danger', icon: '🚨', message: `${b24h} pedidos llevan más de 24h sin despachar — riesgo de retraso crítico` })
    } else if (b24h >= 5) {
      alerts.push({ type: 'warning', icon: '⚠️', message: `${b24h} pedidos llevan más de 24h esperando guía o despacho` })
    } else if (b24h > 0) {
      alerts.push({ type: 'info', icon: '🕐', message: `${b24h} pedido${b24h > 1 ? 's' : ''} superaron las 24h — priorizar` })
    }

    if (pSinGuia >= 20) {
      alerts.push({ type: 'warning', icon: '📦', message: `${pSinGuia} pedidos confirmados sin guía asignada` })
    } else if (pSinGuia >= 10) {
      alerts.push({ type: 'info', icon: '📋', message: `${pSinGuia} pedidos confirmados pendientes de guía o despacho local` })
    }

    if (avgDispatchTimeMinutes !== null && avgDispatchTimeMinutes > 480) {
      alerts.push({ type: 'warning', icon: '⏱️', message: `Tiempo promedio de despacho: ${Math.round(avgDispatchTimeMinutes / 60)}h — por encima del SLA` })
    } else if (avgDispatchTimeMinutes !== null && avgDispatchTimeMinutes <= DISPATCH_SLA_HORAS * 60) {
      alerts.push({ type: 'success', icon: '✅', message: `SLA cumplido: promedio ${Math.round(avgDispatchTimeMinutes / 60)}h por pedido` })
    }

    if (confirmadosProcesadosHoy >= DISPATCH_META_DIARIA) {
      alerts.push({ type: 'success', icon: '🎯', message: `¡Meta diaria alcanzada! ${confirmadosProcesadosHoy} pedidos procesados hoy` })
    } else if (confirmadosProcesadosHoy > 0) {
      const faltan = DISPATCH_META_DIARIA - confirmadosProcesadosHoy
      alerts.push({ type: 'info', icon: '⚡', message: `Te faltan ${faltan} pedido${faltan > 1 ? 's' : ''} para tu meta del día` })
    }

    // Buen ritmo si el backlog es bajo y se procesó hoy
    if (b24h === 0 && pSinGuia < 5 && confirmadosProcesadosHoy > 0) {
      alerts.push({ type: 'success', icon: '🚀', message: 'Excelente ritmo — backlog bajo control' })
    }

    // ── Coaching ──────────────────────────────────────────────────────────────
    const coaching: string[] = []
    const faltan = Math.max(0, DISPATCH_META_DIARIA - confirmadosProcesadosHoy)

    if (faltan === 0) {
      coaching.push(`🎯 ¡Meta diaria cumplida! Llevas ${confirmadosProcesadosHoy} pedidos procesados hoy.`)
    } else if (faltan <= 3) {
      coaching.push(`¡Casi! Te faltan ${faltan} pedido${faltan > 1 ? 's' : ''} para tu meta del día.`)
    } else if (confirmadosProcesadosHoy === 0) {
      coaching.push(`Tienes ${pSinGuia} pedido${pSinGuia !== 1 ? 's' : ''} esperando. ¡Comienza a procesar!`)
    } else {
      coaching.push(`Llevas ${confirmadosProcesadosHoy} hoy. Llega a ${DISPATCH_META_DIARIA} para tu meta diaria.`)
    }

    if (b24h >= 5) {
      coaching.push(`${b24h} pedidos llevan más de 24h sin despachar. Prioriza esos primero.`)
    }

    if (avgDispatchTimeMinutes !== null && avgDispatchTimeMinutes <= DISPATCH_SLA_HORAS * 60) {
      coaching.push(`⚡ Excelente velocidad — promedio de ${Math.round(avgDispatchTimeMinutes / 60)}h por pedido.`)
    }

    if (progresoMetaSemanal >= 100) {
      coaching.push(`🏆 ¡Meta semanal completada! ${confirmadosSemana} pedidos esta semana.`)
    } else if (progresoMetaSemanal >= 70) {
      coaching.push(`Vas muy bien esta semana: ${confirmadosSemana}/${DISPATCH_META_SEMANAL} pedidos procesados.`)
    }

    if (coaching.length > 4) coaching.splice(4)

    // ── Respuesta ─────────────────────────────────────────────────────────────
    const result: DispatchScoreData = {
      agentName,
      confirmadosProcesadosHoy,
      guiasEFIAsignadasHoy:      gEFIHoy,
      despachosLocalesHoy:       dLocHoy,
      confirmadosProcesadosAyer,
      guiasEFIAsignadasAyer:     gEFIAyer,
      despachosLocalesAyer:      dLocAyer,
      confirmadosSemana,
      guiasEFISemana:            gEFISemana,
      despachosLocalesSemana:    dLocSemana,
      pendientesSinGuia:         pSinGuia,
      backlog24h:                b24h,
      avgDispatchTimeMinutes,
      score,
      level,
      scoreVolumen,
      scoreVelocidad,
      scoreBacklog,
      scoreBase,
      metaDiaria:                DISPATCH_META_DIARIA,
      metaSemanal:               DISPATCH_META_SEMANAL,
      progresoMetaDiaria,
      progresoMetaSemanal,
      weeklyActivity,
      alerts,
      coaching,
      recentActivity,
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[GET /api/dispatch-agent/score]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
