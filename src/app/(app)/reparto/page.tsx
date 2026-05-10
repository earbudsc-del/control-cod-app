'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { whatsAppUrl, callUrl, formatEventDate } from '@/lib/utils'
import type { ActionType, ContactResult, Order } from '@/types'
import {
  Bike, RefreshCw, MessageCircle, Phone,
  CheckCircle2, PhoneMissed, ExternalLink,
  MapPin, Search, TrendingUp, ShieldAlert,
  AlertTriangle, ArrowUpCircle, Clock, Package,
  ChevronLeft, ChevronRight,
} from 'lucide-react'
import { horasEnTransito } from '@/lib/transit-helpers'
import { FlujoKpis } from '@/components/shared/flujo-kpis'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type Tab = 'all' | 'critico' | 'riesgo' | 'normal' | 'entregados'

interface RepartoPerfData {
  entregadosHoy:   number
  entregadosAyer:  number
  contactadosHoy:  number
  incidenciasHoy:  number
  escaladosHoy:    number
  criticosActivos: number
}

interface DeliveredEntry {
  order:            Order
  reported_at:      string
  courier_confirmed: boolean
}

interface OrdersResponse {
  data:       Order[]
  pagination: { total: number }
}

// ── Lógica de tiempo en reparto ───────────────────────────────────────────────

const MS_24H = 24 * 60 * 60 * 1000
const MS_48H = 48 * 60 * 60 * 1000

function repartoSinceMs(order: Order): number {
  // Prioridad: status_since → last_tracking_update → updated_at
  return new Date(order.status_since ?? order.last_tracking_update ?? order.updated_at).getTime()
}

function horasEnReparto(order: Order): number {
  return (Date.now() - repartoSinceMs(order)) / (1000 * 60 * 60)
}

function criticality(order: Order): 'critico' | 'riesgo' | 'normal' {
  const h = horasEnReparto(order)
  if (h >= 48) return 'critico'
  if (h >= 24) return 'riesgo'
  return 'normal'
}

function repartoDesdeLabel(order: Order): string {
  const h    = horasEnReparto(order)
  const dias = Math.floor(h / 24)
  const hrs  = Math.floor(h % 24)
  if (h < 1)     return 'Hace menos de 1h'
  if (h < 24)    return `Hace ${Math.floor(h)}h`
  if (dias === 1) return hrs > 0 ? `Hace 1d ${hrs}h` : 'Hace 1 día'
  return hrs > 0 ? `Hace ${dias}d ${hrs}h` : `Hace ${dias} días`
}

// ── Orden inteligente (crítico → riesgo → normal, más viejo primero) ──────────

function sortedAll(orders: Order[]): Order[] {
  const criticos = orders
    .filter(o => horasEnReparto(o) >= 48)
    .sort((a, b) => repartoSinceMs(a) - repartoSinceMs(b))
  const riesgo = orders
    .filter(o => horasEnReparto(o) >= 24 && horasEnReparto(o) < 48)
    .sort((a, b) => repartoSinceMs(a) - repartoSinceMs(b))
  const normal = orders
    .filter(o => horasEnReparto(o) < 24)
    .sort((a, b) => repartoSinceMs(b) - repartoSinceMs(a))
  return [...criticos, ...riesgo, ...normal]
}


// ── UI maps ───────────────────────────────────────────────────────────────────

const CRIT_STYLES = {
  critico: {
    badge:    'bg-red-100 text-red-700 border border-red-200',
    badgeLabel: '+48h · Crítico',
    row:      'bg-red-50/30 hover:bg-red-50/60',
    Icon:     ShieldAlert,
  },
  riesgo: {
    badge:    'bg-orange-100 text-orange-700 border border-orange-200',
    badgeLabel: '1-2 días · Riesgo',
    row:      'bg-orange-50/20 hover:bg-orange-50/40',
    Icon:     AlertTriangle,
  },
  normal: {
    badge:    'bg-green-100 text-green-700 border border-green-200',
    badgeLabel: '0-1 día · Normal',
    row:      'hover:bg-gray-50/40',
    Icon:     Clock,
  },
}

const ACTION_BADGE: Record<string, { label: string; color: string }> = {
  contacted:  { label: 'Contactado',  color: 'bg-blue-100 text-blue-700'    },
  delivered:  { label: 'Entregado',   color: 'bg-green-100 text-green-700'  },
  no_answer:  { label: 'No responde', color: 'bg-amber-100 text-amber-700'  },
  escalado:   { label: 'Escalado',    color: 'bg-orange-100 text-orange-700' },
}


