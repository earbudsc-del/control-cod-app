import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'
import { getInboxAccess } from '@/lib/whatsapp/inbox-access'
import { countConversations, InboxQueryTooBroadError } from '@/lib/whatsapp/conversation-search'

/** GET /api/whatsapp/conversations/counts?q= — total real por filtro para la búsqueda actual. */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const access = await getInboxAccess(supabase)
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status })
    const counts = await countConversations(supabase, access.ctx, new URL(request.url).searchParams.get('q'))
    return NextResponse.json({ counts })
  } catch (err) {
    if (err instanceof InboxQueryTooBroadError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    console.error('[GET /api/whatsapp/conversations/counts]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
