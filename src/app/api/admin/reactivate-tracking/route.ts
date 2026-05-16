import { NextResponse }        from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { updateOrderTracking } from '@/lib/tracking/update-order'

// POST /api/admin/reactivate-tracking
// Solo admin.
//
// Re-sincroniza órdenes que están en estado final (returned/delivered/cancelled)
// pero podrían haber sido clasificadas incorrectamente por el parser EFI.
//
// El cron NUNCA re-procesa estados finales. Este endpoint permite al admin
// forzar una re-sincronización individual o en batch para corregir errores.
//
// Body (JSON):
//   { order_ids?: string[] }   → IDs específicos a reactivar
//   {}                         → Busca automáticamente los sospechosos (returned
//                                con raw_status activo en los últimos 7 días)
//
// Responde con:
//   { processed, reactivated, failed, results[] }

const ALLOWED_ROLES = ['admin']

// raw_status patterns que NO deberían estar en órdenes finales
const ACTIVE_RAW_PATTERNS = [
  'reparto', 'en ruta', 'mensajero', 'despacho', 'en camino', 'en entrega',
  'para entrega', 'a entregar', 'novedad', 'ausente',
  'en transito', 'transito', 'bodega', 'recibido', 'generada', 'en proceso',
  'intento', 'distribucion',
]

function hasActiveRaw(rawStatus: string | null): boolean {
  if (!rawStatus) return false
  const r = rawStatus.toLowerCase()
  return ACTIVE_RAW_PATTERNS.some(p => r.includes(p))
}

export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!ALLOWED_ROLES.includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
    }

    let body: { order_ids?: string[] } = {}
    try { body = await req.json() } catch { /* body vacío */ }

    const service = await createServiceClient()
    const d7ago   = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    let ordersToProcess: Array<{ id: string; tracking_number: string; normalized_status: string; raw_status: string | null }> = []

    if (body.order_ids?.length) {
      // Modo manual: IDs específicos
      const { data } = await service
        .from('orders')
        .select('id, tracking_number, normalized_status, raw_status')
        .in('id', body.order_ids)
        .not('tracking_number', 'is', null)

      ordersToProcess = (data ?? []) as typeof ordersToProcess
    } else {
      // Modo automático: returned con raw_status sospechoso (últimos 7 días)
      const { data } = await service
        .from('orders')
        .select('id, tracking_number, normalized_status, raw_status')
        .in('normalized_status', ['returned', 'cancelled'])
        .not('tracking_number', 'is', null)
        .gte('last_tracking_update', d7ago)
        .order('last_tracking_update', { ascending: false })
        .limit(50)

      ordersToProcess = ((data ?? []) as typeof ordersToProcess)
        .filter(o => hasActiveRaw(o.raw_status))
    }

    if (ordersToProcess.length === 0) {
      return NextResponse.json({
        processed:   0,
        reactivated: 0,
        failed:      0,
        results:     [],
        note:        'No se encontraron órdenes sospechosas para reactivar.',
      })
    }

    console.log(`[reactivate-tracking] procesando ${ordersToProcess.length} órdenes`)

    const results: Array<{
      id:              string
      tracking_number: string
      old_status:      string
      new_status:      string | null
      success:         boolean
      error?:          string
      skipped?:        boolean
    }> = []

    for (const order of ordersToProcess) {
      // Para órdenes en final status, pasamos null como currentNormalizedStatus
      // para desactivar el guard y permitir que EFI sobreescriba el estado actual.
      const result = await updateOrderTracking(
        order.id,
        order.tracking_number,
        service,
        undefined,  // sin guard — queremos que EFI sobreescriba el estado final
      )

      results.push({
        id:              order.id,
        tracking_number: order.tracking_number,
        old_status:      order.normalized_status,
        new_status:      result.normalized_status ?? null,
        success:         result.success,
        ...(result.error  && { error:   result.error }),
        ...(result.skipped && { skipped: result.skipped }),
      })
    }

    const reactivated = results.filter(r => r.success && r.new_status !== r.old_status).length
    const failed      = results.filter(r => !r.success).length

    console.log(`[reactivate-tracking] processed=${ordersToProcess.length} reactivated=${reactivated} failed=${failed}`)

    return NextResponse.json({
      processed:   ordersToProcess.length,
      reactivated,
      failed,
      results,
    })

  } catch (err) {
    console.error('[POST /api/admin/reactivate-tracking]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
