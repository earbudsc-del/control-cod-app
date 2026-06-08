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

    const { id } = await params

    // UPDATE + SELECT en un solo round-trip.
    // RLS filtra store_id — si la conv no existe o es de otra tienda, data === null.
    const { data, error } = await supabase
      .from('wa_conversations')
      .update({
        unread_count: 0,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, unread_count')
      .maybeSingle()

    if (error) throw error

    if (!data) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

    return NextResponse.json({
      success:         true,
      conversation_id: data.id,
      unread_count:    data.unread_count,
    })
  } catch (err) {
    console.error('[PATCH /api/whatsapp/conversations/[id]/read]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
