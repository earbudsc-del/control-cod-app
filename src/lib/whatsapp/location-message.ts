// Ubicaciones compartidas por WhatsApp en el Inbox.
//
// El webhook guarda cada pin en wa_messages (message_type='location') con
// metadata { latitude, longitude, name, address }. Este módulo solo LEE esos
// datos para mostrarlos; no cambia el webhook ni la asignación al pedido
// (src/lib/whatsapp/inbound-location.ts sigue siendo la única que escribe).
//
// Las funciones puras son client-safe; attachLinkedOrders es de servidor.

export interface LocationInfo {
  latitude:  number
  longitude: number
  name:      string | null
  address:   string | null
}

function finite(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Datos de ubicación de un mensaje, o null si no hay coordenadas válidas. */
export function parseLocation(metadata: unknown): LocationInfo | null {
  if (!metadata || typeof metadata !== 'object') return null
  const m = metadata as Record<string, unknown>
  const latitude = finite(m.latitude), longitude = finite(m.longitude)
  if (latitude === null || longitude === null) return null
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null
  return { latitude, longitude, name: text(m.name), address: text(m.address) }
}

/** Enlace directo a Google Maps con las coordenadas reales (sin depender de la dirección). */
export function googleMapsUrl(l: Pick<LocationInfo, 'latitude' | 'longitude'>): string {
  return `https://www.google.com/maps?q=${l.latitude},${l.longitude}`
}

export function formatCoordinates(l: Pick<LocationInfo, 'latitude' | 'longitude'>): string {
  return `${l.latitude.toFixed(6)}, ${l.longitude.toFixed(6)}`
}

// Mismo formato que makePreview() del webhook para mensajes sin texto: "[tipo]".
const TYPE_PREVIEW: Record<string, string> = { location: '📍 Ubicación' }

/** Vista previa legible para la lista de conversaciones. */
export function displayPreview(preview: string | null | undefined): string | null {
  if (!preview) return preview ?? null
  const m = preview.match(/^\[(\w+)\]$/)
  return m && TYPE_PREVIEW[m[1]] ? TYPE_PREVIEW[m[1]] : preview
}

/** Vista previa de un mensaje recibido en tiempo real (igual criterio que el webhook). */
export function messagePreview(msg: { body: string | null; message_type: string }): string {
  return msg.body?.trim() ? msg.body.trim().slice(0, 150) : `[${msg.message_type}]`
}

// ── Servidor ─────────────────────────────────────────────────────────────────

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

type MessageRow = { message_type: string; wa_msg_id: string; [k: string]: unknown }

/**
 * Agrega linked_order_number a los mensajes de ubicación de la página: el
 * pedido cuya ubicación SD es ese pin (orders.sd_location_wa_msg_id, escrito
 * por la asignación automática o manual). Una sola consulta, y solo si la
 * página trae ubicaciones; si falla, los mensajes se devuelven sin la marca.
 */
export async function attachLinkedOrders<T extends MessageRow>(db: SupabaseLike, storeId: string, messages: T[]): Promise<Array<T & { linked_order_number?: string | null }>> {
  const ids = [...new Set(messages.filter(m => m.message_type === 'location' && m.wa_msg_id).map(m => m.wa_msg_id))]
  if (ids.length === 0) return messages
  const { data, error } = await db.from('orders').select('order_number, sd_location_wa_msg_id')
    .eq('store_id', storeId).in('sd_location_wa_msg_id', ids)
  if (error) return messages
  const byMsg = new Map(((data ?? []) as Array<{ order_number: string | null; sd_location_wa_msg_id: string }>)
    .map(o => [o.sd_location_wa_msg_id, o.order_number]))
  return messages.map(m => (m.message_type === 'location' ? { ...m, linked_order_number: byMsg.get(m.wa_msg_id) ?? null } : m))
}
