// Sprint C.1 — métricas de una campaña. READ ONLY.
//
// Solo se cuenta lo que tiene evidencia:
//   accepted   = filas con wa_message_id (Meta aceptó). NO es entrega.
//   delivered / read / failed_after_accept = estado del wa_message por
//                webhook de status de Meta (read implica delivered).
//   responded  = respuestas de botones registradas (wa_broadcast_responses).
//   confirm_interest ≠ confirmed: "Sí, confirmar" es intención; una
//   confirmación atribuible exige confirmation_status='confirmed' con
//   customer_confirmed_at POSTERIOR al envío al pedido de esa fila.

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface BroadcastMetrics {
  queued:        number
  pending:       number
  processing:    number
  accepted:      number
  delivered:     number
  read:          number
  failed:        number            // rechazo de Meta + agotó reintentos
  failed_after_accept: number      // Meta aceptó y luego reportó failed
  send_unknown:  number
  skipped:       number
  skipped_by_reason: Record<string, number>
  responded:     number
  responses_by_intent: Record<string, number>
  responses_unhandled: number
  confirmations_attributable: number
  errors: Array<{ queue_id: string; order_id: string; status: string; meta_error_code: string | null; error_message: string | null }>
}

interface QueueRow {
  id: string; order_id: string; status: string; wa_message_id: string | null; processed_at: string | null
  skip_reason: string | null; meta_error_code: string | null; error_message: string | null
}

export async function getBroadcastMetrics(db: SupabaseLike, storeId: string, broadcastId: string): Promise<BroadcastMetrics> {
  const { data: rowsData, error } = await db.from('wa_template_queue')
    .select('id, order_id, status, wa_message_id, processed_at, skip_reason, meta_error_code, error_message')
    .eq('store_id', storeId).eq('broadcast_id', broadcastId)
  if (error) throw new Error(`wa_template_queue(metrics): ${error.message ?? String(error)}`)
  const rows = (rowsData ?? []) as QueueRow[]

  const m: BroadcastMetrics = {
    queued: rows.length, pending: 0, processing: 0, accepted: 0, delivered: 0, read: 0, failed: 0,
    failed_after_accept: 0, send_unknown: 0, skipped: 0, skipped_by_reason: {}, responded: 0,
    responses_by_intent: {}, responses_unhandled: 0, confirmations_attributable: 0, errors: [],
  }
  for (const r of rows) {
    if (r.status === 'pending') m.pending++
    else if (r.status === 'processing') m.processing++
    else if (r.status === 'failed') m.failed++
    else if (r.status === 'send_unknown') m.send_unknown++
    else if (r.status === 'skipped') {
      m.skipped++
      const k = (r.skip_reason ?? 'sin_motivo').split(':')[0]
      m.skipped_by_reason[k] = (m.skipped_by_reason[k] ?? 0) + 1
    }
    if (r.wa_message_id) m.accepted++
    if (r.status === 'failed' || r.status === 'send_unknown') {
      m.errors.push({ queue_id: r.id, order_id: r.order_id, status: r.status, meta_error_code: r.meta_error_code, error_message: r.error_message })
    }
  }

  const wamids = rows.map(r => r.wa_message_id).filter((w): w is string => !!w)
  for (let i = 0; i < wamids.length; i += 100) {
    const { data } = await db.from('wa_messages').select('wa_msg_id, status, delivered_at, read_at')
      .eq('store_id', storeId).in('wa_msg_id', wamids.slice(i, i + 100))
    for (const w of (data ?? []) as Array<{ status: string; delivered_at: string | null; read_at: string | null }>) {
      if (w.status === 'read' || w.read_at) { m.read++; m.delivered++ }
      else if (w.status === 'delivered' || w.delivered_at) m.delivered++
      else if (w.status === 'failed') m.failed_after_accept++
    }
  }

  const { data: resp } = await db.from('wa_broadcast_responses').select('intent, handled_at')
    .eq('store_id', storeId).eq('broadcast_id', broadcastId)
  for (const r of (resp ?? []) as Array<{ intent: string; handled_at: string | null }>) {
    m.responded++
    m.responses_by_intent[r.intent] = (m.responses_by_intent[r.intent] ?? 0) + 1
    if (!r.handled_at) m.responses_unhandled++
  }

  const sentAtByOrder = new Map(rows.filter(r => r.wa_message_id && r.processed_at).map(r => [r.order_id, r.processed_at!]))
  const orderIds = [...sentAtByOrder.keys()]
  for (let i = 0; i < orderIds.length; i += 100) {
    const { data } = await db.from('orders').select('id, confirmation_status, customer_confirmed_at')
      .eq('store_id', storeId).in('id', orderIds.slice(i, i + 100))
    for (const o of (data ?? []) as Array<{ id: string; confirmation_status: string | null; customer_confirmed_at: string | null }>) {
      const sentAt = sentAtByOrder.get(o.id)
      if (o.confirmation_status === 'confirmed' && o.customer_confirmed_at && sentAt
          && Date.parse(o.customer_confirmed_at) > Date.parse(sentAt)) m.confirmations_attributable++
    }
  }
  m.errors = m.errors.slice(0, 50)
  return m
}
