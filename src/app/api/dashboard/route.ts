import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const oneDayAgo  = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()

    // Bounds for "today" and "yesterday" in Santo Domingo (UTC-4, no DST)
    function rdDayBounds(daysAgo = 0): { start: string; end: string } {
      const dateStrRD = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Santo_Domingo',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date())
      const [y, m, d] = dateStrRD.split('-').map(Number)
      const startUTC  = new Date(Date.UTC(y, m - 1, d - daysAgo, 4, 0, 0, 0))
      const endUTC    = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000 - 1)
      return { start: startUTC.toISOString(), end: endUTC.toISOString() }
    }
    const hoyRD  = rdDayBounds(0)
    const ayerRD = rdDayBounds(1)

    const [statsRes, slaRes, classRes, recentRes, staleRepartoRes, staleNovedadRes, workQueueRes, staleTransitRes, confirmedHoyRes, confirmedAyerRes] = await Promise.all([
      // Conteos por estado
      supabase.rpc('get_order_stats').maybeSingle(),

      // Pedidos con SLA en breach o en warning
      supabase.from('orders_with_sla')
        .select('id, tracking_number, customer_name, classification, sla_status, sla_deadline, assigned_name')
        .in('sla_status', ['breached', 'warning'])
        .not('follow_up_result', 'in', '("delivered","returned")')
        .order('sla_deadline', { ascending: true })
        .limit(10),

      // Conteo por clasificación
      supabase.from('orders')
        .select('classification')
        .not('classification', 'is', null),

      // Actividad reciente
      supabase.from('agent_actions')
        .select('id, action_type, created_at, order_id, orders(tracking_number, customer_name), profile:profiles!agent_id(full_name)')
        .order('created_at', { ascending: false })
        .limit(10),

      // Pedidos en reparto con más de 2 días sin movimiento
      supabase.from('orders')
        .select('id, tracking_number, customer_name, city, last_tracking_update, created_at')
        .eq('normalized_status', 'en_reparto')
        .or(`last_tracking_update.lt.${twoDaysAgo},and(last_tracking_update.is.null,created_at.lt.${twoDaysAgo})`)
        .order('last_tracking_update', { ascending: true, nullsFirst: true })
        .limit(20),

      // Novedades con más de 1 día sin movimiento
      supabase.from('orders')
        .select('id, tracking_number, customer_name, city, last_tracking_update, created_at')
        .eq('normalized_status', 'novedad')
        .or(`last_tracking_update.lt.${oneDayAgo},and(last_tracking_update.is.null,created_at.lt.${oneDayAgo})`)
        .order('last_tracking_update', { ascending: true, nullsFirst: true })
        .limit(20),

      // Cola de trabajo: pedidos problemáticos activos
      supabase.from('orders')
        .select('id, tracking_number, customer_name, city, normalized_status, delivery_attempts, sla_breached, last_tracking_update, created_at')
        .not('follow_up_result', 'in', '("delivered","returned","recovered")')
        .or('normalized_status.in.(novedad,failed_attempt,en_reparto),sla_breached.eq.true')
        .order('last_tracking_update', { ascending: true, nullsFirst: true })
        .limit(100),

      // Pedidos in_transit con más de 2 días sin movimiento
      supabase.from('orders')
        .select('id, tracking_number, customer_name, city, last_tracking_update, created_at')
        .eq('normalized_status', 'in_transit')
        .or(`last_tracking_update.lt.${twoDaysAgo},and(last_tracking_update.is.null,created_at.lt.${twoDaysAgo})`)
        .order('last_tracking_update', { ascending: true, nullsFirst: true })
        .limit(20),

      // Confirmados hoy
      supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'confirmed')
        .gte('last_confirmation_attempt', hoyRD.start)
        .lte('last_confirmation_attempt', hoyRD.end),

      // Confirmados ayer
      supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'confirmed')
        .gte('last_confirmation_attempt', ayerRD.start)
        .lte('last_confirmation_attempt', ayerRD.end),
    ])

    // Cola de trabajo: asignar prioridad y ordenar
    const nowMs      = Date.now()
    const oneDayMs   = 24 * 60 * 60 * 1000
    const twoDaysMs  = 2  * 24 * 60 * 60 * 1000

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function assignPriority(o: any): { priority: 1 | 2 | 3; reason: string } {
      const baseMs = o.last_tracking_update
        ? new Date(o.last_tracking_update).getTime()
        : new Date(o.created_at).getTime()
      const ageMs = nowMs - baseMs

      if (o.sla_breached)                                              return { priority: 3, reason: 'SLA vencido' }
      if (o.normalized_status === 'novedad' && ageMs > oneDayMs)       return { priority: 3, reason: 'Novedad +1 día' }
      if (o.delivery_attempts >= 3)                                    return { priority: 3, reason: `${o.delivery_attempts} intentos` }
      if (o.delivery_attempts === 2)                                   return { priority: 2, reason: '2 intentos' }
      if (o.normalized_status === 'en_reparto' && ageMs > twoDaysMs)   return { priority: 2, reason: 'Reparto +2 días' }
      if (o.delivery_attempts === 1)                                   return { priority: 1, reason: '1 intento' }
      return { priority: 1, reason: 'Novedad reciente' }
    }

    const workQueue = (workQueueRes.data ?? [])
      .map(o => ({ ...o, ...assignPriority(o) }))
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority
        const aMs = a.last_tracking_update ? new Date(a.last_tracking_update).getTime() : new Date(a.created_at).getTime()
        const bMs = b.last_tracking_update ? new Date(b.last_tracking_update).getTime() : new Date(b.created_at).getTime()
        return aMs - bMs
      })
      .slice(0, 50)

    // Conteos por clasificación manual
    const classCounts: Record<string, number> = {}
    for (const row of classRes.data ?? []) {
      if (row.classification) {
        classCounts[row.classification] = (classCounts[row.classification] ?? 0) + 1
      }
    }

    // Contar totales por estado normalizando la vista
    const { data: statusCounts } = await supabase
      .from('orders')
      .select('normalized_status, is_at_risk, sla_breached, last_tracking_update, created_at')

    const stats = {
      total:           statusCounts?.length ?? 0,
      on_delivery:     statusCounts?.filter(o => o.normalized_status === 'en_reparto').length ?? 0,
      delivered:       statusCounts?.filter(o => o.normalized_status === 'delivered').length ?? 0,
      in_transit:      statusCounts?.filter(o => o.normalized_status === 'in_transit').length ?? 0,
      transit_critico: (statusCounts ?? []).filter(o => {
        if (o.normalized_status !== 'in_transit') return false
        const base = o.last_tracking_update ?? o.created_at
        return (Date.now() - new Date(base).getTime()) >= twoDaysMs
      }).length,
      failed_attempts: statusCounts?.filter(o => o.normalized_status === 'failed_attempt').length ?? 0,
      returned:        statusCounts?.filter(o => o.normalized_status === 'returned').length ?? 0,
      at_risk:         statusCounts?.filter(o => o.is_at_risk).length ?? 0,
      sla_breached:    statusCounts?.filter(o => o.sla_breached).length ?? 0,
    }

    return NextResponse.json({
      stats,
      sla_alerts:        slaRes.data ?? [],
      classification:    classCounts,
      recent_activity:   recentRes.data ?? [],
      stale_reparto:     staleRepartoRes.data ?? [],
      stale_novedad:     staleNovedadRes.data ?? [],
      stale_transit:     staleTransitRes.data ?? [],
      work_queue:        workQueue,
      confirmed_hoy:     confirmedHoyRes.count  ?? 0,
      confirmed_ayer:    confirmedAyerRes.count ?? 0,
    })
  } catch (err) {
    console.error('[GET /api/dashboard]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
