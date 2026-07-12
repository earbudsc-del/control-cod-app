import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { ActionType, ContactResult, NoveltyType } from '@/types'
import { isAgentOrAbove } from '@/lib/roles'
import { createLocalFulfillment } from '@/lib/shopify/fulfillments'
import { recordNoveltyAction, type NoveltyActionInput } from '@/lib/novelty/record-novelty-action'

interface ActionBody {
  action_type: ActionType
  contact_result?: ContactResult
  notes?: string
  // Motor de Novedades — solo aplican cuando el pedido está en normalized_status='novedad'
  confirm_communication?: NoveltyType
  rescheduled_date?: string
  rescheduled_note?: string
}

// action_type que el motor de Novedades intercepta cuando el pedido está en
// normalized_status='novedad'. Fuera de novedad (Reparto, SD Delivery) estos
// mismos valores siguen el camino genérico de siempre, sin cambios.
const NOVELTY_ACTION_TYPES = new Set<ActionType>(['contacted', 'rescheduled', 'recovered'])

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: order_id } = await params
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      console.error(`[actions] 401 no auth order_id=${order_id}`)
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles').select('id, role').eq('id', user.id).single()

    if (!profile || !isAgentOrAbove(profile.role)) {
      console.error(`[actions] 403 user=${user.id} role=${profile?.role ?? 'null'}`)
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const body: ActionBody = await request.json()
    const { action_type, contact_result, notes } = body

    const VALID_TYPES: ActionType[] = [
      'contacted','confirmed','rescheduled','recovered',
      'courier_claim','note_added','status_updated','returned','delivered',
      'route_confirmed','customer_declined','local_dispatched',
    ]
    if (!VALID_TYPES.includes(action_type)) {
      return NextResponse.json({ error: 'Tipo de acción inválido' }, { status: 400 })
    }

    // ── Motor de Novedades: delega en recordNoveltyAction cuando el pedido ──
    // está en normalized_status='novedad'. Reparto y SD Delivery reutilizan
    // los mismos action_type ('contacted', 'rescheduled') pero nunca están en
    // normalized_status='novedad', así que este chequeo los deja intactos.
    if (NOVELTY_ACTION_TYPES.has(action_type)) {
      const { data: order } = await supabase
        .from('orders')
        .select('normalized_status')
        .eq('id', order_id)
        .single()

      if (order?.normalized_status === 'novedad') {
        let noveltyInput: NoveltyActionInput

        if (action_type === 'rescheduled') {
          if (!body.rescheduled_date) {
            return NextResponse.json(
              { error: 'Se requiere rescheduled_date para reprogramar' },
              { status: 400 },
            )
          }
          noveltyInput = {
            kind: 'rescheduled',
            orderId: order_id,
            agentId: profile.id,
            rescheduledDate: body.rescheduled_date,
            rescheduledNote: body.rescheduled_note ?? null,
          }
        } else if (action_type === 'contacted' && body.confirm_communication) {
          noveltyInput = {
            kind: 'confirm_classification',
            orderId: order_id,
            agentId: profile.id,
            confirmedType: body.confirm_communication,
          }
        } else if (action_type === 'contacted') {
          noveltyInput = {
            kind: 'contacted',
            orderId: order_id,
            agentId: profile.id,
            contactResult: contact_result ?? null,
            notes: notes ?? null,
          }
        } else {
          noveltyInput = {
            kind: 'recovered',
            orderId: order_id,
            agentId: profile.id,
            notes: notes ?? null,
          }
        }

        const result = await recordNoveltyAction(supabase, noveltyInput)
        if (!result.ok) {
          console.error(`[actions/novelty] order=${order_id} kind=${noveltyInput.kind} error=${result.error}`)
          return NextResponse.json({ error: result.error }, { status: result.status })
        }
        // Shape distinto del path genérico ({ action, order }) — el único
        // consumidor de esta rama es /novedad, que necesita el estado fresco
        // del pedido (novelty_type, delivery_resolution, etc.) para actualizar
        // la UI sin re-fetch completo.
        return NextResponse.json(result.data, { status: 201 })
      }
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

    if (error) {
      console.error(`[actions] DB insert FAILED — order=${order_id} action=${action_type} code=${error.code} msg=${error.message}`)
      throw error
    }

    // ── Sincronización Shopify: crear fulfillment cuando el mensajero sale a ruta ──
    if (action_type === 'route_confirmed') {
      const { data: order } = await supabase
        .from('orders')
        .select('shopify_order_id, tracking_number, source')
        .eq('id', order_id)
        .single()

      if (order?.shopify_order_id && order.source === 'shopify_webhook') {
        const fulfillResult = await createLocalFulfillment(
          order.shopify_order_id,
          order.tracking_number ?? null,
        )

        const logEntry = {
          order_id,
          shopify_order_id: order.shopify_order_id,
          event_type:       'fulfillment',
          result:           fulfillResult.success
            ? (fulfillResult.skipped ? 'skipped' : 'success')
            : 'error',
          error_message:    fulfillResult.error ?? null,
          metadata:         { action_type, fulfillment_id: fulfillResult.fulfillment_id ?? null },
          triggered_by:     profile.id,
        }

        supabase.from('shopify_sync_log').insert(logEntry).then(({ error: logErr }) => {
          if (logErr) console.error('[actions/route_confirmed] shopify_sync_log error:', logErr.message)
        })

        if (fulfillResult.success) {
          console.log(
            `[actions/route_confirmed] Shopify fulfillment ${fulfillResult.skipped ? 'ya existía' : 'creado'} — order=${order_id} shopify=${order.shopify_order_id}`,
          )
        } else {
          console.warn(
            `[actions/route_confirmed] Shopify fulfillment FALLÓ (flujo local OK) — order=${order_id} shopify=${order.shopify_order_id} error=${fulfillResult.error}`,
          )
        }
      }
    }

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    console.error('[POST /api/orders/[id]/actions]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
