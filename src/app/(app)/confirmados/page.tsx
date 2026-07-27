'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { formatCurrency, formatEventDate, whatsAppUrl, callUrl } from '@/lib/utils'
import {
  CheckCircle2, RefreshCw, Package, Search,
  Calendar, Truck, MapPin, AlertTriangle,
  ChevronLeft, ChevronRight, ClipboardList, ShoppingCart,
  Navigation, MessageCircle, Phone, ExternalLink, PackageCheck,
} from 'lucide-react'
import { AlertBadges } from '@/components/shared/alert-badges'
import { checkCoverage, isSantoDomingoOrder } from '@/lib/alert-helpers'
import { MarkPaidButton } from '@/components/orders/mark-paid-button'
import { SelectionProvider, SelectionSync } from '@/components/selection/SelectionProvider'
import { SelectionCheckbox } from '@/components/selection/SelectionCheckbox'
import { SelectionHeaderCheckbox } from '@/components/selection/SelectionHeaderCheckbox'
import { SelectionBulkActionBar } from '@/components/selection/BulkActionBar'
import { PrintCodLabelsBatchButton } from '@/components/order-label/PrintCodLabelsBatchButton'

type FilterType  = 'todos' | 'hoy' | 'ayer' | 'rango' | 'recuperados'
type AlertFilter = 'todos' | 'duplicados' | 'cobertura' | 'zona_desconocida' | 'santo_domingo'
type MainTab     = 'confirmados' | 'sd_por_cobrar' | 'entregados'

interface SdPorCobrarOrder {
  id:                string
  order_number:      string | null
  customer_name:     string | null
  customer_phone:    string | null
  customer_address:  string | null
  city:              string | null
  province:          string | null
  product_summary:   string | null
  cod_amount:        number | null
  normalized_status: string
  status_since:      string | null
  created_at:        string
}

interface EntregadoOrder {
  id:                 string
  order_number:       string | null
  customer_name:      string | null
  customer_phone:     string | null
  customer_address:   string | null
  city:               string | null
  province:           string | null
  product_summary:    string | null
  cod_amount:         number | null
  paid_at:            string | null
  paid_by:            string | null
  paid_by_name:       string | null
  delivered_at:       string | null
  delivered_by_name:  string | null
  created_at:         string
}

interface ConfirmadoOrder {
  id:                        string
  order_number:              string | null
  shopify_order_id:          string | null
  customer_name:             string | null
  customer_phone:            string | null
  customer_address:          string | null
  city:                      string | null
  province:                  string | null
  product_summary:           string | null
  cod_amount:                number | null
  confirmation_method:       string | null
  last_confirmation_attempt: string | null
  created_at:                string
  duplicate_alert:           boolean | null
  duplicate_of_order_id:     string | null
  duplicate_reason:          string | null
  recovered_cart_id:         string | null
  recovered_cart_source:     string | null
}

interface ApiResponse {
  data:  ConfirmadoOrder[]
  stats: { confirmados_hoy: number; confirmados_ayer: number; recuperados: number }
}

const METHOD_BADGE: Record<string, { label: string; cls: string }> = {
  call:     { label: 'Llamada',  cls: 'bg-blue-100 text-blue-700'   },
  whatsapp: { label: 'WhatsApp', cls: 'bg-green-100 text-green-700' },
  other:    { label: 'Otro',     cls: 'bg-gray-100 text-gray-600'   },
}

