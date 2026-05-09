import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/confirmacion/pedidos
 *
 * Vista principal estilo Shopify: TODOS los pedidos de source='shopify_webhook'
 * ordenados por shopify_created_at DESC con paginación server-side.
 *
 * Query params:
 *   ?page=N         — página (default 1)
 *   ?limit=N        — registros por página (default 50, max 100)
 *   ?search=X       — búsqueda por nombre, teléfono, #orden, tracking
 *   ?from=ISO       — filtro desde fecha (shopify_created_at >= from)
 *   ?to=ISO         — filtro hasta fecha (shopify_created_at < to)
 *
 * Respuesta: { data: Order[], total, page, pages }
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const page   = Math.max(1, parseInt(searchParams.get('page')  ?? '1'))
    const limit  = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50')))
    const search = searchParams.get('search')?.trim() ?? ''
    const from   = searchParams.get('from') ?? ''
    const to     = searchParams.get('to')   ?? ''

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

    if (search) {
      query = query.or(
        `customer_name.ilike.%${search}%,customer_phone.ilike.%${search}%,order_number.ilike.%${search}%,tracking_number.ilike.%${search}%`,
      )
    }

    if (from) query = query.gte('shopify_created_at', from)
    if (to)   query = query.lt('shopify_created_at', to)

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
