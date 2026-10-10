import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getBroadcastAdminContext } from '@/lib/broadcast/admin-context'
import { getBroadcastMetrics } from '@/lib/broadcast/metrics'
import { isWaBroadcastEnabled } from '@/lib/config/wa-broadcast'

/**
 * GET /api/admin/broadcasts/[id] — detalle + métricas de una campaña. READ ONLY.
 * Solo admins; aislamiento por store_id del perfil (nunca del browser).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getBroadcastAdminContext(await createClient())
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { id } = await params

    const db = await createServiceClient()
    const { data: broadcast, error } = await db.from('wa_broadcasts').select('*')
      .eq('id', id).eq('store_id', auth.ctx.storeId).maybeSingle()
    if (error) throw error
    if (!broadcast) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

    const metrics = broadcast.status === 'draft' ? null : await getBroadcastMetrics(db, auth.ctx.storeId, id)
    return NextResponse.json({ broadcast, metrics, broadcast_enabled: isWaBroadcastEnabled() })
  } catch (err) {
    console.error('[GET /api/admin/broadcasts/[id]]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
