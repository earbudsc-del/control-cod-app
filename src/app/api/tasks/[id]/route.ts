import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const VALID_STATUSES = ['open', 'in_progress', 'completed', 'expired', 'escalated'] as const
const VALID_RESULTS  = ['delivered', 'recovered', 'no_answer', 'rescheduled', 'returned', 'no_action'] as const

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const body = await request.json()
    const update: Record<string, unknown> = {}

    if ('status' in body) {
      if (!VALID_STATUSES.includes(body.status)) {
        return NextResponse.json({ error: 'status inválido' }, { status: 400 })
      }
      update.status = body.status
      // Auto-set completed_at when closing a task (unless caller already provided it)
      if (body.status === 'completed' && !('completed_at' in body)) {
        update.completed_at = new Date().toISOString()
      }
    }

    if ('result' in body) {
      if (body.result !== null && !VALID_RESULTS.includes(body.result)) {
        return NextResponse.json({ error: 'result inválido' }, { status: 400 })
      }
      update.result = body.result
    }

    if ('completed_at' in body) {
      update.completed_at = body.completed_at
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Sin campos válidos para actualizar' }, { status: 400 })
    }

    // RLS garantiza que el agente solo puede actualizar tareas asignadas a él
    const { data, error } = await supabase
      .from('tasks')
      .update(update)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      // PGRST116 = no rows returned (tarea no existe o RLS la bloqueó)
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Tarea no encontrada o sin permisos' }, { status: 404 })
      }
      throw error
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[PATCH /api/tasks/[id]]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
