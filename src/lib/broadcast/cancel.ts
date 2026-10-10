// Sprint C.1.4 (F2) — cancelación MANUAL de una campaña de Broadcast.
//
// Nunca se cancela nada automáticamente: solo un admin, desde el endpoint
// PATCH /api/admin/broadcasts/[id]/cancel. Cancelar no envía nada, por eso
// (igual que pausar) no exige WA_BROADCAST_ENABLED.
//
// Qué conserva / qué libera:
//   - sent, failed, send_unknown, skipped y processing (en vuelo) NO se tocan:
//     son historial real (Meta aceptó, rechazó o no se sabe) y siguen
//     excluyendo ese teléfono de campañas futuras.
//   - pending (Meta nunca aceptó ese mensaje) se LIBERA: se elimina la fila
//     de la cola. Es la única forma, sin migración, de no bloquear al
//     destinatario: UNIQUE(order_id, template_name) (033) impide otra fila
//     del mismo pedido y broadcast_id es inmutable (064), así que la fila no
//     puede reasignarse a otra campaña.
//   - Antes de eliminar se deja rastro por pedido en order_history (quién,
//     campaña, intentos). Si ese registro falla NO se elimina nada.
//
// Idempotente: repetir la cancelación de una campaña ya cancelada solo vuelve
// a liberar pendientes rezagados (p.ej. una fila que el processor devolvió a
// pending justo después de la primera limpieza).
//
// Envíos en vuelo: el processor relee el estado justo antes de llamar a Meta,
// así que tras el cambio a 'cancelled' ningún envío NUEVO puede empezar. Solo
// una fila ya en 'processing' que pasó esa última lectura puede seguir hacia
// Meta. Por eso la cancelación no se confirma hasta que esas filas terminan
// (sent / failed / send_unknown / devuelta a pending → liberada), con un tope
// mayor que el timeout de Meta. Si alguna no termina a tiempo se informa en
// `in_flight_unsettled`: ese envío puede haber salido y queda excluido de
// campañas futuras igual que un send_unknown.

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const CANCELLABLE_STATUSES = ['draft', 'queued', 'processing', 'paused'] as const

const CHUNK = 100
// > META_TIMEOUT_MS (10 s) de send-template.ts.
export const CANCEL_INFLIGHT_WAIT_MS = 15_000
const CANCEL_POLL_MS = 500
// Filas 'processing' más viejas que esto son de un worker muerto (mismo
// umbral que el processor): no se espera por ellas.
const STALE_PROCESSING_MS = 10 * 60_000

export interface CancelOptions {
  sleep?:     (ms: number) => Promise<void>
  msNow?:     () => number
  maxWaitMs?: number
}

/** Espera a que terminen los envíos en vuelo. Devuelve cuántos siguen sin terminar. */
async function waitForInFlight(db: SupabaseLike, storeId: string, broadcastId: string, o: CancelOptions): Promise<number> {
  const msNow = o.msNow ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const deadline = msNow() + (o.maxWaitMs ?? CANCEL_INFLIGHT_WAIT_MS)
  for (;;) {
    const { data, error } = await db.from('wa_template_queue').select('id')
      .eq('store_id', storeId).eq('broadcast_id', broadcastId).eq('status', 'processing')
      .gte('last_attempted_at', new Date(msNow() - STALE_PROCESSING_MS).toISOString())
    if (error) throw new Error(`wa_template_queue(in-flight): ${error.message ?? String(error)}`)
    const n = (data ?? []).length
    if (n === 0 || msNow() >= deadline) return n
    await sleep(CANCEL_POLL_MS)
  }
}

export interface ReleaseResult { released: number }

/**
 * Libera las filas 'pending' de una campaña (nunca enviadas). Server-only.
 * `userId` null = liberación del sistema (processor) sobre una campaña que
 * un admin ya canceló.
 */
export async function releaseUnsentRecipients(
  db: SupabaseLike, storeId: string, broadcastId: string, userId: string | null, nowIso: string,
): Promise<ReleaseResult> {
  const { data, error } = await db.from('wa_template_queue').select('id, order_id, attempt_count')
    .eq('store_id', storeId).eq('broadcast_id', broadcastId).eq('status', 'pending')
  if (error) throw new Error(`wa_template_queue(release): ${error.message ?? String(error)}`)
  const pending = (data ?? []) as Array<{ id: string; order_id: string; attempt_count: number | null }>
  if (pending.length === 0) return { released: 0 }

  const short = broadcastId.slice(0, 8)
  let released = 0
  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK)
    // 1. Rastro primero: sin historial no se elimina nada.
    const { error: histErr } = await db.from('order_history').insert(chunk.map(r => ({
      order_id: r.order_id, changed_by: userId, field: 'whatsapp_broadcast',
      old_value: `pendiente de envío · campaña ${short} · intentos ${r.attempt_count ?? 0}`,
      new_value: `liberado sin enviar · campaña cancelada · ${nowIso}`,
    })))
    if (histErr) throw new Error(`order_history(release): ${histErr.message ?? String(histErr)}`)
    // 2. Solo filas que SIGUEN pending (una tomada por el processor no se toca).
    const { data: gone, error: delErr } = await db.from('wa_template_queue').delete()
      .in('id', chunk.map(r => r.id)).eq('broadcast_id', broadcastId).eq('status', 'pending').select('id')
    if (delErr) throw new Error(`wa_template_queue(release delete): ${delErr.message ?? String(delErr)}`)
    released += (gone ?? []).length
  }
  return { released }
}

export type CancelResult =
  | { ok: true; released: number; already_cancelled: boolean; in_flight_unsettled: number }
  | { ok: false; status: number; error: string }

export async function cancelBroadcast(
  db: SupabaseLike, ctx: { userId: string; storeId: string }, id: string, nowFn: () => string = () => new Date().toISOString(),
  opts: CancelOptions = {},
): Promise<CancelResult> {
  const { data: b, error } = await db.from('wa_broadcasts').select('id, status').eq('id', id).eq('store_id', ctx.storeId).maybeSingle()
  if (error) throw new Error(`wa_broadcasts(cancel): ${error.message ?? String(error)}`)
  if (!b) return { ok: false, status: 404, error: 'Campaña no encontrada' }

  const status = (b as { status: string }).status
  const already = status === 'cancelled'
  if (!already) {
    if (!(CANCELLABLE_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, status: 409, error: `No se puede cancelar una campaña en estado ${status}` }
    }
    // Transición condicionada al estado observado: si cambió en medio
    // (p.ej. el processor la completó), no se pisa.
    const { data: moved, error: moveErr } = await db.from('wa_broadcasts')
      .update({ status: 'cancelled', cancelled_at: nowFn() })
      .eq('id', id).eq('store_id', ctx.storeId).eq('status', status).select('id').maybeSingle()
    if (moveErr) throw new Error(`wa_broadcasts(cancel update): ${moveErr.message ?? String(moveErr)}`)
    if (!moved) return { ok: false, status: 409, error: 'El estado de la campaña cambió — recarga y vuelve a intentar' }
  }

  // Primero se deja terminar lo que ya estaba con Meta; luego se libera
  // (incluye filas que el processor devolvió a pending al ver la cancelación).
  const inFlight = await waitForInFlight(db, ctx.storeId, id, opts)
  const { released } = await releaseUnsentRecipients(db, ctx.storeId, id, ctx.userId, nowFn())
  return { ok: true, released, already_cancelled: already, in_flight_unsettled: inFlight }
}
