import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Santo Domingo is UTC-4 (no DST).
// Midnight RD = 04:00 UTC.
function rdDayBounds(daysAgo = 0): { start: string; end: string } {
  const now = new Date()
  const dateStrRD = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  const [y, m, d] = dateStrRD.split('-').map(Number)
  const startUTC = new Date(Date.UTC(y, m - 1, d - daysAgo, 4, 0, 0, 0))
  const endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { start: startUTC.toISOString(), end: endUTC.toISOString() }
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const filter = searchParams.get('filter') // 'hoy' | 'ayer'
    const from   = searchParams.get('from')
    const to     = searchParams.get('to')

    const hoy  = rdDayBounds(0)
    const ayer = rdDayBounds(1)

    const [statsHoyRes, statsAyerRes] = await Promise.all([
      supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'confirmed')
        .gte('last_confirmation_attempt', hoy.start)
        .lte('last_confirmation_attempt', hoy.end),
      supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'confirmed')
        .gte('last_confirmation_attempt', ayer.start)
        .lte('last_confirmation_attempt', ayer.end),
    ])

    let query = supabase
      .from('orders')
      .select('id, order_number, customer_name, customer_phone, customer_address, city, product_summary, cod_amount, confirmation_method, last_confirmation_attempt, created_at, duplicate_alert, duplicate_of_order_id, duplicate_reason')
      .eq('confirmation_status', 'confirmed')
      .order('last_confirmation_attempt', { ascending: false, nullsFirst: false })
      .limit(200)

    if (filter === 'hoy') {
      query = query.gte('last_confirmation_attempt', hoy.start).lte('last_confirmation_attempt', hoy.end)
    } else if (filter === 'ayer') {
      query = query.gte('last_confirmation_attempt', ayer.start).lte('last_confirmation_attempt', ayer.end)
    } else if (from && to) {
      query = query.gte('last_confirmation_attempt', from).lte('last_confirmation_attempt', to)
    }

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({
      data:  data ?? [],
      stats: {
        confirmados_hoy:  statsHoyRes.count  ?? 0,
        confirmados_ayer: statsAyerRes.count ?? 0,
      },
    })
  } catch (err) {
    console.error('[GET /api/confirmados]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
