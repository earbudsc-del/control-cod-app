import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'
import type { CartRecoveryStatus } from '@/types'

const ALLOWED_ROLES = ['admin', 'ia_supervisor', 'confirmation_agent'] as const
const VALID_STATUSES: CartRecoveryStatus[] = ['pending', 'contacted', 'no_answer', 'recovered', 'discarded']

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', user.id).single()
    if (!ALLOWED_ROLES.includes(profile?.role as never)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body = await request.json() as { status?: CartRecoveryStatus; note?: string }
    const { status, note } = body

    if (!status || !VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: 'Estado inválido' }, { status: 400 })
    }

    const now = new Date().toISOString()
    const agentName = profile?.full_name ?? 'Agente'

    const updates: Record<string, unknown> = {
      recovery_status: status,
      updated_at:      now,
    }

    if (status === 'contacted' || status === 'no_answer') {
      updates.last_contacted_at = now
      updates.recovery_attempts = (await supabase
        .from('abandoned_carts')
        .select('recovery_attempts')
        .eq('id', id)
        .single()
      ).data?.recovery_attempts ?? 0 + 1
    }

    // Agregar nota de cambio de estado si se provee
    if (note?.trim()) {
      const { data: current } = await supabase
        .from('abandoned_carts')
        .select('notes')
        .eq('id', id)
        .single()

      const statusLabel: Record<CartRecoveryStatus, string> = {
        pending:   'Pendiente',
        contacted: 'Contactado',
        no_answer: 'No responde',
        recovered: 'Recuperado',
        discarded: 'Descartado',
      }
      const timestamp = new Date(now).toLocaleString('es-DO', { timeZone: 'America/Santo_Domingo' })
      const newNote   = `${timestamp} — ${agentName} [${statusLabel[status]}]: ${note.trim()}`
      updates.notes   = current?.notes ? `${newNote}\n\n${current.notes}` : newNote
    }

    const { data, error } = await supabase
      .from('abandoned_carts')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ ok: true, cart: data })
  } catch (err) {
    console.error('[PATCH /api/abandoned-carts/[id]/status]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
