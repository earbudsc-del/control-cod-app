import { NextResponse } from 'next/server'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { corsHeaders } from '@/lib/cors'
import { isSdEligible } from '@/lib/deliveries/sd-status'

// GET /api/v1/deliveries/orders/[id]/history
//
// Timeline real de agent_actions para un pedido — mismo dato que usan las
// pantallas de detalle de Control COD, sin motor de historial paralelo.
// Lectura: cualquier admin/santo_domingo_delivery_agent de la misma tienda
// puede consultarlo (no está limitado al mensajero asignado — solo las
// mutaciones en .../actions están restringidas por dueño).

const ALLOWED_ROLES = ['admin', 'santo_domingo_delivery_agent']

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
    const { id: orderId } = await params
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

    const { data: order } = await supabase
      .from('orders')
      .select('id, store_id, city, province, customer_address, tracking_number, normalized_status, confirmation_status, assigned_to')
      .eq('id', orderId)
      .single()

    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404, headers })
    if (order.store_id !== profile.store_id && profile.role !== 'admin') {
      return NextResponse.json({ error: 'Pedido fuera de tu tienda' }, { status: 403, headers })
    }
    if (!isSdEligible(order)) {
      return NextResponse.json({ error: 'Pedido fuera de la cobertura interna de Santo Domingo' }, { status: 403, headers })
    }

    const { data: actions, error: actionsError } = await supabase
      .from('agent_actions')
      .select('id, action_type, contact_result, notes, created_at, agent:profiles!agent_id(full_name)')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
      .limit(100)

    if (actionsError) throw actionsError

    const history = (actions ?? []).map((row: any) => ({
      id: row.id,
      actionType: row.action_type,
      contactResult: row.contact_result,
      note: row.notes,
      agentName: row.agent?.full_name ?? null,
      at: row.created_at,
    }))

    return NextResponse.json({ orderId, history }, { status: 200, headers })
  } catch (err) {
    console.error('[GET /api/v1/deliveries/orders/[id]/history]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}
