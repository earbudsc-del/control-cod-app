import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'
import { getInboxAccess } from '@/lib/whatsapp/inbox-access'
import { attentionFlags, InboxQueryTooBroadError, queryInbox } from '@/lib/whatsapp/conversation-search'

/**
 * GET /api/whatsapp/conversations — búsqueda global + filtro + paginación por cursor.
 *
 * Params: q (nombre / teléfono / # pedido), filter (all | unread | attention |
 * broadcast | unassigned | mine), cursor (opaco, de next_cursor), limit (≤100),
 * counts=1 (incluye los contadores de todos los filtros reutilizando las mismas
 * consultas: una petición en vez de dos). total = total real, no lo cargado.
 * Sesión del agente (RLS) + store_id explícito del perfil.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const access = await getInboxAccess(supabase)
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status })

    const sp = new URL(request.url).searchParams
    const page = await queryInbox(supabase, access.ctx, {
      q: sp.get('q'), filter: sp.get('filter'), cursor: sp.get('cursor'), limit: sp.get('limit'),
      withCounts: sp.get('counts') === '1',
    })

    // Respuestas de campaña sin atender / escalamientos abiertos de esta página.
    const flags = await attentionFlags(supabase, access.ctx.storeId, page.data.map(c => c.id)).catch(() => new Map())
    const data = page.data.map(c => ({
      ...c,
      broadcast_attention: flags.get(c.id)?.broadcast ?? 0,
      escalation_open:     flags.get(c.id)?.escalated ?? false,
    }))

    return NextResponse.json({ data, next_cursor: page.next_cursor, total: page.total, ...(page.counts ? { counts: page.counts } : {}) })
  } catch (err) {
    if (err instanceof InboxQueryTooBroadError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    console.error('[GET /api/whatsapp/conversations]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
