import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'

const ALLOWED_ROLES = ['admin', 'ia_supervisor', 'confirmation_agent'] as const

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
    if (!ALLOWED_ROLES.includes(profile?.role as never)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const { data: cart, error } = await supabase
      .from('abandoned_carts')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !cart) {
      return NextResponse.json({ error: 'Carrito no encontrado' }, { status: 404 })
    }

    // Fetch basic order info if the cart was auto-recovered via webhook
    let recoveredOrder: { id: string; tracking_number: string; order_number: string | null } | null = null
    if (cart.recovered_order_id) {
      const { data: order } = await supabase
        .from('orders')
        .select('id, tracking_number, order_number')
        .eq('id', cart.recovered_order_id)
        .maybeSingle()
      recoveredOrder = order ?? null
    }

    return NextResponse.json({ cart, recoveredOrder })
  } catch (err) {
    console.error('[GET /api/abandoned-carts/[id]]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
