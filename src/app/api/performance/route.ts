import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get('agent_id')

    let query = supabase.from('agent_performance_summary').select('*')
    if (agentId) query = query.eq('agent_id', agentId)

    const { data, error } = await query.order('pedidos_asignados', { ascending: false })
    if (error) throw error

    return NextResponse.json(data)
  } catch (err) {
    console.error('[GET /api/performance]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
