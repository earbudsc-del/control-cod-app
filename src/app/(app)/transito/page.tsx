'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Spinner } from '@/components/ui/spinner'
import { formatEventDate } from '@/lib/utils'
import type { Order } from '@/types'
import {
  Package, RefreshCw, ShieldAlert, AlertTriangle,
  Clock, ExternalLink, MapPin, ChevronLeft, ChevronRight,
  Search, X,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function cityDisplay(order: Order): string {
  if (order.city && order.city.trim())     return order.city.trim()
  if (order.province && order.province.trim()) return order.province.trim()
  if (order.customer_address && order.customer_address.trim()) {
    // Intenta extraer una ubicación del address (último segmento separado por coma)
    const parts = order.customer_address.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return 'Ubicación no registrada'
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
  const [orders, setOrders]           = useState<Order[]>([])
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [currentPage, setCurrentPage] = useState(1)
  const [search, setSearch]           = useState('')

  const PAGE_SIZE = 50

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res: OrdersResponse = await fetch(
        '/api/orders?status=in_transit&limit=200&page=1'
      ).then(r => r.json())
      const loaded = res.data ?? []
      setOrders(loaded)
      setLastRefresh(new Date())

      // ── Debug: muestra campos clave para diagnóstico de stuckSince ──
      if (process.env.NODE_ENV !== 'production' || true) {
        for (const o of loaded) {
          const horas = horasEnTransito(o)
          const crit  = transitCriticality(o)
          console.log('[transito-debug]', {
            tracking_number:      o.tracking_number,
            raw_status:           o.raw_status,
            normalized_status:    o.normalized_status,
            status_since:         o.status_since,
            shipment_created_at:  o.shipment_created_at,
            last_tracking_update: o.last_tracking_update,
            shopify_created_at:   o.shopify_created_at,
            created_at:           o.created_at,
            stuckSince_used:      o.status_since ?? o.shipment_created_at ?? o.shopify_created_at ?? o.created_at,
            horas_calculadas:     Math.round(horas * 10) / 10,
            categoria:            crit,
          })
        }
      }
    } catch (err) {
      console.error('[transito/fetchData]', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

  // ── Búsqueda client-side ───────────────────────────────────────────────────

  const filteredOrders = useMemo(() => {
    if (!search.trim()) return orders
    const q = search.trim().toLowerCase()
    return orders.filter(o =>
      (o.tracking_number  ?? '').toLowerCase().includes(q) ||
      (o.order_number     ?? '').toLowerCase().includes(q) ||
      (o.customer_name    ?? '').toLowerCase().includes(q) ||
      (o.customer_phone   ?? '').toLowerCase().includes(q) ||
      (o.city             ?? '').toLowerCase().includes(q) ||
      (o.province         ?? '').toLowerCase().includes(q) ||
      (o.raw_status       ?? '').toLowerCase().includes(q)
    )
  }, [orders, search])

  // Reset página al cambiar búsqueda
  useEffect(() => { setCurrentPage(1) }, [search])

  // ── Datos derivados ────────────────────────────────────────────────────────

  const criticos = useMemo(() => filteredOrders.filter(o => horasEnTransito(o) >= 48),  [filteredOrders])
  const riesgo   = useMemo(() => filteredOrders.filter(o => horasEnTransito(o) >= 24 && horasEnTransito(o) < 48), [filteredOrders])
  const normales = useMemo(() => filteredOrders.filter(o => horasEnTransito(o) < 24),   [filteredOrders])
  const sorted   = useMemo(() => sortedByStale(filteredOrders), [filteredOrders])

  const pagedSorted = useMemo(
    () => sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [sorted, currentPage],
  )
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)

  // Reset paginación cuando cambia el conjunto de órdenes
  useEffect(() => { setCurrentPage(1) }, [sorted.length])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

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
              <div className="flex items-center gap-3">
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
              </div>
              <p className="text-white font-semibold">Pedidos en tránsito</p>
              <p className="text-blue-100 text-xs mt-0.5">
                Monitoreo de retrasos — detecta problemas antes de que lleguen a novedad
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <p className="text-blue-100 text-xs">
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

      {/* ── Tarjetas de clasificación ── */}
      <div className="grid grid-cols-3 gap-3">
        {([
          {
            count: criticos.length,
            label: 'Críticos (+48h)',
            sub:   '+2 días sin movimiento',
            cls:   'border-red-200 bg-red-50 text-red-700',
            Icon:  ShieldAlert,
          },
          {
            count: riesgo.length,
            label: 'En riesgo (1–2 días)',
            sub:   'Requieren vigilancia',
            cls:   'border-yellow-200 bg-yellow-50 text-yellow-700',
            Icon:  AlertTriangle,
          },
          {
            count: normales.length,
            label: 'Normales (0–1 día)',
            sub:   'En movimiento reciente',
            cls:   'border-green-200 bg-green-50 text-green-700',
            Icon:  Clock,
          },
        ] as const).map(({ count, label, sub, cls, Icon }) => (
          <div key={label} className={`flex items-center gap-3 p-4 rounded-xl border-2 ${cls}`}>
            <div className="flex-1 min-w-0">
              <p className="text-3xl font-black tabular-nums leading-none">{count}</p>
              <p className="text-sm font-bold mt-1">{label}</p>
              <p className="text-xs opacity-60 mt-0.5 truncate">{sub}</p>
            </div>
            <Icon className="w-7 h-7 opacity-25 shrink-0" />
          </div>
        ))}
      </div>

      {/* ── Escalamiento operativo ── */}
      {!loading && (criticos.length > 0 || riesgo.length > 0) && (
        <div className="space-y-2">
          {riesgo.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-2.5 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-yellow-600 shrink-0 mt-0.5" />
              <p className="text-xs text-yellow-800 font-medium leading-relaxed">
                <span className="font-bold">{riesgo.length} guía{riesgo.length !== 1 ? 's' : ''} +24h</span>
                {' '}— Requieren seguimiento con Effi / transportadora antes de convertirse en novedad.
              </p>
            </div>
          )}
          {criticos.length > 0 && (
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
      {search && (
        <p className="text-xs text-gray-500 -mt-2">
          {sorted.length === 0
            ? 'Sin resultados para esa búsqueda'
            : `${sorted.length} resultado${sorted.length !== 1 ? 's' : ''} para "${search}"`}
        </p>
      )}

      {/* ── Sin pedidos en tránsito ── */}
      {!loading && orders.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-6 text-center">
          <p className="text-green-700 font-medium">No hay pedidos en tránsito en este momento</p>
          <p className="text-green-600 text-sm mt-1">
            Los pedidos aparecerán aquí cuando su estado sea IN_TRANSIT
          </p>
        </div>
      )}

      {/* ── Sin resultados de búsqueda ── */}
      {!loading && orders.length > 0 && sorted.length === 0 && search && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl px-5 py-6 text-center">
          <p className="text-gray-600 font-medium">Sin resultados para &quot;{search}&quot;</p>
          <button onClick={() => setSearch('')} className="text-blue-600 text-sm mt-1 underline">
            Limpiar búsqueda
          </button>
        </div>
      )}

      {/* ── Tabla ── */}
      {(loading || sorted.length > 0) && (
        <div className="bg-white rounded-xl border-2 border-blue-100 overflow-hidden shadow-sm">

          <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center gap-2">
            <Package className="w-4 h-4 text-blue-600 shrink-0" />
            <p className="text-sm font-semibold text-blue-800">
              Detalle · Ordenado por mayor tiempo sin movimiento
            </p>
            {search && (
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
                  const crit         = transitCriticality(order)
                  const style        = TRANSIT_STYLES[crit]
                  // Usa la misma fuente que transitSinceMs para mostrar la fecha base
                  const stuckSinceTs = order.status_since ?? order.shipment_created_at ?? order.shopify_created_at ?? order.created_at
                  const loc          = cityDisplay(order)
                  return (
                    <tr key={order.id} className={`transition-colors group ${style.row}`}>

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
                          <span className={`text-xs truncate max-w-[100px] ${loc === 'Ubicación no registrada' ? 'text-gray-400 italic' : ''}`}>
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
                          ${crit === 'critico' ? 'text-red-600'
                            : crit === 'riesgo' ? 'text-yellow-700'
                            : 'text-gray-600'}`}>
                          {sinMovimientoLabel(order)}
                        </p>
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          {stuckSinceTs ? formatEventDate(stuckSinceTs) : '—'}
                        </p>
                      </td>

                      {/* Estado badge + raw_status */}
                      <td className="px-3 py-2.5">
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
                      </td>

                      {/* Ver detalle */}
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/orders/${order.id}`}
                          className="inline-flex items-center gap-1 text-xs font-medium
                                     text-blue-600 hover:text-blue-800 whitespace-nowrap hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Ver
                        </Link>
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

          {!loading && orders.length > 200 && (
            <div className="px-5 py-3 bg-blue-50 border-t border-blue-100 text-center">
              <p className="text-xs text-blue-700">
                Mostrando 200 pedidos.{' '}
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
        </ul>
        <p className="text-xs text-gray-400 mt-1">
          El tiempo estancado se calcula desde <strong className="text-gray-500">status_since</strong> (fecha real del estado EFI),
          con fallback a shipment_created_at → shopify_created_at → created_at.
          El campo &quot;Último sync EFI&quot; (last_tracking_update) <em>no</em> se usa para este cálculo.
        </p>
      </div>

    </div>
  )
}
