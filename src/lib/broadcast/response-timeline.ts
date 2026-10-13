// Línea de tiempo de respuestas a Broadcast por ENVÍO (fila de wa_template_queue).
//
// El historial (wa_broadcast_responses) se conserva completo; esta capa decide
// QUÉ significa: la última decisión del cliente y si cambió de opinión.
//
// Orden cronológico REAL: hora del mensaje del cliente (wa_messages.sent_at, el
// timestamp de Meta), no la hora en que el webhook lo procesó — un reintento de
// Meta que llega tarde no debe pasar por encima de una decisión más reciente.
// Desempate: hora de registro y luego id (determinístico).
//
// Duplicados CONSECUTIVOS de la misma intención (p. ej. pulsó el botón y además
// lo escribió, o dos webhooks a la vez) se colapsan al leer: nunca cuentan como
// cambio de decisión, y no hace falta descartar nada al escribir para que el
// resultado sea correcto.

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface ResponseEvent {
  id:                 string
  queue_id:           string | null
  intent:             string
  created_at:         string
  inbound_message_id: string | null
  message_at?:        string | null   // wa_messages.sent_at del mensaje del cliente
}

const ms = (v: string | null | undefined): number | null => {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

export function eventTime(e: Pick<ResponseEvent, 'message_at' | 'created_at'>): number {
  return ms(e.message_at) ?? ms(e.created_at) ?? 0
}

/** Orden cronológico real (más antiguo primero). */
export function compareEvents(a: ResponseEvent, b: ResponseEvent): number {
  return eventTime(a) - eventTime(b)
    || (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Intenciones del envío en orden real, sin repeticiones consecutivas. */
export function decisionPath(events: ResponseEvent[]): string[] {
  const path: string[] = []
  for (const e of [...events].sort(compareEvents)) {
    if (path[path.length - 1] !== e.intent) path.push(e.intent)
  }
  return path
}

export interface SendDecision {
  queue_id:     string
  latest:       string            // última intención válida
  previous:     string | null     // intención inmediatamente anterior distinta (si cambió)
  changed:      boolean
}

/** Última decisión por envío. Las respuestas sin envío asociado (unknown/none) no cuentan. */
export function decisionsBySend(events: ResponseEvent[]): Map<string, SendDecision> {
  const byQueue = new Map<string, ResponseEvent[]>()
  for (const e of events) {
    if (!e.queue_id || e.intent === 'unknown') continue
    byQueue.set(e.queue_id, [...(byQueue.get(e.queue_id) ?? []), e])
  }
  const out = new Map<string, SendDecision>()
  for (const [queue_id, evs] of byQueue) {
    const path = decisionPath(evs)
    out.set(queue_id, {
      queue_id, latest: path[path.length - 1],
      previous: path.length > 1 ? path[path.length - 2] : null,
      changed: path.length > 1,
    })
  }
  return out
}

/** Hora real de los mensajes del cliente (wa_messages.sent_at), por bloques. */
export async function loadMessageTimes(db: SupabaseLike, storeId: string, messageIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const ids = [...new Set(messageIds.filter(Boolean))]
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('wa_messages').select('id, sent_at').eq('store_id', storeId).in('id', ids.slice(i, i + 100))
    if (error) throw new Error(`wa_messages(times): ${error.message ?? String(error)}`)
    for (const m of (data ?? []) as Array<{ id: string; sent_at: string | null }>) out.set(m.id, m.sent_at)
  }
  return out
}

/** Completa message_at de cada respuesta. */
export async function withMessageTimes<T extends ResponseEvent>(db: SupabaseLike, storeId: string, events: T[]): Promise<T[]> {
  const times = await loadMessageTimes(db, storeId, events.map(e => e.inbound_message_id ?? '').filter(Boolean))
  return events.map(e => ({ ...e, message_at: e.inbound_message_id ? times.get(e.inbound_message_id) ?? null : null }))
}
