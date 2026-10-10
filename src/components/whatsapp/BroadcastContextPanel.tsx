'use client'

// Sprint C.1 — contexto de campaña Broadcast para el agente del Inbox.
// Muestra el pedido con su estado ACTUAL (leído de orders), la campaña de
// origen, el botón pulsado y la ventana de 24 h. No confirma ni cancela: las
// acciones comerciales se hacen en el detalle del pedido (flujos existentes).
// Se oculta si la conversación no tiene relación con ninguna campaña.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Megaphone, MapPin, Clock, Ban, CheckCircle2, ExternalLink } from 'lucide-react'
import { BROADCAST_INTENT_LABELS } from '@/lib/broadcast/labels'
import type { BroadcastInboxContext } from '@/lib/broadcast/inbox-context'

const INTENT_STYLE: Record<string, string> = {
  confirm_interest:    'bg-green-100 text-green-800',
  decline_order:       'bg-red-100 text-red-800',
  repurchase_interest: 'bg-teal-100 text-teal-800',
  repurchase_decline:  'bg-gray-100 text-gray-700',
  unknown:             'bg-amber-100 text-amber-800',
}

function fmtMoney(v: number | null): string {
  return v == null ? '—' : `RD$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v)}`
}

export default function BroadcastContextPanel({ conversationId, onChanged }: { conversationId: string | null; onChanged?: () => void }) {
  const [ctx, setCtx] = useState<BroadcastInboxContext | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!conversationId) { setCtx(null); return }
    try {
      const res = await fetch(`/api/whatsapp/conversations/${conversationId}/broadcast-context`)
      const body = await res.json().catch(() => null)
      setCtx(res.ok ? body?.data ?? null : null)
    } catch {
      setCtx(null)
    }
  }, [conversationId])

  useEffect(() => { setError(null); void load() }, [load])

  async function act(action: 'mark_handled' | 'opt_out') {
    if (!conversationId) return
    if (action === 'opt_out' && !window.confirm('¿Registrar que este cliente NO quiere recibir mensajes promocionales? No afecta su pedido.')) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/whatsapp/conversations/${conversationId}/broadcast-context`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      })
      if (!res.ok) setError((await res.json().catch(() => null))?.error ?? 'No se pudo guardar')
      await load()
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  if (!ctx || (!ctx.order && ctx.responses.length === 0)) return null
  const last = ctx.responses[0]
  const o = ctx.order

  return (
    <div className="flex-shrink-0 border-b border-amber-200 bg-amber-50/60 px-4 py-2.5 text-xs text-gray-700 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Megaphone className="w-3.5 h-3.5 text-amber-700" />
        <span className="font-semibold text-gray-900">Respuesta de campaña</span>
        {ctx.campaign && <span className="font-mono text-[10px] text-gray-500">{ctx.campaign.template_name} · {ctx.campaign.status_label}</span>}
        {last && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${INTENT_STYLE[last.intent] ?? INTENT_STYLE.unknown}`}>
            {BROADCAST_INTENT_LABELS[last.intent] ?? last.intent}{last.button_text ? ` · "${last.button_text}"` : ''}
          </span>
        )}
        {ctx.unhandled > 0 && <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-semibold text-amber-900">Sin atender</span>}
        {ctx.marketing_opt_out && (
          <span className="flex items-center gap-1 rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-semibold text-gray-700">
            <Ban className="w-3 h-3" /> Baja promocional
          </span>
        )}
      </div>

      {o ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span><b>{o.order_number ?? 'Pedido'}</b> · {o.customer_name ?? '—'}</span>
          <span>Confirmación: <b>{o.confirmation_status ?? '—'}</b></span>
          <span>Estado: <b>{o.normalized_status ?? '—'}</b></span>
          <span>Pago: <b>{o.payment_status ?? '—'}</b></span>
          <span>{fmtMoney(o.cod_amount)}{o.offer_line ? ` · ${o.offer_line}` : ''}</span>
          <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />
            {o.location.has_coordinates ? `Ubicación ${o.location.status ?? 'recibida'}` : 'Sin ubicación'} · {[o.address, o.city].filter(Boolean).join(', ') || '—'}
          </span>
          <Link href={`/orders/${o.id}`} className="flex items-center gap-1 font-semibold text-indigo-700 hover:underline">
            Abrir pedido <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      ) : (
        <p className="text-amber-800">No se pudo asociar esta respuesta a un pedido con certeza — revisar manualmente.</p>
      )}

      {last?.intent === 'confirm_interest' && o?.confirmation_status === 'confirmed' && (
        <p className="text-green-800">El pedido ya está confirmado — no confirmar de nuevo.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className={`flex items-center gap-1 ${ctx.window.open ? 'text-green-700' : 'text-red-700'}`}>
          <Clock className="w-3 h-3" />
          {ctx.window.open ? 'Ventana 24 h abierta — puedes responder' : 'Fuera de la ventana 24 h — solo templates'}
        </span>
        {ctx.unhandled > 0 && (
          <button disabled={busy} onClick={() => act('mark_handled')}
            className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-0.5 font-semibold hover:bg-gray-50 disabled:opacity-50">
            <CheckCircle2 className="w-3 h-3" /> Marcar atendida
          </button>
        )}
        {!ctx.marketing_opt_out && (
          <button disabled={busy} onClick={() => act('opt_out')}
            className="rounded-md border border-gray-300 bg-white px-2 py-0.5 font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            Registrar baja promocional
          </button>
        )}
        {error && <span className="text-red-700">{error}</span>}
      </div>
    </div>
  )
}
