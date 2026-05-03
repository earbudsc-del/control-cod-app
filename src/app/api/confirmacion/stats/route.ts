import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Filtros base que debe cumplir un pedido para estar en la cola activa de confirmación.
// Deben coincidir exactamente con los de GET /api/confirmacion.
const ACTIVE_PENDING = {
  source:              'shopify_webhook',
  confirmation_status: 'pending',
  // normalized_status NOT IN ('delivered', 'returned') → se aplica con .neq() en cada query
} as const

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayIso  = todayStart.toISOString()
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

    // Shorthand para el bloque de filtros comunes a la cola pendiente activa
    const pendingBase = () =>
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source',              ACTIVE_PENDING.source)
        .eq('confirmation_status', ACTIVE_PENDING.confirmation_status)
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')

    const [
      { count: nuevos },
      { count: reintentar },
      { count: atrasados },
      { count: confirmadosHoy },
      { count: contactadosHoy },
      { count: inalcanzables },
      { count: noDesean },
    ] = await Promise.all([

      // Nunca contactados — mismos filtros que la tabla visible
      pendingBase().or('confirmation_attempts.is.null,confirmation_attempts.eq.0'),

      // 1–2 intentos sin éxito — mismos filtros que la tabla visible
      pendingBase().gte('confirmation_attempts', 1).lte('confirmation_attempts', 2),

      // Pendientes con más de 48 h de antigüedad — mismos filtros que la tabla visible
      pendingBase().lt('created_at', cutoff48h),

      // Confirmados hoy (métrica histórica, solo pedidos Shopify)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'confirmed')
        .gte('customer_confirmed_at', todayIso),

      // Contactados hoy (cualquier intento hoy, solo pedidos Shopify)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .gte('last_confirmation_attempt', todayIso),

      // Inalcanzables activos (solo pedidos Shopify)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'unreachable')
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned'),

      // No desean activos (solo pedidos Shopify)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'cancelled')
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned'),
    ])

    return NextResponse.json({
      nuevos:         nuevos         ?? 0,
      reintentar:     reintentar     ?? 0,
      atrasados:      atrasados      ?? 0,
      confirmadosHoy: confirmadosHoy ?? 0,
      contactadosHoy: contactadosHoy ?? 0,
      sinRespuesta:   reintentar     ?? 0,
      inalcanzables:  inalcanzables  ?? 0,
      noDesean:       noDesean       ?? 0,
    })
  } catch (err) {
    console.error('[GET /api/confirmacion/stats]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
