'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  RotateCcw, Phone, MapPin, ExternalLink,
  Search, X, Filter, ChevronDown, ChevronUp, MessageCircle, FileText,
  CheckCircle, RefreshCw, Bot,
} from 'lucide-react'

// ─── Tipos ─────────────────────────────────────────────────────────────────

interface SupervisorAnalysis {
  resumen: string
  senalesAFavor: string[]
  senalesEnContra: string[]
  razonamiento: string
  recomendacion: string
  checklistEvidencia: string[]
}

interface DevolucionItem {
  id: string
  tracking_number: string | null
  order_number: string | null
  customer_name: string | null
  customer_phone: string | null
  city: string | null
  province: string | null
  raw_status: string | null
  normalized_status: string
  delivery_attempts: number
  last_attempt_reason: string | null
  status_since: string | null
  shopify_created_at: string | null
  created_at: string
  cod_amount?: number
  return_review_status: string | null
  score: number
  signals: string[]
  signalsFor: string[]
  signalsAgainst: string[]
  possibleCompensation: boolean
  compensationReason: string
  compensationPriority: 'low' | 'medium' | 'high' | 'critical'
  confidenceScore: number
  lifecycleRisk: string
  courierFlag: string
  indemnCat: 'excluido' | 'probablemente_no' | 'revisar_manual' | 'posible' | 'probable'
  supervisorAnalysis: SupervisorAnalysis
}

interface Kpis {
  totalDevueltas: number
  devueltasHoy: number
  devueltasAyer: number
  posiblesIndemnizaciones: number
  altaProbabilidad: number
  tresMasIntentos: number
  slaVencido72h: number
  courierSospechoso: number
  reclamadas: number
  pendientesRevisar: number
}

interface ApiResponse {
  data: DevolucionItem[]
  kpis: Kpis
  montoReclamable?: number
  page: number
  limit: number
  generatedAt: string
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('es-DO', {
    timeZone: 'America/Santo_Domingo',
    dateStyle: 'short',
  }).format(new Date(iso))
}

function horasTotales(created: string): number {
  return (Date.now() - new Date(created).getTime()) / 3600000
}

const PRIORITY_STYLE: Record<string, { label: string; cls: string }> = {
  critical: { label: 'Crítica',  cls: 'bg-red-100 text-red-800 border border-red-200' },
  high:     { label: 'Alta',     cls: 'bg-orange-100 text-orange-800 border border-orange-200' },
  medium:   { label: 'Media',    cls: 'bg-yellow-100 text-yellow-800 border border-yellow-200' },
  low:      { label: 'Baja',     cls: 'bg-gray-100 text-gray-700 border border-gray-200' },
}

const INDEMN_CAT_LABEL: Record<string, { label: string; cls: string }> = {
  excluido:        { label: 'Excluida', cls: 'bg-gray-100 text-gray-500' },
  probablemente_no: { label: 'Prob. no indemnizable', cls: 'bg-slate-100 text-slate-600' },
  revisar_manual:  { label: 'Revisar manualmente', cls: 'bg-amber-50 text-amber-700' },
  posible:         { label: 'Posible', cls: 'bg-yellow-100 text-yellow-800' },
  probable:        { label: 'Alta probabilidad', cls: 'bg-orange-100 text-orange-800' },
}

const REVIEW_STATUS_META: Record<string, { label: string; cls: string }> = {
  pendiente_revision:  { label: 'Pendiente',          cls: 'bg-gray-100 text-gray-700' },
  revisado:            { label: 'Revisado',            cls: 'bg-blue-100 text-blue-700' },
  escalado:            { label: 'Escalado',            cls: 'bg-purple-100 text-purple-700' },
  reclamo_preparado:   { label: 'Reclamo listo',      cls: 'bg-amber-100 text-amber-700' },
  reclamado:           { label: 'Reclamado',           cls: 'bg-green-100 text-green-700' },
  descartado:          { label: 'Descartado',          cls: 'bg-gray-100 text-gray-400 line-through' },
  no_indemnizable:     { label: 'No indemnizable',     cls: 'bg-red-50 text-red-600' },
  posible_reclamo:     { label: 'Posible reclamo',     cls: 'bg-yellow-100 text-yellow-700' },
  rechazado_courier:   { label: 'Rechazado courier',   cls: 'bg-red-100 text-red-700' },
  aprobado_courier:    { label: 'Aprobado courier',    cls: 'bg-emerald-100 text-emerald-700' },
}

