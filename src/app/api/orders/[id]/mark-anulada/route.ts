import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Roles permitidos para anular guías manualmente desde /transito
const ALLOWED_ROLES = ['admin', 'novelty_agent']

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: order_id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, role, full_name')
      .eq('id', user.id)
      .single()

    if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
      return NextResponse.json(
        { error: 'Sin permisos. Solo admin o novelty_agent pueden marcar guías como anuladas.' },
        { status: 403 },
      )
    }

    const { data: order } = await supabase
      .from('orders')
      .select('id, tracking_number, normalized_status, raw_status')
      .eq('id', order_id)
      .single()

    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })

    // Actualizar estado del pedido
    const { error: updateErr } = await supabase
      .from('orders')
      .update({
        raw_status:           'Anulada',
        normalized_status:    'returned',
        last_tracking_update: new Date().toISOString(),
      })
      .eq('id', order_id)

    if (updateErr) throw updateErr

    const prevRaw        = order.raw_status        ?? 'N/A'
    const prevNormalized = order.normalized_status ?? 'N/A'
    const noteContent    = `Guía anulada manualmente desde /transito por ${profile.full_name ?? profile.role}. Estado anterior: raw_status="${prevRaw}", normalized_status="${prevNormalized}".`

    // Insertar nota interna + acción de agente en paralelo (sin bloquear si fallan)
    await Promise.all([
      supabase
        .from('notes')
        .insert({ order_id, created_by: profile.id, content: noteContent })
        .then(r => { if (r.error) console.error('[mark-anulada] note error:', r.error) }),
      supabase
        .from('agent_actions')
        .insert({
          order_id,
          agent_id:    profile.id,
          action_type: 'cancelled',
          notes:       'Guía anulada manualmente desde /transito',
        })
        .then(r => { if (r.error) console.error('[mark-anulada] action error:', r.error) }),
    ])

    console.log(
      `[mark-anulada] order=${order_id} tracking=${order.tracking_number} ` +
      `prev="${prevRaw}"/${prevNormalized} → Anulada/returned by=${profile.role}`,
    )

    return NextResponse.json({
      success:           true,
      order_id,
      tracking_number:   order.tracking_number,
      raw_status:        'Anulada',
      normalized_status: 'returned',
    })
  } catch (err) {
    console.error('[POST /api/orders/[id]/mark-anulada]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
