import type { DeliveryResolution, NoveltyType } from '@/types'
import { classifyNovelty } from './classify-novelty'
import { extractRescheduleDate } from './extract-reschedule-date'

export interface NoveltyTrackingInput {
  normalizedStatus:           string
  previousNormalizedStatus:   string | null
  deliveryAttempts:           number
  previousDeliveryAttempts:   number | null
  lastAttemptReason:          string | null
  previousLastAttemptReason:  string | null
  previousDeliveryResolution: DeliveryResolution | null
}

export interface NoveltyTrackingUpdate {
  novelty_type?:        NoveltyType | null
  delivery_resolution?: DeliveryResolution
  rescheduled_date?:    string
}

/**
 * Decide qué actualizar en `orders` a partir de un evento de tracking (cron o
 * consulta manual a EFI). Función pura — recibe el estado anterior y nuevo como
 * argumentos explícitos, no consulta la DB. Esto permite reutilizarla sin
 * cambios si en el futuro cada intento vive en su propia fila de eventos en vez
 * de columnas de `orders`.
 *
 * No modifica follow_up_result, normalized_status ni el parser EFI — solo
 * decide los campos del motor de novedades.
 */
export function processNoveltyTracking(input: NoveltyTrackingInput): NoveltyTrackingUpdate | null {
  const {
    normalizedStatus, previousNormalizedStatus,
    deliveryAttempts, previousDeliveryAttempts,
    lastAttemptReason, previousLastAttemptReason,
    previousDeliveryResolution,
  } = input

  // El tracking confirmó entrega o devolución — se refleja automáticamente,
  // el agente nunca escribe estos valores directamente.
  if (normalizedStatus === 'delivered') {
    return previousDeliveryResolution === 'delivered' ? null : { delivery_resolution: 'delivered' }
  }
  if (normalizedStatus === 'returned') {
    return previousDeliveryResolution === 'returned' ? null : { delivery_resolution: 'returned' }
  }

  // El pedido no está (o ya no está) en novedad — no tocar nada. Si vuelve a
  // entrar en novedad más adelante, se reabre como un evento nuevo (ver abajo).
  if (normalizedStatus !== 'novedad') return null

  // ¿Es un evento realmente nuevo, o un sync repetido sin cambios?
  const enteredNovedadNow  = previousNormalizedStatus !== 'novedad'
  const attemptsIncreased  = deliveryAttempts > (previousDeliveryAttempts ?? 0)
  const reasonChanged      = (lastAttemptReason ?? null) !== (previousLastAttemptReason ?? null)
  const isNewEvent         = enteredNovedadNow || attemptsIncreased || reasonChanged

  if (!isNewEvent) return null // sync repetido: no reabrir, no sobrescribir, no tocar reprogramación

  // Si la transportadora ya confirma explícitamente una reprogramación con
  // fecha parseable, ese evento por sí solo constituye un acuerdo real — no
  // requiere confirmación humana adicional para entrar en Reprogramados.
  // Si hay evidencia de reprogramación pero sin fecha válida, cae al camino
  // normal (pending) — nunca se inventa una fecha.
  const rescheduledDate = extractRescheduleDate(lastAttemptReason)
  if (rescheduledDate) {
    return {
      novelty_type:        'contacted',
      delivery_resolution: 'rescheduled',
      rescheduled_date:    rescheduledDate,
    }
  }

  // Evento nuevo de la transportadora: reclasifica novelty_type sobre ESTE
  // evento y reabre delivery_resolution a pending. rescheduled_date/_note NO
  // se tocan aquí — se conservan como "último acuerdo incumplido" (lo maneja
  // la UI a partir de delivery_resolution=pending + rescheduled_date presente).
  return {
    novelty_type:        classifyNovelty(lastAttemptReason),
    delivery_resolution: 'pending',
  }
}
