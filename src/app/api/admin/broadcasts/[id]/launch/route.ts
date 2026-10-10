import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getBroadcastAdminContext } from '@/lib/broadcast/admin-context'
import { launchBroadcast } from '@/lib/broadcast/launch'
import { isWaBroadcastEnabled } from '@/lib/config/wa-broadcast'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/admin/broadcasts/[id]/launch — encola la campaña (draft → queued).
 *
 * Body: { launch_request_key: UUID, send_limit: number, confirm_count: number, acknowledge_real_messages: true }
 *
 * - Requiere WA_BROADCAST_ENABLED='true' (403 si no).
 * - Revalida la audiencia en el servidor; confirm_count debe coincidir con
 *   el lote recalculado (si cambió: 409 + current_count).
 * - Idempotente por launch_request_key. No envía nada por sí mismo: el
 *   envío lo hace el processor (/api/cron/wa-broadcast-queue).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getBroadcastAdminContext(await createClient())
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { id } = await params

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const key = typeof body?.launch_request_key === 'string' && UUID_RE.test(body.launch_request_key) ? body.launch_request_key.toLowerCase() : null
    const sendLimit = typeof body?.send_limit === 'number' && Number.isInteger(body.send_limit) && body.send_limit > 0 ? body.send_limit : null
    const confirmCount = typeof body?.confirm_count === 'number' && Number.isInteger(body.confirm_count) ? body.confirm_count : null
    if (!key) return NextResponse.json({ error: 'launch_request_key (UUID) requerido' }, { status: 400 })
    if (!sendLimit) return NextResponse.json({ error: 'send_limit (entero > 0) requerido' }, { status: 400 })
    if (confirmCount === null) return NextResponse.json({ error: 'confirm_count requerido' }, { status: 400 })
    if (body?.acknowledge_real_messages !== true) {
      return NextResponse.json({ error: 'Debes confirmar que se enviarán mensajes reales' }, { status: 400 })
    }

    const r = await launchBroadcast(await createServiceClient(), auth.ctx,
      { broadcastId: id, launchRequestKey: key, sendLimit, confirmCount }, isWaBroadcastEnabled())
    if (!r.ok) return NextResponse.json({ error: r.error, current_count: r.current_count }, { status: r.status })
    console.log(`[broadcast] launch broadcast=${r.broadcast_id} queued=${r.queued} replay=${r.replay} by=${auth.ctx.userId}`)
    return NextResponse.json(r, { status: r.replay ? 200 : 201 })
  } catch (err) {
    console.error('[POST /api/admin/broadcasts/[id]/launch]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
