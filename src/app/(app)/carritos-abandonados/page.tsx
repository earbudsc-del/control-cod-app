'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import {
  ShoppingCart, RefreshCw, Phone, MessageCircle,
  CheckCircle2, XCircle, Clock, Search, X, StickyNote,
  ChevronLeft, ChevronRight, AlertTriangle, MapPinOff,
  Building2, HelpCircle, Navigation, RotateCcw,
} from 'lucide-react'
import { checkCoverage, isSantoDomingoOrder } from '@/lib/alert-helpers'
import type { AbandonedCart, CartRecoveryStatus } from '@/types'

// ── Constantes ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

type DateFilter   = 'all' | 'today' | 'yesterday' | '7days'
type StatusFilter = 'all' | CartRecoveryStatus

const STATUS_LABELS: Record<CartRecoveryStatus, string> = {
  pending:   'Pendiente',
  contacted: 'Contactado',
  no_answer: 'No responde',
  recovered: 'Recuperado',
  discarded: 'Descartado',
}

const STATUS_STYLES: Record<CartRecoveryStatus, string> = {
  pending:   'bg-gray-100 text-gray-700',
  contacted: 'bg-indigo-100 text-indigo-700',
  no_answer: 'bg-yellow-100 text-yellow-700',
  recovered: 'bg-green-100 text-green-700',
  discarded: 'bg-gray-200 text-gray-500',
}

interface CartStats {
  pending:        number
  today:          number
  contactedToday: number
  recovered:      number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return digits
  if (digits.length === 10) return `1${digits}`
  return digits.length >= 7 ? digits : null
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms   = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  const hrs  = Math.floor(ms / 3600000)
  const days = Math.floor(ms / 86400000)
  if (mins < 60)  return `Hace ${mins}m`
  if (hrs  < 24)  return `Hace ${hrs}h`
  if (days === 1) return 'Ayer'
  return `Hace ${days} días`
}

function rdRangeUTC(offsetDays: number): string {
  const now = new Date()
  const rd  = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santo_Domingo' }))
  rd.setHours(0, 0, 0, 0)
  rd.setDate(rd.getDate() - offsetDays)
  return new Date(Date.UTC(rd.getFullYear(), rd.getMonth(), rd.getDate(), 4, 0, 0, 0)).toISOString()
}

function buildWAMessage(cart: AbandonedCart): string {
  const nombre   = cart.customer_name?.split(' ')[0] ?? 'cliente'
  const producto = cart.products_summary ?? 'tu pedido'
  const coverage = checkCoverage(cart.customer_address, cart.city)
  const isSD     = isSantoDomingoOrder(cart.city, cart.province, cart.customer_address)

  let msg = `Hola ${nombre} 😊 vimos que dejaste tu pedido de ${producto} casi listo. ¿Quieres que te ayudemos a completarlo para enviártelo hoy? Tenemos pago contra entrega.`

  if (isSD) {
    msg += ` Como estás en Santo Domingo, podemos coordinar entrega con nuestro transporte local.`
  } else if (coverage.isOutOfCoverage) {
    msg = `Hola ${nombre} 😊 vimos que dejaste tu pedido de ${producto} casi listo. Antes de procesarlo, vamos a validar si tenemos cobertura para tu zona.`
  }

  return msg
}

// ── Badge de fuente ───────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return null
  const isShopify = source === 'shopify_abandoned_checkout' || source === 'shopify'
  const isCod     = source === 'cod_form_lead'
  const isManual  = source === 'manual_import'

  if (isShopify) return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
      Shopify
    </span>
  )
  if (isCod) return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-100 text-blue-700 border border-blue-200">
      COD Form
    </span>
  )
  if (isManual) return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-gray-100 text-gray-500 border border-gray-200">
      Manual
    </span>
  )
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-gray-100 text-gray-500 border border-gray-200">
      {source}
    </span>
  )
}

// ── Componente de badges de cobertura ────────────────────────────────────────

