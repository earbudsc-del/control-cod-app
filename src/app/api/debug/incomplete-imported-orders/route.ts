import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'

// GET /api/debug/incomplete-imported-orders
// Solo admin. Solo lectura.
//
// Diagnóstico de órdenes que tienen tracking asignado pero les falta
// teléfono, dirección o ciudad — impide contactar clientes en Novedad.

const ALLOWED_ROLES = ['admin']
const SAMPLE_LIMIT  = 30

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

    // ── Conteos totales (parallel) ─────────────────────────────────────────────
    const [noPhoneRes, noAddressRes, noCityRes, sampleRes] = await Promise.all([
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .is('customer_phone', null),

      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .is('customer_address', null),

      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .is('city', null),

      supabase
        .from('orders')
        .select(
          'id, tracking_number, order_number, customer_name, customer_phone, ' +
          'customer_address, city, normalized_status, raw_status, source, created_at',
        )
        .not('tracking_number', 'is', null)
        .or('customer_phone.is.null,customer_address.is.null,city.is.null')
        .order('created_at', { ascending: false })
        .limit(SAMPLE_LIMIT),
    ])

    // ── Conteo por source (parallel) ───────────────────────────────────────────
    const SOURCES = ['csv_import', 'shopify_webhook', 'manual']
    const [csvRes, shopifyRes, manualRes, nullSrcRes] = await Promise.all([
      ...SOURCES.map(src =>
        supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .not('tracking_number', 'is', null)
          .eq('source', src)
          .or('customer_phone.is.null,customer_address.is.null,city.is.null'),
      ),
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .not('tracking_number', 'is', null)
        .is('source', null)
        .or('customer_phone.is.null,customer_address.is.null,city.is.null'),
    ])

    const bySource: Record<string, number> = {}
    if ((csvRes.count     ?? 0) > 0) bySource.csv_import      = csvRes.count     ?? 0
    if ((shopifyRes.count ?? 0) > 0) bySource.shopify_webhook = shopifyRes.count  ?? 0
    if ((manualRes.count  ?? 0) > 0) bySource.manual          = manualRes.count   ?? 0
    if ((nullSrcRes.count ?? 0) > 0) bySource['(sin source)'] = nullSrcRes.count  ?? 0

    // ── Sample ─────────────────────────────────────────────────────────────────
    type RawRow = {
      id: string
      tracking_number: string | null
      order_number:    string | null
      customer_name:   string | null
      customer_phone:  string | null
      customer_address: string | null
      city:            string | null
      normalized_status: string
      raw_status:      string | null
      source:          string | null
      created_at:      string
    }

    const sample = ((sampleRes.data ?? []) as unknown as RawRow[]).map((o) => ({
      id:               o.id,
      tracking_number:  o.tracking_number,
      order_number:     o.order_number,
      customer_name:    o.customer_name,
      customer_phone:   o.customer_phone,
      customer_address: o.customer_address,
      customer_city:    o.city,          // alias para legibilidad en el response
      normalized_status: o.normalized_status,
      raw_status:       o.raw_status,
      source:           o.source,
      created_at:       o.created_at,
    }))

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      totals: {
        without_phone:   noPhoneRes.count   ?? 0,
        without_address: noAddressRes.count ?? 0,
        without_city:    noCityRes.count    ?? 0,
      },
      by_source:   bySource,
      sample_count: sample.length,
      sample,
      note: `Muestra ${SAMPLE_LIMIT} órdenes más recientes con tracking asignado y al menos un campo de contacto nulo (phone / address / city).`,
    })
  } catch (err) {
    console.error('[GET /api/debug/incomplete-imported-orders]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
