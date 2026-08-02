// Customer Intelligence Engine — Fase 1 (identidad).
// Contrato canónico de normalización de teléfono — ver
// docs/CUSTOMER_INTELLIGENCE_ARCHITECTURE_V1.md sección 3.4.
//
// Deliberadamente separado de src/lib/normalize-phone.ts (normalizePhoneRD),
// que sigue siendo la función que usan hoy los webhooks de Shopify/WhatsApp
// sin cambios — esta función no los reemplaza en esta fase, solo es la base
// del nuevo motor de identidad.
//
// Alcance honesto de v1: sin una librería de parsing internacional (no
// instalada, no se agrega en esta fase), esta función resuelve con
// confianza los formatos dominicanos/NANP (10 dígitos, 11 con prefijo '1',
// con o sin '+', con separadores). Para números internacionales no-NANP con
// '+' explícito, se reconoce que NO son dominicanos (nunca se les fuerza el
// prefijo '1') pero no se garantiza un split confiable de
// country_code/national_number — quedan marcados como
// reconocidos-pero-no-desglosados (`valid=true`, ambos campos en `null`) en
// vez de mal-etiquetados como República Dominicana.

export interface NormalizedPhoneResult {
  normalized_e164: string | null
  country_code:    string | null
  national_number: string | null
  valid:            boolean
  reason:           string | null
  // 'empty' | 'too_short' | 'too_long' | 'ambiguous_country_code' | null
}

const INVALID = (reason: string): NormalizedPhoneResult => ({
  normalized_e164: null,
  country_code:    null,
  national_number: null,
  valid:            false,
  reason,
})

/**
 * Normaliza un número de teléfono a formato E.164.
 *
 * @param raw            Valor crudo (puede traer espacios, guiones, paréntesis,
 *                        '+', extensión).
 * @param defaultCountry  Reservado para desambiguar formatos NANP de 10 dígitos
 *                        sin '+' (hoy solo se soporta 'DO' — República
 *                        Dominicana comparte el plan de numeración NANP con
 *                        el resto de códigos de área +1, así que no hace
 *                        falta distinguir 809/829/849 de otros códigos de
 *                        área NANP para este propósito).
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry: 'DO' = 'DO',
): NormalizedPhoneResult {
  void defaultCountry // reservado — ver nota arriba, no cambia el comportamiento hoy

  if (!raw || !raw.trim()) return INVALID('empty')

  const trimmed = raw.trim()
  const hadPlus = trimmed.startsWith('+')

  // Descarta una extensión final ("ext. 123", "x123") antes de extraer dígitos —
  // puede aparecer en datos importados por CSV histórico.
  const withoutExt = trimmed.replace(/\s*(?:ext\.?|x)\s*\d+\s*$/i, '')

  const digits = withoutExt.replace(/\D/g, '')

  if (digits.length === 0) return INVALID('empty')
  if (digits.length < 7)   return INVALID('too_short')
  if (digits.length > 15)  return INVALID('too_long')

  // NANP de 10 dígitos sin código de país explícito (formato dominante hoy
  // en orders.customer_phone antes de normalizar).
  if (digits.length === 10) {
    return {
      normalized_e164: `+1${digits}`,
      country_code:    '1',
      national_number: digits,
      valid:            true,
      reason:           null,
    }
  }

  // NANP de 11 dígitos con el '1' ya incluido (con o sin '+').
  if (digits.length === 11 && digits[0] === '1') {
    const national = digits.slice(1)
    return {
      normalized_e164: `+${digits}`,
      country_code:    '1',
      national_number: national,
      valid:            true,
      reason:           null,
    }
  }

  // Número internacional marcado explícitamente con '+' — se reconoce como
  // válido y NO se le fuerza el prefijo '1', pero sin tabla de códigos de
  // país no se garantiza el split de country_code/national_number.
  if (hadPlus && digits.length >= 8 && digits.length <= 15) {
    return {
      normalized_e164: `+${digits}`,
      country_code:    null,
      national_number: null,
      valid:            true,
      reason:           null,
    }
  }

  // Todo lo demás es ambiguo: ni encaja en NANP ni trae un '+' explícito
  // que indique intención de código de país — no se adivina.
  if (digits.length < 10) return INVALID('too_short')
  return INVALID('ambiguous_country_code')
}
