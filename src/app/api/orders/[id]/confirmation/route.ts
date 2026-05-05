import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

type ConfirmAction = 'confirmed' | 'no_answer' | 'wrong_number' | 'cancelled' | 'no_coverage'
type ConfirmMethod = 'call' | 'whatsapp' | 'other'

const MAX_ATTEMPTS = 3

function computeConfidence(
  action: ConfirmAction,
  method: ConfirmMethod,
  newAttempts: number,
  duplicateAlert: boolean,
): string {
  if (action === 'confirmed') {
    if (method === 'call') return duplicateAlert ? 'medium' : 'high'
    // whatsapp o other: duplicado baja a low
    return duplicateAlert ? 'low' : 'medium'
  }
  if (action === 'no_answer') return newAttempts >= MAX_ATTEMPTS ? 'risky' : 'low'
  // wrong_number, cancelled
  return 'risky'
}

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

    const { data: order } = await supabase
      .from('orders')
      .select('confirmation_attempts, duplicate_alert')
      .eq('id', id)
      .single()

    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })

    const attempts   = (order.confirmation_attempts ?? 0) + 1
    const confidence = computeConfidence(action, method, attempts, !!order.duplicate_alert)

    const updates: Record<string, unknown> = {
      confirmation_attempts:     attempts,
      last_confirmation_attempt: new Date().toISOString(),
      confirmation_method:       method,
      confirmation_confidence:   confidence,
    }

    switch (action) {
      case 'confirmed':
        updates.confirmation_status   = 'confirmed'
        updates.customer_confirmed    = true
        updates.customer_confirmed_at = new Date().toISOString()
        break
      case 'no_answer':
        if (attempts >= MAX_ATTEMPTS) updates.confirmation_status = 'unreachable'
        break
      case 'wrong_number':
        updates.confirmation_status = 'unreachable'
        break
      case 'cancelled':
        updates.confirmation_status = 'cancelled'
        break
      case 'no_coverage':
        updates.confirmation_status = 'no_coverage'
        break
    }

    const { error } = await supabase.from('orders').update(updates).eq('id', id)
    if (error) {
      console.error('[confirmation] Supabase update error — action:', action, '| code:', error.code, '| message:', error.message, '| details:', error.details)
      throw error
    }

    if (action === 'no_coverage') {
      await supabase.from('notes').insert({
        order_id:   id,
        created_by: user.id,
        content:    'Pedido marcado como Sin cobertura',
      })
    }

    return NextResponse.json({
      success:                 true,
      confirmation_attempts:   attempts,
      confirmation_status:     updates.confirmation_status ?? 'pending',
      confirmation_confidence: confidence,
    })
  } catch (err) {
    console.error('[POST /api/orders/[id]/confirmation]', err)
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: 'Error interno', detail: msg }, { status: 500 })
  }
}
