'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { formatCurrency, formatEventDate } from '@/lib/utils'
import {
  CheckCircle2, RefreshCw, Package, Search,
  Calendar, Truck, MapPin, AlertTriangle,
  ChevronLeft, ChevronRight, ClipboardList,
} from 'lucide-react'
import { AlertBadges } from '@/components/shared/alert-badges'
import { checkCoverage } from '@/lib/alert-helpers'

type FilterType  = 'todos' | 'hoy' | 'ayer' | 'rango'
type AlertFilter = 'todos' | 'duplicados' | 'cobertura' | 'zona_desconocida'

interface ConfirmadoOrder {
  id:                        string
  order_number:              string | null
  customer_name:             string | null
  customer_phone:            string | null
  customer_address:          string | null
  city:                      string | null
  product_summary:           string | null
  cod_amount:                number | null
  confirmation_method:       string | null
  last_confirmation_attempt: string | null
  created_at:                string
  duplicate_alert:           boolean | null
  duplicate_of_order_id:     string | null
  duplicate_reason:          string | null
}

interface ApiResponse {
  data:  ConfirmadoOrder[]
  stats: { confirmados_hoy: number; confirmados_ayer: number }
}

const METHOD_BADGE: Record<string, { label: string; cls: string }> = {
  call:     { label: 'Llamada',  cls: 'bg-blue-100 text-blue-700'   },
  whatsapp: { label: 'WhatsApp', cls: 'bg-green-100 text-green-700' },
  other:    { label: 'Otro',     cls: 'bg-gray-100 text-gray-600'   },
}

