import { SD_LOCATION_REQUEST_TEMPLATE_NAME } from './sd-location-request'

// Batched — igual patrón que resolveWhatsappLinksBatch: evita N+1 sin
// importar cuántos pedidos SD se estén listando. Expone el estado del
// mensaje automático de confirmación + ubicación (Sprint 3A, spec sección 6)
// como campos de solo lectura para Ruta COD.

interface SupabaseLike {
  from: (table: string) => any
}

export interface SdLocationRequestInfo {
  locationRequestStatus: 'pending' | 'processing' | 'sent' | 'skipped' | 'failed' | null
  locationRequestScheduledAt: string | null
  locationRequestSentAt: string | null
  customerRepliedAt: string | null
}

const EMPTY: SdLocationRequestInfo = {
  locationRequestStatus: null,
  locationRequestScheduledAt: null,
  locationRequestSentAt: null,
  customerRepliedAt: null,
}

export async function fetchSdLocationRequestInfoBatch(
  supabase: SupabaseLike,
  orderIds: string[],
  conversationIdByOrderId: Map<string, string | undefined>,
): Promise<Map<string, SdLocationRequestInfo>> {
  const result = new Map<string, SdLocationRequestInfo>()
  if (orderIds.length === 0) return result

  const { data: jobs } = await supabase
    .from('wa_template_queue')
    .select('order_id, status, scheduled_at, processed_at, created_at')
    .in('order_id', orderIds)
    .eq('template_name', SD_LOCATION_REQUEST_TEMPLATE_NAME)

  if (!jobs?.length) return result

  type JobRow = { order_id: string; status: string; scheduled_at: string; processed_at: string | null; created_at: string }
  const jobByOrderId = new Map<string, JobRow>()
  for (const j of jobs as JobRow[]) jobByOrderId.set(j.order_id, j)

  // customerRepliedAt: primer mensaje inbound en la conversación del pedido,
  // posterior a la creación del job (mismo criterio que la supresión
  // 'client_already_wrote' del cron — ver runSdLocationRequestJob).
  const conversationIds = [...new Set(
    [...jobByOrderId.keys()]
      .map(orderId => conversationIdByOrderId.get(orderId))
      .filter((id): id is string => Boolean(id)),
  )]

  const firstInboundByConversation = new Map<string, string>()
  if (conversationIds.length > 0) {
    const { data: inbound } = await supabase
      .from('wa_messages')
      .select('conversation_id, sent_at')
      .in('conversation_id', conversationIds)
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: true })

    for (const row of (inbound ?? []) as { conversation_id: string; sent_at: string | null }[]) {
      if (!row.sent_at) continue
      if (!firstInboundByConversation.has(row.conversation_id)) {
        firstInboundByConversation.set(row.conversation_id, row.sent_at)
      }
    }
  }

  for (const orderId of orderIds) {
    const job = jobByOrderId.get(orderId)
    if (!job) {
      result.set(orderId, EMPTY)
      continue
    }

    const conversationId = conversationIdByOrderId.get(orderId)
    const firstInbound = conversationId ? firstInboundByConversation.get(conversationId) : undefined
    const customerRepliedAt = firstInbound && firstInbound > job.created_at ? firstInbound : null

    result.set(orderId, {
      locationRequestStatus: job.status as SdLocationRequestInfo['locationRequestStatus'],
      locationRequestScheduledAt: job.scheduled_at,
      locationRequestSentAt: job.status === 'sent' ? job.processed_at : null,
      customerRepliedAt,
    })
  }

  return result
}
