import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    // Solo pedidos que necesitan acción de confirmación:
    // - Sin tracking_number: si ya tiene guía, pertenece a /despachados
    const { data, error, count } = await supabase
      .from('orders')
      .select('*', { count: 'exact' })
      .eq('source', 'shopify_webhook')
      .eq('confirmation_status', 'pending')
      .eq('normalized_status', 'pending')
      .is('tracking_number', null)
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) throw error

    return NextResponse.json({ data: data ?? [], total: count ?? 0 })
  } catch (err) {
    console.error('[GET /api/confirmacion]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
