import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { ActionType, ContactResult } from '@/types'
import { isAgentOrAbove } from '@/lib/roles'

interface ActionBody {
  action_type: ActionType
  contact_result?: ContactResult
  notes?: string
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: order_id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('id, role').eq('id', user.id).single()

    if (!profile || !isAgentOrAbove(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body: ActionBody = await request.json()
    const { action_type, contact_result, notes } = body

    const VALID_TYPES: ActionType[] = [
      'contacted','confirmed','rescheduled','recovered',
      'courier_claim','status_updated','returned','delivered',
    ]
    if (!VALID_TYPES.includes(action_type)) {
      return NextResponse.json({ error: 'Tipo de acción inválido' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('agent_actions')
      .insert({
        order_id,
        agent_id:      profile.id,
        action_type,
        contact_result: contact_result ?? null,
        notes:          notes ?? null,
      })
      .select('*, profile:profiles!agent_id(full_name)')
      .single()

    if (error) throw error
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    console.error('[POST /api/orders/[id]/actions]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
