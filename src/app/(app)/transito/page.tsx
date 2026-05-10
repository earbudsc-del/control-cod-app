'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Spinner } from '@/components/ui/spinner'
import { formatEventDate } from '@/lib/utils'
import type { Order } from '@/types'
import {
  Package, RefreshCw, ShieldAlert, AlertTriangle,
  Clock, ExternalLink, MapPin, ChevronLeft, ChevronRight,
  Search, X, Ban,
} from 'lucide-react'
import {
  transitSinceMs, horasEnTransito, transitCriticality,
  sinMovimientoLabel, TRANSIT_STYLES,
} from '@/lib/transit-helpers'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface OrdersResponse {
  data:       Order[]
  pagination: { total: number }
}

type FilterCategory = 'all' | 'critico' | 'riesgo' | 'normal' | 'anulada'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Orden: más tiempo sin movimiento primero ──────────────────────────────────

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
  const [orders, setOrders]           = useState<Order[]>([])     // in_transit activos (excluye returned)
  const [anuladas, setAnuladas]       = useState<Order[]>([])     // anuladas en EFI
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [currentPage, setCurrentPage] = useState(1)
  const [search, setSearch]           = useState('')
  const [filter, setFilter]           = useState<FilterCategory>('all')

  // ── Estado para actualización individual por fila ─────────────────────────
  const [updatingId, setUpdatingId]   = useState<string | null>(null)
  const [updateToast, setUpdateToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null)
  const toastRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const PAGE_SIZE = 50

  // ── fetchData con modo silencioso (no muestra spinner) ────────────────────
  // silent=true: refresca datos sin poner loading=true (evita parpadeo tras
  // actualización individual de una guía).
  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [activeRes, anuladasRes] = await Promise.all([
        fetch('/api/orders?status=in_transit&limit=200&page=1').then(r => r.json()) as Promise<OrdersResponse>,
        // También traemos returned con raw_status~anulada (ya reclasificadas por el cron)
        fetch('/api/orders?rawStatus=anulada&limit=200&page=1').then(r => r.json()) as Promise<OrdersResponse>,
      ])
      const activeRaw  = (activeRes.data  ?? []) as Order[]
      const cancelled  = (anuladasRes.data ?? []) as Order[]

      // Doble-guarda client-side: cualquier guía en_transit con raw_status que
      // contenga 'anulad' la movemos a anuladas (estado inconsistente transitorio).
      const trueActive: Order[]   = []
      const extraAnuladas: Order[] = []
      for (const o of activeRaw) {
        if (o.raw_status?.toLowerCase().includes('anulad')) {
          extraAnuladas.push(o)
        } else {
          trueActive.push(o)
        }
      }

      // Merge anuladas sin duplicados (por id)
      const allAnuladasMap = new Map<string, Order>()
      for (const o of [...cancelled, ...extraAnuladas]) {
        allAnuladasMap.set(o.id, o)
      }

      setOrders(trueActive)
      setAnuladas([...allAnuladasMap.values()])
      setLastRefresh(new Date())

      // ── Debug en consola ──
      if (process.env.NODE_ENV !== 'production') {
        for (const o of trueActive) {
          console.log('[transito-debug]', {
            tracking_number:  o.tracking_number,
            raw_status:       o.raw_status,
            normalized_status: o.normalized_status,
            status_since:     o.status_since,
            horas:            Math.round(horasEnTransito(o) * 10) / 10,
            categoria:        transitCriticality(o),
          })
        }
      }
    } catch (err) {
      console.error('[transito/fetchData]', err)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  // ── Toast helper ─────────────────────────────────────────────────────────
  function showToast(msg: string, type: 'ok' | 'err') {
    if (toastRef.current) clearTimeout(toastRef.current)
    setUpdateToast({ msg, type })
    toastRef.current = setTimeout(() => setUpdateToast(null), 4500)
  }

  // ── Actualizar tracking de una guía individual ────────────────────────────
  async function handleRefreshTracking(order: Order) {
    if (updatingId) return                    // evitar concurrencia
    setUpdatingId(order.id)
    try {
      const res  = await fetch(`/api/orders/${order.id}/tracking`, { method: 'POST' })
      const data = await res.json() as { success?: boolean; normalized_status?: string; error?: string }

      if (!res.ok || !data.success) {
        showToast(data.error ?? 'Error al actualizar tracking', 'err')
        return
      }

      // Refetch silencioso para actualizar estado local sin parpadeo de tabla
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

  useEffect(() => {
    fetchData(false)
    const interval = setInterval(() => fetchData(false), 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

  // ── Búsqueda ───────────────────────────────────────────────────────────────

  const filteredActive   = useMemo(() => {
    if (!search.trim()) return orders
    const q = search.trim().toLowerCase()
    return orders.filter(o => matchesSearch(o, q))
  }, [orders, search])

  const filteredAnuladas = useMemo(() => {
    if (!search.trim()) return anuladas
    const q = search.trim().toLowerCase()
    return anuladas.filter(o => matchesSearch(o, q))
  }, [anuladas, search])

  // Reset página al cambiar búsqueda o filtro
  useEffect(() => { setCurrentPage(1) }, [search, filter])

  // ── Counts para las tarjetas (sobre datos sin filtro de búsqueda) ──────────
  const criticos = useMemo(() => orders.filter(o => horasEnTransito(o) >= 48),  [orders])
  const riesgo   = useMemo(() => orders.filter(o => horasEnTransito(o) >= 24 && horasEnTransito(o) < 48), [orders])
  const normales = useMemo(() => orders.filter(o => horasEnTransito(o) < 24),   [orders])

  // ── Datos mostrados según filtro activo ───────────────────────────────────
  const visibleOrders: Order[] = useMemo(() => {
    if (filter === 'anulada')  return filteredAnuladas
    if (filter === 'critico')  return filteredActive.filter(o => horasEnTransito(o) >= 48)
    if (filter === 'riesgo')   return filteredActive.filter(o => horasEnTransito(o) >= 24 && horasEnTransito(o) < 48)
    if (filter === 'normal')   return filteredActive.filter(o => horasEnTransito(o) < 24)
    return filteredActive  // 'all'
  }, [filter, filteredActive, filteredAnuladas])

  const sorted = useMemo(
    () => filter === 'anulada' ? visibleOrders : sortedByStale(visibleOrders),
    [filter, visibleOrders],
  )

  const pagedSorted = useMemo(
    () => sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [sorted, currentPage],
  )
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)

  // ── Handler tarjeta clickeable ─────────────────────────────────────────────
  function toggleFilter(cat: FilterCategory) {
    setFilter(prev => prev === cat ? 'all' : cat)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const filterLabel: Record<FilterCategory, string> = {
    all:     'Todos los activos',
    critico: 'Críticos +48h',
    riesgo:  'Riesgo +24h',
    normal:  'Normales <24h',
    anulada: 'Anuladas en EFI',
  }

  return (
    <div className="space-y-4">

      {/* ── Toast de actualización individual ── */}
      {updateToast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3
                         rounded-xl shadow-lg text-sm font-semibold text-white
                         animate-in fade-in slide-in-from-top-2 duration-200
                         ${updateToast.type === 'ok' ? 'bg-green-700' : 'bg-red-600'}`}>
          {updateToast.type === 'ok' ? '✓' : '✗'} {updateToast.msg}
        </div>
      )}

      {/* ── Banner ── */}
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
                  {loading ? '…' : orders.length.toLocaleString()}
                </h1>
                {!loading && criticos.length > 0 && (
                  <span className="flex items-center gap-1.5 bg-red-500/80 text-white
                                   text-xs font-bold px-2.5 py-1 rounded-full animate-pulse">
                    <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    {criticos.length} CRÍTICO{criticos.length !== 1 ? 'S' : ''}
                  </span>
                )}
                {!loading && anuladas.length > 0 && (
                  <span className="flex items-center gap-1.5 bg-gray-500/60 text-white
                                   text-xs font-semibold px-2.5 py-1 rounded-full">
                    <Ban className="w-3 h-3" />
                    {anuladas.length} anulada{anuladas.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <p className="text-white font-semibold">Pedidos en tránsito activo</p>
              <p className="text-blue-100 text-xs mt-0.5">
                Monitoreo de retrasos · Anuladas excluidas del conteo activo
              </p>
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

      {/* ── Tarjetas clickeables ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Críticos */}
        <button
          onClick={() => toggleFilter('critico')}
          className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all
            ${filter === 'critico'
              ? 'border-red-400 bg-red-100 ring-2 ring-red-300 ring-offset-1 shadow-md'
              : 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100 hover:border-red-300'
            }`}
        >
          <div className="flex-1 min-w-0">
            <p className={`text-3xl font-black tabular-nums leading-none ${filter === 'critico' ? 'text-red-700' : 'text-red-700'}`}>
              {criticos.length}
            </p>
            <p className="text-sm font-bold mt-1 text-red-700">Críticos (+48h)</p>
            <p className="text-xs text-red-500 opacity-70 mt-0.5 truncate">
              {filter === 'critico' ? '← Filtro activo' : '+2 días sin movimiento'}
            </p>
          </div>
          <ShieldAlert className="w-7 h-7 text-red-400 opacity-40 shrink-0" />
        </button>

        {/* Riesgo */}
        <button
          onClick={() => toggleFilter('riesgo')}
          className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all
            ${filter === 'riesgo'
              ? 'border-yellow-400 bg-yellow-100 ring-2 ring-yellow-300 ring-offset-1 shadow-md'
              : 'border-yellow-200 bg-yellow-50 text-yellow-700 hover:bg-yellow-100 hover:border-yellow-300'
            }`}
        >
          <div className="flex-1 min-w-0">
            <p className="text-3xl font-black tabular-nums leading-none text-yellow-700">
              {riesgo.length}
            </p>
            <p className="text-sm font-bold mt-1 text-yellow-700">En riesgo (1–2 días)</p>
            <p className="text-xs text-yellow-600 opacity-70 mt-0.5 truncate">
              {filter === 'riesgo' ? '← Filtro activo' : 'Requieren vigilancia'}
            </p>
          </div>
          <AlertTriangle className="w-7 h-7 text-yellow-400 opacity-40 shrink-0" />
        </button>

        {/* Normal */}
        <button
          onClick={() => toggleFilter('normal')}
          className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all
            ${filter === 'normal'
              ? 'border-green-400 bg-green-100 ring-2 ring-green-300 ring-offset-1 shadow-md'
              : 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100 hover:border-green-300'
            }`}
        >
          <div className="flex-1 min-w-0">
            <p className="text-3xl font-black tabular-nums leading-none text-green-700">
              {normales.length}
            </p>
            <p className="text-sm font-bold mt-1 text-green-700">Normales (0–1 día)</p>
            <p className="text-xs text-green-600 opacity-70 mt-0.5 truncate">
              {filter === 'normal' ? '← Filtro activo' : 'En movimiento reciente'}
            </p>
          </div>
          <Clock className="w-7 h-7 text-green-400 opacity-40 shrink-0" />
        </button>

        {/* Anuladas */}
        <button
          onClick={() => toggleFilter('anulada')}
          className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all
            ${filter === 'anulada'
              ? 'border-gray-400 bg-gray-200 ring-2 ring-gray-300 ring-offset-1 shadow-md'
              : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100 hover:border-gray-300'
            }`}
        >
          <div className="flex-1 min-w-0">
            <p className="text-3xl font-black tabular-nums leading-none text-gray-600">
              {anuladas.length}
            </p>
            <p className="text-sm font-bold mt-1 text-gray-600">Anuladas (EFI)</p>
            <p className="text-xs text-gray-400 mt-0.5 truncate">
              {filter === 'anulada' ? '← Filtro activo' : 'Canceladas en Effi'}
            </p>
          </div>
          <Ban className="w-7 h-7 text-gray-400 opacity-40 shrink-0" />
        </button>
      </div>

      {/* ── Escalamiento operativo (solo cuando no hay filtro o filtro activos) ── */}
      {!loading && filter !== 'anulada' && (criticos.length > 0 || riesgo.length > 0) && (
        <div className="space-y-2">
          {riesgo.length > 0 && filter !== 'critico' && filter !== 'normal' && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-2.5 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-yellow-600 shrink-0 mt-0.5" />
              <p className="text-xs text-yellow-800 font-medium leading-relaxed">
                <span className="font-bold">{riesgo.length} guía{riesgo.length !== 1 ? 's' : ''} +24h</span>
                {' '}— Requieren seguimiento con Effi / transportadora antes de convertirse en novedad.
              </p>
            </div>
          )}
          {criticos.length > 0 && filter !== 'riesgo' && filter !== 'normal' && (
            <div className="bg-red-50 border-2 border-red-200 rounded-xl px-4 py-3 flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-red-800">
                  {criticos.length} pedido{criticos.length !== 1 ? 's' : ''} crítico{criticos.length !== 1 ? 's' : ''} +48h sin movimiento
                </p>
                <p className="text-xs text-red-700 font-medium mt-0.5">
                  Escalar con prioridad alta a Effi / transportadora — pueden estar bloqueados o con novedad sin registrar.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Banner anuladas activo ── */}
      {!loading && filter === 'anulada' && (
        <div className="bg-gray-100 border border-gray-300 rounded-xl px-4 py-3 flex items-start gap-3">
          <Ban className="w-5 h-5 text-gray-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-gray-700">
              Mostrando {anuladas.length} guía{anuladas.length !== 1 ? 's' : ''} anulada{anuladas.length !== 1 ? 's' : ''} en EFI
            </p>
            <p className="text-xs text-gray-500 font-medium mt-0.5">
              Estas guías están canceladas / anuladas en Effi. No escalar como tránsito activo. No cuentan en los totales de Crítico / Riesgo / Normal.
            </p>
          </div>
        </div>
      )}

      {/* ── Buscador ── */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por guía, pedido, cliente, teléfono, ciudad, provincia o estado EFI…"
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

      {/* Indicador filtro + búsqueda activos */}
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
          {search && (
            <span className="text-xs text-gray-500">
              {sorted.length === 0
                ? 'Sin resultados'
                : `${sorted.length} resultado${sorted.length !== 1 ? 's' : ''} para "${search}"`}
            </span>
          )}
        </div>
      )}

      {/* ── Sin pedidos en tránsito ── */}
      {!loading && orders.length === 0 && anuladas.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-6 text-center">
          <p className="text-green-700 font-medium">No hay pedidos en tránsito en este momento</p>
          <p className="text-green-600 text-sm mt-1">
            Los pedidos aparecerán aquí cuando su estado sea IN_TRANSIT
          </p>
        </div>
      )}

      {/* ── Sin resultados búsqueda ── */}
      {!loading && sorted.length === 0 && (search || filter !== 'all') && (orders.length > 0 || anuladas.length > 0) && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl px-5 py-6 text-center">
          <p className="text-gray-600 font-medium">
            Sin resultados {search ? `para "${search}"` : ''} {filter !== 'all' ? `en "${filterLabel[filter]}"` : ''}
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

          <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center gap-2 flex-wrap">
            <Package className="w-4 h-4 text-blue-600 shrink-0" />
            <p className="text-sm font-semibold text-blue-800">
              {filter === 'anulada'
                ? `Anuladas en EFI · ${sorted.length} guía${sorted.length !== 1 ? 's' : ''}`
                : filter !== 'all'
                  ? `${filterLabel[filter]} · Ordenado por mayor tiempo`
                  : 'Detalle · Ordenado por mayor tiempo sin movimiento'
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

          {/* Tabla */}
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
                  const isAnulada    = filter === 'anulada' ||
                    (order.raw_status?.toLowerCase().includes('anulad') ?? false)
                  const crit         = isAnulada ? 'normal' as const : transitCriticality(order)
                  const style        = isAnulada ? TRANSIT_STYLES.normal : TRANSIT_STYLES[crit]
                  const stuckSinceTs = order.status_since ?? order.shipment_created_at ?? order.shopify_created_at ?? order.created_at
                  const loc          = cityDisplay(order)

                  return (
                    <tr key={order.id}
                        className={`transition-colors group ${isAnulada ? 'bg-gray-50/50 hover:bg-gray-100/40 opacity-75' : style.row}`}>

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

                      {/* Sin movimiento desde */}
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

                      {/* Estado badge + raw_status */}
                      <td className="px-3 py-2.5">
                        {isAnulada ? (
                          <>
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold
                                            px-1.5 py-0.5 rounded-full whitespace-nowrap
                                            bg-gray-100 text-gray-500 border border-gray-300">
                              <Ban className="w-2.5 h-2.5 shrink-0" />
                              Anulada
                            </span>
                            {order.raw_status && order.raw_status.toLowerCase() !== 'anulada' && (
                              <p className="text-[10px] text-gray-400 mt-0.5 truncate max-w-[120px]"
                                 title={order.raw_status}>
                                {order.raw_status}
                              </p>
                            )}
                            <p className="text-[10px] text-gray-400 font-medium mt-0.5 leading-tight">
                              No escalar
                            </p>
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
                                ↑ Escalar con Effi
                              </p>
                            )}
                            {crit === 'riesgo' && (
                              <p className="text-[10px] text-yellow-700 font-medium mt-0.5 leading-tight">
                                Seguimiento Effi
                              </p>
                            )}
                          </>
                        )}
                      </td>

                      {/* Acciones: Ver + Actualizar tracking */}
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
                            <button
                              onClick={() => handleRefreshTracking(order)}
                              disabled={updatingId !== null}
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
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

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

          {!loading && orders.length >= 200 && filter !== 'anulada' && (
            <div className="px-5 py-3 bg-blue-50 border-t border-blue-100 text-center">
              <p className="text-xs text-blue-700">
                Mostrando hasta 200 pedidos activos.{' '}
                <Link href="/orders?status=in_transit" className="font-semibold underline">
                  Ver todos en Pedidos
                </Link>
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Notas operativas ── */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-5 py-4 space-y-2">
        <p className="text-xs text-gray-700 font-semibold">Guía operativa para escalamiento:</p>
        <ul className="text-xs text-gray-500 leading-relaxed space-y-1 list-disc list-inside">
          <li>
            <strong className="text-gray-700">Generada / En tránsito +24h</strong>
            {' '}— Requiere seguimiento con Effi / transportadora para confirmar recogida o avance.
          </li>
          <li>
            <strong className="text-gray-700">+48h Crítico</strong>
            {' '}— Escalar con prioridad alta. Puede estar bloqueado o con novedad sin registrar.
          </li>
          <li>
            <strong className="text-gray-700">+72h</strong>
            {' '}— Considerar apertura de reclamo formal con la transportadora.
          </li>
          <li>
            <strong className="text-gray-700">Anuladas</strong>
            {' '}— Guías canceladas / anuladas en EFI. No escalar. El cron dejará de sincronizarlas automáticamente.
          </li>
        </ul>
        <p className="text-xs text-gray-400 mt-1">
          Tiempo estancado calculado desde <strong className="text-gray-500">status_since</strong> (fecha real EFI),
          fallback: shipment_created_at → shopify_created_at → created_at.
          <strong className="text-gray-500"> last_tracking_update</strong> no se usa para este cálculo.
        </p>
      </div>

    </div>
  )
}
