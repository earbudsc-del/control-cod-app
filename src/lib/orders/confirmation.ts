import type { createClient } from '@/lib/supabase/server'

// Lógica compartida del flujo de confirmación de pedidos.
// Usada por:
//   - POST /api/orders/[id]/confirmation (acción manual del agente)
//   - webhook de WhatsApp (Fase 6C — botones "Confirmar" / "No, gracias")

export type ConfirmAction = 'confirmed' | 'no_answer' | 'wrong_number' | 'cancelled' | 'no_coverage'
export type ConfirmMethod = 'call' | 'whatsapp' | 'other'

type SupabaseClient = Awaited<ReturnType<typeof createClient>>

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

export interface ApplyConfirmationActionParams {
  supabase: SupabaseClient
  orderId:  string
  action:   ConfirmAction
  method:   ConfirmMethod
  // Solo se usa para la nota interna de 'no_coverage'. Null en flujos sin sesión (webhook).
  userId?:  string | null
  // true para flujos automáticos (webhook): exige confirmation_status='pending'
  // y bloquea pedidos ya delivered/returned. false (default) preserva el
  // comportamiento histórico del endpoint manual — el agente puede sobreescribir.
  guardAutomated?: boolean
}

export type ApplyConfirmationActionResult =
  | {
      ok: true
      confirmation_attempts:   number
      confirmation_status:     string
      confirmation_confidence: string
    }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'terminal_status' | 'db_error' }

export async function applyConfirmationAction({
  supabase,
  orderId,
  action,
  method,
  userId = null,
  guardAutomated = false,
}: ApplyConfirmationActionParams): Promise<ApplyConfirmationActionResult> {
  const { data: order } = await supabase
    .from('orders')
    .select('confirmation_attempts, duplicate_alert, confirmation_status, normalized_status')
    .eq('id', orderId)
    .single()

  if (!order) return { ok: false, reason: 'not_found' }

  if (guardAutomated) {
    if (order.confirmation_status !== 'pending') return { ok: false, reason: 'not_pending' }
    if (order.normalized_status === 'delivered' || order.normalized_status === 'returned') {
      return { ok: false, reason: 'terminal_status' }
    }
  }

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

  const { error } = await supabase.from('orders').update(updates).eq('id', orderId)
  if (error) {
    console.error('[confirmation] Supabase update error — action:', action, '| code:', error.code, '| message:', error.message, '| details:', error.details)
    return { ok: false, reason: 'db_error' }
  }

  if (action === 'no_coverage' && userId) {
    await supabase.from('notes').insert({
      order_id:   orderId,
      created_by: userId,
      content:    'Pedido marcado como Sin cobertura',
    })
  }

  return {
    ok: true,
    confirmation_attempts:   attempts,
    confirmation_status:     (updates.confirmation_status as string | undefined) ?? 'pending',
    confirmation_confidence: confidence,
  }
}
