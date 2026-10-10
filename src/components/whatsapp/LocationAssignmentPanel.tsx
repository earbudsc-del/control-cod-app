'use client'

// C.1.3 — ubicación ambigua pendiente de asociar (varios pedidos SD activos).
// El agente elige el pedido correcto; el servidor revalida (tienda, contacto,
// pedido activo), guarda la ubicación y audita. NO confirma ni despacha.
// Se oculta si la conversación no tiene pins pendientes.

import { useCallback, useEffect, useState } from 'react'
import { MapPin, ExternalLink } from 'lucide-react'
import type { LocationCandidateOrder, PendingLocation } from '@/lib/whatsapp/inbound-location'

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('es-DO', { timeZone: 'America/Santo_Domingo', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—'
}

export default function LocationAssignmentPanel({ conversationId }: { conversationId: string | null }) {
  const [pending, setPending] = useState<PendingLocation[]>([])
  const [candidates, setCandidates] = useState<LocationCandidateOrder[]>([])
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    if (!conversationId) { setPending([]); setCandidates([]); return }
    try {
      const r = await fetch(`/api/whatsapp/conversations/${conversationId}/location-assignment`)
      const body = await r.json().catch(() => null)
      setPending(r.ok ? body?.data?.pending ?? [] : [])
      setCandidates(r.ok ? body?.data?.candidates ?? [] : [])
    } catch {
      setPending([]); setCandidates([])
    }
  }, [conversationId])

  useEffect(() => { setMsg(null); setChoice({}); void load() }, [load])

  async function assign(messageId: string) {
    const orderId = choice[messageId]
    if (!conversationId || !orderId) return
    const order = candidates.find(c => c.id === orderId)
    if (!window.confirm(`¿Asociar esta ubicación al pedido ${order?.order_number ?? ''}? No confirma ni despacha el pedido.`)) return
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(`/api/whatsapp/conversations/${conversationId}/location-assignment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: messageId, order_id: orderId }),
      })
      const body = await r.json().catch(() => null)
      setMsg(r.ok ? { ok: true, text: 'Ubicación asociada al pedido.' } : { ok: false, text: body?.error ?? 'No se pudo asociar' })
      await load()
    } finally { setBusy(false) }
  }

  if (pending.length === 0) return msg?.ok ? <p className="flex-shrink-0 border-b border-green-200 bg-green-50 px-4 py-1.5 text-xs text-green-800">{msg.text}</p> : null

  return (
    <div className="flex-shrink-0 border-b border-sky-200 bg-sky-50/70 px-4 py-2.5 text-xs text-gray-700 space-y-2">
      {pending.map(p => (
        <div key={p.message_id} className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <MapPin className="w-3.5 h-3.5 text-sky-700" />
            <span className="font-semibold text-gray-900">Ubicación sin asociar</span>
            <span className="text-gray-500">{fmtDate(p.sent_at)} · el cliente tiene {p.candidates_count ?? candidates.length} pedidos activos</span>
            <a href={`https://www.google.com/maps?q=${p.latitude},${p.longitude}`} target="_blank" rel="noreferrer"
               className="flex items-center gap-1 font-semibold text-indigo-700 hover:underline">
              Ver en mapa <ExternalLink className="w-3 h-3" />
            </a>
            {(p.name || p.address) && <span className="text-gray-500">{[p.name, p.address].filter(Boolean).join(' · ')}</span>}
          </div>
          {candidates.length === 0 ? (
            <p className="text-amber-800">Ningún pedido activo de este contacto puede recibir la ubicación ahora.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select value={choice[p.message_id] ?? ''} disabled={busy}
                onChange={e => setChoice(c => ({ ...c, [p.message_id]: e.target.value }))}
                className="rounded-md border border-gray-300 bg-white px-2 py-1">
                <option value="">Elegir pedido…</option>
                {candidates.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.order_number ?? c.id.slice(0, 8)} · {c.confirmation_status ?? '—'} · {c.normalized_status ?? '—'} · {[c.customer_address, c.city].filter(Boolean).join(', ') || 'sin dirección'}
                  </option>
                ))}
              </select>
              <button disabled={busy || !choice[p.message_id]} onClick={() => assign(p.message_id)}
                className="rounded-md bg-sky-700 px-2.5 py-1 font-semibold text-white disabled:opacity-40">
                Asociar ubicación
              </button>
              <span className="text-gray-500">No confirma ni despacha el pedido.</span>
            </div>
          )}
        </div>
      ))}
      {msg && <p className={msg.ok ? 'text-green-700' : 'text-red-700'}>{msg.text}</p>}
    </div>
  )
}
