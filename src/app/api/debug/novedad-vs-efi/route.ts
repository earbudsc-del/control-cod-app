import { createClient }     from '@/lib/supabase/server'
import { NextResponse }       from 'next/server'
import { parseEFITracking }   from '@/lib/tracking/efi-parser'

// GET /api/debug/novedad-vs-efi
// Solo admin. Solo lectura — NO modifica ningún dato en DB.
//
// Consulta EFI en tiempo real para cada guía con normalized_status='novedad'
// y compara con el estado real actual. Útil para detectar desincronizaciones
// entre el estado del CSV importado y el estado vivo de EFI.

export const maxDuration = 300

const DEFAULT_LIMIT = 120  // cubre el universo esperado de ~106 novedades
const MAX_LIMIT     = 200
const EFI_DELAY_MS  = 500
const EFI_BASE      = 'https://effi.com.co/tracking/index'

// ── Types ──────────────────────────────────────────────────────────────────────

interface OrderRow {
  id:                   string
  order_number:         string | null
  tracking_number:      string
  customer_name:        string | null
  normalized_status:    string
  raw_status:           string | null
  last_tracking_update: string | null
}

interface MismatchItem {
  tracking_number:      string
  order_number:         string | null
  customer_name:        string | null
  last_tracking_update: string | null
  db_raw_status:        string | null
  efi_raw_status:       string | null
  efi_normalized_status: string
}

interface StillNovedadItem {
  tracking_number:      string
  order_number:         string | null
  customer_name:        string | null
  last_tracking_update: string | null
  efi_raw_status:       string | null
}

interface FailedItem {
  tracking_number:      string
  order_number:         string | null
  customer_name:        string | null
  last_tracking_update: string | null
  reason:               string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function fetchEFIHTML(
  tracking: string,
): Promise<{ html: string } | { error: string }> {
  try {
    const res = await fetch(
      `${EFI_BASE}/${encodeURIComponent(tracking.trim())}`,
      {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-419,es;q=0.9',
          'Cache-Control':   'no-cache',
        },
        cache:  'no-store',
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) return { error: `EFI HTTP ${res.status}` }
    return { html: await res.text() }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Error de red' }
  }
}

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function inc(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(request: Request) {
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
      return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
    }

    const url   = new URL(request.url)
    const raw   = url.searchParams.get('limit')
    const limit = raw
      ? Math.min(Math.max(1, parseInt(raw, 10) || DEFAULT_LIMIT), MAX_LIMIT)
      : DEFAULT_LIMIT

    const { data: rows, error: queryErr } = await supabase
      .from('orders')
      .select('id, order_number, tracking_number, customer_name, normalized_status, raw_status, last_tracking_update')
      .eq('normalized_status', 'novedad')
      .not('tracking_number', 'is', null)
      .order('last_tracking_update', { ascending: true, nullsFirst: true })
      .limit(limit)

    if (queryErr) {
      console.error('[novedad-vs-efi] DB error:', queryErr.message)
      return NextResponse.json({ error: 'Error al consultar DB' }, { status: 500 })
    }

    const orders = (rows ?? []) as OrderRow[]

    console.log(
      `[novedad-vs-efi] user=${user.id} total_novedad=${orders.length} limit=${limit}`,
    )

    const changedFromNovedad: MismatchItem[]    = []
    const stillNovedad:       StillNovedadItem[] = []
    const unknownOrFailed:    FailedItem[]       = []
    const byEfiStatus:        Record<string, number> = {}

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i]!
      if (i > 0) await delay(EFI_DELAY_MS)

      const fetched = await fetchEFIHTML(order.tracking_number)

      if ('error' in fetched) {
        unknownOrFailed.push({
          tracking_number:      order.tracking_number,
          order_number:         order.order_number,
          customer_name:        order.customer_name,
          last_tracking_update: order.last_tracking_update,
          reason:               fetched.error,
        })
        inc(byEfiStatus, 'error')
        continue
      }

      const tracking = parseEFITracking(fetched.html, order.tracking_number)

      if (!tracking.encontrado) {
        unknownOrFailed.push({
          tracking_number:      order.tracking_number,
          order_number:         order.order_number,
          customer_name:        order.customer_name,
          last_tracking_update: order.last_tracking_update,
          reason:               'not_found_in_efi',
        })
        inc(byEfiStatus, 'not_found')
        continue
      }

      if (tracking.normalized_status === 'unknown') {
        unknownOrFailed.push({
          tracking_number:      order.tracking_number,
          order_number:         order.order_number,
          customer_name:        order.customer_name,
          last_tracking_update: order.last_tracking_update,
          reason:               `efi_unknown_status: "${tracking.estado_actual ?? 'sin estado'}"`,
        })
        inc(byEfiStatus, 'unknown')
        continue
      }

      inc(byEfiStatus, tracking.normalized_status)

      if (tracking.normalized_status === 'novedad') {
        stillNovedad.push({
          tracking_number:      order.tracking_number,
          order_number:         order.order_number,
          customer_name:        order.customer_name,
          last_tracking_update: order.last_tracking_update,
          efi_raw_status:       tracking.estado_actual,
        })
      } else {
        changedFromNovedad.push({
          tracking_number:       order.tracking_number,
          order_number:          order.order_number,
          customer_name:         order.customer_name,
          last_tracking_update:  order.last_tracking_update,
          db_raw_status:         order.raw_status,
          efi_raw_status:        tracking.estado_actual,
          efi_normalized_status: tracking.normalized_status,
        })
      }
    }

    // Ordenar cambiadas: más urgentes primero (delivered/returned antes que transit)
    const statusOrder = ['delivered', 'returned', 'en_reparto', 'in_transit', 'pending']
    changedFromNovedad.sort(
      (a, b) =>
        (statusOrder.indexOf(a.efi_normalized_status) === -1 ? 99 : statusOrder.indexOf(a.efi_normalized_status)) -
        (statusOrder.indexOf(b.efi_normalized_status) === -1 ? 99 : statusOrder.indexOf(b.efi_normalized_status)),
    )

    console.log(
      `[novedad-vs-efi] checked=${orders.length} ` +
      `still=${stillNovedad.length} changed=${changedFromNovedad.length} ` +
      `failed=${unknownOrFailed.length}`,
    )

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      query: {
        limit,
        checked: orders.length,
        note: orders.length === limit
          ? `Se alcanzó el límite de ${limit}. Puede haber más novedades en DB. Usa ?limit=N para aumentar.`
          : 'Se revisaron todas las novedades encontradas.',
      },
      summary: {
        total_db_novedad:     orders.length,
        still_novedad_in_efi: stillNovedad.length,
        changed_from_novedad: changedFromNovedad.length,
        unknown_or_failed:    unknownOrFailed.length,
        by_efi_status:        byEfiStatus,
      },
      // Las más importantes: DB dice novedad pero EFI ya cambió
      changed_from_novedad: changedFromNovedad,
      // Las que sí son novedad en EFI también
      still_novedad:        stillNovedad,
      // Errores de fetch o guías no encontradas
      unknown_or_failed:    unknownOrFailed,
    })
  } catch (err) {
    console.error('[GET /api/debug/novedad-vs-efi]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
