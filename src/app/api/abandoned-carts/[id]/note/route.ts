import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'

const ALLOWED_ROLES = ['admin', 'ia_supervisor', 'confirmation_agent'] as const

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', user.id).single()
    if (!ALLOWED_ROLES.includes(profile?.role as never)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body = await request.json() as { note?: string }
    const note = body.note?.trim()
    if (!note) return NextResponse.json({ error: 'Nota vacía' }, { status: 400 })

    const { data: current } = await supabase
      .from('abandoned_carts')
      .select('notes')
      .eq('id', id)
      .single()

    const agentName = profile?.full_name ?? 'Agente'
    const timestamp = new Date().toLocaleString('es-DO', { timeZone: 'America/Santo_Domingo' })
    const newNote   = `${timestamp} — ${agentName}: ${note}`
    const combined  = current?.notes ? `${newNote}\n\n${current.notes}` : newNote

    const { error } = await supabase
      .from('abandoned_carts')
      .update({ notes: combined, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) throw error

    return NextResponse.json({ ok: true, notes: combined })
  } catch (err) {
    console.error('[POST /api/abandoned-carts/[id]/note]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
