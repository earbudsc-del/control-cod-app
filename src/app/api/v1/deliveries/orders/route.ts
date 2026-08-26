import { NextResponse } from 'next/server'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { detectSdZone } from '@/lib/sd-zones'
import { corsHeaders } from '@/lib/cors'
import { resolveWhatsappLinksBatch } from '@/lib/deliveries/whatsapp-link'
import { fetchPaidOrderIds, withoutPaidAction } from '@/lib/deliveries/payment-status'
import { SD_LOCATION_REQUEST_TEMPLATE_NAME } from '@/lib/deliveries/sd-location-request'
import { fetchSdLocationRequestInfoBatch } from '@/lib/deliveries/sd-location-request-status'
import { loadAgentActionsForOrders } from '@/lib/deliveries/load-agent-actions'
import {
  isSdEligible,
  computePool,
  computeStatus,
  computeOwnership,
  computeAllowedActions,
  reduceLatestActions,
  type SdOrderRow,
  type LatestAction,
} from '@/lib/deliveries/sd-status'

// GET /api/v1/deliveries/orders
//
// Endpoint protegido para Ruta COD (app de mensajero, proyecto Vite separado).
// Valida el access_token de Supabase Auth enviado como Bearer, verifica el rol
// del perfil asociado y devuelve los pedidos internos de Santo Domingo que el
// mensajero puede trabajar — misma lógica que ya usa el módulo SD Delivery
// (src/app/(app)/sd-delivery/page.tsx), ahora centralizada en
// src/lib/deliveries/sd-status.ts y reutilizada también por
// POST .../actions y GET .../routes.
//
// TODO (futuro, no bloqueante): el criterio de cobertura SD (tracking_number
// IS NULL + isSantoDomingoOrder) es un atajo documentado en CLAUDE.md — a
// futuro se reemplazará por un campo explícito (ej. workflow_owner).

const ALLOWED_ROLES = ['admin', 'santo_domingo_delivery_agent']

const ORDER_FIELDS =
  'id, order_number, customer_name, customer_phone, customer_address, city, province, ' +
  'cod_amount, product_summary, normalized_status, confirmation_status, tracking_number, ' +
  'delivery_attempts, created_at, status_since, last_tracking_update, updated_at, ' +
  'store_id, assigned_to, rescheduled_date, rescheduled_note, sd_location_received_at, ' +
  'sd_location_lat, sd_location_lng, sd_location_status, sd_location_wa_msg_id, sd_location_conversation_id'

interface OrderRow extends SdOrderRow {
  order_number: string | null
  customer_name: string | null
  customer_phone: string | null
  cod_amount: number | null
  product_summary: string | null
  delivery_attempts: number
  created_at: string
  status_since: string | null
  last_tracking_update: string | null
  updated_at: string
  store_id: string
  rescheduled_date: string | null
  rescheduled_note: string | null
  sd_location_received_at: string | null
  sd_location_lat: number | null
  sd_location_lng: number | null
  sd_location_status: string | null
  sd_location_wa_msg_id: string | null
  sd_location_conversation_id: string | null
  raw_status?: string | null
}

