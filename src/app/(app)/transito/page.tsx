'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { formatEventDate } from '@/lib/utils'
import type { Order } from '@/types'
import {
  Package, RefreshCw, ShieldAlert, AlertTriangle,
  Clock, ExternalLink, MapPin, ChevronLeft, ChevronRight,
  Search, X, Ban, XCircle, Truck,
} from 'lucide-react'
import {
  transitSinceMs, horasEnTransito, transitCriticality,
  sinMovimientoLabel, TRANSIT_STYLES,
} from '@/lib/transit-helpers'
import { isCancelledGuide } from '@/lib/order-status-helpers'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface OrdersResponse {
  data:       Order[]
  pagination: { total: number }
}

type TabType        = 'generadas' | 'transito' | 'anuladas'
type FilterCategory = 'all' | 'critico' | 'riesgo' | 'normal'

// ── Helpers de clasificación (alias locales de helpers compartidos) ────────────

function isGenerada(o: Order): boolean {
  return (o.raw_status ?? '').toLowerCase().includes('generada')
}

// isAnuladaRaw: alias al helper compartido para consistencia entre módulos
const isAnuladaRaw = isCancelledGuide

// ── Helpers de UI ─────────────────────────────────────────────────────────────

function cityDisplay(order: Order): string {
  if (order.city?.trim())     return order.city.trim()
  if (order.province?.trim()) return order.province.trim()
  if (order.customer_address?.trim()) {
    const parts = order.customer_address.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]!
  }
  return 'Ubicación no registrada'
}

function matchesSearch(o: Order, q: string): boolean {
  return (
    (o.tracking_number  ?? '').toLowerCase().includes(q) ||
    (o.order_number     ?? '').toLowerCase().includes(q) ||
    (o.customer_name    ?? '').toLowerCase().includes(q) ||
    (o.customer_phone   ?? '').toLowerCase().includes(q) ||
    (o.city             ?? '').toLowerCase().includes(q) ||
    (o.province         ?? '').toLowerCase().includes(q) ||
    (o.raw_status       ?? '').toLowerCase().includes(q)
  )
}

