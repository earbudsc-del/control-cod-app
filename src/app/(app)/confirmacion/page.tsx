'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { whatsAppUrl, callUrl, formatCurrency } from '@/lib/utils'
import { type Order, STATUS_LABELS, STATUS_COLORS } from '@/types'
import {
  ClipboardList, RefreshCw, MessageCircle, Phone,
  CheckCircle2, PhoneMissed, XCircle, ExternalLink,
  MapPin, RotateCcw, Clock, Inbox, TrendingUp,
  AlertTriangle, MapPinOff, ChevronLeft, ChevronRight, Search,
  Truck, PackageCheck,
} from 'lucide-react'
import { AlertBadges } from '@/components/shared/alert-badges'
import { checkCoverage } from '@/lib/alert-helpers'

const MAX_ATTEMPTS = 3
const MS_48H       = 48 * 60 * 60 * 1000
const PAGE_SIZE    = 50

type Tab = 'all' | 'nuevos' | 'reintentar' | 'atrasados'
         | 'confirmados_sin_guia' | 'despachados'
         | 'duplicados' | 'cobertura' | 'zona_desconocida'

type ContactMethod = 'call' | 'whatsapp' | 'other'

interface ConfirmStats {
  nuevos:             number
  reintentar:         number
  atrasados:          number
  confirmadosHoy:     number
  contactadosHoy:     number
  sinRespuesta:       number
  inalcanzables:      number
  noDesean:           number
  sinCobertura:       number
  confirmadosSinGuia: number
  despachados:        number
}

interface ConfirmResult {
  confirmation_attempts:   number
  confirmation_status:     string
  confirmation_confidence: string
}

interface AgentPerf {
  confirmadosHoy:        number
  contactadosHoy:        number
  noRespondieronHoy:     number
  canceladosHoy:         number
  numerosIncorrectosHoy: number
  sinCoberturaHoy:       number
  tasaConfirmacionHoy:   number | null
}

interface ApiResponse {
  data:               Order[]
  pendientes:         Order[]
  confirmadosSinGuia: Order[]
  despachados:        Order[]
  total:              number
}

// ── UI maps ──────────────────────────────────────────────────────────────────

const CONFIDENCE: Record<string, { label: string; cls: string }> = {
  high:   { label: 'Seguro',  cls: 'bg-green-100 text-green-700 border border-green-200' },
  medium: { label: 'Medio',   cls: 'bg-yellow-100 text-yellow-700 border border-yellow-200' },
  low:    { label: 'Bajo',    cls: 'bg-orange-100 text-orange-700 border border-orange-200' },
  risky:  { label: 'Riesgo',  cls: 'bg-red-100 text-red-700 border border-red-200' },
}

const CONF_STATUS: Record<string, { label: string; cls: string }> = {
  pending:     { label: 'Pendiente',     cls: 'bg-gray-100 text-gray-500' },
  confirmed:   { label: 'Confirmado',    cls: 'bg-green-100 text-green-700' },
  unreachable: { label: 'Inalcanzable',  cls: 'bg-red-100 text-red-700' },
  cancelled:   { label: 'Canceló',       cls: 'bg-gray-200 text-gray-700' },
  no_coverage: { label: 'Sin cobertura', cls: 'bg-orange-100 text-orange-700' },
}

const TERMINAL: Record<string, { label: string; color: string }> = {
  confirmed:    { label: 'Confirmado',     color: 'bg-green-100 text-green-700'   },
  wrong_number: { label: 'Nro incorrecto', color: 'bg-red-100 text-red-700'       },
  cancelled:    { label: 'Canceló',        color: 'bg-gray-100 text-gray-600'     },
  unreachable:  { label: 'Inalcanzable',   color: 'bg-red-100 text-red-700'       },
  no_coverage:  { label: 'Sin cobertura',  color: 'bg-orange-100 text-orange-700' },
}

