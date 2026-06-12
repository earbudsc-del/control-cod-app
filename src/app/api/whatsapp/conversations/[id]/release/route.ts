import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile) return NextResponse.json({ error: 'Perfil no encontrado' }, { status: 403 })
    if (profile.role === 'viewer') return NextResponse.json({ error: 'Sin acceso al inbox' }, { status: 403 })

    const { id } = await params

    const { data, error } = await supabase
      .from('wa_conversations')
      .update({ assigned_to: null, ai_enabled: true })
      .eq('id', id)
      .eq('assigned_to', user.id)
      .select(
        `id, status, unread_count, last_message_at, last_message_preview,
         assigned_to, ai_enabled, created_at, updated_at,
         contact:wa_contacts(id, phone_normalized, display_name, wa_id, order_id, last_seen_at)`,
      )
      .maybeSingle()

    if (error) throw error
    if (!data) return NextResponse.json({ error: 'No encontrado o no asignada a ti' }, { status: 404 })

    return NextResponse.json({ data })
  } catch (err) {
    console.error('[PATCH /api/whatsapp/conversations/[id]/release]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
