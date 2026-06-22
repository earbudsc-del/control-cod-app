export interface WaContact {
  id: string
  phone_normalized: string
  display_name: string | null
  wa_id: string | null
  order_id: string | null
  last_seen_at?: string | null
}

export interface WaConversation {
  id: string
  status: 'open' | 'pending' | 'closed'
  unread_count: number
  last_message_at: string | null
  last_message_preview: string | null
  assigned_to: string | null
  ai_enabled: boolean
  created_at: string
  updated_at: string
  contact: WaContact
  assigned_agent?: { id: string; full_name: string } | null
}

// Agente seleccionable en el dropdown "Asignar a:" del header del Inbox.
export interface WaAgentOption {
  id: string
  full_name: string
  role: string
}

export interface WaMessage {
  id: string
  direction: 'inbound' | 'outbound'
  message_type: string
  body: string | null
  status: string
  sent_at: string | null
  delivered_at: string | null
  read_at: string | null
  sent_by: string | null
  wa_msg_id: string
  metadata?: Record<string, unknown> | null
}

export interface WaTemplateMetadata {
  template_name?: string
  header_image_url?: string
  customer_name?: string
  product_summary?: string
  cod_amount?: string
  buttons?: string[]
}
