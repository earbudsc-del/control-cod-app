import type { SupabaseClient } from '@supabase/supabase-js'
import { parseEFITracking } from '@/lib/tracking/efi-parser'
import { parseEFIDate }     from '@/lib/tracking/parse-efi-date'

const EFI_BASE = 'https://effi.com.co/tracking/index'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReconcileOutcome =
  | 'assigned'            // 1 match — tracking asignado, estado EFI aplicado
  | 'multiple_candidates' // 2+ matches — admin debe elegir
  | 'no_match'            // 0 matches con ese teléfono
  | 'efi_not_found'       // EFI no conoce la guía
  | 'efi_error'           // fallo de red o HTTP al consultar EFI
  | 'already_assigned'    // la guía ya está en otra orden

export interface OrderCandidate {
  id:                        string
  order_number:              string | null
  customer_name:             string | null
  customer_phone:            string | null
  customer_address:          string | null
  city:                      string | null
  created_at:                string
  last_confirmation_attempt: string | null
}

export interface ReconcileResult {
  outcome:        ReconcileOutcome
  tracking_number: string
  efi?: {
    found:             boolean
    estado_actual:     string | null
    normalized_status: string
    attempts:          number
  }
  assigned_order?: {
    id:                string
    order_number:      string | null
    customer_name:     string | null
    normalized_status: string
  }
  candidates?:    OrderCandidate[]
  existing_order?: { id: string; order_number: string | null }
  error?:         string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function normalizePhone(raw: string): string {
  const d = raw.replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('1')) return d.slice(1)
  return d.length > 10 ? d.slice(-10) : d
}

function isValidEstadoText(s: string | null): boolean {
  if (!s) return false
  const n = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  return !n.includes('histor') && !n.includes('novedades')
}

// ── Core reconciliation logic ─────────────────────────────────────────────────

