export type UserRole =
  | 'admin'
  | 'ia_supervisor'
  | 'confirmation_agent'
  | 'novelty_agent'
  | 'delivery_agent'
  | 'agent'
  | 'viewer'
export type ConfirmationStatus     = 'pending' | 'confirmed' | 'unreachable' | 'cancelled'
export type CartRecoveryStatus     = 'pending' | 'contacted' | 'no_answer' | 'recovered' | 'discarded'
export type ConfirmationMethod     = 'call' | 'whatsapp' | 'other'
export type ConfirmationConfidence = 'high' | 'medium' | 'low' | 'risky'
export type NormalizedStatus =
  | 'pending'
  | 'in_transit'
  | 'out_for_delivery'
  | 'en_reparto'
  | 'novedad'
  | 'indemnizacion'
  | 'delivered'
  | 'failed_attempt'
  | 'returned'
  | 'unknown'
export type Classification = 'urgent' | 'critical' | 'follow_up' | 'claim'
export type FollowUpResult = 'pending' | 'delivered' | 'returned' | 'recovered' | 'no_action'
export type ContactResult =
  | 'answered_confirmed'
  | 'answered_rescheduled'
  | 'answered_refused'
  | 'no_answer'
  | 'wrong_number'
  | 'unreachable'
export type ActionType =
  | 'contacted'
  | 'confirmed'
  | 'rescheduled'
  | 'recovered'
  | 'courier_claim'
  | 'note_added'
  | 'status_updated'
  | 'returned'
  | 'delivered'
export type InvalidReason =
  | 'courier_no_call'
  | 'courier_no_show'
  | 'courier_mismanagement'
  | 'wrong_address_used'
  | 'other'
export type ImportStatus = 'processing' | 'completed' | 'failed'
export type SlaStatus = 'ok' | 'warning' | 'breached' | 'none'

export interface Store {
  id: string
  name: string
  slug: string
  shopify_domain: string | null
  is_active: boolean
  created_at: string
}

export interface Profile {
  id: string
  store_id: string
  full_name: string
  role: UserRole
  created_at: string
  email:           string | null
  last_sign_in_at: string | null
  last_activity:   string | null
}

export interface SlaRule {
  id: string
  store_id: string | null
  classification: Classification
  max_inaction_hours: number
  is_active: boolean
}

export interface StatusPattern {
  id: string
  pattern: string
  normalized_status: NormalizedStatus
  attempt_increment: number
  is_at_risk_trigger: boolean
  priority: number
}

export interface Import {
  id: string
  store_id: string
  filename: string
  imported_by: string | null
  record_count: number
  status: ImportStatus
  error_log: Record<string, unknown> | null
  created_at: string
  profile?: Profile
}

export interface Order {
  id: string
  store_id: string
  import_id: string | null
  tracking_number: string
  order_number: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_address: string | null
  city: string | null
  province: string | null
  product_summary: string | null
  cod_amount: number | null
  carrier: string | null
  raw_status: string | null
  normalized_status: NormalizedStatus
  delivery_attempts: number
  invalid_attempts: number
  last_attempt_date: string | null
  is_at_risk: boolean
  classification: Classification | null
  assigned_to: string | null
  assigned_by: string | null
  assigned_at: string | null
  follow_up_result: FollowUpResult
  last_action_at: string | null
  customer_confirmed: boolean
  customer_confirmed_at: string | null
  last_contact_at: string | null
  last_contact_result: ContactResult | null
  sla_deadline: string | null
  sla_breached: boolean
  shopify_order_id:    string | null
  shopify_created_at?: string | null
  source?: string | null
  created_at: string
  updated_at: string
  // Campos de vistas enriquecidas
  sla_status?: SlaStatus
  sla_hours_remaining?: number | null
  assigned_name?: string | null
  // Campos de seguimiento novedad (preparados para uso futuro)
  novedad_motivo?: string | null
  novedad_contactado?: boolean
  novedad_reprogramado?: boolean
  novedad_no_salvable?: boolean
  novedad_updated_at?: string | null
  // Fechas de eventos logísticos (pobladlas por migraciones 014/015 + cron)
  status_since?: string | null
  last_novedad_at?: string | null
  shipment_created_at?: string | null
  // Tracking EFI manual
  last_tracking_update?: string | null
  last_attempt_reason?: string | null
  tracking_history?: Array<{ fecha: string; estado: string }> | null
  tracking_novedades?: Array<{ fecha: string; mensaje: string }> | null
  // Confirmación de pedido
  confirmation_status?: ConfirmationStatus | null
  confirmation_attempts?: number
  last_confirmation_attempt?: string | null
  confirmation_method?: ConfirmationMethod | null
  confirmation_confidence?: ConfirmationConfidence | null
  // Detección de pedidos duplicados (migración 018)
  duplicate_alert?: boolean
  duplicate_of_order_id?: string | null
  duplicate_reason?: string | null
}

