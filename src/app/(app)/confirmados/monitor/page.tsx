'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { AlertBadges } from '@/components/shared/alert-badges'
import { isSantoDomingoOrder } from '@/lib/alert-helpers'
import {
  RefreshCw, Clock, CheckCircle2, AlertTriangle,
  Phone, MapPin, Activity, Search, X, ArrowDownCircle,
  PhoneOff, BarChart2, ShieldAlert, Copy, XCircle, Bot,
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

type Tab = 'hoy' | 'backlog' | 'santo_domingo' | 'confirmados_hoy'

type DrillFilter =
  | 'entrantes_hoy' | 'contactados_hoy' | 'confirmados_hoy'
  | 'pendientes_hoy' | 'sin_tocar_hoy' | 'sin_respuesta_hoy'
  | 'ayer' | 'semana' | 'mes' | 'mas_30'
  | null

const DRILL_META: Record<NonNullable<DrillFilter>, { title: string; sub: string; isConfirmed?: boolean }> = {
  entrantes_hoy:     { title: 'Entrantes hoy',         sub: 'Pedidos recibidos hoy' },
  contactados_hoy:   { title: 'Contactados hoy',        sub: 'Con intentos registrados hoy, aún en cola' },
  confirmados_hoy:   { title: 'Confirmados hoy',        sub: 'Pedidos confirmados hoy', isConfirmed: true },
  pendientes_hoy:    { title: 'Pendientes de hoy',      sub: 'Recibidos hoy, sin confirmar' },
  sin_tocar_hoy:     { title: 'Sin tocar hoy',          sub: 'Recibidos hoy · 0 intentos' },
  sin_respuesta_hoy: { title: 'Sin respuesta hoy',      sub: 'Contactados hoy, aún pendientes' },
  ayer:              { title: 'Pendientes de ayer',     sub: 'Creados ayer, aún en cola' },
  semana:            { title: 'Pendientes esta semana', sub: 'Últimos 7 días · excl. ayer y hoy' },
  mes:               { title: 'Pendientes este mes',    sub: 'Últimos 30 días · excl. esta semana' },
  mas_30:            { title: 'Más de 30 días',         sub: 'Más de 30 días en cola sin confirmar' },
}

interface StatsData {
  pendingTotal:              number
  sinTocarTotal:             number
  atrasados24h:              number
  atrasados:                 number
  confirmadosHoy:            number
  contactadosHoy:            number
  entrantesHoy:              number
  pendientesHoy:             number
  sinTocarHoy:               number
  // Sección A — nuevas
  sinRespuestaHoy:           number
  // Sección B — antigüedad
  pendientesAyer:            number
  pendientesSemana:          number
  pendientesMes:             number
  pendientesMas30d:          number
  // Sección C — causa (en cola)
  reintentar:                number
  tresMasIntentosPendientes: number
  duplicadosPendientes:      number
  // Sección C — causa (bloqueados)
  inalcanzables:             number
  sinCobertura:              number
  numeroIncorrecto:          number
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
  const [activeTab,    setActiveTab]    = useState<Tab>('hoy')
  const [pending,      setPending]      = useState<Order[]>([])
  const [confirmed,    setConfirmed]    = useState<Order[]>([])
  const [stats,        setStats]        = useState<StatsData | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [lastRefresh,  setLastRefresh]  = useState<Date>(new Date())
  const [search,       setSearch]       = useState('')
  const [drillFilter,  setDrillFilter]  = useState<DrillFilter>(null)

  const todayStartMs    = rdMidnightUTC(0)
  const tomorrowMs      = rdMidnightUTC(1)
  const yesterdayMs     = rdMidnightUTC(-1)
  const sevenDaysAgoMs  = rdMidnightUTC(-7)
  const thirtyDaysAgoMs = rdMidnightUTC(-30)

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
        pendingTotal:              statsRes.pendingTotal              ?? pendingOrders.length,
        sinTocarTotal:             statsRes.sinTocarTotal             ?? 0,
        atrasados24h:              statsRes.atrasados24h              ?? 0,
        atrasados:                 statsRes.atrasados                 ?? 0,
        confirmadosHoy:            statsRes.confirmadosHoy            ?? 0,
        contactadosHoy:            statsRes.contactadosHoy            ?? 0,
        entrantesHoy:              statsRes.entrantesHoy              ?? 0,
        pendientesHoy:             statsRes.pendientesHoy             ?? 0,
        sinTocarHoy:               statsRes.sinTocarHoy               ?? 0,
        sinRespuestaHoy:           statsRes.sinRespuestaHoy           ?? 0,
        pendientesAyer:            statsRes.pendientesAyer            ?? 0,
        pendientesSemana:          statsRes.pendientesSemana          ?? 0,
        pendientesMes:             statsRes.pendientesMes             ?? 0,
        pendientesMas30d:          statsRes.pendientesMas30d          ?? 0,
        reintentar:                statsRes.reintentar                ?? 0,
        tresMasIntentosPendientes: statsRes.tresMasIntentosPendientes ?? 0,
        duplicadosPendientes:      statsRes.duplicadosPendientes      ?? 0,
        inalcanzables:             statsRes.inalcanzables             ?? 0,
        sinCobertura:              statsRes.sinCobertura              ?? 0,
        numeroIncorrecto:          statsRes.numeroIncorrecto          ?? 0,
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

  // Pedidos creados hoy: filtra del backlog total y ordena por 0 intentos primero
  const pedidosHoy = useMemo(() =>
    pending
      .filter(o => {
        const ts = o.shopify_created_at ?? o.created_at
        return new Date(ts).getTime() >= todayStartMs
      })
      .sort((a, b) => {
        const aAttempts = a.confirmation_attempts ?? 0
        const bAttempts = b.confirmation_attempts ?? 0
        if (aAttempts !== bAttempts) return aAttempts - bAttempts
        const aTs = new Date(a.shopify_created_at ?? a.created_at).getTime()
        const bTs = new Date(b.shopify_created_at ?? b.created_at).getTime()
        return aTs - bTs
      })
  , [pending, todayStartMs])

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

  // Lista filtrada para el panel de detalle (drill-down)
  const drillResult = useMemo((): { orders: Order[]; isConfirmed: boolean } => {
    if (!drillFilter) return { orders: [], isConfirmed: false }
    const ts = (o: Order) => new Date(o.shopify_created_at ?? o.created_at).getTime()
    switch (drillFilter) {
      case 'entrantes_hoy': {
        const p = pending.filter(o => ts(o) >= todayStartMs)
        const c = confirmed.filter(o => ts(o) >= todayStartMs)
        return {
          orders: [...p, ...c].sort((a, b) => ts(b) - ts(a)),
          isConfirmed: false,
        }
      }
      case 'contactados_hoy':
        return {
          orders: pending.filter(o =>
            o.last_confirmation_attempt &&
            new Date(o.last_confirmation_attempt).getTime() >= todayStartMs
          ),
          isConfirmed: false,
        }
      case 'confirmados_hoy':
        return { orders: confirmadosHoy, isConfirmed: true }
      case 'pendientes_hoy':
        return { orders: pedidosHoy, isConfirmed: false }
      case 'sin_tocar_hoy':
        return { orders: pedidosHoy.filter(o => !(o.confirmation_attempts ?? 0)), isConfirmed: false }
      case 'sin_respuesta_hoy':
        return { orders: pedidosHoy.filter(o => (o.confirmation_attempts ?? 0) >= 1), isConfirmed: false }
      case 'ayer':
        return { orders: pending.filter(o => ts(o) >= yesterdayMs && ts(o) < todayStartMs), isConfirmed: false }
      case 'semana':
        return { orders: pending.filter(o => ts(o) >= sevenDaysAgoMs && ts(o) < yesterdayMs), isConfirmed: false }
      case 'mes':
        return { orders: pending.filter(o => ts(o) >= thirtyDaysAgoMs && ts(o) < sevenDaysAgoMs), isConfirmed: false }
      case 'mas_30':
        return { orders: pending.filter(o => ts(o) < thirtyDaysAgoMs), isConfirmed: false }
      default:
        return { orders: [], isConfirmed: false }
    }
  }, [drillFilter, pending, confirmed, pedidosHoy, confirmadosHoy,
      todayStartMs, yesterdayMs, sevenDaysAgoMs, thirtyDaysAgoMs])

  const avancePct = stats && stats.entrantesHoy > 0
    ? Math.min(100, Math.round((stats.confirmadosHoy / stats.entrantesHoy) * 100))
    : 0

  // ── Tab counts ────────────────────────────────────────────────────────────
  const tabCounts: Record<Tab, number> = {
    hoy:             pedidosHoy.length,
    backlog:         pending.length,
    santo_domingo:   santoDomingo.length,
    confirmados_hoy: confirmadosHoy.length,
  }

  // ── Order row ─────────────────────────────────────────────────────────────
  function OrderRow({ order, showSince = true }: { order: Order; showSince?: boolean }) {
    const ms   = sinceMs(order)
    const isSD = isSantoDomingoOrder(order.city, order.province, order.customer_address)

    return (
      <tr className="border-b border-gray-100 hover:bg-gray-50/50">
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

        <td className="py-3 px-4 text-center hidden sm:table-cell">
          <AttemptsBadge attempts={order.confirmation_attempts} />
        </td>

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
    { key: 'hoy',             label: 'Hoy',              shortLabel: 'Hoy'       },
    { key: 'backlog',         label: 'Pendientes',       shortLabel: 'Pend.'     },
    { key: 'santo_domingo',   label: 'Santo Domingo',    shortLabel: 'SD'        },
    { key: 'confirmados_hoy', label: 'Confirmados hoy',  shortLabel: 'Conf. hoy' },
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

      {/* ─── A: Operación del día ─────────────────────────────────────── */}
      <div className="space-y-3">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">
          Operación del día
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <KpiCard
            label="Entrantes hoy"
            value={stats?.entrantesHoy ?? 0}
            sub="Pedidos recibidos hoy"
            color="bg-indigo-50 border-indigo-200"
            icon={ArrowDownCircle}
            onClick={() => setDrillFilter('entrantes_hoy')}
            active={drillFilter === 'entrantes_hoy'}
          />
          <KpiCard
            label="Contactados hoy"
            value={stats?.contactadosHoy ?? 0}
            sub="Intentos registrados hoy"
            color="bg-blue-50 border-blue-200"
            icon={Phone}
            onClick={() => setDrillFilter('contactados_hoy')}
            active={drillFilter === 'contactados_hoy'}
          />
          <KpiCard
            label="Confirmados hoy"
            value={stats?.confirmadosHoy ?? 0}
            sub="Listos para despacho"
            color="bg-green-50 border-green-200"
            icon={CheckCircle2}
            onClick={() => setDrillFilter('confirmados_hoy')}
            active={drillFilter === 'confirmados_hoy'}
          />
          <KpiCard
            label="Pendientes de hoy"
            value={stats?.pendientesHoy ?? 0}
            sub="Sin confirmar todavía"
            color="bg-amber-50 border-amber-200"
            icon={Clock}
            onClick={() => setDrillFilter('pendientes_hoy')}
            active={drillFilter === 'pendientes_hoy'}
          />
          <KpiCard
            label="Sin tocar hoy"
            value={stats?.sinTocarHoy ?? 0}
            sub="0 intentos registrados"
            color={(stats?.sinTocarHoy ?? 0) > 0 && (stats?.pendientesHoy ?? 0) > 0 && (stats?.sinTocarHoy ?? 0) / (stats?.pendientesHoy ?? 1) >= 0.5
              ? 'bg-rose-50 border-rose-300'
              : 'bg-rose-50 border-rose-200'}
            icon={AlertTriangle}
            onClick={() => setDrillFilter('sin_tocar_hoy')}
            active={drillFilter === 'sin_tocar_hoy'}
          />
          <KpiCard
            label="Sin respuesta hoy"
            value={stats?.sinRespuestaHoy ?? 0}
            sub="Contactados, aún pendientes"
            color="bg-orange-50 border-orange-200"
            icon={PhoneOff}
            onClick={() => setDrillFilter('sin_respuesta_hoy')}
            active={drillFilter === 'sin_respuesta_hoy'}
          />
        </div>

        {/* Avance del día */}
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1.5">
            <span>Avance del día</span>
            <span className="font-semibold text-gray-700">{avancePct}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-2 rounded-full transition-all duration-500"
              style={{
                width: `${avancePct}%`,
                background: avancePct >= 70 ? '#22c55e' : avancePct >= 40 ? '#f59e0b' : '#ef4444',
              }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {stats?.confirmadosHoy ?? 0} confirmados
            {(stats?.entrantesHoy ?? 0) > 0
              ? ` de ${stats?.entrantesHoy} pedidos recibidos hoy`
              : ' · sin pedidos nuevos hoy todavía'}
          </p>
        </div>
      </div>

      {/* ─── B: Pendientes por antigüedad ────────────────────────────── */}
      {(() => {
        const total = stats?.pendingTotal ?? pending.length
        const buckets: { label: string; value: number; bar: string; text: string; drill: DrillFilter }[] = [
          { label: 'Hoy',            value: stats?.pendientesHoy    ?? 0, bar: 'bg-emerald-400', text: 'text-emerald-700', drill: 'pendientes_hoy' },
          { label: 'Ayer',           value: stats?.pendientesAyer   ?? 0, bar: 'bg-yellow-400',  text: 'text-yellow-700', drill: 'ayer'           },
          { label: 'Esta semana',    value: stats?.pendientesSemana ?? 0, bar: 'bg-orange-400',  text: 'text-orange-700', drill: 'semana'         },
          { label: 'Este mes',       value: stats?.pendientesMes    ?? 0, bar: 'bg-red-400',     text: 'text-red-700',    drill: 'mes'            },
          { label: 'Más de 30 días', value: stats?.pendientesMas30d ?? 0, bar: 'bg-gray-300',    text: 'text-gray-500',   drill: 'mas_30'         },
        ]
        return (
          <div className="space-y-3">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">
              Pendientes por antigüedad
            </p>
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                  <BarChart2 className="w-4 h-4 text-gray-400" />
                  Distribución del backlog
                </p>
                <button
                  onClick={() => setActiveTab('backlog')}
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                >
                  Ver todos →
                </button>
              </div>
              <div className="space-y-1.5">
                {buckets.map(({ label, value, bar, text, drill }) => {
                  const isActive = drillFilter === drill
                  return (
                    <button
                      key={label}
                      onClick={() => setDrillFilter(isActive ? null : drill)}
                      className={[
                        'w-full flex items-center gap-3 px-2 py-1.5 rounded-lg transition-all text-left',
                        isActive
                          ? 'bg-gray-100 ring-1 ring-gray-300'
                          : 'hover:bg-gray-50 active:bg-gray-100',
                        value === 0 ? 'opacity-50 cursor-default' : 'cursor-pointer',
                      ].join(' ')}
                      disabled={value === 0}
                    >
                      <span className="text-xs text-gray-500 w-28 shrink-0">{label}</span>
                      <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-2 rounded-full transition-all duration-500 ${bar}`}
                          style={{ width: total > 0 ? `${Math.max(value > 0 ? 3 : 0, Math.round((value / total) * 100))}%` : '0%' }}
                        />
                      </div>
                      <span className={`text-xs font-semibold w-8 text-right ${value > 0 ? text : 'text-gray-300'}`}>
                        {value}
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="pt-1 border-t border-gray-100 flex items-center justify-between text-xs text-gray-400">
                <span>Total pendientes: <strong className="text-gray-600">{total}</strong></span>
                {(stats?.atrasados ?? 0) > 0 && (
                  <span className="flex items-center gap-1 text-red-500">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse inline-block" />
                    {stats?.atrasados ?? 0} críticos +48h
                  </span>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* ─── C: Pendientes por causa ──────────────────────────────────── */}
      <div className="space-y-3">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">
          Pendientes por causa
        </p>

        {/* Grupo 1: En cola */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            En cola — trabajo del agente
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              label="Sin tocar"
              value={stats?.sinTocarTotal ?? 0}
              sub="0 intentos, todas las fechas"
              color="bg-gray-50 border-gray-200"
              icon={Clock}
              onClick={() => setActiveTab('backlog')}
            />
            <KpiCard
              label="1-2 intentos"
              value={stats?.reintentar ?? 0}
              sub="En proceso, sin confirmar"
              color="bg-yellow-50 border-yellow-200"
              icon={Phone}
              onClick={() => setActiveTab('backlog')}
            />
            <KpiCard
              label="3+ intentos"
              value={stats?.tresMasIntentosPendientes ?? 0}
              sub="Difícil de confirmar"
              color={(stats?.tresMasIntentosPendientes ?? 0) > 5 ? 'bg-orange-50 border-orange-300' : 'bg-orange-50 border-orange-200'}
              icon={AlertTriangle}
              onClick={() => setActiveTab('backlog')}
            />
            <KpiCard
              label="Duplicados"
              value={stats?.duplicadosPendientes ?? 0}
              sub="Con alerta de duplicado"
              color="bg-amber-50 border-amber-200"
              icon={Copy}
            />
          </div>
        </div>

        {/* Grupo 2: Bloqueados */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Bloqueados — requieren acción externa
          </p>
          <div className="grid grid-cols-3 gap-3">
            <KpiCard
              label="Sin respuesta"
              value={stats?.inalcanzables ?? 0}
              sub="Inalcanzables (3+ intentos)"
              color="bg-slate-50 border-slate-200"
              icon={PhoneOff}
            />
            <KpiCard
              label="Número incorrecto"
              value={stats?.numeroIncorrecto ?? 0}
              sub="Dato de contacto erróneo"
              color={(stats?.numeroIncorrecto ?? 0) > 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}
              icon={XCircle}
            />
            <KpiCard
              label="Sin cobertura"
              value={stats?.sinCobertura ?? 0}
              sub="Zona no cubierta"
              color="bg-purple-50 border-purple-200"
              icon={ShieldAlert}
            />
          </div>
        </div>
      </div>

      {/* ─── D: Evaluación del Supervisor ─────────────────────────────── */}
      {(() => {
        if (!stats || stats.entrantesHoy === 0) return null

        const { entrantesHoy, confirmadosHoy, contactadosHoy,
                pendientesHoy, sinTocarHoy, sinRespuestaHoy } = stats

        const pctSinTocar  = pendientesHoy > 0 ? sinTocarHoy / pendientesHoy : 0
        const tasaConfirm  = entrantesHoy  > 0 ? confirmadosHoy / entrantesHoy : 0

        let nivel: 'excelente' | 'correcto' | 'riesgo' | 'critico'
        if (pctSinTocar > 0.60 || (entrantesHoy > 5 && confirmadosHoy === 0))   nivel = 'critico'
        else if (pctSinTocar > 0.35 || tasaConfirm < 0.40)                       nivel = 'riesgo'
        else if (tasaConfirm >= 0.70 && pctSinTocar <= 0.15)                     nivel = 'excelente'
        else                                                                      nivel = 'correcto'

        const resumenPartes: string[] = []
        resumenPartes.push(`Entraron ${entrantesHoy}`)
        if (confirmadosHoy > 0)   resumenPartes.push(`${confirmadosHoy} confirmados`)
        if (contactadosHoy > 0)   resumenPartes.push(`${contactadosHoy} contactados`)
        if (sinTocarHoy > 0)      resumenPartes.push(`${sinTocarHoy} sin tocar`)
        if (sinRespuestaHoy > 0)  resumenPartes.push(`${sinRespuestaHoy} sin respuesta`)

        const evaluaciones = {
          excelente: 'El agente está gestionando correctamente.',
          correcto:  'La gestión del día va en buen ritmo.',
          riesgo:    pctSinTocar > 0.35
            ? `Riesgo: ${Math.round(pctSinTocar * 100)}% de los pedidos del día sin gestión.`
            : 'Riesgo: tasa de confirmación baja.',
          critico:   pctSinTocar > 0.60
            ? 'Riesgo alto. La mayoría de los pedidos del día sin gestión — revisar con el agente.'
            : 'Riesgo alto. Sin confirmaciones registradas — revisar con el agente.',
        }

        const estilos = {
          excelente: { bg: 'bg-green-50 border-green-200',  dot: 'bg-green-500', label: 'text-green-700'  },
          correcto:  { bg: 'bg-blue-50 border-blue-200',    dot: 'bg-blue-500',  label: 'text-blue-700'   },
          riesgo:    { bg: 'bg-amber-50 border-amber-200',  dot: 'bg-amber-500', label: 'text-amber-700'  },
          critico:   { bg: 'bg-red-50 border-red-200',      dot: 'bg-red-500 animate-pulse', label: 'text-red-700' },
        }

        const e = estilos[nivel]

        return (
          <div className={`rounded-xl border p-4 space-y-2 ${e.bg}`}>
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-gray-400 shrink-0" />
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">
                Evaluación del Supervisor
              </p>
            </div>
            <p className="text-sm text-gray-600">
              {resumenPartes.join(' · ')}.
            </p>
            <p className={`text-sm font-semibold flex items-center gap-2 ${e.label}`}>
              <span className={`w-2 h-2 rounded-full inline-block ${e.dot}`} />
              {evaluaciones[nivel]}
            </p>
          </div>
        )
      })()}

      {/* Tabs */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">

        {/* Tab bar */}
        <div className="border-b border-gray-200 px-4 overflow-x-auto">
          <div className="flex min-w-max">
            {TAB_META.map(({ key, label, shortLabel }) => {
              const count  = tabCounts[key]
              const active = activeTab === key

              return (
                <button
                  key={key}
                  onClick={() => { setDrillFilter(null); setActiveTab(key) }}
                  className={[
                    'px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors flex items-center gap-1.5',
                    active
                      ? 'border-indigo-600 text-indigo-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
                  ].join(' ')}
                >
                  <span className="hidden sm:inline">{label}</span>
                  <span className="sm:hidden">{shortLabel}</span>
                  {key !== 'hoy' && (
                    <span className={[
                      'text-xs rounded-full px-1.5 py-0.5 font-semibold min-w-[1.25rem] text-center',
                      active ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500',
                    ].join(' ')}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Tab / Drill content */}
        <div className="p-4">

          {/* ── Panel de detalle (drill-down) ─────────────────────────── */}
          {drillFilter && (() => {
            const meta = DRILL_META[drillFilter]
            return (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{meta.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{meta.sub}</p>
                  </div>
                  <button
                    onClick={() => setDrillFilter(null)}
                    className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors shrink-0"
                  >
                    <X className="w-3 h-3" />
                    Cerrar
                  </button>
                </div>
                <OrderTable
                  orders={drillResult.orders}
                  showSince={!drillResult.isConfirmed}
                  isConfirmed={drillResult.isConfirmed}
                  emptyText="Sin pedidos para este filtro."
                />
              </div>
            )
          })()}

          {/* ── HOY ─────────────────────────────────────────────────────── */}
          {!drillFilter && activeTab === 'hoy' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm bg-indigo-50/50 rounded-lg px-4 py-2.5 border border-indigo-100">
                <span className="text-gray-600">{stats?.entrantesHoy ?? pedidosHoy.length} entrantes</span>
                <span className="text-gray-300">·</span>
                <span className="text-green-700 font-medium">{stats?.confirmadosHoy ?? 0} confirmados</span>
                <span className="text-gray-300">·</span>
                <span className="text-amber-700">{stats?.pendientesHoy ?? pedidosHoy.length} pendientes</span>
                <span className="text-gray-300">·</span>
                <span className="text-rose-600">{stats?.sinTocarHoy ?? 0} sin tocar</span>
              </div>
              <OrderTable
                orders={pedidosHoy}
                emptyText="No hay pedidos de hoy en cola. ¡Todo al día!"
              />
            </div>
          )}

          {/* ── BACKLOG ──────────────────────────────────────────────────── */}
          {!drillFilter && activeTab === 'backlog' && (
            <div className="space-y-3">
              {((stats?.atrasados ?? 0) > 0 || (stats?.atrasados24h ?? 0) > 0) && (
                <div className="flex gap-3 flex-wrap text-xs text-gray-500">
                  {(stats?.atrasados ?? 0) > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-red-400 inline-block animate-pulse" />
                      +48h críticos: <strong className="text-red-600">{stats?.atrasados ?? 0}</strong>
                    </span>
                  )}
                  {(stats?.atrasados24h ?? 0) > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />
                      +24h riesgo: <strong className="text-orange-600">{stats?.atrasados24h ?? 0}</strong>
                    </span>
                  )}
                </div>
              )}
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
                emptyText={search ? 'Sin resultados para esa búsqueda.' : 'No hay pedidos en el backlog. ¡Excelente!'}
              />
            </div>
          )}

          {/* ── SANTO DOMINGO ─────────────────────────────────────────────── */}
          {!drillFilter && activeTab === 'santo_domingo' && (
            <OrderTable
              orders={santoDomingo}
              emptyText="Sin pedidos de zona Santo Domingo pendientes."
            />
          )}

          {/* ── CONFIRMADOS HOY ───────────────────────────────────────────── */}
          {!drillFilter && activeTab === 'confirmados_hoy' && (
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
