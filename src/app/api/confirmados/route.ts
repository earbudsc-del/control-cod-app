import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isSantoDomingoOrder } from '@/lib/alert-helpers'

// Santo Domingo is UTC-4 (no DST).
// Midnight RD = 04:00 UTC.
function rdDayBounds(daysAgo = 0): { start: string; end: string } {
  const now = new Date()
  const dateStrRD = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  const [y, m, d] = dateStrRD.split('-').map(Number)
  const startUTC = new Date(Date.UTC(y, m - 1, d - daysAgo, 4, 0, 0, 0))
  const endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { start: startUTC.toISOString(), end: endUTC.toISOString() }
}

const SD_POR_COBRAR_FIELDS =
  'id, order_number, shopify_order_id, customer_name, customer_phone, customer_address, ' +
  'city, province, product_summary, cod_amount, normalized_status, payment_status, ' +
  'tracking_number, status_since, created_at, is_test, archived_at'

const ENTREGADOS_FIELDS =
  'id, order_number, shopify_order_id, customer_name, customer_phone, customer_address, ' +
  'city, province, product_summary, cod_amount, normalized_status, payment_status, ' +
  'paid_at, paid_by, tracking_number, created_at, is_test, archived_at'

interface SdPorCobrarRow {
  id: string
  order_number: string | null
  shopify_order_id: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_address: string | null
  city: string | null
  province: string | null
  product_summary: string | null
  cod_amount: number | null
  normalized_status: string
  payment_status: string
  tracking_number: string | null
  status_since: string | null
  created_at: string
  is_test: boolean
  archived_at: string | null
}

interface EntregadoRow {
  id: string
  order_number: string | null
  shopify_order_id: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_address: string | null
  city: string | null
  province: string | null
  product_summary: string | null
  cod_amount: number | null
  normalized_status: string
  payment_status: string
  paid_at: string | null
  paid_by: string | null
  tracking_number: string | null
  created_at: string
  is_test: boolean
  archived_at: string | null
}

// GET /api/confirmados?tab=sd_por_cobrar
// Pedidos SD local ya despachados/entregados con el cobro aún pendiente.
// Único origen de datos del botón "Pagado" en este módulo.
async function handleSdPorCobrar(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data, error } = await supabase
    .from('orders')
    .select(SD_POR_COBRAR_FIELDS)
    .is('tracking_number', null)
    .in('normalized_status', ['en_reparto', 'delivered'])
    .eq('payment_status', 'pending')
    .is('archived_at', null)
    .eq('is_test', false)
    .order('status_since', { ascending: true, nullsFirst: false })
    .limit(500)

  if (error) throw error

  const orders = (data ?? []) as unknown as SdPorCobrarRow[]

  // Doble-guarda cliente-side — en_reparto+sin tracking ya es SD por invariante
  // del sistema, pero se re-verifica por si algún dato queda inconsistente.
  const rows = orders.filter(o => isSantoDomingoOrder(o.city, o.province, o.customer_address))

  return NextResponse.json({ data: rows, count: rows.length })
}

