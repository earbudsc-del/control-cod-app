import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const ACTIVE_STATUSES = ['in_transit', 'en_reparto', 'novedad', 'unknown']

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data, error } = await supabase
      .from('orders')
      .select('id')
      .in('normalized_status', ACTIVE_STATUSES)

    if (error) throw error

    return NextResponse.json({ ids: (data ?? []).map(o => o.id) })
  } catch (err) {
    console.error('[GET /api/orders/active-tracking-ids]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
