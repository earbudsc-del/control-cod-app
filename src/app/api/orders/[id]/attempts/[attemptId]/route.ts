import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { InvalidReason } from '@/types'
import { isAgentOrAbove } from '@/lib/roles'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; attemptId: string }> },
) {
  try {
    const { attemptId } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('id, role').eq('id', user.id).single()

    if (!profile || !isAgentOrAbove(profile.role)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const { is_valid, invalid_reason, invalid_notes }: {
      is_valid: boolean
      invalid_reason?: InvalidReason
      invalid_notes?: string
    } = await request.json()

    if (!is_valid && !invalid_reason) {
      return NextResponse.json({ error: 'Se requiere razón para invalidar' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('delivery_attempt_records')
      .update({
        is_valid,
        invalid_reason:  is_valid ? null : (invalid_reason ?? null),
        invalid_notes:   is_valid ? null : (invalid_notes ?? null),
        flagged_by:      profile.id,
        flagged_at:      new Date().toISOString(),
      })
      .eq('id', attemptId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json(data)
  } catch (err) {
    console.error('[PATCH /api/orders/[id]/attempts/[attemptId]]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