export interface AbandonedCart {
  id:                   string
  store_id:             string
  shopify_checkout_id:  string | null
  // Draft Order (migración 023)
  shopify_draft_order_id:   string | null
  shopify_draft_order_name: string | null  // e.g. "#D2256"
  draft_status:             string | null  // open | invoice_sent | completed
  completed_at:             string | null
  customer_name:        string | null
  customer_phone:       string | null
  customer_email:       string | null
  products_summary:     string | null
  total_amount:         number | null
  currency:             string | null
  checkout_url:         string | null
  customer_address:     string | null
  city:                 string | null
  province:             string | null
  // Campos COD form (migración 022)
  product_id:           string | null
  variant_id:           string | null
  page_url:             string | null
  referrer:             string | null
  utm_source:           string | null
  utm_campaign:         string | null
  utm_content:          string | null
  session_id:           string | null
  recovery_status:      CartRecoveryStatus
  recovery_attempts:    number
  last_contacted_at:    string | null
  recovered_order_id:   string | null
  notes:                string | null
  abandoned_at:         string | null
  // 'shopify_draft_order' | 'shopify_abandoned_checkout' | 'cod_form_lead' | 'manual_import' | 'shopify' (legacy)
  source:               string | null
  created_at:           string
  updated_at:           string
}

export interface Note {
  id: string
  order_id: string
  created_by: string | null
  content: string
  created_at: string
  profile?: Profile
}

export interface AgentAction {
  id: string
  order_id: string
  agent_id: string | null
  action_type: ActionType
  contact_result: ContactResult | null
  notes: string | null
  created_at: string
  profile?: Profile
}

export interface OrderAssignment {
  id: string
  order_id: string
  assigned_to: string | null
  assigned_by: string | null
  assigned_at: string
  unassigned_at: string | null
  reason: string | null
  assigned_profile?: Profile
  assigned_by_profile?: Profile
}

export interface DeliveryAttemptRecord {
  id: string
  order_id: string
  attempt_number: number
  attempted_at: string | null
  is_valid: boolean
  invalid_reason: InvalidReason | null
  invalid_notes: string | null
  flagged_by: string | null
  flagged_at: string | null
  source: 'efi_import' | 'manual'
  created_at: string
}

export interface OrderHistory {
  id: string
  order_id: string
  changed_by: string | null
  field: string
  old_value: string | null
  new_value: string | null
  created_at: string
  profile?: Profile
}

export interface AgentPerformance {
  agent_id: string
  agent_name: string
  role: UserRole
  store_id: string
  pedidos_asignados: number
  pedidos_contactados: number
  pedidos_confirmados: number
  pedidos_reprogramados: number
  pedidos_recuperados: number
  pedidos_entregados: number
  pedidos_devueltos: number
  sla_incumplidos: number
  reclamos_courier: number
  notas_registradas: number
  sin_accion_24h: number
}

