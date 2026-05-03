import type { SupabaseClient } from '@supabase/supabase-js'
import type { TaskType, TaskPriority } from '@/types'

// Qué rol atiende cada tipo de tarea
const TASK_ROLE_MAP: Record<TaskType, string> = {
  confirmation: 'confirmation_agent',
  novedad:      'novelty_agent',
  follow_up:    'delivery_agent',
  recovery:     'novelty_agent',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findAvailableAgent(supabase: SupabaseClient<any>, storeId: string, role: string): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('store_id', storeId)
    .eq('role', role)
    .limit(1)
    .maybeSingle()

  return data?.id ?? null
}

/**
 * Inserta una tarea solo si no existe ya una activa (open/in_progress)
 * para el mismo order_id + task_type. Previene duplicados.
 */
export async function createTaskIfNotExists(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  {
    orderId,
    storeId,
    taskType,
    priority,
  }: {
    orderId:  string
    storeId:  string
    taskType: TaskType
    priority: TaskPriority
  },
): Promise<{ created: boolean; error?: string }> {
  // Verificar si ya existe una tarea activa para este pedido + tipo
  const { data: existing, error: checkErr } = await supabase
    .from('tasks')
    .select('id')
    .eq('order_id', orderId)
    .eq('task_type', taskType)
    .in('status', ['open', 'in_progress'])
    .maybeSingle()

  if (checkErr) return { created: false, error: checkErr.message }
  if (existing)  return { created: false }

  const role       = TASK_ROLE_MAP[taskType]
  const assignedTo = await findAvailableAgent(supabase, storeId, role)

  const { error: insertErr } = await supabase.from('tasks').insert({
    order_id:       orderId,
    store_id:       storeId,
    task_type:      taskType,
    priority,
    status:         'open',
    assigned_to:    assignedTo,
    assigned_by:    null,
    assigned_by_ia: true,
  })

  if (insertErr) return { created: false, error: insertErr.message }

  return { created: true }
}

/**
 * Evalúa el estado actualizado de un pedido y crea las tareas que correspondan.
 * Se llama después de cada actualización de tracking exitosa.
 *
 * Reglas:
 *   - novedad status → tarea 'novedad' (alta)
 *   - en_reparto                              → tarea 'follow_up' (media)
 */
export async function resolveAutoTasks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  {
    orderId,
    storeId,
    normalizedStatus,
  }: {
    orderId:          string
    storeId:          string
    normalizedStatus: string
  },
): Promise<void> {
  if (normalizedStatus === 'novedad') {
    await createTaskIfNotExists(supabase, {
      orderId,
      storeId,
      taskType: 'novedad',
      priority: 'high',
    })
  }

  if (normalizedStatus === 'en_reparto') {
    await createTaskIfNotExists(supabase, {
      orderId,
      storeId,
      taskType: 'follow_up',
      priority: 'medium',
    })
  }
}
