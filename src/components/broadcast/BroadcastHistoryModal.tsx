'use client'

// Sprint Broadcast B — historial mínimo de broadcasts (solo lectura).
// Sin acciones de envío/proceso/reintento en este sprint.

import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { broadcastReasonLabel, BROADCAST_STATUS_LABELS } from '@/lib/broadcast/labels'
import { DEFAULT_CAMPAIGN, campaignLabel, type BroadcastCampaign } from '@/lib/broadcast/campaign'

interface BroadcastRow {
  id: string
  template_name: string
  status: string
  created_at: string
  candidate_count: number
  eligible_count: number
  excluded_count: number
  excluded_by_reason: Record<string, number>
  selection_filter: { mode?: string; order_ids?: string[]; filters?: Record<string, unknown>; campaign?: unknown; resolved_at?: string }
  eligibility_rule_version: string
  creator: { full_name: string | null } | null
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('es-DO', {
    timeZone: 'America/Santo_Domingo', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit',
  })
}

function selectionSummary(sf: BroadcastRow['selection_filter']): string {
  // Drafts B/B.1 no tienen campaign → coordinación/pendientes.
  const camp = campaignLabel((sf.campaign as BroadcastCampaign | undefined) ?? DEFAULT_CAMPAIGN)
  return `${camp} — ${audienceSummary(sf)}`
}

function audienceSummary(sf: BroadcastRow['selection_filter']): string {
  if (sf.mode === 'selected_ids') return `Selección manual · ${sf.order_ids?.length ?? 0} pedidos`
  if (sf.mode === 'filtered') {
    const f = sf.filters ?? {}
    const parts = [
      f.status ? `estado=${String(f.status)}` : 'estado=todos',
      f.payment && f.payment !== 'todos' ? `pago=${String(f.payment)}` : null,
      f.date_from || f.date_to ? 'con rango de fecha' : null,
      f.search ? `búsqueda="${String(f.search)}"` : null,
    ].filter(Boolean)
    return `Todos los resultados del filtro SD · ${parts.join(' · ')}`
  }
  return '—'
}

export function BroadcastHistoryModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows]       = useState<BroadcastRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [openId, setOpenId]   = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res  = await fetch('/api/admin/broadcasts')
        const body = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) setError(body.error ?? `Error ${res.status}`)
        else setRows(body.data ?? [])
      } catch {
        if (!cancelled) setError('Error de red')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-3xl max-h-[90vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-xl"
           onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Historial WhatsApp">
        <div className="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-white px-5 py-4">
          <h2 className="text-base font-bold text-gray-900">Historial WhatsApp — Broadcasts</h2>
          <button onClick={onClose} aria-label="Cerrar" className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-4">
          {loading && <div className="flex justify-center py-10"><Spinner className="h-5 w-5 text-teal-600" /></div>}
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4" /> {error}
            </div>
          )}
          {!loading && !error && rows.length === 0 && (
            <p className="py-10 text-center text-sm text-gray-500">Todavía no hay broadcasts.</p>
          )}

          {rows.length > 0 && (
            <ul className="divide-y divide-gray-100">
              {rows.map(r => (
                <li key={r.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="text-gray-500 tabular-nums">{fmt(r.created_at)}</span>
                    <span className="font-semibold text-gray-800">{r.creator?.full_name ?? '—'}</span>
                    <span className="font-mono text-[11px] text-gray-500">{r.template_name}</span>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-700">
                      {BROADCAST_STATUS_LABELS[r.status] ?? r.status}
                    </span>
                    <span className="text-xs text-gray-600 tabular-nums">
                      {r.candidate_count} cand. · <b className="text-teal-700">{r.eligible_count} eleg.</b> · {r.excluded_count} excl.
                    </span>
                    <button onClick={() => setOpenId(openId === r.id ? null : r.id)}
                      className="ml-auto rounded-md border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50">
                      {openId === r.id ? 'Ocultar' : 'Ver'}
                    </button>
                  </div>
                  {openId === r.id && (
                    <div className="mt-2 space-y-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700">
                      <p>{selectionSummary(r.selection_filter)}</p>
                      {r.selection_filter.resolved_at && (
                        <p>
                          Audiencia congelada: {r.selection_filter.mode === 'filtered'
                            ? `solo pedidos existentes al ${fmt(r.selection_filter.resolved_at)}`
                            : 'solo los pedidos seleccionados'} — revalidar puede reducirla, nunca ampliarla.
                        </p>
                      )}
                      <p>Regla: <span className="font-mono">{r.eligibility_rule_version}</span></p>
                      {Object.keys(r.excluded_by_reason ?? {}).length > 0 && (
                        <ul className="space-y-0.5">
                          {Object.entries(r.excluded_by_reason).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
                            <li key={k}><b className="tabular-nums">{n}</b> — {broadcastReasonLabel(k)}</li>
                          ))}
                        </ul>
                      )}
                      <p className="text-gray-500">
                        Conteos al momento de preparar el borrador. Antes de cualquier envío la audiencia se revalida completa.
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
