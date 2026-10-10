import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getBroadcastAdminContext } from '@/lib/broadcast/admin-context'
import { computeLaunchPreview } from '@/lib/broadcast/launch'
import { isWaBroadcastEnabled } from '@/lib/config/wa-broadcast'

/**
 * POST /api/admin/broadcasts/[id]/launch-preview — READ ONLY.
 * Body: { send_limit?: number }
 *
 * Revalida la audiencia del borrador AHORA y devuelve exactamente el lote
 * que se encolaría (con exclusiones y motivos). No escribe nada. Permitido
 * con WA_BROADCAST_ENABLED apagado (solo lectura); el flag se informa.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getBroadcastAdminContext(await createClient())
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { id } = await params
    const body = await request.json().catch(() => ({})) as { send_limit?: unknown }
    const limit = typeof body.send_limit === 'number' && Number.isFinite(body.send_limit) ? body.send_limit : null

    const r = await computeLaunchPreview(await createServiceClient(), auth.ctx, id, limit)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ...r.preview, broadcast_enabled: isWaBroadcastEnabled() })
  } catch (err) {
    console.error('[POST /api/admin/broadcasts/[id]/launch-preview]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