export default function ConfirmadosPage() {
  const searchParams   = useSearchParams()
  const initialFilter  = (searchParams.get('filter') as FilterType) ?? 'todos'

  const [orders, setOrders]           = useState<ConfirmadoOrder[]>([])
  const [stats, setStats]             = useState({ confirmados_hoy: 0, confirmados_ayer: 0 })
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [activeFilter, setActiveFilter] = useState<FilterType>(initialFilter)
  const [pipelineCounts, setPipelineCounts] = useState<{ pendingTotal: number; despachados: number } | null>(null)
  const [fromDate, setFromDate]       = useState('')
  const [toDate, setToDate]           = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [readyMap, setReadyMap]       = useState<Record<string, boolean>>({})
  const [alertFilter, setAlertFilter] = useState<AlertFilter>('todos')
  const [currentPage, setCurrentPage] = useState(1)

  const PAGE_SIZE = 50

  function buildUrl(filter: FilterType, from: string, to: string): string {
    if (filter === 'hoy')  return '/api/confirmados?filter=hoy'
    if (filter === 'ayer') return '/api/confirmados?filter=ayer'
    if (filter === 'rango' && from && to) return `/api/confirmados?from=${from}T04:00:00Z&to=${to}T03:59:59Z`
    return '/api/confirmados'
  }

  const fetchData = useCallback(async (
    filter: FilterType = activeFilter,
    from:   string     = fromDate,
    to:     string     = toDate,
  ) => {
    setLoading(true)
    try {
      const [res, pipelineRes] = await Promise.all([
        fetch(buildUrl(filter, from, to)).then(r => r.json() as Promise<ApiResponse>),
        fetch('/api/confirmacion/stats').then(r => r.json()),
      ])
      setOrders(res.data  ?? [])
      setStats(res.stats  ?? { confirmados_hoy: 0, confirmados_ayer: 0 })
      setPipelineCounts({
        pendingTotal: pipelineRes.pendingTotal ?? 0,
        despachados:  pipelineRes.despachados  ?? 0,
      })
      setLastRefresh(new Date())
    } catch (err) {
      console.error('[confirmados/fetchData]', err)
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilter, fromDate, toDate])

  useEffect(() => {
    fetchData()
    const interval = setInterval(() => fetchData(), 3 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

  function applyFilter(filter: FilterType) {
    setActiveFilter(filter)
    fetchData(filter, fromDate, toDate)
  }

  function applyRango() {
    setActiveFilter('rango')
    fetchData('rango', fromDate, toDate)
  }

  const alertCounts = useMemo(() => ({
    duplicados: orders.filter(o => o.duplicate_alert).length,
    cobertura:  orders.filter(o => checkCoverage(o.customer_address, o.city).isOutOfCoverage).length,
    unknown:    orders.filter(o => checkCoverage(o.customer_address, o.city).isUnknownZone).length,
  }), [orders])

  const displayed = useMemo(() => {
    let base = orders

    if (alertFilter === 'duplicados')       base = base.filter(o => o.duplicate_alert)
    if (alertFilter === 'cobertura')        base = base.filter(o => checkCoverage(o.customer_address, o.city).isOutOfCoverage)
    if (alertFilter === 'zona_desconocida') base = base.filter(o => checkCoverage(o.customer_address, o.city).isUnknownZone)

    if (!searchQuery.trim()) return base
    const q = searchQuery.toLowerCase()
    return base.filter(o =>
      (o.order_number    ?? '').toLowerCase().includes(q) ||
      (o.customer_name   ?? '').toLowerCase().includes(q) ||
      (o.customer_phone  ?? '').toLowerCase().includes(q) ||
      (o.city            ?? '').toLowerCase().includes(q) ||
      (o.product_summary ?? '').toLowerCase().includes(q)
    )
  }, [orders, searchQuery, alertFilter])

  const pagedDisplayed = useMemo(
    () => displayed.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [displayed, currentPage],
  )
  const totalPages = Math.ceil(displayed.length / PAGE_SIZE)

  // Reset paginación al cambiar filtros o búsqueda
  useEffect(() => { setCurrentPage(1) }, [activeFilter, searchQuery, alertFilter])

  function markReady(id: string) {
    setReadyMap(prev => ({ ...prev, [id]: true }))
  }

  return (
    <div className="space-y-4">

      {/* ── Banner ── */}
      <div className="relative overflow-hidden rounded-2xl
                      bg-gradient-to-r from-green-500 to-emerald-600
                      border-2 border-green-400 shadow-lg shadow-green-200/50">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white" />
          <div className="absolute -right-2 -bottom-10 w-24 h-24 rounded-full bg-white" />
        </div>
        <div className="relative px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-12 h-12 bg-white/20 rounded-xl">
              <CheckCircle2 className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-black text-white tabular-nums">
                  {loading ? '…' : orders.length.toLocaleString()}
                </h1>
                {!loading && orders.length > 0 && (
                  <span className="flex items-center gap-1.5 bg-white/20 text-white
                                   text-xs font-bold px-2.5 py-1 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    CONFIRMADOS
                  </span>
                )}
              </div>
              <p className="text-white font-semibold">Confirmados sin guía</p>
              <p className="text-green-100 text-xs mt-0.5">
                Pendientes de asignar número de tracking · Listos para despachar
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <p className="text-green-100 text-xs">
              {lastRefresh.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
            </p>
            <button
              onClick={() => fetchData()}
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

      {/* ── Pipeline de navegación ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="flex items-stretch divide-x divide-gray-100">

          {/* Paso 1 — Link a /confirmacion */}
          <Link href="/confirmacion"
            className="flex-1 flex items-center gap-3 px-5 py-3.5 hover:bg-indigo-50 transition-colors group">
            <ClipboardList className="w-5 h-5 text-gray-300 group-hover:text-indigo-400 shrink-0 transition-colors" />
            <div className="min-w-0">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Paso 1</p>
              <p className="text-sm font-bold text-gray-600 group-hover:text-indigo-700 leading-tight transition-colors">Confirmación</p>
              <p className="text-2xl font-black tabular-nums text-indigo-600 leading-none">
                {pipelineCounts ? pipelineCounts.pendingTotal : '…'}
              </p>
            </div>
          </Link>

          <div className="flex items-center justify-center w-8 bg-gray-50 shrink-0">
            <ChevronRight className="w-4 h-4 text-gray-300" />
          </div>

          {/* Paso 2 — ACTIVO */}
          <div className="flex-1 flex items-center gap-3 px-5 py-3.5 bg-green-600">
            <CheckCircle2 className="w-5 h-5 text-green-200 shrink-0" />
            <div className="min-w-0">
              <p className="text-[10px] font-bold text-green-200 uppercase tracking-wider">Paso 2</p>
              <p className="text-sm font-bold text-white leading-tight">Sin guía</p>
              <p className="text-2xl font-black tabular-nums text-white leading-none">{loading ? '…' : orders.length}</p>
            </div>
          </div>

          <div className="flex items-center justify-center w-8 bg-gray-50 shrink-0">
            <ChevronRight className="w-4 h-4 text-gray-300" />
          </div>

          {/* Paso 3 — Link a /despachados */}
          <Link href="/despachados"
            className="flex-1 flex items-center gap-3 px-5 py-3.5 hover:bg-blue-50 transition-colors group">
            <Truck className="w-5 h-5 text-gray-300 group-hover:text-blue-400 shrink-0 transition-colors" />
            <div className="min-w-0">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Paso 3</p>
              <p className="text-sm font-bold text-gray-600 group-hover:text-blue-700 leading-tight transition-colors">Despachados</p>
              <p className="text-2xl font-black tabular-nums text-blue-600 leading-none">
                {pipelineCounts ? pipelineCounts.despachados : '…'}
              </p>
            </div>
          </Link>
        </div>
      </div>

      {/* ── Tarjetas de resumen ── */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => applyFilter('hoy')}
          className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all
            ${activeFilter === 'hoy'
              ? 'border-green-400 bg-green-100 text-green-800 ring-2 ring-green-300/50'
              : 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100'}`}
        >
          <div className="flex-1 min-w-0">
            <p className="text-3xl font-black tabular-nums leading-none">{stats.confirmados_hoy}</p>
            <p className="text-sm font-bold mt-1">Sin guía hoy</p>
          </div>
          <CheckCircle2 className="w-7 h-7 opacity-25 shrink-0" />
        </button>

        <button
          onClick={() => applyFilter('ayer')}
          className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all
            ${activeFilter === 'ayer'
              ? 'border-emerald-400 bg-emerald-100 text-emerald-800 ring-2 ring-emerald-300/50'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
        >
          <div className="flex-1 min-w-0">
            <p className="text-3xl font-black tabular-nums leading-none">{stats.confirmados_ayer}</p>
            <p className="text-sm font-bold mt-1">Sin guía ayer</p>
          </div>
          <Package className="w-7 h-7 opacity-25 shrink-0" />
        </button>
      </div>

      {/* ── Filtros ── */}
      <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0">Filtrar</span>
          <div className="flex items-center gap-2 flex-wrap">
            {([
              { key: 'todos', label: 'Todos' },
              { key: 'hoy',   label: 'Hoy'   },
              { key: 'ayer',  label: 'Ayer'  },
            ] as { key: FilterType; label: string }[]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => applyFilter(key)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors
                  ${activeFilter === key
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                {label}
              </button>
            ))}

            <div className="flex items-center gap-2 ml-2">
              <Calendar className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                className="text-xs border border-gray-200 rounded px-2 py-1
                           focus:outline-none focus:ring-1 focus:ring-green-300"
              />
              <span className="text-xs text-gray-400">—</span>
              <input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                className="text-xs border border-gray-200 rounded px-2 py-1
                           focus:outline-none focus:ring-1 focus:ring-green-300"
              />
              <button
                onClick={applyRango}
                disabled={!fromDate || !toDate}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg
                           bg-gray-100 text-gray-600 hover:bg-gray-200
                           transition-colors disabled:opacity-40"
              >
                Aplicar
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Filtros de alerta ── */}
      {(alertCounts.duplicados > 0 || alertCounts.cobertura > 0 || alertCounts.unknown > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 shrink-0">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              <span className="text-[11px] font-bold text-amber-700 uppercase tracking-wider">
                Alertas
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setAlertFilter('todos')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors
                  ${alertFilter === 'todos'
                    ? 'bg-amber-600 text-white'
                    : 'bg-white text-amber-700 border border-amber-200 hover:bg-amber-100'}`}
              >
                Todas las alertas
              </button>
              {alertCounts.duplicados > 0 && (
                <button
                  onClick={() => setAlertFilter(prev => prev === 'duplicados' ? 'todos' : 'duplicados')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors
                    ${alertFilter === 'duplicados'
                      ? 'bg-amber-500 text-white'
                      : 'bg-white text-amber-700 border border-amber-200 hover:bg-amber-100'}`}
                >
                  ⚠️ Duplicados
                  <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full
                    ${alertFilter === 'duplicados' ? 'bg-white/30 text-white' : 'bg-amber-100 text-amber-700'}`}>
                    {alertCounts.duplicados}
                  </span>
                </button>
              )}
              {alertCounts.cobertura > 0 && (
                <button
                  onClick={() => setAlertFilter(prev => prev === 'cobertura' ? 'todos' : 'cobertura')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors
                    ${alertFilter === 'cobertura'
                      ? 'bg-red-500 text-white'
                      : 'bg-white text-red-700 border border-red-200 hover:bg-red-50'}`}
                >
                  🚫 Fuera de cobertura
                  <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full
                    ${alertFilter === 'cobertura' ? 'bg-white/30 text-white' : 'bg-red-100 text-red-700'}`}>
                    {alertCounts.cobertura}
                  </span>
                </button>
              )}
              {alertCounts.unknown > 0 && (
                <button
                  onClick={() => setAlertFilter(prev => prev === 'zona_desconocida' ? 'todos' : 'zona_desconocida')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors
                    ${alertFilter === 'zona_desconocida'
                      ? 'bg-yellow-500 text-white'
                      : 'bg-white text-yellow-700 border border-yellow-200 hover:bg-yellow-50'}`}
                >
                  🟡 Zona desconocida
                  <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full
                    ${alertFilter === 'zona_desconocida' ? 'bg-white/30 text-white' : 'bg-yellow-100 text-yellow-700'}`}>
                    {alertCounts.unknown}
                  </span>
                </button>
              )}
            </div>
            {alertFilter !== 'todos' && (
              <button
                onClick={() => setAlertFilter('todos')}
                className="text-xs text-amber-600 hover:underline ml-auto shrink-0"
              >
                Limpiar filtro
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Tabla ── */}
      <div className="bg-white rounded-xl border-2 border-green-200 overflow-hidden shadow-sm">

        {/* Buscador */}
        <div className="px-4 py-3 border-b border-green-100">
          <div className="relative max-w-lg">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Buscar por # pedido, nombre, teléfono, ciudad o producto…"
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-green-300 focus:border-green-300
                         placeholder:text-gray-400"
            />
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16">
            <Spinner className="w-6 h-6 text-green-500" />
          </div>
        )}

        {!loading && displayed.length === 0 && (
          <div className="px-5 py-12 text-center">
            <p className="text-gray-500 font-medium">
              {searchQuery
                ? `Sin resultados para "${searchQuery}"`
                : 'No hay pedidos confirmados sin guía en este período'}
            </p>
            {activeFilter !== 'todos' && (
              <button
                onClick={() => applyFilter('todos')}
                className="text-green-600 text-sm mt-2 hover:underline"
              >
                Ver todos los confirmados
              </button>
            )}
          </div>
        )}

        {!loading && displayed.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-green-50/60 border-b border-green-100">
                <tr>
                  {['# Pedido', 'Cliente', 'Ciudad', 'Producto', 'COD', 'Confirmado', 'Método', 'Acción'].map(h => (
                    <th key={h}
                        className="px-3 py-3 text-left text-xs font-semibold text-green-800 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-green-50">
                {pagedDisplayed.map(order => {
                  const isReady    = !!readyMap[order.id]
                  const method     = order.confirmation_method
                    ? (METHOD_BADGE[order.confirmation_method] ?? METHOD_BADGE['other'])
                    : null
                  const hasDup     = !!order.duplicate_alert
                  const cov        = checkCoverage(order.customer_address, order.city)
                  const hasAlert   = hasDup || cov.isOutOfCoverage || cov.isUnknownZone

                  return (
                    <tr
                      key={order.id}
                      className={`transition-colors
                        ${hasAlert ? 'bg-amber-50/40 hover:bg-amber-50/70' : 'hover:bg-green-50/40'}`}
                    >

                      {/* # Pedido */}
                      <td className="px-3 py-2.5">
                        <p className="font-mono text-xs font-semibold text-gray-900 whitespace-nowrap">
                          {order.order_number ?? '—'}
                        </p>
                      </td>

                      {/* Cliente */}
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[140px]">
                          {order.customer_name ?? '—'}
                        </p>
                        <p className="font-mono text-xs text-gray-500 mt-0.5">
                          {order.customer_phone ?? '—'}
                        </p>
                        <AlertBadges
                          duplicateAlert={order.duplicate_alert}
                          customerAddress={order.customer_address}
                          city={order.city}
                        />
                      </td>

                      {/* Ciudad */}
                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-1 text-gray-600">
                          <MapPin className="w-3 h-3 text-gray-400 shrink-0 mt-0.5" />
                          <span className="text-xs truncate max-w-[90px]">
                            {order.city ?? '—'}
                          </span>
                        </div>
                      </td>

                      {/* Producto */}
                      <td className="px-3 py-2.5 max-w-[160px]">
                        <p className="text-xs text-gray-600 truncate" title={order.product_summary ?? ''}>
                          {order.product_summary ?? '—'}
                        </p>
                      </td>

                      {/* COD */}
                      <td className="px-3 py-2.5">
                        <span className="text-sm font-semibold text-gray-900 whitespace-nowrap tabular-nums">
                          {formatCurrency(order.cod_amount)}
                        </span>
                      </td>

                      {/* Fecha confirmación */}
                      <td className="px-3 py-2.5">
                        <span className="text-xs text-gray-600 whitespace-nowrap">
                          {formatEventDate(order.last_confirmation_attempt)}
                        </span>
                      </td>

                      {/* Método */}
                      <td className="px-3 py-2.5">
                        {method ? (
                          <span className={`inline-flex items-center text-[11px] font-semibold
                                           px-2 py-0.5 rounded-full ${method.cls}`}>
                            {method.label}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>

                      {/* Acción */}
                      <td className="px-3 py-2.5">
                        {isReady ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold
                                           px-2.5 py-1 rounded-full bg-green-100 text-green-700">
                            <CheckCircle2 className="w-3 h-3" />
                            Marcado
                          </span>
                        ) : (
                          <button
                            onClick={() => markReady(order.id)}
                            className="flex items-center gap-1.5 bg-green-600 hover:bg-green-700
                                       text-white text-[11px] font-semibold px-3 py-1.5 rounded-lg
                                       transition-colors shadow-sm whitespace-nowrap"
                          >
                            <Truck className="w-3 h-3 shrink-0" />
                            Listo para despacho
                          </button>
                        )}
                      </td>

                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-green-100 bg-green-50/40">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg
                         border border-green-200 text-green-700 bg-white hover:bg-green-50
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Anterior
            </button>
            <span className="text-xs text-gray-500 tabular-nums">
              Página <span className="font-bold text-gray-800">{currentPage}</span> de{' '}
              <span className="font-bold text-gray-800">{totalPages}</span>
              {' '}·{' '}
              <span className="text-gray-400">{displayed.length} resultados</span>
            </span>
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg
                         border border-green-200 text-green-700 bg-white hover:bg-green-50
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Siguiente
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

    </div>
  )
}
