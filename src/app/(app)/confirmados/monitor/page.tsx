'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { AlertBadges } from '@/components/shared/alert-badges'
import { isSantoDomingoOrder } from '@/lib/alert-helpers'
import {
  RefreshCw, Clock, CheckCircle2, AlertTriangle, Users,
  Phone, MapPin, TrendingUp, Activity, Search, X,
} from 'lucide-react'
import type { Order } from '@/types'

// ─── Helpers ────────────────────────────────────────────────────────────────

function rdMidnightUTC(offsetDays = 0): number {
  const rdStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' })
  const [y, m, d] = rdStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d + offsetDays, 4, 0, 0, 0)
}

function sinceMs(order: Order): number {
  const base = order.shopify_created_at ?? order.created_at
  return Date.now() - new Date(base).getTime()
}

function formatSince(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  if (h < 1)  return 'Hace menos de 1h'
  if (h < 24) return `Hace ${h}h`
  const d = Math.floor(h / 24)
  const rem = h % 24
  return rem > 0 ? `Hace ${d}d ${rem}h` : `Hace ${d}d`
}

function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('es-DO', {
    timeZone: 'America/Santo_Domingo',
    day:    '2-digit',
    month:  'short',
    hour:   '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

const TERMINAL_STATUSES = new Set(['delivered', 'returned', 'cancelled', 'indemnizacion'])

function isActive(order: Order): boolean {
  return (
    order.source === 'shopify_webhook' &&
    !TERMINAL_STATUSES.has(order.normalized_status)
  )
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Tab = 'resumen' | 'pendientes' | 'alertas' | 'santo_domingo' | 'confirmados_hoy'

interface StatsData {
  pendingTotal:  number
  sinTocarTotal: number
  atrasados24h:  number
  atrasados:     number     // +48h
  confirmadosHoy: number
  contactadosHoy: number
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, color, icon: Icon, onClick, active,
}: {
  label: string
  value: number | string
  sub?: string
  color: string
  icon: React.ElementType
  onClick?: () => void
  active?: boolean
}) {
  const base = 'rounded-xl border p-4 flex flex-col gap-1 transition-all'
  const cls  = active
    ? `${base} ${color} ring-2 ring-offset-1 shadow-md cursor-pointer`
    : onClick
      ? `${base} bg-white border-gray-200 hover:shadow-sm cursor-pointer`
      : `${base} bg-white border-gray-200`
  return (
    <div className={cls} onClick={onClick}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500 font-medium">{label}</p>
        <Icon className="w-4 h-4 text-gray-400" />
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400">{sub}</p>}
    </div>
  )
}

function AttemptsBadge({ attempts }: { attempts?: number }) {
  if (!attempts || attempts === 0)
    return <span className="text-xs text-gray-400">0 intentos</span>
  if (attempts === 1)
    return <span className="text-xs px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded-full">{attempts} intento</span>
  return <span className="text-xs px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded-full font-medium">{attempts} intentos</span>
}

function SinceBadge({ ms }: { ms: number }) {
  const h = ms / 3_600_000
  if (h >= 48) return (
    <span className="text-xs px-1.5 py-0.5 bg-red-100 text-red-700 rounded-full font-medium animate-pulse">
      +48h
    </span>
  )
  if (h >= 24) return (
    <span className="text-xs px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded-full font-medium">
      +24h
    </span>
  )
  return null
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function MonitorConfirmacionPage() {
  const [activeTab,    setActiveTab]    = useState<Tab>('resumen')
  const [pending,      setPending]      = useState<Order[]>([])
  const [confirmed,    setConfirmed]    = useState<Order[]>([])
  const [stats,        setStats]        = useState<StatsData | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [lastRefresh,  setLastRefresh]  = useState<Date>(new Date())
  const [search,       setSearch]       = useState('')

  const todayStartMs = rdMidnightUTC(0)
  const tomorrowMs   = rdMidnightUTC(1)

  const fetchData = useCallback(async () => {
    try {
      const [pendingRes, confirmedRes, statsRes] = await Promise.all([
        fetch('/api/orders?confirmationStatus=pending&limit=500').then(r => r.json()),
        fetch('/api/orders?confirmationStatus=confirmed&limit=300').then(r => r.json()),
        fetch('/api/confirmacion/stats').then(r => r.json()),
      ])

      const pendingOrders: Order[] = (pendingRes.data ?? []).filter(isActive)
      const confirmedOrders: Order[] = (confirmedRes.data ?? []).filter((o: Order) =>
        o.source === 'shopify_webhook'
      )

      setPending(pendingOrders)
      setConfirmed(confirmedOrders)
      setStats({
        pendingTotal:   statsRes.pendingTotal   ?? pendingOrders.length,
        sinTocarTotal:  statsRes.sinTocarTotal  ?? 0,
        atrasados24h:   statsRes.atrasados24h   ?? 0,
        atrasados:      statsRes.atrasados      ?? 0,
        confirmadosHoy: statsRes.confirmadosHoy ?? 0,
        contactadosHoy: statsRes.contactadosHoy ?? 0,
      })
      setLastRefresh(new Date())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const t = setInterval(fetchData, 3 * 60 * 1000)
    return () => clearInterval(t)
  }, [fetchData])

  // ── Derived lists ─────────────────────────────────────────────────────────

  const pendingFiltered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return pending
    return pending.filter(o =>
      o.tracking_number?.toLowerCase().includes(q) ||
      o.order_number?.toLowerCase().includes(q) ||
      o.customer_name?.toLowerCase().includes(q) ||
      o.customer_phone?.toLowerCase().includes(q)
    )
  }, [pending, search])

  const alertas = useMemo(() =>
    pending.filter(o => sinceMs(o) >= 24 * 3_600_000)
           .sort((a, b) => sinceMs(b) - sinceMs(a))
  , [pending])

  const santoDomingo = useMemo(() =>
    pending.filter(o => isSantoDomingoOrder(o.city, o.province, o.customer_address))
  , [pending])

  const confirmadosHoy = useMemo(() =>
    confirmed.filter(o => {
      const ts = o.customer_confirmed_at ?? o.last_confirmation_attempt
      if (!ts) return false
      const ms = new Date(ts).getTime()
      return ms >= todayStartMs && ms < tomorrowMs
    }).sort((a, b) => {
      const aTs = a.customer_confirmed_at ?? a.last_confirmation_attempt ?? ''
      const bTs = b.customer_confirmed_at ?? b.last_confirmation_attempt ?? ''
      return bTs.localeCompare(aTs)
    })
  , [confirmed, todayStartMs, tomorrowMs])

  const tasa = stats
    ? stats.confirmadosHoy + (stats.pendingTotal ?? 0) > 0
      ? Math.round((stats.confirmadosHoy / (stats.confirmadosHoy + (stats.pendingTotal ?? 0))) * 100)
      : 0
    : 0

  // ── Tab counts ────────────────────────────────────────────────────────────
  const tabCounts: Record<Tab, number> = {
    resumen:         0,
    pendientes:      pending.length,
    alertas:         alertas.length,
    santo_domingo:   santoDomingo.length,
    confirmados_hoy: confirmadosHoy.length,
  }

  // ── Order row ─────────────────────────────────────────────────────────────
  function OrderRow({ order, showSince = true }: { order: Order; showSince?: boolean }) {
    const ms    = sinceMs(order)
    const isSD  = isSantoDomingoOrder(order.city, order.province, order.customer_address)

    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50/50">
        {/* Fecha / Orden */}
        <td className="py-3 px-4 text-xs text-gray-500 whitespace-nowrap">
          <p className="font-medium text-gray-700">{order.order_number ?? '—'}</p>
          <p>{formatAbsolute(order.shopify_created_at ?? order.created_at)}</p>
          {showSince && (
            <div className="flex items-center gap-1 mt-0.5">
              <SinceBadge ms={ms} />
              <span className="text-gray-400">{formatSince(ms)}</span>
            </div>
          )}
        </td>

        {/* Cliente */}
        <td className="py-3 px-4">
          <p className="text-sm font-medium text-gray-800 truncate max-w-[140px]">
            {order.customer_name ?? '—'}
          </p>
          {order.customer_phone && (
            <p className="text-xs text-gray-500 flex items-center gap-1">
              <Phone className="w-3 h-3" /> {order.customer_phone}
            </p>
          )}
          <AlertBadges
            customerAddress={order.customer_address}
            city={order.city}
            province={order.province}
            duplicateAlert={!!(order as any).duplicate_alert}
            productSummary={order.product_summary}
          />
        </td>

        {/* Ubicación */}
        <td className="py-3 px-4 text-xs text-gray-500 hidden md:table-cell">
          <div className="flex items-center gap-1">
            <MapPin className="w-3 h-3 shrink-0" />
            <span>{[order.city, order.province].filter(Boolean).join(', ') || '—'}</span>
          </div>
          {isSD && (
            <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded-full mt-0.5 inline-block">
              SD local
            </span>
          )}
        </td>

        {/* Intentos */}
        <td className="py-3 px-4 text-center hidden sm:table-cell">
          <AttemptsBadge attempts={order.confirmation_attempts} />
        </td>

        {/* Último contacto */}
        <td className="py-3 px-4 text-xs text-gray-500 hidden lg:table-cell whitespace-nowrap">
          {order.last_confirmation_attempt
            ? formatAbsolute(order.last_confirmation_attempt)
            : <span className="text-gray-300 italic">Sin contacto</span>}
        </td>
      </tr>
    )
  }

  function ConfirmedRow({ order }: { order: Order }) {
    const ts = order.customer_confirmed_at ?? order.last_confirmation_attempt
    return (
      <tr className="border-b border-gray-100 hover:bg-green-50/30">
        <td className="py-3 px-4 text-xs text-gray-500 whitespace-nowrap">
          <p className="font-medium text-gray-700">{order.order_number ?? '—'}</p>
          <p>{formatAbsolute(ts)}</p>
        </td>
        <td className="py-3 px-4">
          <p className="text-sm font-medium text-gray-800 truncate max-w-[140px]">
            {order.customer_name ?? '—'}
          </p>
          {order.customer_phone && (
            <p className="text-xs text-gray-500 flex items-center gap-1">
              <Phone className="w-3 h-3" /> {order.customer_phone}
            </p>
          )}
        </td>
        <td className="py-3 px-4 text-xs text-gray-500 hidden md:table-cell">
          {[order.city, order.province].filter(Boolean).join(', ') || '—'}
        </td>
        <td className="py-3 px-4 hidden sm:table-cell">
          <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full">
            Confirmado ✓
          </span>
        </td>
        <td className="py-3 px-4 text-xs text-gray-500 hidden lg:table-cell">
          {order.confirmation_method ?? '—'}
        </td>
      </tr>
    )
  }

  // ── Table wrapper ─────────────────────────────────────────────────────────
  function OrderTable({
    orders,
    showSince = true,
    emptyText = 'Sin pedidos en esta vista.',
    isConfirmed = false,
  }: {
    orders: Order[]
    showSince?: boolean
    emptyText?: string
    isConfirmed?: boolean
  }) {
    if (orders.length === 0) {
      return (
        <div className="text-center py-16 text-gray-400">
          <CheckCircle2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{emptyText}</p>
        </div>
      )
    }
    const headers = isConfirmed
      ? ['Pedido / Hora', 'Cliente', 'Ubicación', 'Estado', 'Método']
      : ['Pedido / Ingreso', 'Cliente', 'Ubicación', 'Intentos', 'Último contacto']

    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50/70">
              {headers.map(h => (
                <th key={h} className="py-2.5 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders.map(o =>
              isConfirmed
                ? <ConfirmedRow key={o.id} order={o} />
                : <OrderRow    key={o.id} order={o} showSince={showSince} />
            )}
          </tbody>
        </table>
        <p className="text-xs text-gray-400 text-right px-4 py-2">
          {orders.length} pedido{orders.length !== 1 ? 's' : ''}
        </p>
      </div>
    )
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        <RefreshCw className="w-6 h-6 animate-spin mr-3" />
        Cargando monitor...
      </div>
    )
  }

  const TAB_META: { key: Tab; label: string; shortLabel: string }[] = [
    { key: 'resumen',         label: 'Resumen',          shortLabel: 'Resumen' },
    { key: 'pendientes',      label: 'Pendientes',        shortLabel: 'Pend.' },
    { key: 'alertas',         label: `Alertas`,           shortLabel: 'Alertas' },
    { key: 'santo_domingo',   label: 'Santo Domingo',     shortLabel: 'SD' },
    { key: 'confirmados_hoy', label: 'Confirmados hoy',   shortLabel: 'Conf. hoy' },
  ]

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-10">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Activity className="w-5 h-5 text-indigo-600" />
            Monitor de Confirmación
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Vista de solo lectura · sin acciones · auto-refresh cada 3 min
          </p>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700 px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Actualizar
          <span className="text-gray-400">
            {lastRefresh.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Santo_Domingo' })}
          </span>
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard
          label="Pendientes"
          value={stats?.pendingTotal ?? pending.length}
          sub="Total en cola"
          color="bg-indigo-50 border-indigo-200"
          icon={Users}
          onClick={() => setActiveTab('pendientes')}
          active={activeTab === 'pendientes'}
        />
        <KpiCard
          label="Sin tocar"
          value={stats?.sinTocarTotal ?? 0}
          sub="0 intentos, todas las fechas"
          color="bg-amber-50 border-amber-200"
          icon={Clock}
          onClick={() => setActiveTab('pendientes')}
          active={false}
        />
        <KpiCard
          label="+24h sin confirmar"
          value={stats?.atrasados24h ?? 0}
          sub="Entre 24h y 48h"
          color="bg-orange-50 border-orange-200"
          icon={AlertTriangle}
          onClick={() => setActiveTab('alertas')}
          active={activeTab === 'alertas' && (stats?.atrasados24h ?? 0) > 0}
        />
        <KpiCard
          label="+48h críticos"
          value={stats?.atrasados ?? 0}
          sub="Más de 48h en cola"
          color="bg-red-50 border-red-200"
          icon={AlertTriangle}
          onClick={() => setActiveTab('alertas')}
          active={activeTab === 'alertas' && (stats?.atrasados ?? 0) > 0}
        />
        <KpiCard
          label="Confirmados hoy"
          value={stats?.confirmadosHoy ?? 0}
          sub="En zona RD"
          color="bg-green-50 border-green-200"
          icon={CheckCircle2}
          onClick={() => setActiveTab('confirmados_hoy')}
          active={activeTab === 'confirmados_hoy'}
        />
        <KpiCard
          label="Tasa confirmación"
          value={`${tasa}%`}
          sub="Hoy vs pendientes"
          color="bg-blue-50 border-blue-200"
          icon={TrendingUp}
        />
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">

        {/* Tab bar */}
        <div className="border-b border-gray-200 px-4 overflow-x-auto">
          <div className="flex min-w-max">
            {TAB_META.map(({ key, label, shortLabel }) => {
              const count  = tabCounts[key]
              const active = activeTab === key
              const hasAlert = (key === 'alertas' && (alertas.length > 0))

              return (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={[
                    'px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors flex items-center gap-1.5',
                    active
                      ? 'border-indigo-600 text-indigo-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
                    hasAlert && !active ? 'text-red-500' : '',
                  ].join(' ')}
                >
                  <span className="hidden sm:inline">{label}</span>
                  <span className="sm:hidden">{shortLabel}</span>
                  {key !== 'resumen' && (
                    <span className={[
                      'text-xs rounded-full px-1.5 py-0.5 font-semibold min-w-[1.25rem] text-center',
                      active ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500',
                      hasAlert && !active ? 'bg-red-100 text-red-600' : '',
                    ].join(' ')}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Tab content */}
        <div className="p-4">

          {/* ── RESUMEN ─────────────────────────────────────────────────────── */}
          {activeTab === 'resumen' && (
            <div className="space-y-6">
              {/* Estado rápido */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="rounded-lg bg-gray-50 p-4 space-y-1">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Pendientes totales</p>
                  <p className="text-3xl font-bold text-gray-900">{stats?.pendingTotal ?? pending.length}</p>
                  <p className="text-xs text-gray-400">
                    {stats?.sinTocarTotal ?? 0} sin ningún intento
                  </p>
                </div>
                <div className="rounded-lg bg-green-50 p-4 space-y-1">
                  <p className="text-xs font-semibold text-green-600 uppercase tracking-wide">Confirmados hoy</p>
                  <p className="text-3xl font-bold text-green-700">{stats?.confirmadosHoy ?? 0}</p>
                  <p className="text-xs text-green-500">
                    {stats?.contactadosHoy ?? 0} contactados hoy
                  </p>
                </div>
                <div className={`rounded-lg p-4 space-y-1 ${(stats?.atrasados ?? 0) > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                  <p className={`text-xs font-semibold uppercase tracking-wide ${(stats?.atrasados ?? 0) > 0 ? 'text-red-500' : 'text-gray-500'}`}>
                    Críticos +48h
                  </p>
                  <p className={`text-3xl font-bold ${(stats?.atrasados ?? 0) > 0 ? 'text-red-700' : 'text-gray-900'}`}>
                    {stats?.atrasados ?? 0}
                  </p>
                  <p className="text-xs text-gray-400">
                    +24h: {stats?.atrasados24h ?? 0} en riesgo
                  </p>
                </div>
              </div>

              {/* Barra de tasa */}
              <div>
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>Tasa de confirmación hoy</span>
                  <span className="font-semibold text-gray-700">{tasa}%</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-2 rounded-full transition-all duration-500"
                    style={{
                      width: `${tasa}%`,
                      background: tasa >= 70 ? '#22c55e' : tasa >= 40 ? '#f59e0b' : '#ef4444',
                    }}
                  />
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  {stats?.confirmadosHoy ?? 0} confirmados / {(stats?.confirmadosHoy ?? 0) + (stats?.pendingTotal ?? 0)} gestionados
                </p>
              </div>

              {/* Distribución rápida */}
              {(stats?.atrasados ?? 0) > 0 && (
                <div className="rounded-lg border border-red-100 bg-red-50 p-4 flex items-start gap-3">
                  <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                  <div className="text-sm text-red-700">
                    <strong>{stats?.atrasados ?? 0} pedido{(stats?.atrasados ?? 0) !== 1 ? 's' : ''}</strong> llevan más de 48h en cola sin confirmar.
                    {(stats?.atrasados24h ?? 0) > 0 && (
                      <> Además, <strong>{stats?.atrasados24h}</strong> están entre 24h y 48h (riesgo).</>
                    )}
                    {' '}Ve al tab <span className="font-semibold">Alertas</span> para verlos.
                  </div>
                </div>
              )}

              {/* SD */}
              {santoDomingo.length > 0 && (
                <div className="rounded-lg border border-purple-100 bg-purple-50 p-4 flex items-start gap-3">
                  <MapPin className="w-4 h-4 text-purple-500 mt-0.5 shrink-0" />
                  <p className="text-sm text-purple-700">
                    <strong>{santoDomingo.length}</strong> pedido{santoDomingo.length !== 1 ? 's' : ''} de zona Santo Domingo pendientes.
                    {' '}Ve al tab <span className="font-semibold">Santo Domingo</span>.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── PENDIENTES ────────────────────────────────────────────────── */}
          {activeTab === 'pendientes' && (
            <div className="space-y-3">
              {/* Buscador */}
              <div className="relative max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar pedido, cliente, teléfono..."
                  className="w-full pl-9 pr-8 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
                {search && (
                  <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <OrderTable
                orders={pendingFiltered}
                emptyText={search ? 'Sin resultados para esa búsqueda.' : 'No hay pedidos pendientes. ¡Excelente!'}
              />
            </div>
          )}

          {/* ── ALERTAS ───────────────────────────────────────────────────── */}
          {activeTab === 'alertas' && (
            <div className="space-y-4">
              {alertas.length === 0 ? (
                <div className="text-center py-16 text-gray-400">
                  <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-green-400 opacity-50" />
                  <p className="text-sm">Sin pedidos en riesgo. Todo dentro de las 24h.</p>
                </div>
              ) : (
                <>
                  <div className="flex gap-3 flex-wrap text-xs text-gray-500">
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-red-400 inline-block animate-pulse" />
                      +48h críticos: <strong className="text-red-600">{alertas.filter(o => sinceMs(o) >= 48 * 3_600_000).length}</strong>
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />
                      +24h riesgo: <strong className="text-orange-600">{alertas.filter(o => sinceMs(o) < 48 * 3_600_000).length}</strong>
                    </span>
                  </div>
                  <OrderTable orders={alertas} emptyText="Sin alertas." />
                </>
              )}
            </div>
          )}

          {/* ── SANTO DOMINGO ─────────────────────────────────────────────── */}
          {activeTab === 'santo_domingo' && (
            <OrderTable
              orders={santoDomingo}
              emptyText="Sin pedidos de zona Santo Domingo pendientes."
            />
          )}

          {/* ── CONFIRMADOS HOY ───────────────────────────────────────────── */}
          {activeTab === 'confirmados_hoy' && (
            <div className="space-y-3">
              {confirmadosHoy.length > 0 && (
                <p className="text-xs text-gray-500 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                  {confirmadosHoy.length} pedido{confirmadosHoy.length !== 1 ? 's' : ''} confirmado{confirmadosHoy.length !== 1 ? 's' : ''} hoy en zona RD
                </p>
              )}
              <OrderTable
                orders={confirmadosHoy}
                showSince={false}
                emptyText="Sin confirmaciones registradas hoy todavía."
                isConfirmed
              />
            </div>
          )}

        </div>
      </div>

      {/* Footer note */}
      <p className="text-xs text-gray-400 text-center pb-2">
        Monitor de solo lectura · datos en tiempo real de la base de datos · sin acciones disponibles
      </p>
    </div>
  )
}
