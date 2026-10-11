'use client'

// Sprint C.2 — asistente único de Broadcast:
//   Grupo → Template → Destinatarios → Revisar → Enviar.
//
// La UI NO decide nada: describe la selección (grupo + template + destinatarios)
// y muestra lo que calcula el servidor. Reutiliza el motor C.1:
//   Destinatarios → POST /api/admin/broadcasts/recipients  (READ ONLY)
//   Revisar       → POST /api/admin/broadcasts             (crea el BORRADOR, con botón explícito)
//                   POST /api/admin/broadcasts/[id]/launch-preview (lote exacto, congelable)
//   Enviar        → POST /api/admin/broadcasts/[id]/launch  (solo con Broadcast activado;
//                   confirmación escrita; repite con la MISMA clave ante 202)
// Nada se crea ni se envía automáticamente.

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, ChevronLeft, ChevronRight, ImageIcon, Search, Send, X } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { useSelection } from '@/components/selection/SelectionProvider'
import { broadcastReasonLabel } from '@/lib/broadcast/labels'
import { REPURCHASE_AUDIENCE_BASE, MAX_SELECTED_IDS, type BroadcastAudienceBase, type BroadcastSelection } from '@/lib/broadcast/selection'
import {
  BROADCAST_TEMPLATES, GROUP_LABELS, REPURCHASE_WINDOWS, campaignGroup, campaignLabel, templateCompatibility,
  type BroadcastCampaign, type BroadcastTemplateName, type RouteFilter,
} from '@/lib/broadcast/campaign'
import { TEMPLATE_DEFINITIONS, renderTemplateBody } from '@/lib/broadcast/templates'
import type { LaunchPreview, LaunchRecipient } from '@/lib/broadcast/launch'

type Step = 1 | 2 | 3 | 4 | 5
const STEPS: Array<{ n: Step; label: string }> = [
  { n: 1, label: 'Grupo' }, { n: 2, label: 'Template' }, { n: 3, label: 'Destinatarios' }, { n: 4, label: 'Revisar' }, { n: 5, label: 'Enviar' },
]
const PAGE_SIZE = 25
const MAX_PREP_ROUNDS = 10

interface RecipientsResponse {
  group: string; template_name: BroadcastTemplateName
  template_ready: boolean; template_missing: string[]; header_image_url: string | null
  candidate_count: number; eligible_count: number
  excluded_by_reason: Record<string, number>; launch_excluded_by_reason: Record<string, number>
  sendable_total: number; items: LaunchRecipient[]; page: number; page_size: number; filtered_total: number; pages: number
  broadcast_enabled: boolean
}
type LaunchPreviewResponse = LaunchPreview & { broadcast_enabled: boolean }

// UUID v4 por apertura del asistente (el servidor exige request_key: UNIQUE en 065).
function newRequestKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Copia del conjunto sin esos ids (los destinatarios se desmarcan, nunca se sustituyen). */
function without(set: Set<string>, ids: string[]): Set<string> {
  const drop = new Set(ids)
  return new Set([...set].filter(x => !drop.has(x)))
}

async function postJson<T>(url: string, body: unknown): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; error: string }> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await r.json().catch(() => ({}))
    return r.ok ? { ok: true, status: r.status, data: data as T } : { ok: false, status: r.status, error: (data as { error?: string }).error ?? `Error ${r.status}` }
  } catch {
    return { ok: false, status: 0, error: 'Error de red' }
  }
}

