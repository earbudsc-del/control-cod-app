import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'
import { aiEnabledAfterRelease } from '@/lib/broadcast/conversation-guard'

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

    // C.1.2 — liberar una conversación de Broadcast NO la devuelve a la IA:
    // queda sin asignar pero con ai_enabled=false (atención humana). Las
    // conversaciones normales mantienen el comportamiento previo (true).
    const aiEnabled = await aiEnabledAfterRelease(supabase, id)

    const { data, error } = await supabase
      .from('wa_conversations')
      .update({ assigned_to: null, ai_enabled: aiEnabled })
      .eq('id', id)
      .eq('assigned_to', user.id)
      .select(
        `id, status, unread_count, last_message_at, last_message_preview,
         assigned_to, ai_enabled, created_at, updated_at,
         contact:wa_contacts(id, phone_normalized, display_name, wa_id, order_id, last_seen_at),
         assigned_agent:profiles(id, full_name)`,
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