// GET /api/confirmados?tab=entregados
// Pedidos SD local ya entregados Y pagados. "Mensajero" y "fecha de entrega"
// se derivan de agent_actions (action_type='delivered') — NO existen
// delivered_at/delivered_by como columnas (ver 046_orders_payment_status.sql).
// "Fecha de pago" y "usuario que confirmó el pago" sí son columnas directas
// (paid_at/paid_by). 3 queries totales sin importar cuántas filas — sin N+1.
async function handleEntregados(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data, error } = await supabase
    .from('orders')
    .select(ENTREGADOS_FIELDS)
    .is('tracking_number', null)
    .eq('normalized_status', 'delivered')
    .eq('payment_status', 'paid')
    .is('archived_at', null)
    .eq('is_test', false)
    .order('paid_at', { ascending: false, nullsFirst: false })
    .limit(500)

  if (error) throw error

  const orders = (data ?? []) as unknown as EntregadoRow[]
  const rows = orders.filter(o => isSantoDomingoOrder(o.city, o.province, o.customer_address))
  const orderIds = rows.map(o => o.id)

  // Query 2: último evento 'delivered' por pedido (agente + fecha de entrega).
  const { data: deliveredActions } = orderIds.length > 0
    ? await supabase
        .from('agent_actions')
        .select('order_id, agent_id, created_at')
        .eq('action_type', 'delivered')
        .in('order_id', orderIds)
        .order('created_at', { ascending: false })
    : { data: [] as { order_id: string; agent_id: string | null; created_at: string }[] }

  // Primera fila (created_at DESC) por order_id = evento delivered más reciente
  const deliveredByOrder = new Map<string, { agentId: string | null; at: string }>()
  for (const a of deliveredActions ?? []) {
    if (!deliveredByOrder.has(a.order_id)) {
      deliveredByOrder.set(a.order_id, { agentId: a.agent_id, at: a.created_at })
    }
  }

  // Query 3: una sola consulta a profiles con la unión de paid_by + agentes
  // que entregaron — evita el N+1 de resolver nombre por fila.
  const profileIds = new Set<string>()
  for (const o of rows) if (o.paid_by) profileIds.add(o.paid_by)
  for (const d of deliveredByOrder.values()) if (d.agentId) profileIds.add(d.agentId)

  const { data: profilesData } = profileIds.size > 0
    ? await supabase.from('profiles').select('id, full_name').in('id', [...profileIds])
    : { data: [] as { id: string; full_name: string | null }[] }

  const profileNameById = new Map<string, string | null>((profilesData ?? []).map(p => [p.id, p.full_name]))

  const enriched = rows.map(o => {
    const delivered = deliveredByOrder.get(o.id)
    return {
      ...o,
      delivered_at:      delivered?.at ?? null,
      delivered_by_name: delivered?.agentId ? (profileNameById.get(delivered.agentId) ?? null) : null,
      paid_by_name:      o.paid_by ? (profileNameById.get(o.paid_by) ?? null) : null,
    }
  })

  return NextResponse.json({ data: enriched, count: enriched.length })
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    const canView = profile?.role === 'admin' || profile?.role === 'dispatch_agent'
    if (!canView) return NextResponse.json({ error: 'Sin permisos para ver confirmados' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const tab = searchParams.get('tab') // 'sd_por_cobrar' | 'entregados' | null (vista default)

    if (tab === 'sd_por_cobrar') return await handleSdPorCobrar(supabase)
    if (tab === 'entregados')    return await handleEntregados(supabase)

    const filter = searchParams.get('filter') // 'hoy' | 'ayer' | 'recuperados'
    const from   = searchParams.get('from')
    const to     = searchParams.get('to')

    const hoy  = rdDayBounds(0)
    const ayer = rdDayBounds(1)

    // Stats: confirmados sin guía por día (útil para saber cuántos quedaron pendientes)
    const [statsHoyRes, statsAyerRes] = await Promise.all([
      supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'confirmed')
        .is('tracking_number', null)
        .neq('normalized_status', 'en_reparto')
        .gte('last_confirmation_attempt', hoy.start)
        .lte('last_confirmation_attempt', hoy.end),
      supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('confirmation_status', 'confirmed')
        .is('tracking_number', null)
        .neq('normalized_status', 'en_reparto')
        .gte('last_confirmation_attempt', ayer.start)
        .lte('last_confirmation_attempt', ayer.end),
    ])

    // Pedidos confirmados SIN guía asignada todavía.
    // Excluye en_reparto: son pedidos SD local ya despachados que siguen sin tracking EFI.
    let query = supabase
      .from('orders')
      .select('id, order_number, shopify_order_id, customer_name, customer_phone, customer_address, city, province, product_summary, cod_amount, confirmation_method, last_confirmation_attempt, created_at, duplicate_alert, duplicate_of_order_id, duplicate_reason')
      .eq('confirmation_status', 'confirmed')
      .is('tracking_number', null)
      .neq('normalized_status', 'delivered')
      .neq('normalized_status', 'returned')
      .neq('normalized_status', 'en_reparto')
      .order('last_confirmation_attempt', { ascending: false, nullsFirst: false })
      .limit(200)

    // Para el filtro 'recuperados' obtenemos primero los shopify_order_ids recuperados
    if (filter === 'recuperados') {
      const { data: recoveredCarts } = await supabase
        .from('abandoned_carts')
        .select('recovered_order_id')
        .eq('recovery_status', 'recovered')
        .not('recovered_order_id', 'is', null)
        .limit(500)

      const recoveredIds = (recoveredCarts ?? [])
        .map(c => c.recovered_order_id)
        .filter(Boolean) as string[]

      if (recoveredIds.length === 0) {
        // No hay carritos recuperados → devolver vacío
        return NextResponse.json({
          data:  [],
          stats: {
            confirmados_hoy:  statsHoyRes.count  ?? 0,
            confirmados_ayer: statsAyerRes.count ?? 0,
            recuperados:      0,
          },
        })
      }

      query = query.in('shopify_order_id', recoveredIds)
    } else if (filter === 'hoy') {
      query = query.gte('last_confirmation_attempt', hoy.start).lte('last_confirmation_attempt', hoy.end)
    } else if (filter === 'ayer') {
      query = query.gte('last_confirmation_attempt', ayer.start).lte('last_confirmation_attempt', ayer.end)
    } else if (from && to) {
      query = query.gte('last_confirmation_attempt', from).lte('last_confirmation_attempt', to)
    }

    const { data, error } = await query
    if (error) throw error

    const orders = data ?? []

    // Enriquecer con info de carrito abandonado recuperado
    let enriched = orders as (typeof orders[0] & {
      recovered_cart_id: string | null
      recovered_cart_source: string | null
    })[]

    if (orders.length > 0) {
      const shopifyIds = orders
        .map(o => o.shopify_order_id)
        .filter((id): id is string => !!id)

      if (shopifyIds.length > 0) {
        const { data: carts } = await supabase
          .from('abandoned_carts')
          .select('id, source, recovered_order_id')
          .in('recovered_order_id', shopifyIds)
          .eq('recovery_status', 'recovered')

        const cartMap: Record<string, { id: string; source: string }> = {}
        for (const cart of carts ?? []) {
          if (cart.recovered_order_id) {
            cartMap[cart.recovered_order_id] = { id: cart.id, source: cart.source }
          }
        }

        enriched = orders.map(o => ({
          ...o,
          recovered_cart_id:     o.shopify_order_id ? (cartMap[o.shopify_order_id]?.id ?? null)     : null,
          recovered_cart_source: o.shopify_order_id ? (cartMap[o.shopify_order_id]?.source ?? null) : null,
        }))
      } else {
        enriched = orders.map(o => ({ ...o, recovered_cart_id: null, recovered_cart_source: null }))
      }
    }

    const recuperadosCount = enriched.filter(o => o.recovered_cart_id !== null).length

    return NextResponse.json({
      data:  enriched,
      stats: {
        confirmados_hoy:  statsHoyRes.count  ?? 0,
        confirmados_ayer: statsAyerRes.count ?? 0,
        recuperados:      recuperadosCount,
      },
    })
  } catch (err) {
    console.error('[GET /api/confirmados]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
