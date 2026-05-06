import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    // Admin-only
    const { data: caller } = await supabase
      .from('profiles').select('role').eq('id', user.id).single()
    if (caller?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
    }

    const service = await createServiceClient()

    const [profilesRes, authRes, actionsRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, full_name, role, created_at')
        .order('full_name'),

      // Emails + último login desde auth
      service.auth.admin.listUsers({ perPage: 1000 }),

      // Última acción por agente (500 más recientes basta para un equipo pequeño)
      supabase
        .from('agent_actions')
        .select('agent_id, created_at')
        .order('created_at', { ascending: false })
        .limit(500),
    ])

    if (profilesRes.error) throw profilesRes.error

    // Email + last_sign_in_at por user id
    const authMap: Record<string, { email: string | null; last_sign_in_at: string | null }> = {}
    for (const u of (authRes.data?.users ?? [])) {
      authMap[u.id] = {
        email:           u.email           ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
      }
    }

    // Última actividad por agente (primer registro desc = más reciente)
    const activityMap: Record<string, string> = {}
    for (const a of (actionsRes.data ?? [])) {
      if (!activityMap[a.agent_id]) activityMap[a.agent_id] = a.created_at
    }

    const enriched = (profilesRes.data ?? []).map(p => ({
      ...p,
      email:           authMap[p.id]?.email           ?? null,
      last_sign_in_at: authMap[p.id]?.last_sign_in_at ?? null,
      last_activity:   activityMap[p.id]              ?? null,
    }))

    return NextResponse.json(enriched)
  } catch (err) {
    console.error('[GET /api/profiles]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: caller } = await supabase
      .from('profiles').select('role').eq('id', user.id).single()

    if (caller?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
    }

    const { id, full_name, role } = await request.json()

    const { data, error } = await supabase
      .from('profiles')
      .update({ full_name, role })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json(data)
  } catch (err) {
    console.error('[PATCH /api/profiles]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
