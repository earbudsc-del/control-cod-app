import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: order_id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { content } = await request.json()
    if (!content?.trim()) {
      return NextResponse.json({ error: 'La nota no puede estar vacía' }, { status: 400 })
    }

    const { data: profile } = await supabase
      .from('profiles').select('id').eq('id', user.id).single()

    const [noteRes] = await Promise.all([
      supabase.from('notes')
        .insert({ order_id, created_by: profile?.id, content: content.trim() })
        .select('*, profile:profiles!created_by(full_name)')
        .single(),
      // Registrar también en agent_actions para métricas
      supabase.from('agent_actions').insert({
        order_id,
        agent_id: profile?.id,
        action_type: 'note_added',
        notes: content.trim(),
      }),
    ])

    if (noteRes.error) throw noteRes.error
    return NextResponse.json(noteRes.data, { status: 201 })
  } catch (err) {
    console.error('[POST /api/orders/[id]/notes]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
