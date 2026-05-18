import { createClient }        from '@/lib/supabase/server'
import { NextResponse }          from 'next/server'
import { updateOrderTracking }   from '@/lib/tracking/update-order'

export const maxDuration = 300

const DEFAULT_LIMIT    = 150
const MAX_LIMIT        = 300
const EFI_DELAY_MS     = 600
const ACTIVE_STATUSES  = ['in_transit', 'en_reparto', 'novedad'] as const

type ActiveStatus = typeof ACTIVE_STATUSES[number]

// ── Types ──────────────────────────────────────────────────────────────────────

interface OrderRow {
  id:                  string
  order_number:        string | null
  tracking_number:     string
  normalized_status:   string
  last_tracking_update: string | null
}

interface ChangedItem {
  order_number:    string | null
  tracking_number: string
  old_status:      string
  new_status:      string
}

interface FailedItem {
  order_number:    string | null
  tracking_number: string
  error:           string
}

interface SyncSummary {
  total_queried: number
  checked:       number
  updated:       number
  changed_status: number
  skipped:       number
  failed:        number
}

interface SyncResponse {
  summary:        SyncSummary
  by_old_status:  Record<string, number>
  by_new_status:  Record<string, number>
  changed:        ChangedItem[]
  failed:         FailedItem[]
}

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function inc(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1
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

    // Body opcional: { limit?: number }
    let bodyLimit = DEFAULT_LIMIT
    try {
      const body = await request.json()
      if (typeof body.limit === 'number' && body.limit > 0) {
        bodyLimit = Math.min(body.limit, MAX_LIMIT)
      }
    } catch {
      // body vacío → usar default
    }

    // Consultar guías activas, las más antiguas primero (stale first)
    const { data: rows, error: queryErr } = await supabase
      .from('orders')
      .select('id, order_number, tracking_number, normalized_status, last_tracking_update')
      .in('normalized_status', [...ACTIVE_STATUSES])
      .not('tracking_number', 'is', null)
      .order('last_tracking_update', { ascending: true, nullsFirst: true })
      .limit(bodyLimit)

    if (queryErr) {
      console.error('[sync-imported-active-guides] query error:', queryErr.message)
      return NextResponse.json({ error: 'Error al consultar DB' }, { status: 500 })
    }

    const orders = (rows ?? []) as OrderRow[]

    console.log(
      `[sync-imported-active-guides] user=${user.id} limit=${bodyLimit} ` +
      `queried=${orders.length} statuses=${ACTIVE_STATUSES.join(',')}`,
    )

    const summary: SyncSummary = {
      total_queried:  orders.length,
      checked:        0,
      updated:        0,
      changed_status: 0,
      skipped:        0,
      failed:         0,
    }
    const byOldStatus: Record<string, number> = {}
    const byNewStatus: Record<string, number> = {}
    const changed: ChangedItem[] = []
    const failed: FailedItem[]   = []

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i]!
      if (i > 0) await delay(EFI_DELAY_MS)

      inc(byOldStatus, order.normalized_status)

      const result = await updateOrderTracking(
        order.id,
        order.tracking_number,
        supabase,
        order.normalized_status,
      )

      if (!result.success) {
        summary.failed++
        failed.push({
          order_number:    order.order_number,
          tracking_number: order.tracking_number,
          error:           result.error ?? 'Error desconocido',
        })
        console.warn(
          `[sync-imported-active-guides] FAILED guia=${order.tracking_number} ` +
          `order=${order.order_number} error="${result.error}"`,
        )
        continue
      }

      summary.checked++

      if (result.skipped) {
        summary.skipped++
        inc(byNewStatus, order.normalized_status) // status sin cambio
        continue
      }

      summary.updated++
      const newStatus = result.normalized_status ?? order.normalized_status
      inc(byNewStatus, newStatus)

      if (newStatus !== order.normalized_status) {
        summary.changed_status++
        changed.push({
          order_number:    order.order_number,
          tracking_number: order.tracking_number,
          old_status:      order.normalized_status,
          new_status:      newStatus,
        })
        console.log(
          `[sync-imported-active-guides] STATUS_CHANGE guia=${order.tracking_number} ` +
          `order=${order.order_number} ${order.normalized_status}→${newStatus}`,
        )
      }
    }

    console.log(
      `[sync-imported-active-guides] DONE total=${orders.length} ` +
      `checked=${summary.checked} updated=${summary.updated} ` +
      `changed=${summary.changed_status} skipped=${summary.skipped} failed=${summary.failed}`,
    )

    const response: SyncResponse = {
      summary,
      by_old_status: byOldStatus,
      by_new_status: byNewStatus,
      changed,
      failed,
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error('[POST /api/admin/sync-imported-active-guides]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
