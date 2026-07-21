import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isLocalSdDelivery, type SdOrderRow } from '@/lib/deliveries/sd-status'

type DeliveryChannel = 'gintracom' | 'sd_local'

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
    const yesterdayIso = new Date(Date.UTC(rdy, rdm - 1, rdd - 1, 4, 0, 0, 0)).toISOString()

    // Source 1: EFI/Gintracom confirmed deliveries — cron sets last_tracking_update
    // when transitioning to delivered. Since cron never re-processes delivered
    // orders, this timestamp is fixed at the moment of delivery detection.
    // tracking_number IS NOT NULL excluye entregas locales SD (Source 3, más abajo)
    // — antes se mezclaban aquí y se etiquetaban erróneamente como
    // courier_confirmed:true (SD nunca pasa por EFI).
    const { data: efiDelivered } = await supabase
      .from('orders')
      .select('*')
      .eq('normalized_status', 'delivered')
      .not('tracking_number', 'is', null)
      .gte('last_tracking_update', yesterdayIso)
      .order('last_tracking_update', { ascending: false })

    // Source 2: agent manually reported delivered (not yet EFI-confirmed) —
    // solo pedidos con guía (courier externo); el reporte SD siempre llega ya
    // con normalized_status='delivered' inmediato (Source 3 lo cubre).
    const { data: agentActions } = await supabase
      .from('agent_actions')
      .select('id, order_id, created_at')
      .eq('agent_id', user.id)
      .eq('action_type', 'delivered')
      .gte('created_at', yesterdayIso)
      .order('created_at', { ascending: false })

    // Source 3: entregas locales SD — sin guía, clasificadas por isLocalSdDelivery.
    // No se restringe por agent_id: a diferencia de Source 2 (que es "lo que yo
    // reporté, EFI aún no confirma"), esta es la métrica de canal del sistema
    // completo, igual que Source 1 para Gintracom.
    const { data: sdCandidates } = await supabase
      .from('orders')
      .select('*')
      .eq('normalized_status', 'delivered')
      .is('tracking_number', null)
      .gte('last_tracking_update', yesterdayIso)
      .order('last_tracking_update', { ascending: false })

    const sdDelivered = ((sdCandidates ?? []) as (SdOrderRow & Record<string, unknown>)[])
      .filter(isLocalSdDelivery)

    // Build meta map: EFI takes precedence (courier_confirmed = true) para pedidos
    // con guía; SD siempre queda marcado courier_confirmed:false (nunca pasa por
    // EFI) con su propio channel.
    const metaMap = new Map<string, { reported_at: string; courier_confirmed: boolean; channel: DeliveryChannel }>()

    for (const o of (efiDelivered ?? [])) {
      metaMap.set(o.id, {
        reported_at:       o.last_tracking_update as string,
        courier_confirmed: true,
        channel:           'gintracom',
      })
    }

    for (const o of sdDelivered) {
      metaMap.set(o.id as string, {
        reported_at:       o.last_tracking_update as string,
        courier_confirmed: false,
        channel:           'sd_local',
      })
    }

    // Keep most recent agent action per order; skip if EFI/SD already covered it
    for (const a of (agentActions ?? [])) {
      if (!metaMap.has(a.order_id)) {
        metaMap.set(a.order_id, { reported_at: a.created_at, courier_confirmed: false, channel: 'gintracom' })
      }
    }

    if (!metaMap.size) return NextResponse.json([])

    // Fetch orders not already loaded via efiDelivered/sdDelivered
    const loadedIds = new Set([...(efiDelivered ?? []).map(o => o.id), ...sdDelivered.map(o => o.id as string)])
    const agentOnlyIds = [...metaMap.keys()].filter(id => !loadedIds.has(id))

    let deliveredOrders = [...(efiDelivered ?? []), ...sdDelivered]
    if (agentOnlyIds.length) {
      const { data: more } = await supabase.from('orders').select('*').in('id', agentOnlyIds)
      deliveredOrders = [...deliveredOrders, ...(more ?? [])]
    }

    const result = deliveredOrders.map(order => ({
      order,
      reported_at:       metaMap.get(order.id)!.reported_at,
      courier_confirmed: metaMap.get(order.id)!.courier_confirmed,
      channel:           metaMap.get(order.id)!.channel,
    }))

    return NextResponse.json(result)
  } catch (err) {
    console.error('[GET /api/reparto/entregados]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
