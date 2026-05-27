import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/confirmacion/pedidos
 *
 * Vista principal estilo Shopify: TODOS los pedidos de source='shopify_webhook'
 * ordenados por shopify_created_at DESC con paginación server-side.
 *
 * Query params:
 *   ?page=N                      — página (default 1)
 *   ?limit=N                     — registros por página (default 50, max 100)
 *   ?search=X                    — búsqueda por nombre, teléfono, #orden, tracking
 *   ?from=ISO                    — filtro desde fecha (shopify_created_at >= from) — ignorado si filter != ''
 *   ?to=ISO                      — filtro hasta fecha (shopify_created_at < to)   — ignorado si filter != ''
 *   ?filter=santo_domingo        — solo pedidos de SD/DN/Zona local (todas las fechas)
 *   ?filter=fuera_de_cobertura   — solo pedidos con confirmation_status='no_coverage' (todas las fechas)
 *
 * Respuesta: { data: Order[], total, page, pages }
 */

// Filtro OR idéntico al que usa /api/confirmacion/stats para SD
const SD_FILTER = [
  'city.ilike.%santo domingo%',
  'city.ilike.%distrito nacional%',
  'city.ilike.dn',
  'province.ilike.%santo domingo%',
  'province.ilike.%distrito nacional%',
  'province.ilike.dn',
  'customer_address.ilike.%santo domingo%',
  'customer_address.ilike.%distrito nacional%',
].join(',')

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const page   = Math.max(1, parseInt(searchParams.get('page')   ?? '1'))
    const limit  = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50')))
    const search = searchParams.get('search')?.trim() ?? ''
    const from   = searchParams.get('from') ?? ''
    const to     = searchParams.get('to')   ?? ''
    const filter = searchParams.get('filter') ?? ''  // 'santo_domingo' | 'fuera_de_cobertura' | ''
    const status = searchParams.get('status') ?? ''  // 'pending' | 'reintentar' | 'confirmed' | 'cancelled' | 'no_coverage' | 'unreachable' | ''

    const rangeFrom = (page - 1) * limit
    const rangeTo   = rangeFrom + limit - 1

    let query = supabase
      .from('orders')
      .select('*', { count: 'exact' })
      .eq('source', 'shopify_webhook')
      // Orden cronológico inverso: más recientes primero
      .order('shopify_created_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(rangeFrom, rangeTo)

    // ── Filtros de búsqueda por texto ─────────────────────────────────────────
    if (search) {
      query = query.or(
        `customer_name.ilike.%${search}%,customer_phone.ilike.%${search}%,order_number.ilike.%${search}%,tracking_number.ilike.%${search}%`,
      )
    }

    // ── Filtro de fecha (solo aplica a la vista general, no a SD/FCD) ─────────
    if (!filter) {
      if (from) query = query.gte('shopify_created_at', from)
      if (to)   query = query.lt('shopify_created_at', to)
    }

    // ── Filtros especiales ────────────────────────────────────────────────────
    if (filter === 'santo_domingo') {
      // Todos los pedidos de zona SD/DN — sin restricción de fecha
      query = query.or(SD_FILTER)
    }

    if (filter === 'fuera_de_cobertura') {
      // Todos los pedidos marcados como sin cobertura — sin restricción de fecha
      query = query.eq('confirmation_status', 'no_coverage')
    }

    // ── Filtro de estado de confirmación ──────────────────────────────────────
    if (status === 'pending') {
      // Pendiente: status=pending y sin intentos (0 o null)
      query = query
        .eq('confirmation_status', 'pending')
        .or('confirmation_attempts.eq.0,confirmation_attempts.is.null')
    } else if (status === 'reintentar') {
      // No contesta: status=pending con 1–2 intentos
      query = query
        .eq('confirmation_status', 'pending')
        .gt('confirmation_attempts', 0)
    } else if (status === 'confirmed') {
      query = query.eq('confirmation_status', 'confirmed')
    } else if (status === 'cancelled') {
      query = query.eq('confirmation_status', 'cancelled')
    } else if (status === 'no_coverage') {
      query = query.eq('confirmation_status', 'no_coverage')
    } else if (status === 'unreachable') {
      query = query.or('confirmation_status.eq.unreachable,confirmation_status.eq.wrong_number')
    }

    const { data, error, count } = await query
    if (error) throw error

    const total = count ?? 0
    const pages = Math.ceil(total / limit)

    return NextResponse.json({ data: data ?? [], total, page, pages })
  } catch (err) {
    console.error('[GET /api/confirmacion/pedidos]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
