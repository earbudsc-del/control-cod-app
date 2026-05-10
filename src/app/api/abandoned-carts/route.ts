import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'
import type { CartRecoveryStatus } from '@/types'

const ALLOWED_ROLES = ['admin', 'ia_supervisor', 'confirmation_agent'] as const

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
    if (!ALLOWED_ROLES.includes(profile?.role as never)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const status   = searchParams.get('status')   as CartRecoveryStatus | null
    const q        = searchParams.get('q')?.trim().toLowerCase()
    const from     = searchParams.get('from')
    const to       = searchParams.get('to')
    const page     = Math.max(1, parseInt(searchParams.get('page') ?? '1'))
    const pageSize = 50

    let query = supabase
      .from('abandoned_carts')
      .select('*', { count: 'exact' })
      .order('abandoned_at', { ascending: false, nullsFirst: false })

    if (status) query = query.eq('recovery_status', status)
    if (from)   query = query.gte('abandoned_at', from)
    if (to)     query = query.lte('abandoned_at', to)

    // Búsqueda de texto (server-side sobre los campos principales)
    if (q) {
      query = query.or(
        `customer_name.ilike.%${q}%,customer_phone.ilike.%${q}%,customer_email.ilike.%${q}%,products_summary.ilike.%${q}%,city.ilike.%${q}%,province.ilike.%${q}%`
      )
    }

    const { data, count, error } = await query.range((page - 1) * pageSize, page * pageSize - 1)
    if (error) throw error

    // Stats para las métricas del dashboard
    const now     = new Date()
    const todayRD = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santo_Domingo' }))
    todayRD.setHours(0, 0, 0, 0)
    // Medianoche RD = 04:00 UTC
    const todayUTC = new Date(Date.UTC(todayRD.getFullYear(), todayRD.getMonth(), todayRD.getDate(), 4, 0, 0, 0))

    const base = () => supabase.from('abandoned_carts').select('id', { count: 'exact', head: true })

    const [pendingRes, todayRes, contactedTodayRes, recoveredRes] = await Promise.all([
      base().eq('recovery_status', 'pending'),
      base().gte('abandoned_at', todayUTC.toISOString()),
      base().eq('recovery_status', 'contacted').gte('last_contacted_at', todayUTC.toISOString()),
      base().eq('recovery_status', 'recovered'),
    ])

    return NextResponse.json({
      data:  data ?? [],
      total: count ?? 0,
      stats: {
        pending:        pendingRes.count   ?? 0,
        today:          todayRes.count     ?? 0,
        contactedToday: contactedTodayRes.count ?? 0,
        recovered:      recoveredRes.count ?? 0,
      },
    })
  } catch (err) {
    console.error('[GET /api/abandoned-carts]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
