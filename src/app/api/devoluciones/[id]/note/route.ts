import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

const ALLOWED_ROLES = ['admin', 'ia_supervisor', 'novelty_agent']

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles').select('role, full_name').eq('id', user.id).single()
  const role = profile?.role ?? 'agent'
  if (!ALLOWED_ROLES.includes(role)) return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const { note } = body as { note?: string }

  if (!note || !note.trim()) {
    return NextResponse.json({ error: 'Nota requerida' }, { status: 400 })
  }

  const agentName = profile?.full_name ?? 'Agente'
  const timestamp = new Intl.DateTimeFormat('es-DO', {
    timeZone: 'America/Santo_Domingo',
    dateStyle: 'short', timeStyle: 'short',
  }).format(new Date())

  const { error } = await supabase.from('notes').insert({
    order_id: id,
    content: `[${timestamp} — ${agentName}] ${note.trim()}`,
    created_by: user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
