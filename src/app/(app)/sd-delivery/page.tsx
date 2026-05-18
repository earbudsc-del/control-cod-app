'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Spinner } from '@/components/ui/spinner'
import { whatsAppUrl, callUrl } from '@/lib/utils'
import { isSantoDomingoOrder } from '@/lib/alert-helpers'
import type { Order } from '@/types'
import {
  MapPin, RefreshCw, MessageCircle, Phone,
  CheckCircle2, PhoneMissed, ExternalLink,
  Search, TrendingUp, Calendar, Package2,
  CalendarDays, RotateCcw, FileText, X,
  ChevronLeft, ChevronRight, Clock, ShieldAlert,
} from 'lucide-react'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type Tab       = 'pendientes' | 'no_responden' | 'entregados_hoy' | 'entregados_ayer'
type DateFilter = 'hoy' | 'ayer' | 'todos'

interface SdPerfData {
  entregadosHoy:   number
  entregadosAyer:  number
  contactadosHoy:  number
  noRespondenHoy:  number
  reprogramadosHoy: number
}

interface DeliveredEntry {
  order:           Order
  reported_at:     string
  local_confirmed: boolean
}

interface OrdersResponse { data: Order[] }

// ── Helpers ───────────────────────────────────────────────────────────────────

function rdMidnightUTC(offsetDays = 0): number {
  const rd    = new Date(Date.now() + offsetDays * 86_400_000)
  const rdStr = rd.toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' })
  const [y, m, d] = rdStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d, 4, 0, 0, 0)
}

function isToday(iso: string): boolean {
  const ts = new Date(iso).getTime()
  return ts >= rdMidnightUTC(0) && ts < rdMidnightUTC(1)
}

function isYesterday(iso: string): boolean {
  const ts = new Date(iso).getTime()
  return ts >= rdMidnightUTC(-1) && ts < rdMidnightUTC(0)
}

function statusSinceMs(order: Order): number {
  return new Date(order.status_since ?? order.last_tracking_update ?? order.updated_at).getTime()
}

function horasEnReparto(order: Order): number {
  return (Date.now() - statusSinceMs(order)) / (1000 * 60 * 60)
}

function tiempoLabel(order: Order): string {
  const h = horasEnReparto(order)
  const dias = Math.floor(h / 24)
  const hrs  = Math.floor(h % 24)
  if (h < 1)     return 'Hace menos de 1h'
  if (h < 24)    return `Hace ${Math.floor(h)}h`
  if (dias === 1) return hrs > 0 ? `Hace 1d ${hrs}h` : 'Hace 1 día'
  return hrs > 0 ? `Hace ${dias}d ${hrs}h` : `Hace ${dias} días`
}

function criticalityLabel(order: Order): 'critico' | 'riesgo' | 'normal' {
  const h = horasEnReparto(order)
  if (h >= 48) return 'critico'
  if (h >= 24) return 'riesgo'
  return 'normal'
}

function buildWaMsg(nombre: string, product: string | null | undefined): string {
  const n = nombre.trim() || 'cliente'
  const p = (product ?? '').trim().slice(0, 32) || 'tu pedido'
  return [
    `Hola ${n} 😊,`,
    '',
    `Tu pedido de ${p} 📦 está en camino.`,
    'El mensajero pasará hoy por tu dirección.',
    '',
    'Por favor tener el monto exacto listo 🙏',
  ].join('\n')
}

const ACTION_BADGE: Record<string, { label: string; color: string }> = {
  contacted:   { label: 'Contactado',   color: 'bg-blue-100 text-blue-700'   },
  no_answer:   { label: 'No responde',  color: 'bg-amber-100 text-amber-700' },
  delivered:   { label: 'Entregado',    color: 'bg-green-100 text-green-700' },
  rescheduled: { label: 'Reprogramado', color: 'bg-indigo-100 text-indigo-700' },
  note_added:  { label: 'Nota',         color: 'bg-gray-100 text-gray-600'   },
}

const PAGE_SIZE = 40

// ── Modales ───────────────────────────────────────────────────────────────────

interface NoteModalProps {
  orderId:  string
  name:     string
  onSave:   (orderId: string, note: string) => Promise<void>
  onClose:  () => void
}

