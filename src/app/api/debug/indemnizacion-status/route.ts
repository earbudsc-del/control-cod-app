import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'

// GET /api/debug/indemnizacion-status
// Solo admin. Solo lectura.
//
// Diagnóstico del estado de indemnización en DB:
// - total_indemnizacion: órdenes con normalized_status='indemnizacion'
// - total_mismatched: órdenes con normalized_status='novedad' y raw_status ILIKE '%indemniz%'
//                    (candidatas a corrección por fix-indemnizacion-status)
// - sample: muestra de las desincronizadas

const ALLOWED_ROLES = ['admin']

export async function GET() {
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

    const [indemnizacionRes, mismatchedRes] = await Promise.all([
      // Total de órdenes ya correctamente clasificadas como indemnizacion
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'indemnizacion'),

      // Órdenes en novedad cuyo raw_status indica indemnización (deben migrarse)
      supabase
        .from('orders')
        .select('id, tracking_number, order_number, customer_name, raw_status, last_tracking_update, created_at')
        .eq('normalized_status', 'novedad')
        .ilike('raw_status', '%indemniz%')
        .order('last_tracking_update', { ascending: true, nullsFirst: true })
        .limit(50),
    ])

    return NextResponse.json({
      generatedAt:         new Date().toISOString(),
      total_indemnizacion: indemnizacionRes.count ?? 0,
      total_mismatched:    mismatchedRes.data?.length ?? 0,
      sample:              (mismatchedRes.data ?? []).map(o => ({
        tracking_number:      o.tracking_number,
        order_number:         o.order_number,
        customer_name:        o.customer_name,
        raw_status:           o.raw_status,
        last_tracking_update: o.last_tracking_update,
        created_at:           o.created_at,
      })),
      note: 'total_mismatched > 0 significa que hay órdenes en novedad con raw_status de indemnización — ejecutar POST /api/admin/fix-indemnizacion-status para corregirlas.',
    })
  } catch (err) {
    console.error('[GET /api/debug/indemnizacion-status]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
