import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Returns IDs of orders with route_confirmed in the last 7 days, plus full order data for
// those currently en_reparto (SD local). The orders supplement enRepartoData in the page
// to handle the case where a recently-dispatched order is beyond the limit=500 page.
export async function GET() {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({ ids: [], orders: [] }, { status: 401 })

    const serviceClient = await createServiceClient()
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // serviceClient bypassa RLS — ve TODOS los route_confirmed del sistema (sin filtro de store).
    // El filtro de store se aplica en la query de orders más abajo (authClient respeta RLS).
    const { data: actionsData, error: actionsError } = await serviceClient
      .from('agent_actions')
      .select('order_id, created_at')
      .eq('action_type', 'route_confirmed')
      .gte('created_at', since)
      .order('created_at', { ascending: false })

    if (actionsError) {
      console.error('[route-confirmed-ids] agent_actions query FAILED:', actionsError.code, actionsError.message)
      return NextResponse.json({ ids: [], orders: [] })
    }

    const ids = [...new Set((actionsData ?? []).map(r => r.order_id as string))]
    if (ids.length === 0) return NextResponse.json({ ids: [], orders: [] })

    // Fetch full order data using the user's auth client (respects store RLS) for ids
    // that are still en_reparto and SD local (no tracking). These may be absent from the
    // main en_reparto fetch if they were dispatched recently and sorted beyond limit=500.
    const { data: ordersData, error: ordersError } = await authClient
      .from('orders')
      .select('*')
      .in('id', ids)
      .eq('normalized_status', 'en_reparto')
      .is('tracking_number', null)

    if (ordersError) {
      console.error('[route-confirmed-ids] orders query FAILED:', ordersError.code, ordersError.message, '— returning ids only')
      return NextResponse.json({ ids, orders: [] })
    }

    return NextResponse.json({ ids, orders: ordersData ?? [] })
  } catch (err) {
    console.error('[GET /api/sd-delivery/route-confirmed-ids]', err)
    return NextResponse.json({ ids: [], orders: [] })
  }
}
