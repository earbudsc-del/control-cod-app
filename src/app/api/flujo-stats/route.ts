import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const [generadasRes, inTransitRes, enRepartoRes] = await Promise.all([
      supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .ilike('raw_status', 'generada'),
      supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'in_transit'),
      supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'en_reparto'),
    ])

    return NextResponse.json({
      generadas:  generadasRes.count  ?? 0,
      in_transit: inTransitRes.count  ?? 0,
      en_reparto: enRepartoRes.count  ?? 0,
    })
  } catch (err) {
    console.error('[GET /api/flujo-stats]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
