import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'

// POST /api/admin/fix-indemnizacion-status
// Solo admin. DB-only — sin llamadas EFI.
//
// Encuentra órdenes con normalized_status='novedad' y raw_status ILIKE '%indemniz%'
// (registros creados antes del Paso 8, cuando el parser aún mapeaba Indemnización → novedad)
// y actualiza normalized_status='indemnizacion'.

const ALLOWED_ROLES = ['admin']

interface FixedItem {
  tracking_number: string | null
  order_number:    string | null
  customer_name:   string | null
  raw_status:      string | null
}

export async function POST() {
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
      return NextResponse.json({ error: 'Solo admins pueden usar esta herramienta' }, { status: 403 })
    }

    // 1. Encontrar todas las novedades con raw_status que indique indemnización
    const { data: mismatched, error: queryErr } = await supabase
      .from('orders')
      .select('id, tracking_number, order_number, customer_name, raw_status')
      .eq('normalized_status', 'novedad')
      .ilike('raw_status', '%indemniz%')

    if (queryErr) {
      console.error('[fix-indemnizacion-status] DB query error:', queryErr.message)
      return NextResponse.json({ error: 'Error al consultar DB' }, { status: 500 })
    }

    const rows = mismatched ?? []
    const scanned = rows.length

    if (scanned === 0) {
      console.log(`[fix-indemnizacion-status] user=${user.id} — nada que corregir`)
      return NextResponse.json({ scanned: 0, updated: 0, sample: [] })
    }

    // 2. Obtener IDs para el UPDATE en lote
    const ids = rows.map(r => r.id)

    const { error: updateErr } = await supabase
      .from('orders')
      .update({ normalized_status: 'indemnizacion' })
      .in('id', ids)

    if (updateErr) {
      console.error('[fix-indemnizacion-status] DB update error:', updateErr.message)
      return NextResponse.json({ error: 'Error al actualizar DB' }, { status: 500 })
    }

    const sample: FixedItem[] = rows.slice(0, 20).map(r => ({
      tracking_number: r.tracking_number,
      order_number:    r.order_number,
      customer_name:   r.customer_name,
      raw_status:      r.raw_status,
    }))

    console.log(
      `[fix-indemnizacion-status] user=${user.id} scanned=${scanned} updated=${scanned}`,
    )

    return NextResponse.json({ scanned, updated: scanned, sample })
  } catch (err) {
    console.error('[POST /api/admin/fix-indemnizacion-status]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
