'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { whatsAppUrl, callUrl, formatCurrency } from '@/lib/utils'
import type { Order } from '@/types'
import {
  ClipboardList, RefreshCw, MessageCircle, Phone,
  CheckCircle2, PhoneMissed, XCircle, ExternalLink,
  MapPin, RotateCcw, Clock, Inbox, TrendingUp,
  AlertTriangle, MapPinOff, ChevronLeft, ChevronRight, Search, Truck,
  CalendarDays,
} from 'lucide-react'
import { AlertBadges } from '@/components/shared/alert-badges'
import { checkCoverage, isSantoDomingoOrder } from '@/lib/alert-helpers'

const MAX_ATTEMPTS = 3
const MS_48H       = 48 * 60 * 60 * 1000

type Tab           = 'all' | 'nuevos' | 'reintentar' | 'atrasados' | 'duplicados' | 'cobertura' | 'zona_desconocida' | 'santo_domingo'
type ContactMethod = 'call' | 'whatsapp' | 'other'
type DateFilter    = 'hoy' | 'ayer' | '7dias' | 'personalizado'

/**
 * Devuelve ms UTC del inicio del día en America/Santo_Domingo (UTC-4, sin DST).
 * offsetDays=0 → hoy, offsetDays=-1 → ayer, offsetDays=1 → mañana.
 */
function rdMidnightUTC(offsetDays = 0): number {
  const rd    = new Date(Date.now() + offsetDays * 86_400_000)
  const rdStr = rd.toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' })
  const [y, m, d] = rdStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d, 4, 0, 0, 0)
}

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
  pendingTotal:       number
  confirmadosSinGuia: number
  despachados:        number
  santoDomingoPendientes?:        number
  santoDomingoConfirmadosSinGuia?: number
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

interface ApiResponse { data: Order[]; total: number }

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
  { tab: 'all',              label: 'Todos'           },
  { tab: 'nuevos',           label: 'Nuevos'          },
  { tab: 'reintentar',       label: 'Reintentar'      },
  { tab: 'atrasados',        label: 'Atrasados +48h'  },
  { tab: 'duplicados',       label: '⚠️ Duplicados'   },
  { tab: 'cobertura',        label: '🚫 Cobertura'    },
  { tab: 'zona_desconocida', label: '🟡 Zona desc.'   },
  { tab: 'santo_domingo',    label: '🏙️ Sto. Domingo' },
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

