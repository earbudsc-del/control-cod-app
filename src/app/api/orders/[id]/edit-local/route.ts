import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isSantoDomingoOrder } from '@/lib/alert-helpers'

// POST /api/orders/[id]/edit-local
//
// Edición operativa de dirección/producto/monto COD para pedidos del flujo
// LOCAL Santo Domingo, cuando el cliente cambia de opinión después de
// confirmar (nueva dirección, nueva oferta/2x1, nuevo monto a pagar).
//
// Exclusivo del flujo SD local — nunca toca pedidos con guía EFI/Gintracom
// (tracking_number != null) ni sincroniza nada con Shopify o EFI. La
// zona/sector se derivan siempre en tiempo real desde
// customer_address/city/province (ver detectSdZone() en
// src/lib/sd-zones.ts) — nunca se persisten, así que el UPDATE de la RPC
// ya deja la clasificación de zona coherente sin ningún recálculo aparte.
//
// La escritura real (UPDATE orders + INSERT notes + INSERT agent_actions,
// atómico) vive en la función `edit_local_sd_order` — ver
// supabase/migrations/063_edit_local_sd_order_rpc.sql. Este endpoint solo:
//   1. Autentica y valida rol (defensa en profundidad — la RPC revalida
//      el rol otra vez, bajo lock, así que el rechazo real no depende de
//      este chequeo).
//   2. Hace el precheck de elegibilidad SD (isSantoDomingoOrder — lógica
//      que SOLO existe en TypeScript, nunca se duplica en SQL) sobre una
//      lectura fresca del pedido.
//   3. Limpia el body y arma los parámetros de la RPC (qué campos se
//      piden cambiar y a qué valor).
//   4. Llama UNA sola vez a la RPC, con el cliente de sesión autenticada
//      (nunca el service client — la RPC es SECURITY INVOKER y depende
//      de auth.uid()).
//   5. Mapea el outcome de la RPC a HTTP status + reason.
//
// Sticker (normalizeOrderLabel) y Ruta COD (GET /api/v1/deliveries/orders)
// leen customer_address/city/province/product_summary/cod_amount en vivo
// desde `orders` en cada request — no hay caché ni copia a actualizar.

const ALLOWED_ROLES = ['admin', 'dispatch_agent', 'confirmation_agent']

const ORDER_FIELDS =
  'id, store_id, order_number, customer_address, city, province, product_summary, ' +
  'cod_amount, tracking_number, normalized_status, payment_status'

interface OrderRow {
  id: string
  store_id: string
  order_number: string | null
  customer_address: string | null
  city: string | null
  province: string | null
  product_summary: string | null
  cod_amount: number | null
  tracking_number: string | null
  normalized_status: string
  payment_status: 'pending' | 'paid' | null
}

interface EditBody {
  customer_address?: unknown
  city?: unknown
  province?: unknown
  product_summary?: unknown
  cod_amount?: unknown
}

const TERMINAL_STATUSES = new Set(['delivered', 'returned'])

// undefined = campo no provisto (no tocar) · null = provisto pero vacío
function cleanString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed.length === 0 ? null : trimmed
}

