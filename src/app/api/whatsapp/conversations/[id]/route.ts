import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { id } = await params

    const { data, error } = await supabase
      .from('wa_conversations')
      .select(
        `id, status, unread_count, last_message_at, last_message_preview,
         assigned_to, created_at, updated_at,
         contact:wa_contacts(id, phone_normalized, display_name, wa_id, order_id, last_seen_at)`,
      )
      .eq('id', id)
      .maybeSingle()

    if (error) throw error

    // RLS bloquea convs de otras tiendas — null == no existe o no pertenece.
    // 404 uniforme para no revelar existencia de recursos ajenos.
    if (!data) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

    return NextResponse.json({ data })
  } catch (err) {
    console.error('[GET /api/whatsapp/conversations/[id]]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
