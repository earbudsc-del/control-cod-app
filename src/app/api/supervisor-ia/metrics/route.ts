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
    // Ventana operativa para generadas: igual que en flujo-stats.
    // Excluye guías históricas atascadas que EFI ya no sirve y que inflan el conteo.
    const cutoffGeneradas = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const generadasDateFilter = `shipment_created_at.gte.${cutoffGeneradas},and(shipment_created_at.is.null,created_at.gte.${cutoffGeneradas})`

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
      // 4 - Operación: entregados hoy (EFI — solo con tracking_number)
      entregadosHoyRes,
      // 5 - Operación: novedades activas (EFI — solo con tracking_number)
      novedadesActivasRes,
      // 6 - Operación: reparto crítico +48h (EFI — solo con tracking_number)
      reparto48hRes,
      // 7 - Operación: tránsito crítico +48h (no generadas, no anuladas, solo con tracking_number)
      transito48hRes,
      // 8 - Operación: generadas críticas +48h (solo con tracking_number)
      generadas48hRes,
      // 9 - Operación: fuera de cobertura
      sinCoberturaRes,
      // 10 - Alertas: sin confirmar +24h
      sinConfirmar24hRes,
      // 11 - Alertas: novedades con 2+ intentos (EFI — solo con tracking_number)
      novedad2IntentosRes,
      // 12 - Alertas: novedad +7 días (EFI — solo con tracking_number)
      novedad7diasRes,
      // 13 - Alertas: novedad +14 días (EFI — solo con tracking_number)
      novedad14diasRes,
      // 14 - Alertas: guías anuladas/canceladas (EFI — solo con tracking_number)
      guiasAnuladasRes,
      // 15 - Alertas: carritos pendientes
      carritosPendientesRes,
      // 16 - Posibles indemnizables (EFI — solo con tracking_number)
      indemnizablesRes,
      // 17 - Módulo confirmación: inalcanzables
      confUnreachableRes,
      // 18 - Módulo confirmación: cancelados
      confCancelledRes,
      // 19 - Módulo reparto: total en reparto (EFI — solo con tracking_number)
      repartoTotalRes,
      // 20 - Módulo tránsito: generadas activas (EFI — solo con tracking_number, ventana 60d)
      transitoGeneradasRes,
      // 21 - Módulo tránsito: en tránsito activo (EFI — solo con tracking_number, sin generadas/anuladas)
      transitoActivoRes,
      // 22 - Módulo carritos: contactados hoy
      carritosContactadosHoyRes,
      // 23 - Módulo carritos: recuperados total
      carritosRecuperadosTotalRes,
      // 24 - Módulo novedad: recuperadas hoy (EFI — solo con tracking_number)
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

      // EFI deliveries only — SD local (no tracking_number) excluded
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .not('tracking_number', 'is', null)
        .gte('last_tracking_update', hoyRD.start)
        .lte('last_tracking_update', hoyRD.end),

      // EFI novedades only — SD local (no tracking_number) excluded
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'novedad')
        .not('tracking_number', 'is', null),

      // EFI reparto crítico — SD local excluded
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'en_reparto')
        .not('tracking_number', 'is', null)
        .or(repOrFilter),

      // EFI tránsito crítico — no generadas, no anuladas, SD local excluded
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'in_transit')
        .not('tracking_number', 'is', null)
        .not('raw_status', 'ilike', '%generada%')
        .not('raw_status', 'ilike', '%anulada%')
        .not('raw_status', 'ilike', '%cancelada%')
        .or(trOrFilter),

      // EFI generadas críticas — within 60-day window, SD local excluded
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'in_transit')
        .not('tracking_number', 'is', null)
        .ilike('raw_status', '%generada%')
        .or(trOrFilter)
        .or(generadasDateFilter),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'no_coverage'),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'pending')
        .is('tracking_number', null)
        .lt('shopify_created_at', cutoff24h),

      // EFI novedad 2+ intentos — SD local excluded
      supabase.from('orders')
        .select('id, tracking_number, customer_name, city, province, delivery_attempts, last_attempt_reason, customer_phone, cod_amount', { count: 'exact' })
        .eq('normalized_status', 'novedad')
        .not('tracking_number', 'is', null)
        .gte('delivery_attempts', 2)
        .order('delivery_attempts', { ascending: false })
        .limit(50),

      // EFI novedad +7 días — SD local excluded
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'novedad')
        .not('tracking_number', 'is', null)
        .or(nov7OrFilter),

      // EFI novedad +14 días — SD local excluded
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'novedad')
        .not('tracking_number', 'is', null)
        .or(nov14OrFilter),

      // EFI guías anuladas/canceladas — SD local excluded
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'returned')
        .not('tracking_number', 'is', null)
        .or('raw_status.ilike.%anulada%,raw_status.ilike.%cancelada%'),

      supabase.from('abandoned_carts').select('id', { count: 'exact', head: true })
        .eq('recovery_status', 'pending'),

      // EFI posibles indemnizables — SD local excluded
      supabase.from('orders')
        .select('id, tracking_number, order_number, customer_name, customer_phone, city, province, delivery_attempts, last_attempt_reason, raw_status, normalized_status, cod_amount')
        .eq('normalized_status', 'returned')
        .not('tracking_number', 'is', null)
        .gte('delivery_attempts', 2)
        .order('delivery_attempts', { ascending: false })
        .limit(50),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'unreachable'),

      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'cancelled'),

      // EFI total en reparto — SD local (no tracking_number) excluded
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'en_reparto')
        .not('tracking_number', 'is', null),

      // EFI generadas activas — raw_status='Generada', within 60-day window, SD local excluded
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'in_transit')
        .not('tracking_number', 'is', null)
        .ilike('raw_status', '%generada%')
        .or(generadasDateFilter),

      // EFI en tránsito activo — raw_status≠Generada/Anulada/Cancelada, SD local excluded
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'in_transit')
        .not('tracking_number', 'is', null)
        .not('raw_status', 'ilike', '%generada%')
        .not('raw_status', 'ilike', '%anulada%')
        .not('raw_status', 'ilike', '%cancelada%'),

      supabase.from('abandoned_carts').select('id', { count: 'exact', head: true })
        .in('recovery_status', ['contacted', 'no_answer'])
        .gte('last_contacted_at', hoyRD.start)
        .lte('last_contacted_at', hoyRD.end),

      supabase.from('abandoned_carts').select('id', { count: 'exact', head: true })
        .eq('recovery_status', 'recovered'),

      // EFI novedades recuperadas hoy — solo entregas EFI con intentos previos
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('normalized_status', 'delivered')
        .not('tracking_number', 'is', null)
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
