import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getBroadcastAdminContext } from '@/lib/broadcast/admin-context'
import { parseBroadcastSelection } from '@/lib/broadcast/selection'
import {
  BroadcastSelectionTooBroadError,
  createBroadcastDraft,
  listBroadcasts,
} from '@/lib/broadcast/broadcast-service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/admin/broadcasts — crea un broadcast en estado DRAFT.
 *
 * Body: { selection, request_key }  (misma selection que /preview;
 *        request_key = UUID por apertura del modal, obligatoria)
 *
 * Recalcula candidatos/elegibilidad/conteos en el servidor (ignora cualquier
 * conteo del browser) e inserta UNA fila en wa_broadcasts. NO inserta nada
 * en wa_template_queue. Idempotente por (store_id, request_key) con UNIQUE en
 * DB (065): requests repetidas/concurrentes devuelven el mismo draft.
 */
export async function POST(request: Request) {
  try {
    const auth = await getBroadcastAdminContext(await createClient())
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

    const body = await request.json().catch(() => null)
    const parsed = parseBroadcastSelection(body?.selection)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const requestKey = typeof body?.request_key === 'string' && UUID_RE.test(body.request_key) ? body.request_key.toLowerCase() : null
    if (!requestKey) return NextResponse.json({ error: 'request_key (UUID) requerido' }, { status: 400 })

    const result = await createBroadcastDraft(await createServiceClient(), auth.ctx, parsed.selection, requestKey)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ broadcast: result.broadcast, replay: result.replay }, { status: result.replay ? 200 : 201 })
  } catch (err) {
    if (err instanceof BroadcastSelectionTooBroadError) {
      return NextResponse.json({ error: 'Selección demasiado amplia — aplica un filtro de estado o fecha' }, { status: 422 })
    }
    console.error('[POST /api/admin/broadcasts]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

/** GET /api/admin/broadcasts — historial de la tienda del admin (más recientes primero). */
export async function GET() {
  try {
    const auth = await getBroadcastAdminContext(await createClient())
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

    const data = await listBroadcasts(await createServiceClient(), auth.ctx.storeId)
    return NextResponse.json({ data })
  } catch (err) {
    console.error('[GET /api/admin/broadcasts]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
