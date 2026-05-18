import { createClient }        from '@/lib/supabase/server'
import { NextResponse }          from 'next/server'
import { updateOrderTracking }   from '@/lib/tracking/update-order'

// POST /api/admin/fix-novedad-mismatches
// Solo admin.
//
// Consulta EFI en tiempo real para todas las guías con normalized_status='novedad'
// y aplica updateOrderTracking() en cada una para corregir estados del CSV importado.
// Solo modifica guías cuyo estado EFI difiere del estado en DB.

export const maxDuration = 300

const DEFAULT_LIMIT = 120
const MAX_LIMIT     = 200
const EFI_DELAY_MS  = 500

// ── Types ──────────────────────────────────────────────────────────────────────

interface OrderRow {
  id:                   string
  order_number:         string | null
  tracking_number:      string
  customer_name:        string | null
  normalized_status:    string
  last_tracking_update: string | null
}

interface ChangedItem {
  order_number:    string | null
  tracking_number: string
  customer_name:   string | null
  old_status:      string
  new_status:      string
}

interface FailedItem {
  order_number:    string | null
  tracking_number: string
  error:           string
}

interface FixSummary {
  total_queried:  number
  checked:        number
  updated:        number
  changed_status: number
  skipped:        number
  failed:         number
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
      // body vacío o no-JSON → usar default
    }

    const { data: rows, error: queryErr } = await supabase
      .from('orders')
      .select('id, order_number, tracking_number, customer_name, normalized_status, last_tracking_update')
      .eq('normalized_status', 'novedad')
      .not('tracking_number', 'is', null)
      .order('last_tracking_update', { ascending: true, nullsFirst: true })
      .limit(bodyLimit)

    if (queryErr) {
      console.error('[fix-novedad-mismatches] DB error:', queryErr.message)
      return NextResponse.json({ error: 'Error al consultar DB' }, { status: 500 })
    }

    const orders = (rows ?? []) as OrderRow[]

    console.log(
      `[fix-novedad-mismatches] user=${user.id} queried=${orders.length} limit=${bodyLimit}`,
    )

    const summary: FixSummary = {
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
        order.normalized_status,  // 'novedad' — guard contra unknown-overwrite
      )

      if (!result.success) {
        summary.failed++
        failed.push({
          order_number:    order.order_number,
          tracking_number: order.tracking_number,
          error:           result.error ?? 'Error desconocido',
        })
        console.warn(
          `[fix-novedad-mismatches] FAILED guia=${order.tracking_number} ` +
          `order=${order.order_number} error="${result.error}"`,
        )
        continue
      }

      summary.checked++

      if (result.skipped) {
        summary.skipped++
        inc(byNewStatus, order.normalized_status)
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
          customer_name:   order.customer_name,
          old_status:      order.normalized_status,
          new_status:      newStatus,
        })
        console.log(
          `[fix-novedad-mismatches] STATUS_CHANGE guia=${order.tracking_number} ` +
          `order=${order.order_number} novedad→${newStatus}`,
        )
      }
    }

    console.log(
      `[fix-novedad-mismatches] DONE total=${orders.length} ` +
      `checked=${summary.checked} updated=${summary.updated} ` +
      `changed=${summary.changed_status} skipped=${summary.skipped} failed=${summary.failed}`,
    )

    return NextResponse.json({
      summary,
      by_old_status: byOldStatus,
      by_new_status: byNewStatus,
      changed,
      failed,
    })
  } catch (err) {
    console.error('[POST /api/admin/fix-novedad-mismatches]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
