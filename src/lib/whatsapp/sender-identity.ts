// Identidad del remitente para mensajes salientes de wa_messages.
//
// No agrega columnas nuevas — reutiliza wa_messages.metadata (JSONB, ya
// existente desde 034_wa_messages_metadata.sql) y wa_messages.sent_by (FK a
// profiles, ya existente desde 030_whatsapp_base.sql). sender_type/name/role
// quedan dentro de metadata junto a lo que cada endpoint ya guardaba ahí
// (ej. generated_by/template_name), sin reemplazarlo.

export type SenderType = 'genesis' | 'courier' | 'agent' | 'admin' | 'system'

export interface SenderIdentity {
  sender_type: SenderType
  sender_id: string | null
  sender_name: string | null
  sender_role: string | null
}

// Deriva sender_type a partir del rol de perfil ya disponible en cada
// endpoint — un mensajero (santo_domingo_delivery_agent) es 'courier',
// admin es 'admin', cualquier otro agente humano es 'agent'.
export function senderTypeFromRole(role: string | null | undefined): SenderType {
  if (role === 'santo_domingo_delivery_agent') return 'courier'
  if (role === 'admin') return 'admin'
  return 'agent'
}

export function buildSenderIdentity(
  profile: { id: string; full_name: string | null; role: string | null } | null,
  kind?: 'genesis' | 'system',
): SenderIdentity {
  if (kind === 'genesis') {
    return { sender_type: 'genesis', sender_id: null, sender_name: 'Génesis IA', sender_role: null }
  }
  if (kind === 'system' || !profile) {
    return { sender_type: 'system', sender_id: null, sender_name: null, sender_role: null }
  }
  return {
    sender_type: senderTypeFromRole(profile.role),
    sender_id: profile.id,
    sender_name: profile.full_name,
    sender_role: profile.role,
  }
}

export const SENDER_LABELS: Record<SenderType, (name: string | null) => string> = {
  genesis: () => 'Génesis IA',
  courier: name => (name ? `Mensajero · ${name}` : 'Mensajero'),
  agent: name => (name ? `Agente · ${name}` : 'Agente'),
  admin: name => (name ? `Administrador · ${name}` : 'Administrador'),
  system: () => 'Sistema',
}

export function senderLabel(senderType: SenderType | null | undefined, senderName: string | null | undefined): string | null {
  if (!senderType) return null
  return SENDER_LABELS[senderType](senderName ?? null)
}
