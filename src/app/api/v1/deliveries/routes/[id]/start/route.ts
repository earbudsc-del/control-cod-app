import { NextResponse } from 'next/server'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { corsHeaders } from '@/lib/cors'
import { reduceLatestActions, type LatestAction } from '@/lib/deliveries/sd-status'
import { buildDerivedRoutes, type RouteOrderRow } from '@/lib/deliveries/routes'
import { executeStartRoute } from '@/lib/deliveries/action-executors'

// POST /api/v1/deliveries/routes/[id]/start
//
// Como las rutas son derivadas (no persistidas), "iniciar" una ruta = aplicar
// start_route (route_confirmed) a todas sus paradas en confirmado_listo/
// reprogramado que están asignadas al mensajero. El estado "activa" de la
// ruta se deriva automáticamente de que al menos una parada quede en_ruta —
// no hay una columna de estado que escribir aparte.

const ALLOWED_ROLES = ['admin', 'santo_domingo_delivery_agent']

const ORDER_FIELDS =
  'id, order_number, customer_name, customer_phone, customer_address, city, province, ' +
  'cod_amount, normalized_status, confirmation_status, tracking_number, assigned_to, ' +
  'shopify_order_id, source, created_at, status_since, last_tracking_update, updated_at'

function getBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

    const orders = (ordersData ?? []) as unknown as (RouteOrderRow & { shopify_order_id: string | null; source: string | null })[]
    const orderIds = orders.map(o => o.id)

    let latestByOrder = new Map<string, LatestAction>()
    if (orderIds.length > 0) {
      // Sin corte de fecha — ver nota en GET /api/v1/deliveries/orders/route.ts:
      // un route_confirmed viejo no debe "caducar" y hacer reaparecer start_route.
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
    if (!route) return NextResponse.json({ error: 'Ruta no encontrada' }, { status: 404, headers })

    // Solo una ruta activa a la vez: si el mensajero ya tiene paradas en_ruta
    // en OTRA zona, no dejamos iniciar una segunda ruta en paralelo. Las
    // rutas son derivadas por zona (sin persistencia formal — ver routes.ts),
    // así que esta validación se hace sobre el mismo cálculo ya obtenido
    // arriba, sin tabla nueva.
    const otherActiveRoute = routes.find(r => r.id !== routeId && r.status === 'activa')
    if (otherActiveRoute) {
      return NextResponse.json({
        error: `Ya tienes una ruta activa en ${otherActiveRoute.name}. Termina o reprograma esas paradas antes de iniciar otra ruta.`,
      }, { status: 409, headers })
    }

    const stops = stopsByRoute.get(routeId) ?? []
    const startable = stops.filter(s => s.allowedActions.includes('start_route'))

    if (startable.length === 0) {
      return NextResponse.json({ error: 'No hay paradas listas para iniciar en esta ruta.' }, { status: 422, headers })
    }

    const orderById = new Map(orders.map(o => [o.id, o]))
    const started: string[] = []
    const failed: { orderId: string; error: string }[] = []

    for (const stop of startable) {
      const order = orderById.get(stop.orderId)
      const result = await executeStartRoute(
        supabase, stop.orderId, profile.id,
        order?.shopify_order_id ?? null, order?.tracking_number ?? null, order?.source ?? null,
      )
      if (result.ok) started.push(stop.orderId)
      else failed.push({ orderId: stop.orderId, error: result.error ?? 'error desconocido' })
    }

    return NextResponse.json({
      routeId, started: started.length, failed, startedOrderIds: started,
    }, { status: started.length > 0 ? 200 : 500, headers })
  } catch (err) {
    console.error('[POST /api/v1/deliveries/routes/[id]/start]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}
