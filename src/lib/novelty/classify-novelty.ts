import type { NoveltyType } from '@/types'

// Vocabulario calibrado contra datos reales de Gintracom/EFI (diagnóstico 2026-07-11):
// el sujeto siempre es "Destinatario" (no "cliente"), y el verbo que sigue es la
// señal real de si hubo o no comunicación — el motivo logístico por sí solo
// (ausente, dirección incorrecta, zona peligrosa) nunca decide la clasificación.

const CONTACTED_PATTERNS: RegExp[] = [
  /\bindica\b/,        // "Destinatario indica que..."
  /\binforma\b/,       // "Destinatario informa..."
  /\bsolicita\b/,       // "Destinatario solicita..."
  /\bagenda\b/,         // "Destinatario agenda fecha y hora..."
  /re\s*programa/,      // tolera "re programa" y "reprograma"
  /\brechaz/,           // rechaza, rechazó, rechazo
  /\brehus/,            // rehusa, rehusó
  /ya no desea/,
  /no tiene(?:\s+el)?\s+dinero/,
  /cambi[oó]\s+(?:la\s+)?direccion/,
  /\bacord[oó]\b/,
  /\bconfirma\b/,
]

const NO_CONTACT_PATTERNS: RegExp[] = [
  /no contesta/,
  /no responde/,
  /no fue posible contactar/,
  /no se logr[oó]\s+(?:el\s+)?contacto/,
  /telefono apagado/,
  /numero apagado/,
  /fuera de servicio/,
  /sin respuesta/,
  /llamada no contestada/,
  /whatsapp sin respuesta/,
  /no visualizado/,
]

export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Clasifica la condición comunicacional del evento de novedad más reciente
 * reportado por la transportadora, a partir del texto crudo (last_attempt_reason).
 *
 * No usa raw_status como señal (en los datos reales es "Novedad" en ~100% de
 * los casos — no aporta información). Recibe el texto como argumento explícito
 * (no consulta `orders`) para poder reutilizarse sin cambios en una futura
 * arquitectura por eventos.
 *
 * Evidencia ambigua o ausente → null (no se asume). La UI decide qué hacer con
 * los casos null (vista "Sin contacto" con advertencia, confirmación manual).
 */
export function classifyNovelty(reason: string | null | undefined): NoveltyType | null {
  if (!reason || !reason.trim()) return null

  const text = normalizeText(reason)

  if (CONTACTED_PATTERNS.some(re => re.test(text)))  return 'contacted'
  if (NO_CONTACT_PATTERNS.some(re => re.test(text))) return 'no_contact'
  return null
}
