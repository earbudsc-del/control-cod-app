import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// GET — lista las secciones de conocimiento/reglas de la tienda del admin,
// ordenadas por prioridad descendente.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles').select('role, store_id').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
  if (!profile.store_id) return NextResponse.json({ error: 'Sin tienda asignada' }, { status: 400 })

  const { data, error } = await supabase
    .from('ai_agent_knowledge_sections')
    .select('*')
    .eq('store_id', profile.store_id)
    .order('priority', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json(data ?? [])
}

// POST — crea una nueva sección de conocimiento/regla operativa.
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles').select('role, store_id').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
  if (!profile.store_id) return NextResponse.json({ error: 'Sin tienda asignada' }, { status: 400 })

  const body = await request.json()
  const sectionKey = String(body.section_key ?? '').trim()
  const label       = String(body.label ?? '').trim()

  if (!sectionKey || !label) {
    return NextResponse.json({ error: 'section_key y label son obligatorios' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('ai_agent_knowledge_sections')
    .insert({
      store_id:    profile.store_id,
      section_key: sectionKey,
      label,
      content:     body.content ? String(body.content) : null,
      priority:    Number.isFinite(body.priority) ? Number(body.priority) : 0,
      is_active:   body.is_active === undefined ? true : Boolean(body.is_active),
    })
    .select('*')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Ya existe una sección con esa clave' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json(data, { status: 201 })
}
