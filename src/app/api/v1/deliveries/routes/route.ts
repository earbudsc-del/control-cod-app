import { NextResponse } from 'next/server'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { corsHeaders } from '@/lib/cors'
import { reduceLatestActions, type LatestAction } from '@/lib/deliveries/sd-status'
import { buildDerivedRoutes, type RouteOrderRow } from '@/lib/deliveries/routes'

// GET /api/v1/deliveries/routes
//
// Rutas derivadas (ver src/lib/deliveries/routes.ts) para el mensajero
// autenticado — agrupa por zona real (detectSdZone) sus pedidos SD ya
// despachados. No persiste nada; se recalcula en cada request desde
// `orders` + `agent_actions`, igual que GET .../orders.

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

export async function GET(request: Request) {
  const origin = request.headers.get('origin')
  const headers = corsHeaders(origin)

  try {
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

    const { routes } = buildDerivedRoutes({ orders, latestByOrder, courierId: user.id, role: profile.role })
    routes.sort((a, b) => a.name.localeCompare(b.name))

    return NextResponse.json({
      routes,
      // Contrato explícito para el cliente: estas rutas NO son entidades
      // persistentes. Se recalculan en cada request desde `orders` +
      // `agent_actions`; el orden de las paradas no sobrevive una recarga
      // si el conjunto de pedidos cambia, y todavía no hay forma de que un
      // admin las cree, reordene o mueva pedidos entre ellas. Ver
      // src/lib/deliveries/routes.ts para el detalle.
      derived: true,
      persistence: 'none' as const,
      serverTime: new Date().toISOString(),
    }, { status: 200, headers })
  } catch (err) {
    console.error('[GET /api/v1/deliveries/routes]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}
