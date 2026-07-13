import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    // Día RD (UTC-4, sin DST) — medianoche RD = 04:00 UTC
    const rdDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santo_Domingo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
    const [rdy, rdm, rdd] = rdDateStr.split('-').map(Number)
    const todayIso     = new Date(Date.UTC(rdy, rdm - 1, rdd,     4, 0, 0, 0)).toISOString()
    const yesterdayIso = new Date(Date.UTC(rdy, rdm - 1, rdd - 1, 4, 0, 0, 0)).toISOString()

    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

    const agentId = user.id

    const [
      { count: entregadosHoy },
      { count: contactadosHoy },
      { count: incidenciasHoy },
      { count: escaladosHoy },
      { count: criticosActivos },
      { count: entregadosAyer },
      { count: contactadosAyer },
    ] = await Promise.all([

      // Entregados hoy: status_since registra cuándo EFI confirmó entrega real
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .not('status_since', 'is', null)
        .gte('status_since', todayIso),

      // Contactados: cualquier acción de tipo 'contacted' hoy
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'contacted')
        .gte('created_at', todayIso),

      // Incidencias: no respondió o número incorrecto hoy
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'contacted')
        .in('contact_result', ['no_answer', 'wrong_number'])
        .gte('created_at', todayIso),

      // Escalados: courier_claim hoy
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'courier_claim')
        .gte('created_at', todayIso),

      // Críticos activos: pedidos en reparto EFI/Gintracom (con guía) con más de 48h sin cambio
      // de estado. Excluye anuladas/canceladas y pedidos SD locales (tracking_number IS NULL) —
      // mismo universo "activo" que usa /reparto y /api/flujo-stats, para no inflar el conteo
      // con pedidos SD nunca cerrados por el mensajero (ver CLAUDE.md — fix desfase /reparto).
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('normalized_status', 'en_reparto')
        .not('tracking_number', 'is', null)
        .not('raw_status', 'ilike', '%anulad%')
        .not('raw_status', 'ilike', '%cancelad%')
        .lt('status_since', cutoff48h),

      // Entregados ayer: status_since registra cuándo EFI confirmó entrega real
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .not('status_since', 'is', null)
        .gte('status_since', yesterdayIso)
        .lt('status_since', todayIso),

      // Contactados ayer
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'contacted')
        .gte('created_at', yesterdayIso)
        .lt('created_at', todayIso),
    ])

    return NextResponse.json({
      entregadosHoy:   entregadosHoy   ?? 0,
      contactadosHoy:  contactadosHoy  ?? 0,
      incidenciasHoy:  incidenciasHoy  ?? 0,
      escaladosHoy:    escaladosHoy    ?? 0,
      criticosActivos: criticosActivos ?? 0,
      entregadosAyer:  entregadosAyer  ?? 0,
      contactadosAyer: contactadosAyer ?? 0,
    })
  } catch (err) {
    console.error('[GET /api/reparto/performance]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
