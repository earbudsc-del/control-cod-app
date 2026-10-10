import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getBroadcastAdminContext } from '@/lib/broadcast/admin-context'
import { pauseBroadcast } from '@/lib/broadcast/launch'

/**
 * PATCH /api/admin/broadcasts/[id]/pause — detiene los envíos PENDIENTES.
 * Siempre permitido (también con el flag apagado). No retira mensajes ya
 * aceptados por Meta: solo impide que el processor tome más destinatarios.
 */
export async function PATCH(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getBroadcastAdminContext(await createClient())
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { id } = await params
    const r = await pauseBroadcast(await createServiceClient(), auth.ctx, id)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    console.log(`[broadcast] pause broadcast=${id} by=${auth.ctx.userId}`)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[PATCH /api/admin/broadcasts/[id]/pause]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
