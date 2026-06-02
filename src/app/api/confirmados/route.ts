import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

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
