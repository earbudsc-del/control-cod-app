import { createClient }    from '@/lib/supabase/server'
import { NextResponse }      from 'next/server'
import { normalizePhone }    from '@/lib/admin/reconcile-guide'
import type { SupabaseClient } from '@supabase/supabase-js'

export const maxDuration = 300  // DB-only, no EFI calls — chunk loop dentro del límite

const IMPORT_MAX = 500

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ImportItem {
  tracking_number: string
  phone:           string
  estado?:         string
  nombre?:         string
  ciudad?:         string
}

export type ImportOutcome =
  | 'assigned'
  | 'assigned_pending_forced'
  | 'already_assigned'
  | 'multiple_candidates'
  | 'no_match'
  | 'error'

interface Candidate {
  id:                  string
  order_number:        string | null
  customer_name:       string | null
  customer_phone:      string | null
  confirmation_status: string | null
}

export interface ImportResult {
  tracking_number:   string
  phone:             string
  estado?:           string
  outcome:           ImportOutcome
  order_number?:     string | null
  customer_name?:    string | null
  normalized_status?: string
  candidates?:       Candidate[]
  existing_order?:   { id: string; order_number: string | null }
  error?:            string
}

export interface ImportSummary {
  total:                   number
  assigned:                number
  assigned_pending_forced: number
  already_assigned:        number
  multiple_candidates:     number
  no_match:                number
  errors:                  number
}

export interface ImportResponse {
  summary:          ImportSummary
  auto_assigned:    ImportResult[]
  needs_review:     ImportResult[]
  already_assigned: ImportResult[]
  errors:           ImportResult[]
}

// ── Status mapping ─────────────────────────────────────────────────────────────
// Mapea texto de estado EFI (CSV export) → normalized_status interno.
// Datos vienen del propio EFI, el cron sincronizará el estado exacto en el próximo ciclo.

function mapEstadoToNormalized(estado: string | undefined | null): string {
  if (!estado) return 'in_transit'
  const s = estado.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  if (s.includes('reparto'))                         return 'en_reparto'
  if (s.includes('novedad'))                         return 'novedad'
  if (s.includes('transit'))                         return 'in_transit'
  if (s.includes('genera'))                          return 'in_transit'
  if (s.includes('entreg'))                          return 'delivered'
  if (s.includes('devolu') || s.includes('devuelt')) return 'returned'
  return 'in_transit'
}

// ── Process single item ────────────────────────────────────────────────────────

