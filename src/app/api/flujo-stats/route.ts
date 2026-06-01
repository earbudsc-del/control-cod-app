import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    // Ventana operativa para "generadas": 60 días hacia atrás.
    // Excluye guías históricas atascadas en in_transit con raw_status='Generada'
    // que EFI ya no sirve (devuelve "no encontrada") — contaminaban el conteo inflando
    // el número de generadas vs lo real en EFI.
    // Prioridad: shipment_created_at (fecha real EFI). Fallback: created_at (fecha DB).
    const cutoffGeneradas = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

    const base = () => supabase.from('orders').select('id', { count: 'exact', head: true })

    const [generadasRes, inTransitRes, enRepartoRes, anuladas1Res, anuladas2Res] = await Promise.all([
      // Generadas activas: raw_status contiene "generada" SIN anuladas/canceladas,
      // sin estados terminales, y dentro de la ventana operativa de 60 días.
      // El OR cubre órdenes sin shipment_created_at usando created_at como fallback.
      base()
        .not('tracking_number', 'is', null)
        .ilike('raw_status', '%generada%')
        .not('raw_status', 'ilike', '%anulad%')
        .not('raw_status', 'ilike', '%cancelad%')
        .not('normalized_status', 'in', '(returned,delivered,novedad,en_reparto)')
        .or(`shipment_created_at.gte.${cutoffGeneradas},and(shipment_created_at.is.null,created_at.gte.${cutoffGeneradas})`),

      // En tránsito activo: normalized_status='in_transit' sin generadas ni anuladas
      base()
        .not('tracking_number', 'is', null)
        .eq('normalized_status', 'in_transit')
        .not('raw_status', 'ilike', '%generada%')
        .not('raw_status', 'ilike', '%anulad%')
        .not('raw_status', 'ilike', '%cancelad%'),

      // En reparto: excluyendo anuladas/canceladas
      base()
        .not('tracking_number', 'is', null)
        .eq('normalized_status', 'en_reparto')
        .not('raw_status', 'ilike', '%anulad%')
        .not('raw_status', 'ilike', '%cancelad%'),

      // Anuladas (raw_status "Anulada")
      base()
        .not('tracking_number', 'is', null)
        .ilike('raw_status', '%anulad%'),

      // Canceladas (raw_status "Cancelada por transportadora")
      base()
        .not('tracking_number', 'is', null)
        .ilike('raw_status', '%cancelad%'),
    ])

    return NextResponse.json({
      generadas:  generadasRes.count  ?? 0,
      in_transit: inTransitRes.count  ?? 0,
      en_reparto: enRepartoRes.count  ?? 0,
      anuladas:   (anuladas1Res.count ?? 0) + (anuladas2Res.count ?? 0),
    })
  } catch (err) {
    console.error('[GET /api/flujo-stats]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
