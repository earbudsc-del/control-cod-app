import { NextResponse } from 'next/server'
import { createClient, createPrivilegedServiceClient } from '@/lib/supabase/server'
import { getBroadcastAdminContext } from '@/lib/broadcast/admin-context'
import { parseBroadcastSelection } from '@/lib/broadcast/selection'
import { BroadcastSelectionTooBroadError } from '@/lib/broadcast/broadcast-service'
import { computeSelectionSendable } from '@/lib/broadcast/launch'
import { paginateRecipients } from '@/lib/broadcast/recipients'
import { isWaBroadcastEnabled } from '@/lib/config/wa-broadcast'

/**
 * POST /api/admin/broadcasts/recipients — READ ONLY (asistente C.2, paso "Destinatarios").
 *
 * Body: { selection: { …grupo, template }, page?, page_size?, search? }
 *
 * Calcula EN EL SERVIDOR quién recibiría el template elegido ahora mismo:
 * audiencia del grupo revalidada + reglas del template + baja promocional +
 * ya contactados + reglas por teléfono (131026 / 131049 / 7 días). Devuelve la
 * página pedida de enviables y las exclusiones con su motivo. No escribe nada.
 */
export async function POST(request: Request) {
  try {
    const auth = await getBroadcastAdminContext(await createClient())
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const parsed = parseBroadcastSelection(body?.selection)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const r = await computeSelectionSendable(createPrivilegedServiceClient(), auth.ctx, parsed.selection)
    const page = paginateRecipients(r.sendable, { page: body?.page, page_size: body?.page_size, search: body?.search })
    return NextResponse.json({
      group: r.group,
      template_name: r.template,
      template_ready: r.template_ready,
      template_missing: r.template_missing,
      header_image_url: r.header_image_url,
      candidate_count: r.audience.candidate_count,
      eligible_count: r.audience.eligible_count,
      excluded_by_reason: r.audience.excluded_by_reason,
      launch_excluded_by_reason: r.launch_excluded_by_reason,
      launch_excluded: r.launch_excluded,
      sendable_total: r.sendable.length,
      ...page,
      broadcast_enabled: isWaBroadcastEnabled(),
    })
  } catch (err) {
    if (err instanceof BroadcastSelectionTooBroadError) {
      return NextResponse.json({ error: 'Selección demasiado amplia — aplica un filtro de estado o fecha' }, { status: 422 })
    }
    console.error('[POST /api/admin/broadcasts/recipients]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
