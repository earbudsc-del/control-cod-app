import { NextResponse } from 'next/server'
import { createClient, createPrivilegedServiceClient } from '@/lib/supabase/server'
import { getBroadcastAdminContext } from '@/lib/broadcast/admin-context'
import { cancelBroadcast } from '@/lib/broadcast/cancel'

// La cancelación espera hasta CANCEL_INFLIGHT_WAIT_MS (15 s) a que terminen
// los envíos que ya estaban en vuelo con Meta.
export const maxDuration = 30

/**
 * PATCH /api/admin/broadcasts/[id]/cancel — cancela una campaña (borrador,
 * en cola, en proceso o pausada). Body: { acknowledge_cancel: true }
 *
 * Siempre permitido (también con el flag apagado): no envía nada. Conserva
 * enviados / fallidos / inciertos; libera los pendientes nunca enviados para
 * que puedan entrar en campañas futuras (con rastro en order_history).
 * Repetirla sobre una campaña ya cancelada solo libera pendientes rezagados.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getBroadcastAdminContext(await createClient())
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const body = await request.json().catch(() => null) as { acknowledge_cancel?: unknown } | null
    if (body?.acknowledge_cancel !== true) {
      return NextResponse.json({ error: 'Debes confirmar la cancelación' }, { status: 400 })
    }
    const { id } = await params
    const r = await cancelBroadcast(createPrivilegedServiceClient(), auth.ctx, id)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    console.log(`[broadcast] cancel broadcast=${id} released=${r.released} in_flight_unsettled=${r.in_flight_unsettled} already=${r.already_cancelled} by=${auth.ctx.userId}`)
    return NextResponse.json(r)
  } catch (err) {
    console.error('[PATCH /api/admin/broadcasts/[id]/cancel]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
