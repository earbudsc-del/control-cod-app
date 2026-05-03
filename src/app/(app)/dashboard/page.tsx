'use client'

import { useEffect, useState } from 'react'
import { ClassificationBadge } from '@/components/orders/classification-badge'
import { SlaBadge } from '@/components/orders/sla-badge'
import { Spinner } from '@/components/ui/spinner'
import { timeAgo, getSlaStatus } from '@/lib/utils'
import { ACTION_LABELS, type Classification, type SlaStatus } from '@/types'
import {
  Package, TrendingDown, CheckCircle, AlertTriangle,
  RotateCcw, Clock, ShieldAlert, Bike, ArrowRight, Timer, ListTodo,
  TrendingUp, CheckCircle2,
} from 'lucide-react'
import Link from 'next/link'

interface DashboardData {
  stats: {
    total: number
    on_delivery: number
    delivered: number
    in_transit: number
    transit_critico: number
    failed_attempts: number
    returned: number
    at_risk: number
    sla_breached: number
  }
  confirmed_hoy:  number
  confirmed_ayer: number
  sla_alerts: Array<{
    id: string
    tracking_number: string
    customer_name: string | null
    classification: Classification | null
    sla_status: SlaStatus
    sla_deadline: string | null
    assigned_name: string | null
  }>
  classification: Record<string, number>
  recent_activity: Array<{
    id: string
    action_type: string
    created_at: string
    orders: { tracking_number: string; customer_name: string | null } | null
    profile: { full_name: string } | null
  }>
  stale_reparto: Array<{
    id: string
    tracking_number: string
    customer_name: string | null
    city: string | null
    last_tracking_update: string | null
    created_at: string
  }>
  stale_novedad: Array<{
    id: string
    tracking_number: string
    customer_name: string | null
    city: string | null
    last_tracking_update: string | null
    created_at: string
  }>
  stale_transit: Array<{
    id: string
    tracking_number: string
    customer_name: string | null
    city: string | null
    last_tracking_update: string | null
    created_at: string
  }>
  work_queue: Array<{
    id: string
    tracking_number: string
    customer_name: string | null
    city: string | null
    normalized_status: string
    delivery_attempts: number
    sla_breached: boolean
    last_tracking_update: string | null
    created_at: string
    priority: 1 | 2 | 3
    reason: string
  }>
}

