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
  created_at: string
  updated_at: string
  contact: WaContact
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
}
