import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getBroadcastAdminContext } from '@/lib/broadcast/admin-context'
import { resumeBroadcast } from '@/lib/broadcast/launch'
import { isWaBroadcastEnabled } from '@/lib/config/wa-broadcast'

/**
 * PATCH /api/admin/broadcasts/[id]/resume — reanuda una campaña pausada.
 * Body: { acknowledge_real_messages: true }
 * Requiere WA_BROADCAST_ENABLED='true' y confirmación explícita.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getBroadcastAdminContext(await createClient())
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const body = await request.json().catch(() => null) as { acknowledge_real_messages?: unknown } | null
    if (body?.acknowledge_real_messages !== true) {
      return NextResponse.json({ error: 'Debes confirmar que se reanudarán envíos reales' }, { status: 400 })
    }
    const { id } = await params
    const r = await resumeBroadcast(await createServiceClient(), auth.ctx, id, isWaBroadcastEnabled())
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    console.log(`[broadcast] resume broadcast=${id} by=${auth.ctx.userId}`)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[PATCH /api/admin/broadcasts/[id]/resume]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
