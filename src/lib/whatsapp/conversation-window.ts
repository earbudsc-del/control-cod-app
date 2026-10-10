// Sprint C.1 — ventana de atención de WhatsApp (24 h).
//
// Meta solo permite mensajes libres (texto) dentro de las 24 h siguientes al
// último mensaje del CLIENTE. Fuera de esa ventana exige un template
// aprobado. Un template de Broadcast saliente NO abre la ventana: la abre la
// respuesta del cliente (incluido pulsar un botón).

export const SERVICE_WINDOW_HOURS = 24

export function isWithinServiceWindow(lastInboundAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false
  const t = Date.parse(lastInboundAt)
  if (Number.isNaN(t)) return false
  return now.getTime() - t < SERVICE_WINDOW_HOURS * 60 * 60 * 1000
}

export const OUTSIDE_WINDOW_ERROR =
  'Fuera de la ventana de 24 h de WhatsApp: el cliente no ha escrito en las últimas 24 horas. ' +
  'Solo se puede enviar un template aprobado.'

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function lastInboundAt(db: SupabaseLike, conversationId: string): Promise<string | null> {
  const { data } = await db.from('wa_messages').select('sent_at')
    .eq('conversation_id', conversationId).eq('direction', 'inbound')
    .order('sent_at', { ascending: false }).limit(1).maybeSingle()
  return (data as { sent_at: string | null } | null)?.sent_at ?? null
}
