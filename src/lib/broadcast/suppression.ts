// Sprint C.1 — supresión de comunicaciones promocionales.
//
// Tres situaciones DISTINTAS que nunca se tratan como equivalentes:
//   1. Rechazar un pedido      ("Ya no lo deseo")     → intención decline_order, NO es baja.
//   2. Rechazar una oferta     ("Ahora no")           → repurchase_decline, NO es baja.
//   3. Pedir no recibir más mensajes promocionales    → marketing_opt_out = true.
//
// Solo (3) suprime envíos futuros. La detección automática es deliberadamente
// estrecha (frases inequívocas); ante la duda NO se marca — el agente puede
// marcar la baja manualmente desde el Inbox.

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

// Mensaje completo de UNA palabra/expresión de baja.
const EXACT = new Set(['stop', 'baja', 'darme de baja', 'dame de baja', 'unsubscribe', 'no mas mensajes', 'no mas'])

// Frases inequívocas dentro de un mensaje más largo.
const PHRASES: RegExp[] = [
  /\bno (me )?(escriban|escribas|envien|envies|manden|mandes|contacten|contactes|molesten|molestes)( mas)?\b/,
  /\bno quiero (recibir|que me (envien|manden|escriban))( mas)? (mensajes|promociones|ofertas|publicidad)\b/,
  /\b(dejen|deja) de (escribirme|enviarme|mandarme|contactarme)\b/,
  /\b(eliminen|elimina|borren|borra|saquen|saca) mi (numero|contacto)\b/,
  /\b(darme|dame|denme) de baja\b/,
]

export function isMarketingOptOutRequest(text: string | null | undefined): boolean {
  if (!text) return false
  const t = norm(text)
  if (!t) return false
  if (EXACT.has(t)) return true
  return PHRASES.some(re => re.test(t))
}

/** Teléfonos (de `phones`) con baja promocional activa en la tienda. */
export async function loadOptedOutPhones(db: SupabaseLike, storeId: string, phones: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  const unique = [...new Set(phones)]
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await db.from('wa_contact_preferences').select('phone_normalized')
      .eq('store_id', storeId).eq('marketing_opt_out', true).in('phone_normalized', unique.slice(i, i + 100))
    if (error) throw new Error(`wa_contact_preferences: ${error.message ?? String(error)}`)
    for (const r of (data ?? []) as Array<{ phone_normalized: string }>) out.add(r.phone_normalized)
  }
  return out
}

export interface RecordOptOutInput {
  storeId:         string
  phoneNormalized: string
  source:          'customer_keyword' | 'agent'
  reason:          string
  userId?:         string | null
  sourceMessageId?: string | null
  now?:            string
}

/** Marca (o re-marca) la baja. Idempotente por UNIQUE(store_id, phone_normalized). */
export async function recordMarketingOptOut(db: SupabaseLike, i: RecordOptOutInput): Promise<{ ok: boolean; error?: string }> {
  const now = i.now ?? new Date().toISOString()
  const { error } = await db.from('wa_contact_preferences').upsert({
    store_id: i.storeId, phone_normalized: i.phoneNormalized, marketing_opt_out: true,
    opted_out_at: now, opt_out_source: i.source, opt_out_reason: i.reason.slice(0, 200),
    opted_out_by: i.userId ?? null, source_message_id: i.sourceMessageId ?? null, updated_at: now,
  }, { onConflict: 'store_id,phone_normalized' })
  return error ? { ok: false, error: error.message ?? String(error) } : { ok: true }
}
