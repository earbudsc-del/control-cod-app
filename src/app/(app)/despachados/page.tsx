'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Spinner } from '@/components/ui/spinner'
import { whatsAppUrl, callUrl, formatCurrency } from '@/lib/utils'
import { type Order, STATUS_LABELS, STATUS_COLORS } from '@/types'
import {
  Truck, RefreshCw, MessageCircle, Phone,
  MapPin, ExternalLink, Search, ChevronLeft, ChevronRight,
  Package,
} from 'lucide-react'

const PAGE_SIZE = 50

interface ApiResponse {
  data:     Order[]
  total:    number
  byStatus: Record<string, number>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / (1000 * 60 * 60))
  if (h < 1)  return 'Hace menos de 1h'
  if (h < 24) return `Hace ${h}h`
  const d = Math.floor(h / 24)
  const r = h % 24
  return r > 0 ? `Hace ${d}d ${r}h` : `Hace ${d}d`
}

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

// ── Componente ────────────────────────────────────────────────────────────────

export default function DespachadosPage() {
  const [orders, setOrders]           = useState<Order[]>([])
  const [total, setTotal]             = useState(0)
  const [byStatus, setByStatus]       = useState<Record<string, number>>({})
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res: ApiResponse = await fetch('/api/despachados').then(r => r.json())
      setOrders(res.data     ?? [])
      setTotal(res.total     ?? 0)
      setByStatus(res.byStatus ?? {})
      setLastRefresh(new Date())
    } catch (err) {
      console.error('[despachados/fetchData]', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Auto-refresh cada 5 min (mismo ciclo que el cron de tracking)
  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

  useEffect(() => { setCurrentPage(1) }, [searchQuery])

  const filteredOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return orders
    return orders.filter(o =>
      (o.customer_name    ?? '').toLowerCase().includes(q) ||
      (o.customer_phone   ?? '').toLowerCase().includes(q) ||
      (o.order_number     ?? '').toLowerCase().includes(q) ||
      (o.tracking_number  ?? '').toLowerCase().includes(q) ||
      (o.city             ?? '').toLowerCase().includes(q),
    )
  }, [orders, searchQuery])

  const pagedOrders = useMemo(
    () => filteredOrders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredOrders, currentPage],
  )
  const totalPages = Math.ceil(filteredOrders.length / PAGE_SIZE)

  // Mini KPI — estados presentes
  const kpiItems = [
    { key: 'in_transit', label: 'En tránsito' },
    { key: 'en_reparto', label: 'En reparto'  },
    { key: 'novedad',    label: 'Novedad'      },
    { key: 'unknown',    label: 'Sin estado'   },
    { key: 'pending',    label: 'Pendiente'    },
  ].filter(({ key }) => (byStatus[key] ?? 0) > 0)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* ── Banner ── */}
      <div className="relative overflow-hidden rounded-2xl
                      bg-gradient-to-r from-blue-500 to-cyan-600
                      border-2 border-blue-400 shadow-lg shadow-blue-200/50">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white" />
          <div className="absolute -right-2 -bottom-10 w-24 h-24 rounded-full bg-white" />
        </div>
        <div className="relative px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-12 h-12 bg-white/20 rounded-xl">
              <Truck className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-black text-white tabular-nums">
                  {loading ? '…' : total.toLocaleString()}
                </h1>
                {!loading && total > 0 && (
                  <span className="flex items-center gap-1.5 bg-white/20 text-white
                                   text-xs font-bold px-2.5 py-1 rounded-full">
                    EN RUTA
                  </span>
                )}
              </div>
              <p className="text-white font-semibold">Pedidos despachados</p>
              <p className="text-blue-100 text-xs mt-0.5">
                Con guía EFI activa · El estado se actualiza cada 5 min
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

      {/* ── Mini KPI por estado ── */}
      {!loading && kpiItems.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          {kpiItems.map(({ key, label }) => (
            <div
              key={key}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-semibold
                ${STATUS_COLORS[key as keyof typeof STATUS_COLORS] ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}
            >
              <span className="text-lg font-black tabular-nums leading-none">{byStatus[key]}</span>
              <span className="text-xs">{label}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Sin pedidos ── */}
      {!loading && total === 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-6 text-center">
          <p className="text-blue-700 font-medium">No hay pedidos despachados activos</p>
          <p className="text-blue-600 text-sm mt-1">
            Cuando se asigne una guía EFI a un pedido confirmado, aparecerá aquí automáticamente
          </p>
        </div>
      )}

      {/* ── Tabla ── */}
      {(loading || total > 0) && (
        <div className="bg-white rounded-xl border-2 border-blue-200 overflow-hidden shadow-sm">

          {/* Header */}
          <div className="px-5 py-3 bg-blue-50 border-b border-blue-200 flex items-center gap-2">
            <Package className="w-4 h-4 text-blue-600 shrink-0" />
            <p className="text-sm font-semibold text-blue-800">
              Pedidos con guía activa · Solo estados no finalizados · Entregados y devueltos aparecen en sus módulos
            </p>
          </div>

          {/* Buscador */}
          <div className="px-4 py-2.5 border-b border-blue-100">
            <div className="relative max-w-lg">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Buscar por nombre, teléfono, #pedido, guía o ciudad..."
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg
                           focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-400
                           placeholder:text-gray-400 bg-white"
              />
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner className="w-6 h-6 text-blue-500" />
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-gray-500 font-medium">
                {searchQuery ? `Sin resultados para "${searchQuery}"` : 'No hay pedidos en esta vista'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-blue-50/60 border-b border-blue-100">
                  <tr>
                    {['Cliente', 'Guía', 'Ciudad / Producto', 'Monto', 'Estado logístico', 'Último mvto.', 'Contactar', ''].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-blue-800 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-50">
                  {pagedOrders.map(order => {
                    const nombre   = order.customer_name ?? ''
                    const waUrl    = whatsAppUrl(order.customer_phone, '')
                    const telUrl   = callUrl(order.customer_phone)
                    const hasPhone = !!order.customer_phone
                    const ns       = order.normalized_status

                    return (
                      <tr key={order.id} className="hover:bg-blue-50/30 transition-colors">

                        {/* Cliente */}
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

                        {/* Guía */}
                        <td className="px-3 py-2.5">
                          <p className="font-mono text-xs font-semibold text-blue-700 bg-blue-50
                                        px-2 py-1 rounded border border-blue-200 w-fit whitespace-nowrap">
                            {order.tracking_number || '—'}
                          </p>
                        </td>

                        {/* Ciudad / Producto */}
                        <td className="px-3 py-2.5 max-w-[160px]">
                          <div className="flex items-center gap-1">
                            <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                            <span className="text-xs text-gray-700 truncate">
                              {[order.city, order.province].filter(Boolean).join(', ') || '—'}
                            </span>
                          </div>
                          <p className="text-[10px] text-gray-400 truncate mt-0.5" title={order.product_summary ?? ''}>
                            {order.product_summary || '—'}
                          </p>
                        </td>

                        {/* Monto */}
                        <td className="px-3 py-2.5">
                          <p className="text-sm font-semibold text-green-700 whitespace-nowrap tabular-nums">
                            {formatCurrency(order.cod_amount)}
                          </p>
                        </td>

                        {/* Estado logístico */}
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full w-fit
                            ${STATUS_COLORS[ns] ?? 'bg-gray-100 text-gray-600'}`}>
                            {STATUS_LABELS[ns] ?? ns}
                          </span>
                          {order.raw_status && (
                            <p className="text-[10px] text-gray-400 mt-0.5 truncate max-w-[120px]"
                               title={order.raw_status}>
                              {order.raw_status}
                            </p>
                          )}
                        </td>

                        {/* Último movimiento */}
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="text-xs text-gray-600">
                            {formatRelativeTime(order.last_tracking_update)}
                          </span>
                        </td>

                        {/* Contactar */}
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

                        {/* Ver detalle */}
                        <td className="px-3 py-2.5">
                          <Link
                            href={`/orders/${order.id}`}
                            className="inline-flex items-center gap-1 text-xs font-medium
                                       text-indigo-600 hover:text-indigo-800 whitespace-nowrap hover:underline"
                          >
                            <ExternalLink className="w-3 h-3" />Ver
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
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
                           border border-blue-200 text-blue-700 bg-white hover:bg-blue-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente<ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {!loading && total > 200 && (
            <div className="px-5 py-3 bg-blue-50 border-t border-blue-100 text-center">
              <p className="text-xs text-blue-700">Mostrando 200 de {total} pedidos despachados.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Info ── */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-5 py-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          <strong className="text-gray-700">Esta vista es de monitoreo.</strong>{' '}
          El estado logístico se actualiza automáticamente desde EFI cada 5 minutos.
          Los pedidos entregados pasan a <strong>En Reparto</strong> o <strong>Novedades</strong> según el resultado del courier.
        </p>
      </div>
    </div>
  )
}
