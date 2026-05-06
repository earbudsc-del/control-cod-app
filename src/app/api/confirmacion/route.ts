import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const [pendientesRes, confirmadosSinGuiaRes, despachadosRes] = await Promise.all([

      // A) Pendientes de confirmar: confirmation_status='pending' + sin tracking
      supabase
        .from('orders')
        .select('*', { count: 'exact' })
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'pending')
        .is('tracking_number', null)
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')
        .order('created_at', { ascending: false })
        .limit(200),

      // B) Confirmados sin guía: confirmation_status='confirmed' + sin tracking
      supabase
        .from('orders')
        .select('*')
        .eq('source', 'shopify_webhook')
        .eq('confirmation_status', 'confirmed')
        .is('tracking_number', null)
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')
        .order('last_confirmation_attempt', { ascending: false, nullsFirst: false })
        .limit(200),

      // C) Despachados: con tracking, no en estado final
      supabase
        .from('orders')
        .select('*')
        .eq('source', 'shopify_webhook')
        .not('tracking_number', 'is', null)
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')
        .neq('normalized_status', 'cancelled')
        .order('last_tracking_update', { ascending: false, nullsFirst: false })
        .limit(200),
    ])

    if (pendientesRes.error) throw pendientesRes.error

    return NextResponse.json({
      data:               pendientesRes.data   ?? [],  // backward compat
      pendientes:         pendientesRes.data   ?? [],
      confirmadosSinGuia: confirmadosSinGuiaRes.data ?? [],
      despachados:        despachadosRes.data  ?? [],
      total:              pendientesRes.count  ?? 0,
    })
  } catch (err) {
    console.error('[GET /api/confirmacion]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