// Mapeo de outcomes de la RPC → HTTP status + mensaje. 'ok' se maneja
// aparte (no es un error). Cualquier outcome no listado aquí (no debería
// ocurrir nunca — la RPC solo devuelve estos + 'ok') cae al 500 genérico.
const OUTCOME_MAP: Record<string, { status: number; error: string }> = {
  not_found: {
    status: 404,
    error: 'Pedido no encontrado',
  },
  forbidden: {
    status: 403,
    error: 'Sin permisos para editar este pedido',
  },
  has_tracking: {
    status: 422,
    error: 'Este pedido tiene guía EFI/Gintracom asignada — no se puede editar desde aquí.',
  },
  already_paid: {
    status: 422,
    error: 'No se puede editar un pedido que ya fue pagado.',
  },
  terminal_status: {
    status: 422,
    error: 'No se puede editar un pedido ya entregado o devuelto.',
  },
  conflict: {
    status: 409,
    error: 'El pedido cambió mientras lo editabas. Actualiza la información e inténtalo nuevamente.',
  },
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params

    const authClient = await createClient()
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'No autorizado', reason: 'forbidden' }, { status: 401 })
    }

    const { data: profile } = await authClient
      .from('profiles').select('id, role, store_id').eq('id', user.id).single()

    if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
      return NextResponse.json(
        { error: 'Sin permisos para editar pedidos', reason: 'forbidden' },
        { status: 403 },
      )
    }

    let body: EditBody
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 })
    }

    // Precheck — lectura fresca con el cliente de sesión (RLS: mismo
    // store). Esta MISMA fila es la que se le pasa a la RPC como
    // "expected_*" — la RPC revalida bajo lock que nadie la movió entre
    // esta lectura y la ejecución de la transacción (ver 'conflict' abajo).
    const { data: orderData } = await authClient
      .from('orders')
      .select(ORDER_FIELDS)
      .eq('id', id)
      .single()

    if (!orderData) {
      return NextResponse.json({ error: 'Pedido no encontrado', reason: 'not_found' }, { status: 404 })
    }
    const order = orderData as unknown as OrderRow

    if (order.store_id !== profile.store_id) {
      return NextResponse.json({ error: 'Sin acceso a este pedido', reason: 'forbidden' }, { status: 403 })
    }

    if (order.tracking_number !== null) {
      return NextResponse.json({
        error: 'Este pedido tiene guía EFI/Gintracom asignada — no se puede editar desde aquí.',
        reason: 'has_tracking',
      }, { status: 422 })
    }

    // Elegibilidad SD local: SOLO se evalúa aquí, en TypeScript, sobre la
    // lectura fresca de arriba — nunca se reproduce en SQL (ver comentario
    // de cabecera de la migración 063).
    if (!isSantoDomingoOrder(order.city, order.province, order.customer_address)) {
      return NextResponse.json({
        error: 'La edición solo está disponible para pedidos del flujo local de Santo Domingo.',
        reason: 'not_sd_local',
      }, { status: 422 })
    }

    if (TERMINAL_STATUSES.has(order.normalized_status)) {
      return NextResponse.json({
        error: `No se puede editar un pedido en estado "${order.normalized_status}".`,
        reason: 'terminal_status',
      }, { status: 422 })
    }

    if (order.payment_status === 'paid') {
      return NextResponse.json({
        error: 'No se puede editar un pedido que ya fue pagado.',
        reason: 'already_paid',
      }, { status: 422 })
    }

    // Solo estos cinco campos pueden llegar a la RPC — ningún otro dato
    // del body se lee ni se reenvía.
    let setAddress = false; let addressVal: string | null = null
    if ('customer_address' in body) {
      const next = cleanString(body.customer_address)
      if (next !== undefined) { setAddress = true; addressVal = next }
    }
    let setCity = false; let cityVal: string | null = null
    if ('city' in body) {
      const next = cleanString(body.city)
      if (next !== undefined) { setCity = true; cityVal = next }
    }
    let setProvince = false; let provinceVal: string | null = null
    if ('province' in body) {
      const next = cleanString(body.province)
      if (next !== undefined) { setProvince = true; provinceVal = next }
    }
    let setProduct = false; let productVal: string | null = null
    if ('product_summary' in body) {
      const next = cleanString(body.product_summary)
      if (next !== undefined) { setProduct = true; productVal = next }
    }
    let setCod = false; let codVal: number | null = null
    if ('cod_amount' in body && body.cod_amount !== undefined && body.cod_amount !== null && body.cod_amount !== '') {
      const raw = body.cod_amount
      const next = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(next) || next < 0) {
        return NextResponse.json({ error: 'Monto COD inválido' }, { status: 400 })
      }
      setCod = true; codVal = next
    }

    if (!setAddress && !setCity && !setProvince && !setProduct && !setCod) {
      return NextResponse.json({ error: 'Sin cambios para guardar' }, { status: 400 })
    }

    // Única llamada — UPDATE orders + INSERT notes + INSERT agent_actions
    // ocurren dentro de la misma transacción de Postgres (todo o nada).
    // Cliente de SESIÓN, nunca service role — la RPC es SECURITY INVOKER
    // y su identidad depende de auth.uid().
    const { data: outcome, error: rpcError } = await authClient.rpc('edit_local_sd_order', {
      p_order_id: id,
      p_expected_customer_address: order.customer_address,
      p_expected_city: order.city,
      p_expected_province: order.province,
      p_set_customer_address: setAddress,
      p_customer_address: addressVal,
      p_set_city: setCity,
      p_city: cityVal,
      p_set_province: setProvince,
      p_province: provinceVal,
      p_set_product_summary: setProduct,
      p_product_summary: productVal,
      p_set_cod_amount: setCod,
      p_cod_amount: codVal,
    })

    if (rpcError) {
      console.error(`[edit-local] RPC error order=${id}`, rpcError)
      return NextResponse.json(
        { error: 'Error interno al editar el pedido', reason: 'db_error' },
        { status: 500 },
      )
    }

    if (outcome !== 'ok') {
      const mapped = OUTCOME_MAP[outcome as string]
      if (mapped) {
        return NextResponse.json({ error: mapped.error, reason: outcome }, { status: mapped.status })
      }
      console.error(`[edit-local] outcome inesperado de la RPC order=${id} outcome=${outcome}`)
      return NextResponse.json(
        { error: 'Error interno al editar el pedido', reason: 'db_error' },
        { status: 500 },
      )
    }

    const { data: updated } = await authClient
      .from('orders')
      .select(ORDER_FIELDS)
      .eq('id', id)
      .single()

    console.log(
      `[edit-local] order=${id} order_number=${order.order_number} by=${profile.id} ` +
      `role=${profile.role} fields=${[
        setAddress && 'customer_address', setCity && 'city', setProvince && 'province',
        setProduct && 'product_summary', setCod && 'cod_amount',
      ].filter(Boolean).join(',')}`,
    )

    return NextResponse.json({ success: true, order: updated })
  } catch (err) {
    console.error('[POST /api/orders/[id]/edit-local]', err)
    return NextResponse.json({ error: 'Error interno al editar el pedido' }, { status: 500 })
  }
}
