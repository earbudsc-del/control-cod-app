/**
 * Convierte un string de fecha crudo de EFI a ISO 8601 (UTC).
 * Retorna null si el string es vacío, nulo, o no tiene formato reconocible.
 * Nunca lanza excepción — es seguro usarlo en el path crítico del cron.
 *
 * Formatos soportados (todos observados en EFI Commerce):
 *   YYYY-MM-DD HH:mm AM/PM  → "2026-04-24 11:51 AM"  (formato actual EFI)
 *   DD/MM/YYYY HH:mm        → "13/04/2025 10:15"      (legado)
 *   DD/MM/YYYY HH:mm:ss     → "13/04/2025 10:15:30"   (legado)
 *   DD/MM/YYYY              → "13/04/2025"             (legado, solo fecha)
 *   D/M/YYYY HH:mm          → "3/4/2025 08:00"         (legado, sin cero líder)
 *   DD MMM YYYY             → "13 ABR 2025"             (mes abreviado ES)
 *   DD MMMM YYYY            → "13 ABRIL 2025"           (mes completo ES)
 */

const MONTH_ES: Record<string, number> = {
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
  jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11,
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
}

// YYYY-MM-DD HH:mm AM/PM  (formato actual de EFI Commerce)
const RE_ISO_AMPM   = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+([AaPp][Mm])$/

// DD/MM/YYYY con hora opcional (legado)
const RE_NUMERIC    = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/

// DD (mes en texto ES) YYYY con hora opcional
const RE_TEXT_MONTH = /^(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/i

function makeDate(
  year: number, month: number, day: number,
  hour = 0, minute = 0, second = 0,
): string | null {
  // Validación básica antes de crear el objeto Date
  if (month < 0 || month > 11) return null
  if (day < 1 || day > 31)     return null
  if (hour < 0 || hour > 23)   return null
  if (minute < 0 || minute > 59) return null

  const d = new Date(Date.UTC(year, month, day, hour, minute, second))
  // Date.UTC acepta overflow de días sin error, así que verificamos que el mes no se corrió
  if (d.getUTCMonth() !== month) return null

  return d.toISOString()
}

export function parseEFIDate(raw: string | null | undefined): string | null {
  if (!raw) return null

  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s) return null

  // ── Formato actual: YYYY-MM-DD HH:mm AM/PM ───────────────────────────────
  const m0 = s.match(RE_ISO_AMPM)
  if (m0) {
    let hour = parseInt(m0[4]!)
    const minute   = parseInt(m0[5]!)
    const meridiem = m0[6]!.toUpperCase()
    // Conversión 12h → 24h: 12 AM = 0h, 12 PM = 12h, resto suma 12 si PM
    if (meridiem === 'AM' && hour === 12) hour = 0
    if (meridiem === 'PM' && hour !== 12) hour += 12
    return makeDate(
      parseInt(m0[1]!),      // year
      parseInt(m0[2]!) - 1,  // month (0-indexed)
      parseInt(m0[3]!),      // day
      hour,
      minute,
    )
  }

  // ── Formato numérico: DD/MM/YYYY [HH:mm[:ss]] ────────────────────────────
  const m1 = s.match(RE_NUMERIC)
  if (m1) {
    return makeDate(
      parseInt(m1[3]!),      // year
      parseInt(m1[2]!) - 1,  // month (0-indexed)
      parseInt(m1[1]!),      // day
      m1[4] ? parseInt(m1[4]) : 0,
      m1[5] ? parseInt(m1[5]) : 0,
      m1[6] ? parseInt(m1[6]) : 0,
    )
  }

  // ── Formato texto ES: DD MMMM YYYY [HH:mm[:ss]] ──────────────────────────
  const m2 = s.match(RE_TEXT_MONTH)
  if (m2) {
    const monthIdx = MONTH_ES[m2[2]!.toLowerCase()]
    if (monthIdx === undefined) return null
    return makeDate(
      parseInt(m2[3]!),
      monthIdx,
      parseInt(m2[1]!),
      m2[4] ? parseInt(m2[4]) : 0,
      m2[5] ? parseInt(m2[5]) : 0,
      m2[6] ? parseInt(m2[6]) : 0,
    )
  }

  return null
}
