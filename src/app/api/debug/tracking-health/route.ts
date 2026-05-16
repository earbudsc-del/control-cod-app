import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/debug/tracking-health
// Solo admin. Muestra el estado real del pipeline de sincronización EFI.

const ALLOWED_ROLES = ['admin']

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

    if (!ALLOWED_ROLES.includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
    }

    const now     = new Date()
    const h24ago  = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const h48ago  = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
    const h72ago  = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString()
    const h6ago   = new Date(now.getTime() -  6 * 60 * 60 * 1000).toISOString()
    const h1ago   = new Date(now.getTime() -  1 * 60 * 60 * 1000).toISOString()

    const [
      // Conteos por normalized_status (todos los pedidos con tracking)
      statusCountsRes,
      // Guías sin raw_status (parser nunca extrajo estado)
      nullRawRes,
      // Guías con normalized_status unknown (parser falló)
      unknownRes,
      // Guías activas no actualizadas en +24h
      stale24hRes,
      // Guías activas no actualizadas en +48h
      stale48hRes,
      // Guías activas no actualizadas en +72h
      stale72hRes,
      // Guías actualizadas en la última hora (pulso del cron)
      recentlyUpdatedRes,
      // Guías actualizadas en las últimas 6h
      updated6hRes,
      // Muestra de guías stuck: in_transit sin actualizar en +48h
      stuckTransitSampleRes,
      // Muestra de guías stuck: en_reparto sin actualizar en +48h
      stuckRepartoSampleRes,
      // Muestra de guías stuck: novedad sin actualizar en +48h
      stuckNovedadSampleRes,
      // Conteo total de guías activas (con tracking, no finalizadas)
      totalActiveRes,
    ] = await Promise.all([
      // 1 - Conteos por normalized_status
      supabase
        .from('orders')
        .select('normalized_status')
        .not('tracking_number', 'is', null),

      // 2 - null raw_status con tracking asignado (parser nunca corrió o EFI nunca respondió)
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .is('raw_status', null),

      // 3 - unknown: parser corrió pero no pudo clasificar
      supabase
        .from('orders')
        .select('id, tracking_number, raw_status, last_tracking_update, created_at', { count: 'exact' })
        .not('tracking_number', 'is', null)
        .eq('normalized_status', 'unknown')
        .order('last_tracking_update', { ascending: false, nullsFirst: true })
        .limit(30),

      // 4 - activas sin actualizar +24h
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .not('normalized_status', 'in', '(delivered,returned,cancelled)')
        .or(`last_tracking_update.lt.${h24ago},last_tracking_update.is.null`),

      // 5 - activas sin actualizar +48h
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .not('normalized_status', 'in', '(delivered,returned,cancelled)')
        .or(`last_tracking_update.lt.${h48ago},last_tracking_update.is.null`),

      // 6 - activas sin actualizar +72h
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .not('normalized_status', 'in', '(delivered,returned,cancelled)')
        .or(`last_tracking_update.lt.${h72ago},last_tracking_update.is.null`),

      // 7 - actualizadas en la última hora (cron latiendo)
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .gte('last_tracking_update', h1ago),

      // 8 - actualizadas en las últimas 6h
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .gte('last_tracking_update', h6ago),

      // 9 - muestra in_transit stuck +48h
      supabase
        .from('orders')
        .select('tracking_number, raw_status, normalized_status, last_tracking_update, created_at')
        .eq('normalized_status', 'in_transit')
        .or(`last_tracking_update.lt.${h48ago},last_tracking_update.is.null`)
        .order('last_tracking_update', { ascending: true, nullsFirst: true })
        .limit(15),

      // 10 - muestra en_reparto stuck +48h
      supabase
        .from('orders')
        .select('tracking_number, raw_status, normalized_status, last_tracking_update, created_at')
        .eq('normalized_status', 'en_reparto')
        .or(`last_tracking_update.lt.${h48ago},last_tracking_update.is.null`)
        .order('last_tracking_update', { ascending: true, nullsFirst: true })
        .limit(15),

      // 11 - muestra novedad stuck +48h
      supabase
        .from('orders')
        .select('tracking_number, raw_status, normalized_status, last_tracking_update, created_at')
        .eq('normalized_status', 'novedad')
        .or(`last_tracking_update.lt.${h48ago},last_tracking_update.is.null`)
        .order('last_tracking_update', { ascending: true, nullsFirst: true })
        .limit(15),

      // 12 - total activas
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .not('normalized_status', 'in', '(delivered,returned,cancelled)'),
    ])

    // Agrupar conteos por normalized_status
    const byStatus: Record<string, number> = {}
    for (const row of statusCountsRes.data ?? []) {
      const k = row.normalized_status as string
      byStatus[k] = (byStatus[k] ?? 0) + 1
    }
    const byStatusSorted = Object.entries(byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({ status, count }))

    // Diagnóstico del cron
    const totalActive    = totalActiveRes.count ?? 0
    const updatedLastH   = recentlyUpdatedRes.count ?? 0
    const updatedLast6H  = updated6hRes.count ?? 0
    const stale24h       = stale24hRes.count ?? 0
    const stale48h       = stale48hRes.count ?? 0
    const stale72h       = stale72hRes.count ?? 0

    // El cron procesa hasta 160 órdenes por ejecución. Si hay más activas que eso,
    // algunas quedarán sin actualizar en cada ciclo.
    const maxPerRun      = 160
    const cappedCapacity = totalActive > maxPerRun
    const estimatedCycleMinutes = totalActive > 0
      ? Math.ceil(totalActive / maxPerRun) * 5  // 5 min entre runs
      : 0

    let cronHealth: 'healthy' | 'slow' | 'stalled'
    if (updatedLastH > 0)        cronHealth = 'healthy'
    else if (updatedLast6H > 0)  cronHealth = 'slow'
    else                         cronHealth = 'stalled'

    return NextResponse.json({
      generatedAt: now.toISOString(),

      cron: {
        health:                   cronHealth,
        updatedLastHour:          updatedLastH,
        updatedLast6h:            updatedLast6H,
        totalActiveOrders:        totalActive,
        maxPerCronRun:            maxPerRun,
        cappedCapacity,
        estimatedFullCycleMinutes: estimatedCycleMinutes,
        note: cappedCapacity
          ? `ALERTA: ${totalActive} órdenes activas > ${maxPerRun} cap/run. Algunas se sincronizan cada ~${estimatedCycleMinutes} min en lugar de cada 5 min.`
          : `Capacidad OK: ${totalActive} órdenes activas dentro del límite de ${maxPerRun} por ejecución.`,
      },

      stale: {
        stale24h,
        stale48h,
        stale72h,
        description: 'Órdenes activas (no delivered/returned) sin actualización en el período indicado',
      },

      parser: {
        nullRawStatus:  nullRawRes.count ?? 0,
        unknownStatus:  unknownRes.count ?? 0,
        unknownSample:  (unknownRes.data ?? []).map(o => ({
          tracking_number:      o.tracking_number,
          raw_status:           o.raw_status,
          last_tracking_update: o.last_tracking_update,
          created_at:           o.created_at,
        })),
        description: 'null raw_status = EFI nunca respondió; unknown = EFI respondió pero parser no pudo clasificar',
      },

      byStatus: byStatusSorted,

      stuckSamples: {
        in_transit_stuck48h: stuckTransitSampleRes.data ?? [],
        en_reparto_stuck48h: stuckRepartoSampleRes.data ?? [],
        novedad_stuck48h:    stuckNovedadSampleRes.data ?? [],
      },
    })
  } catch (err) {
    console.error('[GET /api/debug/tracking-health]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
