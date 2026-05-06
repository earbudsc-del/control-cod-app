import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const [ordersRes, statsRes] = await Promise.all([

      // Pedidos con tracking activos en el pipeline logístico
      supabase
        .from('orders')
        .select('*', { count: 'exact' })
        .eq('source', 'shopify_webhook')
        .not('tracking_number', 'is', null)
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')
        .neq('normalized_status', 'cancelled')
        .order('last_tracking_update', { ascending: false, nullsFirst: false })
        .limit(200),

      // Conteo por normalized_status para mini KPI
      supabase
        .from('orders')
        .select('normalized_status')
        .eq('source', 'shopify_webhook')
        .not('tracking_number', 'is', null)
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')
        .neq('normalized_status', 'cancelled'),
    ])

    if (ordersRes.error) throw ordersRes.error

    // Conteo por estado
    const byStatus: Record<string, number> = {}
    for (const row of (statsRes.data ?? [])) {
      const s = row.normalized_status ?? 'unknown'
      byStatus[s] = (byStatus[s] ?? 0) + 1
    }

    return NextResponse.json({
      data:     ordersRes.data  ?? [],
      total:    ordersRes.count ?? 0,
      byStatus,
    })
  } catch (err) {
    console.error('[GET /api/despachados]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
