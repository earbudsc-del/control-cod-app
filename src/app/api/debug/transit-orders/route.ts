import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/debug/transit-orders
//   ?tracking_numbers=9000539795,9000540492   → guías específicas
//   (sin params)                               → todos los in_transit (máx 50)
//
// Requiere sesión activa. Devuelve campos de diagnóstico para determinar
// por qué una guía sigue como in_transit/Generada aunque EFI diga Anulada.

interface DiagRow {
  id: string
  tracking_number: string | null
  raw_status: string | null
  normalized_status: string
  status_since: string | null
  shipment_created_at: string | null
  last_tracking_update: string | null
  updated_at: string
  created_at: string
  shopify_created_at: string | null
  delivery_attempts: number
  last_attempt_reason: string | null
  tracking_history: Array<{ fecha: string; estado: string }> | null
}

const DIAG_SELECT =
  'id, tracking_number, raw_status, normalized_status, ' +
  'status_since, shipment_created_at, last_tracking_update, ' +
  'updated_at, created_at, shopify_created_at, ' +
  'delivery_attempts, last_attempt_reason, tracking_history'

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const rawIds = searchParams.get('tracking_numbers')
    const trackingNumbers = rawIds
      ? rawIds.split(',').map(s => s.trim()).filter(Boolean)
      : null

    let rows: DiagRow[]

    if (trackingNumbers?.length) {
      const { data, error } = await supabase
        .from('orders')
        .select(DIAG_SELECT)
        .in('tracking_number', trackingNumbers)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      rows = (data ?? []) as unknown as DiagRow[]
    } else {
      // Sin filtro → in_transit más antiguos primero + últimas anuladas
      const [transitRes, anuladasRes] = await Promise.all([
        supabase
          .from('orders')
          .select(DIAG_SELECT)
          .eq('normalized_status', 'in_transit')
          .order('status_since', { ascending: true, nullsFirst: false })
          .limit(30),
        supabase
          .from('orders')
          .select(DIAG_SELECT)
          .eq('normalized_status', 'returned')
          .ilike('raw_status', '%anulad%')
          .order('last_tracking_update', { ascending: false })
          .limit(20),
      ])
      if (transitRes.error) return NextResponse.json({ error: transitRes.error.message }, { status: 500 })
      if (anuladasRes.error) return NextResponse.json({ error: anuladasRes.error.message }, { status: 500 })
      rows = [
        ...((transitRes.data  ?? []) as unknown as DiagRow[]),
        ...((anuladasRes.data ?? []) as unknown as DiagRow[]),
      ]
    }

    const now = Date.now()
    const enriched = rows.map(o => {
      const rs = o.raw_status?.toLowerCase() ?? ''
      const ns = o.normalized_status
      let diagnostico: string
      if (ns === 'returned' && rs.includes('anulad'))          diagnostico = 'OK — ya reclasificada como Anulada'
      else if (ns === 'in_transit' && rs.includes('anulad'))   diagnostico = 'INCONSISTENTE — raw_status anulada pero normalized=in_transit'
      else if (ns === 'in_transit' && !o.last_tracking_update) diagnostico = 'NUNCA SINCRONIZADA — sin last_tracking_update'
      else if (ns === 'in_transit')                            diagnostico = 'PENDIENTE — cron no detectó Estado global aún'
      else                                                     diagnostico = ns

      return {
        tracking_number:      o.tracking_number,
        raw_status:           o.raw_status,
        normalized_status:    o.normalized_status,
        status_since:         o.status_since,
        shipment_created_at:  o.shipment_created_at,
        last_tracking_update: o.last_tracking_update,
        shopify_created_at:   o.shopify_created_at,
        created_at:           o.created_at,
        updated_at:           o.updated_at,
        delivery_attempts:    o.delivery_attempts,
        last_attempt_reason:  o.last_attempt_reason,
        tracking_events:      Array.isArray(o.tracking_history) ? o.tracking_history.length : 0,
        horas_en_transito:    o.status_since
          ? Math.round((now - new Date(o.status_since).getTime()) / 36e5 * 10) / 10
          : null,
        diagnostico,
        id: o.id,
      }
    })

    return NextResponse.json({
      total:     enriched.length,
      generated: new Date().toISOString(),
      data:      enriched,
    })
  } catch (err) {
    console.error('[debug/transit-orders] unexpected error:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
