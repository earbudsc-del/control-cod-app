'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/orders/status-badge'
import { ClassificationBadge } from '@/components/orders/classification-badge'
import { SlaBadge } from '@/components/orders/sla-badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { formatDate, formatCurrency, getSlaStatus, truncate } from '@/lib/utils'
import { Search, Filter, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Order, NormalizedStatus, Classification } from '@/types'
import { TrackingButton, type TrackingUpdateResult } from '@/components/orders/tracking-button'
import { BulkTrackingButton } from '@/components/orders/bulk-tracking-button'

interface OrdersResponse {
  data: Order[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '',                label: 'Todos los estados' },
  { value: 'pending',         label: 'Pendiente' },
  { value: 'in_transit',      label: 'En tránsito' },
  { value: 'out_for_delivery',label: 'En ruta' },
  { value: 'en_reparto',      label: 'En reparto' },
  { value: 'failed_attempt',  label: 'Intento fallido' },
  { value: 'delivered',       label: 'Entregado' },
  { value: 'returned',        label: 'Devuelto' },
]

const CLASS_OPTIONS: { value: string; label: string }[] = [
  { value: '',          label: 'Todas' },
  { value: 'critical',  label: 'Crítico' },
  { value: 'urgent',    label: 'Urgente' },
  { value: 'follow_up', label: 'Seguimiento' },
  { value: 'claim',     label: 'Reclamo' },
]

export default function OrdersPage() {
  const router       = useRouter()
  const searchParams = useSearchParams()

  const [orders, setOrders]     = useState<Order[]>([])
  const [pagination, setPagination] = useState({ page: 1, total: 0, pages: 1 })
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState(searchParams.get('search') ?? '')
  const [status, setStatus]     = useState(searchParams.get('status') ?? '')
  const [cls, setCls]           = useState(searchParams.get('classification') ?? '')
  const [riskOnly, setRiskOnly] = useState(searchParams.get('is_at_risk') === 'true')
  const [slaOnly, setSlaOnly]   = useState(searchParams.get('sla_breached') === 'true')
  const [page, setPage]         = useState(parseInt(searchParams.get('page') ?? '1'))

  function updateOrder(orderId: string, result: TrackingUpdateResult) {
    setOrders(prev => prev.map(o =>
      o.id === orderId
        ? { ...o, normalized_status: result.normalized_status, delivery_attempts: result.delivery_attempts }
        : o,
    ))
  }

  const fetchOrders = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (search)  params.set('search', search)
    if (status)  params.set('status', status)
    if (cls)     params.set('classification', cls)
    if (riskOnly) params.set('is_at_risk', 'true')
    if (slaOnly)  params.set('sla_breached', 'true')
    params.set('page', String(page))
    params.set('limit', '50')

    const res: OrdersResponse = await fetch(`/api/orders?${params}`).then(r => r.json())
    setOrders(res.data ?? [])
    setPagination(res.pagination ?? { page: 1, total: 0, pages: 1 })
    setLoading(false)
  }, [search, status, cls, riskOnly, slaOnly, page])

  useEffect(() => { fetchOrders() }, [fetchOrders])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setPage(1)
    fetchOrders()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Pedidos</h1>
          <p className="text-sm text-gray-500 mt-0.5">{pagination.total.toLocaleString()} pedidos</p>
        </div>
        <div className="flex items-center gap-2">
          <BulkTrackingButton onComplete={fetchOrders} />
          <Link href="/imports">
            <Button size="sm">Importar</Button>
          </Link>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <div className="flex flex-wrap gap-3">
          <form onSubmit={handleSearch} className="flex gap-2 flex-1 min-w-[200px]">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Guía, cliente, teléfono…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <Button type="submit" size="sm">Buscar</Button>
          </form>

          <select
            value={status}
            onChange={e => { setStatus(e.target.value); setPage(1) }}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>

          <select
            value={cls}
            onChange={e => { setCls(e.target.value); setPage(1) }}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {CLASS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>

          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={riskOnly}
              onChange={e => { setRiskOnly(e.target.checked); setPage(1) }}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Solo en riesgo
          </label>

          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={slaOnly}
              onChange={e => { setSlaOnly(e.target.checked); setPage(1) }}
              className="rounded border-gray-300 text-red-600 focus:ring-red-500"
            />
            SLA vencido
          </label>
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner className="w-6 h-6 text-blue-600" />
          </div>
        ) : orders.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Filter className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">Sin pedidos con los filtros actuales</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  {['Guía / Pedido','Cliente','Estado','Intentos','Clasificación','SLA','Asignado','Actualizado',''].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {orders.map(order => {
                  const slaStatus = getSlaStatus(order.sla_deadline, order.sla_breached)
                  return (
                    <tr
                      key={order.id}
                      className={`hover:bg-gray-50 cursor-pointer transition-colors
                        ${order.is_at_risk ? 'border-l-2 border-l-red-400' : ''}`}
                      onClick={() => router.push(`/orders/${order.id}`)}
                    >
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs font-medium text-gray-900">{order.tracking_number}</p>
                        {order.order_number && (
                          <p className="text-xs text-gray-400">{order.order_number}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-800 truncate max-w-[140px]">
                          {order.customer_name ?? '—'}
                        </p>
                        <p className="text-xs text-gray-400">{order.customer_phone ?? ''}</p>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={order.normalized_status} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        {order.delivery_attempts > 0 ? (
                          <span className={`font-bold text-sm
                            ${order.delivery_attempts >= 3 ? 'text-red-600' :
                              order.delivery_attempts === 2 ? 'text-amber-600' : 'text-gray-700'}`}>
                            {order.delivery_attempts}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                        {order.invalid_attempts > 0 && (
                          <span className="ml-1 text-xs text-red-400" title="Intentos inválidos">
                            +{order.invalid_attempts}⚠
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <ClassificationBadge classification={order.classification} />
                      </td>
                      <td className="px-4 py-3">
                        {order.classification && (
                          <SlaBadge status={slaStatus} deadline={order.sla_deadline} />
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-xs text-gray-600">
                          {(order as any).assigned_name ?? <span className="text-gray-300">Sin asignar</span>}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-xs text-gray-400 whitespace-nowrap">
                          {formatDate(order.updated_at)}
                        </p>
                      </td>
                      {/* Tracking — stopPropagation para no navegar al detalle */}
                      <td
                        className="px-4 py-3"
                        onClick={e => e.stopPropagation()}
                      >
                        <TrackingButton
                          orderId={order.id}
                          trackingNumber={order.tracking_number}
                          onUpdated={result => updateOrder(order.id, result)}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Paginación */}
        {pagination.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-50">
            <p className="text-xs text-gray-500">
              Página {pagination.page} de {pagination.pages} · {pagination.total} total
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary" size="sm"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                variant="secondary" size="sm"
                disabled={page >= pagination.pages}
                onClick={() => setPage(p => p + 1)}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
