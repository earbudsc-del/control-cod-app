import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isLocalSdDelivery, type SdOrderRow } from '@/lib/deliveries/sd-status'

interface SdDeliveredCandidateRow extends SdOrderRow {
  last_tracking_update: string
}

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
      { data: sdDeliveredRows },
    ] = await Promise.all([

      // Entregados hoy (Gintracom/EFI): status_since registra cuándo EFI confirmó
      // entrega real. tracking_number IS NOT NULL excluye explícitamente las
      // entregas locales SD, que se cuentan aparte (ver entregadosSdHoy/Ayer más
      // abajo) — antes ambos canales se mezclaban en este mismo número.
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .not('tracking_number', 'is', null)
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

      // Entregados ayer (Gintracom/EFI): mismo criterio que entregadosHoy.
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .not('tracking_number', 'is', null)
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

      // Candidatos a entrega local SD (hoy + ayer en una sola query): sin guía
      // (tracking_number IS NULL), acotado por last_tracking_update — fecha real
      // de entrega local, escrita por markSdOrderDelivered() en el momento exacto
      // de la acción (validado contra agent_actions: coincide en el 100% del
      // histórico auditado, no requiere fallback). La clasificación de zona SD
      // (isLocalSdDelivery) no es evaluable en SQL — se filtra en memoria sobre
      // este conjunto ya acotado por fecha (volumen bajo).
      supabase
        .from('orders')
        .select('id, city, province, customer_address, tracking_number, normalized_status, confirmation_status, assigned_to, last_tracking_update')
        .eq('normalized_status', 'delivered')
        .is('tracking_number', null)
        .gte('last_tracking_update', yesterdayIso),
    ])

    const todayMs     = new Date(todayIso).getTime()
    const yesterdayMs = new Date(yesterdayIso).getTime()

    const sdDelivered = ((sdDeliveredRows ?? []) as SdDeliveredCandidateRow[]).filter(isLocalSdDelivery)
    const entregadosSdHoy  = sdDelivered.filter(o => new Date(o.last_tracking_update).getTime() >= todayMs).length
    const entregadosSdAyer = sdDelivered.filter(o => {
      const ms = new Date(o.last_tracking_update).getTime()
      return ms >= yesterdayMs && ms < todayMs
    }).length

    return NextResponse.json({
      entregadosHoy:    entregadosHoy   ?? 0,
      contactadosHoy:   contactadosHoy  ?? 0,
      incidenciasHoy:   incidenciasHoy  ?? 0,
      escaladosHoy:     escaladosHoy    ?? 0,
      criticosActivos:  criticosActivos ?? 0,
      entregadosAyer:   entregadosAyer  ?? 0,
      contactadosAyer:  contactadosAyer ?? 0,
      entregadosSdHoy,
      entregadosSdAyer,
    })
  } catch (err) {
    console.error('[GET /api/reparto/performance]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
