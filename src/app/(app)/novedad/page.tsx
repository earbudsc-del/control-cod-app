'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { whatsAppUrl, callUrl, daysSince, formatEventDate } from '@/lib/utils'
import { parseEFIDate } from '@/lib/tracking/parse-efi-date'
import { FlujoKpis } from '@/components/shared/flujo-kpis'
import type { ActionType, ContactResult, Order } from '@/types'
import {
  AlertCircle, RefreshCw, MessageCircle, Phone,
  CheckCircle2, PhoneMissed, XCircle, ExternalLink,
  MapPin, Search, TrendingUp, CalendarClock,
  RotateCcw, ShieldAlert, Clock, ChevronLeft, ChevronRight,
  Package, DollarSign,
} from 'lucide-react'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type Tab = 'all' | 'dos' | 'tres-mas' | 'reprogramados' | 'no-salvables' | 'recuperadas'

interface NoveltyPerfData {
  novedadesTrabajadasHoy:  number
  pedidosContactadosHoy:   number
  pedidosReprogramadosHoy: number
  pedidosNoRespondenHoy:   number
  pedidosNoSalvablesHoy:   number
  tasaRecuperacionHoy:     number | null
  atrasadosPendientes:     number
  recuperadasHoy:          number
  recuperadasAyer:         number
}

interface RecuperadaEntry {
  order:        Order
  delivered_at: string
  confirmed:    boolean
}

interface OrdersResponse {
  data:       Order[]
  pagination: { total: number }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildNovedadMsg(nombre: string, producto: string | null | undefined): string {
  const n   = nombre.trim() || 'cliente'
  const raw = (producto ?? '').trim()
  const p   = raw.length > 32 ? raw.slice(0, 30) + '...' : raw || 'tu pedido'
  return [
    'Hola ' + n + ' 😊,',
    '',
    'Te escribimos por tu pedido de ' + p + ' 📦',
    '',
    'El mensajero intentó entregarlo, pero no se pudo completar en ese momento.',
    '',
    'Podemos coordinar una nueva entrega para finalizarlo sin inconvenientes.',
    '',
    'Indícanos por favor en qué horario puedes recibirlo,',
    'o deja a alguien encargado.',
    '',
    'Quedamos atentos 🙏',
  ].join('\n')
}

const TAB_META: { tab: Tab; label: string }[] = [
  { tab: 'all',           label: 'Todos'         },
  { tab: 'dos',           label: '2 intentos'    },
  { tab: 'tres-mas',      label: 'Alerta 3+'     },
  { tab: 'reprogramados', label: 'Reprogramados' },
  { tab: 'no-salvables',  label: 'No salvables'  },
  { tab: 'recuperadas',   label: '✓ Entregadas' },
]

const ACTION_BADGE: Record<string, { label: string; color: string }> = {
  contacted:   { label: 'Contactado',   color: 'bg-blue-100 text-blue-700'    },
  rescheduled: { label: 'Reprogramado', color: 'bg-indigo-100 text-indigo-700' },
  no_answer:   { label: 'No responde',  color: 'bg-amber-100 text-amber-700'  },
}

// Días desde que el pedido entró en novedad (last_novedad_at → status_since → last_tracking_update)
function daysInNovedad(order: Order): number {
  const base = (
    order.last_novedad_at ??
    order.status_since ??
    order.last_tracking_update ??
    order.created_at
  ) as string
  return Math.floor((Date.now() - new Date(base).getTime()) / (1000 * 60 * 60 * 24))
}

type SuggestionSeverity = 'medium' | 'high' | 'critical'
interface NovedadSuggestion { text: string; severity: SuggestionSeverity }

function supervisorSuggestion(days: number): NovedadSuggestion | null {
  if (days >= 14) return { text: 'Riesgo crítico — escalar inmediatamente',  severity: 'critical' }
  if (days >= 7)  return { text: 'Contacto urgente antes de reprogramar',    severity: 'high'     }
  if (days >= 3)  return { text: 'Seguimiento pendiente',                    severity: 'medium'   }
  return null
}

// Medianoche RD en UTC (America/Santo_Domingo = UTC-4, sin DST)
function rdMidnightUTC(offsetDays = 0): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date())
  const y = parseInt(parts.find(p => p.type === 'year')!.value)
  const m = parseInt(parts.find(p => p.type === 'month')!.value)
  const d = parseInt(parts.find(p => p.type === 'day')!.value)
  return Date.UTC(y, m - 1, d + offsetDays, 4, 0, 0, 0)
}

const PAGE_SIZE = 50

// ── Subcomponente: Card móvil de novedad activa ───────────────────────────────

interface NovedadCardProps {
  order: Order
  accion: string | undefined
  busy: boolean
  novedadSrc: string | null
  dias: number
  sug: NovedadSuggestion | null
  onContacted: () => void
  onRescheduled: () => void
  onNoAnswer: () => void
  onNoSalvable: () => void
  onRecuperada: () => void
  isHighlighted: boolean
}

