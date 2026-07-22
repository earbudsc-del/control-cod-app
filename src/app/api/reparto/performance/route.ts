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
      { count: escaladosHoy },
      { count: criticosActivos },
      { count: entregadosAyer },
      { data: sdDeliveredRows },
      { data: contactedRows },
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

      // Escalados: courier_claim hoy. No filtrado por canal — SD Delivery/Ruta COD
      // no usan este action_type hoy (auditado); si algún día lo usaran, requeriría
      // el mismo tratamiento que contactadosHoy/incidenciasHoy más abajo.
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

      // Contactados/Incidencias (hoy + ayer, una sola query): trae las filas crudas
      // de agent_actions de este agente en la ventana [ayer, ahora) — la exclusión de
      // pedidos SD locales se resuelve después con UNA query adicional a orders (por
      // order_id), nunca una query por acción (sin N+1). Ver resolución más abajo.
      supabase
        .from('agent_actions')
        .select('order_id, created_at, contact_result')
        .eq('agent_id', agentId)
        .eq('action_type', 'contacted')
        .gte('created_at', yesterdayIso),
    ])

    const todayMs     = new Date(todayIso).getTime()
    const yesterdayMs = new Date(yesterdayIso).getTime()

    const sdDelivered = ((sdDeliveredRows ?? []) as SdDeliveredCandidateRow[]).filter(isLocalSdDelivery)
    const entregadosSdHoy  = sdDelivered.filter(o => new Date(o.last_tracking_update).getTime() >= todayMs).length
    const entregadosSdAyer = sdDelivered.filter(o => {
      const ms = new Date(o.last_tracking_update).getTime()
      return ms >= yesterdayMs && ms < todayMs
    }).length

    // Resuelve el canal (Gintracom vs SD local) de las acciones 'contacted' con UNA
    // sola query adicional a orders — order.id → tracking_number. No filtra por
    // ciudad, payment_status, notas ni rol del agente: el único criterio es
    // tracking_number IS NOT NULL, igual que el resto del módulo.
    const contactedOrderIds = [...new Set((contactedRows ?? []).map(r => r.order_id))]
    let gintracomOrderIds = new Set<string>()
    if (contactedOrderIds.length) {
      const { data: ordersForContacted } = await supabase
        .from('orders')
        .select('id, tracking_number')
        .in('id', contactedOrderIds)
      gintracomOrderIds = new Set(
        (ordersForContacted ?? []).filter(o => o.tracking_number !== null).map(o => o.id),
      )
    }

    const gintracomContacted = (contactedRows ?? []).filter(r => gintracomOrderIds.has(r.order_id))

    const contactadosHoy = gintracomContacted.filter(
      r => new Date(r.created_at).getTime() >= todayMs,
    ).length

    const contactadosAyer = gintracomContacted.filter(r => {
      const ms = new Date(r.created_at).getTime()
      return ms >= yesterdayMs && ms < todayMs
    }).length

    const incidenciasHoy = gintracomContacted.filter(r =>
      new Date(r.created_at).getTime() >= todayMs
      && (r.contact_result === 'no_answer' || r.contact_result === 'wrong_number'),
    ).length

    return NextResponse.json({
      entregadosHoy:    entregadosHoy   ?? 0,
      contactadosHoy,
      incidenciasHoy,
      escaladosHoy:     escaladosHoy    ?? 0,
      criticosActivos:  criticosActivos ?? 0,
      entregadosAyer:   entregadosAyer  ?? 0,
      contactadosAyer,
      entregadosSdHoy,
      entregadosSdAyer,
    })
  } catch (err) {
    console.error('[GET /api/reparto/performance]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
