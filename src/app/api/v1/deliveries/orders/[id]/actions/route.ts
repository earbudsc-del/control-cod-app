import { NextResponse } from 'next/server'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { detectSdZone } from '@/lib/sd-zones'
import { corsHeaders } from '@/lib/cors'
import { createLocalFulfillment } from '@/lib/shopify/fulfillments'
import { applyConfirmationAction } from '@/lib/orders/confirmation'
import { markSdOrderDelivered } from '@/lib/deliveries/mark-delivered'
import { markOrderPaid } from '@/lib/orders/mark-paid'
import { withoutPaidAction } from '@/lib/deliveries/payment-status'
import {
  isSdEligible,
  computePool,
  computeStatus,
  computeOwnership,
  computeAllowedActions,
  reduceLatestActions,
  type SdAction,
  type SdOrderRow,
} from '@/lib/deliveries/sd-status'

// POST /api/v1/deliveries/orders/[id]/actions
//
// Único endpoint de acciones operativas para Ruta COD. Adapta cada `action`
// del mensajero a los action_type / side-effects que YA existen en Control
// COD (agent_actions, applyConfirmationAction, createLocalFulfillment,
// markOrderAsPaid) — no crea un motor paralelo. Ver src/lib/deliveries/sd-status.ts
// para la máquina de estados y las transiciones permitidas por estado.
//
// REGLA APROBADA — entregado ≠ pagado: 'delivered' nunca llama a
// markOrderPaid ni acepta monto cobrado. El cobro se registra únicamente vía
// la acción 'paid' (requiere status='entregado'), de forma explícita e
// idempotente, delegando en markOrderPaid() (src/lib/orders/mark-paid.ts) —
// el mismo motor único que usa POST /api/orders/[id]/mark-paid. Fuente de
// verdad: orders.payment_status (migración 046_orders_payment_status.sql).

const ALLOWED_ROLES = ['admin', 'santo_domingo_delivery_agent']

const ACTIONS: SdAction[] = [
  'accept', 'ready_for_route', 'start_route', 'delivered', 'paid',
  'no_response', 'reschedule', 'customer_cancelled', 'incident', 'release',
]

interface ActionBody {
  action: SdAction
  rescheduledFor?: string
  note?: string
  amountCollected?: number
}

const ORDER_FIELDS =
  'id, order_number, customer_name, customer_phone, customer_address, city, province, ' +
  'cod_amount, normalized_status, confirmation_status, customer_confirmed, tracking_number, assigned_to, ' +
  'store_id, shopify_order_id, source, product_summary, delivery_attempts, created_at, ' +
  'status_since, last_tracking_update, updated_at, rescheduled_date, rescheduled_note, payment_status'

interface OrderRow extends SdOrderRow {
  order_number: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_confirmed: boolean | null
  cod_amount: number | null
  store_id: string
  shopify_order_id: string | null
  source: string | null
  product_summary: string | null
  delivery_attempts: number
  created_at: string
  status_since: string | null
  last_tracking_update: string | null
  updated_at: string
  rescheduled_date: string | null
  rescheduled_note: string | null
  payment_status: 'pending' | 'paid'
}

function getBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

