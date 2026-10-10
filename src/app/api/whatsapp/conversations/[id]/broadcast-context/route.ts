import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getInboxAgentContext } from '@/lib/whatsapp/inbox-auth'
import { buildBroadcastInboxContext, markBroadcastResponsesHandled } from '@/lib/broadcast/inbox-context'
import { recordMarketingOptOut } from '@/lib/broadcast/suppression'

/** GET — contexto de Broadcast de la conversación (pedido actual, campaña, botón, ventana 24 h). READ ONLY. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getInboxAgentContext()
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { id } = await params
    const ctx = await buildBroadcastInboxContext(await createServiceClient(), auth.storeId, id)
    if (!ctx) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
    return NextResponse.json({ data: ctx })
  } catch (err) {
    console.error('[GET broadcast-context]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

/**
 * PATCH — acciones del agente sobre la respuesta de campaña:
 *   { action: 'mark_handled' }  marca las respuestas pendientes como atendidas
 *   { action: 'opt_out', reason } registra baja promocional del contacto
 * No toca el pedido: confirmar/cancelar se hace con los flujos existentes.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getInboxAgentContext()
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const { id } = await params
    const body = await request.json().catch(() => null) as { action?: unknown; reason?: unknown } | null
    const db = await createServiceClient()

    if (body?.action === 'mark_handled') {
      const n = await markBroadcastResponsesHandled(db, auth.storeId, id, auth.userId)
      return NextResponse.json({ ok: true, handled: n })
    }
    if (body?.action === 'opt_out') {
      const ctx = await buildBroadcastInboxContext(db, auth.storeId, id)
      if (!ctx?.phone_normalized) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
      const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'Marcado por agente desde el Inbox'
      const r = await recordMarketingOptOut(db, { storeId: auth.storeId, phoneNormalized: ctx.phone_normalized, source: 'agent', reason, userId: auth.userId })
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 500 })
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: 'action inválida' }, { status: 400 })
  } catch (err) {
    console.error('[PATCH broadcast-context]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