function sortedByStale(orders: Order[]): Order[] {
  const criticos = orders
    .filter(o => horasEnTransito(o) >= 48)
    .sort((a, b) => transitSinceMs(a) - transitSinceMs(b))
  const riesgo = orders
    .filter(o => horasEnTransito(o) >= 24 && horasEnTransito(o) < 48)
    .sort((a, b) => transitSinceMs(a) - transitSinceMs(b))
  const normal = orders
    .filter(o => horasEnTransito(o) < 24)
    .sort((a, b) => transitSinceMs(a) - transitSinceMs(b))
  return [...criticos, ...riesgo, ...normal]
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function TransitoPage() {
  const searchParams = useSearchParams()

  // Tres arrays separados por etapa
  const [generatedOrders,  setGeneratedOrders]  = useState<Order[]>([])
  const [transitOrders,    setTransitOrders]    = useState<Order[]>([])
  const [cancelledOrders,  setCancelledOrders]  = useState<Order[]>([])

  const [loading,      setLoading]      = useState(true)
  const [lastRefresh,  setLastRefresh]  = useState<Date>(new Date())
  const [currentPage,  setCurrentPage]  = useState(1)
  const [search,       setSearch]       = useState('')

  const initTab = (): TabType => {
    const t = searchParams.get('tab')
    if (t === 'transito') return 'transito'
    if (t === 'anuladas')  return 'anuladas'
    return 'generadas'
  }
  const [activeTab,    setActiveTab]    = useState<TabType>(initTab)
  const [filter,       setFilter]       = useState<FilterCategory>('all')

  // Estados para acciones individuales por fila
  const [updatingId,   setUpdatingId]   = useState<string | null>(null)
  const [markingId,    setMarkingId]    = useState<string | null>(null)
  const [updateToast,  setUpdateToast]  = useState<{ msg: string; type: 'ok' | 'err' } | null>(null)
  const toastRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const PAGE_SIZE = 50

  // ── fetchData ─────────────────────────────────────────────────────────────
  // Tres fetches paralelos:
  //   1. in_transit (API excluye anulada/cancelada a nivel de query)
  //   2. rawStatus=anulada  → guías ya reclasificadas como "Anulada"
  //   3. rawStatus=cancelada → guías "Cancelada por transportadora"
  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [activeRes, anuladasRes, canceladasRes] = await Promise.all([
        fetch('/api/orders?status=in_transit&limit=200&page=1').then(r => r.json()) as Promise<OrdersResponse>,
        fetch('/api/orders?rawStatus=anulada&limit=200&page=1').then(r => r.json())  as Promise<OrdersResponse>,
        fetch('/api/orders?rawStatus=cancelada&limit=200&page=1').then(r => r.json()) as Promise<OrdersResponse>,
      ])

      const activeRaw   = (activeRes.data    ?? []) as Order[]
      const anuladas    = (anuladasRes.data   ?? []) as Order[]
      const canceladas  = (canceladasRes.data ?? []) as Order[]

      // Separar in_transit por raw_status
      const generated:     Order[] = []
      const transit:       Order[] = []
      const extraCancelled: Order[] = []

      for (const o of activeRaw) {
        if (isAnuladaRaw(o)) {
          // Doble-guarda: aunque la API filtra anuladas/canceladas,
          // si alguna slip through por estado inconsistente, va aquí.
          extraCancelled.push(o)
        } else if (isGenerada(o)) {
          generated.push(o)
        } else {
          transit.push(o)
        }
      }

      // Merge todas las anuladas/canceladas sin duplicados
      const allCancelledMap = new Map<string, Order>()
      for (const o of [...anuladas, ...canceladas, ...extraCancelled]) {
        allCancelledMap.set(o.id, o)
      }

      setGeneratedOrders(generated)
      setTransitOrders(transit)
      setCancelledOrders([...allCancelledMap.values()])
      setLastRefresh(new Date())
    } catch (err) {
      console.error('[transito/fetchData]', err)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(msg: string, type: 'ok' | 'err') {
    if (toastRef.current) clearTimeout(toastRef.current)
    setUpdateToast({ msg, type })
    toastRef.current = setTimeout(() => setUpdateToast(null), 4500)
  }

  // ── Actualizar tracking individual ────────────────────────────────────────
  async function handleRefreshTracking(order: Order) {
    if (updatingId || markingId) return
    setUpdatingId(order.id)
    try {
      const res  = await fetch(`/api/orders/${order.id}/tracking`, { method: 'POST' })
      const data = await res.json() as { success?: boolean; normalized_status?: string; error?: string }

      if (!res.ok || !data.success) {
        showToast(data.error ?? 'Error al actualizar tracking', 'err')
        return
      }

      await fetchData(true)

      const ns = data.normalized_status
      if (ns === 'returned' || ns === 'cancelled') {
        showToast('✓ Guía reclasificada — ya no está en tránsito activo', 'ok')
      } else {
        showToast(`✓ Tracking actualizado · Estado: ${ns ?? 'actualizado'}`, 'ok')
      }
    } catch {
      showToast('Error de conexión al actualizar', 'err')
    } finally {
      setUpdatingId(null)
    }
  }

  // ── Anular guía manualmente (admin / novelty_agent) ──────────────────────
  async function handleMarkAnulada(order: Order) {
    if (markingId || updatingId) return
    setMarkingId(order.id)
    try {
      const res  = await fetch(`/api/orders/${order.id}/mark-anulada`, { method: 'POST' })
      const data = await res.json() as { success?: boolean; error?: string; tracking_number?: string }

      if (!res.ok || !data.success) {
        showToast(data.error ?? 'Error al anular la guía', 'err')
        return
      }

      await fetchData(true)
      showToast(
        `✓ Guía ${data.tracking_number ?? ''} marcada como Anulada — excluida del tránsito activo`,
        'ok',
      )
    } catch {
      showToast('Error de conexión al anular la guía', 'err')
    } finally {
      setMarkingId(null)
    }
  }

  useEffect(() => {
    fetchData(false)
    const interval = setInterval(() => fetchData(false), 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Resetear página y filtro al cambiar de tab
  useEffect(() => { setCurrentPage(1); setFilter('all') }, [activeTab])
  // Resetear página al buscar o filtrar
  useEffect(() => { setCurrentPage(1) }, [search, filter])

  // ── Datos del tab activo ──────────────────────────────────────────────────
  const activeOrders = useMemo(() => {
    if (activeTab === 'generadas') return generatedOrders
    if (activeTab === 'transito')  return transitOrders
    return cancelledOrders
  }, [activeTab, generatedOrders, transitOrders, cancelledOrders])

  // ── Búsqueda ──────────────────────────────────────────────────────────────
  const filteredOrders = useMemo(() => {
    if (!search.trim()) return activeOrders
    const q = search.trim().toLowerCase()
    return activeOrders.filter(o => matchesSearch(o, q))
  }, [activeOrders, search])

  // ── Counts de criticidad (sobre activeOrders, sin filtro de búsqueda) ─────
  const tabCriticos = useMemo(() => activeOrders.filter(o => horasEnTransito(o) >= 48),               [activeOrders])
  const tabRiesgo   = useMemo(() => activeOrders.filter(o => horasEnTransito(o) >= 24 && horasEnTransito(o) < 48), [activeOrders])
  const tabNormales = useMemo(() => activeOrders.filter(o => horasEnTransito(o) < 24),                [activeOrders])

  // ── Visibles según filtro ─────────────────────────────────────────────────
  const visibleOrders = useMemo(() => {
    if (activeTab === 'anuladas') return filteredOrders
    if (filter === 'critico') return filteredOrders.filter(o => horasEnTransito(o) >= 48)
    if (filter === 'riesgo')  return filteredOrders.filter(o => horasEnTransito(o) >= 24 && horasEnTransito(o) < 48)
    if (filter === 'normal')  return filteredOrders.filter(o => horasEnTransito(o) < 24)
    return filteredOrders
  }, [activeTab, filter, filteredOrders])

  const sorted = useMemo(
    () => activeTab === 'anuladas' ? visibleOrders : sortedByStale(visibleOrders),
    [activeTab, visibleOrders],
  )

  const pagedSorted = useMemo(
    () => sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [sorted, currentPage],
  )
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)

  function toggleFilter(cat: FilterCategory) {
    setFilter(prev => prev === cat ? 'all' : cat)
  }

  // ── Config de tabs ────────────────────────────────────────────────────────
  const isAnuladasTab = activeTab === 'anuladas'

  const filterLabel: Record<FilterCategory, string> = {
    all:     'Todos',
    critico: 'Críticos +48h',
    riesgo:  'Riesgo +24h',
    normal:  'Normales <24h',
  }

  // Texto de escalamiento diferente por etapa
  const escCriticoMsg = activeTab === 'generadas'
    ? 'Guías creadas +48h sin ser recogidas. Escalar despacho/recogida con Effi / transportadora.'
    : 'Guías en tránsito +48h sin movimiento. Escalar ruta/bloqueo con transportadora — prioridad alta.'

  const escRiesgoMsg = activeTab === 'generadas'
    ? 'Guías creadas +24h sin ser recogidas. Confirmar despacho con Effi antes de que pasen a crítico.'
    : 'Guías en tránsito +24h. Seguimiento con transportadora sobre el movimiento del paquete.'

  // Counts totales para el banner
  const totalActivo = generatedOrders.length + transitOrders.length

  return (
    <div className="space-y-4">

      {/* ── Toast de acción individual ── */}
      {updateToast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3
                         rounded-xl shadow-lg text-sm font-semibold text-white
                         animate-in fade-in slide-in-from-top-2 duration-200
                         ${updateToast.type === 'ok' ? 'bg-green-700' : 'bg-red-600'}`}>
          {updateToast.type === 'ok' ? '✓' : '✗'} {updateToast.msg}
        </div>
      )}

      {/* ── Banner principal ── */}
      <div className="relative overflow-hidden rounded-2xl
                      bg-gradient-to-r from-blue-600 to-indigo-600
                      border-2 border-blue-500 shadow-lg shadow-blue-200/50">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white" />
          <div className="absolute -right-2 -bottom-10 w-24 h-24 rounded-full bg-white" />
        </div>
        <div className="relative px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-12 h-12 bg-white/20 rounded-xl">
              <Package className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-black text-white tabular-nums">
                  {loading ? '…' : totalActivo.toLocaleString()}
                </h1>
                <span className="text-white/80 text-sm font-semibold">pedidos en ruta</span>
              </div>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <span className="inline-flex items-center gap-1.5 bg-white/15 rounded-lg px-2.5 py-1 text-xs text-white">
                  <Package className="w-3 h-3" />
                  <span className="font-bold">{loading ? '…' : generatedOrders.length}</span> generadas
                </span>
                <span className="inline-flex items-center gap-1.5 bg-white/15 rounded-lg px-2.5 py-1 text-xs text-white">
                  <Truck className="w-3 h-3" />
                  <span className="font-bold">{loading ? '…' : transitOrders.length}</span> en tránsito
                </span>
                {!loading && cancelledOrders.length > 0 && (
                  <span className="inline-flex items-center gap-1.5 bg-black/20 rounded-lg px-2.5 py-1 text-xs text-white/70">
                    <Ban className="w-3 h-3" />
                    <span className="font-bold">{cancelledOrders.length}</span> anuladas
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <p className="text-blue-100 text-xs">
              {lastRefresh.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
            </p>
            <button
              onClick={() => fetchData(false)}
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

      {/* ── Tabs de etapa ── */}
      <div className="flex gap-2 flex-wrap">
        {/* Generadas */}
        <button
          onClick={() => setActiveTab('generadas')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 text-sm font-semibold
                      transition-all duration-150
                      ${activeTab === 'generadas'
                        ? 'border-blue-500 bg-blue-600 text-white shadow-md'
                        : 'border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100'}`}
        >
          <Package className="w-4 h-4" />
          Generadas
          <span className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-bold
                            ${activeTab === 'generadas' ? 'bg-white/25 text-white' : 'bg-blue-100 text-blue-700'}`}>
            {loading ? '…' : generatedOrders.length}
          </span>
        </button>

        {/* En tránsito */}
        <button
          onClick={() => setActiveTab('transito')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 text-sm font-semibold
                      transition-all duration-150
                      ${activeTab === 'transito'
                        ? 'border-indigo-500 bg-indigo-600 text-white shadow-md'
                        : 'border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100'}`}
        >
          <Truck className="w-4 h-4" />
          En tránsito
          <span className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-bold
                            ${activeTab === 'transito' ? 'bg-white/25 text-white' : 'bg-indigo-100 text-indigo-700'}`}>
            {loading ? '…' : transitOrders.length}
          </span>
        </button>

        {/* Anuladas */}
        <button
          onClick={() => setActiveTab('anuladas')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 text-sm font-semibold
                      transition-all duration-150
                      ${activeTab === 'anuladas'
                        ? 'border-gray-500 bg-gray-600 text-white shadow-md'
                        : 'border-gray-200 text-gray-600 bg-gray-50 hover:bg-gray-100'}`}
        >
          <Ban className="w-4 h-4" />
          Anuladas
          <span className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-bold
                            ${activeTab === 'anuladas' ? 'bg-white/25 text-white' : 'bg-gray-100 text-gray-600'}`}>
            {loading ? '…' : cancelledOrders.length}
          </span>
        </button>
      </div>

      {/* ── Info de la etapa ── */}
      <div className={`rounded-xl border px-4 py-2.5 flex items-center gap-2
                       ${isAnuladasTab
                         ? 'bg-gray-50 border-gray-200'
                         : activeTab === 'generadas'
                           ? 'bg-blue-50 border-blue-200'
                           : 'bg-indigo-50 border-indigo-200'}`}>
        {isAnuladasTab
          ? <Ban className="w-4 h-4 text-gray-500 shrink-0" />
          : activeTab === 'generadas'
            ? <Package className="w-4 h-4 text-blue-600 shrink-0" />
            : <Truck className="w-4 h-4 text-indigo-600 shrink-0" />
        }
        <p className={`text-xs font-medium
                       ${isAnuladasTab ? 'text-gray-600' : activeTab === 'generadas' ? 'text-blue-700' : 'text-indigo-700'}`}>
          {isAnuladasTab
            ? 'Guías anuladas/canceladas en Effi. No escalar como tránsito activo.'
            : activeTab === 'generadas'
              ? 'Guías creadas/despachadas en Effi que aún no han sido recogidas o movidas por la transportadora.'
              : 'Guías recogidas por la transportadora y en movimiento hacia destino.'
          }
        </p>
      </div>

      {/* ── Tarjetas Crítico / Riesgo / Normal (solo tabs activos) ── */}
      {!isAnuladasTab && (
        <div className="grid grid-cols-3 gap-3">
          <button
            onClick={() => toggleFilter('critico')}
            className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all
              ${filter === 'critico'
                ? 'border-red-400 bg-red-100 ring-2 ring-red-300 ring-offset-1 shadow-md'
                : 'border-red-200 bg-red-50 hover:bg-red-100 hover:border-red-300'}`}
          >
            <div className="flex-1 min-w-0">
              <p className="text-3xl font-black tabular-nums leading-none text-red-700">
                {tabCriticos.length}
              </p>
              <p className="text-sm font-bold mt-1 text-red-700">Críticos (+48h)</p>
              <p className="text-xs text-red-500 opacity-70 mt-0.5 truncate">
                {filter === 'critico' ? '← Filtro activo' : '+2 días sin movimiento'}
              </p>
            </div>
            <ShieldAlert className="w-7 h-7 text-red-400 opacity-40 shrink-0" />
          </button>

          <button
            onClick={() => toggleFilter('riesgo')}
            className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all
              ${filter === 'riesgo'
                ? 'border-yellow-400 bg-yellow-100 ring-2 ring-yellow-300 ring-offset-1 shadow-md'
                : 'border-yellow-200 bg-yellow-50 hover:bg-yellow-100 hover:border-yellow-300'}`}
          >
            <div className="flex-1 min-w-0">
              <p className="text-3xl font-black tabular-nums leading-none text-yellow-700">
                {tabRiesgo.length}
              </p>
              <p className="text-sm font-bold mt-1 text-yellow-700">En riesgo (1–2 días)</p>
              <p className="text-xs text-yellow-600 opacity-70 mt-0.5 truncate">
                {filter === 'riesgo' ? '← Filtro activo' : 'Requieren vigilancia'}
              </p>
            </div>
            <AlertTriangle className="w-7 h-7 text-yellow-400 opacity-40 shrink-0" />
          </button>

          <button
            onClick={() => toggleFilter('normal')}
            className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all
              ${filter === 'normal'
                ? 'border-green-400 bg-green-100 ring-2 ring-green-300 ring-offset-1 shadow-md'
                : 'border-green-200 bg-green-50 hover:bg-green-100 hover:border-green-300'}`}
          >
            <div className="flex-1 min-w-0">
              <p className="text-3xl font-black tabular-nums leading-none text-green-700">
                {tabNormales.length}
              </p>
              <p className="text-sm font-bold mt-1 text-green-700">Normales (0–1 día)</p>
              <p className="text-xs text-green-600 opacity-70 mt-0.5 truncate">
                {filter === 'normal' ? '← Filtro activo' : 'Sin retraso'}
              </p>
            </div>
            <Clock className="w-7 h-7 text-green-400 opacity-40 shrink-0" />
          </button>
        </div>
      )}

      {/* ── Banners de escalamiento (solo tabs activos) ── */}
      {!loading && !isAnuladasTab && (tabCriticos.length > 0 || tabRiesgo.length > 0) && (
        <div className="space-y-2">
          {tabRiesgo.length > 0 && filter !== 'critico' && filter !== 'normal' && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-2.5 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-yellow-600 shrink-0 mt-0.5" />
              <p className="text-xs text-yellow-800 font-medium leading-relaxed">
                <span className="font-bold">
                  {tabRiesgo.length} guía{tabRiesgo.length !== 1 ? 's' : ''} +24h
                </span>
                {' '}— {escRiesgoMsg}
              </p>
            </div>
          )}
          {tabCriticos.length > 0 && filter !== 'riesgo' && filter !== 'normal' && (
            <div className="bg-red-50 border-2 border-red-200 rounded-xl px-4 py-3 flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-red-800">
                  {tabCriticos.length} pedido{tabCriticos.length !== 1 ? 's' : ''} crítico{tabCriticos.length !== 1 ? 's' : ''} +48h
                </p>
                <p className="text-xs text-red-700 font-medium mt-0.5">{escCriticoMsg}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Buscador ── */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por guía, pedido, cliente, teléfono, ciudad o estado EFI…"
          className="w-full pl-9 pr-9 py-2.5 text-sm border border-gray-200 rounded-xl
                     focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-400
                     placeholder:text-gray-400"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Chips de filtro + búsqueda activos */}
      {(filter !== 'all' || search) && (
        <div className="flex items-center gap-2 flex-wrap -mt-2">
          {filter !== 'all' && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold
                             bg-blue-50 text-blue-700 border border-blue-200 px-2.5 py-1 rounded-full">
              Filtro: {filterLabel[filter]}
              <button onClick={() => setFilter('all')} className="text-blue-400 hover:text-blue-700">
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          {search && sorted.length > 0 && (
            <span className="text-xs text-gray-500">
              {sorted.length} resultado{sorted.length !== 1 ? 's' : ''} para &ldquo;{search}&rdquo;
            </span>
          )}
        </div>
      )}

      {/* ── Sin pedidos en el tab ── */}
      {!loading && activeOrders.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-6 text-center">
          <p className="text-green-700 font-medium">
            {isAnuladasTab
              ? 'No hay guías anuladas o canceladas registradas'
              : activeTab === 'generadas'
                ? 'No hay guías en estado "Generada" actualmente'
                : 'No hay guías en tránsito activo actualmente'
            }
          </p>
        </div>
      )}

      {/* ── Sin resultados de búsqueda ── */}
      {!loading && sorted.length === 0 && (search || filter !== 'all') && activeOrders.length > 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl px-5 py-6 text-center">
          <p className="text-gray-600 font-medium">
            Sin resultados{search ? ` para &ldquo;${search}&rdquo;` : ''}
            {filter !== 'all' ? ` en "${filterLabel[filter]}"` : ''}
          </p>
          <button
            onClick={() => { setSearch(''); setFilter('all') }}
            className="text-blue-600 text-sm mt-1 underline"
          >
            Limpiar filtros
          </button>
        </div>
      )}

      {/* ── Tabla ── */}
      {(loading || sorted.length > 0) && (
        <div className="bg-white rounded-xl border-2 border-blue-100 overflow-hidden shadow-sm">

          {/* Header de tabla */}
          <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center gap-2 flex-wrap">
            {isAnuladasTab
              ? <Ban className="w-4 h-4 text-gray-500 shrink-0" />
              : activeTab === 'transito'
                ? <Truck className="w-4 h-4 text-indigo-600 shrink-0" />
                : <Package className="w-4 h-4 text-blue-600 shrink-0" />
            }
            <p className="text-sm font-semibold text-blue-800">
              {isAnuladasTab
                ? `Anuladas · ${sorted.length} guía${sorted.length !== 1 ? 's' : ''}`
                : filter !== 'all'
                  ? `${filterLabel[filter]} · ${activeTab === 'generadas' ? 'Generadas' : 'En tránsito'} · Mayor tiempo primero`
                  : `${activeTab === 'generadas' ? 'Generadas' : 'En tránsito'} · Mayor tiempo sin movimiento primero`
              }
            </p>
            {(search || filter !== 'all') && sorted.length > 0 && (
              <span className="ml-auto text-xs text-blue-600 font-medium">
                {sorted.length} resultado{sorted.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Spinner */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Spinner className="w-6 h-6 text-blue-500" />
            </div>
          )}

          {/* Filas */}
          {!loading && sorted.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-blue-50/60 border-b border-blue-100">
                <tr>
                  {['Guía', 'Cliente', 'Ciudad', 'Sin movimiento', 'Estado EFI', ''].map(h => (
                    <th key={h}
                        className="px-3 py-3 text-left text-xs font-semibold text-blue-800 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-blue-50">
                {pagedSorted.map(order => {
                  const isAnulada    = isAnuladasTab || isAnuladaRaw(order)
                  const crit         = isAnulada ? 'normal' as const : transitCriticality(order)
                  const style        = isAnulada ? TRANSIT_STYLES.normal : TRANSIT_STYLES[crit]
                  const stuckSinceTs = order.status_since ?? order.shipment_created_at ?? order.shopify_created_at ?? order.created_at
                  const loc          = cityDisplay(order)

                  return (
                    <tr key={order.id}
                        className={`transition-colors group
                          ${isAnulada
                            ? 'bg-gray-50/50 hover:bg-gray-100/40 opacity-75'
                            : style.row}`}>

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
                          {order.customer_name ?? '—'}
                        </p>
                        <p className="font-mono text-xs text-gray-500 mt-0.5">
                          {order.customer_phone ?? '—'}
                        </p>
                      </td>

                      {/* Ciudad */}
                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-1 text-gray-600">
                          <MapPin className="w-3 h-3 text-gray-400 shrink-0 mt-0.5" />
                          <span className={`text-xs truncate max-w-[100px]
                            ${loc === 'Ubicación no registrada' ? 'text-gray-400 italic' : ''}`}>
                            {loc}
                          </span>
                        </div>
                        {order.city && order.province && order.city !== order.province && (
                          <p className="text-[10px] text-gray-400 mt-0.5 ml-4 truncate max-w-[100px]">
                            {order.province}
                          </p>
                        )}
                      </td>

                      {/* Sin movimiento */}
                      <td className="px-3 py-2.5">
                        <p className={`text-xs font-semibold whitespace-nowrap
                          ${isAnulada ? 'text-gray-400 line-through'
                            : crit === 'critico' ? 'text-red-600'
                            : crit === 'riesgo'  ? 'text-yellow-700'
                            : 'text-gray-600'}`}>
                          {sinMovimientoLabel(order)}
                        </p>
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          {stuckSinceTs ? formatEventDate(stuckSinceTs) : '—'}
                        </p>
                      </td>

                      {/* Estado EFI */}
                      <td className="px-3 py-2.5">
                        {isAnulada ? (
                          <>
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold
                                            px-1.5 py-0.5 rounded-full whitespace-nowrap
                                            bg-gray-100 text-gray-500 border border-gray-300">
                              <Ban className="w-2.5 h-2.5 shrink-0" />
                              Anulada
                            </span>
                            {order.raw_status && !isAnuladaRaw(order) && (
                              <p className="text-[10px] text-gray-400 mt-0.5 truncate max-w-[120px]"
                                 title={order.raw_status}>
                                {order.raw_status}
                              </p>
                            )}
                            <p className="text-[10px] text-gray-400 font-medium mt-0.5">No escalar</p>
                          </>
                        ) : (
                          <>
                            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold
                                              px-1.5 py-0.5 rounded-full whitespace-nowrap ${style.badge}`}>
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
                              {style.label}
                            </span>
                            {order.raw_status && (
                              <p className="text-[10px] text-gray-600 font-medium mt-0.5 truncate max-w-[120px]"
                                 title={order.raw_status}>
                                {order.raw_status}
                              </p>
                            )}
                            {crit === 'critico' && (
                              <p className="text-[10px] text-red-600 font-bold mt-0.5 leading-tight">
                                {activeTab === 'generadas' ? '↑ Escalar recogida' : '↑ Escalar con Effi'}
                              </p>
                            )}
                            {crit === 'riesgo' && (
                              <p className="text-[10px] text-yellow-700 font-medium mt-0.5 leading-tight">
                                {activeTab === 'generadas' ? 'Confirmar despacho' : 'Seguimiento Effi'}
                              </p>
                            )}
                          </>
                        )}
                      </td>

                      {/* Acciones */}
                      <td className="px-3 py-2.5">
                        <div className="flex flex-col gap-1.5 items-start">
                          <Link
                            href={`/orders/${order.id}`}
                            className="inline-flex items-center gap-1 text-xs font-medium
                                       text-blue-600 hover:text-blue-800 whitespace-nowrap hover:underline"
                          >
                            <ExternalLink className="w-3 h-3" />
                            Ver
                          </Link>
                          {!isAnulada && (
                            <>
                              <button
                                onClick={() => handleRefreshTracking(order)}
                                disabled={updatingId !== null || markingId !== null}
                                title="Consultar EFI y actualizar estado ahora"
                                className="inline-flex items-center gap-1 text-xs font-medium
                                           text-indigo-600 hover:text-indigo-800 whitespace-nowrap
                                           disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {updatingId === order.id
                                  ? <Spinner className="w-3 h-3" />
                                  : <RefreshCw className="w-3 h-3" />
                                }
                                {updatingId === order.id ? 'Actualizando…' : 'Actualizar'}
                              </button>
                              <button
                                onClick={() => handleMarkAnulada(order)}
                                disabled={updatingId !== null || markingId !== null}
                                title="Marcar como anulada manualmente — solo admin/novelty_agent"
                                className="inline-flex items-center gap-1 text-xs font-medium
                                           text-red-500 hover:text-red-700 whitespace-nowrap
                                           disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {markingId === order.id
                                  ? <Spinner className="w-3 h-3" />
                                  : <XCircle className="w-3 h-3" />
                                }
                                {markingId === order.id ? 'Anulando…' : 'Anular'}
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {/* Paginación */}
          {!loading && totalPages > 1 && (
            <div className="flex items-center justify-between px-5 py-3 border-t border-blue-100 bg-blue-50/40">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg
                           border border-blue-200 text-blue-700 bg-white hover:bg-blue-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Anterior
              </button>
              <span className="text-xs text-gray-500 tabular-nums">
                Página <span className="font-bold text-gray-800">{currentPage}</span> de{' '}
                <span className="font-bold text-gray-800">{totalPages}</span>
                {' '}·{' '}
                <span className="text-gray-400">{sorted.length} resultados</span>
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg
                           border border-blue-200 text-blue-700 bg-white hover:bg-blue-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Notas operativas ── */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-5 py-4 space-y-2">
        <p className="text-xs text-gray-700 font-semibold">Guía operativa por etapa:</p>
        <ul className="text-xs text-gray-500 leading-relaxed space-y-1 list-disc list-inside">
          <li>
            <strong className="text-gray-700">Generada +24h</strong>
            {' '}— Confirmar recogida con Effi / transportadora. La guía existe pero no ha salido.
          </li>
          <li>
            <strong className="text-gray-700">Generada +48h Crítico</strong>
            {' '}— Escalar despacho con prioridad. Posible bloqueo, guía sin recoger o candidata a anulación.
          </li>
          <li>
            <strong className="text-gray-700">En tránsito +24h</strong>
            {' '}— Seguimiento con transportadora sobre la ruta y movimiento del paquete.
          </li>
          <li>
            <strong className="text-gray-700">En tránsito +48h Crítico</strong>
            {' '}— Escalar con prioridad alta. Posible bloqueo en ruta o novedad sin registrar en Effi.
          </li>
          <li>
            <strong className="text-gray-700">+72h cualquier etapa</strong>
            {' '}— Considerar apertura de reclamo formal con la transportadora.
          </li>
          <li>
            <strong className="text-gray-700">Anuladas</strong>
            {' '}— No escalar. Botón &ldquo;Anular&rdquo; disponible para admin/novelty_agent para marcarlas manualmente si Effi no las detectó automáticamente.
          </li>
        </ul>
        <p className="text-xs text-gray-400 mt-1">
          Tiempo calculado desde <strong className="text-gray-500">status_since</strong>{' '}
          → shipment_created_at → shopify_created_at → created_at.
          <strong className="text-gray-500"> last_tracking_update</strong> no se usa para este cálculo.
        </p>
      </div>

    </div>
  )
}