function formatDOP(v?: number) {
  if (v == null) return null
  return new Intl.NumberFormat('es-DO', { style: 'currency', currency: 'DOP', maximumFractionDigits: 0 }).format(v)
}

// ─── KpiCard ───────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color, onClick, active }: {
  label: string; value: number | string; sub?: string
  color?: string; onClick?: () => void; active?: boolean
}) {
  const base = 'rounded-xl p-4 border cursor-pointer transition-all hover:shadow-md'
  const activeStyle = active ? 'ring-2 ring-offset-1 shadow-md' : ''
  return (
    <div className={`${base} ${color ?? 'bg-white border-gray-200'} ${activeStyle}`} onClick={onClick}>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      <div className="text-sm font-medium text-gray-700 mt-0.5">{label}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  )
}

// ─── NoteModal ─────────────────────────────────────────────────────────────

function NoteModal({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  async function save() {
    if (!note.trim()) return
    setSaving(true)
    await fetch(`/api/devoluciones/${orderId}/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    })
    setSaving(false)
    setDone(true)
    setTimeout(onClose, 800)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-900">Agregar nota interna</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>
        {done ? (
          <div className="flex items-center gap-2 text-green-600 py-2"><CheckCircle className="w-5 h-5" /> Nota guardada</div>
        ) : (
          <>
            <textarea
              className="w-full border border-gray-300 rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400"
              rows={4}
              placeholder="Escribe tu nota aquí..."
              value={note}
              onChange={e => setNote(e.target.value)}
            />
            <div className="flex gap-2 mt-3 justify-end">
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
              <button
                onClick={save}
                disabled={saving || !note.trim()}
                className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── SupervisorModal ───────────────────────────────────────────────────────

function SupervisorModal({ order, onClose }: { order: DevolucionItem; onClose: () => void }) {
  const sa = order.supervisorAnalysis
  const catMeta = INDEMN_CAT_LABEL[order.indemnCat] ?? INDEMN_CAT_LABEL['revisar_manual']
  const priorMeta = PRIORITY_STYLE[order.compensationPriority]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100 sticky top-0 bg-white rounded-t-xl">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-purple-600" />
            <h3 className="font-semibold text-gray-900">Supervisor IA — Análisis del caso</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Resumen */}
          <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 leading-relaxed">
            {sa.resumen}
          </div>

          {/* Confianza + categoría */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-3 py-1 rounded-full font-medium ${priorMeta.cls}`}>
              {order.confidenceScore}% confianza IA
            </span>
            <span className={`text-xs px-3 py-1 rounded-full font-medium ${catMeta.cls}`}>
              {catMeta.label}
            </span>
            <span className="text-xs text-gray-400">{order.delivery_attempts} intento(s)</span>
          </div>

          {/* Señales a favor */}
          {sa.senalesAFavor.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-green-700 mb-2 uppercase tracking-wide">
                Por qué podría indemnizar
              </div>
              <ul className="space-y-1.5">
                {sa.senalesAFavor.map((s, i) => (
                  <li key={i} className="text-xs text-gray-700 flex items-start gap-2">
                    <span className="text-green-500 mt-0.5 shrink-0">✓</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Señales en contra */}
          {sa.senalesEnContra.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-red-700 mb-2 uppercase tracking-wide">
                Por qué podría NO indemnizar
              </div>
              <ul className="space-y-1.5">
                {sa.senalesEnContra.map((s, i) => (
                  <li key={i} className="text-xs text-gray-700 flex items-start gap-2">
                    <span className="text-red-500 mt-0.5 shrink-0">✗</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Razonamiento */}
          <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
            <div className="text-xs font-semibold text-blue-700 mb-1.5">Razonamiento</div>
            <p className="text-xs text-blue-800 leading-relaxed">{sa.razonamiento}</p>
          </div>

          {/* Recomendación */}
          <div className="bg-amber-50 rounded-lg p-3 border border-amber-100">
            <div className="text-xs font-semibold text-amber-700 mb-1">Recomendación final</div>
            <p className="text-xs text-amber-800 font-medium">{sa.recomendacion}</p>
          </div>

          {/* Checklist */}
          <div>
            <div className="text-xs font-semibold text-gray-600 mb-2 uppercase tracking-wide">
              Evidencia pendiente de revisar
            </div>
            <ul className="space-y-2">
              {sa.checklistEvidencia.map((item, i) => (
                <li key={i} className="text-xs text-gray-600 flex items-start gap-2">
                  <span className="text-gray-300 mt-0.5 shrink-0 text-base leading-none">☐</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="px-5 pb-5 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Página principal ──────────────────────────────────────────────────────

const TABS = [
  { key: 'todas',              label: 'Todas' },
  { key: '2-intentos',         label: '2 intentos' },
  { key: '3mas-intentos',      label: '3+ intentos' },
  { key: 'posible-indemnizacion', label: 'Posible indem.' },
  { key: 'alta-indemnizacion', label: 'Alta prob. indem.' },
  { key: 'devueltas-hoy',      label: 'Hoy' },
  { key: 'devueltas-ayer',     label: 'Ayer' },
  { key: 'courier-sospechoso', label: 'Courier sospechoso' },
  { key: 'sla-vencido',        label: 'SLA vencido +72h' },
  { key: 'reclamadas',         label: 'Reclamadas' },
]

export default function DevolucionesPage() {
  const searchParams = useSearchParams()
  const initialFilter = searchParams.get('filter') ?? 'todas'

  const [data, setData]               = useState<DevolucionItem[]>([])
  const [kpis, setKpis]               = useState<Kpis | null>(null)
  const [montoReclamable, setMonto]   = useState<number | null>(null)
  const [loading, setLoading]         = useState(true)
  const [page, setPage]               = useState(1)
  const [activeTab, setActiveTab]     = useState(initialFilter)
  const [search, setSearch]           = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [noteTarget, setNoteTarget]   = useState<string | null>(null)
  const [supervisorTarget, setSupervisorTarget] = useState<DevolucionItem | null>(null)

  // Filtros adicionales
  const [cityFilter, setCity]       = useState('')
  const [provFilter, setProv]       = useState('')
  const [dateFrom, setDateFrom]     = useState('')
  const [dateTo, setDateTo]         = useState('')
  const [intentosFilt, setIntentos] = useState('')

  // Estados de acción locales
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({})
  const [actionBusy, setActionBusy]     = useState<Record<string, boolean>>({})

  const fetchData = useCallback(async (pg = 1) => {
    setLoading(true)
    try {
      const sp = new URLSearchParams({
        page: String(pg),
        filter: activeTab,
        ...(search      && { search }),
        ...(cityFilter  && { city: cityFilter }),
        ...(provFilter  && { province: provFilter }),
        ...(dateFrom    && { from: dateFrom }),
        ...(dateTo      && { to: dateTo }),
        ...(intentosFilt && { intentos: intentosFilt }),
      })
      const res = await fetch(`/api/devoluciones?${sp}`)
      if (!res.ok) return
      const json: ApiResponse = await res.json()
      setData(json.data)
      setKpis(json.kpis)
      setMonto(json.montoReclamable ?? null)
      setPage(json.page)
    } finally {
      setLoading(false)
    }
  }, [activeTab, search, cityFilter, provFilter, dateFrom, dateTo, intentosFilt])

  useEffect(() => { fetchData(1) }, [fetchData])

  async function changeStatus(orderId: string, status: string) {
    setActionBusy(b => ({ ...b, [orderId]: true }))
    const res = await fetch(`/api/devoluciones/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setActionBusy(b => ({ ...b, [orderId]: false }))
    if (res.ok) setActionStatus(s => ({ ...s, [orderId]: status }))
  }

  function getReviewStatus(order: DevolucionItem): string {
    return actionStatus[order.id] ?? order.return_review_status ?? 'pendiente_revision'
  }

  // ── Render indemnización cell ──────────────────────────────────────────

  function IndemnCell({ order }: { order: DevolucionItem }) {
    const catMeta = INDEMN_CAT_LABEL[order.indemnCat] ?? INDEMN_CAT_LABEL['revisar_manual']
    const priorMeta = PRIORITY_STYLE[order.compensationPriority]

    if (order.indemnCat === 'excluido') {
      return (
        <div>
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">
            Excluida
          </span>
          <div className="text-xs text-gray-400 mt-0.5 truncate max-w-[150px]" title={order.compensationReason}>
            {order.compensationReason}
          </div>
        </div>
      )
    }

    if (!order.possibleCompensation) {
      return (
        <div>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${catMeta.cls}`}>
            {catMeta.label}
          </span>
          {order.signalsAgainst.length > 0 && (
            <div className="text-xs text-gray-400 mt-0.5 truncate max-w-[150px]" title={order.signalsAgainst[0]}>
              {order.signalsAgainst[0]}
            </div>
          )}
        </div>
      )
    }

    return (
      <div>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${priorMeta.cls}`}>
          {catMeta.label} · {order.confidenceScore}%
        </span>
        <div className="text-xs text-gray-500 mt-0.5 truncate max-w-[150px]" title={order.compensationReason}>
          {order.compensationReason}
        </div>
        {order.cod_amount != null && (
          <div className="text-xs font-medium text-emerald-700 mt-0.5">
            {formatDOP(order.cod_amount)}
            <span className="text-gray-400 font-normal ml-1">(ref.)</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5 pt-14 md:pt-0 px-4 py-4 md:p-6 max-w-screen-xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <RotateCcw className="w-5 h-5 text-red-500" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">Devoluciones</h1>
            <p className="text-xs text-gray-500">Análisis operativo · Indemnizaciones · Seguimiento</p>
          </div>
        </div>
        <button
          onClick={() => fetchData(page)}
          className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Actualizar
        </button>
      </div>

      {/* KPI Cards */}
      {kpis && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <KpiCard label="Devueltas hoy"      value={kpis.devueltasHoy}            color="bg-white border-gray-200"       onClick={() => { setActiveTab('devueltas-hoy'); fetchData(1) }}        active={activeTab === 'devueltas-hoy'} />
          <KpiCard label="Devueltas ayer"     value={kpis.devueltasAyer}           color="bg-white border-gray-200"       onClick={() => { setActiveTab('devueltas-ayer'); fetchData(1) }}       active={activeTab === 'devueltas-ayer'} />
          <KpiCard label="Posible indem."     value={kpis.posiblesIndemnizaciones} color="bg-amber-50 border-amber-200"   onClick={() => { setActiveTab('posible-indemnizacion'); fetchData(1) }} active={activeTab === 'posible-indemnizacion'} />
          <KpiCard label="Alta prob. indem."  value={kpis.altaProbabilidad}        color="bg-red-50 border-red-200"       onClick={() => { setActiveTab('alta-indemnizacion'); fetchData(1) }}   active={activeTab === 'alta-indemnizacion'} />
          <KpiCard label="3+ intentos"        value={kpis.tresMasIntentos}         color="bg-orange-50 border-orange-200" onClick={() => { setActiveTab('3mas-intentos'); fetchData(1) }}        active={activeTab === '3mas-intentos'} />
          <KpiCard label="SLA vencido +72h"   value={kpis.slaVencido72h}           color="bg-white border-gray-200"       onClick={() => { setActiveTab('sla-vencido'); fetchData(1) }}          active={activeTab === 'sla-vencido'} />
          <KpiCard label="Courier sospechoso" value={kpis.courierSospechoso}       color="bg-purple-50 border-purple-200" onClick={() => { setActiveTab('courier-sospechoso'); fetchData(1) }}   active={activeTab === 'courier-sospechoso'} />
          <KpiCard label="Reclamadas"         value={kpis.reclamadas}              color="bg-green-50 border-green-200"   onClick={() => { setActiveTab('reclamadas'); fetchData(1) }}            active={activeTab === 'reclamadas'} />
          <KpiCard label="Pend. revisar"      value={kpis.pendientesRevisar}       color="bg-gray-50 border-gray-200" />
          {montoReclamable != null && (
            <KpiCard
              label="Monto potencial"
              value={formatDOP(montoReclamable) ?? '—'}
              sub="Alta prob. · referencia estimada"
              color="bg-emerald-50 border-emerald-200"
            />
          )}
        </div>
      )}

      {/* Disclaimer monto potencial */}
      {montoReclamable != null && montoReclamable > 0 && (
        <p className="text-xs text-gray-400 -mt-2">
          * El monto potencial es referencia operativa — no garantiza aprobación del reclamo por parte del courier.
        </p>
      )}

      {/* Tabs */}
      <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
        <div className="flex gap-1 min-w-max border-b border-gray-200 pb-0">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => { setActiveTab(t.key); setPage(1); fetchData(1) }}
              className={`px-3 py-2 text-xs font-medium rounded-t-lg whitespace-nowrap transition-colors
                ${activeTab === t.key
                  ? 'bg-red-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Buscador + filtros */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar por guía, orden, cliente o teléfono..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-8 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-400"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowFilters(f => !f)}
            className="flex items-center gap-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg px-3 py-2 hover:bg-gray-50"
          >
            <Filter className="w-4 h-4" />
            Filtros
            {showFilters ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>

        {showFilters && (
          <div className="bg-gray-50 rounded-xl p-4 grid grid-cols-2 md:grid-cols-4 gap-3 border border-gray-200">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Ciudad</label>
              <input value={cityFilter} onChange={e => setCity(e.target.value)} placeholder="Santo Domingo..." className="w-full text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Provincia</label>
              <input value={provFilter} onChange={e => setProv(e.target.value)} placeholder="DN..." className="w-full text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Desde</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Hasta</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Intentos</label>
              <select value={intentosFilt} onChange={e => setIntentos(e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none">
                <option value="">Todos</option>
                <option value="2">2 intentos</option>
                <option value="3">3+ intentos</option>
              </select>
            </div>
            <div className="flex items-end">
              <button
                onClick={() => { setCity(''); setProv(''); setDateFrom(''); setDateTo(''); setIntentos('') }}
                className="text-xs text-gray-500 hover:text-red-600 underline"
              >
                Limpiar filtros
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Contenido */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Cargando devoluciones...
        </div>
      ) : data.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <RotateCcw className="w-8 h-8 mx-auto mb-2 text-gray-300" />
          <p className="font-medium">Sin devoluciones en este filtro</p>
          <p className="text-sm mt-1">Prueba cambiando el tab o los filtros</p>
        </div>
      ) : (
        <>
          {/* Tabla desktop */}
          <div className="hidden md:block overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Guía / Orden', 'Cliente', 'Ciudad', 'Motivo', 'Intentos', 'Días', 'Análisis IA', 'Estado revisión', 'Acciones'].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.map(order => {
                  const reviewStatus = getReviewStatus(order)
                  const busy = actionBusy[order.id] ?? false
                  const dias = Math.floor(horasTotales(order.created_at) / 24)
                  const revMeta = REVIEW_STATUS_META[reviewStatus] ?? REVIEW_STATUS_META['pendiente_revision']

                  return (
                    <tr
                      key={order.id}
                      className={`hover:bg-gray-50 transition-colors ${reviewStatus === 'descartado' ? 'opacity-50' : ''}`}
                    >
                      {/* Guía */}
                      <td className="px-3 py-2.5">
                        <div className="font-mono text-xs text-gray-800 truncate max-w-[120px]" title={order.tracking_number ?? ''}>
                          {order.tracking_number ?? '—'}
                        </div>
                        <div className="text-xs text-gray-400">{order.order_number ?? '—'}</div>
                      </td>
                      {/* Cliente */}
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-gray-800 truncate max-w-[130px]">{order.customer_name ?? '—'}</div>
                        <div className="text-xs text-gray-400">{order.customer_phone ?? '—'}</div>
                      </td>
                      {/* Ciudad */}
                      <td className="px-3 py-2.5 text-xs text-gray-600">
                        {order.city ?? order.province ?? '—'}
                      </td>
                      {/* Motivo */}
                      <td className="px-3 py-2.5">
                        <div className="text-xs text-gray-600 truncate max-w-[120px]" title={order.last_attempt_reason ?? ''}>
                          {order.raw_status ?? '—'}
                        </div>
                        {order.last_attempt_reason && (
                          <div className="text-xs text-gray-400 truncate max-w-[120px]" title={order.last_attempt_reason}>
                            {order.last_attempt_reason}
                          </div>
                        )}
                      </td>
                      {/* Intentos */}
                      <td className="px-3 py-2.5 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${
                          order.delivery_attempts === 0 ? 'bg-gray-100 text-gray-500' :
                          order.delivery_attempts <= 2  ? 'bg-yellow-100 text-yellow-700' :
                          order.delivery_attempts === 3 ? 'bg-orange-100 text-orange-700' :
                          'bg-red-100 text-red-700'
                        }`}>
                          {order.delivery_attempts}
                        </span>
                      </td>
                      {/* Días */}
                      <td className="px-3 py-2.5 text-xs text-gray-600 text-center">
                        <span className={dias > 14 ? 'text-red-600 font-medium' : dias > 7 ? 'text-amber-600' : ''}>
                          {dias}d
                        </span>
                      </td>
                      {/* Análisis IA */}
                      <td className="px-3 py-2.5">
                        <IndemnCell order={order} />
                      </td>
                      {/* Estado revisión */}
                      <td className="px-3 py-2.5">
                        <select
                          value={reviewStatus}
                          onChange={e => changeStatus(order.id, e.target.value)}
                          disabled={busy}
                          className={`text-xs rounded-lg px-2 py-1 border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-400 ${revMeta.cls}`}
                        >
                          {Object.entries(REVIEW_STATUS_META).map(([k, v]) => (
                            <option key={k} value={k}>{v.label}</option>
                          ))}
                        </select>
                      </td>
                      {/* Acciones */}
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Link
                            href={`/orders/${order.id}`}
                            className="text-xs text-indigo-600 hover:underline flex items-center gap-0.5"
                          >
                            Ver <ExternalLink className="w-3 h-3" />
                          </Link>
                          {order.customer_phone && (
                            <a
                              href={`https://wa.me/1${order.customer_phone.replace(/\D/g, '')}?text=Hola%20${encodeURIComponent(order.customer_name ?? '')},%20le%20contactamos%20sobre%20su%20pedido%20${encodeURIComponent(order.order_number ?? '')}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-green-600 hover:underline flex items-center gap-0.5"
                            >
                              <MessageCircle className="w-3 h-3" /> WA
                            </a>
                          )}
                          <button
                            onClick={() => setNoteTarget(order.id)}
                            className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-0.5"
                          >
                            <FileText className="w-3 h-3" /> Nota
                          </button>
                          <button
                            onClick={() => setSupervisorTarget(order)}
                            className="text-xs text-purple-600 hover:text-purple-800 flex items-center gap-0.5 whitespace-nowrap"
                          >
                            <Bot className="w-3 h-3" /> Supervisor IA
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Cards mobile */}
          <div className="md:hidden space-y-3">
            {data.map(order => {
              const reviewStatus = getReviewStatus(order)
              const busy = actionBusy[order.id] ?? false
              const dias = Math.floor(horasTotales(order.created_at) / 24)
              const catMeta = INDEMN_CAT_LABEL[order.indemnCat] ?? INDEMN_CAT_LABEL['revisar_manual']
              const priorMeta = PRIORITY_STYLE[order.compensationPriority]
              const revMeta = REVIEW_STATUS_META[reviewStatus] ?? REVIEW_STATUS_META['pendiente_revision']

              return (
                <div
                  key={order.id}
                  className={`bg-white rounded-xl border border-gray-200 p-4 shadow-sm ${reviewStatus === 'descartado' ? 'opacity-50' : ''}`}
                >
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <div className="font-mono text-xs text-gray-600">{order.tracking_number ?? '—'}</div>
                      <div className="font-semibold text-gray-900">{order.customer_name ?? '—'}</div>
                    </div>
                    <div className="text-right">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                        order.delivery_attempts === 0 ? 'bg-gray-100 text-gray-500' :
                        order.delivery_attempts <= 2  ? 'bg-yellow-100 text-yellow-700' :
                        order.delivery_attempts === 3 ? 'bg-orange-100 text-orange-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {order.delivery_attempts} int.
                      </span>
                      <div className="text-xs text-gray-400 mt-0.5">{dias}d · {formatDate(order.created_at)}</div>
                    </div>
                  </div>

                  {/* Info */}
                  <div className="text-xs text-gray-600 space-y-0.5 mb-2">
                    <div className="flex items-center gap-1"><Phone className="w-3 h-3" /> {order.customer_phone ?? '—'}</div>
                    <div className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {order.city ?? order.province ?? '—'}</div>
                    {order.raw_status && <div className="text-gray-400 truncate">EFI: {order.raw_status}</div>}
                    {order.last_attempt_reason && <div className="text-gray-400 truncate">Motivo: {order.last_attempt_reason}</div>}
                  </div>

                  {/* Análisis IA */}
                  <div className={`text-xs rounded-lg px-2 py-1.5 mb-2 ${
                    order.indemnCat === 'excluido' ? 'bg-gray-50 border border-gray-200' :
                    order.possibleCompensation ? priorMeta.cls : catMeta.cls
                  }`}>
                    <div className="font-medium">
                      {order.indemnCat === 'excluido' ? 'Excluida' :
                       order.possibleCompensation ? `${catMeta.label} · ${order.confidenceScore}%` :
                       catMeta.label}
                    </div>
                    <div className="mt-0.5 text-gray-600">{order.compensationReason}</div>
                    {order.cod_amount != null && order.possibleCompensation && (
                      <div className="font-bold text-emerald-700 mt-0.5">
                        {formatDOP(order.cod_amount)}
                        <span className="text-xs font-normal text-gray-500 ml-1">(ref. estimada)</span>
                      </div>
                    )}
                  </div>

                  {/* Estado revisión */}
                  <div className="mb-3">
                    <select
                      value={reviewStatus}
                      onChange={e => changeStatus(order.id, e.target.value)}
                      disabled={busy}
                      className={`text-xs rounded-lg px-2 py-1.5 w-full border-0 cursor-pointer focus:outline-none ${revMeta.cls}`}
                    >
                      {Object.entries(REVIEW_STATUS_META).map(([k, v]) => (
                        <option key={k} value={k}>{v.label}</option>
                      ))}
                    </select>
                  </div>

                  {/* Acciones */}
                  <div className="flex gap-2 flex-wrap">
                    <Link
                      href={`/orders/${order.id}`}
                      className="flex-1 text-center text-xs bg-indigo-50 text-indigo-700 rounded-lg py-2 hover:bg-indigo-100"
                    >
                      Ver pedido
                    </Link>
                    {order.customer_phone && (
                      <a
                        href={`https://wa.me/1${order.customer_phone.replace(/\D/g, '')}?text=Hola%20${encodeURIComponent(order.customer_name ?? '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-center text-xs bg-green-50 text-green-700 rounded-lg py-2 hover:bg-green-100"
                      >
                        WhatsApp
                      </a>
                    )}
                    <button
                      onClick={() => setNoteTarget(order.id)}
                      className="text-xs bg-gray-50 text-gray-600 rounded-lg px-3 py-2 hover:bg-gray-100"
                    >
                      <FileText className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setSupervisorTarget(order)}
                      className="text-xs bg-purple-50 text-purple-700 rounded-lg px-3 py-2 hover:bg-purple-100 flex items-center gap-1"
                    >
                      <Bot className="w-3.5 h-3.5" /> IA
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Paginación */}
          <div className="flex items-center justify-between mt-3">
            <button
              onClick={() => { const np = Math.max(1, page - 1); setPage(np); fetchData(np) }}
              disabled={page <= 1 || loading}
              className="text-sm text-gray-600 border border-gray-300 rounded-lg px-4 py-1.5 hover:bg-gray-50 disabled:opacity-40"
            >
              ← Anterior
            </button>
            <span className="text-sm text-gray-500">Página {page}</span>
            <button
              onClick={() => { const np = page + 1; setPage(np); fetchData(np) }}
              disabled={data.length < 50 || loading}
              className="text-sm text-gray-600 border border-gray-300 rounded-lg px-4 py-1.5 hover:bg-gray-50 disabled:opacity-40"
            >
              Siguiente →
            </button>
          </div>
        </>
      )}

      {/* Modales */}
      {noteTarget && (
        <NoteModal orderId={noteTarget} onClose={() => setNoteTarget(null)} />
      )}
      {supervisorTarget && (
        <SupervisorModal order={supervisorTarget} onClose={() => setSupervisorTarget(null)} />
      )}
    </div>
  )
}
