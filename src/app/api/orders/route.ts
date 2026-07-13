import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const page       = parseInt(searchParams.get('page')  ?? '1')
    const limit      = parseInt(searchParams.get('limit') ?? '50')
    const status     = searchParams.get('status')
    const cls        = searchParams.get('classification')
    const assigned   = searchParams.get('assigned_to')
    const risk       = searchParams.get('is_at_risk')
    const sla        = searchParams.get('sla_breached')
    const search     = searchParams.get('search')
    const attempts   = searchParams.get('attempts')
    const from       = (page - 1) * limit
    const to         = from + limit - 1

    const sortBy    = searchParams.get('sortBy')
    const rawStatus = searchParams.get('rawStatus')   // filtro por raw_status ilike %value%

    let query = supabase
      .from('orders_with_sla')
      .select('*', { count: 'exact' })

    // sortBy=status_since_asc: ordena los más viejos en el estado primero (útil en /reparto)
    if (sortBy === 'status_since_asc') {
      query = query
        .order('status_since', { ascending: true, nullsFirst: false })
        .order('updated_at', { ascending: true })
    } else {
      query = query.order('updated_at', { ascending: false })
    }

    query = query.range(from, to)

    if (status === 'failed_attempt') {
      // "Intento fallido" no es un normalized_status — son pedidos con al menos un intento de entrega no completado
      // Excluir indemnizacion: aunque tenga delivery_attempts >= 1, es un estado de reclamo independiente
      query = query.gte('delivery_attempts', 1).neq('normalized_status', 'delivered').neq('normalized_status', 'indemnizacion')
    } else if (status === 'in_transit') {
      // in_transit activos: excluye guías con raw_status que indique cancelación o anulación,
      // aunque normalized_status aún no haya sido actualizado por el cron (estado transitorio).
      query = query
        .eq('normalized_status', 'in_transit')
        .not('raw_status', 'ilike', '%anulada%')
        .not('raw_status', 'ilike', '%cancelada%')
    } else if (status === 'en_reparto') {
      // en_reparto activo: excluye guías anuladas/canceladas que el cron aún no reclasificó
      // (mismo criterio que in_transit, evita contaminar el universo "activo" con anuladas).
      query = query
        .eq('normalized_status', 'en_reparto')
        .not('raw_status', 'ilike', '%anulad%')
        .not('raw_status', 'ilike', '%cancelad%')
      // requireTracking=true: restringe al universo EFI/Gintracom (tracking_number asignado),
      // usado por /reparto para no mezclar pedidos locales SD (tracking_number IS NULL,
      // que tienen su propio flujo de cierre en /sd-delivery y nunca son tocados por el cron EFI).
      if (searchParams.get('requireTracking') === 'true') {
        query = query.not('tracking_number', 'is', null)
      }
    } else if (status) {
      query = query.eq('normalized_status', status)
    }
    if (cls)      query = query.eq('classification', cls)
    if (assigned) query = query.eq('assigned_to', assigned)
    if (risk === 'true')  query = query.eq('is_at_risk', true)
    if (sla === 'true')   query = query.eq('sla_breached', true)
    if (attempts) query = query.eq('delivery_attempts', parseInt(attempts))

    if (search) {
      query = query.or(
        `tracking_number.ilike.%${search}%,customer_name.ilike.%${search}%,customer_phone.ilike.%${search}%,order_number.ilike.%${search}%`,
      )
    }

    if (rawStatus) {
      query = query.ilike('raw_status', `%${rawStatus}%`)
    }

    const confirmationStatus = searchParams.get('confirmationStatus')
    if (confirmationStatus === 'pending') {
      query = query
        .eq('confirmation_status', 'pending')
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')
    } else if (confirmationStatus === 'confirmed') {
      query = query.eq('confirmation_status', 'confirmed')
    }

    const { data, error, count } = await query
    if (error) throw error

    return NextResponse.json({
      data,
      pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) },
    })
  } catch (err) {
    console.error('[GET /api/orders]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
