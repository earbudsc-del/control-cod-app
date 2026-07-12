import { parseEFIDate } from '@/lib/tracking/parse-efi-date'
import { classifyNovelty } from './classify-novelty'

export interface NovedadEvent {
  fecha:   string
  mensaje: string
}

// tracking_novedades se guarda con el evento más reciente en el índice 0
// (orden descendente) — NUNCA confiar en la posición del array para decidir
// "cuál es el más reciente" (ese supuesto, en la dirección contraria, causó
// que una reprogramación antigua se tratara como vigente). Se ordena
// explícitamente por la fecha real parseada de cada evento.
export function sortNovedadesByDateDesc(events: NovedadEvent[]): NovedadEvent[] {
  return events
    .map(e => ({ event: e, time: parseEFIDate(e.fecha) }))
    .filter((x): x is { event: NovedadEvent; time: string } => !!x.time)
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .map(x => x.event)
}

/**
 * El evento de novedad realmente más reciente, determinado por fecha — no
 * por posición en el arreglo. Única fuente de verdad para decidir
 * novelty_type / delivery_resolution / rescheduled_date vigentes.
 */
export function getLatestNovedadEvent(events: NovedadEvent[] | null | undefined): NovedadEvent | null {
  if (!events || events.length === 0) return null
  const sorted = sortNovedadesByDateDesc(events)
  return sorted[0] ?? null
}

/**
 * Cuenta los intentos consecutivos sin contacto empezando por el evento más
 * reciente y contando hacia atrás mientras cada evento clasifique como
 * no_contact. Se detiene en el primer evento contacted/ambiguo — igual que
 * detenerse en una reprogramación, porque el texto de reprogramación ya
 * clasifica como 'contacted' vía classifyNovelty.
 */
export function countConsecutiveNoContact(events: NovedadEvent[] | null | undefined): number {
  if (!events || events.length === 0) return 0
  const sorted = sortNovedadesByDateDesc(events)
  let count = 0
  for (const e of sorted) {
    if (classifyNovelty(e.mensaje) !== 'no_contact') break
    count++
  }
  return count
}
