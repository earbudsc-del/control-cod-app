'use client'

// Sprint Broadcast B — modal "Preparar WhatsApp — Confirmación SD".
//
// La UI NO decide elegibilidad: envía la selección (ids o filtros allowlisted)
// a /api/admin/broadcasts/preview y muestra lo que devuelve el servidor.
// "Crear borrador" vuelve a mandar la MISMA selección; el servidor recalcula
// todo. No existe botón "Enviar" en este sprint.

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, MessageCircle, Send, X } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { useSelection } from '@/components/selection/SelectionProvider'
import { broadcastReasonLabel, BROADCAST_WARNING_LABELS } from '@/lib/broadcast/labels'
import type { BroadcastSelection } from '@/lib/broadcast/selection'

interface PreviewEligible {
  order_id: string; order_number: string | null; customer_name: string | null
  phone_normalized: string; warnings: string[]; message_preview: string
}
interface PreviewExcluded {
  order_id: string; order_number: string | null; customer_name: string | null; excluded_reason: string
}
interface PreviewResponse {
  template_name: string
  eligibility_rule_version: string
  candidate_count: number
  eligible_count: number
  excluded_count: number
  excluded_by_reason: Record<string, number>
  eligible: PreviewEligible[]
  excluded: PreviewExcluded[]
  eligible_truncated: boolean
  excluded_truncated: boolean
}

