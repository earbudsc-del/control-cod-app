import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Filtros base para un pedido pendiente de confirmación.
// tracking_number IS NULL es el criterio crítico: si ya tiene guía, pasó a /despachados.
const ACTIVE_PENDING = {
  source:              'shopify_webhook',
  confirmation_status: 'pending',
} as const

/**
 * Calcula el inicio del día actual en timezone America/Santo_Domingo (UTC-4, sin DST).
 * Medianoche RD = 04:00 UTC.
 */
function rdTodayStartISO(): string {
  const now    = new Date()
  const rdStr  = now.toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' })
  const [y, m, d] = rdStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 4, 0, 0, 0)).toISOString()
}

/** Calcula el inicio de un día relativo al hoy RD (negativo = pasado). */
function rdOffsetISO(days: number): string {
  const now   = new Date()
  const rdStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' })
  const [y, m, d] = rdStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days, 4, 0, 0, 0)).toISOString()
}

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    // Límites de tiempo: hoy RD y cortes de 24h, 48h y antigüedad
    const todayStartRD  = rdTodayStartISO()
    const todayIso      = new Date().setHours(0, 0, 0, 0), todayIsoStr = new Date(todayIso).toISOString()
    const cutoff24h     = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const cutoff48h     = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    const yesterdayStart = rdOffsetISO(-1)   // ayer 04:00 UTC
    const sevenDaysAgo   = rdOffsetISO(-7)   // hace 7 días 04:00 UTC
    const thirtyDaysAgo  = rdOffsetISO(-30)  // hace 30 días 04:00 UTC

    // Base idéntica a /api/confirmacion/route.ts: pending + sin tracking + normalized pending
    const pendingBase = () =>
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source',              ACTIVE_PENDING.source)
        .eq('confirmation_status', ACTIVE_PENDING.confirmation_status)
        .eq('normalized_status',   'pending')
        .is('tracking_number', null)

    // Filtro OR para pedidos de Santo Domingo / Distrito Nacional
    const sdFilter = [
      'city.ilike.%santo domingo%',
      'city.ilike.%distrito nacional%',
      'city.ilike.dn',
      'province.ilike.%santo domingo%',
      'province.ilike.%distrito nacional%',
      'province.ilike.dn',
      'customer_address.ilike.%santo domingo%',
      'customer_address.ilike.%distrito nacional%',
    ].join(',')

    const [
      { count: nuevos },
      { count: reintentar },
      { count: atrasados },
      { count: atrasados24h },
      { count: sinTocarTotal },
      { count: confirmadosHoy },
      { count: contactadosHoy },
      { count: inalcanzables },
      { count: noDesean },
      { count: sinCobertura },
      { count: pendingTotal },
      { count: confirmadosSinGuia },
      { count: despachados },
      { count: santoDomingoPendientes },
      { count: santoDomingoConfirmadosSinGuia },
      { count: santoDomingoTotal },
      { count: fueraDeCoberturaTotal },
      { count: entrantesHoy },
      { count: pendientesHoy },
      { count: sinTocarHoy },
      // Sección A — nuevas
      { count: sinRespuestaHoy },
      // Sección B — antigüedad (buckets exclusivos, rolling windows)
      { count: pendientesAyer },
      { count: pendientesSemana },
      { count: pendientesMes },
      { count: pendientesMas30d },
      // Sección C — causa
      { count: tresMasIntentosPendientes },
      { count: duplicadosPendientes },
      { count: numeroIncorrecto },
      // Pipeline nav — pago SD (migración 046)
      { count: sdPorCobrar },
      { count: entregadosSd },
    ] = await Promise.all([

      // Nuevos: pedidos de HOY (en RD) con 0 intentos de contacto — sin contacto previo
      pendingBase()
        .or('confirmation_attempts.is.null,confirmation_attempts.eq.0')
        .gte('shopify_created_at', todayStartRD),

      // 1–2 intentos sin éxito (sin importar fecha)
      pendingBase().gte('confirmation_attempts', 1).lte('confirmation_attempts', 2),

      // Atrasados críticos: más de 48h desde shopify_created_at, sin tracking, aún pending
      pendingBase().lt('shopify_created_at', cutoff48h),

      // Atrasados 24h: entre 24h y 48h (zona amarilla — riesgo)
      pendingBase().lt('shopify_created_at', cutoff24h).gte('shopify_created_at', cutoff48h),

      // Sin tocar: 0 intentos de confirmación, todas las fechas (acumulado real pendiente)
      pendingBase().or('confirmation_attempts.is.null,confirmation_attempts.eq.0'),

      // Confirmados hoy (métrica histórica, solo pedidos Shopify)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'confirmed')
        .gte('customer_confirmed_at', todayIsoStr),

      // Contactados hoy (cualquier intento hoy, solo pedidos Shopify)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .gte('last_confirmation_attempt', todayIsoStr),

      // Inalcanzables activos
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'unreachable')
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned'),

      // No desean (cancelados)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'cancelled')
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned'),

      // Sin cobertura
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'no_coverage')
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned'),

      // Total cola de confirmación (para pipeline nav)
      pendingBase(),

      // Confirmados sin guía pendientes de despacho (para pipeline nav).
      // Excluye en_reparto: pedidos SD ya despachados localmente que siguen sin tracking EFI.
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'confirmed')
        .is('tracking_number', null)
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')
        .neq('normalized_status', 'en_reparto'),

      // Despachados con guía activa (para pipeline nav)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .not('tracking_number', 'is', null)
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')
        .neq('normalized_status', 'cancelled'),

      // Santo Domingo pendientes (transporte local)
      pendingBase().or(sdFilter),

      // Santo Domingo confirmados sin guía pendientes de despacho (transporte local).
      // Excluye en_reparto: ya despachados.
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'confirmed')
        .is('tracking_number', null)
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')
        .neq('normalized_status', 'en_reparto')
        .or(sdFilter),

      // Total TODOS los pedidos de zona SD/DN (todas fechas, todos status) — para tab SD
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .or(sdFilter),

      // Total TODOS los pedidos sin cobertura (todas fechas, todos status) — para tab FCD
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'no_coverage'),

      // Entrantes hoy: todos los pedidos Shopify activos creados hoy en RD (cualquier status)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .gte('shopify_created_at', todayStartRD)
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')
        .neq('normalized_status', 'cancelled'),

      // Pendientes de hoy: creados hoy y aún en cola de confirmación
      pendingBase().gte('shopify_created_at', todayStartRD),

      // Sin tocar hoy: creados hoy con 0 intentos de confirmación
      pendingBase()
        .gte('shopify_created_at', todayStartRD)
        .or('confirmation_attempts.is.null,confirmation_attempts.eq.0'),

      // Sin respuesta hoy: creados hoy, al menos 1 intento, aún pendientes
      pendingBase()
        .gte('shopify_created_at', todayStartRD)
        .gte('confirmation_attempts', 1),

      // Pendientes de ayer (bucket exclusivo: [yesterdayStart, todayStartRD))
      pendingBase()
        .gte('shopify_created_at', yesterdayStart)
        .lt( 'shopify_created_at', todayStartRD),

      // Pendientes de esta semana (últimos 7 días, excl. ayer y hoy)
      pendingBase()
        .gte('shopify_created_at', sevenDaysAgo)
        .lt( 'shopify_created_at', yesterdayStart),

      // Pendientes de este mes (últimos 30 días, excl. últimos 7 días)
      pendingBase()
        .gte('shopify_created_at', thirtyDaysAgo)
        .lt( 'shopify_created_at', sevenDaysAgo),

      // Más de 30 días en cola
      pendingBase().lt('shopify_created_at', thirtyDaysAgo),

      // 3+ intentos sin confirmar
      pendingBase().gte('confirmation_attempts', 3),

      // Duplicados en cola
      pendingBase().eq('duplicate_alert', true),

      // Número incorrecto (no terminales)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'wrong_number')
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned'),

      // SD · Por cobrar (para pipeline nav + tab de /confirmados)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .is('tracking_number', null)
        .in('normalized_status', ['en_reparto', 'delivered'])
        .eq('payment_status', 'pending')
        .is('archived_at', null)
        .eq('is_test', false)
        .or(sdFilter),

      // Entregados SD (pagados) — para pipeline nav + tab de /confirmados
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .is('tracking_number', null)
        .eq('normalized_status', 'delivered')
        .eq('payment_status', 'paid')
        .is('archived_at', null)
        .eq('is_test', false)
        .or(sdFilter),
    ])

    return NextResponse.json({
      nuevos:                         nuevos                         ?? 0,
      reintentar:                     reintentar                     ?? 0,
      atrasados:                      atrasados                      ?? 0,
      atrasados24h:                   atrasados24h                   ?? 0,
      sinTocarTotal:                  sinTocarTotal                  ?? 0,
      confirmadosHoy:                 confirmadosHoy                 ?? 0,
      contactadosHoy:                 contactadosHoy                 ?? 0,
      sinRespuesta:                   reintentar                     ?? 0,
      inalcanzables:                  inalcanzables                  ?? 0,
      noDesean:                       noDesean                       ?? 0,
      sinCobertura:                   sinCobertura                   ?? 0,
      pendingTotal:                   pendingTotal                   ?? 0,
      confirmadosSinGuia:             confirmadosSinGuia             ?? 0,
      despachados:                    despachados                    ?? 0,
      santoDomingoPendientes:         santoDomingoPendientes         ?? 0,
      santoDomingoConfirmadosSinGuia: santoDomingoConfirmadosSinGuia ?? 0,
      santoDomingoTotal:              santoDomingoTotal              ?? 0,
      fueraDeCoberturaTotal:          fueraDeCoberturaTotal          ?? 0,
      entrantesHoy:                   entrantesHoy                   ?? 0,
      pendientesHoy:                  pendientesHoy                  ?? 0,
      sinTocarHoy:                    sinTocarHoy                    ?? 0,
      // Sección A — nuevas
      sinRespuestaHoy:                sinRespuestaHoy                ?? 0,
      // Sección B — antigüedad
      pendientesAyer:                 pendientesAyer                 ?? 0,
      pendientesSemana:               pendientesSemana               ?? 0,
      pendientesMes:                  pendientesMes                  ?? 0,
      pendientesMas30d:               pendientesMas30d               ?? 0,
      // Sección C — causa
      tresMasIntentosPendientes:      tresMasIntentosPendientes      ?? 0,
      duplicadosPendientes:           duplicadosPendientes           ?? 0,
      numeroIncorrecto:               numeroIncorrecto               ?? 0,
      // Pipeline nav — pago SD (migración 046)
      sdPorCobrar:                    sdPorCobrar                    ?? 0,
      entregadosSd:                   entregadosSd                   ?? 0,
    })
  } catch (err) {
    console.error('[GET /api/confirmacion/stats]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
