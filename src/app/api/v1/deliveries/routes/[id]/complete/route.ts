import { NextResponse } from 'next/server'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { corsHeaders } from '@/lib/cors'
import { reduceLatestActions, type LatestAction } from '@/lib/deliveries/sd-status'
import { buildDerivedRoutes, type RouteOrderRow } from '@/lib/deliveries/routes'
import { loadAgentActionsForOrders } from '@/lib/deliveries/load-agent-actions'

// POST /api/v1/deliveries/routes/[id]/complete
//
// Las rutas son derivadas — "completada" ya se calcula automáticamente
// cuando todas sus paradas quedan en estado terminal (entregado/cancelado).
// Este endpoint no escribe nada: valida esa condición y confirma el estado
// final, para que el contrato pedido (POST .../complete) exista y sea
// consistente con GET .../routes, sin inventar una columna de estado que no
// tiene dónde vivir todavía (ver nota en src/lib/deliveries/routes.ts).

const ALLOWED_ROLES = ['admin', 'santo_domingo_delivery_agent']

const ORDER_FIELDS =
  'id, order_number, customer_name, customer_phone, customer_address, city, province, ' +
  'cod_amount, normalized_status, confirmation_status, tracking_number, assigned_to, ' +
  'sd_location_lat, sd_location_lng, ' +
  'created_at, status_since, last_tracking_update, updated_at'

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

    // Nota: esta query trae SOLO pedidos en_reparto — si la ruta ya está
    // 100% terminal, ninguna de sus paradas aparecerá aquí (correcto: ya no
    // están en_reparto). Por eso la validación de "completada" se basa en
    // que `routes` ya no contenga la ruta con paradas activas, no en volver
    // a listar paradas entregadas.
    const { data: ordersData, error: ordersError } = await supabase
      .from('orders')
      .select(ORDER_FIELDS)
      .eq('store_id', profile.store_id)
      .eq('normalized_status', 'en_reparto')
      .eq('assigned_to', user.id)
      .is('tracking_number', null)
      .limit(500)

    if (ordersError) throw ordersError

    const orders = (ordersData ?? []) as unknown as RouteOrderRow[]
    const orderIds = orders.map(o => o.id)

    let latestByOrder = new Map<string, LatestAction>()
    if (orderIds.length > 0) {
      // Mismo corte de 7 días que antes (misma fórmula, mismo `since`) — ahora
      // vía loadAgentActionsForOrders (chunkeado de a 100 IDs, Sprint Crítico
      // 3), mismas columnas, mismos 4 action_type, mismo orden. Única
      // diferencia real: la query original ignoraba `error` (`const { data:
      // actions } = await ...` sin chequear `error`, tragándolo en silencio);
      // el helper SÍ lanza si algún chunk falla, y ese error cae en el
      // catch de este endpoint → 500 "Error interno" en vez de continuar
      // silenciosamente como si no hubiera acciones. Comportamiento más
      // seguro, consistente con los otros 3 endpoints /routes* — documentado
      // aquí porque es la única semántica que cambia con esta migración.
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const actions = await loadAgentActionsForOrders(supabase, orderIds, { since })
      latestByOrder = reduceLatestActions(actions)
    }

    const { routes } = buildDerivedRoutes({ orders, latestByOrder, courierId: user.id, role: profile.role })
    const route = routes.find(r => r.id === routeId)

    if (!route) {
      // Ya no quedan paradas activas para esta ruta hoy — se considera completada.
      return NextResponse.json({ routeId, status: 'completada' }, { status: 200, headers })
    }
    if (route.status !== 'completada') {
      return NextResponse.json({
        error: 'La ruta todavía tiene paradas pendientes.',
        stopsCount: route.stopsCount,
        delivered: route.delivered,
      }, { status: 422, headers })
    }

    return NextResponse.json({ routeId, status: 'completada' }, { status: 200, headers })
  } catch (err) {
    console.error('[POST /api/v1/deliveries/routes/[id]/complete]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}
