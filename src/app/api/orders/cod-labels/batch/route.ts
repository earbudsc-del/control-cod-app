import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { normalizeOrderLabel } from '@/lib/order-label/normalize-order-label'
import { checkLabelCompleteness } from '@/lib/order-label/label-completeness'

const MAX_BATCH_SIZE = 50

// POST /api/orders/cod-labels/batch — punto único de datos para la impresión
// masiva de Sticker COD. Recibe los IDs ya seleccionados por el agente (nunca
// más de 50 por lote) y devuelve el modelo normalizado (mismo normalizeOrderLabel
// que usa la impresión individual) + un flag de completitud por pedido. Una
// sola query — nunca N GET individuales, nunca consulta a Shopify.
export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const body = await req.json().catch(() => null) as { orderIds?: unknown } | null
    const orderIds = Array.isArray(body?.orderIds) ? body.orderIds.filter((id): id is string => typeof id === 'string') : []

    if (orderIds.length === 0) {
      return NextResponse.json({ error: 'orderIds vacío' }, { status: 400 })
    }
    if (orderIds.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `Máximo ${MAX_BATCH_SIZE} pedidos por lote. Seleccionaste ${orderIds.length}.` },
        { status: 400 },
      )
    }

    // Cliente de sesión (no service role) — la RLS existente restringe por
    // store_id igual que el resto de endpoints de orders, sin ampliar permisos.
    const { data: orders, error } = await supabase
      .from('orders')
      .select('*')
      .in('id', orderIds)

    if (error) throw error

    const found = orders ?? []
    const foundIds = new Set(found.map(o => o.id))
    const notFound = orderIds.filter(id => !foundIds.has(id))

    const labels = found.map(order => {
      const { complete, missingFields } = checkLabelCompleteness(order)
      return { ...normalizeOrderLabel(order), complete, missingFields }
    })

    return NextResponse.json({ labels, notFound })
  } catch (err) {
    console.error('[POST /api/orders/cod-labels/batch]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
