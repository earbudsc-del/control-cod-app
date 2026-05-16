import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { updateOrderTracking } from '@/lib/tracking/update-order'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, tracking_number, normalized_status')
      .eq('id', id)
      .single()

    if (orderErr || !order) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })
    }
    if (!order.tracking_number?.trim()) {
      return NextResponse.json({ error: 'El pedido no tiene número de guía' }, { status: 400 })
    }

    const result = await updateOrderTracking(
      id,
      order.tracking_number,
      supabase,
      order.normalized_status,
    )

    if (!result.success) {
      const status = result.error?.includes('no encontrada') ? 404 : 502
      return NextResponse.json({ error: result.error }, { status })
    }

    return NextResponse.json({
      success:             true,
      normalized_status:   result.normalized_status,
      delivery_attempts:   result.delivery_attempts,
      last_attempt_reason: result.last_attempt_reason,
    })
  } catch (err) {
    console.error('[POST /api/orders/[id]/tracking]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
