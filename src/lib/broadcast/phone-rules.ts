// Sprint C.2 — reglas por TELÉFONO comunes a todos los templates de Broadcast.
//
// SERVER-ONLY, READ ONLY. Se calculan con los datos existentes (cola + mensajes),
// sin la migración 067 (que en el futuro hará persistentes los bloqueos):
//
//   frequency_cap_7d            — el teléfono recibió un Broadcast promocional (cualquier
//                                 template) en los últimos 7 días. Cuentan sent,
//                                 send_unknown y processing. NO cuentan failed, skipped ni
//                                 pendientes. No aplica a mensajes operativos fuera de Broadcast.
//   marketing_restricted_recent — Meta rechazó con 131049 (restricción de marketing del
//                                 destinatario) hace menos de 7 días. Regla interna: Meta no
//                                 garantiza aceptar el siguiente envío.
//   phone_unavailable_whatsapp  — Meta devolvió 131026 (no disponible en WhatsApp) y no hay
//                                 evidencia POSTERIOR de validez: mensaje entrante del cliente
//                                 o un delivered/read de Meta a ese número. Empate → bloqueado.
//                                 (El desbloqueo manual por admin llega con la 067.)
//
// Fechas: cola → processed_at / last_attempted_at / created_at; mensajes → sent_at (cota
// inferior verificable del fallo; la hora del webhook de fallo no se guarda).

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const PROMO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const CODE_PHONE_UNAVAILABLE = '131026'
export const CODE_MARKETING_RESTRICTED = '131049'

export type PhoneRestriction = 'phone_unavailable_whatsapp' | 'marketing_restricted_recent' | 'frequency_cap_7d'

export interface PhoneStatus {
  restriction: PhoneRestriction | null
  last_broadcast_at: string | null
  last_unavailable_at: string | null
  last_marketing_restriction_at: string | null
}

export interface PhoneRuleOptions {
  nowMs?: number
  excludeQueueIds?: Set<string>        // la fila que se está enviando (processor)
  excludeBroadcastId?: string          // el propio borrador (vista previa de lanzamiento)
}

const CHUNK = 100
const ms = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}
const maxMs = (...v: Array<number | null>): number | null => v.reduce<number | null>((m, x) => (x !== null && (m === null || x > m) ? x : m), null)
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString())

type QueueRow = {
  id: string; phone_normalized: string; broadcast_id: string | null; status: string
  meta_error_code: string | null; processed_at: string | null; last_attempted_at: string | null; created_at: string | null
}