export async function reconcileEFIGuide({
  tracking_number,
  phone,
  supabase,
}: {
  tracking_number: string
  phone:           string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:        SupabaseClient<any>
}): Promise<ReconcileResult> {
  const tn             = tracking_number.trim()
  const normalizedPhone = normalizePhone(phone)

  if (!normalizedPhone || normalizedPhone.length < 7) {
    return { outcome: 'efi_error', tracking_number: tn, error: 'Teléfono inválido (menos de 7 dígitos)' }
  }

  // 1. Verificar que la guía no esté en otra orden
  const { data: existing } = await supabase
    .from('orders')
    .select('id, order_number')
    .eq('tracking_number', tn)
    .limit(1)
    .maybeSingle()

  if (existing) {
    return {
      outcome:        'already_assigned',
      tracking_number: tn,
      existing_order: { id: existing.id, order_number: existing.order_number },
    }
  }

  // 2. Consultar EFI en tiempo real
  let efiResult: ReturnType<typeof parseEFITracking>
  try {
    const res = await fetch(`${EFI_BASE}/${encodeURIComponent(tn)}`, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-419,es;q=0.9',
        'Cache-Control':   'no-cache',
      },
      cache:  'no-store',
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      return { outcome: 'efi_error', tracking_number: tn, error: `EFI HTTP ${res.status}` }
    }
    efiResult = parseEFITracking(await res.text(), tn)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error de red'
    return { outcome: 'efi_error', tracking_number: tn, error: msg }
  }

  if (!efiResult.encontrado) {
    return {
      outcome:        'efi_not_found',
      tracking_number: tn,
      efi: { found: false, estado_actual: null, normalized_status: 'unknown', attempts: 0 },
    }
  }

  // 3. Buscar órdenes confirmadas sin tracking que coincidan con el teléfono
  // ILIKE con los últimos 7 dígitos (tolerante a formatos) + match exacto en JS
  const last7 = normalizedPhone.slice(-7)

  const { data: rawCandidates } = await supabase
    .from('orders')
    .select('id, order_number, customer_name, customer_phone, customer_address, city, created_at, last_confirmation_attempt')
    .eq('confirmation_status', 'confirmed')
    .is('tracking_number', null)
    .ilike('customer_phone', `%${last7}%`)
    .neq('normalized_status', 'delivered')
    .neq('normalized_status', 'returned')
    .limit(10)

  const matched: OrderCandidate[] = (rawCandidates ?? []).filter(
    (o: OrderCandidate) => normalizePhone(o.customer_phone ?? '') === normalizedPhone,
  )

  if (matched.length === 0) {
    return {
      outcome:        'no_match',
      tracking_number: tn,
      efi: { found: true, estado_actual: efiResult.estado_actual, normalized_status: efiResult.normalized_status, attempts: efiResult.attempts },
    }
  }

  if (matched.length > 1) {
    return {
      outcome:        'multiple_candidates',
      tracking_number: tn,
      efi: { found: true, estado_actual: efiResult.estado_actual, normalized_status: efiResult.normalized_status, attempts: efiResult.attempts },
      candidates: matched,
    }
  }

  // 4. Exactamente 1 match — asignar
  const target = matched[0]!

  // Si EFI no pudo clasificar el estado, usar in_transit como mínimo viable
  // (sabemos que la guía existe en EFI, por lo tanto está al menos en tránsito)
  const effectiveStatus = efiResult.normalized_status === 'unknown' ? 'in_transit' : efiResult.normalized_status

  const updates: Record<string, unknown> = {
    tracking_number:      tn,
    normalized_status:    effectiveStatus,
    delivery_attempts:    efiResult.attempts,
    last_tracking_update: new Date().toISOString(),
  }

  if (efiResult.estado_actual && isValidEstadoText(efiResult.estado_actual)) {
    updates.raw_status = efiResult.estado_actual
  }
  if (efiResult.last_attempt_reason)           updates.last_attempt_reason = efiResult.last_attempt_reason
  if (efiResult.historial_estados.length  > 0) updates.tracking_history    = efiResult.historial_estados
  if (efiResult.historial_novedades.length > 0) updates.tracking_novedades  = efiResult.historial_novedades

  const shipmentCreatedAt = parseEFIDate(efiResult.fecha_creacion)
  if (shipmentCreatedAt) updates.shipment_created_at = shipmentCreatedAt

  const lastNovedad   = efiResult.historial_novedades.at(-1)
  const lastNovedadAt = parseEFIDate(lastNovedad?.fecha)
  if (lastNovedadAt) updates.last_novedad_at = lastNovedadAt

  const firstEstado = efiResult.historial_estados.at(0)
  const statusSince = parseEFIDate(firstEstado?.fecha)
  if (statusSince) updates.status_since = statusSince

  const { error: updateErr } = await supabase
    .from('orders')
    .update(updates)
    .eq('id', target.id)

  if (updateErr) {
    return { outcome: 'efi_error', tracking_number: tn, error: updateErr.message }
  }

  // Fallback last_novedad_at si quedó en novedad sin fecha de EFI
  if (effectiveStatus === 'novedad' && !lastNovedadAt) {
    await supabase
      .from('orders')
      .update({ last_novedad_at: new Date().toISOString() })
      .eq('id', target.id)
      .is('last_novedad_at', null)
  }

  console.log(
    `[reconcile-efi] assigned tracking=${tn} orderId=${target.id} ` +
    `orderNumber=${target.order_number} status=${effectiveStatus}`,
  )

  return {
    outcome:        'assigned',
    tracking_number: tn,
    efi: {
      found:             true,
      estado_actual:     efiResult.estado_actual,
      normalized_status: effectiveStatus,
      attempts:          efiResult.attempts,
    },
    assigned_order: {
      id:                target.id,
      order_number:      target.order_number,
      customer_name:     target.customer_name,
      normalized_status: effectiveStatus,
    },
  }
}