export function BroadcastWizard({ selection: base, onClose, onCreated }: {
  selection: BroadcastAudienceBase
  onClose: () => void
  onCreated?: () => void
}) {
  const [step, setStep] = useState<Step>(1)
  const [campaign, setCampaign] = useState<BroadcastCampaign>({ type: 'coordination', segment: 'pending' })
  const [template, setTemplate] = useState<BroadcastTemplateName | null>(null)

  // Destinatarios
  const [mode, setMode] = useState<'all' | 'manual'>('all')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [recipients, setRecipients] = useState<RecipientsResponse | null>(null)

  // Borrador + revisión
  const [requestKey] = useState(newRequestKey)
  const [launchKey] = useState(newRequestKey)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ id: string } | null>(null)
  const [limit, setLimit] = useState<number | null>(null)
  const [review, setReview] = useState<LaunchPreviewResponse | null>(null)

  // Envío
  const [typed, setTyped] = useState('')
  const [ack, setAck] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const group = campaignGroup(campaign)
  const audienceBase: BroadcastAudienceBase = campaign.type === 'repurchase' ? REPURCHASE_AUDIENCE_BASE : base
  const groupSelection = useMemo<BroadcastSelection | null>(
    () => (template ? { ...audienceBase, campaign, template } : null),
    [audienceBase, campaign, template],
  )
  // Selección final: todo el grupo o los clientes elegidos (nunca otros).
  const finalSelection = useMemo<BroadcastSelection | null>(() => {
    if (!groupSelection || !template) return null
    if (mode === 'all') return groupSelection
    return { mode: 'selected_ids', order_ids: [...chosen], campaign, template }
  }, [groupSelection, mode, chosen, campaign, template])

  const locked = !!created          // tras crear el borrador, la selección queda fija
  const compatible = BROADCAST_TEMPLATES.filter(t => templateCompatibility(t, campaign).ok)

  // Al cambiar de grupo: el template se re-elige (preselección si solo hay uno compatible).
  useEffect(() => {
    if (locked) return
    setTemplate(compatible.length === 1 ? compatible[0] : null)
    setMode('all'); setChosen(new Set()); setPage(1); setSearch(''); setRecipients(null)
  }, [campaign]) // eslint-disable-line react-hooks/exhaustive-deps

  // Paso 3: destinatarios del grupo para el template (servidor, paginado).
  useEffect(() => {
    if (step !== 3 || !groupSelection) return
    let cancelled = false
    setLoading(true); setError(null)
    void postJson<RecipientsResponse>('/api/admin/broadcasts/recipients', { selection: groupSelection, page, page_size: PAGE_SIZE, search })
      .then(r => {
        if (cancelled) return
        if (r.ok) setRecipients(r.data); else setError(r.error)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [step, groupSelection, page, search])

  // Paso 4: lote exacto del borrador (se recalcula al cambiar el tope).
  useEffect(() => {
    if (step < 4 || !created) return
    let cancelled = false
    setLoading(true); setError(null)
    void postJson<LaunchPreviewResponse>(`/api/admin/broadcasts/${created.id}/launch-preview`, limit ? { send_limit: limit } : {})
      .then(r => {
        if (cancelled) return
        if (!r.ok) { setError(r.error); return }
        setReview(r.data)
        if (limit === null) setLimit(Math.max(1, Math.min(r.data.sendable_count, 300)))
        setTyped(''); setAck(false)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [step, created, limit])

  async function createDraft() {
    if (creating || created) return
    if (!finalSelection) return
    setCreating(true); setError(null)
    const r = await postJson<{ broadcast: { id: string } }>('/api/admin/broadcasts', { selection: finalSelection, request_key: requestKey })
    setCreating(false)
    if (!r.ok) { setError(r.error); return }
    setCreated({ id: r.data.broadcast.id })
    onCreated?.()
  }

  const count = review?.batch.length ?? 0
  const canLaunch = !!review && review.broadcast_enabled && review.template_ready && count > 0
    && ack && typed.trim() === String(count) && !launching && done === null

  async function launch() {
    if (!canLaunch || !created || !limit) return
    setLaunching(true); setError(null); setProgress(null)
    try {
      for (let round = 0; round < MAX_PREP_ROUNDS; round++) {
        const r = await postJson<{ queued?: number; prepared?: number; target?: number }>(`/api/admin/broadcasts/${created.id}/launch`, {
          launch_request_key: launchKey, send_limit: limit, confirm_count: count, acknowledge_real_messages: true,
        })
        if (!r.ok) { setError(r.error); return }
        if (r.status !== 202) { setDone(r.data.queued ?? count); onCreated?.(); return }
        setProgress(`Preparando destinatarios… ${r.data.prepared ?? 0} de ${r.data.target ?? count}`)
      }
      setError('La preparación no terminó — vuelve a pulsar: continúa donde quedó (misma clave)')
    } finally {
      setLaunching(false)
    }
  }

  const canNext =
    step === 1 ? true
    : step === 2 ? !!template && templateCompatibility(template, campaign).ok
    : step === 3 ? !!recipients && (mode === 'all' ? recipients.sendable_total > 0 : chosen.size > 0 && chosen.size <= MAX_SELECTED_IDS)
    : step === 4 ? !!review && count > 0
    : false

  const exclusions = (r: Record<string, number> | undefined) => Object.entries(r ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
         onClick={() => { if (!creating && !launching) onClose() }}>
      <div className="w-full sm:max-w-3xl max-h-[94vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-xl"
           onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Broadcast WhatsApp">
        {/* Header + pasos */}
        <div className="sticky top-0 z-10 border-b border-gray-100 bg-white px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-teal-700">Broadcast WhatsApp</p>
              <h2 className="text-base font-bold text-gray-900">{campaignLabel(campaign)}{template ? ` · ${TEMPLATE_DEFINITIONS[template].label}` : ''}</h2>
            </div>
            <button onClick={onClose} disabled={creating || launching} aria-label="Cerrar"
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 disabled:opacity-40"><X className="h-5 w-5" /></button>
          </div>
          <ol className="mt-2 flex flex-wrap items-center gap-1 text-[11px] font-semibold">
            {STEPS.map(s => (
              <li key={s.n} className={`flex items-center gap-1 rounded-full px-2 py-0.5 ${step === s.n ? 'bg-teal-600 text-white' : step > s.n ? 'bg-teal-50 text-teal-700' : 'bg-gray-100 text-gray-500'}`}>
                {step > s.n ? <Check className="h-3 w-3" /> : <span>{s.n}</span>} {s.label}
              </li>
            ))}
          </ol>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm text-gray-700">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          {/* 1. Grupo */}
          {step === 1 && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">¿A qué clientes va dirigido? La segmentación del servidor decide quién pertenece a cada grupo.</p>
              {([
                { key: 'pending', c: { type: 'coordination', segment: 'pending' } as BroadcastCampaign, hint: 'Pedidos que el cliente nunca confirmó.' },
                { key: 'confirmed_unpaid', c: { type: 'coordination', segment: 'confirmed_unpaid', route: 'all' } as BroadcastCampaign, hint: 'Confirmaron, pero todavía no han pagado.' },
                { key: 'paid', c: { type: 'repurchase', window_days: 30 } as BroadcastCampaign, hint: 'Compraron y pagaron (compra completada). Usa todo el segmento SD.' },
              ] as const).map(o => (
                <button key={o.key} disabled={locked} onClick={() => setCampaign(o.c)}
                  className={`w-full rounded-xl border px-3 py-2.5 text-left disabled:opacity-60 ${group === o.key ? 'border-teal-600 bg-teal-50' : 'border-gray-200 hover:border-teal-400'}`}>
                  <p className="font-semibold text-gray-900">{GROUP_LABELS[o.key]}</p>
                  <p className="text-xs text-gray-500">{o.hint}</p>
                </button>
              ))}
              {campaign.type === 'coordination' && campaign.segment === 'confirmed_unpaid' && (
                <Chips label="Ruta" disabled={locked} options={([['all', 'Todos'], ['not_in_route', 'Sin ruta'], ['in_route', 'Ya en ruta']] as Array<[RouteFilter, string]>)
                  .map(([r, l]) => ({ key: r, label: l, active: (campaign.route ?? 'all') === r, onClick: () => setCampaign({ type: 'coordination', segment: 'confirmed_unpaid', route: r }) }))} />
              )}
              {campaign.type === 'repurchase' && (
                <Chips label="Pagaron hace" disabled={locked} options={REPURCHASE_WINDOWS.map(w => ({
                  key: String(w), label: `${w}+ días`, active: campaign.window_days === w, onClick: () => setCampaign({ type: 'repurchase', window_days: w }),
                }))} />
              )}
            </div>
          )}

          {/* 2. Template */}
          {step === 2 && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">Templates aprobados por Meta. Las combinaciones comercialmente incorrectas para este grupo están bloqueadas.</p>
              {BROADCAST_TEMPLATES.map(t => {
                const def = TEMPLATE_DEFINITIONS[t], compat = templateCompatibility(t, campaign)
                return (
                  <button key={t} disabled={!compat.ok || locked} onClick={() => setTemplate(t)}
                    className={`w-full rounded-xl border px-3 py-2.5 text-left ${!compat.ok ? 'cursor-not-allowed border-gray-100 bg-gray-50 opacity-70'
                      : template === t ? 'border-teal-600 bg-teal-50' : 'border-gray-200 hover:border-teal-400'}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-gray-900">{def.label}</p>
                      <span className="font-mono text-[10px] text-gray-500">Meta: {def.metaName} · {def.language} · imagen + {def.bodyParamCount} variable(s)</span>
                    </div>
                    <p className="text-xs text-gray-600">{def.purpose}</p>
                    <p className="mt-1 text-[11px] text-gray-500">Botones: {def.buttons.join(' · ')}</p>
                    {!compat.ok && <p className="mt-1 text-[11px] font-semibold text-red-600">Bloqueado: {compat.reason}</p>}
                  </button>
                )
              })}
            </div>
          )}

          {/* 3. Destinatarios */}
          {step === 3 && (
            <div className="space-y-3">
              {recipients && (
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="Candidatos del grupo" value={recipients.candidate_count} cls="bg-gray-50 text-gray-800" />
                  <Stat label="Elegibles del grupo" value={recipients.eligible_count} cls="bg-gray-50 text-gray-800" />
                  <Stat label="Enviables con este template" value={recipients.sendable_total} cls="bg-teal-50 text-teal-800" />
                </div>
              )}
              {recipients && !recipients.template_ready && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">Template sin configurar: {recipients.template_missing.join(', ')}. No se podrá enviar hasta configurarlo.</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Chips label="Enviar a" disabled={locked} options={[
                  { key: 'all', label: `Todo el grupo enviable${recipients ? ` (${recipients.sendable_total})` : ''}`, active: mode === 'all', onClick: () => setMode('all') },
                  { key: 'manual', label: `Clientes elegidos (${chosen.size})`, active: mode === 'manual', onClick: () => setMode('manual') },
                ]} />
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-2">
                <Search className="h-4 w-4 text-gray-400" />
                <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder="Buscar por pedido, nombre o teléfono"
                  className="w-full py-2 text-sm outline-none" />
              </div>
              {loading && <div className="flex justify-center py-6"><Spinner className="h-5 w-5 text-teal-600" /></div>}
              {recipients && !loading && (
                <>
                  {mode === 'manual' && recipients.items.length > 0 && (
                    <button disabled={locked} onClick={() => setChosen(prev => {
                      const pageIds = recipients.items.map(i => i.order_id)
                      return pageIds.every(id => prev.has(id)) ? without(prev, pageIds) : new Set([...prev, ...pageIds])
                    })} className="text-xs font-semibold text-teal-700 underline">Marcar / desmarcar esta página</button>
                  )}
                  <ul className="max-h-72 divide-y divide-gray-50 overflow-y-auto rounded-xl border border-gray-100">
                    {recipients.items.map(r => (
                      <li key={r.order_id} className="flex items-center gap-2 px-3 py-1.5">
                        {mode === 'manual' && (
                          <input type="checkbox" disabled={locked} checked={chosen.has(r.order_id)} aria-label={`Elegir ${r.customer_name ?? r.order_id}`}
                            onChange={() => setChosen(prev => (prev.has(r.order_id) ? without(prev, [r.order_id]) : new Set([...prev, r.order_id])))} />
                        )}
                        <span className="flex-1 truncate"><b>{r.order_number ?? '—'}</b> · {r.customer_name ?? 'Cliente'}</span>
                        <span className="shrink-0 text-xs tabular-nums text-gray-500">****{r.phone_normalized.slice(-4)}</span>
                      </li>
                    ))}
                    {recipients.items.length === 0 && <li className="px-3 py-4 text-center text-xs text-gray-500">Sin resultados</li>}
                  </ul>
                  <Pager page={recipients.page} pages={recipients.pages} total={recipients.filtered_total} onPage={setPage} />
                  {mode === 'manual' && chosen.size > MAX_SELECTED_IDS && (
                    <p className="text-xs text-red-600">Máximo {MAX_SELECTED_IDS} clientes por selección manual.</p>
                  )}
                  <Exclusions title="Excluidos del grupo" items={exclusions(recipients.excluded_by_reason)} />
                  <Exclusions title="Excluidos para este template / teléfono" items={exclusions(recipients.launch_excluded_by_reason)} />
                </>
              )}
            </div>
          )}

          {/* 4. Revisar */}
          {step === 4 && (
            <div className="space-y-3">
              {!created ? (
                <div className="rounded-xl border border-gray-100 p-3 space-y-2">
                  <p>Se creará un <b>borrador</b> con: <b>{GROUP_LABELS[group]}</b> · <b>{template ? TEMPLATE_DEFINITIONS[template].label : ''}</b> ·{' '}
                    {mode === 'all' ? 'todo el grupo enviable' : `${chosen.size} cliente(s) elegido(s)`}.</p>
                  <p className="text-xs text-gray-500">Crear el borrador no envía nada. El servidor revalida todo y muestra el lote exacto.</p>
                  <button onClick={createDraft} disabled={loading || creating || !finalSelection}
                    className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
                    {creating ? <Spinner className="h-4 w-4" /> : null} {creating ? 'Creando…' : 'Crear borrador y revisar'}
                  </button>
                </div>
              ) : loading && !review ? (
                <div className="flex justify-center py-6"><Spinner className="h-5 w-5 text-teal-600" /></div>
              ) : review && template && (
                <ReviewPanel review={review} template={template} limit={limit} onLimit={v => setLimit(v)} />
              )}
            </div>
          )}

          {/* 5. Enviar */}
          {step === 5 && review && (
            <div className="space-y-3">
              {done !== null ? (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">
                  <CheckCircle2 className="mt-0.5 h-4 w-4" /> Campaña encolada: {done} destinatario(s). Supervisa, pausa o cancela desde el historial.
                </div>
              ) : !review.broadcast_enabled ? (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
                  Broadcast está desactivado en este entorno. El borrador quedó guardado y puedes revisarlo en el historial; no se puede enviar.
                </p>
              ) : (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 space-y-2">
                  <p className="font-semibold">Se enviarán {count} mensajes REALES de WhatsApp con «{TEMPLATE_DEFINITIONS[template!].label}». No se pueden retirar una vez aceptados por Meta.</p>
                  {!review.template_ready && <p>Template sin configurar: {review.template_missing.join(', ')}</p>}
                  <label className="flex items-center gap-2"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> Entiendo y el equipo puede atender las respuestas.</label>
                  <label className="flex items-center gap-2">Escribe <b>{count}</b> para confirmar:
                    <input value={typed} onChange={e => setTyped(e.target.value)} className="w-20 rounded-md border border-red-300 px-2 py-1" />
                  </label>
                  {progress && <p className="text-teal-800">{progress}</p>}
                  <button onClick={launch} disabled={!canLaunch}
                    className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-40">
                    <Send className="h-4 w-4" /> {launching ? 'Encolando…' : `Enviar a ${count}`}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Navegación */}
        <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-gray-100 bg-white px-5 py-3">
          <button onClick={() => setStep(s => (s > 1 ? (s - 1) as Step : s))} disabled={step === 1 || creating || launching || (locked && step <= 4)}
            className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-100 disabled:opacity-40">
            <ChevronLeft className="h-4 w-4" /> Atrás
          </button>
          {step < 5 ? (
            <button onClick={() => setStep(s => (s + 1) as Step)} disabled={!canNext || loading}
              className="flex items-center gap-1 rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
              Siguiente <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button onClick={onClose} disabled={launching} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700">Cerrar</button>
          )}
        </div>
      </div>
    </div>
  )
}

function ReviewPanel({ review, template, limit, onLimit }: {
  review: LaunchPreviewResponse; template: BroadcastTemplateName; limit: number | null; onLimit: (n: number) => void
}) {
  const def = TEMPLATE_DEFINITIONS[template]
  const [pg, setPg] = useState(1)
  const pages = Math.max(1, Math.ceil(review.batch.length / PAGE_SIZE))
  const sample = review.batch[0]
  const items = review.batch.slice((pg - 1) * PAGE_SIZE, pg * PAGE_SIZE)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Enviables ahora" value={review.sendable_count} cls="bg-gray-50 text-gray-800" />
        <Stat label="En este lote" value={review.batch.length} cls="bg-teal-50 text-teal-800" />
        <Stat label="Quedan para otra fase" value={review.not_in_batch} cls="bg-gray-50 text-gray-800" />
      </div>
      <label className="flex flex-wrap items-center gap-2">
        Tamaño del lote:
        <input type="number" min={1} max={300} value={limit ?? ''} onChange={e => onLimit(Math.max(1, Math.min(300, Number(e.target.value) || 1)))}
          className="w-24 rounded-md border border-gray-300 px-2 py-1" />
        <span className="text-xs text-gray-500">Piloto: 10–20 · máx. 300 por lanzamiento</span>
      </label>
      {review.frozen_count !== null && <p className="text-xs text-gray-500">Lote confirmado congelado: {review.frozen_count} destinatario(s). Nunca se sustituyen.</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-gray-100 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-gray-600"><ImageIcon className="h-3.5 w-3.5" /> Encabezado (imagen)</p>
          {review.header_image_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={review.header_image_url} alt="Imagen del encabezado del template" className="max-h-48 w-full rounded-lg object-contain bg-gray-50" />
            : <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Imagen sin configurar: {review.template_missing.join(', ')}</p>}
          <p className="mt-2 font-mono text-[10px] text-gray-500">Meta: {def.metaName} · {def.language} · template aprobado</p>
        </div>
        <div className="rounded-xl border border-gray-100 p-3">
          <p className="mb-2 text-xs font-semibold text-gray-600">Mensaje (primer destinatario)</p>
          {sample
            ? <div className="whitespace-pre-wrap rounded-lg bg-[#e7f8dc] px-3 py-2 text-sm text-gray-800">{renderTemplateBody(template, sample.body_params)}</div>
            : <p className="text-xs text-gray-500">Sin destinatarios</p>}
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            {def.buttons.map(b => <span key={b} className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-center text-xs font-semibold text-teal-700">{b}</span>)}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-100">
        <p className="border-b border-gray-100 px-3 py-2 text-xs font-semibold text-gray-600">Destinatarios exactos ({review.batch.length}) y variables</p>
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500"><tr>
              <th className="px-2 py-1 text-left">Pedido</th><th className="px-2 py-1 text-left">Teléfono</th>
              {def.variables.map((v, i) => <th key={v} className="px-2 py-1 text-left">{`{{${i + 1}}}`} {v}</th>)}
            </tr></thead>
            <tbody>
              {items.map(r => (
                <tr key={r.order_id} className="border-t border-gray-50">
                  <td className="px-2 py-1 font-semibold">{r.order_number ?? '—'}</td>
                  <td className="px-2 py-1 tabular-nums">****{r.phone_normalized.slice(-4)}</td>
                  {r.body_params.map((p, i) => <td key={i} className="px-2 py-1">{p}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2"><Pager page={pg} pages={pages} total={review.batch.length} onPage={setPg} /></div>
      </div>

      <Exclusions title="Excluidos del grupo" items={Object.entries(review.revalidated.excluded_by_reason).filter(([, n]) => (n ?? 0) > 0) as Array<[string, number]>} />
      <Exclusions title="Excluidos para este template / teléfono" items={Object.entries(review.launch_excluded_by_reason).filter(([, n]) => (n ?? 0) > 0) as Array<[string, number]>} />
      {(review.audience_excluded.length + review.launch_excluded.length) > 0 && (
        <details className="text-xs" open={review.audience_excluded.length > 0 && review.audience_excluded.length <= 20}>
          <summary className="cursor-pointer font-semibold text-gray-700">
            Ver excluidos ({review.audience_excluded.length + review.launch_excluded.length}) — no se sustituyen por otros clientes
          </summary>
          <ul className="mt-1 max-h-40 overflow-y-auto divide-y divide-gray-50">
            {review.audience_excluded.map(x => <li key={`a-${x.order_id}`} className="py-1">{x.order_number ?? '—'} · {x.customer_name ?? '—'} — {broadcastReasonLabel(x.reason)}</li>)}
            {review.launch_excluded.map(x => <li key={`l-${x.order_id}`} className="py-1">{x.order_number ?? '—'} · {x.customer_name ?? '—'} — {broadcastReasonLabel(x.reason)}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}

function Exclusions({ title, items }: { title: string; items: Array<[string, number]> }) {
  if (items.length === 0) return null
  return (
    <div className="rounded-xl border border-gray-100 p-3">
      <p className="mb-1 text-xs font-semibold text-gray-600">{title}</p>
      <ul className="space-y-0.5 text-xs">
        {items.map(([k, n]) => <li key={k}><b className="tabular-nums">{n}</b> — {broadcastReasonLabel(k)}</li>)}
      </ul>
    </div>
  )
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return <p className="text-[11px] text-gray-500">{total} resultado(s)</p>
  return (
    <div className="flex items-center justify-between text-[11px] text-gray-500">
      <span>Página {page} de {pages} · {total} resultado(s)</span>
      <div className="flex gap-1">
        <button onClick={() => onPage(page - 1)} disabled={page <= 1} className="rounded border px-2 py-0.5 disabled:opacity-40">Anterior</button>
        <button onClick={() => onPage(page + 1)} disabled={page >= pages} className="rounded border px-2 py-0.5 disabled:opacity-40">Siguiente</button>
      </div>
    </div>
  )
}

function Chips({ label, options, disabled }: {
  label: string; disabled?: boolean
  options: Array<{ key: string; label: string; active: boolean; onClick: () => void }>
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-24 shrink-0 text-[11px] font-semibold text-gray-500">{label}</span>
      {options.map(o => (
        <button key={o.key} onClick={o.onClick} disabled={disabled}
          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold disabled:opacity-50
            ${o.active ? 'border-teal-600 bg-teal-600 text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-teal-400'}`}>
          {o.label}
        </button>
      ))}
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
