import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const ALLOWED_ROLES = ['admin', 'ia_supervisor']

function rdDayBounds(daysAgo = 0): { start: string; end: string } {
  const dateStrRD = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = dateStrRD.split('-').map(Number)
  const startUTC = new Date(Date.UTC(y, m - 1, d - daysAgo, 4, 0, 0, 0))
  const endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { start: startUTC.toISOString(), end: endUTC.toISOString() }
}

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

    const role = profile?.role ?? 'agent'
    if (!ALLOWED_ROLES.includes(role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const now      = new Date()
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const cutoff48h = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
    const cutoff7d  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000).toISOString()
    const cutoff14d = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const hoyRD     = rdDayBounds(0)

    // OR filter para criticidad por tiempo (reparto)
    const repOrFilter = `status_since.lt.${cutoff48h},and(status_since.is.null,last_tracking_update.lt.${cutoff48h}),and(status_since.is.null,last_tracking_update.is.null,updated_at.lt.${cutoff48h})`
    // OR filter para criticidad por tiempo (tránsito)
    const trOrFilter  = `status_since.lt.${cutoff48h},and(status_since.is.null,shipment_created_at.lt.${cutoff48h}),and(status_since.is.null,shipment_created_at.is.null,created_at.lt.${cutoff48h})`
    // OR filter para novedades por antigüedad
    const nov7OrFilter  = `status_since.lt.${cutoff7d},and(status_since.is.null,updated_at.lt.${cutoff7d})`
    const nov14OrFilter = `status_since.lt.${cutoff14d},and(status_since.is.null,updated_at.lt.${cutoff14d})`

    const [
      // 1 - Operación: nuevos hoy
      nuevosHoyRes,
      // 2 - Operación: confirmados hoy
      confirmadosHoyRes,
      // 3 - Operación: carritos recuperados hoy
      carritosRecuperadosHoyRes,
      // 4 - Operación: entregados hoy
      entregadosHoyRes,
      // 5 - Operación: novedades activas
      novedadesActivasRes,
      // 6 - Operación: reparto crítico +48h
      reparto48hRes,
      // 7 - Operación: tránsito crítico +48h (no generadas, no anuladas)
      transito48hRes,
      // 8 - Operación: generadas críticas +48h
      generadas48hRes,
      // 9 - Operación: fuera de cobertura
      sinCoberturaRes,
      // 10 - Alertas: sin confirmar +24h
      sinConfirmar24hRes,
      // 11 - Alertas: novedades con 2+ intentos (datos + count)
      novedad2IntentosRes,
      // 12 - Alertas: novedad +7 días
      novedad7diasRes,
      // 13 - Alertas: novedad +14 días
      novedad14diasRes,
      // 14 - Alertas: guías anuladas/canceladas (returned)
      guiasAnuladasRes,
      // 15 - Alertas: carritos pendientes
      carritosPendientesRes,
      // 16 - Posibles indemnizables (datos)
      indemnizablesRes,
      // 17 - Módulo confirmación: inalcanzables
      confUnreachableRes,
      // 18 - Módulo confirmación: cancelados
      confCancelledRes,
      // 19 - Módulo reparto: total en reparto
      repartoTotalRes,
      // 20 - Módulo tránsito: generadas (total, sin filtro tiempo)
      transitoGeneradasRes,
      // 21 - Módulo tránsito: en tránsito activo
      transitoActivoRes,
      // 22 - Módulo carritos: contactados hoy
      carritosContactadosHoyRes,
      // 23 - Módulo carritos: recuperados total
      carritosRecuperadosTotalRes,
      // 24 - Módulo novedad: recuperadas hoy (entregadas con intentos previos)
      novedadRecuperadasHoyRes,
    ] = await Promise.all([

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('source', 'shopify_webhook')
        .gte('shopify_created_at', hoyRD.start)
        .lte('shopify_created_at', hoyRD.end),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'confirmed')
        .gte('last_confirmation_attempt', hoyRD.start)
        .lte('last_confirmation_attempt', hoyRD.end),

      supabase.from('abandoned_carts').select('id', { count: 'exact', head: true })
        .eq('recovery_status', 'recovered')
        .gte('last_contacted_at', hoyRD.start)
        .lte('last_contacted_at', hoyRD.end),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .gte('last_tracking_update', hoyRD.start)
        .lte('last_tracking_update', hoyRD.end),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'novedad'),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'en_reparto')
        .or(repOrFilter),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'in_transit')
        .not('raw_status', 'ilike', '%generada%')
        .not('raw_status', 'ilike', '%anulada%')
        .not('raw_status', 'ilike', '%cancelada%')
        .or(trOrFilter),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'in_transit')
        .ilike('raw_status', '%generada%')
        .or(trOrFilter),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'no_coverage'),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'pending')
        .is('tracking_number', null)
        .lt('shopify_created_at', cutoff24h),

      supabase.from('orders')
        .select('id, tracking_number, customer_name, city, province, delivery_attempts, last_attempt_reason, customer_phone, cod_amount', { count: 'exact' })
        .eq('normalized_status', 'novedad')
        .gte('delivery_attempts', 2)
        .order('delivery_attempts', { ascending: false })
        .limit(50),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'novedad')
        .or(nov7OrFilter),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'novedad')
        .or(nov14OrFilter),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'returned')
        .or('raw_status.ilike.%anulada%,raw_status.ilike.%cancelada%'),

      supabase.from('abandoned_carts').select('id', { count: 'exact', head: true })
        .eq('recovery_status', 'pending'),

      supabase.from('orders')
        .select('id, tracking_number, order_number, customer_name, customer_phone, city, province, delivery_attempts, last_attempt_reason, raw_status, normalized_status, cod_amount')
        .eq('normalized_status', 'returned')
        .gte('delivery_attempts', 2)
        .order('delivery_attempts', { ascending: false })
        .limit(50),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'unreachable'),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'cancelled'),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'en_reparto'),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'in_transit')
        .ilike('raw_status', '%generada%'),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'in_transit')
        .not('raw_status', 'ilike', '%generada%')
        .not('raw_status', 'ilike', '%anulada%')
        .not('raw_status', 'ilike', '%cancelada%'),

      supabase.from('abandoned_carts').select('id', { count: 'exact', head: true })
        .in('recovery_status', ['contacted', 'no_answer'])
        .gte('last_contacted_at', hoyRD.start)
        .lte('last_contacted_at', hoyRD.end),

      supabase.from('abandoned_carts').select('id', { count: 'exact', head: true })
        .eq('recovery_status', 'recovered'),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .gt('delivery_attempts', 0)
        .gte('last_tracking_update', hoyRD.start)
        .lte('last_tracking_update', hoyRD.end),
    ])

    const indemnizablesCount = indemnizablesRes.data?.length ?? 0

    return NextResponse.json({
      generatedAt: now.toISOString(),

      operacion: {
        nuevosHoy:               nuevosHoyRes.count              ?? 0,
        confirmadosHoy:          confirmadosHoyRes.count          ?? 0,
        carritosRecuperadosHoy:  carritosRecuperadosHoyRes.count  ?? 0,
        entregadosHoy:           entregadosHoyRes.count           ?? 0,
        novedadesActivas:        novedadesActivasRes.count        ?? 0,
        reparto48h:              reparto48hRes.count              ?? 0,
        transito48h:             transito48hRes.count             ?? 0,
        generadas48h:            generadas48hRes.count            ?? 0,
        fueraCobertura:          sinCoberturaRes.count            ?? 0,
      },

      alertas: {
        sinConfirmar24h:         sinConfirmar24hRes.count         ?? 0,
        reparto48h:              reparto48hRes.count              ?? 0,
        transito48h:             transito48hRes.count             ?? 0,
        generadas48h:            generadas48hRes.count            ?? 0,
        novedad2Intentos:        novedad2IntentosRes.count        ?? 0,
        novedad7dias:            novedad7diasRes.count            ?? 0,
        novedad14dias:           novedad14diasRes.count           ?? 0,
        guiasAnuladas:           guiasAnuladasRes.count           ?? 0,
        posiblesIndemnizables:   indemnizablesCount,
        fueraCobertura:          sinCoberturaRes.count            ?? 0,
        carritosPendientes:      carritosPendientesRes.count      ?? 0,
      },

      modulos: {
        confirmacion: {
          nuevosHoy:     nuevosHoyRes.count      ?? 0,
          confirmadosHoy: confirmadosHoyRes.count ?? 0,
          inalcanzables: confUnreachableRes.count ?? 0,
          cancelados:    confCancelledRes.count   ?? 0,
          sinCobertura:  sinCoberturaRes.count    ?? 0,
          pendientes24h: sinConfirmar24hRes.count ?? 0,
        },
        novedad: {
          activas:               novedadesActivasRes.count    ?? 0,
          recuperadasHoy:        novedadRecuperadasHoyRes.count ?? 0,
          dosIntentos:           novedad2IntentosRes.count    ?? 0,
          mas7dias:              novedad7diasRes.count        ?? 0,
          mas14dias:             novedad14diasRes.count       ?? 0,
          posiblesIndemnizables: indemnizablesCount,
        },
        reparto: {
          enReparto:    repartoTotalRes.count ?? 0,
          criticos48h:  reparto48hRes.count   ?? 0,
          entregadosHoy: entregadosHoyRes.count ?? 0,
        },
        transito: {
          generadas:   transitoGeneradasRes.count ?? 0,
          enTransito:  transitoActivoRes.count    ?? 0,
          criticas48h: transito48hRes.count       ?? 0,
          anuladas:    guiasAnuladasRes.count      ?? 0,
        },
        carritos: {
          pendientes:        carritosPendientesRes.count      ?? 0,
          contactadosHoy:    carritosContactadosHoyRes.count  ?? 0,
          recuperadosHoy:    carritosRecuperadosHoyRes.count  ?? 0,
          recuperadosTotal:  carritosRecuperadosTotalRes.count ?? 0,
        },
      },

      indemnizables:        indemnizablesRes.data       ?? [],
      novedad2IntentosLista: novedad2IntentosRes.data   ?? [],
    })
  } catch (err) {
    console.error('[GET /api/supervisor-ia/metrics]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
