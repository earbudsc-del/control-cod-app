import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getBroadcastAdminContext } from '@/lib/broadcast/admin-context'
import { parseBroadcastSelection } from '@/lib/broadcast/selection'
import { BroadcastSelectionTooBroadError, computeBroadcastAudience } from '@/lib/broadcast/broadcast-service'

/**
 * POST /api/admin/broadcasts/preview — READ ONLY.
 *
 * Body: { selection: { mode: 'selected_ids', order_ids } | { mode: 'filtered', filters } }
 *
 * Resuelve candidatos y decide elegibilidad (sd_standard_v1) en el servidor.
 * No escribe nada: ni wa_broadcasts ni wa_template_queue.
 */
export async function POST(request: Request) {
  try {
    const auth = await getBroadcastAdminContext(await createClient())
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

    const body = await request.json().catch(() => null)
    const parsed = parseBroadcastSelection(body?.selection)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    // Service client para leer wa_template_queue/orders sin depender de RLS;
    // el aislamiento por tienda lo aplica el servicio con auth.ctx.storeId.
    // Misma función que create/revalidación; resolvedAt = ahora (en filtered
    // es el cutoff created_at <= resolvedAt).
    const preview = await computeBroadcastAudience(await createServiceClient(), auth.ctx, parsed.selection, new Date().toISOString())
    return NextResponse.json(preview)
  } catch (err) {
    if (err instanceof BroadcastSelectionTooBroadError) {
      return NextResponse.json({ error: 'Selección demasiado amplia — aplica un filtro de estado o fecha' }, { status: 422 })
    }
    console.error('[POST /api/admin/broadcasts/preview]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