function CartCoverageBadges({ cart }: { cart: AbandonedCart }) {
  const coverage = checkCoverage(cart.customer_address, cart.city)
  const isSD     = isSantoDomingoOrder(cart.city, cart.province, cart.customer_address)

  const showOoc     = coverage.isOutOfCoverage
  const showSpec    = !coverage.isOutOfCoverage && coverage.isSpecialDestination
  const showUnknown = !coverage.isOutOfCoverage && !coverage.isSpecialDestination && coverage.isUnknownZone && !!cart.city

  return (
    <div className="flex flex-wrap gap-1 mt-0.5">
      {showOoc && (
        <span className="inline-flex items-center gap-0.5 bg-red-50 text-red-700 border border-red-200 text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap"
              title={`Zona: ${coverage.matchedZones.join(', ')}`}>
          <MapPinOff className="w-2.5 h-2.5 shrink-0" />
          Fuera de cobertura
        </span>
      )}
      {showSpec && (
        <span className="inline-flex items-center gap-0.5 bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap">
          <Navigation className="w-2.5 h-2.5 shrink-0" />
          Destino especial
        </span>
      )}
      {showUnknown && (
        <span className="inline-flex items-center gap-0.5 bg-yellow-50 text-yellow-700 border border-yellow-200 text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap">
          <HelpCircle className="w-2.5 h-2.5 shrink-0" />
          Zona desconocida
        </span>
      )}
      {isSD && (
        <span className="inline-flex items-center gap-0.5 bg-purple-50 text-purple-700 border border-purple-200 text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap">
          <Building2 className="w-2.5 h-2.5 shrink-0" />
          SD / Transporte local
        </span>
      )}
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function CarritosAbandonadosPage() {
  const [carts,       setCarts]       = useState<AbandonedCart[]>([])
  const [stats,       setStats]       = useState<CartStats | null>(null)
  const [total,       setTotal]       = useState(0)
  const [loading,     setLoading]     = useState(true)
  const [syncing,     setSyncing]     = useState(false)
  const [lastSynced,  setLastSynced]  = useState<string | null>(null)

  const [search,      setSearch]      = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [dateFilter,  setDateFilter]  = useState<DateFilter>('all')
  const [page,        setPage]        = useState(1)

  // Nota modal
  const [noteModal,   setNoteModal]   = useState<{ id: string; name: string } | null>(null)
  const [noteText,    setNoteText]    = useState('')
  const [savingNote,  setSavingNote]  = useState(false)

  // Toast
  const [toast,      setToast]      = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const toastRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    if (toastRef.current) clearTimeout(toastRef.current)
    setToast({ msg, type })
    toastRef.current = setTimeout(() => setToast(null), 3500)
  }

  // ── Carga de datos ──────────────────────────────────────────────────────────

  const fetchData = useCallback(async (p = page) => {
    try {
      setLoading(true)
      const params = new URLSearchParams({ page: String(p), ...(statusFilter !== 'all' && { status: statusFilter }) })
      if (search.trim()) params.set('q', search.trim())
      if (dateFilter === 'today')     { params.set('from', rdRangeUTC(0)); params.set('to', new Date().toISOString()) }
      if (dateFilter === 'yesterday') { params.set('from', rdRangeUTC(1)); params.set('to', rdRangeUTC(0)) }
      if (dateFilter === '7days')     { params.set('from', rdRangeUTC(7)); params.set('to', new Date().toISOString()) }

      const res = await fetch(`/api/abandoned-carts?${params}`)
      if (res.status === 403) {
        showToast('Sin permisos para ver carritos abandonados', 'error')
        return
      }
      const json = await res.json()
      setCarts(json.data  ?? [])
      setTotal(json.total ?? 0)
      setStats(json.stats ?? null)
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, search, dateFilter])

  useEffect(() => { fetchData(1); setPage(1) }, [statusFilter, dateFilter])
  useEffect(() => { fetchData(page) }, [page])

  // Búsqueda con debounce
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function handleSearch(v: string) {
    setSearch(v)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => { fetchData(1); setPage(1) }, 400)
  }

  // ── Sync desde Shopify ──────────────────────────────────────────────────────

  async function handleSync() {
    setSyncing(true)
    try {
      const res  = await fetch('/api/abandoned-carts/sync', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      showToast(`Sync completado — ${json.new} nuevos · ${json.updated} actualizados`)
      setLastSynced(new Date().toLocaleTimeString('es-DO', { timeZone: 'America/Santo_Domingo' }))
      fetchData(1); setPage(1)
    } catch (e) {
      showToast(String(e), 'error')
    } finally {
      setSyncing(false)
    }
  }

  // ── Cambio de estado ────────────────────────────────────────────────────────

  async function handleStatusChange(id: string, status: CartRecoveryStatus, note?: string) {
    try {
      const res  = await fetch(`/api/abandoned-carts/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...(note && { note }) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setCarts(prev => prev.map(c => c.id === id ? json.cart : c))
      showToast(`Marcado como "${STATUS_LABELS[status]}"`)
    } catch (e) {
      showToast(String(e), 'error')
    }
  }

  // ── Guardar nota ────────────────────────────────────────────────────────────

  async function handleSaveNote() {
    if (!noteModal || !noteText.trim()) return
    setSavingNote(true)
    try {
      const res  = await fetch(`/api/abandoned-carts/${noteModal.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noteText.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setCarts(prev => prev.map(c => c.id === noteModal.id ? { ...c, notes: json.notes } : c))
      showToast('Nota guardada')
      setNoteModal(null)
      setNoteText('')
    } catch (e) {
      showToast(String(e), 'error')
    } finally {
      setSavingNote(false)
    }
  }

  // ── WA link ─────────────────────────────────────────────────────────────────

  function waLink(cart: AbandonedCart): string | null {
    const phone = formatPhone(cart.customer_phone)
    if (!phone) return null
    const msg = buildWAMessage(cart)
    return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`
  }

  // ── Stats de cobertura para métricas ─────────────────────────────────────────

  const outOfCoverageCount = carts.filter(c => checkCoverage(c.customer_address, c.city).isOutOfCoverage).length
  const sdCount            = carts.filter(c => isSantoDomingoOrder(c.city, c.province, c.customer_address)).length

  const totalPages = Math.ceil(total / PAGE_SIZE)

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-white max-w-sm
                        ${toast.type === 'error' ? 'bg-red-600' : 'bg-gray-900'}`}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-indigo-600" />
            Carritos abandonados
          </h1>
          {lastSynced && (
            <p className="text-xs text-gray-400 mt-0.5">Última sync Shopify: {lastSynced}</p>
          )}
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium
                     rounded-lg hover:bg-indigo-700 disabled:opacity-60 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Sincronizando…' : 'Sync Shopify Checkouts'}
        </button>
      </div>

      {/* Info COD form */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 space-y-1">
        <p className="font-semibold">Fuentes de leads soportadas</p>
        <ul className="text-xs text-blue-700 space-y-0.5 list-disc list-inside">
          <li><span className="font-medium">COD Form</span> — llegan automáticamente cuando el formulario envía el lead parcial al endpoint <code className="bg-blue-100 px-1 rounded">/api/abandoned-carts/cod-form</code></li>
          <li><span className="font-medium">Shopify Checkouts</span> — "Sync Shopify Checkouts" descarga <code className="bg-blue-100 px-1 rounded">checkouts.json?status=open</code>. Devuelve 0 si usas solo COD form.</li>
        </ul>
      </div>

      {/* Métricas */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Pendientes',      value: stats.pending,        color: 'text-gray-700',   bg: 'bg-gray-50'    },
            { label: 'Hoy',             value: stats.today,          color: 'text-blue-700',   bg: 'bg-blue-50'    },
            { label: 'Contactados hoy', value: stats.contactedToday, color: 'text-indigo-700', bg: 'bg-indigo-50'  },
            { label: 'Recuperados',     value: stats.recovered,      color: 'text-green-700',  bg: 'bg-green-50'   },
            { label: 'Fuera cobertura', value: outOfCoverageCount,   color: 'text-red-700',    bg: 'bg-red-50'     },
            { label: 'Santo Domingo',   value: sdCount,              color: 'text-purple-700', bg: 'bg-purple-50'  },
          ].map(({ label, value, color, bg }) => (
            <div key={label} className={`${bg} rounded-xl border border-gray-200 px-4 py-3 text-center`}>
              <p className={`text-2xl font-black tabular-nums ${color}`}>{value}</p>
              <p className="text-[10px] font-semibold text-gray-500 mt-0.5 leading-tight">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Búsqueda */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Nombre, teléfono, email, producto, ciudad…"
            value={search}
            onChange={e => handleSearch(e.target.value)}
            className="w-full pl-9 pr-8 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {search && (
            <button onClick={() => handleSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Estado */}
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as StatusFilter)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">Todos los estados</option>
          {(Object.entries(STATUS_LABELS) as [CartRecoveryStatus, string][]).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>

        {/* Fecha */}
        <div className="flex gap-1 flex-wrap">
          {([['all', 'Todos'], ['today', 'Hoy'], ['yesterday', 'Ayer'], ['7days', '7 días']] as [DateFilter, string][]).map(([v, l]) => (
            <button
              key={v}
              onClick={() => setDateFilter(v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors
                ${dateFilter === v ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Conteo */}
      <p className="text-sm text-gray-500">
        {loading ? 'Cargando…' : `${total.toLocaleString()} carrito${total !== 1 ? 's' : ''}`}
      </p>

      {/* ── TABLA DESKTOP ── */}
      {!loading && carts.length > 0 && (
        <div className="hidden md:block overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Productos</th>
                <th className="px-4 py-3">Monto</th>
                <th className="px-4 py-3">Ubicación</th>
                <th className="px-4 py-3">Abandono</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {carts.map(cart => {
                const wa = waLink(cart)
                return (
                  <tr key={cart.id} className="hover:bg-gray-50/50 transition-colors">
                    {/* Cliente */}
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{cart.customer_name ?? '—'}</p>
                      {cart.customer_phone && (
                        <p className="text-xs text-gray-500 mt-0.5">{cart.customer_phone}</p>
                      )}
                      {cart.customer_email && (
                        <p className="text-[11px] text-gray-400 truncate max-w-[160px]">{cart.customer_email}</p>
                      )}
                    </td>

                    {/* Productos */}
                    <td className="px-4 py-3 max-w-[180px]">
                      <p className="text-gray-700 text-xs line-clamp-2">{cart.products_summary ?? '—'}</p>
                    </td>

                    {/* Monto */}
                    <td className="px-4 py-3">
                      <p className="font-semibold text-gray-900 tabular-nums">
                        {cart.total_amount != null
                          ? `RD$ ${cart.total_amount.toLocaleString('es-DO', { minimumFractionDigits: 2 })}`
                          : '—'}
                      </p>
                    </td>

                    {/* Ubicación + badges */}
                    <td className="px-4 py-3">
                      <p className="text-gray-700 text-xs">
                        {[cart.city, cart.province].filter(Boolean).join(', ') || '—'}
                      </p>
                      <CartCoverageBadges cart={cart} />
                    </td>

                    {/* Abandono */}
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                      {timeAgo(cart.abandoned_at)}
                    </td>

                    {/* Estado */}
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold ${STATUS_STYLES[cart.recovery_status]}`}>
                        {STATUS_LABELS[cart.recovery_status]}
                      </span>
                      <div className="mt-1">
                        <SourceBadge source={cart.source} />
                      </div>
                      {cart.recovery_attempts > 0 && (
                        <p className="text-[10px] text-gray-400 mt-0.5">{cart.recovery_attempts} intento{cart.recovery_attempts !== 1 ? 's' : ''}</p>
                      )}
                    </td>

                    {/* Acciones */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {wa && (
                          <a href={wa} target="_blank" rel="noreferrer"
                             className="p-1.5 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 transition-colors"
                             title="WhatsApp">
                            <MessageCircle className="w-3.5 h-3.5" />
                          </a>
                        )}
                        {cart.customer_phone && (
                          <a href={`tel:${cart.customer_phone}`}
                             className="p-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                             title="Llamar">
                            <Phone className="w-3.5 h-3.5" />
                          </a>
                        )}
                        {cart.recovery_status === 'pending' && (
                          <button onClick={() => handleStatusChange(cart.id, 'contacted')}
                                  className="p-1.5 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
                                  title="Marcar contactado">
                            <Clock className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {cart.recovery_status === 'contacted' && (
                          <button onClick={() => handleStatusChange(cart.id, 'no_answer')}
                                  className="p-1.5 rounded-lg bg-yellow-50 text-yellow-700 hover:bg-yellow-100 transition-colors"
                                  title="No responde">
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {cart.recovery_status !== 'recovered' && cart.recovery_status !== 'discarded' && (
                          <button onClick={() => handleStatusChange(cart.id, 'recovered')}
                                  className="p-1.5 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 transition-colors"
                                  title="Marcar recuperado">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {cart.recovery_status !== 'discarded' && (
                          <button onClick={() => handleStatusChange(cart.id, 'discarded')}
                                  className="p-1.5 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
                                  title="Descartar">
                            <XCircle className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {cart.recovery_status === 'discarded' && (
                          <button onClick={() => handleStatusChange(cart.id, 'pending')}
                                  className="p-1.5 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                                  title="Reabrir">
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => { setNoteModal({ id: cart.id, name: cart.customer_name ?? 'cliente' }); setNoteText('') }}
                          className="p-1.5 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors"
                          title="Agregar nota"
                        >
                          <StickyNote className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {cart.notes && (
                        <p className="text-[10px] text-gray-400 mt-1 line-clamp-1 max-w-[200px]" title={cart.notes}>
                          📝 {cart.notes.split('\n')[0]}
                        </p>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── CARDS MOBILE ── */}
      {!loading && carts.length > 0 && (
        <div className="md:hidden space-y-3">
          {carts.map(cart => {
            const wa = waLink(cart)
            return (
              <div key={cart.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{cart.customer_name ?? '—'}</p>
                    {cart.customer_phone && (
                      <p className="text-sm text-gray-500">{cart.customer_phone}</p>
                    )}
                    {cart.customer_email && (
                      <p className="text-xs text-gray-400 truncate">{cart.customer_email}</p>
                    )}
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold ${STATUS_STYLES[cart.recovery_status]}`}>
                      {STATUS_LABELS[cart.recovery_status]}
                    </span>
                    <SourceBadge source={cart.source} />
                  </div>
                </div>

                {/* Producto + monto */}
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-gray-600 flex-1 line-clamp-2">{cart.products_summary ?? '—'}</p>
                  {cart.total_amount != null && (
                    <p className="text-sm font-bold text-gray-900 tabular-nums shrink-0">
                      RD$ {cart.total_amount.toLocaleString('es-DO', { minimumFractionDigits: 2 })}
                    </p>
                  )}
                </div>

                {/* Ubicación + badges */}
                <div>
                  <p className="text-xs text-gray-500">{[cart.city, cart.province].filter(Boolean).join(', ') || '—'}</p>
                  <CartCoverageBadges cart={cart} />
                </div>

                {/* Abandono */}
                <p className="text-xs text-gray-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" /> {timeAgo(cart.abandoned_at)}
                </p>

                {/* Notas */}
                {cart.notes && (
                  <p className="text-xs text-gray-500 bg-amber-50 border border-amber-100 rounded-lg px-3 py-1.5 line-clamp-2">
                    📝 {cart.notes.split('\n')[0]}
                  </p>
                )}

                {/* Acciones */}
                <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-gray-100">
                  {wa && (
                    <a href={wa} target="_blank" rel="noreferrer"
                       className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 text-xs font-medium rounded-lg hover:bg-green-100">
                      <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
                    </a>
                  )}
                  {cart.customer_phone && (
                    <a href={`tel:${cart.customer_phone}`}
                       className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 text-xs font-medium rounded-lg hover:bg-blue-100">
                      <Phone className="w-3.5 h-3.5" /> Llamar
                    </a>
                  )}
                  {cart.recovery_status === 'pending' && (
                    <button onClick={() => handleStatusChange(cart.id, 'contacted')}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-700 text-xs font-medium rounded-lg hover:bg-indigo-100">
                      <Clock className="w-3.5 h-3.5" /> Contactado
                    </button>
                  )}
                  {cart.recovery_status === 'contacted' && (
                    <button onClick={() => handleStatusChange(cart.id, 'no_answer')}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-50 text-yellow-700 text-xs font-medium rounded-lg hover:bg-yellow-100">
                      <AlertTriangle className="w-3.5 h-3.5" /> No responde
                    </button>
                  )}
                  {cart.recovery_status !== 'recovered' && cart.recovery_status !== 'discarded' && (
                    <button onClick={() => handleStatusChange(cart.id, 'recovered')}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 text-xs font-medium rounded-lg hover:bg-green-100">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Recuperado
                    </button>
                  )}
                  {cart.recovery_status !== 'discarded' && (
                    <button onClick={() => handleStatusChange(cart.id, 'discarded')}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 text-gray-500 text-xs font-medium rounded-lg hover:bg-gray-200">
                      <XCircle className="w-3.5 h-3.5" /> Descartar
                    </button>
                  )}
                  {cart.recovery_status === 'discarded' && (
                    <button onClick={() => handleStatusChange(cart.id, 'pending')}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 text-gray-600 text-xs font-medium rounded-lg hover:bg-gray-200">
                      <RotateCcw className="w-3.5 h-3.5" /> Reabrir
                    </button>
                  )}
                  <button
                    onClick={() => { setNoteModal({ id: cart.id, name: cart.customer_name ?? 'cliente' }); setNoteText('') }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 text-amber-700 text-xs font-medium rounded-lg hover:bg-amber-100"
                  >
                    <StickyNote className="w-3.5 h-3.5" /> Nota
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Estado vacío */}
      {!loading && carts.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <ShoppingCart className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">Sin carritos abandonados</p>
          <p className="text-sm mt-1">
            {search || statusFilter !== 'all' || dateFilter !== 'all'
              ? 'Ningún resultado para los filtros aplicados'
              : 'Si usas COD form, los carritos aparecerán cuando el formulario envíe leads parciales al endpoint COD.'}
          </p>
        </div>
      )}

      {/* Paginación */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" /> Anterior
          </button>
          <span className="text-sm text-gray-500">Página {page} / {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            Siguiente <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Modal de nota */}
      {noteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-gray-900 text-lg">Agregar nota</h2>
              <button onClick={() => setNoteModal(null)} className="text-gray-400 hover:text-gray-600 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-gray-500">Carrito de <span className="font-medium text-gray-700">{noteModal.name}</span></p>
            <textarea
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder="Escribe una nota sobre este carrito…"
              rows={4}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              autoFocus
            />
            <div className="flex gap-3">
              <button
                onClick={() => setNoteModal(null)}
                className="flex-1 px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleSaveNote}
                disabled={!noteText.trim() || savingNote}
                className="flex-1 px-4 py-2 text-sm bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {savingNote ? 'Guardando…' : 'Guardar nota'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
