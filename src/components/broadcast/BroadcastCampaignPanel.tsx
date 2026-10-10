'use client'

// Sprint C.1 — estado, métricas y controles de una campaña (historial).
// Las métricas solo cuentan lo que tiene evidencia: aceptado por Meta ≠
// entregado; "Quiere confirmar" (intención) ≠ confirmación atribuible.

import { useCallback, useEffect, useState } from 'react'
import { Pause, Play, Send } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { BROADCAST_INTENT_LABELS, BROADCAST_QUEUE_STATUS_LABELS, BROADCAST_STATUS_LABELS } from '@/lib/broadcast/labels'
import type { BroadcastMetrics } from '@/lib/broadcast/metrics'
import { BroadcastLaunchModal } from './BroadcastLaunchModal'

interface Detail {
  broadcast: { id: string; status: string; launched_at: string | null; paused_at: string | null; completed_at: string | null; send_limit: number | null; last_error: string | null }
  metrics: BroadcastMetrics | null
  broadcast_enabled: boolean
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-md bg-white px-2 py-1 border border-gray-100"><div className="text-[10px] text-gray-500">{label}</div><div className="font-bold tabular-nums">{value}</div></div>
}

export function BroadcastCampaignPanel({ broadcastId, onChanged }: { broadcastId: string; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [launchOpen, setLaunchOpen] = useState(false)

  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/broadcasts/${broadcastId}`)
    const body = await r.json().catch(() => ({}))
    if (!r.ok) setError(body.error ?? `Error ${r.status}`); else { setD(body as Detail); setError(null) }
  }, [broadcastId])

  useEffect(() => { void load() }, [load])

  async function control(action: 'pause' | 'resume') {
    if (action === 'resume' && !window.confirm('¿Reanudar el envío de mensajes REALES de esta campaña?')) return
    setBusy(true)
    try {
      const r = await fetch(`/api/admin/broadcasts/${broadcastId}/${action}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: action === 'resume' ? JSON.stringify({ acknowledge_real_messages: true }) : undefined,
      })
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? `Error ${r.status}`)
      await load(); onChanged()
    } finally { setBusy(false) }
  }

  if (error && !d) return <p className="text-red-700">{error}</p>
  if (!d) return <Spinner className="h-4 w-4 text-teal-600" />
  const s = d.broadcast.status, m = d.metrics

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Estado: {BROADCAST_STATUS_LABELS[s] ?? s}</span>
        {s === 'draft' && (
          <button onClick={() => setLaunchOpen(true)} disabled={!d.broadcast_enabled}
            title={d.broadcast_enabled ? undefined : 'WA_BROADCAST_ENABLED desactivado'}
            className="flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 font-semibold text-white disabled:opacity-40">
            <Send className="h-3 w-3" /> Preparar envío
          </button>
        )}
        {(s === 'queued' || s === 'processing') && (
          <button onClick={() => control('pause')} disabled={busy} className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 font-semibold">
            <Pause className="h-3 w-3" /> Pausar
          </button>
        )}
        {s === 'paused' && (
          <button onClick={() => control('resume')} disabled={busy || !d.broadcast_enabled} className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 font-semibold disabled:opacity-40">
            <Play className="h-3 w-3" /> Reanudar
          </button>
        )}
        {!d.broadcast_enabled && <span className="text-amber-700">Broadcast desactivado — solo lectura</span>}
      </div>
      {d.broadcast.last_error && <p className="text-red-700">Último error: {d.broadcast.last_error}</p>}
      {error && <p className="text-red-700">{error}</p>}

      {m && (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
            <Stat label="Encolados" value={m.queued} />
            <Stat label="Pendientes" value={m.pending + m.processing} />
            <Stat label="Aceptados Meta" value={m.accepted} />
            <Stat label="Entregados" value={m.delivered} />
            <Stat label="Leídos" value={m.read} />
            <Stat label="Fallidos" value={m.failed + m.failed_after_accept} />
            <Stat label="Inciertos" value={m.send_unknown} />
            <Stat label="Omitidos" value={m.skipped} />
            <Stat label="Respondieron" value={m.responded} />
            <Stat label="Quieren confirmar" value={m.responses_by_intent.confirm_interest ?? 0} />
            <Stat label="Sin atender" value={m.responses_unhandled} />
            <Stat label="Confirm. atribuibles" value={m.confirmations_attributable} />
          </div>
          {Object.keys(m.responses_by_intent).length > 0 && (
            <p className="text-gray-600">Respuestas: {Object.entries(m.responses_by_intent).map(([k, n]) => `${BROADCAST_INTENT_LABELS[k] ?? k}: ${n}`).join(' · ')}</p>
          )}
          {m.errors.length > 0 && (
            <details>
              <summary className="cursor-pointer font-semibold text-red-700">Errores ({m.errors.length})</summary>
              <ul className="mt-1 space-y-0.5">
                {m.errors.map(e => (
                  <li key={e.queue_id}>{BROADCAST_QUEUE_STATUS_LABELS[e.status] ?? e.status}{e.meta_error_code ? ` · Meta ${e.meta_error_code}` : ''} · {e.error_message?.slice(0, 140) ?? '—'}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-gray-500">"Aceptados" = Meta recibió el mensaje; la entrega y la lectura se confirman por webhook. Las conversaciones están en el Inbox, marcadas "Campaña · atender".</p>
        </>
      )}

      {launchOpen && (
        <BroadcastLaunchModal broadcastId={broadcastId} onClose={() => setLaunchOpen(false)}
          onLaunched={() => { setLaunchOpen(false); void load(); onChanged() }} />
      )}
    </div>
  )
}
