import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// GET /api/debug/contact-fields-health
// Solo admin. Solo lectura.
//
// Diagnóstico global de campos de contacto vacíos (teléfono, dirección, ciudad)
// en TODAS las órdenes, con breakdown por normalized_status, source y
// confirmation_status. Incluye muestra por estado para facilitar diagnóstico.
//
// Campos DB: customer_phone, customer_address, city, province
// (la UI los lee con esos nombres — no hay mismatch de campo)

const ALLOWED_ROLES = ['admin']
const SAMPLE_LIMIT  = 10

const ALL_STATUSES = [
  'pending', 'in_transit', 'out_for_delivery', 'en_reparto',
  'novedad', 'indemnizacion', 'delivered', 'failed_attempt', 'returned',
] as const

const SAMPLE_STATUSES = [
  'in_transit', 'en_reparto', 'novedad', 'indemnizacion', 'delivered', 'pending',
] as const

const KNOWN_SOURCES = ['shopify_webhook', 'csv_import', 'manual'] as const

const CONFIRMATION_STATUSES = ['pending', 'confirmed', 'unreachable', 'cancelled'] as const

const SAMPLE_FIELDS =
  'id, order_number, tracking_number, customer_name, customer_phone, ' +
  'customer_address, city, province, source, confirmation_status, ' +
  'normalized_status, raw_status, created_at'

type BreakdownEntry = {
  total:           number
  without_phone:   number
  without_address: number
  without_city:    number
}

type RawRow = {
  id:                  string
  order_number:        string | null
  tracking_number:     string | null
  customer_name:       string | null
  customer_phone:      string | null
  customer_address:    string | null
  city:                string | null
  province:            string | null
  source:              string | null
  confirmation_status: string | null
  normalized_status:   string
  raw_status:          string | null
  created_at:          string
}

function mapSampleRow(o: unknown) {
  const r = o as RawRow
  return {
    id:                  r.id,
    order_number:        r.order_number,
    tracking_number:     r.tracking_number,
    customer_name:       r.customer_name,
    customer_phone:      r.customer_phone,
    customer_address:    r.customer_address,
    customer_city:       r.city,      // alias — campo DB es "city"
    customer_province:   r.province,  // alias — campo DB es "province"
    source:              r.source,
    confirmation_status: r.confirmation_status,
    normalized_status:   r.normalized_status,
    raw_status:          r.raw_status,
    created_at:          r.created_at,
  }
}