// UUID v4 por apertura del modal. randomUUID requiere contexto seguro; el
// fallback con getRandomValues mantiene la key siempre presente (el servidor
// la exige: UNIQUE (store_id, request_key) en 065).
function newRequestKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function BroadcastPrepareModal({
  selection, onClose, onCreated,
}: {
  selection: BroadcastSelection
  onClose: () => void
  onCreated?: () => void
}) {
  const [preview, setPreview]   = useState<PreviewResponse | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [loading, setLoading]   = useState(true)
  const [listTab, setListTab]   = useState<'eligible' | 'excluded'>('eligible')
  const [sampleIdx, setSampleIdx] = useState(0)
  const [creating, setCreating] = useState(false)
  const [created, setCreated]   = useState<{ id: string; eligible_count: number; replay: boolean } | null>(null)
  // Una key por apertura del modal: un doble click reenvía la misma key y el
  // servidor devuelve el draft ya creado en vez de crear otro.
  const [requestKey] = useState(newRequestKey)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const res  = await fetch('/api/admin/broadcasts/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selection }),
        })
        const body = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) setError(body.error ?? `Error ${res.status}`)
        else setPreview(body as PreviewResponse)
      } catch {
        if (!cancelled) setError('Error de red')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selection])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !creating) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, creating])

  const reasons = useMemo(
    () => Object.entries(preview?.excluded_by_reason ?? {}).sort((a, b) => b[1] - a[1]),
    [preview],
  )
  const warningCount = useMemo(
    () => (preview?.eligible ?? []).filter(e => e.warnings.length > 0).length,
    [preview],
  )
  const sample = preview?.eligible[sampleIdx] ?? preview?.eligible[0] ?? null

  async function createDraft() {
    if (creating || created) return
    setCreating(true); setError(null)
    try {
      const res  = await fetch('/api/admin/broadcasts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selection, request_key: requestKey }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error ?? `Error ${res.status}`); return }
      setCreated({ id: body.broadcast.id, eligible_count: body.broadcast.eligible_count, replay: !!body.replay })
      onCreated?.()
    } catch {
      setError('Error de red')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
         onClick={() => { if (!creating) onClose() }}>
      <div className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-xl"
           onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Preparar WhatsApp">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-gray-100 bg-white px-5 py-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-teal-700">Preparar WhatsApp</p>
            <h2 className="text-base font-bold text-gray-900">Confirmación SD</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Solo crea un borrador. No se envía ningún mensaje en este paso.
            </p>
          </div>
          <button onClick={onClose} disabled={creating} aria-label="Cerrar"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500">
              <Spinner className="h-5 w-5 text-teal-600" /> Revalidando elegibilidad en el servidor…
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          {preview && (
            <>
              {/* Conteos */}
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Candidatos" value={preview.candidate_count} cls="bg-gray-50 text-gray-800" />
                <Stat label="Elegibles ahora" value={preview.eligible_count} cls="bg-teal-50 text-teal-800" />
                <Stat label="Excluidos" value={preview.excluded_count} cls="bg-amber-50 text-amber-800" />
              </div>

              {reasons.length > 0 && (
                <div className="rounded-xl border border-gray-100 p-3">
                  <p className="mb-2 text-xs font-semibold text-gray-600">Motivos de exclusión</p>
                  <ul className="space-y-1">
                    {reasons.map(([reason, n]) => (
                      <li key={reason} className="flex items-baseline gap-2 text-sm">
                        <span className="w-8 text-right font-bold tabular-nums text-gray-800">{n}</span>
                        <span className="text-gray-700">{broadcastReasonLabel(reason)}</span>
                        <span className="text-[10px] text-gray-400 font-mono">{reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {warningCount > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {warningCount} elegible(s) con ubicación recibida que siguen pendientes — normalmente debieron auto-confirmarse. Revisar.
                </div>
              )}

              {/* Preview del mensaje */}
              {sample && (
                <div className="rounded-xl border border-gray-100 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-600">
                      <MessageCircle className="h-3.5 w-3.5 text-green-600" /> Preview del mensaje
                    </p>
                    {preview.eligible.length > 1 && (
                      <select value={sampleIdx} onChange={e => setSampleIdx(Number(e.target.value))}
                        className="max-w-[60%] rounded-md border border-gray-200 px-2 py-1 text-xs">
                        {preview.eligible.map((e, i) => (
                          <option key={e.order_id} value={i}>{e.order_number ?? e.order_id.slice(0, 8)} · {e.customer_name ?? 'Cliente'}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div className="rounded-lg bg-[#e7f8dc] px-3 py-2 text-sm text-gray-800 whitespace-pre-wrap">
                    {sample.message_preview}
                  </div>
                  <p className="mt-1.5 text-[10px] text-gray-400">
                    Copy de preview (template interno <span className="font-mono">{preview.template_name}</span>) — aún no es un template aprobado por Meta.
                  </p>
                </div>
              )}

              {/* Listas */}
              <div className="rounded-xl border border-gray-100">
                <div className="flex border-b border-gray-100 text-xs font-semibold">
                  {(['eligible', 'excluded'] as const).map(t => (
                    <button key={t} onClick={() => setListTab(t)}
                      className={`flex-1 px-3 py-2 ${listTab === t ? 'border-b-2 border-teal-500 text-teal-700' : 'text-gray-500'}`}>
                      {t === 'eligible' ? `Elegibles (${preview.eligible_count})` : `Excluidos (${preview.excluded_count})`}
                    </button>
                  ))}
                </div>
                <ul className="max-h-56 divide-y divide-gray-50 overflow-y-auto text-sm">
                  {listTab === 'eligible' && preview.eligible.map(e => (
                    <li key={e.order_id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span className="truncate"><span className="font-semibold">{e.order_number ?? '—'}</span> · {e.customer_name ?? 'Cliente'}</span>
                      <span className="shrink-0 text-xs text-gray-500 tabular-nums">
                        {e.phone_normalized}
                        {e.warnings.map(w => <span key={w} title={BROADCAST_WARNING_LABELS[w] ?? w} className="ml-1 text-amber-600">⚠</span>)}
                      </span>
                    </li>
                  ))}
                  {listTab === 'excluded' && preview.excluded.map(x => (
                    <li key={x.order_id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span className="truncate"><span className="font-semibold">{x.order_number ?? x.order_id.slice(0, 8)}</span> · {x.customer_name ?? '—'}</span>
                      <span className="shrink-0 text-xs text-amber-700" title={x.excluded_reason}>{broadcastReasonLabel(x.excluded_reason)}</span>
                    </li>
                  ))}
                  {((listTab === 'eligible' && preview.eligible_truncated) || (listTab === 'excluded' && preview.excluded_truncated)) && (
                    <li className="px-3 py-1.5 text-center text-[11px] text-gray-400">Lista truncada — los conteos de arriba son completos</li>
                  )}
                </ul>
              </div>
            </>
          )}

          {created && (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              {created.replay ? 'Este borrador ya estaba creado.' : 'Borrador creado.'} {created.eligible_count} elegibles al momento de prepararlo.
              Antes de cualquier envío se revalidará todo de nuevo.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-gray-100 bg-white px-5 py-3">
          <button onClick={onClose} disabled={creating}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-100 disabled:opacity-40">
            {created ? 'Cerrar' : 'Cancelar'}
          </button>
          {!created && (
            <button onClick={createDraft}
              disabled={loading || creating || !preview || preview.eligible_count === 0}
              className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-40">
              {creating ? <Spinner className="h-4 w-4" /> : null}
              {creating ? 'Creando…' : 'Crear borrador'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={`rounded-xl px-3 py-2 ${cls}`}>
      <p className="text-xl font-bold tabular-nums">{value}</p>
      <p className="text-[11px] font-medium opacity-80">{label}</p>
    </div>
  )
}

// Botón para la barra de acciones masivas: toma los order_id seleccionados.
// Debe montarse dentro de <SelectionProvider>.
export function PrepareWhatsappSelectedButton({ onPrepare }: { onPrepare: (orderIds: string[]) => void }) {
  const { selectedIds } = useSelection()
  return (
    <button
      onClick={() => onPrepare([...selectedIds])}
      className="flex items-center gap-1.5 rounded-lg bg-teal-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-400 whitespace-nowrap">
      <Send className="h-3.5 w-3.5" /> Preparar WhatsApp
    </button>
  )
}
