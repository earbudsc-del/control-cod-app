import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  applyConfirmationAction,
  type ConfirmAction,
  type ConfirmMethod,
} from '@/lib/orders/confirmation'

// Roles autorizados a reabrir una confirmación — decisión administrativa,
// no el flujo normal de contacto/confirmación (ver auditoría 2026-07-31):
// dispatch_agent y delivery_agent quedan explícitamente fuera.
const REOPEN_ALLOWED_ROLES = ['admin', 'confirmation_agent']

const FAILURE_STATUS: Record<string, number> = {
  not_found:        404,
  not_pending:      409,
  terminal_status:  422,
  reason_required:  400,
  reason_too_long:  400,
  forbidden:        403,
  not_confirmed:    422,
  has_tracking:     422,
  already_paid:     422,
  dispatched:       422,
  conflict:         409,
  db_error:         500,
}

// not_confirmed cubre dos casos indistinguibles hoy desde el RPC (ver
// migración 052): el pedido genuinamente nunca fue confirmado por esta vía,
// O alguien más lo modificó/reabrió entre que el agente abrió el modal y
// confirmó la acción (la carrera de "dos agentes simultáneos" se resuelve
// así — el segundo en adquirir el lock relee el estado ya cambiado por el
// primero). No se puede distinguir cuál de los dos ocurrió sin una señal
// adicional que hoy no existe, así que el mensaje cubre ambos casos sin
// afirmar una causa específica que podría ser falsa.
const FAILURE_MESSAGE: Record<string, string> = {
  not_found:       'Pedido no encontrado',
  terminal_status: 'El pedido ya fue entregado o devuelto — no se puede reabrir',
  reason_required: 'El motivo es obligatorio para reabrir un pedido',
  reason_too_long: 'El motivo es demasiado largo',
  forbidden:       'Sin permisos para reabrir pedidos',
  not_confirmed:   'El pedido ya no está en estado confirmado — puede que ya lo hayan reabierto o modificado. Actualiza la página para ver el estado actual.',
  has_tracking:    'El pedido ya tiene guía asignada — no se puede reabrir',
  already_paid:    'El pedido ya fue pagado — no se puede reabrir',
  dispatched:      'El pedido ya está siendo trabajado en ruta — no se puede reabrir',
  conflict:        'El pedido cambió mientras se procesaba esta acción. Actualiza y vuelve a intentar.',
  db_error:        'Error interno',
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { action, method = 'other', reason } = await req.json() as {
      action: ConfirmAction
      method?: ConfirmMethod
      reason?: string
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    if (action === 'reopened') {
      const { data: profile } = await supabase
        .from('profiles').select('role').eq('id', user.id).single()
      if (!profile || !REOPEN_ALLOWED_ROLES.includes(profile.role)) {
        return NextResponse.json({ error: 'Sin permisos para reabrir pedidos' }, { status: 403 })
      }
    }

    const result = await applyConfirmationAction({
      supabase,
      orderId: id,
      action,
      method,
      userId: user.id,
      reason,
    })

    if (!result.ok) {
      const status  = FAILURE_STATUS[result.reason]  ?? 500
      const message = FAILURE_MESSAGE[result.reason]  ?? 'Error interno'
      return NextResponse.json({ error: message }, { status })
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