function buildConfirmMsg(
  nombre: string,
  producto: string | null | undefined,
  monto: number | null | undefined,
): string {
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

// ── Card móvil ────────────────────────────────────────────────────────────────

interface ConfirmacionCardProps {
  order:         Order
  terminal:      string | undefined
  totalAttempts: number
  confidence:    string | undefined
  busy:          boolean
  isHighlighted: boolean
  onConfirmed:   () => void
  onNoAnswer:    () => void
  onNoCoverage:  () => void
  onCancelled:   () => void
  onSetMethod:   (method: ContactMethod) => void
}

function ConfirmacionCard({
  order, terminal, totalAttempts, confidence,
  busy, isHighlighted, onConfirmed, onNoAnswer, onNoCoverage, onCancelled, onSetMethod,
}: ConfirmacionCardProps) {
  const nombre  = order.customer_name ?? ''
  const waUrl   = whatsAppUrl(order.customer_phone, buildConfirmMsg(nombre, order.product_summary, order.cod_amount))
  const telUrl  = callUrl(order.customer_phone)
  const hasPhone = !!order.customer_phone
  const cov     = checkCoverage(order.customer_address, order.city)
  const hasDup  = !!order.duplicate_alert
  const hasAlert = hasDup || cov.isOutOfCoverage || cov.isUnknownZone

  const confStatusKey = terminal
    ? (terminal === 'wrong_number' ? 'unreachable' : terminal)
    : (((order.confirmation_status as string) === 'wrong_number' ? 'unreachable' : order.confirmation_status) ?? 'pending')
  const statusBadge    = CONF_STATUS[confStatusKey]
  const confidenceBadge = confidence ? CONFIDENCE[confidence] : null

  return (
    <div
      className={`p-4 space-y-3
        ${isHighlighted
          ? 'bg-blue-50/80 ring-2 ring-inset ring-blue-400'
          : hasAlert
            ? 'bg-amber-50/50'
            : 'bg-white'
        }`}
    >
      {/* Fila 1: orden# + hora + alertas */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-xs text-gray-400">
            {order.order_number ?? '—'}
            <span className="mx-1 text-gray-300">·</span>
            {formatOrderTime(order.shopify_created_at ?? order.created_at)}
          </p>
        </div>
        <AlertBadges
          duplicateAlert={order.duplicate_alert}
          customerAddress={order.customer_address}
          city={order.city}
          province={order.province}
        />
      </div>

      {/* Fila 2: cliente + teléfono */}
      <div>
        <p className="font-semibold text-gray-900 text-sm leading-tight">
          {nombre || '—'}
        </p>
        <p className="font-mono text-xs text-gray-500 mt-0.5">
          {order.customer_phone ?? '—'}
        </p>
      </div>

      {/* Fila 3: ciudad + producto */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 text-gray-600">
          <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
          <span className="text-xs">{order.city || '—'}</span>
        </div>
        {order.product_summary && (
          <span className="text-[10px] text-gray-400 truncate max-w-[180px]">
            {order.product_summary}
          </span>
        )}
      </div>

      {/* Fila 4: monto + intentos + estado + confianza */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-green-700">
          {formatCurrency(order.cod_amount)}
        </span>
        {totalAttempts > 0 && (
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full
            ${totalAttempts >= MAX_ATTEMPTS
              ? 'bg-red-100 text-red-700'
              : 'bg-amber-100 text-amber-700'}`}>
            {totalAttempts}/{MAX_ATTEMPTS}
          </span>
        )}
        {statusBadge && (
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${statusBadge.cls}`}>
            {statusBadge.label}
          </span>
        )}
        {confidenceBadge && (
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${confidenceBadge.cls}`}>
            {confidenceBadge.label}
          </span>
        )}
      </div>

      {/* Acciones */}
      {busy ? (
        <div className="flex items-center justify-center py-2">
          <Spinner className="w-5 h-5 text-indigo-500" />
        </div>
      ) : terminal ? (
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold
                           px-3 py-1.5 rounded-full
                           ${TERMINAL[terminal]?.color ?? 'bg-gray-100 text-gray-600'}`}>
            <CheckCircle2 className="w-3.5 h-3.5" />
            {TERMINAL[terminal]?.label ?? terminal}
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          {/* WA + Llamar */}
          {hasPhone && (
            <div className="flex gap-2">
              {waUrl && (
                <a
                  href={waUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => onSetMethod('whatsapp')}
                  className="flex-1 flex items-center justify-center gap-2
                             min-h-[44px] bg-green-500 hover:bg-green-600
                             text-white text-sm font-semibold rounded-xl
                             transition-colors shadow-sm"
                >
                  <MessageCircle className="w-4 h-4" />
                  WhatsApp
                </a>
              )}
              {telUrl && (
                <a
                  href={telUrl}
                  onClick={() => onSetMethod('call')}
                  className="flex-1 flex items-center justify-center gap-2
                             min-h-[44px] bg-blue-500 hover:bg-blue-600
                             text-white text-sm font-semibold rounded-xl
                             transition-colors shadow-sm"
                >
                  <Phone className="w-4 h-4" />
                  Llamar
                </a>
              )}
            </div>
          )}

          {/* Grid 2×2 acciones */}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={onConfirmed}
              className="flex items-center justify-center gap-1.5 min-h-[44px]
                         bg-green-100 hover:bg-green-200 text-green-700
                         text-sm font-medium rounded-xl transition-colors"
            >
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              Confirmó
            </button>
            <button
              onClick={onNoAnswer}
              className="flex items-center justify-center gap-1.5 min-h-[44px]
                         bg-amber-100 hover:bg-amber-200 text-amber-700
                         text-sm font-medium rounded-xl transition-colors"
            >
              <PhoneMissed className="w-4 h-4 shrink-0" />
              No contesta
            </button>
            <button
              onClick={onNoCoverage}
              className="flex items-center justify-center gap-1.5 min-h-[44px]
                         bg-orange-100 hover:bg-orange-200 text-orange-700
                         text-sm font-medium rounded-xl transition-colors"
            >
              <MapPinOff className="w-4 h-4 shrink-0" />
              Sin cobertura
            </button>
            <button
              onClick={onCancelled}
              className="flex items-center justify-center gap-1.5 min-h-[44px]
                         bg-gray-100 hover:bg-gray-200 text-gray-700
                         text-sm font-medium rounded-xl transition-colors"
            >
              <XCircle className="w-4 h-4 shrink-0" />
              Canceló
            </button>
          </div>
        </div>
      )}

      {/* Ver detalle */}
      <Link
        href={`/orders/${order.id}`}
        className="flex items-center justify-center gap-1.5 w-full min-h-[36px]
                   text-xs font-medium text-indigo-600 hover:text-indigo-800
                   border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors"
      >
        <ExternalLink className="w-3.5 h-3.5" />
        Ver detalle
      </Link>
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function ConfirmacionPage() {
  const trackingParam = useSearchParams().get('tracking')
  const rowRefs       = useRef<Map<string, HTMLElement>>(new Map())
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [orders, setOrders]           = useState<Order[]>([])
  const [total, setTotal]             = useState(0)
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [stats, setStats]             = useState<ConfirmStats | null>(null)
  const [perf, setPerf]               = useState<AgentPerf | null>(null)
  const [activeTab, setActiveTab]     = useState<Tab>('all')
  const [currentPage, setCurrentPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')

  // ── Filtro de fecha ───────────────────────────────────────────────────────
  const [dateFilter, setDateFilter]   = useState<DateFilter | null>(null)
  const [dateFrom, setDateFrom]       = useState('')
  const [dateTo, setDateTo]           = useState('')
  const [dateApplied, setDateApplied] = useState(false)

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

      const data = ordersRes.data ?? []
      setOrders(data)
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

  const alertCounts = useMemo(() => ({
    duplicados:    orders.filter(o => o.duplicate_alert).length,
    cobertura:     orders.filter(o => checkCoverage(o.customer_address, o.city).isOutOfCoverage).length,
    unknown:       orders.filter(o => checkCoverage(o.customer_address, o.city).isUnknownZone).length,
    santoDomingo:  orders.filter(o => isSantoDomingoOrder(o.city, o.province, o.customer_address)).length,
  }), [orders])

  // Rango de fechas efectivo basado en el filtro activo
  const effectiveDateRange = useMemo((): { from: number; to: number } | null => {
    if (!dateFilter) return null
    const todayMs    = rdMidnightUTC(0)
    const tomorrowMs = rdMidnightUTC(1)
    const yesterdayMs = rdMidnightUTC(-1)
    const sevenDaysMs = rdMidnightUTC(-7)
    switch (dateFilter) {
      case 'hoy':   return { from: todayMs,     to: tomorrowMs  }
      case 'ayer':  return { from: yesterdayMs,  to: todayMs     }
      case '7dias': return { from: sevenDaysMs,  to: tomorrowMs  }
      case 'personalizado': {
        if (!dateApplied || !dateFrom || !dateTo) return null
        const [fy, fm, fd] = dateFrom.split('-').map(Number)
        const [ty, tm, td] = dateTo.split('-').map(Number)
        return {
          from: Date.UTC(fy, fm - 1, fd,     4, 0, 0, 0),
          to:   Date.UTC(ty, tm - 1, td + 1, 4, 0, 0, 0),
        }
      }
      default: return null
    }
  }, [dateFilter, dateFrom, dateTo, dateApplied])

  const displayedOrders = useMemo(() => {
    const cutoff = Date.now() - MS_48H
    switch (activeTab) {
      case 'nuevos': {
        // "Nuevos" = pedidos de HOY en RD, sin contacto previo (0 intentos)
        const todayMs    = rdMidnightUTC(0)
        const tomorrowMs = rdMidnightUTC(1)
        return [...orders]
          .filter(o => {
            if ((o.confirmation_attempts ?? 0) !== 0) return false
            const ts = new Date(o.shopify_created_at ?? o.created_at).getTime()
            return ts >= todayMs && ts < tomorrowMs
          })
          .sort((a, b) => effectiveMs(b) - effectiveMs(a))
      }
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
      case 'santo_domingo':
        return [...orders].filter(o => isSantoDomingoOrder(o.city, o.province, o.customer_address))
      default:
        return sortedAll(orders)
    }
  }, [orders, activeTab])

  const PAGE_SIZE = 50

  const filteredOrders = useMemo(() => {
    // Filtro de fecha: aplica a todos los tabs EXCEPTO 'nuevos' (tiene su propio constraint de hoy)
    let result = displayedOrders
    if (effectiveDateRange && activeTab !== 'nuevos') {
      const { from, to } = effectiveDateRange
      result = result.filter(o => {
        const ts = new Date(o.shopify_created_at ?? o.created_at).getTime()
        return ts >= from && ts < to
      })
    }
    // Búsqueda por texto
    const q = searchQuery.trim().toLowerCase()
    if (!q) return result
    return result.filter(o =>
      (o.customer_name  ?? '').toLowerCase().includes(q) ||
      (o.customer_phone ?? '').toLowerCase().includes(q) ||
      (o.order_number   ?? '').toLowerCase().includes(q),
    )
  }, [displayedOrders, effectiveDateRange, activeTab, searchQuery])

  const pagedOrders = useMemo(
    () => filteredOrders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredOrders, currentPage],
  )
  const totalPages = Math.ceil(filteredOrders.length / PAGE_SIZE)

  useEffect(() => { setCurrentPage(1) }, [activeTab, searchQuery, dateFilter, dateApplied])

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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* ── Toast ── */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3
                         rounded-xl shadow-xl text-sm font-semibold animate-in
                         ${toast.type === 'success'
                           ? 'bg-gray-900 text-white'
                           : 'bg-red-600 text-white'}`}>
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
        <div className="relative px-4 py-4 md:px-6 md:py-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 md:gap-4">
            <div className="flex items-center justify-center w-10 h-10 md:w-12 md:h-12 bg-white/20 rounded-xl">
              <ClipboardList className="w-5 h-5 md:w-6 md:h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2 md:gap-3">
                <h1 className="text-xl md:text-2xl font-black text-white tabular-nums">
                  {loading ? '…' : total.toLocaleString()}
                </h1>
                {!loading && total > 0 && (
                  <span className="flex items-center gap-1.5 bg-white/20 text-white
                                   text-xs font-bold px-2.5 py-1 rounded-full">
                    PENDIENTES
                  </span>
                )}
              </div>
              <p className="text-white font-semibold text-sm md:text-base">Confirmación de pedidos</p>
              <p className="hidden md:block text-indigo-100 text-xs mt-0.5">
                Solo pedidos sin guía · Confirma disponibilidad antes del despacho
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 md:gap-4 shrink-0">
            {confirmedCount > 0 && (
              <span className="hidden md:inline text-sm text-green-200 font-semibold">
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
                         text-sm font-medium px-3 md:px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden md:inline">Refrescar</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Rendimiento del agente hoy ── */}
      {perf && (
        <div className="bg-white rounded-xl border border-gray-200 px-4 md:px-5 py-3.5 shadow-sm">
          <div className="flex items-center gap-3 flex-wrap">

            <div className="flex items-center gap-1.5 shrink-0">
              <TrendingUp className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                Mi día
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap flex-1">
              {([
                { label: 'Confirmados',    count: perf.confirmadosHoy,        cls: 'bg-green-100  text-green-700'  },
                { label: 'Contactados',    count: perf.contactadosHoy,        cls: 'bg-blue-100   text-blue-700'   },
                { label: 'No responden',   count: perf.noRespondieronHoy,     cls: 'bg-amber-100  text-amber-700'  },
                { label: 'Cancelados',     count: perf.canceladosHoy,         cls: 'bg-gray-100   text-gray-600'   },
                { label: 'Sin cobertura',  count: perf.sinCoberturaHoy,       cls: 'bg-orange-100 text-orange-700' },
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
                    : 'bg-red-100 text-red-700'
                }`}>
                <span className="text-[11px] font-semibold opacity-60 leading-none">Tasa</span>
                <span className="text-xl font-black tabular-nums leading-none">
                  {perf.tasaConfirmacionHoy}%
                </span>
              </div>
            ) : (
              <span className="text-xs text-gray-400 shrink-0">Sin contactos hoy</span>
            )}
          </div>
        </div>
      )}

      {/* ── Pipeline de navegación ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <div className="flex items-stretch divide-x divide-gray-100 min-w-[320px]">

            {/* Paso 1 — ACTIVO */}
            <div className="flex-1 flex items-center gap-2 md:gap-3 px-3 md:px-5 py-3.5 bg-indigo-600">
              <ClipboardList className="w-4 md:w-5 h-4 md:h-5 text-indigo-200 shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-indigo-200 uppercase tracking-wider">Paso 1</p>
                <p className="text-xs md:text-sm font-bold text-white leading-tight">Confirmación</p>
                <p className="text-xl md:text-2xl font-black tabular-nums text-white leading-none">{loading ? '…' : total}</p>
              </div>
            </div>

            <div className="flex items-center justify-center w-7 md:w-8 bg-gray-50 shrink-0">
              <ChevronRight className="w-4 h-4 text-gray-300" />
            </div>

            {/* Paso 2 — Link a /confirmados */}
            <Link href="/confirmados"
              className="flex-1 flex items-center gap-2 md:gap-3 px-3 md:px-5 py-3.5 hover:bg-green-50 transition-colors group">
              <CheckCircle2 className="w-4 md:w-5 h-4 md:h-5 text-gray-300 group-hover:text-green-400 shrink-0 transition-colors" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Paso 2</p>
                <p className="text-xs md:text-sm font-bold text-gray-600 group-hover:text-green-700 leading-tight transition-colors">Sin guía</p>
                <p className="text-xl md:text-2xl font-black tabular-nums text-green-600 leading-none">
                  {stats ? stats.confirmadosSinGuia : '…'}
                </p>
              </div>
            </Link>

            <div className="flex items-center justify-center w-7 md:w-8 bg-gray-50 shrink-0">
              <ChevronRight className="w-4 h-4 text-gray-300" />
            </div>

            {/* Paso 3 — Link a /despachados */}
            <Link href="/despachados"
              className="flex-1 flex items-center gap-2 md:gap-3 px-3 md:px-5 py-3.5 hover:bg-blue-50 transition-colors group">
              <Truck className="w-4 md:w-5 h-4 md:h-5 text-gray-300 group-hover:text-blue-400 shrink-0 transition-colors" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Paso 3</p>
                <p className="text-xs md:text-sm font-bold text-gray-600 group-hover:text-blue-700 leading-tight transition-colors">Despachados</p>
                <p className="text-xl md:text-2xl font-black tabular-nums text-blue-600 leading-none">
                  {stats ? stats.despachados : '…'}
                </p>
              </div>
            </Link>
          </div>
        </div>
      </div>

      {/* ── Dashboard operativo ── */}
      {stats && (
        <div className="space-y-2">

          {/* Fila 1: tarjetas de acción clickeables */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
            {([
              {
                tab:   'nuevos'     as Tab,
                count: stats.nuevos,
                label: 'Nuevos',
                sub:   'Sin contacto previo',
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
                label: 'Atrasados',
                sub:   'Más de 2 días pendiente',
                Icon:  Clock,
                base:  'border-red-200 bg-red-50 text-red-700',
                active:'border-red-400 bg-red-100 text-red-800 ring-2 ring-red-300/50',
                hover: 'hover:bg-red-100',
              },
              {
                tab:   'santo_domingo' as Tab,
                count: alertCounts.santoDomingo,
                label: 'Santo Domingo',
                sub:   'Usar transporte local',
                Icon:  MapPin,
                base:  'border-purple-200 bg-purple-50 text-purple-700',
                active:'border-purple-400 bg-purple-100 text-purple-800 ring-2 ring-purple-300/50',
                hover: 'hover:bg-purple-100',
              },
            ] as const).map(({ tab, count, label, sub, Icon, base, active, hover }) => (
              <button
                key={tab}
                onClick={() => { setActiveTab(prev => prev === tab ? 'all' : tab); setCurrentPage(1) }}
                className={`flex items-center gap-2 md:gap-3 p-3 md:p-4 rounded-xl border-2 text-left transition-all
                  ${activeTab === tab ? active : `${base} ${hover}`}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-2xl md:text-3xl font-black tabular-nums leading-none">{count}</p>
                  <p className="text-xs md:text-sm font-bold mt-1">{label}</p>
                  <p className="hidden md:block text-xs opacity-60 mt-0.5 truncate">{sub}</p>
                </div>
                <Icon className="w-6 md:w-7 h-6 md:h-7 opacity-25 shrink-0" />
              </button>
            ))}
          </div>

          {/* Fila 2: métricas informativas */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
            {([
              { label: 'Confirm. hoy',   count: stats.confirmadosHoy, cls: 'bg-green-50   text-green-700   border-green-100'  },
              { label: 'Contactados hoy',count: stats.contactadosHoy, cls: 'bg-blue-50    text-blue-700    border-blue-100'   },
              { label: 'Sin respuesta',  count: stats.sinRespuesta,   cls: 'bg-amber-50   text-amber-700   border-amber-100'  },
              { label: 'Inalcanzables',  count: stats.inalcanzables,  cls: 'bg-red-50     text-red-700     border-red-100'    },
              { label: 'No desean',      count: stats.noDesean,       cls: 'bg-gray-50    text-gray-600    border-gray-200'   },
              { label: 'Sin cobertura',  count: stats.sinCobertura,   cls: 'bg-orange-50  text-orange-700  border-orange-100' },
            ] as const).map(({ label, count, cls }) => (
              <div key={label}
                   className={`flex flex-col items-center justify-center p-3 rounded-lg border ${cls}`}>
                <p className="text-xl font-black tabular-nums leading-none">{count}</p>
                <p className="text-[10px] font-medium mt-1 text-center leading-tight opacity-80">{label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Sin pedidos pendientes ── */}
      {!loading && total === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-6 text-center">
          <p className="text-green-700 font-medium">No hay pedidos pendientes de confirmación</p>
          <p className="text-green-600 text-sm mt-1">
            Todos los pedidos activos han sido confirmados o procesados
          </p>
        </div>
      )}

      {/* ── Vista filtrada vacía ── */}
      {!loading && total > 0 && displayedOrders.length === 0 && (
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-5 py-6 text-center">
          <p className="text-indigo-700 font-medium">No hay pedidos en esta categoría</p>
          <button
            onClick={() => setActiveTab('all')}
            className="text-indigo-500 text-sm mt-2 hover:underline"
          >
            Ver todos los pendientes
          </button>
        </div>
      )}

      {/* ── Tabla + Cards ── */}
      {(loading || total > 0) && (
        <div className="bg-white rounded-xl border-2 border-indigo-200 overflow-hidden shadow-sm">

          {/* Header informativo */}
          <div className="px-4 md:px-5 py-3 bg-indigo-50 border-b border-indigo-200 flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-indigo-600 shrink-0" />
            <p className="text-xs md:text-sm font-semibold text-indigo-800">
              Máx. {MAX_ATTEMPTS} intentos · Sin respuesta en 3 → inalcanzable
            </p>
          </div>

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

          {/* ── Filtro de fecha ── */}
          {!loading && (
            <div className="px-3 py-2 border-b border-indigo-100 flex items-center gap-1.5 flex-wrap bg-gray-50/60">
              <CalendarDays className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              {(['hoy', 'ayer', '7dias'] as DateFilter[]).map(f => (
                <button
                  key={f}
                  onClick={() => { setDateFilter(prev => prev === f ? null : f); setCurrentPage(1) }}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors shrink-0
                    ${dateFilter === f
                      ? 'bg-indigo-500 text-white border-indigo-500'
                      : 'text-gray-600 border-gray-200 hover:border-indigo-300 hover:text-indigo-600 bg-white'
                    }`}
                >
                  {f === 'hoy' ? 'Hoy' : f === 'ayer' ? 'Ayer' : '7 días'}
                </button>
              ))}
              <button
                onClick={() => { setDateFilter(prev => prev === 'personalizado' ? null : 'personalizado'); setCurrentPage(1) }}
                className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors shrink-0
                  ${dateFilter === 'personalizado'
                    ? 'bg-indigo-500 text-white border-indigo-500'
                    : 'text-gray-600 border-gray-200 hover:border-indigo-300 hover:text-indigo-600 bg-white'
                  }`}
              >
                Rango
              </button>
              {dateFilter === 'personalizado' && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={e => setDateFrom(e.target.value)}
                    className="text-[11px] border border-gray-200 rounded px-2 py-1
                               focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                  />
                  <span className="text-[10px] text-gray-400">—</span>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={e => setDateTo(e.target.value)}
                    className="text-[11px] border border-gray-200 rounded px-2 py-1
                               focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                  />
                  <button
                    onClick={() => { setDateApplied(true); setCurrentPage(1) }}
                    className="text-[11px] bg-indigo-600 text-white px-2.5 py-1 rounded-full hover:bg-indigo-700 shrink-0"
                  >
                    Aplicar
                  </button>
                </div>
              )}
              {dateFilter && (
                <button
                  onClick={() => {
                    setDateFilter(null); setDateFrom(''); setDateTo('')
                    setDateApplied(false); setCurrentPage(1)
                  }}
                  className="text-[11px] text-gray-400 hover:text-red-500 ml-auto shrink-0"
                >
                  ✕ Limpiar
                </button>
              )}
            </div>
          )}

          {/* ── Tabs de filtro rápido ── */}
          {!loading && (
            <>
              {/* Mobile: select dropdown */}
              <div className="md:hidden px-3 py-2 border-b border-indigo-100">
                <select
                  value={activeTab}
                  onChange={e => { setActiveTab(e.target.value as Tab); setCurrentPage(1) }}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg
                             focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
                >
                  {TAB_META.map(({ tab, label }) => {
                    const count = tab === 'all'              ? total
                                : tab === 'nuevos'           ? (stats?.nuevos      ?? 0)
                                : tab === 'reintentar'       ? (stats?.reintentar  ?? 0)
                                : tab === 'atrasados'        ? (stats?.atrasados   ?? 0)
                                : tab === 'duplicados'       ? alertCounts.duplicados
                                : tab === 'cobertura'        ? alertCounts.cobertura
                                : tab === 'zona_desconocida' ? alertCounts.unknown
                                :                             alertCounts.santoDomingo
                    return (
                      <option key={tab} value={tab}>{label} ({count})</option>
                    )
                  })}
                </select>
              </div>

              {/* Desktop: tabs horizontales compactos */}
              <div className="hidden md:flex overflow-x-auto border-b border-indigo-100">
                <div className="flex min-w-max">
                  {TAB_META.map(({ tab, label }) => {
                    const count = tab === 'all'              ? total
                                : tab === 'nuevos'           ? (stats?.nuevos      ?? 0)
                                : tab === 'reintentar'       ? (stats?.reintentar  ?? 0)
                                : tab === 'atrasados'        ? (stats?.atrasados   ?? 0)
                                : tab === 'duplicados'       ? alertCounts.duplicados
                                : tab === 'cobertura'        ? alertCounts.cobertura
                                : tab === 'zona_desconocida' ? alertCounts.unknown
                                :                             alertCounts.santoDomingo
                    return (
                      <button
                        key={tab}
                        onClick={() => { setActiveTab(tab); setCurrentPage(1) }}
                        className={`flex items-center gap-1.5 min-h-[40px] px-3 py-2 text-xs font-semibold
                                    border-b-2 transition-colors whitespace-nowrap
                          ${activeTab === tab
                            ? 'border-indigo-500 text-indigo-700 bg-indigo-50/60'
                            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                          }`}
                      >
                        {label}
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full
                          ${activeTab === tab
                            ? 'bg-indigo-500 text-white'
                            : 'bg-gray-100 text-gray-500'
                          }`}>
                          {count}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner className="w-6 h-6 text-indigo-500" />
            </div>
          ) : (
            <>
              {/* ── Cards móvil ── */}
              {pagedOrders.length > 0 && (
                <div className="md:hidden divide-y divide-indigo-50">
                  {pagedOrders.map(order => {
                    const terminal      = terminalMap[order.id]
                    const sessionAtt    = attemptsMap[order.id]
                    const totalAttempts = sessionAtt ?? (order.confirmation_attempts ?? 0)
                    const confidence    = confidenceMap[order.id] ?? order.confirmation_confidence ?? undefined
                    const busy          = !!loadingRow[order.id]
                    const isHighlighted = !!(trackingParam && order.tracking_number === trackingParam)
                    return (
                      <div
                        key={order.id}
                        ref={el => { if (el) rowRefs.current.set(order.id, el) }}
                      >
                        <ConfirmacionCard
                          order={order}
                          terminal={terminal}
                          totalAttempts={totalAttempts}
                          confidence={confidence}
                          busy={busy}
                          isHighlighted={isHighlighted}
                          onConfirmed={()    => postConfirmation(order.id, 'confirmed')}
                          onNoAnswer={()     => postConfirmation(order.id, 'no_answer')}
                          onNoCoverage={()   => postConfirmation(order.id, 'no_coverage')}
                          onCancelled={()    => postConfirmation(order.id, 'cancelled')}
                          onSetMethod={m     => setMethodMap(prev => ({ ...prev, [order.id]: m }))}
                        />
                      </div>
                    )
                  })}
                </div>
              )}

              {/* ── Tabla desktop ── */}
              <div className="hidden md:block overflow-x-auto">
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

                      const isHighlighted  = trackingParam && order.tracking_number === trackingParam
                      const hasDup         = !!order.duplicate_alert
                      const cov            = checkCoverage(order.customer_address, order.city)
                      const hasAlert       = hasDup || cov.isOutOfCoverage || cov.isUnknownZone

                      return (
                        <tr
                          key={order.id}
                          ref={el => { if (el) rowRefs.current.set(order.id, el) }}
                          className={`transition-colors group
                            ${isHighlighted
                              ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/60'
                              : hasAlert
                                ? 'bg-amber-50/40 hover:bg-amber-50/70'
                                : 'hover:bg-indigo-50/30'
                            }`}
                        >

                          {/* Cliente + Teléfono + Guía + Hora + Alertas */}
                          <td className="px-3 py-2.5">
                            <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[160px]">
                              {nombre || '—'}
                            </p>
                            <p className="font-mono text-xs text-gray-500 mt-0.5">
                              {order.customer_phone ?? '—'}
                            </p>
                            <p className="font-mono text-[10px] text-gray-400 mt-0.5">
                              {order.order_number ?? '—'}
                              <span className="mx-1 text-gray-300">·</span>
                              {formatOrderTime(order.shopify_created_at ?? order.created_at)}
                            </p>
                            <AlertBadges
                              duplicateAlert={order.duplicate_alert}
                              customerAddress={order.customer_address}
                              city={order.city}
                              province={order.province}
                            />
                          </td>

                          {/* Ubicación + Producto */}
                          <td className="px-3 py-2.5 max-w-[140px]">
                            <div className="flex items-center gap-1 text-gray-700">
                              <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                              <span className="text-xs truncate">{order.city || '—'}</span>
                            </div>
                            <p className="text-[10px] text-gray-400 truncate mt-0.5" title={order.product_summary ?? ''}>
                              {order.product_summary ?? ''}
                            </p>
                          </td>

                          {/* Monto */}
                          <td className="px-3 py-2.5">
                            <p className="text-sm font-semibold text-green-700 whitespace-nowrap">
                              {formatCurrency(order.cod_amount)}
                            </p>
                          </td>

                          {/* Estado + Confianza */}
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

                          {/* Intentos */}
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

                          {/* Contactar */}
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

                          {/* Acción */}
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
                                {/* Fila 1 */}
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
                                {/* Fila 2 */}
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

                          {/* Ver detalle */}
                          <td className="px-3 py-2.5">
                            <Link
                              href={`/orders/${order.id}`}
                              className="inline-flex items-center gap-1 text-xs font-medium
                                         text-indigo-600 hover:text-indigo-800 whitespace-nowrap
                                         hover:underline"
                            >
                              <ExternalLink className="w-3 h-3" />
                              Ver detalle
                            </Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!loading && totalPages > 1 && (
            <div className="flex items-center justify-between px-4 md:px-5 py-3 border-t border-indigo-100 bg-indigo-50/40">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg
                           border border-indigo-200 text-indigo-700 bg-white hover:bg-indigo-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Anterior
              </button>
              <span className="text-xs text-gray-500 tabular-nums">
                <span className="hidden md:inline">Página </span>
                <span className="font-bold text-gray-800">{currentPage}</span>
                <span className="hidden md:inline"> de </span>
                <span className="md:hidden">/</span>
                <span className="font-bold text-gray-800">{totalPages}</span>
                <span className="hidden md:inline"> · <span className="text-gray-400">{filteredOrders.length} resultados</span></span>
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg
                           border border-indigo-200 text-indigo-700 bg-white hover:bg-indigo-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {!loading && total > 200 && (
            <div className="px-5 py-3 bg-indigo-50 border-t border-indigo-100 text-center">
              <p className="text-xs text-indigo-700">Mostrando 200 de {total} pedidos pendientes.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Tip ── */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 md:px-5 py-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          <strong className="text-gray-700">Flujo recomendado:</strong>{' '}
          Envía WhatsApp o llama → registra resultado →
          Tras {MAX_ATTEMPTS} intentos sin respuesta el pedido se marca como inalcanzable automáticamente.
          Los pedidos ya despachados (con guía) aparecen en <strong className="text-blue-600">Despachados</strong> en el menú.
        </p>
      </div>
    </div>
  )
}
