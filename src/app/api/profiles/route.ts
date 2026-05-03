import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, role')
      .order('full_name')

    if (error) throw error
    return NextResponse.json(data)
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
