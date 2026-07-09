import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  applyConfirmationAction,
  type ConfirmAction,
  type ConfirmMethod,
} from '@/lib/orders/confirmation'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { action, method = 'other' } = await req.json() as {
      action: ConfirmAction
      method?: ConfirmMethod
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const result = await applyConfirmationAction({
      supabase,
      orderId: id,
      action,
      method,
      userId: user.id,
    })

    if (!result.ok) {
      if (result.reason === 'not_found') {
        return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })
      }
      return NextResponse.json({ error: 'Error interno' }, { status: 500 })
    }

    return NextResponse.json({
      success:                 true,
      confirmation_attempts:   result.confirmation_attempts,
      confirmation_status:     result.confirmation_status,
      confirmation_confidence: result.confirmation_confidence,
      auto_dispatched:         result.auto_dispatched,
    })
  } catch (err) {
    console.error('[POST /api/orders/[id]/confirmation]', err)
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: 'Error interno', detail: msg }, { status: 500 })
  }
}