// Null-safe: pedidos SD locales (courier interno, nunca tocados por EFI)
// tienen raw_status=NULL siempre — nunca "anulada"/"cancelada" (esos valores
// solo los escribe el parser EFI). Ver isCancelledGuide en
// src/lib/order-status-helpers.ts (misma semántica, tipo Order en vez de
// OrderRow — se reimplementa aquí en vez de castear para no forzar un tipo
// que no calza 1:1).
function isNotCancelledRawStatus(rawStatus: string | null | undefined): boolean {
  const r = (rawStatus ?? '').toLowerCase()
  return !r.includes('anulad') && !r.includes('cancelad')
}

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
    if (!token) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

    const userClient = createSupabaseJsClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: { user }, error: userError } = await userClient.auth.getUser(token)
    if (userError || !user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers })
    }

    const { data: profile, error: profileError } = await userClient
      .from('profiles')
      .select('id, role, store_id')
      .eq('id', user.id)
      .single()

    if (profileError || !profile || !ALLOWED_ROLES.includes(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403, headers })
    }

    // Nota: la exclusión de anulada/cancelada NO se hace aquí vía
    // .not('raw_status','ilike',...) — con raw_status=NULL (el caso de TODO
    // pedido SD local, siempre, nunca tocado por EFI) esos filtros de
    // PostgREST descartan la fila (lógica de 3 valores de Postgres: NOT NULL
    // = NULL, y WHERE NULL excluye). Confirmado en vivo durante el Sprint
    // Crítico 1: los 293 pedidos SD reales en 'en_reparto' hoy (100% del pool
    // real) tienen raw_status=NULL y ninguno pasaba este filtro — poolA
    // devolvía vacío siempre. El filtro se aplica ahora en JS
    // (isNotCancelledRawStatus, null-safe) junto con isSdEligible más abajo.
    const poolAQuery = userClient
      .from('orders_with_sla')
      .select(`${ORDER_FIELDS}, raw_status`)
      .eq('normalized_status', 'en_reparto')
      .eq('is_test', false)
      .is('tracking_number', null)
      .limit(500)

    const poolBQuery = userClient
      .from('orders_with_sla')
      .select(ORDER_FIELDS)
      .eq('confirmation_status', 'pending')
      .neq('normalized_status', 'delivered')
      .neq('normalized_status', 'returned')
      .eq('is_test', false)
      .is('tracking_number', null)
      .limit(500)

    const poolCQuery = userClient
      .from('orders_with_sla')
      .select(ORDER_FIELDS)
      .eq('confirmation_status', 'confirmed')
      .eq('is_test', false)
      .is('tracking_number', null)
      .limit(500)

    // Pool D — entregados recientemente (últimas 24h). Sin esto, un pedido
    // desaparece de la lista en el instante en que se marca 'delivered' y el
    // mensajero pierde la posibilidad de marcarlo 'paid' después. Ventana
    // acotada, mismo criterio temporal que /api/reparto/entregados.
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const poolDQuery = userClient
      .from('orders_with_sla')
      .select(ORDER_FIELDS)
      .eq('normalized_status', 'delivered')
      .eq('is_test', false)
      .is('tracking_number', null)
      .gte('last_tracking_update', since24h)
      .limit(200)

    const [poolARes, poolBRes, poolCRes, poolDRes] = await Promise.all([poolAQuery, poolBQuery, poolCQuery, poolDQuery])

    if (poolARes.error || poolBRes.error || poolCRes.error || poolDRes.error) {
      console.error(
        '[deliveries/orders] query error',
        poolARes.error?.message, poolBRes.error?.message, poolCRes.error?.message, poolDRes.error?.message,
      )
      return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
    }

    const poolAData = (poolARes.data ?? []) as unknown as OrderRow[]
    const poolBData = (poolBRes.data ?? []) as unknown as OrderRow[]
    const poolCData = (poolCRes.data ?? []) as unknown as OrderRow[]
    const poolDData = (poolDRes.data ?? []) as unknown as OrderRow[]

    const terminal = new Set(['delivered', 'returned', 'cancelled'])
    const poolA = poolAData.filter(o => isSdEligible(o) && isNotCancelledRawStatus(o.raw_status))
    const poolB = poolBData.filter(isSdEligible)
    const poolC = poolCData.filter(o => isSdEligible(o) && !terminal.has(o.normalized_status))
    const poolD = poolDData.filter(isSdEligible)

    const byId = new Map<string, OrderRow>()
    for (const order of [...poolA, ...poolC, ...poolB, ...poolD]) {
      if (!byId.has(order.id)) byId.set(order.id, order)
    }

    const orderIds = [...byId.keys()]
    let latestByOrder = new Map<string, LatestAction>()
    const serviceClient = await createServiceClient()

    if (orderIds.length > 0) {
      // Sin corte de fecha: 'en_ruta' se deriva de la existencia de un
      // route_confirmed sin transición posterior — un pedido puede llevar
      // semanas atascado en 'en_reparto' (caso documentado en CLAUDE.md) y
      // un `.gte('created_at', since)` de 7 días hacía que ese
      // route_confirmed "caducara" y el pedido volviera a mostrar
      // start_route/ready_for_route como si nunca hubiera iniciado ruta.
      //
      // Carga en chunks (loadAgentActionsForOrders) en vez de un único
      // .in(orderIds) — con alto volumen (~400+ pedidos activos) ese filtro
      // construye una URL que PostgREST/Kong rechaza a nivel de transporte
      // (reproducido: TypeError: fetch failed a partir de ~400 IDs, ver
      // Sprint Crítico 3). Sin cambiar el contrato de Ruta COD ni la
      // semántica de reduceLatestActions()/computeStatus() — mismas
      // columnas, mismos 4 action_type, mismo resultado final.
      //
      // Si falla, NO se continúa con "sin acciones": eso convertiría un
      // fallo de infraestructura en un estado comercial incorrecto
      // (cancelado/en_ruta/no_responde/reprogramado dependen todos de este
      // dato). Se falla el request completo con 500 — Ruta COD (polling
      // cada pollAfterSeconds + reintento) conserva el último estado bueno
      // que ya tenía en vez de sobreescribirlo con datos parciales.
      try {
        const actions = await loadAgentActionsForOrders(serviceClient, orderIds)
        latestByOrder = reduceLatestActions(actions)
      } catch (err) {
        console.error(
          '[deliveries/orders] agent_actions query FAILED',
          err instanceof Error ? err.message : String(err),
        )
        return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
      }
    }

    const rows = [...byId.values()]

    // paymentStatus solo importa para el pool de entregados recientes (D) —
    // una sola query batch, no una por pedido. Ver src/lib/deliveries/payment-status.ts.
    const deliveredIds = rows.filter(o => o.normalized_status === 'delivered').map(o => o.id)
    const paidIds = await fetchPaidOrderIds(serviceClient, deliveredIds)

    const waLinks = await resolveWhatsappLinksBatch(
      userClient,
      process.env.NEXT_PUBLIC_APP_URL ?? null,
      rows.map(o => ({ id: o.id, phone: o.customer_phone, customerName: o.customer_name, orderNumber: o.order_number })),
    )

    const conversationIdByOrderId = new Map<string, string | undefined>()
    for (const o of rows) conversationIdByOrderId.set(o.id, waLinks.get(o.id)?.conversationId)
    const sdLocationInfo = await fetchSdLocationRequestInfoBatch(serviceClient, rows.map(o => o.id), conversationIdByOrderId)

    const orders = []
    let cancelledExcluded = 0
    for (const order of rows) {
      const pool = computePool(order)
      const latest = latestByOrder.get(order.id)
      const status = computeStatus(order, pool, latest)
      if (status === 'cancelado') { cancelledExcluded++; continue } // no es un pedido trabajable en el pilot

      const ownership = computeOwnership(order.assigned_to, user.id, profile.role)
      let allowedActions = computeAllowedActions(status, pool, ownership)
      const zone = detectSdZone(order.city, order.province, order.customer_address)

      const lastActionAt = pool === 'confirmado'
        ? (order.status_since ?? order.last_tracking_update ?? order.updated_at ?? order.created_at)
        : order.created_at

      let paymentStatus: 'pending' | 'paid' | undefined
      if (status === 'entregado') {
        paymentStatus = paidIds.has(order.id) ? 'paid' : 'pending'
        allowedActions = withoutPaidAction(allowedActions, paymentStatus === 'paid')
      }

      const locationInfo = sdLocationInfo.get(order.id)

      orders.push({
        id: order.id,
        orderNumber: order.order_number,
        customerName: order.customer_name,
        phone: order.customer_phone,
        address: order.customer_address,
        city: order.city,
        sector: null,
        references: null,
        amountToCollect: order.cod_amount,
        products: order.product_summary,
        status,
        confirmationStatus: order.confirmation_status,
        trackingNumber: order.tracking_number,
        latitude: order.sd_location_lat,
        longitude: order.sd_location_lng,
        createdAt: order.created_at,
        lastActionAt,
        deliveryAttempts: order.delivery_attempts,
        storeId: order.store_id,
        assignedTo: order.assigned_to,
        allowedActions,
        paymentStatus,
        zone: { id: zone.id, label: zone.label },
        rescheduledFor: order.rescheduled_date,
        rescheduledNote: order.rescheduled_note,
        whatsapp: waLinks.get(order.id) ?? null,
        callUrl: order.customer_phone ? `tel:${order.customer_phone}` : null,
        conversationId: waLinks.get(order.id)?.conversationId ?? null,
        locationRequestStatus: locationInfo?.locationRequestStatus ?? null,
        locationRequestScheduledAt: locationInfo?.locationRequestScheduledAt ?? null,
        locationRequestSentAt: locationInfo?.locationRequestSentAt ?? null,
        customerRepliedAt: locationInfo?.customerRepliedAt ?? null,
        locationReceivedAt: order.sd_location_received_at,
      })
    }

    orders.sort((a, b) => new Date(a.lastActionAt).getTime() - new Date(b.lastActionAt).getTime())

    // Log permanente y liviano — una línea, sin datos de cliente. Suficiente
    // para confirmar en producción que el mensajero recibió pedidos reales
    // sin tener que reactivar el diagnóstico verboso (ver historial de esta
    // sección en git si hace falta ese detalle otra vez).
    const withLocation = orders.filter(o => o.locationReceivedAt != null).length
    console.log(`[deliveries/orders] user=${user.id} role=${profile.role} → ${orders.length} pedidos entregados a Ruta COD (cancelados excluidos=${cancelledExcluded}, con ubicación recibida=${withLocation})`)

    return NextResponse.json(
      { orders, serverTime: new Date().toISOString(), pollAfterSeconds: 15 },
      { status: 200, headers },
    )
  } catch (err) {
    console.error('[GET /api/v1/deliveries/orders]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}