// Labels y colores para UI
export const STATUS_LABELS: Record<NormalizedStatus, string> = {
  pending:          'Pendiente',
  in_transit:       'En tránsito',
  out_for_delivery: 'Reprogramado',
  en_reparto:       'En reparto',
  novedad:          'Novedad',
  indemnizacion:    'Indemnización',
  delivered:        'Entregado',
  failed_attempt:   'Intento fallido',
  returned:         'Devuelto',
  unknown:          'Sin estado',
}

export const STATUS_COLORS: Record<NormalizedStatus, string> = {
  pending:          'bg-gray-100 text-gray-700',
  in_transit:       'bg-blue-100 text-blue-700',
  out_for_delivery: 'bg-indigo-100 text-indigo-700',
  en_reparto:       'bg-amber-100 text-amber-700',
  novedad:          'bg-red-100 text-red-700',
  indemnizacion:    'bg-violet-100 text-violet-700',
  delivered:        'bg-green-100 text-green-700',
  failed_attempt:   'bg-orange-100 text-orange-700',
  returned:         'bg-red-100 text-red-700',
  unknown:          'bg-gray-100 text-gray-500',
}

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  urgent:    'Urgente',
  critical:  'Crítico',
  follow_up: 'Seguimiento',
  claim:     'Reclamo',
}

export const CLASSIFICATION_COLORS: Record<Classification, string> = {
  urgent:    'bg-orange-100 text-orange-700',
  critical:  'bg-red-100 text-red-700',
  follow_up: 'bg-blue-100 text-blue-700',
  claim:     'bg-purple-100 text-purple-700',
}

export const ACTION_LABELS: Record<ActionType, string> = {
  contacted:      'Contactó al cliente',
  confirmed:      'Confirmó recepción',
  rescheduled:    'Reprogramó entrega',
  recovered:      'Recuperó pedido',
  courier_claim:  'Reclamo al courier',
  note_added:     'Nota interna',
  status_updated: 'Actualizó estado',
  returned:       'Confirmó devolución',
  delivered:      'Confirmó entrega',
}

export type TaskType = 'follow_up' | 'novedad' | 'confirmation' | 'recovery'
export type TaskPriority = 'high' | 'medium' | 'low'
export type TaskStatus = 'open' | 'in_progress' | 'completed' | 'expired' | 'escalated'
export type TaskResult = 'delivered' | 'recovered' | 'no_answer' | 'rescheduled' | 'returned'

export interface Task {
  id: string
  order_id: string
  store_id: string
  assigned_to: string | null
  assigned_by: string | null
  task_type: TaskType
  priority: TaskPriority
  status: TaskStatus
  due_at: string | null
  completed_at: string | null
  result: TaskResult | null
  notes: string | null
  assigned_by_ia: boolean
  created_at: string
  updated_at: string
  // Campos enriquecidos opcionales (joins)
  order?: Pick<Order, 'tracking_number' | 'customer_name' | 'city' | 'normalized_status' | 'delivery_attempts'>
  assigned_profile?: Pick<Profile, 'full_name'>
}

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  follow_up:    'Seguimiento',
  novedad:      'Novedad',
  confirmation: 'Confirmación',
  recovery:     'Recuperación',
}

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  high:   'Alta',
  medium: 'Media',
  low:    'Baja',
}

export const TASK_PRIORITY_COLORS: Record<TaskPriority, string> = {
  high:   'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low:    'bg-gray-100 text-gray-600',
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open:        'Abierta',
  in_progress: 'En progreso',
  completed:   'Completada',
  expired:     'Vencida',
  escalated:   'Escalada',
}

export const CONTACT_RESULT_LABELS: Record<ContactResult, string> = {
  answered_confirmed:   'Respondió — confirmó',
  answered_rescheduled: 'Respondió — reprogramó',
  answered_refused:     'Respondió — rechazó',
  no_answer:            'No contestó',
  wrong_number:         'Número incorrecto',
  unreachable:          'Fuera de servicio',
}
