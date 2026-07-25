import { NextResponse } from 'next/server'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { corsHeaders } from '@/lib/cors'
import { isSdEligible } from '@/lib/deliveries/sd-status'
import { normalizeOrderLabel } from '@/lib/order-label/normalize-order-label'
import type { Order } from '@/types'

// GET /api/v1/deliveries/orders/[id]/cod-label
//
// Devuelve el modelo normalizado del Sticker COD para Ruta COD. Mismo patrón
// de auth/alcance que .../orders/[id]/history — exactamente el mismo universo
// de pedidos que un mensajero SD ya puede leer hoy vía la API v1 (no se
// amplía ni se reduce el alcance). Control COD NO llama a este endpoint para
// sus propios pedidos: usa normalizeOrderLabel() directamente sobre el order
// que ya tiene cargado en el cliente.

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
      .select(
        'id, store_id, order_number, customer_name, customer_phone, customer_address, city, province, product_summary, cod_amount, tracking_number, normalized_status, confirmation_status, assigned_to, shopify_created_at, created_at',
      )
      .eq('id', orderId)
      .single()

    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404, headers })
    if (order.store_id !== profile.store_id && profile.role !== 'admin') {
      return NextResponse.json({ error: 'Pedido fuera de tu tienda' }, { status: 403, headers })
    }
    if (!isSdEligible(order)) {
      return NextResponse.json({ error: 'Pedido fuera de la cobertura interna de Santo Domingo' }, { status: 403, headers })
    }

    const model = normalizeOrderLabel(order as unknown as Order)

    return NextResponse.json(model, { status: 200, headers })
  } catch (err) {
    console.error('[GET /api/v1/deliveries/orders/[id]/cod-label]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}
