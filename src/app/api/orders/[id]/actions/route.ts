import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { ActionType, ContactResult } from '@/types'
import { isAgentOrAbove } from '@/lib/roles'
import { createLocalFulfillment } from '@/lib/shopify/fulfillments'

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
      'route_confirmed','customer_declined',
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
