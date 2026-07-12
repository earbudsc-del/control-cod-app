import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContactResult, DeliveryResolution, NoveltyType } from '@/types'

export type NoveltyActionInput =
  | {
      kind:          'contacted'
      orderId:       string
      agentId:       string
      contactResult?: ContactResult | null
      notes?:        string | null
    }
  | {
      kind:          'confirm_classification'
      orderId:       string
      agentId:       string
      confirmedType: NoveltyType
    }
  | {
      kind:            'rescheduled'
      orderId:         string
      agentId:         string
      rescheduledDate: string // YYYY-MM-DD, obligatoria
      rescheduledNote?: string | null
    }
  | {
      kind:    'recovered'
      orderId: string
      agentId: string
      notes?:  string | null
    }

export interface NoveltyActionResult {
  ok:      boolean
  status:  number
  error?:  string
  data?: {
    action: Record<string, unknown>
    order: {
      novelty_type:        NoveltyType | null
      delivery_resolution: DeliveryResolution | null
      rescheduled_date:    string | null
      rescheduled_note:    string | null
      last_action_at:      string | null
    }
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Único punto de escritura para acciones manuales del agente sobre pedidos en
 * novedad: inserta en agent_actions, actualiza last_action_at y — según el
 * tipo de acción — novelty_type / delivery_resolution / rescheduled_date /
 * rescheduled_note. Nunca duplicar esta lógica en un endpoint o componente.
 *
 * Validación de permisos: el rol ya se valida en el endpoint que llama a esta
 * función (isAgentOrAbove); aquí solo se valida que el pedido exista. La
 * inserción/actualización queda además protegida por RLS (is_agent_or_above())
 * en `agent_actions`/`orders`, igual que el resto de acciones del sistema.
 *
 * escalated (Fase 4) no está soportado todavía — el CHECK constraint de
 * agent_actions.action_type aún no lo incluye.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recordNoveltyAction(
  supabase: SupabaseClient<any>,
  input: NoveltyActionInput,
): Promise<NoveltyActionResult> {
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('id, delivery_resolution, rescheduled_date, rescheduled_note')
    .eq('id', input.orderId)
    .single()

  if (orderErr || !order) {
    return { ok: false, status: 404, error: 'Pedido no encontrado' }
  }

  if (input.kind === 'rescheduled' && !DATE_RE.test(input.rescheduledDate ?? '')) {
    return { ok: false, status: 400, error: 'Fecha de reprogramación inválida o ausente — se requiere una fecha concreta' }
  }

  // ── Qué se inserta en agent_actions ──────────────────────────────────────
  let actionType: string
  let contactResult: string | null = null
  let notes: string | null = null

  switch (input.kind) {
    case 'contacted':
      actionType    = 'contacted'
      contactResult = input.contactResult ?? null
      notes         = input.notes ?? null
      break
    case 'confirm_classification':
      actionType = 'contacted'
      notes      = `Clasificación confirmada por el agente: ${input.confirmedType}`
      break
    case 'rescheduled':
      actionType = 'rescheduled'
      notes      = input.rescheduledNote ?? `Reprogramado para ${input.rescheduledDate}`
      break
    case 'recovered':
      actionType = 'recovered'
      notes      = input.notes ?? null
      break
  }

  const { data: action, error: actionErr } = await supabase
    .from('agent_actions')
    .insert({
      order_id:       input.orderId,
      agent_id:       input.agentId,
      action_type:    actionType,
      contact_result: contactResult,
      notes,
    })
    .select('*, profile:profiles!agent_id(full_name)')
    .single()

  if (actionErr) {
    return { ok: false, status: 500, error: actionErr.message }
  }

  // ── Qué se actualiza en orders ───────────────────────────────────────────
  const orderUpdate: Record<string, unknown> = {
    last_action_at: new Date().toISOString(),
  }

  if (input.kind === 'confirm_classification') {
    orderUpdate.novelty_type = input.confirmedType
  }
  if (input.kind === 'rescheduled') {
    orderUpdate.delivery_resolution = 'rescheduled'
    orderUpdate.rescheduled_date    = input.rescheduledDate
    orderUpdate.rescheduled_note    = input.rescheduledNote ?? null
  }

  const { data: updatedOrder, error: updateErr } = await supabase
    .from('orders')
    .update(orderUpdate)
    .eq('id', input.orderId)
    .select('novelty_type, delivery_resolution, rescheduled_date, rescheduled_note, last_action_at')
    .single()

  if (updateErr) {
    return { ok: false, status: 500, error: updateErr.message }
  }

  return {
    ok:     true,
    status: 201,
    data: {
      action,
      order: updatedOrder,
    },
  }
}
