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

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    // Límites de tiempo: hoy RD y cortes de 24h y 48h
    const todayStartRD = rdTodayStartISO()
    const todayIso     = new Date().setHours(0, 0, 0, 0), todayIsoStr = new Date(todayIso).toISOString()
    const cutoff24h    = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const cutoff48h    = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

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
    })
  } catch (err) {
    console.error('[GET /api/confirmacion/stats]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
