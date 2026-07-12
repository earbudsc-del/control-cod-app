import { normalizeText } from './classify-novelty'

// Evidencia explícita de que la transportadora reporta un acuerdo de
// reprogramación (no cualquier "contacted" genérico — "indica que ya no
// desea el producto" es contacted pero no implica una fecha acordada).
const RESCHEDULE_EVIDENCE_PATTERNS: RegExp[] = [
  /re\s*programa/,          // "re programa" / "reprograma"
  /reprogramad/,            // "reprogramada" / "reprogramado"
  /agenda/,                 // "agenda fecha y hora de entrega"
  /acuerda\s*(fecha|entrega)?/,
  /programa\s*(la\s*)?entrega/,
]

// Formatos reales tolerados, en orden (el primero que matchee con fecha
// válida gana): "2026 07 13", "2026-07-13", "13/07/2026", "13-07-2026".
const DATE_PATTERNS: Array<{ regex: RegExp; toYMD: (m: RegExpMatchArray) => [number, number, number] }> = [
  { regex: /(\d{4})\s+(\d{2})\s+(\d{2})/, toYMD: m => [+m[1], +m[2], +m[3]] },
  { regex: /(\d{4})-(\d{2})-(\d{2})/,     toYMD: m => [+m[1], +m[2], +m[3]] },
  { regex: /(\d{2})\/(\d{2})\/(\d{4})/,   toYMD: m => [+m[3], +m[2], +m[1]] }, // DD/MM/YYYY
  { regex: /(\d{2})-(\d{2})-(\d{4})/,     toYMD: m => [+m[3], +m[2], +m[1]] }, // DD-MM-YYYY
]

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function hasRescheduleEvidence(reason: string | null | undefined): boolean {
  if (!reason) return false
  const text = normalizeText(reason)
  return RESCHEDULE_EVIDENCE_PATTERNS.some(re => re.test(text))
}

/**
 * Devuelve la fecha acordada (YYYY-MM-DD) SOLO cuando el texto crudo trae
 * evidencia explícita de reprogramación Y una fecha parseable en alguno de
 * los formatos reales conocidos. Nunca inventa ni asume una fecha — si hay
 * evidencia de reprogramación pero ninguna fecha válida, devuelve null.
 */
export function extractRescheduleDate(reason: string | null | undefined): string | null {
  if (!reason || !hasRescheduleEvidence(reason)) return null

  for (const { regex, toYMD } of DATE_PATTERNS) {
    const match = regex.exec(reason)
    if (!match) continue
    const [y, m, d] = toYMD(match)
    if (isValidDate(y, m, d)) return `${y}-${pad(m)}-${pad(d)}`
  }
  return null
}
