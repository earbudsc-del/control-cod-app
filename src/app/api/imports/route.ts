import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { ParsedOrder } from '@/lib/parsers/csv-parser'
import { isAgentOrAbove } from '@/lib/roles'

interface ImportBody {
  filename: string
  orders: ParsedOrder[]
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, store_id, role')
      .eq('id', user.id)
      .single()

    if (!profile || !isAgentOrAbove(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body: ImportBody = await request.json()
    const { filename, orders } = body

    if (!orders?.length) {
      return NextResponse.json({ error: 'No hay pedidos para importar' }, { status: 400 })
    }

    // Crear registro de importación
    const { data: importRecord, error: importError } = await supabase
      .from('imports')
      .insert({
        store_id: profile.store_id,
        filename,
        imported_by: profile.id,
        record_count: orders.length,
        status: 'processing',
      })
      .select('id')
      .single()

    if (importError) throw importError

    const importId = importRecord.id
    let upserted = 0
    let skipped = 0
    const errors: string[] = []

    // Upsert por lotes de 50
    const BATCH = 50
    for (let i = 0; i < orders.length; i += BATCH) {
      const batch = orders.slice(i, i + BATCH)

      const rows = batch
        .filter(o => o.tracking_number)
        .map(o => ({
          store_id:         profile.store_id,
          import_id:        importId,
          tracking_number:  o.tracking_number,
          order_number:     o.order_number ?? null,
          customer_name:    o.customer_name ?? null,
          customer_phone:   o.customer_phone ?? null,
          customer_address: o.customer_address ?? null,
          city:             o.city ?? null,
          province:         o.province ?? null,
          product_summary:  o.product_summary ?? null,
          cod_amount:       o.cod_amount ?? null,
          carrier:          o.carrier ?? null,
          raw_status:       o.raw_status ?? null,
          normalized_status: o.normalized_status,
          delivery_attempts: o.delivery_attempts,
          is_at_risk:       o.is_at_risk,
          updated_at:       new Date().toISOString(),
        }))

      const { error: upsertError } = await supabase
        .from('orders')
        .upsert(rows, {
          onConflict: 'store_id,tracking_number',
          ignoreDuplicates: false,
        })

      if (upsertError) {
        errors.push(`Lote ${Math.floor(i / BATCH) + 1}: ${upsertError.message}`)
      } else {
        upserted += rows.length
      }
    }

    // Actualizar estado del import
    await supabase
      .from('imports')
      .update({
        status: errors.length > 0 ? 'failed' : 'completed',
        record_count: upserted,
        error_log: errors.length > 0 ? { errors } : null,
      })
      .eq('id', importId)

    return NextResponse.json({
      import_id: importId,
      upserted,
      skipped,
      errors,
      status: errors.length > 0 ? 'partial' : 'ok',
    })
  } catch (err) {
    console.error('[POST /api/imports]', err)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data, error } = await supabase
      .from('imports')
      .select('*, profile:profiles!imported_by(full_name)')
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw error
    return NextResponse.json(data)
  } catch (err) {
    console.error('[GET /api/imports]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
