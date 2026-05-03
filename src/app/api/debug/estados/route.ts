import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const [rawRes, normRes, unknownRes] = await Promise.all([
      // Frecuencia de raw_status originales
      supabase.from('orders').select('raw_status').not('raw_status', 'is', null),
      // Conteo por normalized_status
      supabase.from('orders').select('normalized_status'),
      // Pedidos con normalized_status = 'unknown' (primeros 50)
      supabase.from('orders')
        .select('id, tracking_number, raw_status, normalized_status, created_at')
        .eq('normalized_status', 'unknown')
        .order('created_at', { ascending: false })
        .limit(50),
    ])

    // Agrupar raw_status
    const rawCounts: Record<string, number> = {}
    for (const r of rawRes.data ?? []) {
      const key = (r.raw_status as string).trim()
      rawCounts[key] = (rawCounts[key] ?? 0) + 1
    }
    const rawSorted = Object.entries(rawCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({ status, count }))

    // Agrupar normalized_status
    const normCounts: Record<string, number> = {}
    for (const r of normRes.data ?? []) {
      const key = r.normalized_status as string
      normCounts[key] = (normCounts[key] ?? 0) + 1
    }
    const normSorted = Object.entries(normCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({ status, count }))

    return NextResponse.json({
      raw_status_counts:        rawSorted,
      normalized_status_counts: normSorted,
      unknown_orders:           unknownRes.data ?? [],
      total_orders:             (normRes.data ?? []).length,
      total_unknown:            normCounts['unknown'] ?? 0,
    })
  } catch (err) {
    console.error('[GET /api/debug/estados]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
