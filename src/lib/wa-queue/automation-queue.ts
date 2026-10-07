// Sprint Broadcast A.1 — aislamiento del processor de AUTOMATIONS
// (src/app/api/cron/wa-template-queue/route.ts) respecto de Broadcast.
//
// El processor histórico procesa EXCLUSIVAMENTE filas de automation:
//   Barrera 1 (query):    broadcast_id IS NULL
//   Barrera 2 (query):    template_name IN allowlist
//   Barrera 3 (dispatch): antes del claim, se re-verifican ambas condiciones;
//                         una fila fuera de la allowlist NO se reclama, NO se
//                         envía y NO se le cambia el estado — no pertenece a
//                         este processor (ver nota en isAutomationQueueCandidate).
//
// sd_broadcast_confirmation NO está en la allowlist: aunque por bug tuviera
// broadcast_id NULL, este processor jamás la toma.
//
// Requiere la columna wa_template_queue.broadcast_id (migración 064). Ver
// orden de rollout en el reporte del Sprint A.1: 064 se aplica ANTES de
// desplegar este código.

import { SD_LOCATION_REQUEST_TEMPLATE_NAME } from '@/lib/deliveries/sd-location-request'

export const ORDER_CONFIRMATION_TEMPLATE_NAME = 'order_confirmation_cod'

// Allowlist explícita. Agregar un template nuevo de automation = agregarlo
// aquí Y su handler en el dispatch del processor (el switch es exhaustivo).
export const AUTOMATION_TEMPLATE_NAMES = [
  ORDER_CONFIRMATION_TEMPLATE_NAME,
  SD_LOCATION_REQUEST_TEMPLATE_NAME,
] as const

export type AutomationTemplateName = typeof AUTOMATION_TEMPLATE_NAMES[number]

export const AUTOMATION_BATCH_LIMIT = 50

export function getAutomationTemplate(templateName: string): AutomationTemplateName | null {
  return (AUTOMATION_TEMPLATE_NAMES as readonly string[]).includes(templateName)
    ? (templateName as AutomationTemplateName)
    : null
}

export interface AutomationQueueRowLike {
  broadcast_id?: string | null
  template_name: string
  status:        string
}

/**
 * ¿Puede el processor de automation tomar esta fila?
 *
 * Una fila que NO cumple se ignora sin tocarla (ni skipped ni failed):
 * marcarla desde aquí destruiría una fila que pertenece a otro processor
 * (p.ej. un recipient de Broadcast), y un template desconocido no es un
 * fallo de envío — nunca se intentó enviar. Queda pending y visible en la
 * auditoría (scripts/audit-wa-template-queue.ts) con su dueño intacto.
 *
 * `broadcast_id` ausente (undefined) se trata como NO-null: fail-closed si
 * alguien quita la columna del SELECT.
 */
export function isAutomationQueueCandidate(row: AutomationQueueRowLike): boolean {
  return row.broadcast_id === null
    && getAutomationTemplate(row.template_name) !== null
    && row.status === 'pending'
}

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const AUTOMATION_JOB_COLUMNS =
  'id, store_id, order_id, template_name, phone_normalized, created_at, attempt_count, broadcast_id'

/** Query de selección del processor de automation — única definición. */
export function fetchAutomationJobs(supabase: SupabaseLike, nowIso: string) {
  return supabase
    .from('wa_template_queue')
    .select(AUTOMATION_JOB_COLUMNS)
    .eq('status', 'pending')
    .is('broadcast_id', null)
    .in('template_name', [...AUTOMATION_TEMPLATE_NAMES])
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(AUTOMATION_BATCH_LIMIT)
}
