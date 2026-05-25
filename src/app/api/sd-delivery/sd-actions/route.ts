import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Returns the latest secondary action per order for the last 7 days.
// Secondary actions: no_answer (stored as contacted+contact_result='no_answer'),
// rescheduled, and customer_declined.
//
// Key design: we ALSO include route_confirmed in the query so we can determine
// which action is most recent per order. If route_confirmed is the latest,
// we exclude that order from the result (route-confirmed-ids handles those).
// This ensures no_answer/rescheduled only override route_confirmed when
// they are genuinely more recent (e.g., courier attempted delivery, no one home).
//
// Returns: { [order_id]: 'no_answer' | 'rescheduled' | 'customer_declined' }

export async function GET() {
  try {
    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return NextResponse.json({}, { status: 401 })

    const serviceClient = await createServiceClient()
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data, error } = await serviceClient
      .from('agent_actions')
      .select('order_id, action_type, contact_result, created_at')
      .in('action_type', ['route_confirmed', 'rescheduled', 'customer_declined', 'contacted'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[sd-actions] agent_actions query FAILED:', error.code, error.message)
      return NextResponse.json({})
    }

    // Keep only rows that match the secondary action criteria (filter out
    // irrelevant 'contacted' rows that don't have contact_result='no_answer').
    const relevant = (data ?? []).filter(r =>
      r.action_type === 'route_confirmed' ||
      r.action_type === 'rescheduled' ||
      r.action_type === 'customer_declined' ||
      (r.action_type === 'contacted' && r.contact_result === 'no_answer'),
    )

    // Take the most recent relevant action per order (rows are ordered by
    // created_at DESC, so first occurrence = most recent).
    const latestByOrder = new Map<string, typeof relevant[0]>()
    for (const row of relevant) {
      if (!latestByOrder.has(row.order_id)) {
        latestByOrder.set(row.order_id, row)
      }
    }

    // Build result: exclude orders where route_confirmed is the most recent
    // (those are handled by route-confirmed-ids and should stay as en_ruta).
    const result: Record<string, 'no_answer' | 'rescheduled' | 'customer_declined'> = {}
    for (const [orderId, row] of latestByOrder) {
      if (row.action_type === 'route_confirmed') continue
      if (row.action_type === 'rescheduled') {
        result[orderId] = 'rescheduled'
      } else if (row.action_type === 'customer_declined') {
        result[orderId] = 'customer_declined'
      } else if (row.action_type === 'contacted' && row.contact_result === 'no_answer') {
        result[orderId] = 'no_answer'
      }
    }

    const rescheduledMeta: Record<string, { at: string; count: number }> = {}
    for (const [orderId, row] of latestByOrder) {
      if (row.action_type === 'rescheduled') {
        const count = relevant.filter(r => r.order_id === orderId && r.action_type === 'rescheduled').length
        rescheduledMeta[orderId] = { at: row.created_at, count }
      }
    }

    return NextResponse.json({ actions: result, rescheduledMeta })
  } catch (err) {
    console.error('[GET /api/sd-delivery/sd-actions]', err)
    return NextResponse.json({})
  }
}
