import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// PATCH — edita label/content/priority/is_active de una sección.
// Solo admin, scoped a su propia tienda.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles').select('role, store_id').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
  if (!profile.store_id) return NextResponse.json({ error: 'Sin tienda asignada' }, { status: 400 })

  const { id } = await params
  const body = await request.json()
  const updates: Record<string, unknown> = {}

  if ('label' in body) {
    const label = String(body.label ?? '').trim()
    if (!label) return NextResponse.json({ error: 'label no puede estar vacío' }, { status: 400 })
    updates.label = label
  }
  if ('content' in body)   updates.content   = body.content ? String(body.content) : null
  if ('priority' in body) {
    if (!Number.isFinite(body.priority)) return NextResponse.json({ error: 'priority inválida' }, { status: 400 })
    updates.priority = Number(body.priority)
  }
  if ('is_active' in body) updates.is_active = Boolean(body.is_active)

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Sin campos para actualizar' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('ai_agent_knowledge_sections')
    .update(updates)
    .eq('id', id)
    .eq('store_id', profile.store_id)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json(data)
}
