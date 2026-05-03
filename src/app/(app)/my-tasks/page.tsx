import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { ROLE_TASK_TYPES } from '@/lib/roles'
import { TASK_PRIORITY_COLORS, type TaskPriority } from '@/types'
import { MyTasksDashboard } from '@/components/tasks/my-tasks-dashboard'
import { Badge } from '@/components/ui/badge'

const PRIORITY_ORDER = { high: 1, medium: 2, low: 3 } as const

const SUMMARY_TITLE: Record<string, string> = {
  novelty_agent:      'Resumen de novedades',
  delivery_agent:     'Resumen de reparto',
  confirmation_agent: 'Resumen de confirmaciones',
  agent:              'Resumen de tareas',
  ia_supervisor:      'Resumen operativo',
}

export default async function MyTasksPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role')
    .eq('id', user.id)
    .single()

  if (profile?.role === 'admin')              redirect('/dashboard')
  if (profile?.role === 'confirmation_agent') redirect('/mi-rendimiento')

  const role         = profile?.role ?? 'agent'
  const taskTypes    = ROLE_TASK_TYPES[role] ?? null
  const isSupervisor = role === 'ia_supervisor'
  const summaryTitle = SUMMARY_TITLE[role] ?? 'Resumen de tareas'

  let tasksQuery = supabase
    .from('tasks')
    .select(`
      id,
      order_id,
      task_type,
      priority,
      status,
      due_at,
      notes,
      created_at,
      pedido:orders (
        tracking_number,
        order_number,
        customer_name,
        customer_phone,
        city,
        normalized_status,
        delivery_attempts,
        status_since,
        last_novedad_at,
        duplicate_alert,
        duplicate_of_order_id
      )
    `)
    .in('status', ['open', 'in_progress'])

  if (!isSupervisor) {
    tasksQuery = tasksQuery.eq('assigned_to', user.id)
  }

  if (taskTypes !== null) {
    tasksQuery = tasksQuery.in('task_type', taskTypes)
  }

  // Rango temporal para métricas de completadas
  const now          = new Date()
  const startOfToday = new Date(now)
  startOfToday.setUTCHours(0, 0, 0, 0)
  const dow         = now.getUTCDay()
  const startOfWeek = new Date(startOfToday)
  startOfWeek.setUTCDate(startOfToday.getUTCDate() - (dow === 0 ? 6 : dow - 1))

  let completedQuery = supabase
    .from('tasks')
    .select('id, updated_at')
    .eq('status', 'completed')
    .gte('updated_at', startOfWeek.toISOString())

  if (!isSupervisor) {
    completedQuery = completedQuery.eq('assigned_to', user.id)
  }
  if (taskTypes !== null) {
    completedQuery = completedQuery.in('task_type', taskTypes)
  }

  const [{ data: rawTasks }, { data: completedRaw }] = await Promise.all([
    tasksQuery,
    completedQuery,
  ])

  const tasks = (rawTasks ?? []).sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority as keyof typeof PRIORITY_ORDER] ?? 3
    const pb = PRIORITY_ORDER[b.priority as keyof typeof PRIORITY_ORDER] ?? 3
    if (pa !== pb) return pa - pb
    const da = a.due_at ? new Date(a.due_at).getTime() : new Date(a.created_at).getTime()
    const db = b.due_at ? new Date(b.due_at).getTime() : new Date(b.created_at).getTime()
    return da - db
  })

  const highCount        = tasks.filter(t => t.priority === 'high').length
  const openCount        = tasks.filter(t => t.status === 'open').length
  const resolvedToday    = (completedRaw ?? []).filter(t => new Date(t.updated_at) >= startOfToday).length
  const resolvedThisWeek = completedRaw?.length ?? 0

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Mis tareas</h1>
          <p className="text-sm text-gray-500 mt-1">
            {profile?.full_name} · {tasks.length} tarea{tasks.length !== 1 ? 's' : ''} activa{tasks.length !== 1 ? 's' : ''}
          </p>
        </div>
        {tasks.length > 0 && (
          <div className="flex gap-3 text-sm">
            {highCount > 0 && (
              <Badge className={TASK_PRIORITY_COLORS['high' as TaskPriority]}>
                {highCount} urgente{highCount !== 1 ? 's' : ''}
              </Badge>
            )}
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-gray-600">
              {openCount} abiert{openCount !== 1 ? 'as' : 'a'}
            </span>
          </div>
        )}
      </div>

      {/* Dashboard con KPIs — siempre visible */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <MyTasksDashboard
        tasks={tasks as any}
        summaryTitle={summaryTitle}
        resolvedToday={resolvedToday}
        resolvedThisWeek={resolvedThisWeek}
      />
    </div>
  )
}
