import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ROLE_TASK_TYPES } from '@/lib/roles'

const PRIORITY_ORDER = { high: 1, medium: 2, low: 3 } as const

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    // El rol determina los filtros — se obtiene antes de construir la query
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    const role       = profile?.role ?? 'agent'
    const taskTypes  = ROLE_TASK_TYPES[role] ?? null          // null = sin filtro de tipo
    const isSupervisor = role === 'ia_supervisor'

    let query = supabase
      .from('tasks')
      .select(`
        id,
        order_id,
        task_type,
        priority,
        status,
        due_at,
        created_at,
        pedido:orders (
          tracking_number,
          customer_name,
          city,
          normalized_status,
          delivery_attempts
        )
      `)
      .in('status', ['open', 'in_progress'])

    // ia_supervisor ve todas las tareas del store (RLS restringe por store_id)
    // El resto solo ve las tareas asignadas a su usuario
    if (!isSupervisor) {
      query = query.eq('assigned_to', user.id)
    }

    // Roles especializados solo ven los task_types de su área
    if (taskTypes !== null) {
      query = query.in('task_type', taskTypes)
    }

    const { data, error } = await query
    if (error) throw error

    const tasks = (data ?? []).sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority as keyof typeof PRIORITY_ORDER] ?? 3
      const pb = PRIORITY_ORDER[b.priority as keyof typeof PRIORITY_ORDER] ?? 3
      if (pa !== pb) return pa - pb
      const da = a.due_at ? new Date(a.due_at).getTime() : new Date(a.created_at).getTime()
      const db = b.due_at ? new Date(b.due_at).getTime() : new Date(b.created_at).getTime()
      return da - db
    })

    return NextResponse.json({ tasks })
  } catch (err) {
    console.error('[GET /api/my-tasks]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
