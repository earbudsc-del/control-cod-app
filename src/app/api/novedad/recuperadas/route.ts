import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// "Novedades entregadas": orders that had at least one failed delivery attempt
// (delivery_attempts > 0 OR last_attempt_reason IS NOT NULL) and are now delivered by EFI.
// This is a reliable heuristic because delivery_attempts increments from EFI's historial_novedades,
// meaning any order with attempts > 0 went through at least one novedad event.
//
// Limitation: does not guarantee the order had normalized_status='novedad' in this system —
// it could have been delivered after a failed attempt while still in en_reparto status.
// A future improvement would be to track normalized_status history in a separate table.

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    // Día RD (UTC-4, sin DST) — medianoche RD = 04:00 UTC
    const rdDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santo_Domingo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
    const [rdy, rdm, rdd] = rdDateStr.split('-').map(Number)
    const yesterdayIso = new Date(Date.UTC(rdy, rdm - 1, rdd - 1, 4, 0, 0, 0)).toISOString()

    // Orders EFI confirmed as delivered today/ayer that had at least one failed attempt
    const { data: entregadas } = await supabase
      .from('orders')
      .select('*')
      .eq('normalized_status', 'delivered')
      .or('delivery_attempts.gt.0,last_attempt_reason.not.is.null')
      .gte('last_tracking_update', yesterdayIso)
      .order('last_tracking_update', { ascending: false })

    if (!entregadas?.length) return NextResponse.json([])

    const result = entregadas.map(order => ({
      order,
      delivered_at: order.last_tracking_update as string,
      confirmed:    true,
    }))

    return NextResponse.json(result)
  } catch (err) {
    console.error('[GET /api/novedad/recuperadas]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