const TAB_META: { tab: Tab; label: string }[] = [
  { tab: 'all',        label: 'Todos'       },
  { tab: 'critico',    label: '+48h Crítico'},
  { tab: 'riesgo',     label: '1-2 días'    },
  { tab: 'normal',     label: '0-1 día'     },
  { tab: 'entregados', label: 'Entregados'  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildWaMsg(nombre: string, producto: string | null | undefined): string {
  const n   = nombre.trim() || 'cliente'
  const raw = (producto ?? '').trim()
  const p   = raw.length > 32 ? raw.slice(0, 30) + '...' : raw || 'tu pedido'
  return [
    'Hola ' + n + ' 😊,',
    '',
    'Tu pedido de ' + p + ' 📦 ya está en tu ciudad.',
    'Hoy será entregado.',
    '',
    'El mensajero te estará contactando durante el día.',
    '',
    'Por favor, asegúrate de estar disponible',
    'o deja a alguien encargado con el pago listo.',
    '',
    'Gracias 🙏',
  ].join('\n')
}

// ── Mobile Card ───────────────────────────────────────────────────────────────

interface RepartoCardProps {
  order:            Order
  accion:           string | undefined
  busy:             boolean
  isEntregado:      boolean
  courierConfirmed: boolean
  isHighlighted:    boolean
  onContactado:     () => void
  onEntrego:        () => void
  onNoAnswer:       () => void
  onEscalar:        () => void
}

function RepartoCard({
  order,
  accion,
  busy,
  isEntregado,
  courierConfirmed,
  isHighlighted,
  onContactado,
  onEntrego,
  onNoAnswer,
  onEscalar,
}: RepartoCardProps) {
  const crit      = criticality(order)
  const critStyle = CRIT_STYLES[crit]
  const nombre    = order.customer_name ?? ''
  const waUrl     = whatsAppUrl(order.customer_phone, buildWaMsg(nombre, order.product_summary))
  const telUrl    = callUrl(order.customer_phone)
  const hasPhone  = !!order.customer_phone

  const ubicacion = order.city
    || order.province
    || (order.customer_address ? order.customer_address.slice(0, 22) : null)

  const cardBase = isEntregado
    ? 'bg-green-50/30'
    : crit === 'critico' ? 'bg-red-50/30'
    : crit === 'riesgo'  ? 'bg-orange-50/20'
    : 'bg-white'

  return (
    <div className={`p-4 border-b border-amber-100 ${cardBase}
      ${isHighlighted ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/60' : ''}
      ${accion === 'escalado' ? 'ring-1 ring-inset ring-orange-300' : ''}`}
    >
      {/* Tracking + criticidad */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-bold text-gray-900 truncate">
            {order.tracking_number ?? '—'}
          </p>
          {order.order_number && (
            <p className="font-mono text-[11px] text-gray-400 mt-0.5">{order.order_number}</p>
          )}
          {order.carrier && (
            <p className="text-[11px] text-gray-400">{order.carrier}</p>
          )}
        </div>
        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold
                          px-2 py-0.5 rounded-full border shrink-0 ${critStyle.badge}`}>
          {crit === 'critico' && (
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          )}
          {critStyle.badgeLabel}
        </span>
      </div>

      {/* Cliente */}
      <p className="font-semibold text-gray-900 text-base leading-tight">
        {nombre || '—'}
      </p>
      <p className="font-mono text-sm text-gray-500 mt-0.5">
        {order.customer_phone || '—'}
      </p>

      {/* Ubicación + tiempo */}
      <div className="flex items-center justify-between gap-2 mt-2 text-xs">
        {ubicacion ? (
          <span className="flex items-center gap-1 text-gray-500">
            <MapPin className="w-3 h-3 shrink-0" />{ubicacion}
          </span>
        ) : <span />}
        <span className={`font-semibold shrink-0
          ${crit === 'critico' ? 'text-red-600'
            : crit === 'riesgo' ? 'text-orange-600'
            : 'text-gray-500'}`}>
          {repartoDesdeLabel(order)}
        </span>
      </div>

      {order.raw_status && (
        <p className="text-[11px] text-gray-500 mt-1 truncate" title={order.raw_status}>
          EFI: {order.raw_status}
        </p>
      )}
      {order.delivery_attempts > 0 && (
        <p className="text-[11px] text-gray-400 mt-1">
          {order.delivery_attempts} intento{order.delivery_attempts > 1 ? 's' : ''} previos de entrega
        </p>
      )}

      {/* Botones de contacto — solo si no hay acción */}
      {hasPhone && !isEntregado && !busy && !accion && (
        <div className="flex gap-2 mt-3">
          {waUrl && (
            <a href={waUrl} target="_blank" rel="noopener noreferrer"
               className="flex-1 flex items-center justify-center gap-2
                          bg-green-500 text-white py-3 rounded-xl text-sm font-semibold
                          active:bg-green-700 transition-colors">
              <MessageCircle className="w-4 h-4" />WhatsApp
            </a>
          )}
          {telUrl && (
            <a href={telUrl}
               className="flex-1 flex items-center justify-center gap-2
                          bg-blue-500 text-white py-3 rounded-xl text-sm font-semibold
                          active:bg-blue-700 transition-colors">
              <Phone className="w-4 h-4" />Llamar
            </a>
          )}
        </div>
      )}

      {/* Estado / Acciones */}
      <div className="mt-3">
        {isEntregado ? (
          courierConfirmed ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold
                             px-3 py-1.5 rounded-full bg-green-100 text-green-700">
              <CheckCircle2 className="w-3.5 h-3.5" />Confirmado courier
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold
                             px-3 py-1.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
              <CheckCircle2 className="w-3.5 h-3.5" />Reportado · validando courier
            </span>
          )
        ) : busy ? (
          <Spinner className="w-5 h-5 text-amber-500" />
        ) : accion ? (
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold
                           px-3 py-1.5 rounded-full
                           ${ACTION_BADGE[accion]?.color ?? 'bg-gray-100 text-gray-600'}`}>
            <CheckCircle2 className="w-3.5 h-3.5" />
            {ACTION_BADGE[accion]?.label ?? accion}
          </span>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onContactado}
              className="flex items-center justify-center gap-1.5 bg-slate-100 active:bg-slate-200
                         text-slate-700 text-sm font-medium py-2.5 rounded-lg transition-colors"
            >
              <CheckCircle2 className="w-4 h-4" />Contactado
            </button>
            <button
              onClick={onEntrego}
              className="flex items-center justify-center gap-1.5 bg-green-100 active:bg-green-200
                         text-green-700 text-sm font-medium py-2.5 rounded-lg transition-colors"
            >
              <CheckCircle2 className="w-4 h-4" />Entregó
            </button>
            <button
              onClick={onNoAnswer}
              className="flex items-center justify-center gap-1.5 bg-amber-100 active:bg-amber-200
                         text-amber-700 text-sm font-medium py-2.5 rounded-lg transition-colors"
            >
              <PhoneMissed className="w-4 h-4" />No responde
            </button>
            <button
              onClick={onEscalar}
              className="flex items-center justify-center gap-1.5 bg-orange-100 active:bg-orange-200
                         text-orange-700 text-sm font-medium py-2.5 rounded-lg transition-colors"
            >
              <ArrowUpCircle className="w-4 h-4" />Escalar
            </button>
          </div>
        )}
      </div>

      {/* Ver detalle */}
      <div className="mt-3 flex justify-end">
        <Link
          href={`/orders/${order.id}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium
                     text-amber-600 hover:text-amber-800"
        >
          <ExternalLink className="w-3.5 h-3.5" />Ver detalle
        </Link>
      </div>
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function RepartoPage() {
  const searchParamsObj = useSearchParams()
  const trackingParam   = searchParamsObj.get('tracking')
  const rowRefs         = useRef<Map<string, HTMLElement>>(new Map())

  const [allOrders, setAllOrders]         = useState<Order[]>([])
  const [inTransitOrders, setInTransitOrders] = useState<Order[]>([])
  const [perf, setPerf]               = useState<RepartoPerfData | null>(null)
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  const initRepartoTab = (): Tab => {
    const f = searchParamsObj.get('filter')
    if (f === 'critical') return 'critico'
    if (f === 'risk')     return 'riesgo'
    return 'all'
  }
  const [activeTab, setActiveTab]     = useState<Tab>(initRepartoTab)
  const [searchQuery, setSearchQuery] = useState('')

  const [actionMap, setActionMap]   = useState<Record<string, string>>({})
  const [loadingRow, setLoadingRow] = useState<Record<string, boolean>>({})
  const [deliveredDbOrders, setDeliveredDbOrders] = useState<DeliveredEntry[]>([])
  const [deliveredMetaMap,  setDeliveredMetaMap]  = useState<Record<string, { reported_at: string; courier_confirmed: boolean }>>({})
  const [currentPage, setCurrentPage] = useState(1)

  const PAGE_SIZE = 50

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [ordersRes, inTransitRes, perfRes, entregadosRes]: [OrdersResponse, OrdersResponse, RepartoPerfData, DeliveredEntry[]] =
        await Promise.all([
          // sortBy=status_since_asc → más viejos (críticos) primero; limit=500 para no cortar histórico
          fetch('/api/orders?status=en_reparto&limit=500&page=1&sortBy=status_since_asc').then(r => r.json()),
          fetch('/api/orders?status=in_transit&limit=200&page=1').then(r => r.json()),
          fetch('/api/reparto/performance').then(r => r.json()),
          fetch('/api/reparto/entregados').then(r => r.json()),
        ])
      setAllOrders(ordersRes.data ?? [])
      setInTransitOrders(inTransitRes.data ?? [])
      setPerf(perfRes)
      const dbEntries: DeliveredEntry[] = Array.isArray(entregadosRes) ? entregadosRes : []
      setDeliveredDbOrders(dbEntries)
      const meta: Record<string, { reported_at: string; courier_confirmed: boolean }> = {}
      for (const e of dbEntries) meta[e.order.id] = { reported_at: e.reported_at, courier_confirmed: e.courier_confirmed }
      setDeliveredMetaMap(meta)
      setLastRefresh(new Date())
    } catch (err) {
      console.error('[reparto/fetchData]', err)
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
    if (!trackingParam || allOrders.length === 0) return
    const match = allOrders.find(o => o.tracking_number === trackingParam)
    if (match) setTimeout(() => {
      rowRefs.current.get(match.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
  }, [allOrders, trackingParam])

  // ── Acciones ──────────────────────────────────────────────────────────────

  async function postAction(
    orderId: string,
    actionKey: string,
    actionType: ActionType,
    contactResult?: ContactResult,
  ) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      await fetch(`/api/orders/${orderId}/actions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action_type: actionType, contact_result: contactResult ?? null }),
      })
      setActionMap(prev => ({ ...prev, [orderId]: actionKey }))
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  async function markDelivered(orderId: string) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      const res = await fetch(`/api/reparto/orders/${orderId}/mark-delivered`, { method: 'POST' })
      if (!res.ok) return
      const data: { reported_at: string; courier_confirmed: boolean } = await res.json()
      setDeliveredMetaMap(prev => ({ ...prev, [orderId]: { reported_at: data.reported_at, courier_confirmed: data.courier_confirmed } }))
      setActionMap(prev => ({ ...prev, [orderId]: 'delivered' }))
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  // ── Datos derivados ────────────────────────────────────────────────────────

  const deliveredDbIds = useMemo(
    () => new Set(deliveredDbOrders.map(e => e.order.id)),
    [deliveredDbOrders],
  )

  const activeOrders = useMemo(
    () => allOrders.filter(o => actionMap[o.id] !== 'delivered' && !deliveredDbIds.has(o.id)),
    [allOrders, actionMap, deliveredDbIds],
  )

  const allEntregados = useMemo(() => {
    const sessionOnly = allOrders
      .filter(o => actionMap[o.id] === 'delivered' && !deliveredDbIds.has(o.id))
      .map(o => ({
        order:            o,
        reported_at:      deliveredMetaMap[o.id]?.reported_at ?? new Date().toISOString(),
        courier_confirmed: deliveredMetaMap[o.id]?.courier_confirmed ?? false,
      }))
    return [...deliveredDbOrders, ...sessionOnly]
  }, [deliveredDbOrders, allOrders, actionMap, deliveredDbIds, deliveredMetaMap])

  const criticos = useMemo(
    () => activeOrders.filter(o => horasEnReparto(o) >= 48),
    [activeOrders],
  )
  const riesgo = useMemo(
    () => activeOrders.filter(o => horasEnReparto(o) >= 24 && horasEnReparto(o) < 48),
    [activeOrders],
  )
  const normales = useMemo(
    () => activeOrders.filter(o => horasEnReparto(o) < 24),
    [activeOrders],
  )

  const displayedOrders = useMemo(() => {
    let base: Order[]
    switch (activeTab) {
      case 'critico':    base = [...criticos].sort((a, b) => repartoSinceMs(a) - repartoSinceMs(b)); break
      case 'riesgo':     base = [...riesgo].sort((a, b) => repartoSinceMs(a) - repartoSinceMs(b));   break
      case 'normal':     base = [...normales].sort((a, b) => repartoSinceMs(b) - repartoSinceMs(a)); break
      case 'entregados': base = allEntregados.map(e => e.order); break
      default:           base = sortedAll(activeOrders)
    }

    if (!searchQuery.trim()) return base
    const q = searchQuery.toLowerCase()
    return base.filter(o =>
      (o.tracking_number  ?? '').toLowerCase().includes(q) ||
      (o.customer_name    ?? '').toLowerCase().includes(q) ||
      (o.customer_phone   ?? '').toLowerCase().includes(q) ||
      (o.city             ?? '').toLowerCase().includes(q) ||
      (o.carrier          ?? '').toLowerCase().includes(q)
    )
  }, [activeOrders, allEntregados, criticos, riesgo, normales, activeTab, searchQuery])

  const transitCriticos = useMemo(
    () => inTransitOrders.filter(o => horasEnTransito(o) >= 48),
    [inTransitOrders],
  )

  const tabCounts = useMemo<Record<Tab, number>>(() => ({
    all:        activeOrders.length,
    critico:    criticos.length,
    riesgo:     riesgo.length,
    normal:     normales.length,
    entregados: allEntregados.length,
  }), [activeOrders, criticos, riesgo, normales, allEntregados])

  const pagedOrders = useMemo(
    () => displayedOrders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [displayedOrders, currentPage],
  )
  const totalPages = Math.ceil(displayedOrders.length / PAGE_SIZE)

  useEffect(() => { setCurrentPage(1) }, [activeTab, searchQuery])

  const entregadosSesionCount = allEntregados.length

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ── Banner ── */}
      <div className="relative overflow-hidden rounded-2xl
                      bg-gradient-to-r from-amber-400 to-orange-500
                      border-2 border-amber-400 shadow-lg shadow-amber-200/60">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white" />
          <div className="absolute -right-2 -bottom-10 w-24 h-24 rounded-full bg-white" />
        </div>
        <div className="relative px-4 py-4 md:px-6 md:py-5 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 md:w-12 md:h-12 bg-white/20 rounded-xl shrink-0">
              <Bike className="w-5 h-5 md:w-6 md:h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2 md:gap-3">
                <h1 className="text-xl md:text-2xl font-black text-white tabular-nums">
                  {loading ? '…' : activeOrders.length.toLocaleString()}
                </h1>
                {!loading && criticos.length > 0 && (
                  <span className="flex items-center gap-1.5 bg-red-500/80 text-white
                                   text-xs font-bold px-2.5 py-1 rounded-full animate-pulse">
                    <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    {criticos.length} CRÍTICO{criticos.length !== 1 ? 'S' : ''}
                  </span>
                )}
              </div>
              <p className="text-white font-semibold text-sm md:text-base">En reparto ahora</p>
              <p className="hidden md:block text-amber-100 text-xs mt-0.5">
                Gestiona contacto con clientes y escala incidencias al courier
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 md:gap-4 shrink-0">
            {entregadosSesionCount > 0 && (
              <span className="text-xs md:text-sm text-green-200 font-semibold">
                ✓ {entregadosSesionCount} entregados
              </span>
            )}
            <p className="hidden md:block text-amber-100 text-xs">
              {lastRefresh.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
            </p>
            <button
              onClick={fetchData}
              disabled={loading}
              className="flex items-center gap-1.5 md:gap-2 bg-white/20 hover:bg-white/30 text-white
                         text-sm font-medium px-3 py-2 md:px-4 md:py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden md:inline">Refrescar</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Pipeline logístico ── */}
      <FlujoKpis />

      {/* ── Strip "Mi día" ── */}
      {perf && (
        <div className="bg-white rounded-xl border border-gray-200 px-3 py-2.5 md:px-5 md:py-3.5 shadow-sm">
          <div className="flex items-center gap-2 md:gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 shrink-0">
              <TrendingUp className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Mi día</span>
            </div>
            <div className="flex items-center gap-1.5 md:gap-2 flex-wrap flex-1">
              {([
                { label: 'Entregados',  count: perf.entregadosHoy,  cls: 'bg-green-100  text-green-700'  },
                { label: 'Contactados', count: perf.contactadosHoy, cls: 'bg-blue-100   text-blue-700'   },
                { label: 'Incidencias', count: perf.incidenciasHoy, cls: 'bg-amber-100  text-amber-700'  },
                { label: 'Escalados',   count: perf.escaladosHoy,   cls: 'bg-orange-100 text-orange-700' },
              ] as const).map(({ label, count, cls }) => (
                <div key={label} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${cls}`}>
                  <span className="text-sm font-black tabular-nums leading-none">{count}</span>
                  <span className="text-[11px] font-medium">{label}</span>
                </div>
              ))}
            </div>
            {perf.criticosActivos > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-100 text-red-700 shrink-0">
                <ShieldAlert className="w-3.5 h-3.5" />
                <span className="text-sm font-black tabular-nums leading-none">{perf.criticosActivos}</span>
                <span className="text-[11px] font-semibold">+48h activos</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Dashboard operativo ── */}
      <div className="space-y-2">

        {/* Fila 1: tarjetas de acción clickeables */}
        <div className="grid grid-cols-3 gap-2 md:gap-3">
          {([
            {
              tab:   'critico'  as Tab,
              count: criticos.length,
              label: 'Críticos (+48h)',
              sub:   'Sin movimiento +2 días',
              Icon:  ShieldAlert,
              base:  'border-red-200 bg-red-50 text-red-700',
              active:'border-red-400 bg-red-100 text-red-800 ring-2 ring-red-300/50',
              hover: 'hover:bg-red-100',
            },
            {
              tab:   'riesgo'   as Tab,
              count: riesgo.length,
              label: 'En riesgo (1-2d)',
              sub:   'Requieren seguimiento',
              Icon:  AlertTriangle,
              base:  'border-orange-200 bg-orange-50 text-orange-700',
              active:'border-orange-400 bg-orange-100 text-orange-800 ring-2 ring-orange-300/50',
              hover: 'hover:bg-orange-100',
            },
            {
              tab:   'normal'   as Tab,
              count: normales.length,
              label: 'Normales (0-1d)',
              sub:   'Recién en reparto',
              Icon:  Bike,
              base:  'border-amber-200 bg-amber-50 text-amber-700',
              active:'border-amber-400 bg-amber-100 text-amber-800 ring-2 ring-amber-300/50',
              hover: 'hover:bg-amber-100',
            },
          ] as const).map(({ tab, count, label, sub, Icon, base, active, hover }) => (
            <button
              key={tab}
              onClick={() => setActiveTab(prev => prev === tab ? 'all' : tab)}
              className={`flex items-center gap-2 md:gap-3 p-3 md:p-4 rounded-xl border-2 text-left transition-all
                ${activeTab === tab ? active : `${base} ${hover}`}`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-2xl md:text-3xl font-black tabular-nums leading-none">{count}</p>
                <p className="text-xs md:text-sm font-bold mt-1 leading-tight">{label}</p>
                <p className="hidden md:block text-xs opacity-60 mt-0.5 truncate">{sub}</p>
              </div>
              <Icon className="w-5 h-5 md:w-7 md:h-7 opacity-25 shrink-0" />
            </button>
          ))}
        </div>

        {/* Fila 2: chips informativos — 3 cols en móvil, 5 en desktop */}
        <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
          {([
            {
              label: 'Entregados hoy',
              count: perf?.entregadosHoy  ?? '…',
              cls:   'bg-green-50 text-green-700 border-green-100',
            },
            {
              label: 'Entregados ayer',
              count: perf?.entregadosAyer ?? '…',
              cls:   'bg-green-50/60 text-green-600 border-green-100',
            },
            {
              label: 'Contactados hoy',
              count: perf?.contactadosHoy ?? '…',
              cls:   'bg-blue-50 text-blue-700 border-blue-100',
            },
            {
              label: 'Incidencias hoy',
              count: perf?.incidenciasHoy ?? '…',
              cls:   'bg-amber-50 text-amber-700 border-amber-100',
            },
            {
              label: 'Escalados hoy',
              count: perf?.escaladosHoy   ?? '…',
              cls:   'bg-orange-50 text-orange-700 border-orange-100',
            },
          ] as const).map(({ label, count, cls }) => (
            <div key={label}
                 className={`flex flex-col items-center justify-center p-2.5 md:p-3 rounded-lg border ${cls}`}>
              <p className="text-lg md:text-xl font-black tabular-nums leading-none">{count}</p>
              <p className="text-[10px] font-medium mt-1 text-center leading-tight opacity-80">{label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Sin pedidos en reparto ── */}
      {!loading && activeOrders.length === 0 && allEntregados.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-6 text-center">
          <p className="text-green-700 font-medium">No hay pedidos en reparto en este momento</p>
          <p className="text-green-600 text-sm mt-1">
            Los pedidos aparecerán aquí cuando su estado sea EN_REPARTO
          </p>
        </div>
      )}

      {/* ── Tabla + buscador + tabs ── */}
      {(loading || allOrders.length > 0 || allEntregados.length > 0) && (
        <div className="bg-white rounded-xl border-2 border-amber-200 overflow-hidden shadow-sm">

          {/* Info header */}
          <div className="px-4 py-3 md:px-5 bg-amber-50 border-b border-amber-200 space-y-1">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <p className="text-sm font-semibold text-amber-800">
                Prioridad: pedidos críticos (+48h) primero · Escala al courier si no localizas al cliente
              </p>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 pl-6 text-xs text-amber-700">
              <span>+24h sin movimiento → escalar con Effi / transportadora</span>
              <span className="font-bold">+48h Crítico → escalar con prioridad alta</span>
            </div>
          </div>

          {/* Buscador */}
          <div className="px-4 py-3 border-b border-amber-100 bg-white">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Buscar por guía, nombre, teléfono, ciudad…"
                className="w-full pl-9 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg
                           focus:outline-none focus:ring-2 focus:ring-amber-300 focus:border-amber-300
                           placeholder:text-gray-400"
              />
            </div>
          </div>

          {/* Tabs */}
          {!loading && (
            <div className="flex border-b border-amber-100 overflow-x-auto">
              {TAB_META.map(({ tab, label }) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] text-xs font-semibold
                              border-b-2 transition-colors whitespace-nowrap shrink-0
                    ${activeTab === tab
                      ? 'border-amber-500 text-amber-700 bg-amber-50/60'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                >
                  {label}
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full
                    ${activeTab === tab
                      ? 'bg-amber-500 text-white'
                      : 'bg-gray-100 text-gray-500'
                    }`}>
                    {tabCounts[tab]}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Banner: guías críticas viejas detectadas */}
          {!loading && activeTab === 'critico' && criticos.length > 0 && (
            <div className="mx-4 my-2 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
              <ShieldAlert className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <div className="text-xs text-red-700 leading-relaxed">
                <span className="font-bold">Guías estancadas detectadas.</span>{' '}
                Si alguna ya fue entregada o tiene tracking nuevo en EFI,
                ejecuta <span className="font-mono font-semibold">Recuperar pedidos</span> desde Configuración
                para sincronizar su estado.
              </div>
            </div>
          )}

          {/* Vista vacía de tab/búsqueda */}
          {!loading && displayedOrders.length === 0 && allOrders.length > 0 && (
            <div className="px-5 py-10 text-center">
              <p className="text-gray-500 font-medium">
                {searchQuery
                  ? `Sin resultados para "${searchQuery}"`
                  : 'No hay pedidos en esta categoría'}
              </p>
              <button
                onClick={() => { setActiveTab('all'); setSearchQuery('') }}
                className="text-amber-600 text-sm mt-2 hover:underline"
              >
                Ver todos en reparto
              </button>
            </div>
          )}

          {/* Spinner */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Spinner className="w-6 h-6 text-amber-500" />
            </div>
          )}

          {/* ── Cards móvil ── */}
          {!loading && displayedOrders.length > 0 && (
            <div className="md:hidden divide-y divide-amber-50">
              {pagedOrders.map(order => {
                const accion          = actionMap[order.id]
                const busy            = !!loadingRow[order.id]
                const isEntregado     = accion === 'delivered' || deliveredDbIds.has(order.id)
                const deliveredMeta   = deliveredMetaMap[order.id]
                const courierConfirmed = deliveredMeta?.courier_confirmed ?? false
                const isHighlighted   = !!(trackingParam && order.tracking_number === trackingParam)
                return (
                  <RepartoCard
                    key={order.id}
                    order={order}
                    accion={accion}
                    busy={busy}
                    isEntregado={isEntregado}
                    courierConfirmed={courierConfirmed}
                    isHighlighted={isHighlighted}
                    onContactado={() => postAction(order.id, 'contacted', 'contacted')}
                    onEntrego={() => markDelivered(order.id)}
                    onNoAnswer={() => postAction(order.id, 'no_answer', 'contacted', 'no_answer')}
                    onEscalar={() => postAction(order.id, 'escalado', 'courier_claim')}
                  />
                )
              })}
            </div>
          )}

          {/* ── Tabla desktop ── */}
          {!loading && displayedOrders.length > 0 && (
            <table className="hidden md:table w-full text-sm">
              <thead className="bg-amber-50/60 border-b border-amber-100">
                <tr>
                  {['Guía', 'Cliente', 'Ubicación', 'En reparto desde', 'Estado', 'Contactar', 'Acción', ''].map(h => (
                    <th key={h}
                        className="px-3 py-3 text-left text-xs font-semibold text-amber-800 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-50">
                {pagedOrders.map(order => {
                  const nombre     = order.customer_name ?? ''
                  const waUrl      = whatsAppUrl(order.customer_phone, buildWaMsg(nombre, order.product_summary))
                  const telUrl     = callUrl(order.customer_phone)
                  const hasPhone   = !!order.customer_phone
                  const accion     = actionMap[order.id]
                  const busy       = !!loadingRow[order.id]
                  const crit       = criticality(order)
                  const critStyle  = CRIT_STYLES[crit]
                  const repartoSrc = order.status_since ?? order.updated_at

                  const ubicacion = order.city
                    || order.province
                    || (order.customer_address ? order.customer_address.slice(0, 22) : null)

                  const isHighlighted    = trackingParam && order.tracking_number === trackingParam
                  const isEntregado      = accion === 'delivered' || deliveredDbIds.has(order.id)
                  const deliveredMeta    = deliveredMetaMap[order.id]
                  const courierConfirmed = deliveredMeta?.courier_confirmed ?? false

                  const rowBase = isEntregado
                    ? 'bg-green-50/30'
                    : critStyle.row

                  return (
                    <tr
                      key={order.id}
                      ref={(el: HTMLTableRowElement | null) => { if (el) rowRefs.current.set(order.id, el) }}
                      className={`transition-colors group ${rowBase}
                        ${isHighlighted ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/60' : ''}
                        ${accion === 'escalado' ? 'ring-1 ring-inset ring-orange-300' : ''}`}
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
                        {order.carrier && (
                          <p className="text-[10px] text-gray-400 mt-0.5">{order.carrier}</p>
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
                        {order.customer_confirmed && (
                          <p className="text-[10px] text-green-600 font-semibold mt-0.5">Confirmado</p>
                        )}
                      </td>

                      {/* Ubicación */}
                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-1 text-gray-600">
                          <MapPin className="w-3 h-3 text-gray-400 shrink-0 mt-0.5" />
                          <span className="text-xs truncate max-w-[100px]">{ubicacion || '—'}</span>
                        </div>
                        {order.city && order.province && order.city !== order.province && (
                          <p className="text-[10px] text-gray-400 mt-0.5 ml-4 truncate max-w-[100px]">
                            {order.province}
                          </p>
                        )}
                      </td>

                      {/* En reparto desde */}
                      <td className="px-3 py-2.5">
                        <p className="text-xs text-gray-700 font-medium whitespace-nowrap">
                          {formatEventDate(repartoSrc)}
                        </p>
                        <p className={`text-xs font-semibold mt-0.5 whitespace-nowrap
                          ${crit === 'critico' ? 'text-red-600'
                            : crit === 'riesgo' ? 'text-orange-600'
                            : 'text-gray-500'}`}>
                          {repartoDesdeLabel(order)}
                        </p>
                      </td>

                      {/* Estado de urgencia */}
                      <td className="px-3 py-2.5">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold
                                          px-1.5 py-0.5 rounded-full border whitespace-nowrap
                                          ${critStyle.badge}`}>
                          {crit === 'critico' && (
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                          )}
                          {critStyle.badgeLabel}
                        </span>
                        {order.raw_status && (
                          <p className="text-[10px] text-gray-500 mt-0.5 truncate max-w-[120px]"
                             title={order.raw_status}>
                            {order.raw_status}
                          </p>
                        )}
                        {order.delivery_attempts > 0 && (
                          <p className="text-[10px] text-gray-500 mt-0.5">
                            {order.delivery_attempts} intento{order.delivery_attempts > 1 ? 's' : ''} prev.
                          </p>
                        )}
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
                        {isEntregado ? (
                          courierConfirmed ? (
                            <span className="inline-flex items-center gap-1 text-xs font-semibold
                                             px-2.5 py-1 rounded-full bg-green-100 text-green-700">
                              <CheckCircle2 className="w-3 h-3" />Confirmado courier
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-semibold
                                             px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                              <CheckCircle2 className="w-3 h-3" />Reportado · validando courier
                            </span>
                          )
                        ) : busy ? (
                          <Spinner className="w-4 h-4 text-amber-500" />
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
                              onClick={() => markDelivered(order.id)}
                              className="flex items-center gap-1 bg-green-100 hover:bg-green-200
                                         text-green-700 text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <CheckCircle2 className="w-3 h-3 shrink-0" />Entregó
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
                              onClick={() => postAction(order.id, 'escalado', 'courier_claim')}
                              className="flex items-center gap-1 bg-orange-100 hover:bg-orange-200
                                         text-orange-700 text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <ArrowUpCircle className="w-3 h-3 shrink-0" />Escalar
                            </button>
                          </div>
                        )}
                      </td>

                      {/* Ver detalle */}
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/orders/${order.id}`}
                          className="inline-flex items-center gap-1 text-xs font-medium
                                     text-amber-600 hover:text-amber-800 whitespace-nowrap hover:underline"
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

          {!loading && totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 md:px-5 border-t border-amber-100 bg-amber-50/40">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="flex items-center gap-1.5 px-3 py-2 min-h-[40px] text-xs font-semibold rounded-lg
                           border border-amber-200 text-amber-700 bg-white hover:bg-amber-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Anterior
              </button>
              <span className="text-xs text-gray-500 tabular-nums">
                <span className="font-bold text-gray-800">{currentPage}</span>
                {' / '}
                <span className="font-bold text-gray-800">{totalPages}</span>
                <span className="hidden md:inline text-gray-400"> · {displayedOrders.length} resultados</span>
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="flex items-center gap-1.5 px-3 py-2 min-h-[40px] text-xs font-semibold rounded-lg
                           border border-amber-200 text-amber-700 bg-white hover:bg-amber-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {!loading && allOrders.length > 500 && (
            <div className="px-5 py-3 bg-amber-50 border-t border-amber-100 text-center">
              <p className="text-xs text-amber-700">
                Mostrando 500 de más pedidos en reparto.{' '}
                <Link href="/orders?status=en_reparto" className="font-semibold underline">
                  Ver todos en Pedidos
                </Link>
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Resumen tránsito ── */}
      {!loading && inTransitOrders.length > 0 && (
        <div className="flex items-center justify-between gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 md:px-5">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <Package className="w-4 h-4 text-blue-600" />
              <span className="text-sm font-semibold text-blue-800">
                {inTransitOrders.length} en tránsito
              </span>
            </div>
            {transitCriticos.length > 0 && (
              <span className="flex items-center gap-1 text-xs font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                {transitCriticos.length} crítico{transitCriticos.length !== 1 ? 's' : ''} +48h
              </span>
            )}
          </div>
          <Link
            href="/transito"
            className="flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900 whitespace-nowrap shrink-0"
          >
            Ver tránsito
            <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      )}

      {/* ── Flujo recomendado ── */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-4 md:px-5">
        <p className="text-xs text-gray-500 leading-relaxed">
          <strong className="text-gray-700">Flujo recomendado:</strong>{' '}
          Envía WhatsApp para confirmar disponibilidad →
          Llama si no responde en 10 minutos →
          Registra "Contactado" o "No responde" →
          Si el pedido lleva +48h sin entregarse, usa "Escalar" para notificar al courier.
        </p>
      </div>
    </div>
  )
}