function KpiCard({
  label, value, icon: Icon, color, sub,
}: {
  label: string
  value: number
  icon: React.ElementType
  color: string
  sub?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5 flex items-center gap-4">
      <div className={`p-3 rounded-xl ${color}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900">{value.toLocaleString()}</p>
        <p className="text-sm text-gray-500">{label}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

function EnRepartoCard({ count }: { count: number }) {
  return (
    <div className="col-span-2 lg:col-span-4 relative overflow-hidden rounded-xl
                    bg-gradient-to-r from-amber-400 to-amber-500
                    border-2 border-amber-400 shadow-lg shadow-amber-200">
      {/* Fondo decorativo */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute -right-6 -top-6 w-32 h-32 rounded-full bg-white" />
        <div className="absolute -right-2 -bottom-8 w-20 h-20 rounded-full bg-white" />
      </div>

      <div className="relative flex items-center justify-between px-6 py-5 gap-6">
        {/* Izquierda — datos */}
        <div className="flex items-center gap-5">
          <div className="flex items-center justify-center w-14 h-14 bg-white/20 rounded-xl backdrop-blur-sm">
            <Bike className="w-7 h-7 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <p className="text-4xl font-black text-white tabular-nums">
                {count.toLocaleString()}
              </p>
              {count > 0 && (
                <span className="flex items-center gap-1 bg-white/20 text-white text-xs
                                 font-semibold px-2 py-0.5 rounded-full animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-white inline-block" />
                  EN CURSO
                </span>
              )}
            </div>
            <p className="text-amber-100 font-semibold text-base">En reparto ahora</p>
            <p className="text-amber-200 text-xs mt-0.5">Requieren contacto inmediato</p>
          </div>
        </div>

        {/* Derecha — botón */}
        <Link
          href="/reparto"
          className="flex items-center gap-2 bg-white text-amber-700 font-semibold
                     text-sm px-5 py-2.5 rounded-xl hover:bg-amber-50 transition-colors
                     shrink-0 shadow-sm"
        >
          Ver pedidos en reparto
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/dashboard')
      .then(r => r.json())
      .then(setData)
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-blue-600" />
      </div>
    )
  }

  if (!data?.stats) return null

  const { stats, sla_alerts, classification, recent_activity, stale_reparto, stale_novedad, stale_transit, work_queue, confirmed_hoy, confirmed_ayer } = data

  const PRIORITY_CONFIG = {
    3: { label: 'Alta',  dot: 'bg-red-500',    badge: 'bg-red-100 text-red-700',       text: 'text-red-700'    },
    2: { label: 'Media', dot: 'bg-orange-400',  badge: 'bg-orange-100 text-orange-700', text: 'text-orange-700' },
    1: { label: 'Baja',  dot: 'bg-yellow-400',  badge: 'bg-yellow-100 text-yellow-700', text: 'text-yellow-700' },
  } as const

  function daysSince(last: string | null, fallback: string): number {
    const base = last ?? fallback
    return Math.floor((Date.now() - new Date(base).getTime()) / (1000 * 60 * 60 * 24))
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">Resumen operativo de pedidos COD</p>
      </div>

      {/* KPIs — tarjeta En Reparto al frente */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <EnRepartoCard count={stats.on_delivery} />

        <KpiCard label="Total pedidos"    value={stats.total}           icon={Package}       color="bg-blue-50 text-blue-600" />
        <KpiCard label="Entregados"        value={stats.delivered}       icon={CheckCircle}   color="bg-green-50 text-green-600" />
        <KpiCard label="En tránsito"       value={stats.in_transit}      icon={Clock}         color="bg-indigo-50 text-indigo-600" />
        {stats.transit_critico > 0 ? (
          <div className="bg-white rounded-xl border-2 border-red-200 p-5 flex items-center gap-4">
            <div className="p-3 rounded-xl bg-red-100 text-red-600">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold text-red-700">{stats.transit_critico.toLocaleString()}</p>
              <p className="text-sm text-red-600 font-semibold">Tránsito +48h</p>
              <p className="text-xs text-red-400 mt-0.5">Sin movimiento crítico</p>
            </div>
          </div>
        ) : (
          <KpiCard label="Tránsito +48h" value={stats.transit_critico} icon={TrendingUp} color="bg-green-50 text-green-600" sub="Sin demoras críticas" />
        )}
        <KpiCard label="Intentos fallidos" value={stats.failed_attempts} icon={AlertTriangle} color="bg-amber-50 text-amber-600" />
        <KpiCard label="Devoluciones"      value={stats.returned}        icon={RotateCcw}     color="bg-red-50 text-red-600" />
        <KpiCard label="En riesgo"         value={work_queue.length}     icon={ShieldAlert}   color="bg-orange-50 text-orange-600" />
        <KpiCard label="SLA vencidos"      value={stats.sla_breached}    icon={TrendingDown}  color="bg-red-50 text-red-700" />

        {/* Confirmados hoy */}
        <Link
          href="/confirmados?filter=hoy"
          className="bg-white rounded-xl border border-green-200 p-5 flex items-center gap-4
                     hover:border-green-400 hover:shadow-sm transition-all group"
        >
          <div className="p-3 rounded-xl bg-green-50 text-green-600 group-hover:bg-green-100 transition-colors">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{confirmed_hoy.toLocaleString()}</p>
            <p className="text-sm text-gray-500">Confirmados hoy</p>
            <p className="text-xs text-green-600 mt-0.5 font-medium">Ver → /confirmados</p>
          </div>
        </Link>

        {/* Confirmados ayer */}
        <Link
          href="/confirmados?filter=ayer"
          className="bg-white rounded-xl border border-emerald-200 p-5 flex items-center gap-4
                     hover:border-emerald-400 hover:shadow-sm transition-all group"
        >
          <div className="p-3 rounded-xl bg-emerald-50 text-emerald-600 group-hover:bg-emerald-100 transition-colors">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{confirmed_ayer.toLocaleString()}</p>
            <p className="text-sm text-gray-500">Confirmados ayer</p>
            <p className="text-xs text-emerald-600 mt-0.5 font-medium">Ver → /confirmados</p>
          </div>
        </Link>

        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <p className="text-xs font-medium text-gray-500 mb-3">Por clasificación</p>
          <div className="space-y-1.5">
            {Object.entries(classification).map(([cls, count]) => (
              <div key={cls} className="flex items-center justify-between">
                <ClassificationBadge classification={cls as Classification} />
                <span className="text-sm font-semibold text-gray-700">{count}</span>
              </div>
            ))}
            {Object.keys(classification).length === 0 && (
              <p className="text-xs text-gray-400">Sin clasificaciones aún</p>
            )}
          </div>
        </div>
      </div>

      {/* Cola de trabajo */}
      {work_queue.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ListTodo className="w-4 h-4 text-gray-600" />
              <h2 className="font-semibold text-gray-900 text-sm">Cola de trabajo</h2>
              <span className="bg-gray-100 text-gray-700 text-xs font-bold px-2 py-0.5 rounded-full">
                {work_queue.length}
              </span>
              <span className="text-xs text-gray-400 ml-1">pedidos que requieren acción</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-gray-400">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />Alta</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />Media</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />Baja</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500">Prioridad</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500">Guía</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500">Cliente</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500">Ciudad</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500">Razón</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {work_queue.map(order => {
                  const cfg = PRIORITY_CONFIG[order.priority]
                  return (
                    <tr key={order.id} className="hover:bg-gray-50/60 transition-colors group">
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full ${cfg.badge}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} shrink-0`} />
                          {cfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs font-semibold text-gray-900">{order.tracking_number}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-gray-700 truncate max-w-[150px]">{order.customer_name ?? '—'}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-gray-500 text-xs">{order.city ?? '—'}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium ${cfg.text}`}>{order.reason}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/orders/${order.id}`}
                          className="opacity-0 group-hover:opacity-100 transition-opacity
                                     text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          Ver →
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Alertas SLA */}
        <div className="bg-white rounded-xl border border-gray-100">
          <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900 text-sm">Alertas de SLA</h2>
            <Link href="/orders?sla_breached=true" className="text-xs text-blue-600 hover:underline">
              Ver todos
            </Link>
          </div>
          <div className="divide-y divide-gray-50">
            {sla_alerts.length === 0 && (
              <p className="px-5 py-8 text-sm text-gray-400 text-center">Sin alertas activas</p>
            )}
            {sla_alerts.map(alert => (
              <Link
                key={alert.id}
                href={`/orders/${alert.id}`}
                className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {alert.tracking_number}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {alert.customer_name ?? '—'} · {alert.assigned_name ?? 'Sin asignar'}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {alert.classification && (
                    <ClassificationBadge classification={alert.classification} />
                  )}
                  <SlaBadge
                    status={getSlaStatus(alert.sla_deadline, alert.sla_status === 'breached')}
                    deadline={alert.sla_deadline}
                  />
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* Actividad reciente */}
        <div className="bg-white rounded-xl border border-gray-100">
          <div className="px-5 py-4 border-b border-gray-50">
            <h2 className="font-semibold text-gray-900 text-sm">Actividad reciente</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {recent_activity.length === 0 && (
              <p className="px-5 py-8 text-sm text-gray-400 text-center">Sin actividad aún</p>
            )}
            {recent_activity.map(act => (
              <div key={act.id} className="flex items-start gap-3 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800">
                    <span className="font-medium">{act.profile?.full_name ?? 'Sistema'}</span>
                    {' — '}
                    {ACTION_LABELS[act.action_type as keyof typeof ACTION_LABELS] ?? act.action_type}
                  </p>
                  {act.orders && (
                    <Link href={`/orders/${act.orders.tracking_number}`} className="text-xs text-blue-600 hover:underline">
                      {act.orders.tracking_number} · {act.orders.customer_name ?? ''}
                    </Link>
                  )}
                </div>
                <span className="text-xs text-gray-400 shrink-0">{timeAgo(act.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Novedad no trabajada */}
      {stale_novedad.length > 0 && (
        <div className="bg-white rounded-xl border-2 border-red-200 overflow-hidden">
          <div className="px-5 py-4 bg-red-50 border-b border-red-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600" />
              <h2 className="font-semibold text-red-900 text-sm">
                Novedad no trabajada
              </h2>
              <span className="bg-red-200 text-red-800 text-xs font-bold px-2 py-0.5 rounded-full">
                {stale_novedad.length}
              </span>
            </div>
            <Link href="/orders?status=novedad" className="text-xs text-red-700 hover:underline font-medium">
              Ver todas las novedades
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-red-50/50 border-b border-red-100">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-red-800">Guía</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-red-800">Cliente</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-red-800">Ciudad</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-red-800">Sin movimiento</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-red-50">
                {stale_novedad.map(order => {
                  const days = daysSince(order.last_tracking_update, order.created_at)
                  return (
                    <tr key={order.id} className="hover:bg-red-50/40 transition-colors group">
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs font-semibold text-gray-900">
                          {order.tracking_number}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-gray-700 truncate max-w-[160px]">
                          {order.customer_name ?? '—'}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-gray-500 text-xs">{order.city ?? '—'}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                          <Timer className="w-3 h-3" />
                          {days} día{days !== 1 ? 's' : ''}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/orders/${order.id}`}
                          className="opacity-0 group-hover:opacity-100 transition-opacity
                                     text-xs text-red-600 hover:text-red-800 font-medium"
                        >
                          Ver →
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tránsito sin movimiento +48h */}
      {stale_transit.length > 0 && (
        <div className="bg-white rounded-xl border-2 border-indigo-200 overflow-hidden">
          <div className="px-5 py-4 bg-indigo-50 border-b border-indigo-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-indigo-600" />
              <h2 className="font-semibold text-indigo-900 text-sm">
                Tránsito sin movimiento +48h
              </h2>
              <span className="bg-indigo-200 text-indigo-800 text-xs font-bold px-2 py-0.5 rounded-full">
                {stats.transit_critico}
              </span>
            </div>
            <Link href="/transito" className="text-xs text-indigo-700 hover:underline font-medium">
              Ver tránsito
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-indigo-50/50 border-b border-indigo-100">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-indigo-800">Guía</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-indigo-800">Cliente</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-indigo-800">Ciudad</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-indigo-800">Sin movimiento</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-indigo-50">
                {stale_transit.map(order => {
                  const days = daysSince(order.last_tracking_update, order.created_at)
                  return (
                    <tr key={order.id} className="hover:bg-indigo-50/40 transition-colors group">
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs font-semibold text-gray-900">
                          {order.tracking_number}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-gray-700 truncate max-w-[160px]">
                          {order.customer_name ?? '—'}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-gray-500 text-xs">{order.city ?? '—'}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                          <Timer className="w-3 h-3" />
                          {days} día{days !== 1 ? 's' : ''}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/orders/${order.id}`}
                          className="opacity-0 group-hover:opacity-100 transition-opacity
                                     text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                        >
                          Ver →
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* En reparto sin movimiento */}
      {stale_reparto.length > 0 && (
        <div className="bg-white rounded-xl border-2 border-orange-200 overflow-hidden">
          <div className="px-5 py-4 bg-orange-50 border-b border-orange-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Timer className="w-4 h-4 text-orange-600" />
              <h2 className="font-semibold text-orange-900 text-sm">
                En reparto sin movimiento
              </h2>
              <span className="bg-orange-200 text-orange-800 text-xs font-bold px-2 py-0.5 rounded-full">
                {stale_reparto.length}
              </span>
            </div>
            <Link href="/orders?status=en_reparto" className="text-xs text-orange-700 hover:underline font-medium">
              Ver todos en reparto
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-orange-50/50 border-b border-orange-100">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-orange-800">Guía</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-orange-800">Cliente</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-orange-800">Ciudad</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-orange-800">Sin movimiento</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-50">
                {stale_reparto.map(order => {
                  const days = daysSince(order.last_tracking_update, order.created_at)
                  return (
                    <tr key={order.id} className="hover:bg-orange-50/40 transition-colors group">
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs font-semibold text-gray-900">
                          {order.tracking_number}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-gray-700 truncate max-w-[160px]">
                          {order.customer_name ?? '—'}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-gray-500 text-xs">{order.city ?? '—'}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full
                          ${days >= 5 ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
                          <Timer className="w-3 h-3" />
                          {days} día{days !== 1 ? 's' : ''}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/orders/${order.id}`}
                          className="opacity-0 group-hover:opacity-100 transition-opacity
                                     text-xs text-orange-600 hover:text-orange-800 font-medium"
                        >
                          Ver →
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
