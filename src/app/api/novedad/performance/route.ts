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
    const cutoff24h    = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const agentId = user.id

    const [
      // ── Hoy ──────────────────────────────────────────────────────────
      // Pedidos distintos con cualquier acción registrada hoy
      trabajadosHoyRes,
      // Acciones tipo 'contacted' (incluye los que no respondieron)
      { count: pedidosContactadosHoy },
      // Acciones tipo 'rescheduled' (pedido reprogramado exitosamente)
      { count: pedidosReprogramadosHoy },
      // Acciones 'contacted' con contact_result = 'no_answer'
      { count: pedidosNoRespondenHoy },
      // Pedidos marcados no salvables hoy (no registra en agent_actions,
      // se detecta desde orders.follow_up_result = 'no_action' + updated_at)
      { count: pedidosNoSalvablesHoy },

      // ── Ayer ─────────────────────────────────────────────────────────
      trabajadosAyerRes,
      { count: reprogramadosAyer },

      // ── Cola ─────────────────────────────────────────────────────────
      // Novedades con más de 24h sin gestionar (no resueltas)
      { count: atrasadosPendientes },

      // ── Recuperadas ──────────────────────────────────────────────
      { count: recuperadasHoy },
      { count: recuperadasAyer },
    ] = await Promise.all([

      // Hoy — pedidos trabajados (DISTINCT order_id)
      supabase
        .from('agent_actions')
        .select('order_id')
        .eq('agent_id', agentId)
        .gte('created_at', todayIso),

      // Hoy — contactados (cualquier acción de tipo 'contacted')
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'contacted')
        .gte('created_at', todayIso),

      // Hoy — reprogramados
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'rescheduled')
        .gte('created_at', todayIso),

      // Hoy — no responden
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'contacted')
        .eq('contact_result', 'no_answer')
        .gte('created_at', todayIso),

      // Hoy — no salvables (markNoSalvable solo patchea orders, no inserta en agent_actions)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('follow_up_result', 'no_action')
        .gte('updated_at', todayIso),

      // Ayer — pedidos trabajados (DISTINCT order_id)
      supabase
        .from('agent_actions')
        .select('order_id')
        .eq('agent_id', agentId)
        .gte('created_at', yesterdayIso)
        .lt('created_at', todayIso),

      // Ayer — reprogramados
      supabase
        .from('agent_actions')
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId)
        .eq('action_type', 'rescheduled')
        .gte('created_at', yesterdayIso)
        .lt('created_at', todayIso),

      // Cola atrasados: novedades activas sin resolver con más de 24h
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('normalized_status', 'novedad')
        .neq('follow_up_result', 'no_action')
        .lt('updated_at', cutoff24h),

      // Novedades entregadas hoy: EFI confirmó entrega + tuvo al menos 1 intento fallido
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .or('delivery_attempts.gt.0,last_attempt_reason.not.is.null')
        .gte('last_tracking_update', todayIso),

      // Novedades entregadas ayer
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .or('delivery_attempts.gt.0,last_attempt_reason.not.is.null')
        .gte('last_tracking_update', yesterdayIso)
        .lt('last_tracking_update', todayIso),
    ])

    // Calcular distintos (Supabase no soporta COUNT DISTINCT directamente)
    const novedadesTrabajadasHoy = new Set(
      (trabajadosHoyRes.data ?? []).map(r => r.order_id)
    ).size

    const trabajadosAyer = new Set(
      (trabajadosAyerRes.data ?? []).map(r => r.order_id)
    ).size

    const rep  = pedidosReprogramadosHoy ?? 0
    const trab = novedadesTrabajadasHoy
    const repA = reprogramadosAyer ?? 0

    return NextResponse.json({
      // Hoy
      novedadesTrabajadasHoy,
      pedidosContactadosHoy:   pedidosContactadosHoy   ?? 0,
      pedidosReprogramadosHoy: rep,
      pedidosNoRespondenHoy:   pedidosNoRespondenHoy   ?? 0,
      pedidosNoSalvablesHoy:   pedidosNoSalvablesHoy   ?? 0,
      tasaRecuperacionHoy:     trab > 0 ? Math.round((rep  / trab) * 100) : null,
      // Ayer
      trabajadosAyer,
      reprogramadosAyer:       repA,
      tasaAyer:                trabajadosAyer > 0 ? Math.round((repA / trabajadosAyer) * 100) : null,
      // Cola
      atrasadosPendientes:     atrasadosPendientes ?? 0,
      // Recuperadas
      recuperadasHoy:          recuperadasHoy  ?? 0,
      recuperadasAyer:         recuperadasAyer ?? 0,
    })
  } catch (err) {
    console.error('[GET /api/novedad/performance]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
