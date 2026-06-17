import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'

const DEFAULT_LIMIT = 50
const MAX_LIMIT     = 100

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { id } = await params

    // Verificar ownership antes de listar mensajes.
    // RLS ya filtra store_id en wa_conversations — null significa no existe o no pertenece.
    const { data: conv, error: convErr } = await supabase
      .from('wa_conversations')
      .select('id')
      .eq('id', id)
      .maybeSingle()

    if (convErr) throw convErr
    if (!conv) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

    const { searchParams } = new URL(request.url)

    // Polling fallback (FASE 6A.6): trae solo mensajes posteriores a `after`,
    // sin paginar — el volumen esperado por tick es 0-2 mensajes.
    const after = searchParams.get('after')
    if (after) {
      const { data: afterData, error: afterError } = await supabase
        .from('wa_messages')
        .select('id, direction, message_type, body, status, sent_at, delivered_at, read_at, sent_by, wa_msg_id')
        .eq('conversation_id', id)
        .gt('sent_at', after)
        .order('sent_at', { ascending: true, nullsFirst: false })

      if (afterError) throw afterError
      return NextResponse.json({ data: afterData, pagination: null })
    }

    const page  = Math.max(1, parseInt(searchParams.get('page')  ?? '1'))
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT))))
    const from  = (page - 1) * limit
    const to    = from + limit - 1

    const { data, error, count } = await supabase
      .from('wa_messages')
      .select(
        'id, direction, message_type, body, status, sent_at, delivered_at, read_at, sent_by, wa_msg_id',
        { count: 'exact' },
      )
      .eq('conversation_id', id)
      .order('sent_at', { ascending: true, nullsFirst: false })
      .range(from, to)

    if (error) throw error

    return NextResponse.json({
      data,
      pagination: {
        page,
        limit,
        total: count ?? 0,
        pages: Math.ceil((count ?? 0) / limit),
      },
    })
  } catch (err) {
    console.error('[GET /api/whatsapp/conversations/[id]/messages]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { id } = await params

    const body = await request.json() as { text?: unknown }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return NextResponse.json({ error: 'El campo text es requerido' }, { status: 422 })

    const { data: conv, error: convErr } = await supabase
      .from('wa_conversations')
      .select('id, store_id, contact:wa_contacts(wa_id)')
      .eq('id', id)
      .maybeSingle()

    if (convErr) throw convErr
    if (!conv) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
    type ConversationWithContact = {
      id: string
      store_id: string
      contact: { wa_id: string | null } | { wa_id: string | null }[] | null
    }
    const typedConv = conv as ConversationWithContact
    const waId = Array.isArray(typedConv.contact)
      ? typedConv.contact[0]?.wa_id
      : typedConv.contact?.wa_id
    if (!waId) return NextResponse.json({ error: 'El contacto no tiene wa_id' }, { status: 422 })

    const WA_API_VERSION    = process.env.WA_API_VERSION!
    const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID!
    const WA_ACCESS_TOKEN   = process.env.WA_ACCESS_TOKEN!

    const metaRes = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: waId,
          type: 'text',
          text: { body: text },
        }),
      },
    )

    if (!metaRes.ok) {
      const metaErr = await metaRes.text()
      console.error('[POST /api/whatsapp/conversations/[id]/messages] Meta error', metaRes.status, metaErr)
      return NextResponse.json({ error: 'Error al enviar mensaje via Meta', detail: metaErr }, { status: 502 })
    }

    const metaData = await metaRes.json() as { messages?: { id: string }[] }
    const wamid = metaData.messages?.[0]?.id
    if (!wamid) {
      console.error('[POST /api/whatsapp/conversations/[id]/messages] Meta OK sin wamid', metaData)
      return NextResponse.json({ error: 'Meta respondió OK pero no devolvió el ID del mensaje' }, { status: 502 })
    }

    const now = new Date().toISOString()

    const { data: inserted, error: insertErr } = await supabase
      .from('wa_messages')
      .insert({
        store_id:        conv.store_id,
        conversation_id: id,
        wa_msg_id:       wamid,
        direction:       'outbound',
        message_type:    'text',
        body:            text,
        status:          'sent',
        sent_at:         now,
        sent_by:         user.id,
      })
      .select()
      .single()

    if (insertErr) throw insertErr

    await supabase
      .from('wa_conversations')
      .update({
        last_message_at:      now,
        last_message_preview: text.slice(0, 100),
      })
      .eq('id', id)

    return NextResponse.json({ data: inserted }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/whatsapp/conversations/[id]/messages]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