function NovedadCard({
  order, accion, busy, novedadSrc, dias, sug,
  onContacted, onRescheduled, onNoAnswer, onNoSalvable, onRecuperada,
  isHighlighted,
}: NovedadCardProps) {
  const nombre    = order.customer_name ?? ''
  const intentos  = order.delivery_attempts ?? 0
  const waUrl     = whatsAppUrl(order.customer_phone, buildNovedadMsg(nombre, order.product_summary))
  const telUrl    = callUrl(order.customer_phone)
  const hasPhone  = !!order.customer_phone
  const noSalv       = order.follow_up_result === 'no_action'
  const isRecuperada = order.follow_up_result === 'recovered'

  const ubicacion = order.city
    || order.province
    || (order.customer_address ? order.customer_address.slice(0, 30) : null)

  const cardBg = noSalv || isRecuperada
    ? 'bg-gray-50 border-gray-200'
    : intentos >= 3
      ? 'bg-red-50/40 border-red-200'
      : intentos === 2
        ? 'bg-orange-50/40 border-orange-200'
        : 'bg-white border-gray-200'

  return (
    <div className={`rounded-xl border-2 p-4 space-y-3 shadow-sm transition-colors
      ${cardBg} ${isHighlighted ? 'ring-2 ring-blue-400 border-blue-300' : ''}`}>

      {/* Fila superior: orden + intentos badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {order.order_number && (
            <p className="text-xs font-bold text-gray-500 mb-0.5">{order.order_number}</p>
          )}
          <p className="font-mono text-sm font-semibold text-gray-900 truncate">
            {order.tracking_number ?? '—'}
          </p>
          {novedadSrc && (
            <p className="text-[11px] text-gray-400 mt-0.5">{daysSince(novedadSrc)}</p>
          )}
        </div>

        {/* Badge de intentos */}
        <div className="shrink-0 flex flex-col items-end gap-1">
          <span className={`text-xs font-black px-2.5 py-1 rounded-full tabular-nums
            ${intentos >= 3
              ? 'bg-red-100 text-red-700'
              : intentos === 2
                ? 'bg-orange-100 text-orange-700'
                : 'bg-yellow-100 text-yellow-700'
            }`}>
            {intentos} {intentos === 1 ? 'intento' : 'intentos'}
          </span>
          {intentos >= 3 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold
                             bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              Riesgo alto · {dias}d
            </span>
          )}
          {intentos === 2 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold
                             bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
              Último intento · {dias}d
            </span>
          )}
          {intentos < 2 && (
            <span className="text-[10px] text-gray-400">{dias}d en novedad</span>
          )}
        </div>
      </div>

      {/* Cliente + teléfono */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 text-sm leading-tight truncate">
            {nombre || '—'}
          </p>
          <p className="font-mono text-xs text-gray-500 mt-0.5">
            {order.customer_phone ?? 'Sin teléfono'}
          </p>
        </div>
        {order.cod_amount != null && (
          <div className="shrink-0 flex items-center gap-1 text-gray-700">
            <DollarSign className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-sm font-bold tabular-nums">
              {order.cod_amount.toLocaleString('es-DO')}
            </span>
          </div>
        )}
      </div>

      {/* Ubicación */}
      {(ubicacion || order.customer_address) && (
        <div className="flex items-start gap-1.5 text-gray-600">
          <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs truncate">{ubicacion || '—'}</p>
            {order.city && order.province && order.city !== order.province && (
              <p className="text-[10px] text-gray-400">{order.province}</p>
            )}
            {order.customer_address && (
              <p className="text-[10px] text-gray-400 truncate">{order.customer_address}</p>
            )}
          </div>
        </div>
      )}

      {/* Producto */}
      {order.product_summary && (
        <div className="flex items-start gap-1.5">
          <Package className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
          <p className="text-xs text-gray-600 line-clamp-2">{order.product_summary}</p>
        </div>
      )}

      {/* Motivo/estado */}
      <div className="flex flex-col gap-0.5">
        {novedadSrc && (
          <p className="text-[10px] text-gray-400 flex items-center gap-1">
            <Clock className="w-2.5 h-2.5 shrink-0" />
            {formatEventDate(novedadSrc)}
          </p>
        )}
        {order.raw_status && (
          <p className="text-xs text-gray-500 truncate" title={order.raw_status}>
            {order.raw_status}
          </p>
        )}
        {sug && (
          <span className={`self-start text-[10px] font-semibold px-1.5 py-0.5 rounded-full leading-tight
            ${sug.severity === 'critical'
              ? 'bg-red-200 text-red-800'
              : sug.severity === 'high'
                ? 'bg-orange-200 text-orange-800'
                : 'bg-amber-100 text-amber-700'
            }`}>
            {sug.text}
          </span>
        )}
      </div>

      {/* Botones de contacto — grandes para móvil */}
      {hasPhone && (
        <div className="grid grid-cols-2 gap-2">
          {waUrl && (
            <a href={waUrl} target="_blank" rel="noopener noreferrer"
               className="flex items-center justify-center gap-2
                          bg-green-500 hover:bg-green-600 active:bg-green-700
                          text-white text-sm font-bold px-3 py-3 rounded-xl
                          transition-colors shadow-sm">
              <MessageCircle className="w-5 h-5" />WhatsApp
            </a>
          )}
          {telUrl && (
            <a href={telUrl}
               className="flex items-center justify-center gap-2
                          bg-blue-500 hover:bg-blue-600 active:bg-blue-700
                          text-white text-sm font-bold px-3 py-3 rounded-xl
                          transition-colors shadow-sm">
              <Phone className="w-5 h-5" />Llamar
            </a>
          )}
        </div>
      )}

      {/* Acciones + Ver detalle */}
      <div className="space-y-2">
        {noSalv ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold
                           px-3 py-2 rounded-xl bg-gray-100 text-gray-500 w-full justify-center">
            <XCircle className="w-4 h-4" />No salvable
          </span>
        ) : isRecuperada ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold
                           px-3 py-2 rounded-xl bg-green-100 text-green-700 w-full justify-center">
            <CheckCircle2 className="w-4 h-4" />Recuperado
          </span>
        ) : busy ? (
          <div className="flex justify-center py-2">
            <Spinner className="w-5 h-5 text-red-500" />
          </div>
        ) : accion ? (
          <span className={`inline-flex items-center gap-1.5 text-sm font-semibold
                           px-3 py-2 rounded-xl w-full justify-center
                           ${ACTION_BADGE[accion]?.color ?? 'bg-gray-100 text-gray-600'}`}>
            <CheckCircle2 className="w-4 h-4" />
            {ACTION_BADGE[accion]?.label ?? accion}
          </span>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onContacted}
              className="flex items-center justify-center gap-1.5
                         bg-slate-100 hover:bg-slate-200 active:bg-slate-300
                         text-slate-700 text-sm font-medium px-3 py-2.5 rounded-xl
                         transition-colors">
              <CheckCircle2 className="w-4 h-4 shrink-0" />Contactado
            </button>
            <button
              onClick={onRescheduled}
              className="flex items-center justify-center gap-1.5
                         bg-indigo-100 hover:bg-indigo-200 active:bg-indigo-300
                         text-indigo-700 text-sm font-medium px-3 py-2.5 rounded-xl
                         transition-colors">
              <CalendarClock className="w-4 h-4 shrink-0" />Reprogramar
            </button>
            <button
              onClick={onNoAnswer}
              className="flex items-center justify-center gap-1.5
                         bg-amber-100 hover:bg-amber-200 active:bg-amber-300
                         text-amber-700 text-sm font-medium px-3 py-2.5 rounded-xl
                         transition-colors">
              <PhoneMissed className="w-4 h-4 shrink-0" />No responde
            </button>
            <button
              onClick={onNoSalvable}
              className="flex items-center justify-center gap-1.5
                         bg-red-100 hover:bg-red-200 active:bg-red-300
                         text-red-700 text-sm font-medium px-3 py-2.5 rounded-xl
                         transition-colors">
              <XCircle className="w-4 h-4 shrink-0" />No salv.
            </button>
            <button
              onClick={onRecuperada}
              className="col-span-2 flex items-center justify-center gap-1.5
                         bg-green-100 hover:bg-green-200 active:bg-green-300
                         text-green-700 text-sm font-medium px-3 py-2.5 rounded-xl
                         transition-colors">
              <CheckCircle2 className="w-4 h-4 shrink-0" />Recuperado
            </button>
          </div>
        )}

        <Link
          href={`/orders/${order.id}`}
          className="flex items-center justify-center gap-1.5 text-sm font-medium
                     text-red-600 hover:text-red-800 border border-red-200 hover:border-red-400
                     bg-white hover:bg-red-50 px-3 py-2.5 rounded-xl transition-colors w-full">
          <ExternalLink className="w-4 h-4" />
          Ver detalle
        </Link>
      </div>
    </div>
  )
}

