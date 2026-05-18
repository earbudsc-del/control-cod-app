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

    const agentId = user.id

    const [
      { count: entregadosHoy },
      { count: entregadosAyer },
      { count: enRutaHoy },
      { count: confirmedHoy },
      { count: contactadosHoy },
      { count: noRespondenHoy },
      { count: reprogramadosHoy },
    ] = await Promise.all([
      // Entregados hoy por este agente (acción delivered)
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'delivered')
        .gte('created_at', todayIso),

      // Entregados ayer
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'delivered')
        .gte('created_at', yesterdayIso)
        .lt('created_at', todayIso),

      // Rutas confirmadas hoy (mensajero confirmó salida)
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'route_confirmed')
        .gte('created_at', todayIso),

      // Clientes confirmados hoy por el mensajero SD
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'confirmed')
        .gte('created_at', todayIso),

      // Contactados hoy (cualquier acción contacted)
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'contacted')
        .gte('created_at', todayIso),

      // No responden hoy
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'contacted')
        .eq('contact_result', 'no_answer')
        .gte('created_at', todayIso),

      // Reprogramados hoy
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'rescheduled')
        .gte('created_at', todayIso),
    ])

    return NextResponse.json({
      entregadosHoy:    entregadosHoy    ?? 0,
      entregadosAyer:   entregadosAyer   ?? 0,
      enRutaHoy:        enRutaHoy        ?? 0,
      confirmedHoy:     confirmedHoy     ?? 0,
      contactadosHoy:   contactadosHoy   ?? 0,
      noRespondenHoy:   noRespondenHoy   ?? 0,
      reprogramadosHoy: reprogramadosHoy ?? 0,
    })
  } catch (err) {
    console.error('[GET /api/sd-delivery/performance]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