export async function loadPhoneStatuses(
  db: SupabaseLike, storeId: string, phones: string[], o: PhoneRuleOptions = {},
): Promise<Map<string, PhoneStatus>> {
  const now = o.nowMs ?? Date.now()
  const unique = [...new Set(phones)]
  const lastBroadcast = new Map<string, number>()
  const lastUnavailable = new Map<string, number>()
  const lastRestricted = new Map<string, number>()
  const bump = (m: Map<string, number>, k: string, t: number | null) => { if (t !== null && t > (m.get(k) ?? -Infinity)) m.set(k, t) }

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK)

    // 1. Broadcasts recibidos (cualquier template).
    const { data: sentRows, error: e1 } = await db.from('wa_template_queue')
      .select('id, phone_normalized, broadcast_id, status, meta_error_code, processed_at, last_attempted_at, created_at')
      .eq('store_id', storeId).in('phone_normalized', chunk).not('broadcast_id', 'is', null)
      .in('status', ['sent', 'send_unknown', 'processing'])
    if (e1) throw new Error(`wa_template_queue(phone-rules sent): ${e1.message ?? String(e1)}`)
    for (const r of (sentRows ?? []) as QueueRow[]) {
      if (o.excludeQueueIds?.has(r.id)) continue
      if (o.excludeBroadcastId && r.broadcast_id === o.excludeBroadcastId) continue
      const t = r.status === 'processing'
        ? maxMs(ms(r.last_attempted_at), ms(r.created_at))
        : maxMs(ms(r.processed_at), ms(r.last_attempted_at), ms(r.created_at))
      bump(lastBroadcast, r.phone_normalized, t)
    }

    // 2. Rechazos inmediatos de Meta registrados en la cola.
    const { data: failRows, error: e2 } = await db.from('wa_template_queue')
      .select('id, phone_normalized, broadcast_id, status, meta_error_code, processed_at, last_attempted_at, created_at')
      .eq('store_id', storeId).in('phone_normalized', chunk).eq('status', 'failed')
      .in('meta_error_code', [CODE_PHONE_UNAVAILABLE, CODE_MARKETING_RESTRICTED])
    if (e2) throw new Error(`wa_template_queue(phone-rules failed): ${e2.message ?? String(e2)}`)
    for (const r of (failRows ?? []) as QueueRow[]) {
      const t = maxMs(ms(r.processed_at), ms(r.last_attempted_at))
      bump(r.meta_error_code === CODE_PHONE_UNAVAILABLE ? lastUnavailable : lastRestricted, r.phone_normalized, t)
    }

    // 3. Fallos reportados por webhook (wa_messages), vía contacto → conversación.
    const { data: contacts, error: e3 } = await db.from('wa_contacts').select('id, phone_normalized')
      .eq('store_id', storeId).in('phone_normalized', chunk)
    if (e3) throw new Error(`wa_contacts(phone-rules): ${e3.message ?? String(e3)}`)
    const phoneByContact = new Map(((contacts ?? []) as Array<{ id: string; phone_normalized: string }>).map(c => [c.id, c.phone_normalized]))
    if (phoneByContact.size > 0) {
      const { data: convs, error: e4 } = await db.from('wa_conversations').select('id, contact_id')
        .eq('store_id', storeId).in('contact_id', [...phoneByContact.keys()])
      if (e4) throw new Error(`wa_conversations(phone-rules): ${e4.message ?? String(e4)}`)
      const phoneByConv = new Map(((convs ?? []) as Array<{ id: string; contact_id: string }>).map(c => [c.id, phoneByContact.get(c.contact_id)!]))
      if (phoneByConv.size > 0) {
        const { data: msgs, error: e5 } = await db.from('wa_messages').select('conversation_id, error_code, sent_at')
          .eq('store_id', storeId).in('conversation_id', [...phoneByConv.keys()]).eq('direction', 'outbound').eq('status', 'failed')
          .in('error_code', [CODE_PHONE_UNAVAILABLE, CODE_MARKETING_RESTRICTED])
        if (e5) throw new Error(`wa_messages(phone-rules): ${e5.message ?? String(e5)}`)
        for (const m of (msgs ?? []) as Array<{ conversation_id: string; error_code: string; sent_at: string | null }>) {
          const phone = phoneByConv.get(m.conversation_id)
          if (phone) bump(m.error_code === CODE_PHONE_UNAVAILABLE ? lastUnavailable : lastRestricted, phone, ms(m.sent_at))
        }
      }
    }
  }

  // 4. Evidencia de validez POSTERIOR al último 131026 (solo para los bloqueados: pocos).
  const evidence = new Map<string, number>()
  for (const [phone, failedAt] of lastUnavailable) {
    const after = new Date(failedAt).toISOString()
    const { data: contacts } = await db.from('wa_contacts').select('id').eq('store_id', storeId).eq('phone_normalized', phone)
    const contactIds = ((contacts ?? []) as Array<{ id: string }>).map(c => c.id)
    if (contactIds.length === 0) continue
    const { data: convs } = await db.from('wa_conversations').select('id').eq('store_id', storeId).in('contact_id', contactIds)
    const convIds = ((convs ?? []) as Array<{ id: string }>).map(c => c.id)
    if (convIds.length === 0) continue
    const q = (col: string, dir: 'inbound' | 'outbound') => db.from('wa_messages').select(col)
      .eq('store_id', storeId).in('conversation_id', convIds).eq('direction', dir).gt(col, after).order(col, { ascending: false }).limit(1)
    const [inb, dlv, rd] = await Promise.all([q('sent_at', 'inbound'), q('delivered_at', 'outbound'), q('read_at', 'outbound')])
    const t = maxMs(
      ms((inb.data ?? [])[0]?.sent_at), ms((dlv.data ?? [])[0]?.delivered_at), ms((rd.data ?? [])[0]?.read_at),
    )
    if (t !== null && t > failedAt) evidence.set(phone, t)
  }

  const out = new Map<string, PhoneStatus>()
  for (const phone of unique) {
    const b = lastBroadcast.get(phone) ?? null
    const u = lastUnavailable.get(phone) ?? null
    const r = lastRestricted.get(phone) ?? null
    let restriction: PhoneRestriction | null = null
    if (u !== null && !(evidence.has(phone) && evidence.get(phone)! > u)) restriction = 'phone_unavailable_whatsapp'
    else if (r !== null && now - r < PROMO_WINDOW_MS) restriction = 'marketing_restricted_recent'
    else if (b !== null && now - b < PROMO_WINDOW_MS) restriction = 'frequency_cap_7d'
    out.set(phone, { restriction, last_broadcast_at: iso(b), last_unavailable_at: iso(u), last_marketing_restriction_at: iso(r) })
  }
  return out
}

// ── Clasificación de fallos de Meta (métricas e historial) ──────────────────
export type FailureCategory = 'phone_unavailable' | 'marketing_restricted' | 'template_config' | 'temporary_exhausted' | 'other'

const RATE_LIMIT_CODES = new Set(['4', '80007', '130429', '131056'])

export function classifyMetaFailure(code: string | null | undefined, errorMessage?: string | null): FailureCategory {
  const c = (code ?? '').trim()
  if (c === CODE_PHONE_UNAVAILABLE) return 'phone_unavailable'
  if (c === CODE_MARKETING_RESTRICTED) return 'marketing_restricted'
  if (/^132\d{3}$/.test(c)) return 'template_config'
  if (RATE_LIMIT_CODES.has(c) || /Meta API error (429|5\d\d)/.test(errorMessage ?? '')) return 'temporary_exhausted'
  return 'other'
}
