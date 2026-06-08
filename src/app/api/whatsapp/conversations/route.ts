import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'

const DEFAULT_LIMIT = 30
const MAX_LIMIT     = 100

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const page   = Math.max(1, parseInt(searchParams.get('page')  ?? '1'))
    const limit  = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT))))
    const status = searchParams.get('status')
    const from   = (page - 1) * limit
    const to     = from + limit - 1

    let query = supabase
      .from('wa_conversations')
      .select(
        `id, status, unread_count, last_message_at, last_message_preview,
         assigned_to, created_at, updated_at,
         contact:wa_contacts(id, phone_normalized, display_name, wa_id, order_id)`,
        { count: 'exact' },
      )
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .range(from, to)

    if (status && ['open', 'pending', 'closed'].includes(status)) {
      query = query.eq('status', status)
    }

    const { data, error, count } = await query
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
    console.error('[GET /api/whatsapp/conversations]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
