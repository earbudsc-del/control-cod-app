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
    const yesterdayIso = new Date(Date.UTC(rdy, rdm - 1, rdd - 1, 4, 0, 0, 0)).toISOString()

    // Source 1: EFI confirmed deliveries — cron sets last_tracking_update when transitioning
    // to delivered. Since cron never re-processes delivered orders, this timestamp is fixed
    // at the moment of delivery detection.
    const { data: efiDelivered } = await supabase
      .from('orders')
      .select('*')
      .eq('normalized_status', 'delivered')
      .gte('last_tracking_update', yesterdayIso)
      .order('last_tracking_update', { ascending: false })

    // Source 2: agent manually reported delivered (not yet EFI-confirmed)
    const { data: agentActions } = await supabase
      .from('agent_actions')
      .select('id, order_id, created_at')
      .eq('agent_id', user.id)
      .eq('action_type', 'delivered')
      .gte('created_at', yesterdayIso)
      .order('created_at', { ascending: false })

    // Build meta map: EFI takes precedence (courier_confirmed = true)
    const metaMap = new Map<string, { reported_at: string; courier_confirmed: boolean }>()

    for (const o of (efiDelivered ?? [])) {
      metaMap.set(o.id, {
        reported_at:      o.last_tracking_update as string,
        courier_confirmed: true,
      })
    }

    // Keep most recent agent action per order; skip if EFI already covered it
    for (const a of (agentActions ?? [])) {
      if (!metaMap.has(a.order_id)) {
        metaMap.set(a.order_id, { reported_at: a.created_at, courier_confirmed: false })
      }
    }

    if (!metaMap.size) return NextResponse.json([])

    // Fetch orders not already loaded via efiDelivered
    const efiIds = new Set((efiDelivered ?? []).map(o => o.id))
    const agentOnlyIds = [...metaMap.keys()].filter(id => !efiIds.has(id))

    let deliveredOrders = [...(efiDelivered ?? [])]
    if (agentOnlyIds.length) {
      const { data: more } = await supabase.from('orders').select('*').in('id', agentOnlyIds)
      deliveredOrders = [...deliveredOrders, ...(more ?? [])]
    }

    const result = deliveredOrders.map(order => ({
      order,
      reported_at:      metaMap.get(order.id)!.reported_at,
      courier_confirmed: metaMap.get(order.id)!.courier_confirmed,
    }))

    return NextResponse.json(result)
  } catch (err) {
    console.error('[GET /api/reparto/entregados]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
