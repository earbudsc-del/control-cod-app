import { NextResponse } from 'next/server'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { corsHeaders } from '@/lib/cors'
import { reduceLatestActions, type LatestAction } from '@/lib/deliveries/sd-status'
import { buildDerivedRoutes, type RouteOrderRow } from '@/lib/deliveries/routes'

// GET /api/v1/deliveries/routes/[id]
//
// [id] es el id derivado `${zoneKey}_${YYYY-MM-DD}` que devuelve
// GET /api/v1/deliveries/routes — no hay tabla de rutas que buscar por PK,
// se recalculan todas las rutas del mensajero y se filtra la que coincide.

const ALLOWED_ROLES = ['admin', 'santo_domingo_delivery_agent']

const ORDER_FIELDS =
  'id, order_number, customer_name, customer_phone, customer_address, city, province, ' +
  'cod_amount, normalized_status, confirmation_status, tracking_number, assigned_to, ' +
  'created_at, status_since, last_tracking_update, updated_at'

function getBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin')
  const headers = corsHeaders(origin)

  try {
    const { id: routeId } = await params
    const token = getBearerToken(request)
    if (!token) return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const authClient = createSupabaseJsClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: { user }, error: userError } = await authClient.auth.getUser(token)
    if (userError || !user) return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })

    const supabase = await createServiceClient()
    const { data: profile } = await supabase
      .from('profiles').select('id, role, store_id').eq('id', user.id).single()

    if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403, headers })
    }

    const { data: ordersData, error: ordersError } = await supabase
      .from('orders')
      .select(ORDER_FIELDS)
      .eq('store_id', profile.store_id)
      .eq('normalized_status', 'en_reparto')
      .eq('assigned_to', user.id)
      .eq('is_test', false)
      .is('tracking_number', null)
      .limit(500)

    if (ordersError) throw ordersError

    const orders = (ordersData ?? []) as unknown as RouteOrderRow[]
    const orderIds = orders.map(o => o.id)

    let latestByOrder = new Map<string, LatestAction>()
    if (orderIds.length > 0) {
      // Sin corte de fecha — ver nota en GET /api/v1/deliveries/orders/route.ts.
      const { data: actions } = await supabase
        .from('agent_actions')
        .select('order_id, action_type, contact_result, created_at')
        .in('order_id', orderIds)
        .in('action_type', ['route_confirmed', 'rescheduled', 'customer_declined', 'contacted'])
        .order('created_at', { ascending: false })
      latestByOrder = reduceLatestActions(actions ?? [])
    }

    const { routes, stopsByRoute } = buildDerivedRoutes({ orders, latestByOrder, courierId: user.id, role: profile.role })
    const route = routes.find(r => r.id === routeId)

    if (!route) {
      return NextResponse.json({ error: 'Ruta no encontrada' }, { status: 404, headers })
    }

    return NextResponse.json({
      route,
      stops: stopsByRoute.get(routeId) ?? [],
      // Ver GET /api/v1/deliveries/routes — misma advertencia: ruta y orden
      // de paradas son derivados, no persistentes.
      derived: true,
      persistence: 'none' as const,
      serverTime: new Date().toISOString(),
    }, { status: 200, headers })
  } catch (err) {
    console.error('[GET /api/v1/deliveries/routes/[id]]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}