async function processItem(
  item: ImportItem,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
): Promise<ImportResult> {
  const tn    = item.tracking_number.trim()
  const phone = item.phone.trim()

  const normalizedPhone = normalizePhone(phone)
  if (!normalizedPhone || normalizedPhone.length < 7) {
    return { tracking_number: tn, phone, estado: item.estado, outcome: 'error', error: 'Teléfono inválido (menos de 7 dígitos)' }
  }
  const last7 = normalizedPhone.slice(-7)

  // 1. Verificar que la guía no esté ya asignada en otra orden
  const { data: existing } = await supabase
    .from('orders')
    .select('id, order_number')
    .eq('tracking_number', tn)
    .limit(1)
    .maybeSingle()

  if (existing) {
    return {
      tracking_number: tn, phone, estado: item.estado,
      outcome: 'already_assigned',
      existing_order: { id: existing.id, order_number: existing.order_number },
    }
  }

  const effectiveStatus = mapEstadoToNormalized(item.estado)

  // 2. Buscar confirmed + tracking=NULL + teléfono exacto
  const { data: confirmedRaw } = await supabase
    .from('orders')
    .select('id, order_number, customer_name, customer_phone, confirmation_status')
    .eq('confirmation_status', 'confirmed')
    .is('tracking_number', null)
    .ilike('customer_phone', `%${last7}%`)
    .limit(10)

  const confirmed: Candidate[] = (confirmedRaw ?? []).filter(
    (o: Candidate) => normalizePhone(o.customer_phone ?? '') === normalizedPhone,
  )

  if (confirmed.length === 1) {
    const target  = confirmed[0]!
    const updates: Record<string, unknown> = {
      tracking_number:      tn,
      normalized_status:    effectiveStatus,
      last_tracking_update: new Date().toISOString(),
    }
    if (item.estado) updates.raw_status = item.estado
    if (effectiveStatus === 'novedad') updates.last_novedad_at = new Date().toISOString()

    const { error: updateErr } = await supabase
      .from('orders').update(updates).eq('id', target.id)

    if (updateErr) {
      return { tracking_number: tn, phone, estado: item.estado, outcome: 'error', error: updateErr.message }
    }

    console.log(`[efi-import] assigned tn=${tn} order=${target.order_number} status=${effectiveStatus}`)
    return {
      tracking_number: tn, phone, estado: item.estado,
      outcome: 'assigned',
      order_number:      target.order_number,
      customer_name:     target.customer_name,
      normalized_status: effectiveStatus,
    }
  }

  if (confirmed.length > 1) {
    return {
      tracking_number: tn, phone, estado: item.estado,
      outcome: 'multiple_candidates',
      candidates: confirmed,
    }
  }

  // 3. Buscar pending + tracking=NULL + teléfono exacto (force_pending automático)
  const { data: pendingRaw } = await supabase
    .from('orders')
    .select('id, order_number, customer_name, customer_phone, confirmation_status')
    .eq('confirmation_status', 'pending')
    .is('tracking_number', null)
    .ilike('customer_phone', `%${last7}%`)
    .limit(10)

  const pending: Candidate[] = (pendingRaw ?? []).filter(
    (o: Candidate) => normalizePhone(o.customer_phone ?? '') === normalizedPhone,
  )

  if (pending.length === 1) {
    const target  = pending[0]!
    const updates: Record<string, unknown> = {
      tracking_number:      tn,
      normalized_status:    effectiveStatus,
      confirmation_status:  'confirmed',
      last_tracking_update: new Date().toISOString(),
    }
    if (item.estado) updates.raw_status = item.estado
    if (effectiveStatus === 'novedad') updates.last_novedad_at = new Date().toISOString()

    const { error: updateErr } = await supabase
      .from('orders').update(updates).eq('id', target.id)

    if (updateErr) {
      return { tracking_number: tn, phone, estado: item.estado, outcome: 'error', error: updateErr.message }
    }

    console.log(`[efi-import] assigned_pending_forced tn=${tn} order=${target.order_number} status=${effectiveStatus}`)
    return {
      tracking_number: tn, phone, estado: item.estado,
      outcome: 'assigned_pending_forced',
      order_number:      target.order_number,
      customer_name:     target.customer_name,
      normalized_status: effectiveStatus,
    }
  }

  if (pending.length > 1) {
    return {
      tracking_number: tn, phone, estado: item.estado,
      outcome: 'multiple_candidates',
      candidates: pending,
    }
  }

  return { tracking_number: tn, phone, estado: item.estado, outcome: 'no_match' }
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins pueden usar esta herramienta' }, { status: 403 })
    }

    const body     = await request.json()
    const rawItems: unknown[] = Array.isArray(body.items) ? body.items : []

    if (rawItems.length === 0) {
      return NextResponse.json({ error: 'items no puede estar vacío' }, { status: 400 })
    }
    if (rawItems.length > IMPORT_MAX) {
      return NextResponse.json({ error: `Máximo ${IMPORT_MAX} guías por importación` }, { status: 400 })
    }

    const items: ImportItem[] = rawItems.map((item: unknown) => {
      const i = item as Record<string, unknown>
      return {
        tracking_number: String(i.tracking_number ?? '').trim(),
        phone:           String(i.phone           ?? '').trim(),
        estado:          i.estado ? String(i.estado).trim() : undefined,
        nombre:          i.nombre ? String(i.nombre).trim() : undefined,
        ciudad:          i.ciudad ? String(i.ciudad).trim() : undefined,
      }
    })

    const invalid = items.filter(i => !i.tracking_number || !i.phone)
    if (invalid.length > 0) {
      return NextResponse.json({
        error: `${invalid.length} filas sin tracking_number o teléfono`,
        invalid_rows: invalid.slice(0, 10),
      }, { status: 400 })
    }

    const summary: ImportSummary = {
      total:                   items.length,
      assigned:                0,
      assigned_pending_forced: 0,
      already_assigned:        0,
      multiple_candidates:     0,
      no_match:                0,
      errors:                  0,
    }

    const results: ImportResult[] = []

    for (const item of items) {
      const r = await processItem(item, supabase)
      results.push(r)
      switch (r.outcome) {
        case 'assigned':                summary.assigned++;                break
        case 'assigned_pending_forced': summary.assigned_pending_forced++; break
        case 'already_assigned':        summary.already_assigned++;        break
        case 'multiple_candidates':     summary.multiple_candidates++;     break
        case 'no_match':                summary.no_match++;                break
        case 'error':                   summary.errors++;                  break
      }
    }

    console.log(
      `[efi-import] total=${items.length} ` +
      `assigned=${summary.assigned} pending_forced=${summary.assigned_pending_forced} ` +
      `already=${summary.already_assigned} no_match=${summary.no_match} ` +
      `multiple=${summary.multiple_candidates} errors=${summary.errors}`,
    )

    const response: ImportResponse = {
      summary,
      auto_assigned:    results.filter(r => r.outcome === 'assigned' || r.outcome === 'assigned_pending_forced'),
      needs_review:     results.filter(r => r.outcome === 'multiple_candidates' || r.outcome === 'no_match'),
      already_assigned: results.filter(r => r.outcome === 'already_assigned'),
      errors:           results.filter(r => r.outcome === 'error'),
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error('[POST /api/admin/reconcile-efi-import]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