export async function GET() {
  try {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!ALLOWED_ROLES.includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
    }

    // ── Todas las queries en paralelo ──────────────────────────────────────────
    const [globalResults, statusResults, sourceResults, confirmResults, sampleResults] =
      await Promise.all([
        // ── 1. Totales globales (5 queries) ──────────────────────────────────
        Promise.all([
          supabase.from('orders').select('id', { count: 'exact', head: true }),
          supabase.from('orders').select('id', { count: 'exact', head: true }).not('tracking_number', 'is', null),
          supabase.from('orders').select('id', { count: 'exact', head: true }).is('customer_phone', null),
          supabase.from('orders').select('id', { count: 'exact', head: true }).is('customer_address', null),
          supabase.from('orders').select('id', { count: 'exact', head: true }).is('city', null),
        ]),

        // ── 2. Breakdown por normalized_status (9 × 4 = 36 queries) ─────────
        Promise.all(
          ALL_STATUSES.flatMap(status => [
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('normalized_status', status),
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('normalized_status', status).is('customer_phone', null),
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('normalized_status', status).is('customer_address', null),
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('normalized_status', status).is('city', null),
          ]),
        ),

        // ── 3. Breakdown por source (4 sources × 4 = 16 queries) ─────────────
        Promise.all([
          ...KNOWN_SOURCES.flatMap(src => [
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('source', src),
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('source', src).is('customer_phone', null),
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('source', src).is('customer_address', null),
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('source', src).is('city', null),
          ]),
          // source IS NULL
          supabase.from('orders').select('id', { count: 'exact', head: true }).is('source', null),
          supabase.from('orders').select('id', { count: 'exact', head: true }).is('source', null).is('customer_phone', null),
          supabase.from('orders').select('id', { count: 'exact', head: true }).is('source', null).is('customer_address', null),
          supabase.from('orders').select('id', { count: 'exact', head: true }).is('source', null).is('city', null),
        ]),

        // ── 4. Breakdown por confirmation_status (4 × 4 = 16 queries) ────────
        Promise.all(
          CONFIRMATION_STATUSES.flatMap(cs => [
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('confirmation_status', cs),
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('confirmation_status', cs).is('customer_phone', null),
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('confirmation_status', cs).is('customer_address', null),
            supabase.from('orders').select('id', { count: 'exact', head: true }).eq('confirmation_status', cs).is('city', null),
          ]),
        ),

        // ── 5. Muestras por estado (6 queries) ───────────────────────────────
        Promise.all(
          SAMPLE_STATUSES.map(status =>
            supabase
              .from('orders')
              .select(SAMPLE_FIELDS)
              .eq('normalized_status', status)
              .or('customer_phone.is.null,customer_address.is.null,city.is.null')
              .order('created_at', { ascending: false })
              .limit(SAMPLE_LIMIT),
          ),
        ),
      ])

    // ── Procesar totales globales ────────────────────────────────────────────
    const [totalRes, withTrackingRes, noPhoneRes, noAddressRes, noCityRes] = globalResults

    // ── Procesar breakdown por normalized_status ─────────────────────────────
    const byNormalizedStatus: Record<string, BreakdownEntry> = {}
    ALL_STATUSES.forEach((status, i) => {
      const base  = i * 4
      const total = statusResults[base].count ?? 0
      if (total > 0) {
        byNormalizedStatus[status] = {
          total,
          without_phone:   statusResults[base + 1].count ?? 0,
          without_address: statusResults[base + 2].count ?? 0,
          without_city:    statusResults[base + 3].count ?? 0,
        }
      }
    })

    // ── Procesar breakdown por source ────────────────────────────────────────
    const bySource: Record<string, BreakdownEntry> = {}
    KNOWN_SOURCES.forEach((src, i) => {
      const base  = i * 4
      const total = sourceResults[base].count ?? 0
      if (total > 0) {
        bySource[src] = {
          total,
          without_phone:   sourceResults[base + 1].count ?? 0,
          without_address: sourceResults[base + 2].count ?? 0,
          without_city:    sourceResults[base + 3].count ?? 0,
        }
      }
    })
    // source IS NULL
    const nullSrcBase  = KNOWN_SOURCES.length * 4
    const nullSrcTotal = sourceResults[nullSrcBase].count ?? 0
    if (nullSrcTotal > 0) {
      bySource['(sin source)'] = {
        total:           nullSrcTotal,
        without_phone:   sourceResults[nullSrcBase + 1].count ?? 0,
        without_address: sourceResults[nullSrcBase + 2].count ?? 0,
        without_city:    sourceResults[nullSrcBase + 3].count ?? 0,
      }
    }

    // ── Procesar breakdown por confirmation_status ───────────────────────────
    const byConfirmationStatus: Record<string, BreakdownEntry> = {}
    CONFIRMATION_STATUSES.forEach((cs, i) => {
      const base  = i * 4
      const total = confirmResults[base].count ?? 0
      if (total > 0) {
        byConfirmationStatus[cs] = {
          total,
          without_phone:   confirmResults[base + 1].count ?? 0,
          without_address: confirmResults[base + 2].count ?? 0,
          without_city:    confirmResults[base + 3].count ?? 0,
        }
      }
    })

    // ── Procesar muestras ────────────────────────────────────────────────────
    type SampleRow = ReturnType<typeof mapSampleRow>
    const samples: Record<string, SampleRow[]> = {}
    SAMPLE_STATUSES.forEach((status, i) => {
      const rows = sampleResults[i].data ?? []
      if (rows.length > 0) {
        samples[status] = (rows as unknown[]).map(mapSampleRow)
      }
    })

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      totals: {
        total_orders:    totalRes.count       ?? 0,
        with_tracking:   withTrackingRes.count ?? 0,
        without_phone:   noPhoneRes.count     ?? 0,
        without_address: noAddressRes.count   ?? 0,
        without_city:    noCityRes.count      ?? 0,
      },
      by_normalized_status:   byNormalizedStatus,
      by_source:               bySource,
      by_confirmation_status:  byConfirmationStatus,
      samples,
      diagnosis: {
        field_names: {
          note:     'Sin mismatch de nombres. La UI lee los campos con los nombres correctos de DB.',
          city:     'DB=city → UI usa order.city. Alias en response=customer_city.',
          province: 'DB=province → UI usa order.province. Alias en response=customer_province.',
          phone:    'DB=customer_phone → UI usa order.customer_phone.',
          address:  'DB=customer_address → UI usa order.customer_address.',
        },
        if_data_is_null: [
          '1. Órdenes shopify_webhook: el webhook llena estos campos desde shipping_address/billing_address/customer. Si Shopify no envía esos datos, quedan NULL.',
          '2. Órdenes csv_import: el import lee columnas del CSV. Si el CSV no tiene esas columnas, quedan NULL.',
          '3. Fix disponible: POST /api/admin/backfill-imported-order-data (llena campos vacíos sin sobrescribir).',
          '4. Fix en efi-import: modo "Actualizar datos faltantes" para subir CSV con datos de contacto.',
        ],
      },
    })
  } catch (err) {
    console.error('[GET /api/debug/contact-fields-health]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