function NoteModal({ orderId, name, onSave, onClose }: NoteModalProps) {
  const [text, setText] = useState('')
  const [busy, setBusy]   = useState(false)

  async function handleSave() {
    if (!text.trim()) return
    setBusy(true)
    await onSave(orderId, text.trim())
    setBusy(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white w-full md:max-w-md rounded-t-2xl md:rounded-xl shadow-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-gray-900">Agregar nota</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-gray-600 truncate">{name || 'Pedido'}</p>
        <textarea
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Ej: Cliente fuera, reprogramar para mañana tarde…"
          rows={4}
          className="w-full border border-gray-200 rounded-xl p-3 text-sm resize-none
                     focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400"
        />
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-600"
          >Cancelar</button>
          <button
            onClick={handleSave}
            disabled={!text.trim() || busy}
            className="flex-1 py-3 rounded-xl bg-teal-600 text-white text-sm font-semibold
                       disabled:opacity-40 active:bg-teal-700"
          >
            {busy ? <Spinner className="w-4 h-4 mx-auto text-white" /> : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface ReprogramarModalProps {
  orderId: string
  name:    string
  onSave:  (orderId: string, note: string) => Promise<void>
  onClose: () => void
}

function ReprogramarModal({ orderId, name, onSave, onClose }: ReprogramarModalProps) {
  const [text, setText] = useState('')
  const [busy, setBusy]   = useState(false)

  async function handleSave() {
    const note = text.trim() || 'Reprogramado sin especificar fecha'
    setBusy(true)
    await onSave(orderId, note)
    setBusy(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white w-full md:max-w-md rounded-t-2xl md:rounded-xl shadow-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-gray-900">Reprogramar entrega</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-gray-600 truncate">{name || 'Pedido'}</p>
        <textarea
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Ej: Reprogramar para mañana 10am, cliente no estaba en casa…"
          rows={3}
          className="w-full border border-gray-200 rounded-xl p-3 text-sm resize-none
                     focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-teal-400"
        />
        <div className="flex gap-2">
          <button onClick={onClose}
            className="flex-1 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-600">
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={busy}
            className="flex-1 py-3 rounded-xl bg-indigo-600 text-white text-sm font-semibold
                       disabled:opacity-40 active:bg-indigo-700"
          >
            {busy ? <Spinner className="w-4 h-4 mx-auto text-white" /> : 'Reprogramar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Card móvil ────────────────────────────────────────────────────────────────

interface SdCardProps {
  order:        Order
  accion:       string | undefined
  busy:         boolean
  isDelivered:  boolean
  onWA:         () => void
  onLlamar:     () => void
  onContactado: () => void
  onNoAnswer:   () => void
  onEntregado:  () => void
  onReprogramar: () => void
  onNota:        () => void
}

function SdCard({
  order, accion, busy, isDelivered,
  onWA, onLlamar, onContactado, onNoAnswer, onEntregado, onReprogramar, onNota,
}: SdCardProps) {
  const nombre   = order.customer_name ?? ''
  const waUrl    = whatsAppUrl(order.customer_phone, buildWaMsg(nombre, order.product_summary))
  const telUrl   = callUrl(order.customer_phone)
  const hasPhone = !!order.customer_phone
  const crit     = criticalityLabel(order)

  const ubicacion = order.city
    || order.province
    || (order.customer_address ? order.customer_address.slice(0, 24) : null)

  const cardBg = isDelivered
    ? 'bg-green-50/40'
    : crit === 'critico' ? 'bg-red-50/20'
    : crit === 'riesgo'  ? 'bg-orange-50/20'
    : 'bg-white'

  return (
    <div className={`p-4 border-b border-teal-100 ${cardBg}`}>

      {/* Cabecera: guía + tiempo */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-bold text-gray-900 truncate">
            {order.tracking_number ?? '—'}
          </p>
          {order.order_number && (
            <p className="font-mono text-[10px] text-gray-400 mt-0.5">{order.order_number}</p>
          )}
        </div>
        {!isDelivered && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0
            ${crit === 'critico' ? 'bg-red-100 text-red-700 animate-pulse'
              : crit === 'riesgo'  ? 'bg-orange-100 text-orange-700'
              : 'bg-teal-100 text-teal-700'}`}>
            {tiempoLabel(order)}
          </span>
        )}
        {isDelivered && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700 shrink-0">
            <CheckCircle2 className="inline w-3 h-3 mr-0.5" />Entregado
          </span>
        )}
      </div>

      {/* Cliente */}
      <p className="font-semibold text-gray-900 text-base leading-tight">{nombre || '—'}</p>
      <p className="font-mono text-sm text-gray-500 mt-0.5">{order.customer_phone || '—'}</p>

      {/* Ubicación */}
      {ubicacion && (
        <div className="flex items-center gap-1 mt-1.5 text-xs text-gray-500">
          <MapPin className="w-3 h-3 shrink-0 text-teal-500" />
          <span className="truncate">{ubicacion}</span>
        </div>
      )}
      {order.customer_address && (
        <p className="text-[11px] text-gray-400 mt-0.5 truncate pl-4" title={order.customer_address}>
          {order.customer_address}
        </p>
      )}

      {order.delivery_attempts > 0 && !isDelivered && (
        <p className="text-[11px] text-amber-600 font-medium mt-1">
          {order.delivery_attempts} intento{order.delivery_attempts > 1 ? 's' : ''} previos
        </p>
      )}

      {/* Botones de contacto */}
      {hasPhone && !isDelivered && !busy && !accion && (
        <div className="flex gap-2 mt-3">
          {waUrl && (
            <a href={waUrl} target="_blank" rel="noopener noreferrer" onClick={onWA}
               className="flex-1 flex items-center justify-center gap-1.5
                          bg-green-500 text-white py-3 rounded-xl text-sm font-semibold
                          active:bg-green-700 transition-colors">
              <MessageCircle className="w-4 h-4" />WhatsApp
            </a>
          )}
          {telUrl && (
            <a href={telUrl} onClick={onLlamar}
               className="flex-1 flex items-center justify-center gap-1.5
                          bg-blue-500 text-white py-3 rounded-xl text-sm font-semibold
                          active:bg-blue-700 transition-colors">
              <Phone className="w-4 h-4" />Llamar
            </a>
          )}
        </div>
      )}

      {/* Estado / Acciones */}
      <div className="mt-3">
        {isDelivered ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold
                           px-3 py-1.5 rounded-full bg-green-100 text-green-700">
            <CheckCircle2 className="w-3.5 h-3.5" />Entregado — registrado
          </span>
        ) : busy ? (
          <Spinner className="w-5 h-5 text-teal-500" />
        ) : accion ? (
          <div className="flex items-center justify-between">
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold
                             px-3 py-1.5 rounded-full
                             ${ACTION_BADGE[accion]?.color ?? 'bg-gray-100 text-gray-600'}`}>
              <CheckCircle2 className="w-3.5 h-3.5" />
              {ACTION_BADGE[accion]?.label ?? accion}
            </span>
            <button onClick={onNota}
              className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-teal-600 ml-2">
              <FileText className="w-3 h-3" />Nota
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={onContactado}
              className="flex items-center justify-center gap-1.5 bg-slate-100 active:bg-slate-200
                         text-slate-700 text-sm font-medium py-3 rounded-xl transition-colors">
              <CheckCircle2 className="w-4 h-4" />Contactado
            </button>
            <button onClick={onEntregado}
              className="flex items-center justify-center gap-1.5 bg-teal-500 active:bg-teal-600
                         text-white text-sm font-semibold py-3 rounded-xl transition-colors">
              <CheckCircle2 className="w-4 h-4" />Entregado
            </button>
            <button onClick={onNoAnswer}
              className="flex items-center justify-center gap-1.5 bg-amber-100 active:bg-amber-200
                         text-amber-700 text-sm font-medium py-3 rounded-xl transition-colors">
              <PhoneMissed className="w-4 h-4" />No responde
            </button>
            <button onClick={onReprogramar}
              className="flex items-center justify-center gap-1.5 bg-indigo-100 active:bg-indigo-200
                         text-indigo-700 text-sm font-medium py-3 rounded-xl transition-colors">
              <RotateCcw className="w-4 h-4" />Reprogramar
            </button>
          </div>
        )}
      </div>

      {/* Footer: nota + detalle */}
      <div className="mt-3 flex items-center justify-between">
        {!isDelivered && !busy && (
          <button onClick={onNota}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-teal-600">
            <FileText className="w-3 h-3" />Agregar nota
          </button>
        )}
        <span className="flex-1" />
        <Link href={`/orders/${order.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-teal-600 hover:text-teal-800">
          <ExternalLink className="w-3 h-3" />Ver detalle
        </Link>
      </div>
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function SdDeliveryPage() {
  const [allOrders, setAllOrders]         = useState<Order[]>([])
  const [deliveredDb, setDeliveredDb]     = useState<DeliveredEntry[]>([])
  const [perf, setPerf]                   = useState<SdPerfData | null>(null)
  const [loading, setLoading]             = useState(true)
  const [lastRefresh, setLastRefresh]     = useState<Date>(new Date())

  const [activeTab, setActiveTab]         = useState<Tab>('pendientes')
  const [dateFilter, setDateFilter]       = useState<DateFilter>('hoy')
  const [searchQuery, setSearchQuery]     = useState('')
  const [currentPage, setCurrentPage]     = useState(1)

  const [actionMap, setActionMap]         = useState<Record<string, string>>({})
  const [loadingRow, setLoadingRow]       = useState<Record<string, boolean>>({})
  const [noteModal, setNoteModal]         = useState<{ orderId: string; name: string } | null>(null)
  const [reModal, setReModal]             = useState<{ orderId: string; name: string } | null>(null)
  const [toast, setToast]                 = useState<{ msg: string; ok: boolean } | null>(null)

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [ordersRes, deliveredRes, perfRes]: [OrdersResponse, DeliveredEntry[], SdPerfData] =
        await Promise.all([
          fetch('/api/orders?status=en_reparto&limit=500&page=1&sortBy=status_since_asc').then(r => r.json()),
          fetch('/api/reparto/entregados').then(r => r.json()),
          fetch('/api/sd-delivery/performance').then(r => r.json()),
        ])
      setAllOrders(ordersRes.data ?? [])
      setDeliveredDb(Array.isArray(deliveredRes) ? deliveredRes : [])
      setPerf(perfRes)
      setLastRefresh(new Date())
    } catch (err) {
      console.error('[sd-delivery/fetchData]', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 3 * 60 * 1000)
    return () => clearInterval(id)
  }, [fetchData])

  // ── Órdenes SD (filtro por zona) ──────────────────────────────────────────

  const sdOrders = useMemo(
    () => allOrders.filter(o => isSantoDomingoOrder(o.city, o.province, o.customer_address)),
    [allOrders],
  )

  const deliveredDbIds = useMemo(
    () => new Set(deliveredDb.map(e => e.order.id)),
    [deliveredDb],
  )

  const sdDeliveredDb = useMemo(
    () => deliveredDb.filter(e => isSantoDomingoOrder(e.order.city, e.order.province, e.order.customer_address)),
    [deliveredDb],
  )

  // Ordenes activas (no marcadas delivered)
  const activeOrders = useMemo(
    () => sdOrders.filter(o => actionMap[o.id] !== 'delivered' && !deliveredDbIds.has(o.id)),
    [sdOrders, actionMap, deliveredDbIds],
  )

  // Filtro por fecha (en_reparto desde)
  const filteredByDate = useMemo(() => {
    if (dateFilter === 'todos') return activeOrders
    if (dateFilter === 'hoy')   return activeOrders.filter(o => isToday(o.status_since ?? o.last_tracking_update ?? o.updated_at))
    if (dateFilter === 'ayer')  return activeOrders.filter(o => isYesterday(o.status_since ?? o.last_tracking_update ?? o.updated_at))
    return activeOrders
  }, [activeOrders, dateFilter])

  // Listas por tab
  const pendientes   = useMemo(() => filteredByDate.filter(o => !actionMap[o.id] || actionMap[o.id] === 'contacted' || actionMap[o.id] === 'note_added'), [filteredByDate, actionMap])
  const noResponden  = useMemo(() => filteredByDate.filter(o => actionMap[o.id] === 'no_answer' || actionMap[o.id] === 'rescheduled'), [filteredByDate, actionMap])

  // Entregados: session + DB (solo SD, solo hoy o ayer según tab)
  const sessionDelivered = useMemo(
    () => sdOrders
      .filter(o => actionMap[o.id] === 'delivered' && !deliveredDbIds.has(o.id))
      .map(o => ({ order: o, reported_at: new Date().toISOString(), local_confirmed: true })),
    [sdOrders, actionMap, deliveredDbIds],
  )

  const allDelivered = useMemo(() => [...sdDeliveredDb, ...sessionDelivered], [sdDeliveredDb, sessionDelivered])

  const entregadosHoy  = useMemo(() => allDelivered.filter(e => isToday(e.reported_at)), [allDelivered])
  const entregadosAyer = useMemo(() => allDelivered.filter(e => isYesterday(e.reported_at)), [allDelivered])

  // Conteos para tabs
  const tabCounts = useMemo(() => ({
    pendientes:       pendientes.length,
    no_responden:     noResponden.length,
    entregados_hoy:   entregadosHoy.length,
    entregados_ayer:  entregadosAyer.length,
  }), [pendientes, noResponden, entregadosHoy, entregadosAyer])

  // displayedOrders según tab activo
  const displayedOrders = useMemo(() => {
    let base: Order[]
    if (activeTab === 'pendientes')      base = pendientes
    else if (activeTab === 'no_responden') base = noResponden
    else if (activeTab === 'entregados_hoy')  base = entregadosHoy.map(e => e.order)
    else base = entregadosAyer.map(e => e.order)

    if (!searchQuery.trim()) return base
    const q = searchQuery.toLowerCase()
    return base.filter(o =>
      (o.tracking_number  ?? '').toLowerCase().includes(q) ||
      (o.customer_name    ?? '').toLowerCase().includes(q) ||
      (o.customer_phone   ?? '').toLowerCase().includes(q) ||
      (o.customer_address ?? '').toLowerCase().includes(q) ||
      (o.city             ?? '').toLowerCase().includes(q),
    )
  }, [activeTab, pendientes, noResponden, entregadosHoy, entregadosAyer, searchQuery])

  const pagedOrders = useMemo(
    () => displayedOrders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [displayedOrders, currentPage],
  )
  const totalPages = Math.ceil(displayedOrders.length / PAGE_SIZE)

  useEffect(() => { setCurrentPage(1) }, [activeTab, dateFilter, searchQuery])

  // ── Toast ─────────────────────────────────────────────────────────────────

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3000)
  }

  // ── Acciones ──────────────────────────────────────────────────────────────

  async function postAction(
    orderId: string,
    actionKey: string,
    actionType: string,
    contactResult?: string,
    notes?: string,
  ) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      await fetch(`/api/orders/${orderId}/actions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          action_type:    actionType,
          contact_result: contactResult ?? null,
          notes:          notes ?? null,
        }),
      })
      setActionMap(prev => ({ ...prev, [orderId]: actionKey }))
    } catch {
      showToast('Error al registrar acción', false)
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  async function markDelivered(orderId: string) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      const res = await fetch(`/api/sd-delivery/orders/${orderId}/mark-delivered`, { method: 'POST' })
      if (!res.ok) { showToast('Error al marcar entregado', false); return }
      setActionMap(prev => ({ ...prev, [orderId]: 'delivered' }))
      showToast('✓ Pedido entregado registrado', true)
      // Refrescar performance en background
      fetch('/api/sd-delivery/performance').then(r => r.json()).then(setPerf).catch(() => null)
    } catch {
      showToast('Error de red', false)
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  async function saveNote(orderId: string, note: string) {
    await postAction(orderId, 'note_added', 'note_added', undefined, note)
    showToast('Nota guardada', true)
  }

  async function saveReprogramar(orderId: string, note: string) {
    await postAction(orderId, 'rescheduled', 'rescheduled', undefined, note)
    showToast('Reprogramado registrado', true)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const TAB_META: { tab: Tab; label: string }[] = [
    { tab: 'pendientes',      label: 'Pendientes'    },
    { tab: 'no_responden',    label: 'No responden'  },
    { tab: 'entregados_hoy',  label: 'Hoy'           },
    { tab: 'entregados_ayer', label: 'Ayer'          },
  ]

  return (
    <div className="space-y-4">

      {/* ── Toast flotante ── */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg
          text-sm font-semibold text-white transition-all
          ${toast.ok ? 'bg-teal-600' : 'bg-red-600'}`}>
          {toast.msg}
        </div>
      )}

      {/* ── Modales ── */}
      {noteModal && (
        <NoteModal
          orderId={noteModal.orderId}
          name={noteModal.name}
          onSave={saveNote}
          onClose={() => setNoteModal(null)}
        />
      )}
      {reModal && (
        <ReprogramarModal
          orderId={reModal.orderId}
          name={reModal.name}
          onSave={saveReprogramar}
          onClose={() => setReModal(null)}
        />
      )}

      {/* ── Banner ── */}
      <div className="relative overflow-hidden rounded-2xl
                      bg-gradient-to-r from-teal-500 to-emerald-600
                      border-2 border-teal-400 shadow-lg shadow-teal-200/60">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white" />
          <div className="absolute -right-2 -bottom-10 w-24 h-24 rounded-full bg-white" />
        </div>
        <div className="relative px-4 py-4 md:px-6 md:py-5 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 md:w-12 md:h-12 bg-white/20 rounded-xl shrink-0">
              <MapPin className="w-5 h-5 md:w-6 md:h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2 md:gap-3">
                <h1 className="text-xl md:text-2xl font-black text-white tabular-nums">
                  {loading ? '…' : activeOrders.length.toLocaleString()}
                </h1>
                {!loading && pendientes.filter(o => criticalityLabel(o) === 'critico').length > 0 && (
                  <span className="flex items-center gap-1.5 bg-red-500/80 text-white
                                   text-xs font-bold px-2.5 py-1 rounded-full animate-pulse">
                    <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    {pendientes.filter(o => criticalityLabel(o) === 'critico').length} CRÍTICO{pendientes.filter(o => criticalityLabel(o) === 'critico').length !== 1 ? 'S' : ''}
                  </span>
                )}
              </div>
              <p className="text-white font-semibold text-sm md:text-base">Entregas Santo Domingo</p>
              <p className="hidden md:block text-teal-100 text-xs mt-0.5">
                Zona Gran Santo Domingo · Transporte local
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 md:gap-4 shrink-0">
            {(perf?.entregadosHoy ?? 0) > 0 && (
              <span className="text-xs md:text-sm text-emerald-200 font-semibold">
                ✓ {perf!.entregadosHoy} entregados hoy
              </span>
            )}
            <p className="hidden md:block text-teal-100 text-xs">
              {lastRefresh.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
            </p>
            <button
              onClick={fetchData}
              disabled={loading}
              className="flex items-center gap-1.5 md:gap-2 bg-white/20 hover:bg-white/30 text-white
                         text-sm font-medium px-3 py-2 md:px-4 md:py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden md:inline">Refrescar</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Strip Mi día ── */}
      {perf && (
        <div className="bg-white rounded-xl border border-gray-200 px-3 py-2.5 md:px-5 md:py-3.5 shadow-sm">
          <div className="flex items-center gap-2 md:gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 shrink-0">
              <TrendingUp className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Mi día</span>
            </div>
            <div className="flex items-center gap-1.5 md:gap-2 flex-wrap flex-1">
              {([
                { label: 'Entregados',   count: perf.entregadosHoy,    cls: 'bg-teal-100  text-teal-700'   },
                { label: 'Contactados',  count: perf.contactadosHoy,   cls: 'bg-blue-100  text-blue-700'   },
                { label: 'No responden', count: perf.noRespondenHoy,   cls: 'bg-amber-100 text-amber-700'  },
                { label: 'Reprogramados',count: perf.reprogramadosHoy, cls: 'bg-indigo-100 text-indigo-700' },
              ] as const).map(({ label, count, cls }) => (
                <div key={label} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${cls}`}>
                  <span className="text-sm font-black tabular-nums leading-none">{count}</span>
                  <span className="text-[11px] font-medium">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Filtro de fecha ── */}
      <div className="flex gap-2">
        {([
          { key: 'hoy',   label: 'Hoy'  },
          { key: 'ayer',  label: 'Ayer' },
          { key: 'todos', label: 'Todos' },
        ] as { key: DateFilter; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setDateFilter(key)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-colors
              ${dateFilter === key
                ? 'bg-teal-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            <CalendarDays className="w-3.5 h-3.5 shrink-0" />
            {label}
          </button>
        ))}
      </div>

      {/* ── Sin pedidos ── */}
      {!loading && activeOrders.length === 0 && allDelivered.length === 0 && (
        <div className="bg-teal-50 border border-teal-200 rounded-xl px-5 py-8 text-center">
          <Package2 className="w-10 h-10 text-teal-400 mx-auto mb-3" />
          <p className="text-teal-700 font-medium">No hay pedidos SD asignados en este momento</p>
          <p className="text-teal-600 text-sm mt-1">
            Los pedidos en reparto para Santo Domingo aparecerán aquí
          </p>
        </div>
      )}

      {/* ── Tabla principal ── */}
      {(loading || activeOrders.length > 0 || allDelivered.length > 0) && (
        <div className="bg-white rounded-xl border-2 border-teal-200 overflow-hidden shadow-sm">

          {/* Buscador */}
          <div className="px-4 py-3 border-b border-teal-100">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Buscar por nombre, teléfono, guía, dirección…"
                className="w-full pl-9 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg
                           focus:outline-none focus:ring-2 focus:ring-teal-300 focus:border-teal-300
                           placeholder:text-gray-400"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Tabs */}
          {!loading && (
            <div className="flex border-b border-teal-100 overflow-x-auto">
              {TAB_META.map(({ tab, label }) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] text-xs font-semibold
                              border-b-2 transition-colors whitespace-nowrap shrink-0
                    ${activeTab === tab
                      ? 'border-teal-500 text-teal-700 bg-teal-50/60'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                >
                  {label}
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full
                    ${activeTab === tab ? 'bg-teal-500 text-white' : 'bg-gray-100 text-gray-500'}`}>
                    {tabCounts[tab]}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Spinner */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Spinner className="w-6 h-6 text-teal-500" />
            </div>
          )}

          {/* Vista vacía */}
          {!loading && displayedOrders.length === 0 && (activeOrders.length > 0 || allDelivered.length > 0) && (
            <div className="px-5 py-10 text-center">
              <p className="text-gray-500 font-medium">
                {searchQuery
                  ? `Sin resultados para "${searchQuery}"`
                  : 'No hay pedidos en esta categoría'}
              </p>
              <button onClick={() => { setActiveTab('pendientes'); setSearchQuery('') }}
                className="text-teal-600 text-sm mt-2 hover:underline">
                Ver pendientes
              </button>
            </div>
          )}

          {/* ── Cards móvil ── */}
          {!loading && displayedOrders.length > 0 && (
            <div className="md:hidden divide-y divide-teal-50">
              {pagedOrders.map(order => {
                const accion     = actionMap[order.id]
                const busy       = !!loadingRow[order.id]
                const isDelivered = accion === 'delivered' || deliveredDbIds.has(order.id)
                return (
                  <SdCard
                    key={order.id}
                    order={order}
                    accion={accion}
                    busy={busy}
                    isDelivered={isDelivered}
                    onWA={() => postAction(order.id, 'contacted', 'contacted')}
                    onLlamar={() => postAction(order.id, 'contacted', 'contacted')}
                    onContactado={() => postAction(order.id, 'contacted', 'contacted')}
                    onNoAnswer={() => postAction(order.id, 'no_answer', 'contacted', 'no_answer')}
                    onEntregado={() => markDelivered(order.id)}
                    onReprogramar={() => setReModal({ orderId: order.id, name: order.customer_name ?? '' })}
                    onNota={() => setNoteModal({ orderId: order.id, name: order.customer_name ?? '' })}
                  />
                )
              })}
            </div>
          )}

          {/* ── Tabla desktop ── */}
          {!loading && displayedOrders.length > 0 && (
            <table className="hidden md:table w-full text-sm">
              <thead className="bg-teal-50/60 border-b border-teal-100">
                <tr>
                  {['Guía', 'Cliente', 'Ubicación', 'Tiempo', 'Contactar', 'Acciones', ''].map(h => (
                    <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-teal-800 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-teal-50">
                {pagedOrders.map(order => {
                  const nombre     = order.customer_name ?? ''
                  const waUrl      = whatsAppUrl(order.customer_phone, buildWaMsg(nombre, order.product_summary))
                  const telUrl     = callUrl(order.customer_phone)
                  const hasPhone   = !!order.customer_phone
                  const accion     = actionMap[order.id]
                  const busy       = !!loadingRow[order.id]
                  const isDelivered = accion === 'delivered' || deliveredDbIds.has(order.id)
                  const crit       = criticalityLabel(order)
                  const ubicacion  = order.city || order.province || (order.customer_address?.slice(0, 20))

                  const rowBg = isDelivered ? 'bg-green-50/30'
                    : crit === 'critico' ? 'bg-red-50/20 hover:bg-red-50/40'
                    : crit === 'riesgo'  ? 'bg-orange-50/15 hover:bg-orange-50/30'
                    : 'hover:bg-teal-50/30'

                  return (
                    <tr key={order.id} className={`transition-colors ${rowBg}`}>
                      {/* Guía */}
                      <td className="px-3 py-2.5">
                        <p className="font-mono text-xs font-semibold text-gray-900 whitespace-nowrap">
                          {order.tracking_number ?? '—'}
                        </p>
                        {order.order_number && (
                          <p className="font-mono text-[10px] text-gray-400 mt-0.5">{order.order_number}</p>
                        )}
                      </td>

                      {/* Cliente */}
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[140px]">
                          {nombre || '—'}
                        </p>
                        <p className="font-mono text-xs text-gray-500 mt-0.5">{order.customer_phone ?? '—'}</p>
                      </td>

                      {/* Ubicación */}
                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-1 text-gray-600">
                          <MapPin className="w-3 h-3 text-teal-400 shrink-0 mt-0.5" />
                          <span className="text-xs truncate max-w-[120px]">{ubicacion || '—'}</span>
                        </div>
                        {order.customer_address && (
                          <p className="text-[10px] text-gray-400 mt-0.5 ml-4 truncate max-w-[120px]"
                             title={order.customer_address}>
                            {order.customer_address}
                          </p>
                        )}
                      </td>

                      {/* Tiempo */}
                      <td className="px-3 py-2.5">
                        {!isDelivered ? (
                          <>
                            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold
                                              px-1.5 py-0.5 rounded-full border whitespace-nowrap
                                              ${crit === 'critico' ? 'bg-red-100 text-red-700 border-red-200 animate-pulse'
                                                : crit === 'riesgo'  ? 'bg-orange-100 text-orange-700 border-orange-200'
                                                : 'bg-teal-100 text-teal-700 border-teal-200'}`}>
                              {crit === 'critico' && <span className="w-1.5 h-1.5 rounded-full bg-red-500" />}
                              {crit === 'critico' ? '+48h' : crit === 'riesgo' ? '24-48h' : '0-24h'}
                            </span>
                            <p className="text-[10px] text-gray-500 mt-0.5 whitespace-nowrap">
                              {tiempoLabel(order)}
                            </p>
                          </>
                        ) : (
                          <span className="text-[10px] text-green-600 font-semibold">Entregado</span>
                        )}
                      </td>

                      {/* Contactar */}
                      <td className="px-3 py-2.5">
                        {hasPhone ? (
                          <div className="flex items-center gap-1.5">
                            {waUrl && (
                              <a href={waUrl} target="_blank" rel="noopener noreferrer"
                                 onClick={() => postAction(order.id, 'contacted', 'contacted')}
                                 className="flex items-center gap-1 bg-green-500 hover:bg-green-600
                                            text-white text-xs font-semibold px-2 py-1.5 rounded-lg transition-colors">
                                <MessageCircle className="w-3 h-3" />WA
                              </a>
                            )}
                            {telUrl && (
                              <a href={telUrl}
                                 onClick={() => postAction(order.id, 'contacted', 'contacted')}
                                 className="flex items-center gap-1 bg-blue-500 hover:bg-blue-600
                                            text-white text-xs font-semibold px-2 py-1.5 rounded-lg transition-colors">
                                <Phone className="w-3 h-3" />Llamar
                              </a>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-300 italic">Sin teléfono</span>
                        )}
                      </td>

                      {/* Acciones */}
                      <td className="px-3 py-2.5">
                        {isDelivered ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold
                                           px-2 py-1 rounded-full bg-green-100 text-green-700">
                            <CheckCircle2 className="w-3 h-3" />Entregado
                          </span>
                        ) : busy ? (
                          <Spinner className="w-4 h-4 text-teal-500" />
                        ) : accion ? (
                          <span className={`inline-flex items-center gap-1 text-xs font-semibold
                                           px-2 py-1 rounded-full
                                           ${ACTION_BADGE[accion]?.color ?? 'bg-gray-100 text-gray-600'}`}>
                            <CheckCircle2 className="w-3 h-3" />
                            {ACTION_BADGE[accion]?.label ?? accion}
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            <button onClick={() => postAction(order.id, 'contacted', 'contacted')}
                              className="flex items-center gap-1 bg-slate-100 hover:bg-slate-200
                                         text-slate-700 text-[11px] font-medium px-2 py-1 rounded transition-colors whitespace-nowrap">
                              <CheckCircle2 className="w-3 h-3" />Contactado
                            </button>
                            <button onClick={() => markDelivered(order.id)}
                              className="flex items-center gap-1 bg-teal-500 hover:bg-teal-600
                                         text-white text-[11px] font-semibold px-2 py-1 rounded transition-colors whitespace-nowrap">
                              <CheckCircle2 className="w-3 h-3" />Entregado
                            </button>
                            <button onClick={() => postAction(order.id, 'no_answer', 'contacted', 'no_answer')}
                              className="flex items-center gap-1 bg-amber-100 hover:bg-amber-200
                                         text-amber-700 text-[11px] font-medium px-2 py-1 rounded transition-colors whitespace-nowrap">
                              <PhoneMissed className="w-3 h-3" />No resp.
                            </button>
                            <button onClick={() => setReModal({ orderId: order.id, name: nombre })}
                              className="flex items-center gap-1 bg-indigo-100 hover:bg-indigo-200
                                         text-indigo-700 text-[11px] font-medium px-2 py-1 rounded transition-colors whitespace-nowrap">
                              <RotateCcw className="w-3 h-3" />Reprogram.
                            </button>
                            <button onClick={() => setNoteModal({ orderId: order.id, name: nombre })}
                              className="flex items-center gap-1 bg-gray-100 hover:bg-gray-200
                                         text-gray-600 text-[11px] font-medium px-2 py-1 rounded transition-colors whitespace-nowrap">
                              <FileText className="w-3 h-3" />Nota
                            </button>
                          </div>
                        )}
                      </td>

                      {/* Ver detalle */}
                      <td className="px-3 py-2.5">
                        <Link href={`/orders/${order.id}`}
                          className="inline-flex items-center gap-1 text-xs font-medium
                                     text-teal-600 hover:text-teal-800 whitespace-nowrap hover:underline">
                          <ExternalLink className="w-3 h-3" />Ver
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {/* Paginación */}
          {!loading && totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-teal-100 bg-teal-50/40">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="flex items-center gap-1.5 px-3 py-2 min-h-[40px] text-xs font-semibold rounded-lg
                           border border-teal-200 text-teal-700 bg-white hover:bg-teal-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />Anterior
              </button>
              <span className="text-xs text-gray-500 tabular-nums">
                <span className="font-bold text-gray-800">{currentPage}</span> / <span className="font-bold text-gray-800">{totalPages}</span>
                <span className="hidden md:inline text-gray-400"> · {displayedOrders.length} resultados</span>
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="flex items-center gap-1.5 px-3 py-2 min-h-[40px] text-xs font-semibold rounded-lg
                           border border-teal-200 text-teal-700 bg-white hover:bg-teal-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente<ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Flujo operativo ── */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-4 md:px-5">
        <p className="text-xs text-gray-500 leading-relaxed">
          <strong className="text-gray-700">Flujo:</strong>{' '}
          WhatsApp / Llamar para confirmar disponibilidad →
          Registrar "Contactado" →
          Al entregar: marcar "Entregado" →
          Si no contesta o no está: "No responde" o "Reprogramar" →
          Agregar nota para dejar detalles de incidencias.
        </p>
      </div>

    </div>
  )
}