function RecoveredBadge({ source, cartId }: { source: string; cartId: string }) {
  const badge = source === 'shopify_draft_order'
    ? { label: 'Recuperado Draft',        cls: 'bg-violet-100 text-violet-700 border border-violet-200' }
    : source === 'cod_form_lead'
      ? { label: 'Recuperado COD Form',   cls: 'bg-blue-100 text-blue-700 border border-blue-200' }
      : { label: 'Recuperado de carrito', cls: 'bg-teal-100 text-teal-700 border border-teal-200' }

  return (
    <div className="flex items-center gap-1 mt-0.5 flex-wrap">
      <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${badge.cls}`}>
        <ShoppingCart className="w-2.5 h-2.5 shrink-0" />
        {badge.label}
      </span>
      <Link
        href={`/carritos-abandonados/${cartId}`}
        className="text-[10px] text-teal-600 hover:underline font-medium"
      >
        Ver carrito →
      </Link>
    </div>
  )
}

export default function ConfirmadosPage() {
  const searchParams   = useSearchParams()
  const initialFilter  = (searchParams.get('filter') as FilterType) ?? 'todos'
  const tabParam       = searchParams.get('tab')
  const initialMainTab: MainTab =
    tabParam === 'sd_por_cobrar' || tabParam === 'entregados' ? tabParam : 'confirmados'

  const [mainTab, setMainTab] = useState<MainTab>(initialMainTab)

  const [orders, setOrders]           = useState<ConfirmadoOrder[]>([])
  const [stats, setStats]             = useState({ confirmados_hoy: 0, confirmados_ayer: 0, recuperados: 0 })
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [activeFilter, setActiveFilter] = useState<FilterType>(initialFilter)
  const [pipelineCounts, setPipelineCounts] = useState<{
    pendingTotal: number; despachados: number; sdPorCobrar: number; entregadosSd: number
  } | null>(null)
  const [fromDate, setFromDate]       = useState('')
  const [toDate, setToDate]           = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [trackingInputs, setTrackingInputs] = useState<Record<string, string>>({})
  const [assigning, setAssigning]           = useState<Record<string, boolean>>({})
  const [assignErrors, setAssignErrors]     = useState<Record<string, string>>({})
  const [dispatching, setDispatching]       = useState<Record<string, boolean>>({})
  const [dispatchErrors, setDispatchErrors] = useState<Record<string, string>>({})
  const [toast, setToast]                   = useState<{ msg: string; ok: boolean } | null>(null)

  // ── SD · Por cobrar / Entregados ──────────────────────────────────────────
  const [sdPorCobrarData, setSdPorCobrarData]       = useState<SdPorCobrarOrder[]>([])
  const [sdPorCobrarLoading, setSdPorCobrarLoading] = useState(true)
  const [entregadosData, setEntregadosData]         = useState<EntregadoOrder[]>([])
  const [entregadosLoading, setEntregadosLoading]   = useState(true)

  const fetchSdPorCobrar = useCallback(async () => {
    setSdPorCobrarLoading(true)
    try {
      const res = await fetch('/api/confirmados?tab=sd_por_cobrar')
        .then(r => r.json() as Promise<{ data: SdPorCobrarOrder[] }>)
      setSdPorCobrarData(res.data ?? [])
    } catch (err) {
      console.error('[confirmados/fetchSdPorCobrar]', err)
    } finally {
      setSdPorCobrarLoading(false)
    }
  }, [])

  const fetchEntregados = useCallback(async () => {
    setEntregadosLoading(true)
    try {
      const res = await fetch('/api/confirmados?tab=entregados')
        .then(r => r.json() as Promise<{ data: EntregadoOrder[] }>)
      setEntregadosData(res.data ?? [])
    } catch (err) {
      console.error('[confirmados/fetchEntregados]', err)
    } finally {
      setEntregadosLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSdPorCobrar()
    fetchEntregados()
    const interval = setInterval(() => { fetchSdPorCobrar(); fetchEntregados() }, 3 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchSdPorCobrar, fetchEntregados])

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 4000)
  }
  const [alertFilter, setAlertFilter] = useState<AlertFilter>('todos')
  const [currentPage, setCurrentPage] = useState(1)

  const PAGE_SIZE = 50

  function buildUrl(filter: FilterType, from: string, to: string): string {
    if (filter === 'hoy')         return '/api/confirmados?filter=hoy'
    if (filter === 'ayer')        return '/api/confirmados?filter=ayer'
    if (filter === 'recuperados') return '/api/confirmados?filter=recuperados'
    if (filter === 'rango' && from && to) {
      // RD is UTC-4. End of `to` day in RD = start of (to+1) at 04:00 UTC minus 1 second.
      const toNext = new Date(`${to}T00:00:00Z`)
      toNext.setUTCDate(toNext.getUTCDate() + 1)
      return `/api/confirmados?from=${from}T04:00:00Z&to=${toNext.toISOString().slice(0, 10)}T03:59:59Z`
    }
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
      setStats(res.stats  ?? { confirmados_hoy: 0, confirmados_ayer: 0, recuperados: 0 })
      setPipelineCounts({
        pendingTotal: pipelineRes.pendingTotal  ?? 0,
        despachados:  pipelineRes.despachados   ?? 0,
        sdPorCobrar:  pipelineRes.sdPorCobrar    ?? 0,
        entregadosSd: pipelineRes.entregadosSd   ?? 0,
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
    setAlertFilter('todos')
    fetchData(filter, fromDate, toDate)
  }

  function applyRango() {
    setActiveFilter('rango')
    setAlertFilter('todos')
    fetchData('rango', fromDate, toDate)
  }

  const alertCounts = useMemo(() => ({
    duplicados:   orders.filter(o => o.duplicate_alert).length,
    cobertura:    orders.filter(o => checkCoverage(o.customer_address, o.city, o.province).isOutOfCoverage).length,
    unknown:      orders.filter(o => checkCoverage(o.customer_address, o.city, o.province).isUnknownZone).length,
    santoDomingo: orders.filter(o => isSantoDomingoOrder(o.city, null, o.customer_address)).length,
    recuperados:  orders.filter(o => o.recovered_cart_id !== null).length,
  }), [orders])

  const displayed = useMemo(() => {
    let base = orders

    if (alertFilter === 'duplicados')       base = base.filter(o => o.duplicate_alert)
    if (alertFilter === 'cobertura')        base = base.filter(o => checkCoverage(o.customer_address, o.city, o.province).isOutOfCoverage)
    if (alertFilter === 'zona_desconocida') base = base.filter(o => checkCoverage(o.customer_address, o.city, o.province).isUnknownZone)
    if (alertFilter === 'santo_domingo')    base = base.filter(o => isSantoDomingoOrder(o.city, null, o.customer_address))

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

  async function assignTracking(orderId: string) {
    const tracking = (trackingInputs[orderId] ?? '').trim()
    if (!tracking) {
      setAssignErrors(prev => ({ ...prev, [orderId]: 'Ingresa el número de guía' }))
      return
    }
    setAssigning(prev => ({ ...prev, [orderId]: true }))
    setAssignErrors(prev => ({ ...prev, [orderId]: '' }))
    try {
      const res = await fetch(`/api/orders/${orderId}/assign-tracking`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracking_number: tracking }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAssignErrors(prev => ({ ...prev, [orderId]: data.error ?? 'Error al asignar' }))
      } else {
        setOrders(prev => prev.filter(o => o.id !== orderId))
      }
    } catch {
      setAssignErrors(prev => ({ ...prev, [orderId]: 'Error de red' }))
    } finally {
      setAssigning(prev => ({ ...prev, [orderId]: false }))
    }
  }

  async function dispatchLocal(orderId: string) {
    setDispatching(prev => ({ ...prev, [orderId]: true }))
    setDispatchErrors(prev => ({ ...prev, [orderId]: '' }))
    try {
      const res = await fetch(`/api/orders/${orderId}/dispatch-local`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        const msg = data.error ?? 'Error al despachar localmente'
        console.error(`[dispatch-local] HTTP ${res.status}:`, msg)
        setDispatchErrors(prev => ({ ...prev, [orderId]: msg }))
        showToast(msg, false)
      } else {
        setOrders(prev => prev.filter(o => o.id !== orderId))
        showToast('✓ Pedido despachado — aparecerá en SD Rutas', true)
      }
    } catch (err) {
      const msg = 'Error de red al despachar'
      console.error('[dispatch-local] network error:', err)
      setDispatchErrors(prev => ({ ...prev, [orderId]: msg }))
      showToast(msg, false)
    } finally {
      setDispatching(prev => ({ ...prev, [orderId]: false }))
    }
  }

  // Count de recuperados en el filtro actual (para mostrar en el banner cuando aplica)
  const recuperadosInView = activeFilter === 'recuperados'
    ? orders.length
    : alertCounts.recuperados

  return (
    <div className="space-y-4">

      {/* ── Toast flotante ── */}
      {toast && (
        <div className={`fixed left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg
          text-sm font-semibold text-white transition-all bottom-6
          ${toast.ok ? 'bg-green-600' : 'bg-red-600'}`}>
          {toast.msg}
        </div>
      )}

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
                {!loading && recuperadosInView > 0 && (
                  <span className="flex items-center gap-1.5 bg-teal-400/30 text-white
                                   text-xs font-bold px-2.5 py-1 rounded-full border border-teal-300/50">
                    <ShoppingCart className="w-3 h-3" />
                    {recuperadosInView} recuperados
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

          <div className="flex items-center justify-center w-8 bg-gray-50 shrink-0">
            <ChevronRight className="w-4 h-4 text-gray-300" />
          </div>

          {/* Paso 4 — Entregados (SD, pagados) */}
          <button
            onClick={() => setMainTab('entregados')}
            className="flex-1 flex items-center gap-3 px-5 py-3.5 hover:bg-emerald-50 transition-colors group text-left"
          >
            <PackageCheck className="w-5 h-5 text-gray-300 group-hover:text-emerald-500 shrink-0 transition-colors" />
            <div className="min-w-0">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Paso 4</p>
              <p className="text-sm font-bold text-gray-600 group-hover:text-emerald-700 leading-tight transition-colors">Entregados</p>
              <p className="text-2xl font-black tabular-nums text-emerald-600 leading-none">
                {pipelineCounts ? pipelineCounts.entregadosSd : '…'}
              </p>
            </div>
          </button>
        </div>
      </div>

      {/* ── Tabs del módulo ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* El conteo del tab usa el largo real de la lista ya cargada (no un
            COUNT aparte) — así nunca puede divergir de las filas mostradas. */}
        {([
          { key: 'confirmados',   label: 'Confirmados',                                                      cls: 'green'   },
          { key: 'sd_por_cobrar', label: `SD · Por cobrar (${sdPorCobrarLoading ? '…' : sdPorCobrarData.length})`, cls: 'amber'   },
          { key: 'entregados',    label: `Entregados (${entregadosLoading ? '…' : entregadosData.length})`,       cls: 'emerald' },
        ] as { key: MainTab; label: string; cls: string }[]).map(({ key, label, cls }) => (
          <button
            key={key}
            onClick={() => setMainTab(key)}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition-colors
              ${mainTab === key
                ? cls === 'green' ? 'bg-green-600 text-white'
                  : cls === 'amber' ? 'bg-amber-600 text-white'
                    : 'bg-emerald-600 text-white'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {mainTab === 'sd_por_cobrar' && (
        <SdPorCobrarTab
          data={sdPorCobrarData}
          loading={sdPorCobrarLoading}
          onPaidSuccess={(orderId) => {
            showToast('✓ Pedido marcado como pagado', true)
            // Quita la fila de inmediato (sin esperar el refetch) — así
            // desaparece de "SD · Por cobrar" al instante. El refetch de abajo
            // reconcilia el estado real y trae la fila nueva a "Entregados"
            // con mensajero/fecha de pago resueltos desde el servidor.
            setSdPorCobrarData(prev => prev.filter(o => o.id !== orderId))
            fetchEntregados()
            fetchSdPorCobrar()
            fetchData()
          }}
        />
      )}

      {mainTab === 'entregados' && (
        <EntregadosTab data={entregadosData} loading={entregadosLoading} />
      )}

      {mainTab === 'confirmados' && (
      <SelectionProvider>
      <SelectionSync knownIds={displayed.map(o => o.id)} />
      {/* ── Tarjetas de resumen ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
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

        {/* Tarjeta Recuperados de carrito */}
        <button
          onClick={() => applyFilter('recuperados')}
          className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all col-span-2 md:col-span-1
            ${activeFilter === 'recuperados'
              ? 'border-teal-400 bg-teal-100 text-teal-800 ring-2 ring-teal-300/50'
              : 'border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100'}`}
        >
          <div className="flex-1 min-w-0">
            <p className="text-3xl font-black tabular-nums leading-none">{stats.recuperados}</p>
            <p className="text-sm font-bold mt-1">Recuperados de carrito</p>
            <p className="text-[11px] opacity-70 mt-0.5">Draft · COD Form · Checkout</p>
          </div>
          <ShoppingCart className="w-7 h-7 opacity-25 shrink-0" />
        </button>
      </div>

      {/* ── Filtros ── */}
      <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0">Filtrar</span>
          <div className="flex items-center gap-2 flex-wrap">
            {([
              { key: 'todos',       label: 'Todos'                },
              { key: 'hoy',         label: 'Hoy'                  },
              { key: 'ayer',        label: 'Ayer'                 },
              { key: 'recuperados', label: '🛒 Recuperados'       },
            ] as { key: FilterType; label: string }[]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => applyFilter(key)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors
                  ${activeFilter === key
                    ? key === 'recuperados' ? 'bg-teal-600 text-white' : 'bg-green-600 text-white'
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

      {/* ── Info banner para filtro recuperados ── */}
      {activeFilter === 'recuperados' && (
        <div className="bg-teal-50 border border-teal-200 rounded-xl px-4 py-3 flex items-start gap-3">
          <ShoppingCart className="w-4 h-4 text-teal-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-teal-800">Pedidos recuperados desde carritos abandonados</p>
            <p className="text-xs text-teal-700 mt-0.5">
              Estos pedidos fueron confirmados por clientes que habían iniciado pero no completado su compra.
              Tratar como cualquier pedido confirmado — asignar guía EFI y despachar normalmente.
            </p>
          </div>
        </div>
      )}

      {/* ── Filtros de alerta ── */}
      {activeFilter !== 'recuperados' && (alertCounts.duplicados > 0 || alertCounts.cobertura > 0 || alertCounts.unknown > 0 || alertCounts.santoDomingo > 0) && (
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
              {alertCounts.santoDomingo > 0 && (
                <button
                  onClick={() => setAlertFilter(prev => prev === 'santo_domingo' ? 'todos' : 'santo_domingo')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors
                    ${alertFilter === 'santo_domingo'
                      ? 'bg-purple-600 text-white'
                      : 'bg-white text-purple-700 border border-purple-200 hover:bg-purple-50'}`}
                >
                  🏙️ Santo Domingo
                  <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full
                    ${alertFilter === 'santo_domingo' ? 'bg-white/30 text-white' : 'bg-purple-100 text-purple-700'}`}>
                    {alertCounts.santoDomingo}
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
                : activeFilter === 'recuperados'
                  ? 'No hay pedidos recuperados de carrito confirmados sin guía'
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
          <>
            <div className="px-4 py-2 border-b border-green-100 bg-green-50/30 flex items-center gap-3 text-xs text-gray-500">
              {totalPages > 1 ? (
                <span>
                  Mostrando{' '}
                  <span className="font-semibold text-gray-700">
                    {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, displayed.length)}
                  </span>
                  {' '}de{' '}
                  <span className="font-semibold text-gray-700">{displayed.length}</span>
                  {' '}pedidos
                </span>
              ) : (
                <span>
                  <span className="font-semibold text-gray-700">{displayed.length}</span>
                  {' '}pedido{displayed.length !== 1 ? 's' : ''}
                </span>
              )}
              {(alertFilter !== 'todos' || searchQuery.trim() !== '') && orders.length !== displayed.length && (
                <span className="text-gray-400">· {orders.length} total sin filtros</span>
              )}
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-green-50/60 border-b border-green-100">
                <tr>
                  <th className="px-3 py-3 w-8">
                    <SelectionHeaderCheckbox visibleIds={pagedDisplayed.map(o => o.id)} />
                  </th>
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
                  const method       = order.confirmation_method
                    ? (METHOD_BADGE[order.confirmation_method] ?? METHOD_BADGE['other'])
                    : null
                  const hasDup       = !!order.duplicate_alert
                  const cov          = checkCoverage(order.customer_address, order.city, order.province)
                  const hasAlert     = hasDup || cov.isOutOfCoverage || cov.isUnknownZone
                  const isSD         = isSantoDomingoOrder(order.city, null, order.customer_address)
                  const isRecovered  = !!order.recovered_cart_id

                  return (
                    <tr
                      key={order.id}
                      className={`transition-colors
                        ${isRecovered
                          ? 'bg-teal-50/40 hover:bg-teal-50/70'
                          : isSD
                            ? 'bg-purple-50/40 hover:bg-purple-50/70'
                            : hasAlert
                              ? 'bg-amber-50/40 hover:bg-amber-50/70'
                              : 'hover:bg-green-50/40'
                        }`}
                    >
                      <td className="px-3 py-2.5">
                        <SelectionCheckbox id={order.id} label={`Seleccionar pedido ${order.order_number ?? order.id}`} />
                      </td>

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
                          productSummary={order.product_summary}
                        />
                        {isSD && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold
                                           px-2 py-0.5 rounded-full mt-0.5
                                           bg-purple-100 text-purple-700 border border-purple-200">
                            <Navigation className="w-2.5 h-2.5 shrink-0" />
                            SD / Transporte local
                          </span>
                        )}
                        {isRecovered && order.recovered_cart_id && order.recovered_cart_source && (
                          <RecoveredBadge
                            source={order.recovered_cart_source}
                            cartId={order.recovered_cart_id}
                          />
                        )}
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
                        {isSD ? (
                          /* SD / Transporte local — despacho sin guía EFI */
                          <div className="flex flex-col gap-1">
                            <button
                              onClick={() => dispatchLocal(order.id)}
                              disabled={dispatching[order.id]}
                              className="flex items-center gap-1 bg-purple-600 hover:bg-purple-700
                                         text-white text-[11px] font-semibold px-2.5 py-1.5 rounded-lg
                                         transition-colors shadow-sm whitespace-nowrap
                                         disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {dispatching[order.id]
                                ? <Spinner className="w-3 h-3" />
                                : <Navigation className="w-3 h-3 shrink-0" />}
                              {dispatching[order.id] ? 'Despachando…' : 'Despachar local'}
                            </button>
                            {dispatchErrors[order.id] && (
                              <p className="text-[10px] text-red-600 leading-tight max-w-[140px]">
                                {dispatchErrors[order.id]}
                              </p>
                            )}
                          </div>
                        ) : (
                          /* EFI / Gintracom — requiere guía de tracking */
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1">
                              <input
                                type="text"
                                value={trackingInputs[order.id] ?? ''}
                                onChange={e => setTrackingInputs(prev => ({ ...prev, [order.id]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') assignTracking(order.id) }}
                                placeholder="# Guía EFI"
                                disabled={assigning[order.id]}
                                className="w-24 px-2 py-1 text-xs border border-gray-200 rounded-lg
                                           focus:outline-none focus:ring-1 focus:ring-green-300
                                           disabled:opacity-50"
                              />
                              <button
                                onClick={() => assignTracking(order.id)}
                                disabled={assigning[order.id] || !(trackingInputs[order.id] ?? '').trim()}
                                className="flex items-center gap-1 bg-green-600 hover:bg-green-700
                                           text-white text-[11px] font-semibold px-2.5 py-1.5 rounded-lg
                                           transition-colors shadow-sm whitespace-nowrap
                                           disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {assigning[order.id]
                                  ? <Spinner className="w-3 h-3" />
                                  : <Truck className="w-3 h-3 shrink-0" />}
                                {assigning[order.id] ? 'Asignando…' : 'Asignar'}
                              </button>
                            </div>
                            {assignErrors[order.id] && (
                              <p className="text-[10px] text-red-600 leading-tight max-w-[160px]">
                                {assignErrors[order.id]}
                              </p>
                            )}
                          </div>
                        )}
                      </td>

                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          </>
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

      <SelectionBulkActionBar>
        <PrintCodLabelsBatchButton />
      </SelectionBulkActionBar>
      </SelectionProvider>
      )}

    </div>
  )
}

// ── Tab: SD · Por cobrar ─────────────────────────────────────────────────────

type SdSubFilter = 'todos' | 'pendiente_entrega' | 'entregado_pendiente_pago'

function SdPorCobrarTab({
  data, loading, onPaidSuccess,
}: {
  data: SdPorCobrarOrder[]
  loading: boolean
  onPaidSuccess: (orderId: string) => void
}) {
  const LOGISTIC_LABEL: Record<string, { label: string; cls: string }> = {
    en_reparto: { label: 'En reparto', cls: 'bg-orange-100 text-orange-700' },
    delivered:  { label: 'Entregado',  cls: 'bg-green-100 text-green-700'   },
  }

  // Clasificación pedida: "Confirmados pendientes de entrega" (en_reparto,
  // aún no delivered) vs "Entregados pendientes de pago" (delivered). Ambos
  // ya excluyen pagados porque esta pestaña solo recibe payment_status='pending'
  // desde el servidor — nunca hay que filtrar eso aquí.
  const [subFilter, setSubFilter] = useState<SdSubFilter>('todos')

  const pendienteEntrega       = useMemo(() => data.filter(o => o.normalized_status !== 'delivered'), [data])
  const entregadoPendientePago = useMemo(() => data.filter(o => o.normalized_status === 'delivered'), [data])

  const displayed =
    subFilter === 'pendiente_entrega'         ? pendienteEntrega :
    subFilter === 'entregado_pendiente_pago'  ? entregadoPendientePago :
    data

  return (
    <div className="bg-white rounded-xl border-2 border-amber-200 overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-amber-100 bg-amber-50/50">
        <p className="text-sm font-semibold text-amber-800">Santo Domingo — pendientes de cobro</p>
        <p className="text-xs text-amber-700 mt-0.5">
          Pedidos locales ya despachados o entregados por el mensajero cuyo pago todavía no se ha registrado.
        </p>
      </div>

      <div className="px-4 py-2.5 border-b border-amber-100 flex items-center gap-2 flex-wrap">
        {([
          { key: 'todos',                     label: `Todos (${data.length})` },
          { key: 'pendiente_entrega',         label: `Confirmados · pendientes de entrega (${pendienteEntrega.length})` },
          { key: 'entregado_pendiente_pago',  label: `Entregados · pendientes de pago (${entregadoPendientePago.length})` },
        ] as { key: SdSubFilter; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSubFilter(key)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors
              ${subFilter === key
                ? 'bg-amber-600 text-white'
                : 'bg-white text-amber-700 border border-amber-200 hover:bg-amber-100'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Spinner className="w-6 h-6 text-amber-500" />
        </div>
      )}

      {!loading && displayed.length === 0 && (
        <div className="px-5 py-12 text-center text-gray-500 font-medium">
          {subFilter === 'todos' ? 'No hay pedidos SD pendientes de cobro' : 'Sin pedidos en este filtro'}
        </div>
      )}

      {!loading && displayed.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-amber-50/60 border-b border-amber-100">
              <tr>
                {['# Pedido', 'Cliente', 'Sector', 'Producto', 'Monto', 'Estado', 'Desde', 'Acciones'].map(h => (
                  <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-amber-800 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-amber-50">
              {displayed.map(order => {
                const waUrl  = whatsAppUrl(order.customer_phone)
                const telUrl = callUrl(order.customer_phone)
                const logo   = LOGISTIC_LABEL[order.normalized_status] ?? { label: order.normalized_status, cls: 'bg-gray-100 text-gray-600' }
                return (
                  <tr key={order.id} className="hover:bg-amber-50/40 transition-colors">
                    <td className="px-3 py-2.5">
                      <p className="font-mono text-xs font-semibold text-gray-900 whitespace-nowrap">
                        {order.order_number ?? '—'}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[140px]">
                        {order.customer_name ?? '—'}
                      </p>
                      <p className="font-mono text-xs text-gray-500 mt-0.5">{order.customer_phone ?? '—'}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1 text-gray-600">
                        <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                        <span className="text-xs truncate max-w-[110px]">{order.city ?? '—'}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 max-w-[160px]">
                      <p className="text-xs text-gray-600 truncate" title={order.product_summary ?? ''}>
                        {order.product_summary ?? '—'}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="text-sm font-semibold text-gray-900 whitespace-nowrap tabular-nums">
                        {formatCurrency(order.cod_amount)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full ${logo.cls}`}>
                        {logo.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="text-xs text-gray-600 whitespace-nowrap">
                        {formatEventDate(order.status_since ?? order.created_at)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <MarkPaidButton orderId={order.id} onSuccess={() => onPaidSuccess(order.id)} />
                        {waUrl && (
                          <a href={waUrl} target="_blank" rel="noopener noreferrer"
                             className="flex items-center gap-1 bg-green-500 hover:bg-green-600
                                        text-white text-[11px] font-semibold px-2 py-1.5 rounded-lg whitespace-nowrap">
                            <MessageCircle className="w-3 h-3" />WhatsApp
                          </a>
                        )}
                        {telUrl && (
                          <a href={telUrl}
                             className="flex items-center gap-1 bg-blue-500 hover:bg-blue-600
                                        text-white text-[11px] font-semibold px-2 py-1.5 rounded-lg whitespace-nowrap">
                            <Phone className="w-3 h-3" />Llamar
                          </a>
                        )}
                        <Link href={`/orders/${order.id}`}
                          className="flex items-center gap-1 text-xs font-medium text-indigo-600
                                     hover:text-indigo-800 whitespace-nowrap hover:underline">
                          <ExternalLink className="w-3 h-3" />Ver
                        </Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Tab: Entregados ───────────────────────────────────────────────────────────

function EntregadosTab({ data, loading }: { data: EntregadoOrder[]; loading: boolean }) {
  return (
    <div className="bg-white rounded-xl border-2 border-emerald-200 overflow-hidden shadow-sm">
      <div className="px-4 py-3 border-b border-emerald-100 bg-emerald-50/50">
        <p className="text-sm font-semibold text-emerald-800">Santo Domingo — entregados y pagados</p>
        <p className="text-xs text-emerald-700 mt-0.5">
          Pedidos locales cerrados por completo: entrega confirmada y cobro registrado.
        </p>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Spinner className="w-6 h-6 text-emerald-500" />
        </div>
      )}

      {!loading && data.length === 0 && (
        <div className="px-5 py-12 text-center text-gray-500 font-medium">
          Todavía no hay pedidos SD entregados y pagados
        </div>
      )}

      {!loading && data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-emerald-50/60 border-b border-emerald-100">
              <tr>
                {['# Pedido', 'Estado', 'Cliente', 'Sector', 'Producto', 'Monto', 'Mensajero',
                  'Fecha entrega', 'Fecha pago', 'Confirmó pago', ''].map(h => (
                  <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-emerald-800 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-emerald-50">
              {data.map(order => (
                <tr key={order.id} className="hover:bg-emerald-50/40 transition-colors">
                  <td className="px-3 py-2.5">
                    <p className="font-mono text-xs font-semibold text-gray-900 whitespace-nowrap">
                      {order.order_number ?? '—'}
                    </p>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded-full bg-green-600 text-white whitespace-nowrap">
                      Pagado
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[140px]">
                      {order.customer_name ?? '—'}
                    </p>
                    <p className="font-mono text-xs text-gray-500 mt-0.5">{order.customer_phone ?? '—'}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1 text-gray-600">
                      <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                      <span className="text-xs truncate max-w-[100px]">{order.city ?? '—'}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 max-w-[150px]">
                    <p className="text-xs text-gray-600 truncate" title={order.product_summary ?? ''}>
                      {order.product_summary ?? '—'}
                    </p>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-sm font-semibold text-gray-900 whitespace-nowrap tabular-nums">
                      {formatCurrency(order.cod_amount)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-xs text-gray-700 whitespace-nowrap">
                      {order.delivered_by_name ?? <span className="text-gray-300 italic">—</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-xs text-gray-600 whitespace-nowrap">
                      {order.delivered_at ? formatEventDate(order.delivered_at) : '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-xs text-gray-600 whitespace-nowrap">
                      {order.paid_at ? formatEventDate(order.paid_at) : '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-xs text-gray-700 whitespace-nowrap">
                      {order.paid_by_name ?? <span className="text-gray-300 italic">—</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <Link href={`/orders/${order.id}`}
                      className="flex items-center gap-1 text-xs font-medium text-indigo-600
                                 hover:text-indigo-800 whitespace-nowrap hover:underline">
                      <ExternalLink className="w-3 h-3" />Ver
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