const TAB_META: { tab: Tab; label: string }[] = [
  { tab: 'all',                  label: 'Todos'          },
  { tab: 'nuevos',               label: 'Nuevos'         },
  { tab: 'reintentar',           label: 'Reintentar'     },
  { tab: 'atrasados',            label: 'Atrasados +48h' },
  { tab: 'confirmados_sin_guia', label: '✓ Sin guía'     },
  { tab: 'despachados',          label: '🚚 Despachados' },
  { tab: 'duplicados',           label: '⚠️ Duplicados'  },
  { tab: 'cobertura',            label: '🚫 Cobertura'   },
  { tab: 'zona_desconocida',     label: '🟡 Zona desc.'  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatOrderTime(iso: string): string {
  const date = new Date(iso)
  const now  = new Date()
  const time = date.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', hour12: true })
  const today     = new Date(now.getFullYear(),  now.getMonth(),  now.getDate())
  const yesterday = new Date(today.getTime() - 86_400_000)
  const day       = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  if (day.getTime() === today.getTime())     return `Hoy ${time}`
  if (day.getTime() === yesterday.getTime()) return `Ayer ${time}`
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')} ${time}`
}

function buildConfirmMsg(nombre: string, producto: string | null | undefined, monto: number | null | undefined): string {
  const n = nombre.trim() || 'cliente'
  const p = (producto ?? '').trim().slice(0, 30) || 'tu pedido'
  const m = monto ? ` Monto a cancelar: RD$${monto.toLocaleString('es-DO')}.` : ''
  return [
    `Hola ${n} 😊,`,
    '',
    `Tu pedido de ${p} 📦 está próximo a ser entregado.`,
    '',
    `Por favor confirmanos si podrás recibirlo.${m}`,
    '',
    'Quedamos atentos 🙏',
  ].join('\n')
}

function effectiveMs(order: Order): number {
  return new Date(order.shopify_created_at ?? order.created_at).getTime()
}

function sortedAll(orders: Order[]): Order[] {
  const cutoff = Date.now() - MS_48H
  const bucket1 = orders
    .filter(o => effectiveMs(o) < cutoff)
    .sort((a, b) => effectiveMs(a) - effectiveMs(b))
  const recent = orders.filter(o => effectiveMs(o) >= cutoff)
  const bucket2 = recent
    .filter(o => { const a = o.confirmation_attempts ?? 0; return a >= 1 && a <= 2 })
    .sort((a, b) => {
      const ta = a.last_confirmation_attempt ? new Date(a.last_confirmation_attempt).getTime() : 0
      const tb = b.last_confirmation_attempt ? new Date(b.last_confirmation_attempt).getTime() : 0
      return ta - tb
    })
  const bucket3 = recent
    .filter(o => (o.confirmation_attempts ?? 0) === 0)
    .sort((a, b) => effectiveMs(b) - effectiveMs(a))
  return [...bucket1, ...bucket2, ...bucket3]
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function ConfirmacionPage() {
  const trackingParam = useSearchParams().get('tracking')
  const rowRefs       = useRef<Map<string, HTMLTableRowElement>>(new Map())
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // — Datos —
  const [orders, setOrders]                         = useState<Order[]>([])   // pendientes
  const [confirmadosSinGuia, setConfirmadosSinGuia] = useState<Order[]>([])
  const [despachados, setDespachados]               = useState<Order[]>([])
  const [total, setTotal]                           = useState(0)              // count pendientes
  const [loading, setLoading]                       = useState(true)
  const [lastRefresh, setLastRefresh]               = useState<Date>(new Date())
  const [stats, setStats]                           = useState<ConfirmStats | null>(null)
  const [perf, setPerf]                             = useState<AgentPerf | null>(null)

  // — UI —
  const [activeTab, setActiveTab]   = useState<Tab>('all')
  const [currentPage, setCurrentPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')

  // — Estado sesión por fila —
  const [terminalMap, setTerminalMap]     = useState<Record<string, string>>({})
  const [attemptsMap, setAttemptsMap]     = useState<Record<string, number>>({})
  const [loadingRow, setLoadingRow]       = useState<Record<string, boolean>>({})
  const [methodMap, setMethodMap]         = useState<Record<string, ContactMethod>>({})
  const [confidenceMap, setConfidenceMap] = useState<Record<string, string>>({})
  const [toast, setToast]                 = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [ordersRes, statsRes, perfRes] = await Promise.all([
        fetch('/api/confirmacion').then(r => r.json() as Promise<ApiResponse>),
        fetch('/api/confirmacion/stats').then(r => r.json() as Promise<ConfirmStats>),
        fetch('/api/confirmacion/performance').then(r => r.json() as Promise<AgentPerf>),
      ])

      const data = ordersRes.pendientes ?? ordersRes.data ?? []
      setOrders(data)
      setConfirmadosSinGuia(ordersRes.confirmadosSinGuia ?? [])
      setDespachados(ordersRes.despachados ?? [])
      setTotal(ordersRes.total ?? 0)
      setStats(statsRes)
      setPerf(perfRes)
      setLastRefresh(new Date())

      const initConfidence: Record<string, string> = {}
      const initAttempts:   Record<string, number>  = {}
      for (const o of data) {
        if (o.confirmation_confidence) initConfidence[o.id] = o.confirmation_confidence
        if (o.confirmation_attempts)   initAttempts[o.id]   = o.confirmation_attempts
      }
      setConfidenceMap(initConfidence)
      setAttemptsMap(initAttempts)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 3 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

  useEffect(() => {
    if (!trackingParam || orders.length === 0) return
    const match = orders.find(o => o.tracking_number === trackingParam)
    if (match) {
      setTimeout(() => {
        rowRefs.current.get(match.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 100)
    }
  }, [orders, trackingParam])

  // Conteos de alertas sobre la lista de pendientes
  const alertCounts = useMemo(() => ({
    duplicados: orders.filter(o => o.duplicate_alert).length,
    cobertura:  orders.filter(o => checkCoverage(o.customer_address, o.city).isOutOfCoverage).length,
    unknown:    orders.filter(o => checkCoverage(o.customer_address, o.city).isUnknownZone).length,
  }), [orders])

  // ── Ordenamiento client-side de pendientes según tab ─────────────────────────
  const displayedPendientes = useMemo(() => {
    const cutoff = Date.now() - MS_48H
    switch (activeTab) {
      case 'nuevos':
        return [...orders]
          .filter(o => (o.confirmation_attempts ?? 0) === 0)
          .sort((a, b) => effectiveMs(b) - effectiveMs(a))
      case 'reintentar':
        return [...orders]
          .filter(o => { const a = o.confirmation_attempts ?? 0; return a >= 1 && a <= 2 })
          .sort((a, b) => {
            const ta = a.last_confirmation_attempt ? new Date(a.last_confirmation_attempt).getTime() : 0
            const tb = b.last_confirmation_attempt ? new Date(b.last_confirmation_attempt).getTime() : 0
            return ta - tb
          })
      case 'atrasados':
        return [...orders]
          .filter(o => effectiveMs(o) < cutoff)
          .sort((a, b) => effectiveMs(a) - effectiveMs(b))
      case 'duplicados':
        return [...orders].filter(o => o.duplicate_alert)
      case 'cobertura':
        return [...orders].filter(o => checkCoverage(o.customer_address, o.city).isOutOfCoverage)
      case 'zona_desconocida':
        return [...orders].filter(o => checkCoverage(o.customer_address, o.city).isUnknownZone)
      default:
        return sortedAll(orders)
    }
  }, [orders, activeTab])

  // ── Fuente activa según tab ───────────────────────────────────────────────────
  const activeSource = useMemo(() => {
    if (activeTab === 'despachados')          return despachados
    if (activeTab === 'confirmados_sin_guia') return confirmadosSinGuia
    return displayedPendientes
  }, [activeTab, despachados, confirmadosSinGuia, displayedPendientes])

  // Búsqueda sobre la fuente activa
  const filteredOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return activeSource
    return activeSource.filter(o =>
      (o.customer_name  ?? '').toLowerCase().includes(q) ||
      (o.customer_phone ?? '').toLowerCase().includes(q) ||
      (o.order_number   ?? '').toLowerCase().includes(q),
    )
  }, [activeSource, searchQuery])

  const pagedOrders = useMemo(
    () => filteredOrders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredOrders, currentPage],
  )
  const totalPages = Math.ceil(filteredOrders.length / PAGE_SIZE)

  useEffect(() => { setCurrentPage(1) }, [activeTab, searchQuery])

  function showToast(msg: string, type: 'success' | 'error') {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ msg, type })
    toastTimerRef.current = setTimeout(() => setToast(null), 3000)
  }

  async function postConfirmation(orderId: string, action: string) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      const method = methodMap[orderId] ?? 'other'
      const res = await fetch(`/api/orders/${orderId}/confirmation`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action, method }),
      })

      if (!res.ok) {
        showToast('Error al procesar la acción. Intenta de nuevo.', 'error')
        return
      }

      const data = await res.json() as ConfirmResult
      setConfidenceMap(prev => ({ ...prev, [orderId]: data.confirmation_confidence }))

      if (action === 'no_answer') {
        setAttemptsMap(prev => ({ ...prev, [orderId]: data.confirmation_attempts }))
        if (data.confirmation_status === 'unreachable') {
          setTerminalMap(prev => ({ ...prev, [orderId]: 'unreachable' }))
          showToast('Pedido marcado como inalcanzable', 'success')
        } else {
          showToast(`Intento ${data.confirmation_attempts}/${MAX_ATTEMPTS} registrado`, 'success')
        }
      } else {
        setTerminalMap(prev => ({ ...prev, [orderId]: action }))
        const TOAST_MSG: Record<string, string> = {
          confirmed:   '✓ Pedido confirmado',
          cancelled:   'Pedido cancelado',
          no_coverage: 'Pedido marcado como Sin cobertura',
          wrong_number:'Número incorrecto registrado',
        }
        showToast(TOAST_MSG[action] ?? 'Acción registrada', 'success')
        if (action !== 'confirmed') {
          setTimeout(() => setOrders(prev => prev.filter(o => o.id !== orderId)), 1500)
        }
      }
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  const confirmedCount = Object.values(terminalMap).filter(a => a === 'confirmed').length

  // Helpers de vista
  const isPendingView         = activeTab !== 'despachados' && activeTab !== 'confirmados_sin_guia'
  const isDespachadosView     = activeTab === 'despachados'
  const isConfirmSinGuiaView  = activeTab === 'confirmados_sin_guia'
  const hasAnyOrders = total > 0 || despachados.length > 0 || confirmadosSinGuia.length > 0

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* ── Toast ── */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3
                         rounded-xl shadow-xl text-sm font-semibold animate-in
                         ${toast.type === 'success' ? 'bg-gray-900 text-white' : 'bg-red-600 text-white'}`}>
          {toast.type === 'success'
            ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
            : <XCircle      className="w-4 h-4 text-white shrink-0" />}
          {toast.msg}
        </div>
      )}

      {/* ── Banner ── */}
      <div className="relative overflow-hidden rounded-2xl
                      bg-gradient-to-r from-indigo-500 to-purple-600
                      border-2 border-indigo-400 shadow-lg shadow-indigo-200/50">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white" />
          <div className="absolute -right-2 -bottom-10 w-24 h-24 rounded-full bg-white" />
        </div>
        <div className="relative px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-12 h-12 bg-white/20 rounded-xl">
              <ClipboardList className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-black text-white tabular-nums">
                  {loading ? '…' : total.toLocaleString()}
                </h1>
                {!loading && total > 0 && (
                  <span className="flex items-center gap-1.5 bg-white/20 text-white
                                   text-xs font-bold px-2.5 py-1 rounded-full">
                    PENDIENTES
                  </span>
                )}
              </div>
              <p className="text-white font-semibold">Confirmación de pedidos</p>
              <p className="text-indigo-100 text-xs mt-0.5">
                Confirma disponibilidad del cliente antes del despacho
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            {confirmedCount > 0 && (
              <span className="text-sm text-green-200 font-semibold">
                ✓ {confirmedCount} confirmados esta sesión
              </span>
            )}
            <p className="text-indigo-100 text-xs">
              {lastRefresh.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
            </p>
            <button
              onClick={fetchData}
              disabled={loading}
              className="flex items-center gap-2 bg-white/20 hover:bg-white/30 text-white
                         text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refrescar
            </button>
          </div>
        </div>
      </div>

      {/* ── Rendimiento del agente hoy ── */}
      {perf && (
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-3.5 shadow-sm">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 shrink-0">
              <TrendingUp className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Mi día</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap flex-1">
              {([
                { label: 'Confirmados',   count: perf.confirmadosHoy,    cls: 'bg-green-100  text-green-700'  },
                { label: 'Contactados',   count: perf.contactadosHoy,    cls: 'bg-blue-100   text-blue-700'   },
                { label: 'No responden',  count: perf.noRespondieronHoy, cls: 'bg-amber-100  text-amber-700'  },
                { label: 'Cancelados',    count: perf.canceladosHoy,     cls: 'bg-gray-100   text-gray-600'   },
                { label: 'Sin cobertura', count: perf.sinCoberturaHoy,   cls: 'bg-orange-100 text-orange-700' },
              ] as const).map(({ label, count, cls }) => (
                <div key={label} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${cls}`}>
                  <span className="text-sm font-black tabular-nums leading-none">{count}</span>
                  <span className="text-[11px] font-medium">{label}</span>
                </div>
              ))}
            </div>
            {perf.tasaConfirmacionHoy !== null ? (
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg shrink-0
                ${perf.tasaConfirmacionHoy >= 70
                  ? 'bg-green-100 text-green-700'
                  : perf.tasaConfirmacionHoy >= 40
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-red-100 text-red-700'}`}>
                <span className="text-[11px] font-semibold opacity-60 leading-none">Tasa</span>
                <span className="text-xl font-black tabular-nums leading-none">{perf.tasaConfirmacionHoy}%</span>
              </div>
            ) : (
              <span className="text-xs text-gray-400 shrink-0">Sin contactos hoy</span>
            )}
          </div>
        </div>
      )}

      {/* ── Dashboard operativo ── */}
      {stats && (
        <div className="space-y-2">

          {/* Fila 1: acción — pendientes de confirmar */}
          <div className="grid grid-cols-3 gap-3">
            {([
              {
                tab:   'nuevos'     as Tab,
                count: stats.nuevos,
                label: 'Nuevos',
                sub:   'Sin tracking · sin contacto',
                Icon:  Inbox,
                base:  'border-indigo-200 bg-indigo-50 text-indigo-700',
                active:'border-indigo-400 bg-indigo-100 text-indigo-800 ring-2 ring-indigo-300/50',
                hover: 'hover:bg-indigo-100',
              },
              {
                tab:   'reintentar' as Tab,
                count: stats.reintentar,
                label: 'Reintentar',
                sub:   '1–2 intentos sin resp.',
                Icon:  RotateCcw,
                base:  'border-amber-200 bg-amber-50 text-amber-700',
                active:'border-amber-400 bg-amber-100 text-amber-800 ring-2 ring-amber-300/50',
                hover: 'hover:bg-amber-100',
              },
              {
                tab:   'atrasados'  as Tab,
                count: stats.atrasados,
                label: 'Atrasados +48h',
                sub:   'Más de 2 días pendiente',
                Icon:  Clock,
                base:  'border-red-200 bg-red-50 text-red-700',
                active:'border-red-400 bg-red-100 text-red-800 ring-2 ring-red-300/50',
                hover: 'hover:bg-red-100',
              },
            ] as const).map(({ tab, count, label, sub, Icon, base, active, hover }) => (
              <button
                key={tab}
                onClick={() => { setActiveTab(prev => prev === tab ? 'all' : tab); setCurrentPage(1) }}
                className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all
                  ${activeTab === tab ? active : `${base} ${hover}`}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-3xl font-black tabular-nums leading-none">{count}</p>
                  <p className="text-sm font-bold mt-1">{label}</p>
                  <p className="text-xs opacity-60 mt-0.5 truncate">{sub}</p>
                </div>
                <Icon className="w-7 h-7 opacity-25 shrink-0" />
              </button>
            ))}
          </div>

          {/* Fila 2: informativas — confirmados sin guía y despachados */}
          <div className="grid grid-cols-2 gap-3">
            {([
              {
                tab:   'confirmados_sin_guia' as Tab,
                count: stats.confirmadosSinGuia,
                label: 'Confirmados sin guía',
                sub:   'Esperando número de tracking',
                Icon:  PackageCheck,
                base:  'border-teal-200 bg-teal-50 text-teal-700',
                active:'border-teal-400 bg-teal-100 text-teal-800 ring-2 ring-teal-300/50',
                hover: 'hover:bg-teal-100',
              },
              {
                tab:   'despachados' as Tab,
                count: stats.despachados,
                label: 'Despachados',
                sub:   'Con guía · en proceso logístico',
                Icon:  Truck,
                base:  'border-blue-200 bg-blue-50 text-blue-700',
                active:'border-blue-400 bg-blue-100 text-blue-800 ring-2 ring-blue-300/50',
                hover: 'hover:bg-blue-100',
              },
            ] as const).map(({ tab, count, label, sub, Icon, base, active, hover }) => (
              <button
                key={tab}
                onClick={() => { setActiveTab(prev => prev === tab ? 'all' : tab); setCurrentPage(1) }}
                className={`flex items-center gap-3 p-3.5 rounded-xl border-2 text-left transition-all
                  ${activeTab === tab ? active : `${base} ${hover}`}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-2xl font-black tabular-nums leading-none">{count}</p>
                  <p className="text-sm font-bold mt-0.5">{label}</p>
                  <p className="text-xs opacity-60 mt-0.5 truncate">{sub}</p>
                </div>
                <Icon className="w-6 h-6 opacity-25 shrink-0" />
              </button>
            ))}
          </div>

          {/* Fila 3: métricas informativas */}
          <div className="grid grid-cols-6 gap-2">
            {([
              { label: 'Confirm. hoy',    count: stats.confirmadosHoy, cls: 'bg-green-50   text-green-700   border-green-100'  },
              { label: 'Contactados hoy', count: stats.contactadosHoy, cls: 'bg-blue-50    text-blue-700    border-blue-100'   },
              { label: 'Sin respuesta',   count: stats.sinRespuesta,   cls: 'bg-amber-50   text-amber-700   border-amber-100'  },
              { label: 'Inalcanzables',   count: stats.inalcanzables,  cls: 'bg-red-50     text-red-700     border-red-100'    },
              { label: 'No desean',       count: stats.noDesean,       cls: 'bg-gray-50    text-gray-600    border-gray-200'   },
              { label: 'Sin cobertura',   count: stats.sinCobertura,   cls: 'bg-orange-50  text-orange-700  border-orange-100' },
            ] as const).map(({ label, count, cls }) => (
              <div key={label} className={`flex flex-col items-center justify-center p-3 rounded-lg border ${cls}`}>
                <p className="text-xl font-black tabular-nums leading-none">{count}</p>
                <p className="text-[10px] font-medium mt-1 text-center leading-tight opacity-80">{label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Sin pedidos pendientes (solo en vista pendientes) ── */}
      {!loading && total === 0 && isPendingView && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-6 text-center">
          <p className="text-green-700 font-medium">No hay pedidos pendientes de confirmación</p>
          <p className="text-green-600 text-sm mt-1">
            Todos los pedidos activos han sido confirmados o procesados
          </p>
        </div>
      )}

      {/* ── Tabla principal ── */}
      {(loading || hasAnyOrders) && (
        <div className="bg-white rounded-xl border-2 border-indigo-200 overflow-hidden shadow-sm">

          {/* Header informativo — solo para pendientes */}
          {isPendingView && (
            <div className="px-5 py-3 bg-indigo-50 border-b border-indigo-200 flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-indigo-600 shrink-0" />
              <p className="text-sm font-semibold text-indigo-800">
                Máximo {MAX_ATTEMPTS} intentos por pedido · Sin respuesta en 3 intentos → inalcanzable
              </p>
            </div>
          )}

          {/* Header informativo — despachados */}
          {isDespachadosView && (
            <div className="px-5 py-3 bg-blue-50 border-b border-blue-200 flex items-center gap-2">
              <Truck className="w-4 h-4 text-blue-600 shrink-0" />
              <p className="text-sm font-semibold text-blue-800">
                Pedidos con guía de despacho en proceso logístico · El estado se actualiza cada 5 min
              </p>
            </div>
          )}

          {/* Header informativo — confirmados sin guía */}
          {isConfirmSinGuiaView && (
            <div className="px-5 py-3 bg-teal-50 border-b border-teal-200 flex items-center gap-2">
              <PackageCheck className="w-4 h-4 text-teal-600 shrink-0" />
              <p className="text-sm font-semibold text-teal-800">
                Pedidos confirmados por el cliente · Esperando asignación de guía de despacho
              </p>
            </div>
          )}

          {/* Buscador */}
          <div className="px-4 py-2.5 border-b border-indigo-100">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Buscar por nombre, teléfono o #orden..."
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg
                           focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400
                           placeholder:text-gray-400 bg-white"
              />
            </div>
          </div>

          {/* Tabs */}
          {!loading && (
            <div className="flex border-b border-indigo-100 overflow-x-auto">
              {TAB_META.map(({ tab, label }) => {
                const count =
                  tab === 'all'                  ? total
                : tab === 'nuevos'               ? (stats?.nuevos             ?? 0)
                : tab === 'reintentar'           ? (stats?.reintentar         ?? 0)
                : tab === 'atrasados'            ? (stats?.atrasados          ?? 0)
                : tab === 'confirmados_sin_guia' ? (stats?.confirmadosSinGuia ?? confirmadosSinGuia.length)
                : tab === 'despachados'          ? (stats?.despachados        ?? despachados.length)
                : tab === 'duplicados'           ? alertCounts.duplicados
                : tab === 'cobertura'            ? alertCounts.cobertura
                :                                  alertCounts.unknown
                return (
                  <button
                    key={tab}
                    onClick={() => { setActiveTab(tab); setCurrentPage(1) }}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold
                                border-b-2 transition-colors whitespace-nowrap shrink-0
                      ${activeTab === tab
                        ? 'border-indigo-500 text-indigo-700 bg-indigo-50/60'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                  >
                    {label}
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full
                      ${activeTab === tab ? 'bg-indigo-500 text-white' : 'bg-gray-100 text-gray-500'}`}>
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner className="w-6 h-6 text-indigo-500" />
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-gray-500 font-medium">No hay pedidos en esta categoría</p>
              {isPendingView && (
                <button
                  onClick={() => setActiveTab('all')}
                  className="text-indigo-500 text-sm mt-2 hover:underline"
                >
                  Ver todos los pendientes
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">

              {/* ── Tabla: Despachados ── */}
              {isDespachadosView && (
                <table className="w-full text-sm">
                  <thead className="bg-blue-50/60 border-b border-blue-100">
                    <tr>
                      {['Cliente', 'Guía', 'Producto / Ciudad', 'Monto', 'Estado logístico', 'Contactar', ''].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-blue-800 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-blue-50">
                    {pagedOrders.map(order => {
                      const nombre   = order.customer_name ?? ''
                      const waUrl    = whatsAppUrl(order.customer_phone, buildConfirmMsg(nombre, order.product_summary, order.cod_amount))
                      const telUrl   = callUrl(order.customer_phone)
                      const hasPhone = !!order.customer_phone
                      const ns       = order.normalized_status
                      return (
                        <tr key={order.id} className="hover:bg-blue-50/30 transition-colors">
                          <td className="px-3 py-2.5">
                            <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[150px]">
                              {nombre || '—'}
                            </p>
                            <p className="font-mono text-xs text-gray-500 mt-0.5">
                              {order.customer_phone ?? '—'}
                            </p>
                            <p className="text-[10px] text-gray-400 mt-0.5">
                              {order.order_number ?? '—'}
                              <span className="mx-1 text-gray-300">·</span>
                              {formatOrderTime(order.shopify_created_at ?? order.created_at)}
                            </p>
                          </td>
                          <td className="px-3 py-2.5">
                            <p className="font-mono text-xs font-semibold text-blue-700 bg-blue-50
                                          px-2 py-1 rounded border border-blue-200 w-fit">
                              {order.tracking_number || '—'}
                            </p>
                          </td>
                          <td className="px-3 py-2.5 max-w-[140px]">
                            <p className="text-xs text-gray-700 truncate" title={order.product_summary ?? ''}>
                              {order.product_summary || '—'}
                            </p>
                            <div className="flex items-center gap-1 mt-0.5">
                              <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                              <span className="text-xs text-gray-500 truncate">{order.city || '—'}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <p className="text-sm font-semibold text-green-700 whitespace-nowrap">
                              {formatCurrency(order.cod_amount)}
                            </p>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full w-fit
                              ${STATUS_COLORS[ns] ?? 'bg-gray-100 text-gray-600'}`}>
                              {STATUS_LABELS[ns] ?? ns}
                            </span>
                            {order.last_tracking_update && (
                              <p className="text-[10px] text-gray-400 mt-0.5">
                                {formatOrderTime(order.last_tracking_update)}
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            {hasPhone ? (
                              <div className="flex items-center gap-2">
                                {waUrl && (
                                  <a href={waUrl} target="_blank" rel="noopener noreferrer"
                                     className="flex items-center gap-1 bg-green-500 hover:bg-green-600
                                                text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg
                                                transition-colors shadow-sm">
                                    <MessageCircle className="w-3.5 h-3.5" />WA
                                  </a>
                                )}
                                {telUrl && (
                                  <a href={telUrl}
                                     className="flex items-center gap-1 bg-blue-500 hover:bg-blue-600
                                                text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg
                                                transition-colors shadow-sm">
                                    <Phone className="w-3.5 h-3.5" />Llamar
                                  </a>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-gray-300 italic">Sin teléfono</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <Link href={`/orders/${order.id}`}
                              className="inline-flex items-center gap-1 text-xs font-medium
                                         text-indigo-600 hover:text-indigo-800 whitespace-nowrap hover:underline">
                              <ExternalLink className="w-3 h-3" />Ver detalle
                            </Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}

              {/* ── Tabla: Confirmados sin guía ── */}
              {isConfirmSinGuiaView && (
                <table className="w-full text-sm">
                  <thead className="bg-teal-50/60 border-b border-teal-100">
                    <tr>
                      {['Cliente', 'Pedido', 'Producto / Ciudad', 'Monto', 'Confirmado', ''].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-teal-800 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-teal-50">
                    {pagedOrders.map(order => {
                      const nombre = order.customer_name ?? ''
                      return (
                        <tr key={order.id} className="hover:bg-teal-50/30 transition-colors">
                          <td className="px-3 py-2.5">
                            <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[150px]">
                              {nombre || '—'}
                            </p>
                            <p className="font-mono text-xs text-gray-500 mt-0.5">
                              {order.customer_phone ?? '—'}
                            </p>
                          </td>
                          <td className="px-3 py-2.5">
                            <p className="font-mono text-xs text-gray-700">
                              {order.order_number ?? '—'}
                            </p>
                            <p className="text-[10px] text-gray-400 mt-0.5">
                              {formatOrderTime(order.shopify_created_at ?? order.created_at)}
                            </p>
                          </td>
                          <td className="px-3 py-2.5 max-w-[140px]">
                            <p className="text-xs text-gray-700 truncate" title={order.product_summary ?? ''}>
                              {order.product_summary || '—'}
                            </p>
                            <div className="flex items-center gap-1 mt-0.5">
                              <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                              <span className="text-xs text-gray-500 truncate">{order.city || '—'}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <p className="text-sm font-semibold text-green-700 whitespace-nowrap">
                              {formatCurrency(order.cod_amount)}
                            </p>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full
                                             bg-green-100 text-green-700 w-fit">
                              Confirmado
                            </span>
                            {order.last_confirmation_attempt && (
                              <p className="text-[10px] text-gray-400 mt-0.5">
                                {formatOrderTime(order.last_confirmation_attempt)}
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <Link href={`/orders/${order.id}`}
                              className="inline-flex items-center gap-1 text-xs font-medium
                                         text-indigo-600 hover:text-indigo-800 whitespace-nowrap hover:underline">
                              <ExternalLink className="w-3 h-3" />Ver detalle
                            </Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}

              {/* ── Tabla: Pendientes (existente) ── */}
              {isPendingView && (
                <table className="w-full text-sm">
                  <thead className="bg-indigo-50/60 border-b border-indigo-100">
                    <tr>
                      {['Cliente','Ubicación','Monto','Estado','Intentos','Contactar','Acción',''].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-indigo-800 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-indigo-50">
                    {pagedOrders.map(order => {
                      const nombre        = order.customer_name ?? ''
                      const waUrl         = whatsAppUrl(order.customer_phone, buildConfirmMsg(nombre, order.product_summary, order.cod_amount))
                      const telUrl        = callUrl(order.customer_phone)
                      const hasPhone      = !!order.customer_phone
                      const busy          = !!loadingRow[order.id]
                      const terminal      = terminalMap[order.id]
                      const sessionAtt    = attemptsMap[order.id]
                      const totalAttempts = sessionAtt ?? (order.confirmation_attempts ?? 0)
                      const isHighlighted = trackingParam && order.tracking_number === trackingParam
                      const hasDup        = !!order.duplicate_alert
                      const cov           = checkCoverage(order.customer_address, order.city)
                      const hasAlert      = hasDup || cov.isOutOfCoverage || cov.isUnknownZone

                      return (
                        <tr
                          key={order.id}
                          ref={el => { if (el) rowRefs.current.set(order.id, el) }}
                          className={`transition-colors group
                            ${isHighlighted
                              ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/60'
                              : hasAlert
                                ? 'bg-amber-50/40 hover:bg-amber-50/70'
                                : 'hover:bg-indigo-50/30'}`}
                        >
                          <td className="px-3 py-2.5">
                            <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[160px]">
                              {nombre || '—'}
                            </p>
                            <p className="font-mono text-xs text-gray-500 mt-0.5">
                              {order.customer_phone ?? '—'}
                            </p>
                            <p className="font-mono text-[10px] text-gray-400 mt-0.5">
                              {[order.tracking_number, order.order_number].filter(Boolean).join(' · ') || '—'}
                              <span className="mx-1 text-gray-300">·</span>
                              {formatOrderTime(order.shopify_created_at ?? order.created_at)}
                            </p>
                            <AlertBadges
                              duplicateAlert={order.duplicate_alert}
                              customerAddress={order.customer_address}
                              city={order.city}
                            />
                          </td>
                          <td className="px-3 py-2.5 max-w-[140px]">
                            <div className="flex items-center gap-1 text-gray-700">
                              <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                              <span className="text-xs truncate">{order.city || '—'}</span>
                            </div>
                            <p className="text-[10px] text-gray-400 truncate mt-0.5" title={order.product_summary ?? ''}>
                              {order.product_summary ?? ''}
                            </p>
                          </td>
                          <td className="px-3 py-2.5">
                            <p className="text-sm font-semibold text-green-700 whitespace-nowrap">
                              {formatCurrency(order.cod_amount)}
                            </p>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-col gap-1">
                              {(() => {
                                const raw   = terminalMap[order.id] ?? order.confirmation_status ?? 'pending'
                                const key   = raw === 'wrong_number' ? 'unreachable' : raw
                                const badge = CONF_STATUS[key]
                                return badge ? (
                                  <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full w-fit ${badge.cls}`}>
                                    {badge.label}
                                  </span>
                                ) : null
                              })()}
                              {(() => {
                                const conf  = confidenceMap[order.id] ?? order.confirmation_confidence
                                if (!conf) return null
                                const badge = CONFIDENCE[conf]
                                return badge ? (
                                  <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full w-fit ${badge.cls}`}>
                                    {badge.label}
                                  </span>
                                ) : null
                              })()}
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            {totalAttempts > 0 ? (
                              <span className={`text-xs font-bold px-2 py-0.5 rounded-full
                                ${totalAttempts >= MAX_ATTEMPTS
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-amber-100 text-amber-700'}`}>
                                {totalAttempts}/{MAX_ATTEMPTS}
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            {hasPhone ? (
                              <div className="flex items-center gap-2">
                                {waUrl && (
                                  <a href={waUrl} target="_blank" rel="noopener noreferrer"
                                     onClick={() => setMethodMap(prev => ({ ...prev, [order.id]: 'whatsapp' }))}
                                     className="flex items-center gap-1 bg-green-500 hover:bg-green-600
                                                text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg
                                                transition-colors shadow-sm">
                                    <MessageCircle className="w-3.5 h-3.5" />WA
                                  </a>
                                )}
                                {telUrl && (
                                  <a href={telUrl}
                                     onClick={() => setMethodMap(prev => ({ ...prev, [order.id]: 'call' }))}
                                     className="flex items-center gap-1 bg-blue-500 hover:bg-blue-600
                                                text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg
                                                transition-colors shadow-sm">
                                    <Phone className="w-3.5 h-3.5" />Llamar
                                  </a>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-gray-300 italic">Sin teléfono</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            {busy ? (
                              <Spinner className="w-4 h-4 text-indigo-500" />
                            ) : terminal ? (
                              <span className={`inline-flex items-center gap-1 text-xs font-semibold
                                               px-2.5 py-1 rounded-full
                                               ${TERMINAL[terminal]?.color ?? 'bg-gray-100 text-gray-600'}`}>
                                <CheckCircle2 className="w-3 h-3" />
                                {TERMINAL[terminal]?.label ?? terminal}
                              </span>
                            ) : (
                              <div className="grid grid-cols-2 gap-1">
                                <button
                                  onClick={() => postConfirmation(order.id, 'confirmed')}
                                  className="flex items-center gap-1 bg-green-100 hover:bg-green-200
                                             text-green-700 text-[11px] font-medium px-2 py-1 rounded
                                             transition-colors whitespace-nowrap"
                                >
                                  <CheckCircle2 className="w-3 h-3 shrink-0" />Confirmó
                                </button>
                                <button
                                  onClick={() => postConfirmation(order.id, 'no_answer')}
                                  className="flex items-center gap-1 bg-amber-100 hover:bg-amber-200
                                             text-amber-700 text-[11px] font-medium px-2 py-1 rounded
                                             transition-colors whitespace-nowrap"
                                >
                                  <PhoneMissed className="w-3 h-3 shrink-0" />No contesta
                                </button>
                                <button
                                  onClick={() => postConfirmation(order.id, 'no_coverage')}
                                  className="flex items-center gap-1 bg-orange-100 hover:bg-orange-200
                                             text-orange-700 text-[11px] font-medium px-2 py-1 rounded
                                             transition-colors whitespace-nowrap"
                                >
                                  <MapPinOff className="w-3 h-3 shrink-0" />Sin cobertura
                                </button>
                                <button
                                  onClick={() => postConfirmation(order.id, 'cancelled')}
                                  className="flex items-center gap-1 bg-gray-100 hover:bg-gray-200
                                             text-gray-700 text-[11px] font-medium px-2 py-1 rounded
                                             transition-colors whitespace-nowrap"
                                >
                                  <XCircle className="w-3 h-3 shrink-0" />Canceló
                                </button>
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <Link
                              href={`/orders/${order.id}`}
                              className="inline-flex items-center gap-1 text-xs font-medium
                                         text-indigo-600 hover:text-indigo-800 whitespace-nowrap hover:underline"
                            >
                              <ExternalLink className="w-3 h-3" />Ver detalle
                            </Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Paginación */}
          {!loading && totalPages > 1 && (
            <div className="flex items-center justify-between px-5 py-3 border-t border-indigo-100 bg-indigo-50/40">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg
                           border border-indigo-200 text-indigo-700 bg-white hover:bg-indigo-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />Anterior
              </button>
              <span className="text-xs text-gray-500 tabular-nums">
                Página <span className="font-bold text-gray-800">{currentPage}</span> de{' '}
                <span className="font-bold text-gray-800">{totalPages}</span>
                {' '}·{' '}
                <span className="text-gray-400">{filteredOrders.length} resultados</span>
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg
                           border border-indigo-200 text-indigo-700 bg-white hover:bg-indigo-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente<ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {!loading && isPendingView && total > 200 && (
            <div className="px-5 py-3 bg-indigo-50 border-t border-indigo-100 text-center">
              <p className="text-xs text-indigo-700">Mostrando 200 de {total} pedidos pendientes.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Tip ── */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-5 py-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          <strong className="text-gray-700">Flujo recomendado:</strong>{' '}
          Envía WhatsApp o llama → registra resultado →
          Tras {MAX_ATTEMPTS} intentos sin respuesta el pedido se marca como inalcanzable automáticamente.
          Los pedidos con guía de despacho aparecen automáticamente en <strong className="text-blue-700">🚚 Despachados</strong>.
        </p>
      </div>
    </div>
  )
}