// ── Subcomponente: Card móvil de entregada ────────────────────────────────────

function EntregadaCard({ order, delivered_at }: { order: Order; delivered_at: string }) {
  const intentos  = order.delivery_attempts ?? 0
  const ubicacion = order.city
    || order.province
    || (order.customer_address ? order.customer_address.slice(0, 30) : null)

  return (
    <div className="rounded-xl border border-green-200 bg-white p-4 space-y-3 shadow-sm">
      {/* Orden + tracking */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {order.order_number && (
            <p className="text-xs font-bold text-gray-400 mb-0.5">{order.order_number}</p>
          )}
          <p className="font-mono text-sm font-semibold text-gray-900 truncate">
            {order.tracking_number ?? '—'}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
          <span className="text-xs text-green-700 font-semibold">
            {formatEventDate(delivered_at)}
          </span>
        </div>
      </div>

      {/* Cliente */}
      <div>
        <p className="font-semibold text-gray-900 text-sm">{order.customer_name ?? '—'}</p>
        <p className="font-mono text-xs text-gray-500 mt-0.5">{order.customer_phone ?? '—'}</p>
      </div>

      {/* Ubicación */}
      {ubicacion && (
        <div className="flex items-start gap-1.5 text-gray-600">
          <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs truncate">{ubicacion}</p>
            {order.city && order.province && order.city !== order.province && (
              <p className="text-[10px] text-gray-400">{order.province}</p>
            )}
          </div>
        </div>
      )}

      {/* Fecha completa */}
      <p className="text-[10px] text-gray-400">
        {new Date(delivered_at).toLocaleDateString('es-DO', {
          day: '2-digit', month: 'short',
          hour: '2-digit', minute: '2-digit',
          timeZone: 'America/Santo_Domingo',
        })}
      </p>

      {/* Intentos previos */}
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center gap-1 text-xs font-bold
                         px-2.5 py-1 rounded-full tabular-nums
          ${intentos >= 3
            ? 'bg-red-100 text-red-700'
            : intentos === 2
              ? 'bg-orange-100 text-orange-700'
              : intentos === 1
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-gray-100 text-gray-500'
          }`}>
          {intentos} intento{intentos !== 1 ? 's' : ''} previos
        </span>
        {order.last_attempt_reason && (
          <p className="text-[10px] text-gray-400 truncate max-w-[120px]"
             title={order.last_attempt_reason}>
            {order.last_attempt_reason}
          </p>
        )}
      </div>

      <Link
        href={`/orders/${order.id}`}
        className="flex items-center justify-center gap-1.5 text-sm font-medium
                   text-green-600 hover:text-green-800 border border-green-200 hover:border-green-400
                   bg-white hover:bg-green-50 px-3 py-2.5 rounded-xl transition-colors w-full">
        <ExternalLink className="w-4 h-4" />
        Ver detalle
      </Link>
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function NovedadPage() {
  const searchParamsObj = useSearchParams()
  const trackingParam   = searchParamsObj.get('tracking')
  const rowRefs         = useRef<Map<string, HTMLTableRowElement>>(new Map())

  const [allOrders, setAllOrders]     = useState<Order[]>([])
  const [perf, setPerf]               = useState<NoveltyPerfData | null>(null)
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  const initNovedadTab = (): Tab => {
    const f = searchParamsObj.get('filter')
    if (f === '2-intentos') return 'dos'
    return 'all'
  }
  const [activeTab, setActiveTab]     = useState<Tab>(initNovedadTab)
  const [searchQuery, setSearchQuery] = useState('')

  const [actionMap, setActionMap]   = useState<Record<string, string>>({})
  const [loadingRow, setLoadingRow] = useState<Record<string, boolean>>({})
  const [taskMap, setTaskMap]       = useState<Record<string, string>>({})
  const [recuperadasDbOrders, setRecuperadasDbOrders] = useState<RecuperadaEntry[]>([])
  const [entregadasFilter, setEntregadasFilter] = useState<'hoy' | 'ayer' | null>(null)
  const [currentPage, setCurrentPage] = useState(1)

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [ordersRes, perfRes, tasksRes, recuperadasRes]: [OrdersResponse, NoveltyPerfData, { tasks: any[] }, RecuperadaEntry[]] =
        await Promise.all([
          fetch('/api/orders?status=novedad&limit=200&page=1').then(r => r.json()),
          fetch('/api/novedad/performance').then(r => r.json()),
          fetch('/api/my-tasks').then(r => r.json()),
          fetch('/api/novedad/recuperadas').then(r => r.json()),
        ])

      setAllOrders(ordersRes.data ?? [])
      setPerf(perfRes)
      setRecuperadasDbOrders(Array.isArray(recuperadasRes) ? recuperadasRes : [])

      const map: Record<string, string> = {}
      for (const t of (tasksRes.tasks ?? [])) {
        if (t.order_id && (t.task_type === 'novedad' || t.task_type === 'recovery')) {
          map[t.order_id] = t.id
        }
      }
      setTaskMap(map)
      setLastRefresh(new Date())
    } catch (err) {
      console.error('[novedad/fetchData]', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 3 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Scroll al pedido indicado por ?tracking=
  useEffect(() => {
    if (!trackingParam || allOrders.length === 0) return
    const match = allOrders.find(o => o.tracking_number === trackingParam)
    if (match) setTimeout(() => {
      rowRefs.current.get(match.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
  }, [allOrders, trackingParam])

  // Reset paginación al cambiar tab, búsqueda o filtro de fecha
  useEffect(() => { setCurrentPage(1) }, [activeTab, searchQuery, entregadasFilter])

  // ── Acciones ──────────────────────────────────────────────────────────────

  function handleTabChange(tab: Tab) {
    setActiveTab(tab)
    if (tab !== 'recuperadas') setEntregadasFilter(null)
    setCurrentPage(1)
  }

  async function patchTask(orderId: string, body: Record<string, unknown>) {
    const taskId = taskMap[orderId]
    if (!taskId) return
    await fetch(`/api/tasks/${taskId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
  }

  async function postAction(
    orderId: string,
    actionKey: string,
    actionType: ActionType,
    contactResult?: ContactResult,
  ) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      const taskBody = actionKey === 'rescheduled'
        ? { status: 'completed', result: 'rescheduled' }
        : { status: 'in_progress' }
      await Promise.all([
        fetch(`/api/orders/${orderId}/actions`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action_type: actionType, contact_result: contactResult ?? null }),
        }),
        patchTask(orderId, taskBody),
      ])
      setActionMap(prev => ({ ...prev, [orderId]: actionKey }))
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  async function markNoSalvable(orderId: string) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      await Promise.all([
        fetch(`/api/orders/${orderId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ follow_up_result: 'no_action' }),
        }),
        patchTask(orderId, { status: 'completed', result: 'no_action' }),
      ])
      setAllOrders(prev =>
        prev.map(o => o.id === orderId ? { ...o, follow_up_result: 'no_action' } : o)
      )
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  async function markRecuperada(orderId: string) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      await Promise.all([
        fetch(`/api/orders/${orderId}/actions`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action_type: 'recovered' }),
        }),
        fetch(`/api/orders/${orderId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ follow_up_result: 'recovered' }),
        }),
        patchTask(orderId, { status: 'completed', result: 'recovered' }),
      ])
      setAllOrders(prev =>
        prev.map(o => o.id === orderId ? { ...o, follow_up_result: 'recovered' } : o)
      )
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  // ── Datos derivados ────────────────────────────────────────────────────────

  const activeOrders = useMemo(
    () => allOrders.filter(o => o.follow_up_result !== 'no_action' && o.follow_up_result !== 'recovered'),
    [allOrders],
  )
  const noSalvables = useMemo(
    () => allOrders.filter(o => o.follow_up_result === 'no_action'),
    [allOrders],
  )
  const dosExactos = useMemo(
    () => activeOrders.filter(o => (o.delivery_attempts ?? 0) === 2),
    [activeOrders],
  )
  const tresOmas = useMemo(
    () => activeOrders.filter(o => (o.delivery_attempts ?? 0) >= 3),
    [activeOrders],
  )
  const reprogramadosSesion = useMemo(
    () => activeOrders.filter(o => actionMap[o.id] === 'rescheduled'),
    [activeOrders, actionMap],
  )

  const displayedOrders = useMemo(() => {
    if (activeTab === 'recuperadas') return []

    let base: Order[]
    switch (activeTab) {
      case 'dos':           base = dosExactos;          break
      case 'tres-mas':      base = tresOmas;             break
      case 'reprogramados': base = reprogramadosSesion;  break
      case 'no-salvables':  base = noSalvables;          break
      default:              base = activeOrders
    }

    base = [...base].sort((a, b) => (b.delivery_attempts ?? 0) - (a.delivery_attempts ?? 0))

    if (!searchQuery.trim()) return base
    const q = searchQuery.toLowerCase()
    return base.filter(o =>
      (o.tracking_number  ?? '').toLowerCase().includes(q) ||
      (o.customer_name    ?? '').toLowerCase().includes(q) ||
      (o.customer_phone   ?? '').toLowerCase().includes(q) ||
      (o.city             ?? '').toLowerCase().includes(q) ||
      (o.raw_status       ?? '').toLowerCase().includes(q)
    )
  }, [activeOrders, noSalvables, dosExactos, tresOmas, reprogramadosSesion, activeTab, searchQuery])

  const tabCounts = useMemo<Record<Tab, number>>(() => ({
    all:            activeOrders.length,
    dos:            dosExactos.length,
    'tres-mas':     tresOmas.length,
    reprogramados:  reprogramadosSesion.length,
    'no-salvables': noSalvables.length,
    recuperadas:    recuperadasDbOrders.length,
  }), [activeOrders, dosExactos, tresOmas, reprogramadosSesion, noSalvables, recuperadasDbOrders])

  const displayedRecuperadas = useMemo(() => {
    let entries = [...recuperadasDbOrders]
    if (entregadasFilter) {
      const todayMs     = rdMidnightUTC(0)
      const yesterdayMs = rdMidnightUTC(-1)
      entries = entries.filter(e => {
        const ts = new Date(e.delivered_at).getTime()
        if (entregadasFilter === 'hoy') return ts >= todayMs
        return ts >= yesterdayMs && ts < todayMs
      })
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      entries = entries.filter(e =>
        (e.order.tracking_number ?? '').toLowerCase().includes(q) ||
        (e.order.customer_name   ?? '').toLowerCase().includes(q) ||
        (e.order.customer_phone  ?? '').toLowerCase().includes(q) ||
        (e.order.city            ?? '').toLowerCase().includes(q)
      )
    }
    return entries
  }, [recuperadasDbOrders, entregadasFilter, searchQuery])

  // Paginación
  const pagedOrders = useMemo(
    () => displayedOrders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [displayedOrders, currentPage],
  )
  const totalPagesNovedad = Math.ceil(displayedOrders.length / PAGE_SIZE)

  const pagedRecuperadas = useMemo(
    () => displayedRecuperadas.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [displayedRecuperadas, currentPage],
  )
  const totalPagesRecuperadas = Math.ceil(displayedRecuperadas.length / PAGE_SIZE)

  const repSesion = reprogramadosSesion.length

  // ── Render ─────────────────────────────────────────────────────────────────

  const totalPages = activeTab === 'recuperadas' ? totalPagesRecuperadas : totalPagesNovedad
  const activeCount = activeTab === 'recuperadas' ? displayedRecuperadas.length : displayedOrders.length

  return (
    <div className="space-y-3 md:space-y-4">

      {/* ── Banner — compacto en móvil ── */}
      <div className="relative overflow-hidden rounded-2xl
                      bg-gradient-to-r from-red-500 to-rose-600
                      border-2 border-red-400 shadow-lg shadow-red-200/50">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white" />
          <div className="absolute -right-2 -bottom-10 w-24 h-24 rounded-full bg-white" />
        </div>
        <div className="relative px-4 py-3 md:px-6 md:py-5">
          {/* Fila principal */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-9 h-9 md:w-12 md:h-12 bg-white/20 rounded-xl shrink-0">
                <AlertCircle className="w-5 h-5 md:w-6 md:h-6 text-white" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl md:text-2xl font-black text-white tabular-nums">
                    {loading ? '…' : activeOrders.length.toLocaleString()}
                  </h1>
                  {!loading && activeOrders.length > 0 && (
                    <span className="flex items-center gap-1.5 bg-white/20 text-white
                                     text-[10px] md:text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">
                      <span className="w-1.5 h-1.5 rounded-full bg-white" />
                      PENDIENTES
                    </span>
                  )}
                </div>
                <p className="text-white font-semibold text-sm md:text-base">Gestión de novedades</p>
                {/* Subtítulo solo en desktop */}
                <p className="hidden md:block text-red-100 text-xs mt-0.5">
                  Coordina reentregas y recupera pedidos antes de que lleguen a devolución
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* Reprogramados — solo desktop */}
              {repSesion > 0 && (
                <span className="hidden md:block text-sm text-green-200 font-semibold">
                  ✓ {repSesion} reprogramado{repSesion !== 1 ? 's' : ''} esta sesión
                </span>
              )}
              <p className="text-red-100 text-[10px] md:text-xs hidden sm:block">
                {lastRefresh.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
              </p>
              <button
                onClick={fetchData}
                disabled={loading}
                className="flex items-center gap-1.5 bg-white/20 hover:bg-white/30 text-white
                           text-xs md:text-sm font-medium px-3 py-2 rounded-lg transition-colors
                           disabled:opacity-50 min-h-[36px]"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Refrescar</span>
              </button>
            </div>
          </div>

          {/* Reprogramados en móvil — fila separada */}
          {repSesion > 0 && (
            <p className="md:hidden text-xs text-green-200 font-semibold mt-2">
              ✓ {repSesion} reprogramado{repSesion !== 1 ? 's' : ''} esta sesión
            </p>
          )}
        </div>
      </div>

      {/* ── Pipeline logístico ── */}
      <FlujoKpis />

      {/* ── Métricas del agente hoy ── */}
      {perf && (
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 md:px-5 md:py-3.5 shadow-sm">
          <div className="flex items-center gap-2 md:gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 shrink-0">
              <TrendingUp className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Mi día</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap flex-1">
              {([
                { label: 'Trabajados',    count: perf.novedadesTrabajadasHoy,  cls: 'bg-blue-100   text-blue-700'   },
                { label: 'Reprogramados', count: perf.pedidosReprogramadosHoy, cls: 'bg-indigo-100 text-indigo-700' },
                { label: 'Contactados',   count: perf.pedidosContactadosHoy,   cls: 'bg-slate-100  text-slate-700'  },
                { label: 'No responden',  count: perf.pedidosNoRespondenHoy,   cls: 'bg-amber-100  text-amber-700'  },
                { label: 'No salvables',  count: perf.pedidosNoSalvablesHoy,   cls: 'bg-red-100    text-red-700'    },
              ] as const).map(({ label, count, cls }) => (
                <div key={label} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${cls}`}>
                  <span className="text-sm font-black tabular-nums leading-none">{count}</span>
                  <span className="text-[11px] font-medium">{label}</span>
                </div>
              ))}
            </div>
            {perf.tasaRecuperacionHoy !== null ? (
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg shrink-0
                ${perf.tasaRecuperacionHoy >= 70
                  ? 'bg-green-100 text-green-700'
                  : perf.tasaRecuperacionHoy >= 40
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-red-100 text-red-700'
                }`}>
                <span className="text-[11px] font-semibold opacity-60 leading-none">Recuperación</span>
                <span className="text-xl font-black tabular-nums leading-none">
                  {perf.tasaRecuperacionHoy}%
                </span>
              </div>
            ) : (
              <span className="text-xs text-gray-400 shrink-0">Sin gestiones hoy</span>
            )}
          </div>
        </div>
      )}

      {/* ── Dashboard operativo ── */}
      <div className="space-y-2">

        {/* Fila 1: tarjetas de acción — 2 columnas en móvil, 3 en desktop */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 md:gap-3">
          {([
            {
              tab:   'all'      as Tab,
              count: activeOrders.length,
              label: 'Pendientes',
              sub:   'Total activos en novedad',
              Icon:  AlertCircle,
              base:  'border-red-200 bg-red-50 text-red-700',
              active:'border-red-400 bg-red-100 text-red-800 ring-2 ring-red-300/50',
              hover: 'hover:bg-red-100',
            },
            {
              tab:   'dos'      as Tab,
              count: dosExactos.length,
              label: '2 intentos',
              sub:   'Último intento disponible',
              Icon:  RotateCcw,
              base:  'border-orange-200 bg-orange-50 text-orange-700',
              active:'border-orange-400 bg-orange-100 text-orange-800 ring-2 ring-orange-300/50',
              hover: 'hover:bg-orange-100',
            },
            {
              tab:   'tres-mas' as Tab,
              count: tresOmas.length,
              label: 'Riesgo alto (3+)',
              sub:   'Alto riesgo de devolución',
              Icon:  ShieldAlert,
              base:  'border-rose-200 bg-rose-50 text-rose-700',
              active:'border-rose-400 bg-rose-100 text-rose-800 ring-2 ring-rose-300/50',
              hover: 'hover:bg-rose-100',
            },
          ] as const).map(({ tab, count, label, sub, Icon, base, active, hover }, idx) => (
            <button
              key={tab}
              onClick={() => handleTabChange(tab)}
              // En móvil, "Pendientes" ocupa 2 columnas para destacarlo
              className={`flex items-center gap-2 md:gap-3 p-3 md:p-4 rounded-xl border-2 text-left transition-all
                ${idx === 0 ? 'col-span-2 md:col-span-1' : ''}
                ${activeTab === tab ? active : `${base} ${hover}`}`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-2xl md:text-3xl font-black tabular-nums leading-none">{count}</p>
                <p className="text-xs md:text-sm font-bold mt-1">{label}</p>
                <p className="text-[10px] md:text-xs opacity-60 mt-0.5 truncate">{sub}</p>
              </div>
              <Icon className="w-6 h-6 md:w-7 md:h-7 opacity-25 shrink-0" />
            </button>
          ))}
        </div>

        {/* Fila 2: métricas informativas — 3 columnas en móvil (scroll), 6 en desktop */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">

          {/* Entregadas hoy */}
          <button
            onClick={() => {
              setActiveTab('recuperadas')
              setEntregadasFilter(f => (activeTab === 'recuperadas' && f === 'hoy') ? null : 'hoy')
              setCurrentPage(1)
            }}
            className={`flex flex-col items-center justify-center p-2.5 md:p-3 rounded-lg border transition-all
              ${activeTab === 'recuperadas' && entregadasFilter === 'hoy'
                ? 'bg-green-100 border-green-400 ring-2 ring-green-300/50 text-green-800'
                : 'bg-green-50 text-green-700 border-green-100 hover:bg-green-100 hover:border-green-300 cursor-pointer'
              }`}
          >
            <p className="text-lg md:text-xl font-black tabular-nums leading-none">{perf?.recuperadasHoy ?? '…'}</p>
            <p className="text-[9px] md:text-[10px] font-medium mt-1 text-center leading-tight opacity-80">Entregadas hoy</p>
          </button>

          {/* Entregadas ayer */}
          <button
            onClick={() => {
              setActiveTab('recuperadas')
              setEntregadasFilter(f => (activeTab === 'recuperadas' && f === 'ayer') ? null : 'ayer')
              setCurrentPage(1)
            }}
            className={`flex flex-col items-center justify-center p-2.5 md:p-3 rounded-lg border transition-all
              ${activeTab === 'recuperadas' && entregadasFilter === 'ayer'
                ? 'bg-green-100 border-green-400 ring-2 ring-green-300/50 text-green-800'
                : 'bg-green-50/60 text-green-600 border-green-100 hover:bg-green-100 hover:border-green-300 cursor-pointer'
              }`}
          >
            <p className="text-lg md:text-xl font-black tabular-nums leading-none">{perf?.recuperadasAyer ?? '…'}</p>
            <p className="text-[9px] md:text-[10px] font-medium mt-1 text-center leading-tight opacity-80">Entregadas ayer</p>
          </button>

          {([
            {
              label: 'Reprogramados hoy',
              count: perf?.pedidosReprogramadosHoy ?? '…',
              cls:   'bg-indigo-50 text-indigo-700 border-indigo-100',
            },
            {
              label: 'Contactados hoy',
              count: perf?.pedidosContactadosHoy ?? '…',
              cls:   'bg-blue-50 text-blue-700 border-blue-100',
            },
            {
              label: 'Sin respuesta hoy',
              count: perf?.pedidosNoRespondenHoy ?? '…',
              cls:   'bg-amber-50 text-amber-700 border-amber-100',
            },
            {
              label: 'No salvables hoy',
              count: perf?.pedidosNoSalvablesHoy ?? '…',
              cls:   'bg-gray-50 text-gray-600 border-gray-200',
            },
          ] as const).map(({ label, count, cls }) => (
            <div key={label}
                 className={`flex flex-col items-center justify-center p-2.5 md:p-3 rounded-lg border ${cls}`}>
              <p className="text-lg md:text-xl font-black tabular-nums leading-none">{count}</p>
              <p className="text-[9px] md:text-[10px] font-medium mt-1 text-center leading-tight opacity-80">{label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Sin novedades activas ── */}
      {!loading && activeOrders.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-6 text-center">
          <p className="text-green-700 font-medium">No hay pedidos con novedad activos</p>
          <p className="text-green-600 text-sm mt-1">
            Los pedidos aparecerán aquí cuando su estado sea NOVEDAD
          </p>
        </div>
      )}

      {/* ── Tabla/Cards + buscador + tabs ── */}
      {(loading || allOrders.length > 0 || recuperadasDbOrders.length > 0) && (
        <div className="bg-white rounded-xl border-2 border-red-200 overflow-hidden shadow-sm">

          {/* Info header */}
          <div className="px-4 py-2.5 md:px-5 md:py-3 bg-red-50 border-b border-red-200 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            <p className="text-xs md:text-sm font-semibold text-red-800">
              Prioriza contactar primero los pedidos con 2 o más intentos
            </p>
          </div>

          {/* Buscador */}
          <div className="px-3 py-2.5 md:px-4 md:py-3 border-b border-red-100 bg-white">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Buscar guía, nombre, teléfono, ciudad…"
                className="w-full pl-9 pr-4 py-2.5 md:py-2 text-sm border border-gray-200 rounded-lg
                           focus:outline-none focus:ring-2 focus:ring-red-300 focus:border-red-300
                           placeholder:text-gray-400"
              />
            </div>
          </div>

          {/* Tabs de filtro — touch-friendly */}
          {!loading && (
            <div className="flex border-b border-red-100 overflow-x-auto">
              {TAB_META.map(({ tab, label }) => {
                const isActive = activeTab === tab
                const count = tab === 'recuperadas' && entregadasFilter
                  ? displayedRecuperadas.length
                  : tabCounts[tab]
                return (
                  <button
                    key={tab}
                    onClick={() => handleTabChange(tab)}
                    className={`flex items-center gap-1.5 px-3 md:px-4 py-3 md:py-2.5
                                text-xs font-semibold border-b-2 transition-colors
                                whitespace-nowrap shrink-0 min-h-[44px]
                      ${isActive
                        ? 'border-red-500 text-red-700 bg-red-50/60'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                      }`}
                  >
                    {label}
                    {tab === 'recuperadas' && entregadasFilter && (
                      <span className="text-[9px] bg-green-500 text-white px-1.5 py-0.5 rounded-full font-bold">
                        {entregadasFilter}
                      </span>
                    )}
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full
                      ${isActive
                        ? 'bg-red-500 text-white'
                        : 'bg-gray-100 text-gray-500'
                      }`}>
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Vista vacía de tab */}
          {!loading && activeCount === 0 && (allOrders.length > 0 || recuperadasDbOrders.length > 0) && (
            <div className="px-5 py-10 text-center">
              <p className="text-gray-500 font-medium">
                {searchQuery
                  ? `Sin resultados para "${searchQuery}"`
                  : 'No hay pedidos en esta categoría'}
              </p>
              <button
                onClick={() => { handleTabChange('all'); setSearchQuery('') }}
                className="text-red-500 text-sm mt-2 hover:underline"
              >
                Ver todos los pendientes
              </button>
            </div>
          )}

          {/* Spinner */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Spinner className="w-6 h-6 text-red-500" />
            </div>
          )}

          {/* ── MOBILE: Cards novedades activas (< md) ── */}
          {!loading && activeTab !== 'recuperadas' && pagedOrders.length > 0 && (
            <div className="md:hidden divide-y divide-red-50">
              <div className="p-3 space-y-3">
                {pagedOrders.map(order => {
                  const nombre    = order.customer_name ?? ''
                  const intentos  = order.delivery_attempts ?? 0
                  const accion    = actionMap[order.id]
                  const busy      = !!loadingRow[order.id]

                  const lastRawFecha = order.tracking_novedades?.at(-1)?.fecha ?? null
                  const novedadSrc   = order.last_novedad_at ?? (lastRawFecha ? parseEFIDate(lastRawFecha) : null)

                  const dias = daysInNovedad(order)
                  const sug  = intentos === 2 ? supervisorSuggestion(dias) : null

                  const isHighlighted = !!(trackingParam && order.tracking_number === trackingParam)

                  return (
                    <NovedadCard
                      key={order.id}
                      order={order}
                      accion={accion}
                      busy={busy}
                      novedadSrc={novedadSrc}
                      dias={dias}
                      sug={sug}
                      onContacted={() => postAction(order.id, 'contacted', 'contacted')}
                      onRescheduled={() => postAction(order.id, 'rescheduled', 'rescheduled')}
                      onNoAnswer={() => postAction(order.id, 'no_answer', 'contacted', 'no_answer')}
                      onNoSalvable={() => markNoSalvable(order.id)}
                      onRecuperada={() => markRecuperada(order.id)}
                      isHighlighted={isHighlighted}
                    />
                  )
                })}
              </div>
            </div>
          )}

          {/* ── DESKTOP: Tabla novedades activas (≥ md) ── */}
          {!loading && activeTab !== 'recuperadas' && pagedOrders.length > 0 && (
            <table className="hidden md:table w-full text-sm">
              <thead className="bg-red-50/60 border-b border-red-100">
                <tr>
                  {['Guía', 'Cliente', 'Ciudad', 'Intentos', 'Motivo', 'Contactar', 'Acción', ''].map(h => (
                    <th key={h}
                        className="px-3 py-3 text-left text-xs font-semibold text-red-800 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-red-50">
                {pagedOrders.map(order => {
                  const nombre    = order.customer_name ?? ''
                  const intentos  = order.delivery_attempts ?? 0
                  const waUrl     = whatsAppUrl(order.customer_phone, buildNovedadMsg(nombre, order.product_summary))
                  const telUrl    = callUrl(order.customer_phone)
                  const hasPhone  = !!order.customer_phone
                  const accion    = actionMap[order.id]
                  const busy      = !!loadingRow[order.id]
                  const noSalv       = order.follow_up_result === 'no_action'
                  const isRecuperada = order.follow_up_result === 'recovered'

                  const lastRawFecha = order.tracking_novedades?.at(-1)?.fecha ?? null
                  const novedadSrc   = order.last_novedad_at ?? (lastRawFecha ? parseEFIDate(lastRawFecha) : null)

                  const dias = daysInNovedad(order)
                  const sug  = intentos === 2 ? supervisorSuggestion(dias) : null

                  const rowClass = noSalv || isRecuperada
                    ? 'bg-gray-50/60'
                    : intentos >= 3
                      ? 'bg-red-50/30 hover:bg-red-50/60'
                      : intentos === 2
                        ? 'bg-orange-50/20 hover:bg-orange-50/40'
                        : 'hover:bg-gray-50/40'

                  const isHighlighted = trackingParam && order.tracking_number === trackingParam

                  return (
                    <tr
                      key={order.id}
                      ref={el => { if (el) rowRefs.current.set(order.id, el) }}
                      className={`transition-colors group ${rowClass}
                        ${isHighlighted ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/60' : ''}`}
                    >

                      {/* Guía */}
                      <td className="px-3 py-2.5">
                        <p className="font-mono text-xs font-semibold text-gray-900 whitespace-nowrap">
                          {order.tracking_number ?? '—'}
                        </p>
                        {order.order_number && (
                          <p className="font-mono text-[10px] text-gray-400 mt-0.5">
                            {order.order_number}
                          </p>
                        )}
                        {novedadSrc && (
                          <p className="text-[10px] text-gray-400 mt-0.5 whitespace-nowrap">
                            {daysSince(novedadSrc)}
                          </p>
                        )}
                      </td>

                      {/* Cliente */}
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[150px]">
                          {nombre || '—'}
                        </p>
                        <p className="font-mono text-xs text-gray-500 mt-0.5">
                          {order.customer_phone ?? '—'}
                        </p>
                      </td>

                      {/* Ciudad */}
                      <td className="px-3 py-2.5">
                        {(() => {
                          const ubicacion = order.city
                            || order.province
                            || (order.customer_address ? order.customer_address.slice(0, 22) : null)
                          return (
                            <div className="flex items-start gap-1 text-gray-600">
                              <MapPin className="w-3 h-3 text-gray-400 shrink-0 mt-0.5" />
                              <span className="text-xs truncate max-w-[100px]">{ubicacion || '—'}</span>
                            </div>
                          )
                        })()}
                        {order.city && order.province && order.city !== order.province && (
                          <p className="text-[10px] text-gray-400 mt-0.5 ml-4 truncate max-w-[100px]">
                            {order.province}
                          </p>
                        )}
                      </td>

                      {/* Intentos + alerta */}
                      <td className="px-3 py-2.5">
                        <div className="flex flex-col gap-1">
                          <span className={`text-sm font-black tabular-nums
                            ${intentos >= 3 ? 'text-red-600'
                              : intentos === 2 ? 'text-orange-600'
                              : 'text-yellow-600'}`}>
                            {intentos}
                          </span>
                          {intentos >= 3 ? (
                            <>
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold
                                               bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">
                                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                                Riesgo alto
                              </span>
                              <span className="text-[10px] text-red-600 font-medium leading-tight">
                                {dias}d en novedad
                              </span>
                            </>
                          ) : intentos === 2 ? (
                            <>
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold
                                               bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">
                                <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
                                Último intento
                              </span>
                              <span className="text-[10px] text-gray-400 tabular-nums">
                                {dias}d en novedad
                              </span>
                              {sug && (
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full leading-tight
                                  ${sug.severity === 'critical'
                                    ? 'bg-red-200 text-red-800'
                                    : sug.severity === 'high'
                                      ? 'bg-orange-200 text-orange-800'
                                      : 'bg-amber-100 text-amber-700'
                                  }`}>
                                  {sug.text}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold
                                             bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-full">
                              Pendiente
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Motivo */}
                      <td className="px-3 py-2.5 max-w-[120px]">
                        {novedadSrc && (
                          <p className="text-[10px] text-gray-400 mb-0.5 flex items-center gap-1">
                            <Clock className="w-2.5 h-2.5 shrink-0" />
                            {formatEventDate(novedadSrc)}
                          </p>
                        )}
                        <p className="text-xs text-gray-500 truncate" title={order.raw_status ?? ''}>
                          {order.raw_status ?? '—'}
                        </p>
                      </td>

                      {/* Contactar */}
                      <td className="px-3 py-2.5">
                        {hasPhone ? (
                          <div className="flex items-center gap-1.5">
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

                      {/* Acción */}
                      <td className="px-3 py-2.5">
                        {noSalv ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold
                                           px-2.5 py-1 rounded-full bg-gray-100 text-gray-500">
                            <XCircle className="w-3 h-3" />No salvable
                          </span>
                        ) : isRecuperada ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold
                                           px-2.5 py-1 rounded-full bg-green-100 text-green-700">
                            <CheckCircle2 className="w-3 h-3" />Recuperado
                          </span>
                        ) : busy ? (
                          <Spinner className="w-4 h-4 text-red-500" />
                        ) : accion ? (
                          <span className={`inline-flex items-center gap-1 text-xs font-semibold
                                           px-2.5 py-1 rounded-full
                                           ${ACTION_BADGE[accion]?.color ?? 'bg-gray-100 text-gray-600'}`}>
                            <CheckCircle2 className="w-3 h-3" />
                            {ACTION_BADGE[accion]?.label ?? accion}
                          </span>
                        ) : (
                          <div className="grid grid-cols-2 gap-1">
                            <button
                              onClick={() => postAction(order.id, 'contacted', 'contacted')}
                              className="flex items-center gap-1 bg-slate-100 hover:bg-slate-200
                                         text-slate-700 text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <CheckCircle2 className="w-3 h-3 shrink-0" />Contactado
                            </button>
                            <button
                              onClick={() => postAction(order.id, 'rescheduled', 'rescheduled')}
                              className="flex items-center gap-1 bg-indigo-100 hover:bg-indigo-200
                                         text-indigo-700 text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <CalendarClock className="w-3 h-3 shrink-0" />Reprogramar
                            </button>
                            <button
                              onClick={() => postAction(order.id, 'no_answer', 'contacted', 'no_answer')}
                              className="flex items-center gap-1 bg-amber-100 hover:bg-amber-200
                                         text-amber-700 text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <PhoneMissed className="w-3 h-3 shrink-0" />No resp.
                            </button>
                            <button
                              onClick={() => markNoSalvable(order.id)}
                              className="flex items-center gap-1 bg-red-100 hover:bg-red-200
                                         text-red-700 text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <XCircle className="w-3 h-3 shrink-0" />No salv.
                            </button>
                            <button
                              onClick={() => markRecuperada(order.id)}
                              className="col-span-2 flex items-center justify-center gap-1
                                         bg-green-100 hover:bg-green-200 text-green-700
                                         text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <CheckCircle2 className="w-3 h-3 shrink-0" />Recuperado
                            </button>
                          </div>
                        )}
                      </td>

                      {/* Ver detalle */}
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/orders/${order.id}`}
                          className="inline-flex items-center gap-1 text-xs font-medium
                                     text-red-600 hover:text-red-800 whitespace-nowrap hover:underline"
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
          )}

          {/* ── MOBILE: Cards entregadas (< md) ── */}
          {!loading && activeTab === 'recuperadas' && pagedRecuperadas.length > 0 && (
            <div className="md:hidden p-3 space-y-3">
              {pagedRecuperadas.map(({ order, delivered_at }) => (
                <EntregadaCard key={order.id} order={order} delivered_at={delivered_at} />
              ))}
            </div>
          )}

          {/* ── DESKTOP: Tabla ✓ Entregadas (≥ md) ── */}
          {!loading && activeTab === 'recuperadas' && pagedRecuperadas.length > 0 && (
            <table className="hidden md:table w-full text-sm">
              <thead className="bg-green-50/60 border-b border-green-100">
                <tr>
                  {['Guía', 'Cliente', 'Teléfono', 'Ubicación', 'Entregado', 'Intentos previos', ''].map(h => (
                    <th key={h}
                        className="px-3 py-3 text-left text-xs font-semibold text-green-800 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-green-50">
                {pagedRecuperadas.map(({ order, delivered_at }) => {
                  const intentos = order.delivery_attempts ?? 0
                  const ubicacion = order.city
                    || order.province
                    || (order.customer_address ? order.customer_address.slice(0, 28) : null)

                  return (
                    <tr key={order.id} className="hover:bg-green-50/30 transition-colors">

                      <td className="px-3 py-2.5">
                        <p className="font-mono text-xs font-semibold text-gray-900 whitespace-nowrap">
                          {order.tracking_number ?? '—'}
                        </p>
                        {order.order_number && (
                          <p className="font-mono text-[10px] text-gray-400 mt-0.5">
                            {order.order_number}
                          </p>
                        )}
                      </td>

                      <td className="px-3 py-2.5">
                        <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[160px]">
                          {order.customer_name ?? '—'}
                        </p>
                      </td>

                      <td className="px-3 py-2.5">
                        <p className="font-mono text-xs text-gray-600">
                          {order.customer_phone ?? '—'}
                        </p>
                      </td>

                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-1 text-gray-600">
                          <MapPin className="w-3 h-3 text-gray-400 shrink-0 mt-0.5" />
                          <span className="text-xs truncate max-w-[120px]">{ubicacion || '—'}</span>
                        </div>
                        {order.city && order.province && order.city !== order.province && (
                          <p className="text-[10px] text-gray-400 mt-0.5 ml-4 truncate max-w-[120px]">
                            {order.province}
                          </p>
                        )}
                      </td>

                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                          <span className="text-xs text-green-700 font-semibold">
                            {formatEventDate(delivered_at)}
                          </span>
                        </div>
                        <p className="text-[10px] text-gray-400 mt-0.5 ml-4">
                          {new Date(delivered_at).toLocaleDateString('es-DO', {
                            day: '2-digit', month: 'short',
                            hour: '2-digit', minute: '2-digit',
                            timeZone: 'America/Santo_Domingo',
                          })}
                        </p>
                      </td>

                      <td className="px-3 py-2.5">
                        <span className={`inline-flex items-center gap-1 text-xs font-bold
                                         px-2 py-0.5 rounded-full tabular-nums
                          ${intentos >= 3
                            ? 'bg-red-100 text-red-700'
                            : intentos === 2
                              ? 'bg-orange-100 text-orange-700'
                              : intentos === 1
                                ? 'bg-yellow-100 text-yellow-700'
                                : 'bg-gray-100 text-gray-500'
                          }`}>
                          {intentos} intento{intentos !== 1 ? 's' : ''}
                        </span>
                        {order.last_attempt_reason && (
                          <p className="text-[10px] text-gray-400 mt-0.5 truncate max-w-[100px]"
                             title={order.last_attempt_reason}>
                            {order.last_attempt_reason}
                          </p>
                        )}
                      </td>

                      <td className="px-3 py-2.5">
                        <Link
                          href={`/orders/${order.id}`}
                          className="inline-flex items-center gap-1 text-xs font-medium
                                     text-green-600 hover:text-green-800 whitespace-nowrap hover:underline"
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
          )}

          {/* Paginación */}
          {!loading && totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 md:px-5 border-t border-red-100 bg-red-50/40">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg
                           border border-red-200 text-red-700 bg-white hover:bg-red-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors
                           min-h-[40px]"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Anterior
              </button>
              <span className="text-xs text-gray-500 tabular-nums text-center">
                <span className="font-bold text-gray-800">{currentPage}</span>/{' '}
                <span className="font-bold text-gray-800">{totalPages}</span>
                <span className="hidden sm:inline">
                  {' '}·{' '}
                  <span className="text-gray-400">
                    {activeCount} resultado{activeCount !== 1 ? 's' : ''}
                  </span>
                </span>
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg
                           border border-red-200 text-red-700 bg-white hover:bg-red-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors
                           min-h-[40px]"
              >
                Siguiente
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {!loading && allOrders.length > 200 && (
            <div className="px-5 py-3 bg-red-50 border-t border-red-100 text-center">
              <p className="text-xs text-red-700">
                Mostrando 200 de más pedidos.{' '}
                <Link href="/orders?status=novedad" className="font-semibold underline">
                  Ver todos en Pedidos
                </Link>
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Flujo recomendado ── */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 md:px-5 md:py-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          <strong className="text-gray-700">Flujo recomendado:</strong>{' '}
          Envía WhatsApp o llama para coordinar la nueva entrega →
          Registra &quot;Reprogramar&quot; cuando el cliente confirme una nueva fecha →
          Si no responde en 2 intentos, marca como &quot;No salv.&quot; para gestionar la devolución.
        </p>
      </div>
    </div>
  )
}
