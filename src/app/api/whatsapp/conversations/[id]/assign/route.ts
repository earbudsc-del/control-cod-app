import { createClient } from '@/lib/supabase/server'
import { NextResponse }  from 'next/server'

// PATCH — asigna una conversación a Génesis, a un agente específico, o la
// deja sin asignar (modo manual sin IA). Reemplaza/complementa a take/release
// para el dropdown "Asignar a:" del header del Inbox.
//
// Combinaciones válidas (ver FASE 7B.1):
//   Génesis        → { assigned_to: null,      ai_enabled: true  }
//   Agente         → { assigned_to: <agentId>, ai_enabled: false }
//   Sin asignar    → { assigned_to: null,      ai_enabled: false }
//
// No están permitidas combinaciones con assigned_to != null y ai_enabled = true
// (un chat asignado a un humano nunca debe quedar con Génesis activo a la vez).
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('role, store_id').eq('id', user.id).maybeSingle()

    if (!profile) return NextResponse.json({ error: 'Perfil no encontrado' }, { status: 403 })
    if (profile.role === 'viewer') return NextResponse.json({ error: 'Sin acceso al inbox' }, { status: 403 })

    const { id } = await params
    const body = await request.json().catch(() => null) as
      { assigned_to?: string | null; ai_enabled?: boolean } | null

    if (!body || typeof body.ai_enabled !== 'boolean') {
      return NextResponse.json({ error: 'ai_enabled (boolean) es obligatorio' }, { status: 400 })
    }

    const assignedTo = body.assigned_to ?? null
    if (assignedTo !== null && typeof assignedTo !== 'string') {
      return NextResponse.json({ error: 'assigned_to inválido' }, { status: 400 })
    }
    if (assignedTo !== null && body.ai_enabled) {
      return NextResponse.json(
        { error: 'Una conversación asignada a un agente no puede tener ai_enabled=true' },
        { status: 400 },
      )
    }

    if (assignedTo !== null) {
      const { data: targetProfile } = await supabase
        .from('profiles').select('id').eq('id', assignedTo).maybeSingle()
      if (!targetProfile) return NextResponse.json({ error: 'Agente inválido' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('wa_conversations')
      .update({ assigned_to: assignedTo, ai_enabled: body.ai_enabled })
      .eq('id', id)
      .select(
        `id, status, unread_count, last_message_at, last_message_preview,
         assigned_to, ai_enabled, created_at, updated_at,
         contact:wa_contacts(id, phone_normalized, display_name, wa_id, order_id, last_seen_at),
         assigned_agent:profiles(id, full_name)`,
      )
      .maybeSingle()

    if (error) throw error
    if (!data) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

    return NextResponse.json({ data })
  } catch (err) {
    console.error('[PATCH /api/whatsapp/conversations/[id]/assign]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
