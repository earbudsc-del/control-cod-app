import { createClient }   from '@/lib/supabase/server'
import { NextResponse }    from 'next/server'
import { normalizePhone }  from '@/lib/admin/reconcile-guide'

export const maxDuration = 300

const BACKFILL_MAX = 500

// ── Types ─────────────────────────────────────────────────────────────────────

interface BackfillItem {
  tracking_number:  string
  customer_phone?:  string
  customer_address?: string
  customer_city?:   string
  customer_name?:   string
}

type BackfillOutcome = 'updated' | 'skipped' | 'not_found' | 'error'

export interface BackfillResult {
  tracking_number: string
  outcome:         BackfillOutcome
  order_number?:   string | null
  fields_filled?:  string[]
  error?:          string
}

export interface BackfillSummary {
  scanned:   number
  updated:   number
  skipped:   number
  not_found: number
  errors:    number
}

export interface BackfillResponse {
  summary:        BackfillSummary
  sample_updated: BackfillResult[]
  sample_missing: BackfillResult[]
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
    if (rawItems.length > BACKFILL_MAX) {
      return NextResponse.json({ error: `Máximo ${BACKFILL_MAX} items por request` }, { status: 400 })
    }

    const items: BackfillItem[] = rawItems.map((raw: unknown) => {
      const i = raw as Record<string, unknown>
      return {
        tracking_number:  String(i.tracking_number ?? '').trim(),
        customer_phone:   i.customer_phone   ? String(i.customer_phone).trim()   : undefined,
        customer_address: i.customer_address ? String(i.customer_address).trim() : undefined,
        customer_city:    i.customer_city    ? String(i.customer_city).trim()    : undefined,
        customer_name:    i.customer_name    ? String(i.customer_name).trim()    : undefined,
      }
    })

    const missing_tn = items.filter(i => !i.tracking_number)
    if (missing_tn.length > 0) {
      return NextResponse.json({
        error:        `${missing_tn.length} items sin tracking_number`,
        invalid_rows: missing_tn.slice(0, 10),
      }, { status: 400 })
    }

    // ── Process each item ──────────────────────────────────────────────────────

    const summary: BackfillSummary = { scanned: 0, updated: 0, skipped: 0, not_found: 0, errors: 0 }
    const results: BackfillResult[] = []

    for (const item of items) {
      summary.scanned++

      // Buscar orden por tracking_number
      const { data: order, error: fetchErr } = await supabase
        .from('orders')
        .select('id, order_number, customer_name, customer_phone, customer_address, city')
        .eq('tracking_number', item.tracking_number)
        .maybeSingle()

      if (fetchErr) {
        summary.errors++
        results.push({ tracking_number: item.tracking_number, outcome: 'error', error: fetchErr.message })
        continue
      }

      if (!order) {
        summary.not_found++
        results.push({ tracking_number: item.tracking_number, outcome: 'not_found' })
        continue
      }

      // Construir updates — solo llenar campos vacíos
      const updates: Record<string, string> = {}
      const fieldsFilled: string[] = []

      if (item.customer_phone && !order.customer_phone) {
        const normalized = normalizePhone(item.customer_phone)
        if (normalized && normalized.length >= 7) {
          updates.customer_phone = normalized
          fieldsFilled.push('customer_phone')
        }
      }

      if (item.customer_address && !order.customer_address) {
        updates.customer_address = item.customer_address
        fieldsFilled.push('customer_address')
      }

      if (item.customer_city && !order.city) {
        updates.city = item.customer_city       // DB column = city (no customer_city)
        fieldsFilled.push('city')
      }

      if (item.customer_name && !order.customer_name) {
        updates.customer_name = item.customer_name
        fieldsFilled.push('customer_name')
      }

      if (fieldsFilled.length === 0) {
        summary.skipped++
        results.push({
          tracking_number: item.tracking_number,
          outcome:         'skipped',
          order_number:    order.order_number,
          fields_filled:   [],
        })
        continue
      }

      const { error: updateErr } = await supabase
        .from('orders')
        .update(updates)
        .eq('id', order.id)

      if (updateErr) {
        summary.errors++
        results.push({ tracking_number: item.tracking_number, outcome: 'error', error: updateErr.message })
        continue
      }

      console.log(
        `[backfill] tn=${item.tracking_number} order=${order.order_number} filled=${fieldsFilled.join(',')}`,
      )
      summary.updated++
      results.push({
        tracking_number: item.tracking_number,
        outcome:         'updated',
        order_number:    order.order_number,
        fields_filled:   fieldsFilled,
      })
    }

    console.log(
      `[backfill] scanned=${summary.scanned} updated=${summary.updated} ` +
      `skipped=${summary.skipped} not_found=${summary.not_found} errors=${summary.errors}`,
    )

    const response: BackfillResponse = {
      summary,
      sample_updated: results.filter(r => r.outcome === 'updated').slice(0, 20),
      sample_missing: results.filter(r => r.outcome === 'not_found').slice(0, 20),
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error('[POST /api/admin/backfill-imported-order-data]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
