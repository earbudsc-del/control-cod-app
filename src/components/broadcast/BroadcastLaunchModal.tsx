'use client'

// Sprint C.1 — confirmación final antes de encolar envíos REALES.
// Revalida en el servidor (launch-preview) y exige: lote explícito
// (send_limit), escribir la cantidad exacta y marcar la advertencia. La
// clave de lanzamiento es fija por apertura del modal (doble clic / recarga
// → el servidor devuelve el mismo lanzamiento).

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { broadcastReasonLabel } from '@/lib/broadcast/labels'
import type { LaunchPreview } from '@/lib/broadcast/launch'
import { PERSONAL_BUNDLE_PRICE } from '@/lib/broadcast/catalog'
import { formatCodAmount } from '@/lib/broadcast/message-preview'

type Preview = LaunchPreview & { broadcast_enabled: boolean }

export function BroadcastLaunchModal({ broadcastId, onClose, onLaunched }: {
  broadcastId: string; onClose: () => void; onLaunched: () => void
}) {
  const launchKey = useMemo(() => crypto.randomUUID(), [])
  const [limit, setLimit] = useState(10)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [ack, setAck] = useState(false)
  const [launching, setLaunching] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setTyped(''); setAck(false)
    fetch(`/api/admin/broadcasts/${broadcastId}/launch-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ send_limit: limit }),
    }).then(async r => {
      const body = await r.json().catch(() => ({}))
      if (cancelled) return
      if (!r.ok) setError(body.error ?? `Error ${r.status}`)
      else setPreview(body as Preview)
    }).catch(() => { if (!cancelled) setError('Error de red') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [broadcastId, limit])

  const count = preview?.batch.length ?? 0
  const canLaunch = !!preview && preview.broadcast_enabled && preview.template_ready && count > 0
    && ack && typed.trim() === String(count) && !launching

  async function launch() {
    if (!canLaunch) return
    setLaunching(true); setError(null)
    try {
      const r = await fetch(`/api/admin/broadcasts/${broadcastId}/launch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launch_request_key: launchKey, send_limit: limit, confirm_count: count, acknowledge_real_messages: true }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) { setError(body.error ?? `Error ${r.status}`); return }
      onLaunched()
    } catch {
      setError('Error de red — vuelve a pulsar: el lanzamiento es idempotente')
    } finally {
      setLaunching(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={() => { if (!launching) onClose() }}>
      <div className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-xl" onClick={e => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label="Confirmar envío">
        <div className="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-white px-5 py-4">
          <h2 className="text-base font-bold text-gray-900">Confirmar envío de campaña</h2>
          <button onClick={onClose} disabled={launching} aria-label="Cerrar" className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-4 px-5 py-4 text-sm text-gray-700">
          <label className="flex items-center gap-2">
            Tamaño del lote:
            <input type="number" min={1} max={300} value={limit} disabled={launching}
              onChange={e => setLimit(Math.max(1, Math.min(300, Number(e.target.value) || 1)))}
              className="w-24 rounded-md border border-gray-300 px-2 py-1" />
            <span className="text-xs text-gray-500">Piloto: 10–20</span>
          </label>

          {loading && <div className="flex justify-center py-6"><Spinner className="h-5 w-5 text-teal-600" /></div>}
          {error && <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"><AlertTriangle className="h-4 w-4" />{error}</div>}

          {preview && !loading && (
            <>
              <div className="rounded-lg bg-gray-50 px-3 py-2 space-y-0.5">
                <p><b>Campaña:</b> {preview.campaign_label}</p>
                <p><b>Template:</b> <span className="font-mono">{preview.template_name}</span></p>
                <p><b>Oferta:</b> 2 LÜMA Teeth + cepillo antibacterial GRATIS · RD${formatCodAmount(PERSONAL_BUNDLE_PRICE)} · envío gratis · pago contra entrega</p>
                <p><b>Revalidado ahora:</b> {preview.revalidated.eligible_count} elegibles de {preview.revalidated.candidate_count} · {preview.sendable_count} enviables</p>
                <p><b>En este lote:</b> {count}{preview.not_in_batch > 0 ? ` · ${preview.not_in_batch} quedan para una fase posterior` : ''}</p>
                <p className="text-xs text-gray-500">Consumo estimado: {count} conversaciones de marketing iniciadas por la empresa (tarifa según Meta).</p>
              </div>

              {(Object.keys(preview.revalidated.excluded_by_reason).length > 0 || Object.keys(preview.launch_excluded_by_reason).length > 0) && (
                <div>
                  <p className="font-semibold text-gray-900">Excluidos y motivos</p>
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {[...Object.entries(preview.revalidated.excluded_by_reason), ...Object.entries(preview.launch_excluded_by_reason)]
                      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                      .map(([k, n]) => <li key={k}><b className="tabular-nums">{n}</b> — {broadcastReasonLabel(k)}</li>)}
                  </ul>
                </div>
              )}

              {count > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-semibold text-gray-900">Ver los {count} destinatarios</summary>
                  <ul className="mt-1 max-h-40 overflow-y-auto divide-y divide-gray-100">
                    {preview.batch.map(r => <li key={r.order_id} className="py-1">{r.order_number ?? '—'} · {r.customer_name ?? '—'} · ****{r.phone_normalized.slice(-4)}</li>)}
                  </ul>
                </details>
              )}

              {!preview.broadcast_enabled && <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">Broadcast está desactivado (WA_BROADCAST_ENABLED). No se puede lanzar.</p>}
              {!preview.template_ready && <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">Template sin configurar: {preview.template_missing.join(', ')}</p>}

              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 space-y-2">
                <p className="font-semibold">Se enviarán {count} mensajes REALES de WhatsApp a clientes. No se pueden retirar una vez aceptados por Meta.</p>
                <label className="flex items-center gap-2"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> Entiendo y el equipo puede atender las respuestas.</label>
                <label className="flex items-center gap-2">Escribe <b>{count}</b> para confirmar:
                  <input value={typed} onChange={e => setTyped(e.target.value)} className="w-20 rounded-md border border-red-300 px-2 py-1" />
                </label>
              </div>
            </>
          )}
        </div>
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-gray-100 bg-white px-5 py-3">
          <button onClick={onClose} disabled={launching} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700">Cancelar</button>
          <button onClick={launch} disabled={!canLaunch}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-40">
            {launching ? 'Encolando…' : `Enviar a ${count}`}
          </button>
        </div>
      </div>
    </div>
  )
}
