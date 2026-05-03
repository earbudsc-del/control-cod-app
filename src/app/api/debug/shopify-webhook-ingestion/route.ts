import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse }         from 'next/server'

// Calcula el inicio del día en zona RD (UTC-4, sin DST).
// Medianoche RD = 04:00 UTC del mismo día calendario.
function rdTodayStartUTC(): string {
  const rd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  }).format(new Date())
  const [y, m, d] = rd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 4, 0, 0, 0)).toISOString()
}

export async function GET() {
  try {
    // Requiere sesión activa — solo admins deberían usar este endpoint
    const authSupabase = await createClient()
    const { data: { user } } = await authSupabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const service    = await createServiceClient()
    const todayStart = rdTodayStartUTC()
    const generatedAt = new Date().toISOString()

    const [totalHoyRes, last30Res, byStatusRes, byConfirmedRes] = await Promise.all([

      // 1. Total pedidos webhook hoy
      service
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .gte('created_at', todayStart),

      // 2. Últimos 30 pedidos webhook (sin importar fecha)
      service
        .from('orders')
        .select('id, order_number, shopify_order_id, customer_name, customer_phone, created_at, shopify_created_at, confirmation_status, customer_confirmed, normalized_status')
        .eq('source', 'shopify_webhook')
        .order('created_at', { ascending: false })
        .limit(30),

      // 3. Distribución por confirmation_status (hoy)
      service
        .from('orders')
        .select('confirmation_status')
        .eq('source', 'shopify_webhook')
        .gte('created_at', todayStart),

      // 4. Distribución por customer_confirmed (hoy)
      service
        .from('orders')
        .select('customer_confirmed')
        .eq('source', 'shopify_webhook')
        .gte('created_at', todayStart),
    ])

    // Agrupar confirmation_status
    const byStatus: Record<string, number> = {}
    for (const r of byStatusRes.data ?? []) {
      const k = r.confirmation_status === null ? 'NULL' : String(r.confirmation_status)
      byStatus[k] = (byStatus[k] ?? 0) + 1
    }

    // Agrupar customer_confirmed
    const byConfirmed: Record<string, number> = { 'true': 0, 'false': 0, 'NULL': 0 }
    for (const r of byConfirmedRes.data ?? []) {
      const k = r.customer_confirmed === null ? 'NULL' : String(r.customer_confirmed)
      byConfirmed[k] = (byConfirmed[k] ?? 0) + 1
    }

    // Contar cuántos de los últimos 30 serían visibles en /confirmacion
    // (source='shopify_webhook', confirmation_status='pending', normalized_status != delivered/returned)
    const visibles = (last30Res.data ?? []).filter(
      o =>
        o.confirmation_status === 'pending' &&
        o.normalized_status !== 'delivered' &&
        o.normalized_status !== 'returned',
    ).length

    return NextResponse.json({
      _meta: {
        generated_at:    generatedAt,
        today_start_utc: todayStart,
        timezone:        'America/Santo_Domingo (UTC-4, sin DST)',
      },
      total_hoy:                  totalHoyRes.count ?? 0,
      por_confirmation_status_hoy: byStatus,
      por_customer_confirmed_hoy:  byConfirmed,
      ultimos_30_visibles_en_confirmacion: visibles,
      ultimos_30: last30Res.data ?? [],
      internal_error_log: 'Sin tabla de logs — revisar salida de consola del servidor (console.warn/error con prefijo [shopify-webhook])',
    })
  } catch (err) {
    console.error('[GET /api/debug/shopify-webhook-ingestion]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