async function logShopifySync(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  params: {
    orderId: string
    shopifyOrderId: string
    eventType: 'fulfillment' | 'mark_paid'
    result: { success: boolean; skipped?: boolean; error?: string }
    triggeredBy: string
    actionType: string
  },
) {
  await supabase.from('shopify_sync_log').insert({
    order_id: params.orderId,
    shopify_order_id: params.shopifyOrderId,
    event_type: params.eventType,
    result: params.result.success ? (params.result.skipped ? 'skipped' : 'success') : 'error',
    error_message: params.result.error ?? null,
    metadata: { action_type: params.actionType, source: 'ruta_cod' },
    triggered_by: params.triggeredBy,
  }).then(({ error }) => {
    if (error) console.error('[deliveries/actions] shopify_sync_log error:', error.message)
  })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

    let body: ActionBody
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Body inválido' }, { status: 400, headers })
    }

    if (!body.action || !ACTIONS.includes(body.action)) {
      return NextResponse.json({ error: 'Acción inválida' }, { status: 400, headers })
    }
    if (body.action === 'reschedule' && !body.rescheduledFor) {
      return NextResponse.json({ error: 'rescheduledFor es requerido para reprogramar' }, { status: 400, headers })
    }
    if (body.action === 'incident' && !body.note?.trim()) {
      return NextResponse.json({ error: 'note es requerido para registrar una incidencia' }, { status: 400, headers })
    }

    const { data: orderData, error: orderError } = await supabase
      .from('orders')
      .select(ORDER_FIELDS)
      .eq('id', orderId)
      .single()

    if (orderError || !orderData) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404, headers })
    }
    const order = orderData as unknown as OrderRow

    if (order.store_id !== profile.store_id && profile.role !== 'admin') {
      return NextResponse.json({ error: 'Pedido fuera de tu tienda' }, { status: 403, headers })
    }
    if (!isSdEligible(order)) {
      return NextResponse.json({ error: 'Pedido fuera de la cobertura interna de Santo Domingo' }, { status: 403, headers })
    }

    // Sin corte de fecha — ver nota en GET /api/v1/deliveries/orders/route.ts:
    // un route_confirmed viejo no debe "caducar" y hacer reaparecer start_route.
    const { data: recentActions } = await supabase
      .from('agent_actions')
      .select('order_id, action_type, contact_result, created_at')
      .eq('order_id', orderId)
      .in('action_type', ['route_confirmed', 'rescheduled', 'customer_declined', 'contacted'])
      .order('created_at', { ascending: false })

    const latest = reduceLatestActions(recentActions ?? []).get(orderId)
    const pool = computePool(order)
    const status = computeStatus(order, pool, latest)
    const ownership = computeOwnership(order.assigned_to, user.id, profile.role)
    const allowedActions = computeAllowedActions(status, pool, ownership)

    // --- paid: idempotencia operativa. Un segundo intento de pago (doble
    // tap, refresh que reenvía, etc.) no debe crear otra fila en
    // agent_actions ni volver a invocar el side-effect de Shopify — responde
    // 200 con el estado ya pagado y allowedActions sin 'paid'. Se lee
    // order.payment_status directamente (ya viene en ORDER_FIELDS) — sin
    // heurísticas ni consulta adicional; markOrderPaid() más abajo tiene
    // además su propio guard atómico para el caso de carrera. ---
    if (body.action === 'paid' && ownership !== 'other' && order.payment_status === 'paid') {
      return NextResponse.json({
        action: 'paid',
        orderId,
        status,
        allowedActions: withoutPaidAction(allowedActions, true),
        assignedTo: order.assigned_to,
        paymentStatus: 'paid' as const,
        alreadyPaid: true,
        at: new Date().toISOString(),
      }, { status: 200, headers })
    }

    // --- customer_cancelled: idempotencia operativa — mismo patrón que
    // 'paid' arriba. Tras una cancelación exitosa, computeStatus() ya
    // devuelve 'cancelado' y computeAllowedActions() ya no incluye
    // 'customer_cancelled' — sin este atajo, un doble tap del mensajero
    // caería en el guard genérico de abajo (`!allowedActions.includes`) y
    // respondería 422, aunque el resultado que el mensajero quería ya esté
    // logrado. Exige AMBOS campos del eje comercial coherentes
    // (confirmation_status='cancelled' Y customer_confirmed=false) — no
    // basta con uno solo — para no confundir "ya cancelado de verdad" con
    // el estado legacy inconsistente que el bloque de abajo repara (fila
    // customer_declined existente pero confirmation_status todavía
    // 'confirmed': ese caso NO debe tomar este atajo, debe repararse). Se
    // lee directamente de ORDER_FIELDS — sin heurísticas ni consulta
    // adicional. ---
    if (
      body.action === 'customer_cancelled' && ownership !== 'other' &&
      order.confirmation_status === 'cancelled' && order.customer_confirmed === false
    ) {
      return NextResponse.json({
        action: 'customer_cancelled',
        orderId,
        status,
        allowedActions,
        assignedTo: order.assigned_to,
        alreadyCancelled: true,
        at: new Date().toISOString(),
      }, { status: 200, headers })
    }

    // --- accept: caso especial de concurrencia (409), no encaja en el flujo genérico ---
    if (body.action === 'accept') {
      if (ownership === 'mine') {
        return NextResponse.json({
          action: 'accept', orderId, status, allowedActions, assignedTo: order.assigned_to, at: new Date().toISOString(),
        }, { status: 200, headers })
      }
      if (ownership === 'other') {
        return NextResponse.json({ error: 'Este pedido ya fue tomado por otro mensajero.' }, { status: 409, headers })
      }
      if (!allowedActions.includes('accept')) {
        return NextResponse.json({ error: 'No se puede aceptar un pedido en este estado.' }, { status: 422, headers })
      }

      const now = new Date().toISOString()
      const { data: claimed, error: claimError } = await supabase
        .from('orders')
        .update({ assigned_to: user.id, assigned_by: profile.id, assigned_at: now })
        .eq('id', orderId)
        .is('assigned_to', null)
        .select('id')

      if (claimError) throw claimError

      if (!claimed || claimed.length === 0) {
        // Perdió la carrera — alguien más lo tomó entre el fetch y el UPDATE.
        const { data: fresh } = await supabase.from('orders').select('assigned_to').eq('id', orderId).single()
        if (fresh?.assigned_to === user.id) {
          // Aceptado en un request concurrente del mismo usuario — idempotente.
        } else {
          return NextResponse.json({ error: 'Este pedido ya fue tomado por otro mensajero.' }, { status: 409, headers })
        }
      } else {
        await supabase.from('order_assignments').insert({
          order_id: orderId, assigned_to: user.id, assigned_by: profile.id, reason: 'Aceptado por mensajero SD (Ruta COD)',
        })
      }

      const { data: action } = await supabase
        .from('agent_actions')
        .insert({ order_id: orderId, agent_id: profile.id, action_type: 'status_updated', notes: 'Pedido aceptado por mensajero SD (Ruta COD)' })
        .select('id, created_at').single()

      const newAllowed = computeAllowedActions(status, pool, 'mine')
      return NextResponse.json({
        action: 'accept', orderId, status, allowedActions: newAllowed, assignedTo: user.id,
        actionId: action?.id, at: action?.created_at ?? now,
      }, { status: 201, headers })
    }

    // --- resto de acciones: requieren ser dueño (o admin) y una transición válida ---
    if (ownership === 'other') {
      return NextResponse.json({ error: 'Este pedido está asignado a otro mensajero.' }, { status: 403, headers })
    }
    if (!allowedActions.includes(body.action)) {
      // Excepción puntual: 'customer_cancelled' sobre un pedido con un
      // registro operativo de rechazo ya existente (agent_actions.
      // customer_declined) cuyo eje comercial NUNCA se sincronizó —
      // estado legacy inconsistente (bug anterior a las migraciones
      // 060/061, o creado por /sd-delivery legacy, que todavía inserta
      // ese action_type sin pasar por applyConfirmationAction()). No
      // confiar en computeAllowedActions() para este caso puntual: su
      // cálculo de `status` ya ve 'cancelado' por esa misma fila
      // (sd-status.ts revisa customer_declined ANTES que cualquier otra
      // cosa) y por eso NUNCA volvería a ofrecer 'customer_cancelled' en
      // allowedActions — el pedido quedaría atrapado sin reparación
      // posible. Se permite reintentar la transición explícitamente; el
      // motor comercial (RPC, con fromRutaCod=true) revalida sus propios
      // guards de negocio de todas formas, así que esto nunca sortea una
      // regla real, solo el gate de workflow de esta máquina de estados.
      const isLegacyCommercialRepair =
        body.action === 'customer_cancelled' &&
        order.confirmation_status !== 'cancelled' &&
        (recentActions ?? []).some(a => a.action_type === 'customer_declined')

      if (!isLegacyCommercialRepair) {
        return NextResponse.json({ error: `La acción "${body.action}" no es válida desde el estado actual (${status}).` }, { status: 422, headers })
      }
    }

    // Auto-claim: si el pedido estaba disponible (assigned_to NULL, backlog previo
    // a esta funcionalidad) y el mensajero actúa sobre él, queda asignado a quien
    // lo trabaja — preserva la compatibilidad con pedidos ya en curso sin dueño.
    if (ownership === 'unassigned' && profile.role !== 'admin') {
      await supabase
        .from('orders')
        .update({ assigned_to: user.id, assigned_by: profile.id, assigned_at: new Date().toISOString() })
        .eq('id', orderId)
        .is('assigned_to', null)
    }

    let actionType = 'status_updated'
    let contactResult: string | null = null
    let notes: string | null = body.note ?? null

    switch (body.action) {
      case 'ready_for_route': {
        const result = await applyConfirmationAction({
          supabase, orderId, action: 'confirmed', method: 'call', userId: profile.id,
        })
        if (!result.ok) {
          return NextResponse.json({ error: 'No se pudo confirmar el pedido.' }, { status: 422, headers })
        }
        // applyConfirmationAction ya registra su propia auditoría (local_dispatched
        // cuando aplica) — no insertamos un agent_action genérico duplicado aquí.
        break
      }

      case 'start_route': {
        actionType = 'route_confirmed'
        const { data: action, error: insertError } = await supabase
          .from('agent_actions')
          .insert({ order_id: orderId, agent_id: profile.id, action_type: actionType, notes })
          .select('id, created_at').single()
        if (insertError) throw insertError

        if (order.shopify_order_id && order.source === 'shopify_webhook') {
          const fulfillResult = await createLocalFulfillment(order.shopify_order_id, order.tracking_number ?? null)
          await logShopifySync(supabase, {
            orderId, shopifyOrderId: order.shopify_order_id, eventType: 'fulfillment',
            result: fulfillResult, triggeredBy: profile.id, actionType,
          })
        }
        break
      }

      case 'delivered': {
        // Entregado NO implica pagado — son dos hechos distintos que el
        // mensajero confirma por separado (regla aprobada). El cobro se
        // registra únicamente vía la acción 'paid' (case aparte, más abajo).
        // markSdOrderDelivered ya no toca pagos en absoluto — ver
        // src/lib/deliveries/mark-delivered.ts.
        actionType = 'delivered'
        notes = 'Entregado por mensajero SD (Ruta COD)'
        await markSdOrderDelivered(supabase, orderId, profile.id, { notes })
        break
      }

      case 'paid': {
        // Único punto de escritura para "cobrado": delega en markOrderPaid()
        // (src/lib/orders/mark-paid.ts) — el mismo motor que ya usa
        // POST /api/orders/[id]/mark-paid (Confirmación/Confirmados). Un solo
        // helper actualiza orders.payment_status/paid_at/paid_by, inserta una
        // única fila en agent_actions (action_type='paid') y sincroniza
        // Shopify una sola vez — nunca se reimplementa ese UPDATE aquí. Solo
        // alcanzable cuando status='entregado' (ver computeAllowedActions) y
        // el guard de arriba (antes del switch) ya filtra el caso "ya
        // pagado" — markOrderPaid es además idempotente por su cuenta
        // (columna payment_status + guard atómico), así que un segundo
        // intento que sí llegue hasta aquí (carrera) tampoco duplica nada.
        actionType = 'paid'
        notes = `COD cobrado — RD$${body.amountCollected ?? order.cod_amount ?? 0} (Ruta COD)`
        await markOrderPaid(
          supabase,
          {
            id: order.id,
            payment_status: order.payment_status,
            shopify_order_id: order.shopify_order_id,
            source: order.source,
          },
          profile.id,
          {
            triggeredBy: profile.id,
            triggeredAction: 'paid',
            notes,
          },
        )
        break
      }

      case 'no_response': {
        actionType = 'contacted'
        contactResult = 'no_answer'
        const { data: action, error: insertError } = await supabase
          .from('agent_actions')
          .insert({ order_id: orderId, agent_id: profile.id, action_type: actionType, contact_result: contactResult, notes })
          .select('id, created_at').single()
        if (insertError) throw insertError
        break
      }

      case 'reschedule': {
        actionType = 'rescheduled'
        const [{ error: updateError }, { data: action, error: insertError }] = await Promise.all([
          supabase.from('orders').update({
            rescheduled_date: body.rescheduledFor, rescheduled_note: notes,
          }).eq('id', orderId),
          supabase.from('agent_actions')
            .insert({ order_id: orderId, agent_id: profile.id, action_type: actionType, notes })
            .select('id, created_at').single(),
        ])
        if (updateError) throw updateError
        if (insertError) throw insertError
        break
      }

      case 'customer_cancelled': {
        // Reutiliza el motor comercial único (applyConfirmationAction() →
        // cancel_confirmed_order(), migraciones 060/061) en vez de escribir
        // agent_actions directamente. Antes, esta acción solo insertaba
        // 'customer_declined' sin tocar confirmation_status/customer_confirmed
        // — el pedido quedaba operativamente cancelado pero comercialmente
        // 'confirmed' (auditoría customer_cancelled, 2026-08-08). Se pasa
        // `authClient` (el cliente de sesión del mensajero, NO el `supabase`
        // de service role usado en el resto de este handler): la RPC deriva
        // el actor de auth.uid() dentro de la función — con el service
        // client auth.uid() sería NULL y devolvería 'forbidden'. Mismo
        // motor que ya usa POST /api/orders/[id]/confirmation (agente
        // humano en /confirmacion) — no se crea un segundo motor de
        // cancelación. fromRutaCod:true — ver el parámetro p_from_ruta_cod
        // en la migración 061: Ruta COD necesita agent_actions
        // (customer_declined) sin condicionar a normalized_status='en_reparto'
        // (a diferencia de /confirmacion), porque también cancela pedidos
        // SD aún sin despachar.
        const result = await applyConfirmationAction({
          supabase: authClient, orderId, action: 'cancelled', method: 'call', userId: profile.id,
          fromRutaCod: true,
        })
        if (!result.ok) {
          return NextResponse.json({ error: 'No se pudo cancelar el pedido.' }, { status: 422, headers })
        }
        break
      }

      case 'incident': {
        actionType = 'note_added'
        notes = `Incidencia: ${body.note!.trim()}`
        const { data: action, error: insertError } = await supabase
          .from('agent_actions')
          .insert({ order_id: orderId, agent_id: profile.id, action_type: actionType, notes })
          .select('id, created_at').single()
        if (insertError) throw insertError
        break
      }

      case 'release': {
        // Quitar de mi ruta / liberar pedido — no borra nada, solo
        // desasigna assigned_to. El pedido vuelve al pool sin dueño y
        // queda visible/auditable en agent_actions. La comprobación de
        // ownership ('mine') ya se validó arriba vía allowedActions.
        actionType = 'status_updated'
        notes = notes ?? 'Pedido liberado por mensajero (quitar de mi ruta)'
        const { error: releaseError } = await supabase
          .from('orders')
          .update({ assigned_to: null })
          .eq('id', orderId)
        if (releaseError) throw releaseError

        const { data: action, error: insertError } = await supabase
          .from('agent_actions')
          .insert({ order_id: orderId, agent_id: profile.id, action_type: actionType, notes })
          .select('id, created_at').single()
        if (insertError) throw insertError
        break
      }
    }

    // Recomputar estado tras la acción — vuelve a leer el pedido y las
    // acciones recientes en vez de tratar de derivarlo en memoria, para que
    // la respuesta siempre refleje lo que realmente quedó en DB.
    const { data: freshOrderData } = await supabase.from('orders').select(ORDER_FIELDS).eq('id', orderId).single()
    const freshOrder = (freshOrderData ?? order) as unknown as OrderRow
    const { data: freshActions } = await supabase
      .from('agent_actions')
      .select('order_id, action_type, contact_result, created_at')
      .eq('order_id', orderId)
      .in('action_type', ['route_confirmed', 'rescheduled', 'customer_declined', 'contacted'])
      .order('created_at', { ascending: false })

    const freshLatest = reduceLatestActions(freshActions ?? []).get(orderId)
    const freshPool = computePool(freshOrder)
    const freshStatus = computeStatus(freshOrder, freshPool, freshLatest)
    const freshOwnership = computeOwnership(freshOrder.assigned_to, user.id, profile.role)
    let freshAllowed = computeAllowedActions(freshStatus, freshPool, freshOwnership)

    // paymentStatus solo aplica a pedidos entregados — para el resto queda
    // undefined (no hay nada que reportar). Recién ejecutado 'paid' arriba,
    // freshOrder ya refleja el UPDATE síncrono que hizo markOrderPaid().
    let paymentStatus: 'pending' | 'paid' | undefined
    if (freshStatus === 'entregado') {
      paymentStatus = freshOrder.payment_status
      freshAllowed = withoutPaidAction(freshAllowed, paymentStatus === 'paid')
    }

    const zone = detectSdZone(freshOrder.city, freshOrder.province, freshOrder.customer_address)

    return NextResponse.json({
      action: body.action,
      orderId,
      status: freshStatus,
      allowedActions: freshAllowed,
      assignedTo: freshOrder.assigned_to,
      zone: { id: zone.id, label: zone.label },
      rescheduledFor: freshOrder.rescheduled_date,
      rescheduledNote: freshOrder.rescheduled_note,
      paymentStatus,
      at: new Date().toISOString(),
    }, { status: 201, headers })
  } catch (err) {
    console.error('[POST /api/v1/deliveries/orders/[id]/actions]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500, headers })
  }
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}
