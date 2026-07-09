'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Spinner } from '@/components/ui/spinner'
import { whatsAppUrl, callUrl } from '@/lib/utils'
import { isSantoDomingoOrder } from '@/lib/alert-helpers'
import { detectSdZone, getZoneById, SD_ZONES, SD_META_DIARIA, ZONE_COLORS } from '@/lib/sd-zones'
import type { ZoneId } from '@/lib/sd-zones'
import type { Order } from '@/types'
import {
  MapPin, RefreshCw, MessageCircle, Phone,
  CheckCircle2, PhoneMissed, ExternalLink,
  Search, Package2,
  RotateCcw, FileText, X,
  ChevronLeft, ChevronRight, Truck, Navigation,
  UserCheck, Clock, Route, DollarSign, ChevronDown, ChevronUp,
  MoreHorizontal, MapPinOff, Wallet, Target,
} from 'lucide-react'

// ── Tipos ─────────────────────────────────────────────────────────────────────
// Fase A (rediseño "Mi Ruta"): se elimina la navegación por tabs de micro-estado.
// El mensajero trabaja sobre una sola pantalla agrupada por zona ("Mi Ruta") y un
// historial unificado de cierres ("Historial"). El motor de estados internos
// (DisplayState/computeDisplayState) NO cambia — solo deja de determinar a qué
// pestaña pertenece un pedido y pasa a determinar únicamente el badge/label
// amigable y qué botones se muestran en la tarjeta.

type View       = 'ruta' | 'historial'
type DateFilter = 'hoy' | 'ayer' | 'todos'
type OrderPool  = 'nuevo' | 'confirmado'
type LocalAccion = string | undefined

// Estados internos de un pedido (no se muestran tal cual al mensajero)
type DisplayState =
  | 'nuevo'            // pool=nuevo, sin acción (necesita confirmación)
  | 'espera_despacho'  // pool=nuevo, client_confirmed (admin debe despachar)
  | 'confirmado_listo' // pool=confirmado, sin route_confirmed
  | 'en_ruta'          // pool=confirmado, route_confirmed
  | 'no_responde'      // no_answer (cualquier pool)
  | 'reprogramado'     // rescheduled (cualquier pool)
  | 'entregado'
  | 'cancelado'        // customer_declined

interface PooledOrder {
  order: Order
  pool:  OrderPool
}

interface SdPerfData {
  entregadosHoy:    number
  entregadosAyer:   number
  enRutaHoy:        number
  confirmedHoy:     number
  contactadosHoy:   number
  noRespondenHoy:   number
  reprogramadosHoy: number
}

interface DeliveredEntry {
  order:           Order
  reported_at:     string
  local_confirmed: boolean
}

interface OrdersResponse { data: Order[] }

interface SdActionsResponse {
  actions: Record<string, 'no_answer' | 'rescheduled' | 'customer_declined'>
  rescheduledMeta: Record<string, { at: string; count: number }>
}

// ── Helpers de fecha/tiempo ───────────────────────────────────────────────────

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

function criticalityLabel(order: Order): 'critico' | 'riesgo' | 'normal' {
  const h = horasEnReparto(order)
  if (h >= 48) return 'critico'
  if (h >= 24) return 'riesgo'
  return 'normal'
}

function orderDateMs(order: Order, pool: OrderPool): number {
  if (pool === 'nuevo') return new Date(order.created_at).getTime()
  return new Date(order.status_since ?? order.last_tracking_update ?? order.updated_at).getTime()
}

function formatOrderDate(order: Order, pool: OrderPool): { relative: string; absolute: string } {
  const ms = orderDateMs(order, pool)
  const diffMs = Date.now() - ms
  const diffH = diffMs / (1000 * 60 * 60)
  let relative: string
  if (diffH < 1)         relative = 'Hace menos de 1h'
  else if (diffH < 24)   relative = `Hace ${Math.floor(diffH)}h`
  else {
    const dias = Math.floor(diffH / 24)
    const hrs  = Math.floor(diffH % 24)
    if (dias === 1) relative = hrs > 0 ? `Hace 1d ${hrs}h` : 'Hace 1 día'
    else            relative = hrs > 0 ? `Hace ${dias}d ${hrs}h` : `Hace ${dias} días`
  }
  const d = new Date(ms)
  const absolute = d.toLocaleString('es-DO', {
    timeZone: 'America/Santo_Domingo',
    day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
  return { relative, absolute }
}

function formatRescheduleDate(iso: string): { relative: string; absolute: string } {
  const ms = new Date(iso).getTime()
  const diffH = (Date.now() - ms) / (1000 * 60 * 60)
  let relative: string
  if (diffH < 1)         relative = 'Hace menos de 1h'
  else if (diffH < 24)   relative = `Hace ${Math.floor(diffH)}h`
  else {
    const dias = Math.floor(diffH / 24)
    const hrs  = Math.floor(diffH % 24)
    if (dias === 1) relative = hrs > 0 ? `Hace 1d ${hrs}h` : 'Hace 1 día'
    else            relative = hrs > 0 ? `Hace ${dias}d ${hrs}h` : `Hace ${dias} días`
  }
  const absolute = new Date(ms).toLocaleString('es-DO', {
    timeZone: 'America/Santo_Domingo',
    day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
  return { relative, absolute }
}

function mapsUrl(order: Order): string | null {
  const parts = [order.customer_address, order.city, order.province].filter(Boolean)
  if (!parts.length) return null
  return `https://maps.google.com/?q=${encodeURIComponent(parts.join(', '))}`
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

function buildWaMsgNuevo(nombre: string, product: string | null | undefined): string {
  const n = nombre.trim() || 'cliente'
  const p = (product ?? '').trim().slice(0, 32) || 'tu pedido'
  return [
    `Hola ${n} 😊,`,
    '',
    `Te contactamos para confirmar tu pedido de ${p} 📦.`,
    '¿Puedes confirmar que lo recibirás hoy?',
    '',
    'Por favor tener el monto exacto listo 🙏',
  ].join('\n')
}

function matchesQuery(o: Order, q: string): boolean {
  return (
    (o.tracking_number  ?? '').toLowerCase().includes(q) ||
    (o.customer_name    ?? '').toLowerCase().includes(q) ||
    (o.customer_phone   ?? '').toLowerCase().includes(q) ||
    (o.customer_address ?? '').toLowerCase().includes(q) ||
    (o.city             ?? '').toLowerCase().includes(q) ||
    (o.order_number     ?? '').toLowerCase().includes(q)
  )
}

// Motor de estados — SIN CAMBIOS respecto a la versión anterior.
function computeDisplayState(pool: OrderPool, accion: LocalAccion, isDelivered: boolean): DisplayState {
  if (isDelivered) return 'entregado'
  if (accion === 'customer_declined') return 'cancelado'
  if (pool === 'nuevo') {
    if (accion === 'client_confirmed') return 'espera_despacho'
    if (accion === 'no_answer')        return 'no_responde'
    if (accion === 'rescheduled')      return 'reprogramado'
    return 'nuevo'
  }
  // pool === 'confirmado'
  if (accion === 'route_confirmed') return 'en_ruta'
  if (accion === 'no_answer')       return 'no_responde'
  if (accion === 'rescheduled')     return 'reprogramado'
  return 'confirmado_listo'
}

// Prioridad de acción — heurística simple (sin GPS, sin IA) para ordenar pedidos
// dentro de una zona y decidir qué zona/pedido mostrar primero. 0 = actuable ahora
// mismo (ya saliste, solo falta cobrar), 1 = listo para salir, 2 = requiere llamada
// antes de poder avanzar (nuevo/no_responde/reprogramado/espera_despacho).
// Es el mismo tipo de heurística que más adelante reemplazará un ranking real
// (distancia + ubicación real por WhatsApp + tiempo de espera + COD) en Delivery
// Copilot — hoy solo usa datos que ya existen.
function actionPriorityTier(ds: DisplayState): number {
  if (ds === 'en_ruta')          return 0
  if (ds === 'confirmado_listo') return 1
  return 2
}

// Etiqueta amigable + estilo por DisplayState — lo único que el mensajero ve.
function friendlyBadge(ds: DisplayState, crit: 'critico' | 'riesgo' | 'normal', reprogCount?: number) {
  switch (ds) {
    case 'nuevo':
      return { text: 'Por confirmar', cls: 'bg-blue-100 text-blue-700', Icon: Clock }
    case 'espera_despacho':
      return { text: 'Confirmado · en espera', cls: 'bg-purple-100 text-purple-700', Icon: UserCheck }
    case 'confirmado_listo':
      return crit === 'critico'
        ? { text: 'Listo hace tiempo', cls: 'bg-red-100 text-red-700 animate-pulse', Icon: Route }
        : { text: 'Listo para salir', cls: crit === 'riesgo' ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-600', Icon: Route }
    case 'en_ruta':
      return { text: 'En camino', cls: 'bg-teal-100 text-teal-700', Icon: Navigation }
    case 'no_responde':
      return { text: 'No respondió', cls: 'bg-amber-100 text-amber-700', Icon: PhoneMissed }
    case 'reprogramado':
      return { text: reprogCount && reprogCount > 1 ? `Reprogramado ×${reprogCount}` : 'Reprogramado', cls: 'bg-orange-100 text-orange-700', Icon: RotateCcw }
    case 'entregado':
      return { text: 'Entregado', cls: 'bg-green-100 text-green-700', Icon: CheckCircle2 }
    case 'cancelado':
      return { text: 'Ya no desea', cls: 'bg-red-100 text-red-700', Icon: X }
  }
}

const PAGE_SIZE = 40

// ── Agrupación por zona (Fase A: aplica a TODOS los pedidos activos) ──────────

interface PooledZoneGroup {
  zone:      ReturnType<typeof getZoneById>
  items:     PooledOrder[]
  codTotal:  number
}

function groupPooledByZone(pooled: PooledOrder[]): PooledZoneGroup[] {
  const map = new Map<string, PooledOrder[]>()
  for (const p of pooled) {
    const zone = detectSdZone(p.order.city, p.order.province, p.order.customer_address)
    const arr  = map.get(zone.id) ?? []
    arr.push(p)
    map.set(zone.id, arr)
  }
  const orderedIds: string[] = [...SD_ZONES.map(z => z.id), 'otro']
  const groups: PooledZoneGroup[] = []
  for (const id of orderedIds) {
    const items = map.get(id)
    if (!items || items.length === 0) continue
    const zone = getZoneById(id)
    groups.push({
      zone,
      items,
      codTotal: items.reduce((s, { order }) => s + (order.cod_amount ?? 0), 0),
    })
  }
  return groups
}

// ── Modales ───────────────────────────────────────────────────────────────────

interface NoteModalProps {
  orderId:     string
  name:        string
  title?:      string
  placeholder?: string
  notePrefix?: string
  onSave:      (orderId: string, note: string) => Promise<void>
  onClose:     () => void
}

function NoteModal({ orderId, name, title, placeholder, notePrefix, onSave, onClose }: NoteModalProps) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSave() {
    if (!text.trim()) return
    setBusy(true)
    await onSave(orderId, `${notePrefix ?? ''}${text.trim()}`)
    setBusy(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white w-full md:max-w-md rounded-t-2xl md:rounded-xl shadow-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-gray-900">{title ?? 'Agregar nota'}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-gray-600 truncate">{name || 'Pedido'}</p>
        <textarea
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={placeholder ?? 'Ej: Cliente fuera, reprogramar para mañana tarde…'}
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
  const [busy, setBusy] = useState(false)

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

interface MasSheetCtx {
  orderId: string
  name:    string
  ds:      DisplayState
  pool:    OrderPool
}

interface MasSheetProps {
  ctx: MasSheetCtx
  onClose: () => void
  onNoAnswer: (orderId: string) => void
  onReprogramar: (orderId: string, name: string) => void
  onDeclinado: (orderId: string) => void
  onDireccionIncorrecta: (orderId: string, name: string) => void
  onOtroMotivo: (orderId: string, name: string) => void
}

function MasSheet({ ctx, onClose, onNoAnswer, onReprogramar, onDeclinado, onDireccionIncorrecta, onOtroMotivo }: MasSheetProps) {
  const { orderId, name, ds } = ctx
  const canNoAnswer    = ds === 'nuevo' || ds === 'confirmado_listo' || ds === 'en_ruta'
  const canReprogramar = ds === 'en_ruta'
  const canDeclinar    = ds === 'en_ruta'
  const canDireccion   = ds !== 'entregado' && ds !== 'espera_despacho' && ds !== 'cancelado'

  function pick(fn: () => void) {
    fn()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white w-full max-w-lg rounded-t-2xl shadow-xl p-3
                      pb-[calc(env(safe-area-inset-bottom,_0px)_+_12px)]">
        <div className="flex items-center justify-between px-2 pt-1 pb-2">
          <div className="min-w-0">
            <h3 className="font-bold text-gray-900 text-sm">Más opciones</h3>
            <p className="text-xs text-gray-500 truncate">{name || 'Pedido'}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-0.5">
          {canNoAnswer && (
            <button onClick={() => pick(() => onNoAnswer(orderId))}
              className="w-full flex items-center gap-3 px-3 py-3.5 rounded-xl active:bg-amber-50 text-left">
              <PhoneMissed className="w-4 h-4 text-amber-600 shrink-0" />
              <span className="text-sm font-medium text-gray-800">No respondió</span>
            </button>
          )}
          {canReprogramar && (
            <button onClick={() => pick(() => onReprogramar(orderId, name))}
              className="w-full flex items-center gap-3 px-3 py-3.5 rounded-xl active:bg-indigo-50 text-left">
              <RotateCcw className="w-4 h-4 text-indigo-600 shrink-0" />
              <span className="text-sm font-medium text-gray-800">Reprogramar</span>
            </button>
          )}
          {canDeclinar && (
            <button onClick={() => pick(() => onDeclinado(orderId))}
              className="w-full flex items-center gap-3 px-3 py-3.5 rounded-xl active:bg-red-50 text-left">
              <X className="w-4 h-4 text-red-600 shrink-0" />
              <span className="text-sm font-medium text-gray-800">Ya no desea</span>
            </button>
          )}
          {canDireccion && (
            <button onClick={() => pick(() => onDireccionIncorrecta(orderId, name))}
              className="w-full flex items-center gap-3 px-3 py-3.5 rounded-xl active:bg-orange-50 text-left">
              <MapPinOff className="w-4 h-4 text-orange-600 shrink-0" />
              <span className="text-sm font-medium text-gray-800">Dirección incorrecta</span>
            </button>
          )}
          <button onClick={() => pick(() => onOtroMotivo(orderId, name))}
            className="w-full flex items-center gap-3 px-3 py-3.5 rounded-xl active:bg-gray-50 text-left">
            <FileText className="w-4 h-4 text-gray-500 shrink-0" />
            <span className="text-sm font-medium text-gray-800">Otro motivo / nota</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Card única (móvil y desktop) ──────────────────────────────────────────────

// Fase A: la "conversación" con el cliente es un link a WhatsApp externo (wa.me).
// Cuando exista el Inbox interno (Delivery Copilot V1), esta es la ÚNICA función
// que debe cambiar — el resto de la UI ya llama a esto sin saber el canal real.
function getConversationLink(order: Order, pool: OrderPool): string | null {
  const nombre = order.customer_name ?? ''
  const msg = pool === 'nuevo'
    ? buildWaMsgNuevo(nombre, order.product_summary)
    : buildWaMsg(nombre, order.product_summary)
  return whatsAppUrl(order.customer_phone, msg)
}

interface SdCardProps {
  order:              Order
  pool:               OrderPool
  accion:             LocalAccion
  busy:               boolean
  isProximaParada:    boolean
  onAbrirConversacion: () => void
  onLlamar:           () => void
  onClienteConfirma:  () => void
  onConfirmarRuta:    () => void
  onDespacharLocal:   () => void
  onMarcarEntregado:  () => void
  onVolverARuta:      () => void
  onAbrirMas:         () => void
  reprogramadoMeta?: { at: string; count: number }
}

function SdCard({
  order, pool, accion, busy, isProximaParada,
  onAbrirConversacion, onLlamar, onClienteConfirma, onConfirmarRuta, onDespacharLocal, onMarcarEntregado, onVolverARuta, onAbrirMas,
  reprogramadoMeta,
}: SdCardProps) {
  const nombre   = order.customer_name ?? ''
  const conversationUrl = getConversationLink(order, pool)
  const telUrl   = callUrl(order.customer_phone)
  const hasPhone = !!order.customer_phone
  const ds       = computeDisplayState(pool, accion, false)
  const crit     = criticalityLabel(order)
  const badge    = friendlyBadge(ds, crit, reprogramadoMeta?.count)

  const ubicacion = order.city
    || order.province
    || (order.customer_address ? order.customer_address.slice(0, 24) : null)

  return (
    <div className={`p-4 rounded-2xl bg-white transition-shadow ${
      isProximaParada
        ? 'border-2 border-teal-500 shadow-md shadow-teal-100'
        : 'border border-gray-100 shadow-sm'
    }`}>

      {/* "Próxima parada": heurística simple (estado + tiempo esperando), sin GPS/IA —
          acostumbra la UI al concepto de "un cliente recomendado" para Delivery Copilot. */}
      {isProximaParada && (
        <div className="flex items-center gap-1 text-[10px] font-black text-teal-600 uppercase tracking-wide mb-2">
          <Target className="w-3 h-3" />Próxima parada
        </div>
      )}

      {/* Cabecera: identificador + badge de estado */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-bold text-gray-900 truncate">
            {order.tracking_number ?? order.order_number ?? '—'}
          </p>
          {(() => { const { relative, absolute } = formatOrderDate(order, pool); return (
            <p className="text-[10px] text-gray-400 mt-0.5" title={absolute}>
              <span className="font-medium">{relative}</span>
            </p>
          ); })()}
        </div>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 flex items-center gap-1 whitespace-nowrap ${badge.cls}`}>
          <badge.Icon className="w-3 h-3" />{badge.text}
        </span>
      </div>

      {/* Cliente */}
      <p className="font-semibold text-gray-900 text-base leading-tight">{nombre || '—'}</p>
      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
        <p className="font-mono text-sm text-gray-500">{order.customer_phone || '—'}</p>
        {order.cod_amount != null && order.cod_amount > 0 && (
          <span className="text-sm font-black text-emerald-700 bg-emerald-50 border border-emerald-200
                           px-2 py-0.5 rounded-lg tabular-nums">
            RD${order.cod_amount.toLocaleString('es-DO')} COD
          </span>
        )}
      </div>

      {ds === 'nuevo' && order.product_summary && (
        <p className="text-xs text-blue-700 font-medium mt-1 truncate" title={order.product_summary}>
          📦 {order.product_summary.slice(0, 55)}
        </p>
      )}

      {ubicacion && (
        <div className="flex items-center gap-1 mt-1.5 text-xs text-gray-500">
          <MapPin className="w-3 h-3 shrink-0 text-teal-500" />
          <span className="truncate flex-1">{ubicacion}</span>
          {mapsUrl(order) && (
            <a href={mapsUrl(order)!} target="_blank" rel="noopener noreferrer"
               className="shrink-0 flex items-center gap-0.5 text-teal-600 font-semibold
                          bg-teal-50 border border-teal-200 px-1.5 py-0.5 rounded-md
                          active:bg-teal-100 -my-0.5">
              <ExternalLink className="w-3 h-3" />Mapa
            </a>
          )}
        </div>
      )}
      {order.customer_address && (
        <p className="text-[11px] text-gray-400 mt-0.5 truncate pl-4" title={order.customer_address}>
          {order.customer_address}
        </p>
      )}

      {reprogramadoMeta?.at && ds === 'reprogramado' && (() => {
        const { relative, absolute } = formatRescheduleDate(reprogramadoMeta.at)
        return (
          <p className="text-[10px] text-orange-500/80 mt-1">
            <span className="font-medium">{relative}</span>
            <span className="ml-1 opacity-70">· {absolute}</span>
          </p>
        )
      })()}

      {/* Acciones principales */}
      {busy ? (
        <div className="mt-3"><Spinner className="w-5 h-5 text-teal-500" /></div>
      ) : (
        <div className="mt-3 flex items-stretch gap-2">
          {/* WhatsApp y Llamar: las 2 herramientas principales del mensajero — nunca se ocultan.
              El <a href> se mantiene (no window.open) porque es lo que abre confiablemente la
              app de WhatsApp en móvil vía el esquema wa.me. */}
          {hasPhone && conversationUrl && (
            <a href={conversationUrl} target="_blank" rel="noopener noreferrer" onClick={onAbrirConversacion}
               className="flex items-center justify-center bg-green-500 active:bg-green-700
                          text-white min-h-[44px] min-w-[44px] rounded-xl transition-colors shrink-0">
              <MessageCircle className="w-4 h-4" />
            </a>
          )}
          {hasPhone && telUrl && (
            <a href={telUrl} onClick={onLlamar}
               className="flex items-center justify-center bg-blue-500 active:bg-blue-700
                          text-white min-h-[44px] min-w-[44px] rounded-xl transition-colors shrink-0">
              <Phone className="w-4 h-4" />
            </a>
          )}

          {ds === 'nuevo' && (
            <button onClick={onClienteConfirma}
              className="flex-1 flex items-center justify-center gap-2 bg-blue-600 active:bg-blue-700
                         text-white text-sm font-bold py-2.5 min-h-[44px] rounded-xl transition-colors min-w-0">
              <UserCheck className="w-4 h-4 shrink-0" /><span className="truncate">Cliente confirma</span>
            </button>
          )}
          {ds === 'espera_despacho' && (
            <button onClick={onDespacharLocal}
              className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 active:bg-indigo-700
                         text-white text-sm font-bold py-2.5 min-h-[44px] rounded-xl transition-colors min-w-0">
              <Truck className="w-4 h-4 shrink-0" /><span className="truncate">Despachar</span>
            </button>
          )}
          {ds === 'confirmado_listo' && (
            <button onClick={onConfirmarRuta}
              className="flex-1 flex items-center justify-center gap-2 bg-teal-500 active:bg-teal-600
                         text-white text-sm font-bold py-2.5 min-h-[44px] rounded-xl transition-colors min-w-0">
              <Truck className="w-4 h-4 shrink-0" /><span className="truncate">Confirmar ruta</span>
            </button>
          )}
          {ds === 'en_ruta' && (
            <button onClick={onMarcarEntregado}
              className="flex-1 flex items-center justify-center gap-2 bg-emerald-500 active:bg-emerald-600
                         text-white text-sm font-bold py-2.5 min-h-[44px] rounded-xl transition-colors min-w-0">
              <CheckCircle2 className="w-4 h-4 shrink-0" /><span className="truncate">Cliente pagó</span>
            </button>
          )}
          {ds === 'reprogramado' && pool === 'confirmado' && (
            <>
              <button onClick={onVolverARuta}
                className="flex-1 flex items-center justify-center gap-1.5 bg-teal-500 active:bg-teal-600
                           text-white text-xs font-bold py-2.5 min-h-[44px] rounded-xl transition-colors min-w-0">
                <Truck className="w-3.5 h-3.5 shrink-0" /><span className="truncate">Volver a ruta</span>
              </button>
              <button onClick={onMarcarEntregado}
                className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-500 active:bg-emerald-600
                           text-white text-xs font-bold py-2.5 min-h-[44px] rounded-xl transition-colors min-w-0">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /><span className="truncate">Pagó</span>
              </button>
            </>
          )}
          {(ds === 'reprogramado' || ds === 'no_responde') && pool === 'nuevo' && (
            <button onClick={onClienteConfirma}
              className="flex-1 flex items-center justify-center gap-1.5 bg-blue-100 active:bg-blue-200
                         text-blue-700 text-xs font-semibold py-2.5 min-h-[44px] rounded-xl transition-colors min-w-0">
              <UserCheck className="w-3.5 h-3.5 shrink-0" /><span className="truncate">Confirma ahora</span>
            </button>
          )}

          {ds !== 'espera_despacho' && (
            <button onClick={onAbrirMas}
              className="flex items-center justify-center bg-gray-100 active:bg-gray-200
                         text-gray-600 min-h-[44px] min-w-[44px] rounded-xl transition-colors shrink-0">
              <MoreHorizontal className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-end">
        <Link href={`/orders/${order.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-teal-600 hover:text-teal-800">
          <ExternalLink className="w-3 h-3" />Ver detalle
        </Link>
      </div>
    </div>
  )
}

// ── Fila de historial (solo lectura) ──────────────────────────────────────────

function HistorialRow({ order, kind, at }: { order: Order; kind: 'entregado' | 'no_desea'; at: string }) {
  const isEntregado = kind === 'entregado'
  const ubicacion = order.city || order.province
  return (
    <div className={`p-4 border-b border-gray-50 ${isEntregado ? 'bg-green-50/20' : 'bg-red-50/10'}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="font-mono text-sm font-bold text-gray-900 truncate">
          {order.tracking_number ?? order.order_number ?? '—'}
        </p>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 flex items-center gap-1
          ${isEntregado ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
          {isEntregado ? <CheckCircle2 className="w-3 h-3" /> : <X className="w-3 h-3" />}
          {isEntregado ? 'Entregado' : 'Ya no desea'}
        </span>
      </div>
      <p className="font-semibold text-gray-900 text-base leading-tight">{order.customer_name ?? '—'}</p>
      <p className="font-mono text-sm text-gray-500">{order.customer_phone || '—'}</p>
      <div className="flex items-center gap-2 mt-1 flex-wrap">
        {ubicacion && (
          <span className="flex items-center gap-1 text-xs text-gray-500">
            <MapPin className="w-3 h-3 shrink-0 text-gray-400" />{ubicacion}
          </span>
        )}
        {order.cod_amount != null && order.cod_amount > 0 && (
          <span className="text-xs font-black text-emerald-700 bg-emerald-50 border border-emerald-200
                           px-2 py-0.5 rounded-lg tabular-nums">
            RD${order.cod_amount.toLocaleString('es-DO')}
          </span>
        )}
        <span className="text-[11px] text-gray-400">
          {new Date(at).toLocaleString('es-DO', { timeZone: 'America/Santo_Domingo', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}
        </span>
      </div>
      <div className="mt-2.5 flex items-center justify-end">
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
  const [allEnReparto, setAllEnReparto]             = useState<Order[]>([])
  const [allNuevos, setAllNuevos]                   = useState<Order[]>([])
  const [allConfirmedPending, setAllConfirmedPending] = useState<Order[]>([])
  const [deliveredDb, setDeliveredDb]               = useState<DeliveredEntry[]>([])
  const [perf, setPerf]                 = useState<SdPerfData | null>(null)
  const [loading, setLoading]           = useState(true)
  const [lastRefresh, setLastRefresh]   = useState<Date>(new Date())

  const [view, setView]                 = useState<View>('ruta')
  const [dateFilter, setDateFilter]     = useState<DateFilter>('hoy')
  const [searchQuery, setSearchQuery]   = useState('')
  const [searchOpen, setSearchOpen]     = useState(false)
  const [currentPage, setCurrentPage]   = useState(1)
  const [collapsedZones, setCollapsedZones] = useState<Set<string>>(new Set())

  const [actionMap, setActionMap]       = useState<Record<string, string>>({})
  const [confirmedOrderCache, setConfirmedOrderCache] = useState<Map<string, Order>>(new Map())
  const [loadingRow, setLoadingRow]     = useState<Record<string, boolean>>({})
  const [noteModal, setNoteModal]       = useState<{ orderId: string; name: string; mode: 'nota' | 'direccion' } | null>(null)
  const [reModal, setReModal]           = useState<{ orderId: string; name: string } | null>(null)
  const [masSheet, setMasSheet]         = useState<MasSheetCtx | null>(null)
  const [reprogramadoMeta, setReprogramadoMeta] = useState<Record<string, { at: string; count: number }>>({})
  const [toast, setToast]               = useState<{ msg: string; ok: boolean } | null>(null)

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [enRepartoRes, nuevosRes, confirmedRes, deliveredRes, perfRes, routeConfirmedRes, sdActionsRes]:
        [OrdersResponse, OrdersResponse, OrdersResponse, DeliveredEntry[], SdPerfData, { ids: string[], orders: Order[] }, SdActionsResponse] =
        await Promise.all([
          fetch('/api/orders?status=en_reparto&limit=500&page=1&sortBy=status_since_asc').then(r => r.json()),
          fetch('/api/orders?confirmationStatus=pending&limit=300').then(r => r.json()),
          fetch('/api/orders?confirmationStatus=confirmed&limit=200').then(r => r.json()),
          fetch('/api/reparto/entregados').then(r => r.json()),
          fetch('/api/sd-delivery/performance').then(r => r.json()),
          fetch('/api/sd-delivery/route-confirmed-ids').then(r => r.json()).catch(() => ({ ids: [], orders: [] })),
          fetch('/api/sd-delivery/sd-actions').then(r => r.json()).catch(() => ({ actions: {}, rescheduledMeta: {} })),
        ])
      const enRepartoData: Order[] = enRepartoRes.data ?? []
      const confirmedData: Order[]  = confirmedRes.data ?? []
      const routeConfirmedIds       = new Set<string>(routeConfirmedRes.ids ?? [])

      // Supplement enRepartoData with route_confirmed orders that were paginated out.
      // The API returns full order objects for IDs that are en_reparto but beyond limit=500.
      const rcOrders = routeConfirmedRes.orders ?? []
      const enRepartoBaseIds = new Set(enRepartoData.map((o: Order) => o.id))
      const missingRCOrders = rcOrders.filter((o: Order) => !enRepartoBaseIds.has(o.id))
      const supplementedEnReparto = [...enRepartoData, ...missingRCOrders]

      setAllEnReparto(supplementedEnReparto)
      setAllNuevos(nuevosRes.data ?? [])
      setAllConfirmedPending(confirmedData)
      setDeliveredDb(Array.isArray(deliveredRes) ? deliveredRes : [])
      setPerf(perfRes)
      setLastRefresh(new Date())

      const freshEnRepartoIds = new Set(supplementedEnReparto.map((o: Order) => o.id))

      setReprogramadoMeta(sdActionsRes.rescheduledMeta ?? {})
      setActionMap(prev => {
        const next = { ...prev }

        // Seed secondary actions (no_answer, rescheduled, customer_declined) from DB.
        // The sd-actions endpoint only returns a secondary action when it is MORE RECENT
        // than route_confirmed for that order, so applying these first is safe:
        // route_confirmed seeding below will not override them (its guard checks next[id]).
        // Terminal states (delivered, client_confirmed) are never overridden.
        const noOverride = new Set(['delivered', 'client_confirmed'])
        for (const [id, secondaryAction] of Object.entries(sdActionsRes.actions ?? {})) {
          if (!noOverride.has(next[id] ?? '')) {
            next[id] = secondaryAction
          }
        }

        // Seed route_confirmed from DB so "En ruta" persists after page refresh.
        // Only applied when there is no current secondary action already seeded above
        // and the order is currently en_reparto.
        for (const id of routeConfirmedIds) {
          if (freshEnRepartoIds.has(id) && (!next[id] || next[id] === 'client_confirmed')) {
            next[id] = 'route_confirmed'
          }
        }
        // Seed client_confirmed for SD orders confirmed by client but not yet dispatched.
        for (const order of confirmedData) {
          if (
            isSantoDomingoOrder(order.city, order.province, order.customer_address) &&
            !order.tracking_number &&
            !freshEnRepartoIds.has(order.id) &&
            !next[order.id]
          ) {
            next[order.id] = 'client_confirmed'
          }
        }
        return next
      })

      // Remove from cache any order that now appears in en_reparto (admin dispatched it)
      setConfirmedOrderCache(prev => {
        if (prev.size === 0) return prev
        const next = new Map(prev)
        for (const id of freshEnRepartoIds) next.delete(id)
        return next
      })
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

  // ── Órdenes SD filtradas por zona ─────────────────────────────────────────

  // Solo órdenes SD sin tracking EFI: el mensajero local nunca maneja guías de courier.
  // Órdenes con tracking_number pertenecen al flujo EFI y no al despacho local SD.
  const sdEnReparto = useMemo(
    () => allEnReparto.filter(o =>
      isSantoDomingoOrder(o.city, o.province, o.customer_address) && !o.tracking_number,
    ),
    [allEnReparto],
  )

  const sdNuevos = useMemo(() => {
    const enRepartoIds = new Set(allEnReparto.map(o => o.id))
    return allNuevos.filter(o =>
      isSantoDomingoOrder(o.city, o.province, o.customer_address) &&
      !enRepartoIds.has(o.id) &&
      !o.tracking_number,  // excluir órdenes EFI del flujo SD local
    )
  }, [allNuevos, allEnReparto])

  // SD orders confirmed by client but not yet dispatched by admin.
  // DB state: confirmation_status='confirmed', tracking_number=NULL, normalized_status≠en_reparto.
  // Needed because after refresh these orders aren't in sdNuevos (pending) nor sdEnReparto.
  const sdPendingDispatch = useMemo(() => {
    const enRepartoIds = new Set(allEnReparto.map(o => o.id))
    const terminal     = new Set(['delivered', 'returned', 'cancelled'])
    return allConfirmedPending.filter(o =>
      isSantoDomingoOrder(o.city, o.province, o.customer_address) &&
      !o.tracking_number &&
      !enRepartoIds.has(o.id) &&
      !terminal.has(o.normalized_status ?? '')
    )
  }, [allConfirmedPending, allEnReparto])

  const deliveredDbIds = useMemo(
    () => new Set(deliveredDb.map(e => e.order.id)),
    [deliveredDb],
  )

  const sdDeliveredDb = useMemo(
    () => deliveredDb.filter(e =>
      isSantoDomingoOrder(e.order.city, e.order.province, e.order.customer_address),
    ),
    [deliveredDb],
  )

  // ── Pooled orders (activos, no entregados en DB) ───────────────────────────

  const allPooled = useMemo((): PooledOrder[] => {
    const confirmedPool: PooledOrder[] = sdEnReparto
      .filter(o => actionMap[o.id] !== 'delivered' && actionMap[o.id] !== 'customer_declined' && !deliveredDbIds.has(o.id))
      .map(o => ({ order: o, pool: 'confirmado' as OrderPool }))
    const nuevosPool: PooledOrder[] = sdNuevos
      .filter(o => actionMap[o.id] !== 'delivered' && actionMap[o.id] !== 'customer_declined' && !deliveredDbIds.has(o.id))
      .map(o => ({ order: o, pool: 'nuevo' as OrderPool }))

    const enRepartoIds       = new Set(sdEnReparto.map(o => o.id))
    const nuevosIds          = new Set(sdNuevos.map(o => o.id))
    const pendingDispatchIds = new Set(sdPendingDispatch.map(o => o.id))

    // DB-confirmed SD orders (client confirmed, admin hasn't dispatched yet).
    // actionMap is seeded with 'client_confirmed' for these in fetchData, so
    // computeDisplayState returns 'espera_despacho' after page refresh/deploy.
    const pendingDispatchPool: PooledOrder[] = sdPendingDispatch
      .filter(o => actionMap[o.id] !== 'delivered' && actionMap[o.id] !== 'customer_declined' && !deliveredDbIds.has(o.id))
      .map(o => ({ order: o, pool: 'nuevo' as OrderPool }))

    // Locally-confirmed orders not yet reflected in DB; exclude ones already in pendingDispatchPool.
    const cachedPool: PooledOrder[] = Array.from(confirmedOrderCache.values())
      .filter(o =>
        !enRepartoIds.has(o.id) && !nuevosIds.has(o.id) &&
        !pendingDispatchIds.has(o.id) &&
        actionMap[o.id] !== 'delivered' && actionMap[o.id] !== 'customer_declined' && !deliveredDbIds.has(o.id),
      )
      .map(o => ({ order: o, pool: 'nuevo' as OrderPool }))

    return [...nuevosPool, ...pendingDispatchPool, ...cachedPool, ...confirmedPool]
  }, [sdEnReparto, sdNuevos, sdPendingDispatch, confirmedOrderCache, actionMap, deliveredDbIds])

  // ── Filtro de fecha ────────────────────────────────────────────────────────

  const filteredPooled = useMemo(() => {
    if (dateFilter === 'todos') return allPooled
    const check          = dateFilter === 'hoy' ? isToday : isYesterday
    const pendingIds     = new Set(sdPendingDispatch.map(o => o.id))
    return allPooled.filter(({ order, pool }) => {
      // Recién confirmadas localmente: bypass para evitar que el filtro de fecha las oculte.
      if (confirmedOrderCache.has(order.id)) return true
      // DB-confirmed pending dispatch: siempre visibles (cliente confirmó, admin no ha despachado).
      if (pendingIds.has(order.id)) return true
      const ts = pool === 'nuevo'
        ? order.created_at
        : (order.status_since ?? order.last_tracking_update ?? order.updated_at)
      return check(ts)
    })
  }, [allPooled, dateFilter, confirmedOrderCache, sdPendingDispatch])

  // ── Listas por displayState — invariante de fuente de datos preservada ─────
  // Nuevo/espera_despacho respetan el filtro de fecha; en_ruta/no_responde/
  // reprogramado/confirmado_listo son inmunes (ver CLAUDE.md, sesiones 4/5/9).

  const nuevosList = useMemo(
    () => filteredPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], false) === 'nuevo',
    ),
    [filteredPooled, actionMap],
  )

  const confirmadosList = useMemo(
    () => filteredPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], false) === 'espera_despacho',
    ),
    [filteredPooled, actionMap],
  )

  const enRutaList = useMemo(
    () => allPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], false) === 'en_ruta',
    ),
    [allPooled, actionMap],
  )

  const noRespondenList = useMemo(
    () => allPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], false) === 'no_responde',
    ),
    [allPooled, actionMap],
  )

  const reprogramadosList = useMemo(
    () => allPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], false) === 'reprogramado',
    ),
    [allPooled, actionMap],
  )

  const rutasList = useMemo(
    () => allPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], deliveredDbIds.has(order.id)) === 'confirmado_listo',
    ),
    [allPooled, actionMap, deliveredDbIds],
  )

  // Unión de todas las listas activas — es exactamente lo mismo que se mostraba
  // antes repartido en 4 tabs + subfiltros, ahora presentado en una sola vista
  // agrupada por zona ("Mi Ruta").
  const activeList = useMemo(
    () => [...nuevosList, ...confirmadosList, ...rutasList, ...enRutaList, ...noRespondenList, ...reprogramadosList],
    [nuevosList, confirmadosList, rutasList, enRutaList, noRespondenList, reprogramadosList],
  )

  const searchedActiveList = useMemo(() => {
    if (!searchQuery.trim()) return activeList
    const q = searchQuery.toLowerCase()
    return activeList.filter(({ order }) => matchesQuery(order, q))
  }, [activeList, searchQuery])

  // Orden de prioridad dentro de cada zona: en_ruta primero, confirmado_listo después,
  // el resto (nuevo/no_responde/reprogramado/espera_despacho) al final. Dentro de cada
  // grupo, el que lleva más tiempo esperando va primero. Heurística simple (sin GPS,
  // sin IA) — el mismo lugar donde más adelante entraría un ranking real de Delivery
  // Copilot sin tener que tocar el resto de la pantalla.
  const prioritizedActiveList = useMemo(() => {
    return [...searchedActiveList].sort((a, b) => {
      const dsA = computeDisplayState(a.pool, actionMap[a.order.id], false)
      const dsB = computeDisplayState(b.pool, actionMap[b.order.id], false)
      const tierDiff = actionPriorityTier(dsA) - actionPriorityTier(dsB)
      if (tierDiff !== 0) return tierDiff
      const waitA = Date.now() - orderDateMs(a.order, a.pool)
      const waitB = Date.now() - orderDateMs(b.order, b.pool)
      return waitB - waitA
    })
  }, [searchedActiveList, actionMap])

  // Zonas ordenadas por prioridad operativa: zonas con trabajo actuable ahora
  // (en_ruta/confirmado_listo) primero, zonas donde solo quedan llamadas pendientes
  // al final. group.items[0] ya es el pedido de mayor prioridad de esa zona porque
  // prioritizedActiveList llega pre-ordenado (el orden se preserva al agrupar).
  const zoneGroups = useMemo(() => {
    const groups = groupPooledByZone(prioritizedActiveList)
    const zoneTier = (g: PooledZoneGroup) => g.items.length
      ? actionPriorityTier(computeDisplayState(g.items[0].pool, actionMap[g.items[0].order.id], false))
      : 2
    return [...groups].sort((a, b) => {
      const tierDiff = zoneTier(a) - zoneTier(b)
      if (tierDiff !== 0) return tierDiff
      return b.items.length - a.items.length
    })
  }, [prioritizedActiveList, actionMap])

  // "Próxima parada": el pedido de mayor prioridad de todo el día, pero solo si es
  // una parada real (en_ruta/confirmado_listo) — no tiene sentido destacar una llamada
  // pendiente como "parada".
  const proximaParadaId = useMemo(() => {
    const top = prioritizedActiveList[0]
    if (!top) return null
    const ds = computeDisplayState(top.pool, actionMap[top.order.id], false)
    return (ds === 'en_ruta' || ds === 'confirmado_listo') ? top.order.id : null
  }, [prioritizedActiveList, actionMap])

  // ── Incidencias (cancelado / customer_declined) — solo para Historial ─────
  const canceladoPool = useMemo((): PooledOrder[] => {
    const fromConfirmado: PooledOrder[] = sdEnReparto
      .filter(o => actionMap[o.id] === 'customer_declined')
      .map(o => ({ order: o, pool: 'confirmado' as OrderPool }))
    const fromNuevo: PooledOrder[] = sdNuevos
      .filter(o => actionMap[o.id] === 'customer_declined')
      .map(o => ({ order: o, pool: 'nuevo' as OrderPool }))
    const fromPendingDispatch: PooledOrder[] = sdPendingDispatch
      .filter(o => actionMap[o.id] === 'customer_declined')
      .map(o => ({ order: o, pool: 'nuevo' as OrderPool }))
    const seenIds = new Set([...fromConfirmado, ...fromNuevo, ...fromPendingDispatch].map(p => p.order.id))
    const fromCache: PooledOrder[] = Array.from(confirmedOrderCache.values())
      .filter(o => actionMap[o.id] === 'customer_declined' && !seenIds.has(o.id))
      .map(o => ({ order: o, pool: 'nuevo' as OrderPool }))
    return [...fromConfirmado, ...fromNuevo, ...fromPendingDispatch, ...fromCache]
  }, [sdEnReparto, sdNuevos, sdPendingDispatch, confirmedOrderCache, actionMap])

  const incidenciasList = useMemo(
    () => canceladoPool.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], deliveredDbIds.has(order.id)) === 'cancelado',
    ),
    [canceladoPool, actionMap, deliveredDbIds],
  )

  // ── Entregados ─────────────────────────────────────────────────────────────

  const sessionDelivered = useMemo(() => {
    const allSdIds = new Set([
      ...sdEnReparto.map(o => o.id),
      ...sdNuevos.map(o => o.id),
      ...sdPendingDispatch.map(o => o.id),
    ])
    return Array.from(allSdIds)
      .filter(id => actionMap[id] === 'delivered' && !deliveredDbIds.has(id))
      .flatMap(id => {
        const o = sdEnReparto.find(x => x.id === id)
          ?? sdNuevos.find(x => x.id === id)
          ?? sdPendingDispatch.find(x => x.id === id)
        if (!o) return []
        return [{ order: o, reported_at: new Date().toISOString(), local_confirmed: true }]
      })
  }, [sdEnReparto, sdNuevos, sdPendingDispatch, actionMap, deliveredDbIds])

  const allDelivered = useMemo(
    () => [...sdDeliveredDb, ...sessionDelivered],
    [sdDeliveredDb, sessionDelivered],
  )

  const entregadosFiltrados = useMemo(() => {
    if (dateFilter === 'todos') return allDelivered
    if (dateFilter === 'hoy')   return allDelivered.filter(e => isToday(e.reported_at))
    return allDelivered.filter(e => isYesterday(e.reported_at))
  }, [allDelivered, dateFilter])

  // ── Dinero (Fase A: presentación únicamente, sin persistencia nueva) ──────
  // Comisión "real" por zona (reemplaza el promedio plano SD_TARIFA_PROMEDIO).
  const gananciasHoyReal = useMemo(
    () => allDelivered
      .filter(e => isToday(e.reported_at))
      .reduce((sum, e) => sum + detectSdZone(e.order.city, e.order.province, e.order.customer_address).tarifa, 0),
    [allDelivered],
  )

  const codPendiente = useMemo(
    () => activeList.reduce((sum, { order }) => sum + (order.cod_amount ?? 0), 0),
    [activeList],
  )

  const codCobradoHoy = useMemo(
    () => allDelivered
      .filter(e => isToday(e.reported_at))
      .reduce((sum, e) => sum + (e.order.cod_amount ?? 0), 0),
    [allDelivered],
  )

  // ── Historial combinado (entregados + no desea) ────────────────────────────

  const historialAll = useMemo(() => {
    const entregados = entregadosFiltrados.map(e => ({
      order: e.order, kind: 'entregado' as const, at: e.reported_at,
    }))
    const declinados = incidenciasList.map(({ order }) => ({
      order, kind: 'no_desea' as const, at: order.status_since ?? order.updated_at,
    }))
    return [...entregados, ...declinados].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    )
  }, [entregadosFiltrados, incidenciasList])

  const historialFiltrado = useMemo(() => {
    if (!searchQuery.trim()) return historialAll
    const q = searchQuery.toLowerCase()
    return historialAll.filter(({ order }) => matchesQuery(order, q))
  }, [historialAll, searchQuery])

  const historialTotalPages = Math.ceil(historialFiltrado.length / PAGE_SIZE)
  const historialPaged = useMemo(
    () => historialFiltrado.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [historialFiltrado, currentPage],
  )

  useEffect(() => { setCurrentPage(1) }, [view, dateFilter, searchQuery])

  // ── Toast ─────────────────────────────────────────────────────────────────

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3000)
  }

  // ── Acciones (sin cambios respecto a la versión anterior) ──────────────────

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

  async function confirmRoute(orderId: string, silent = false): Promise<boolean> {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      const res = await fetch(`/api/orders/${orderId}/actions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          action_type: 'route_confirmed',
          notes:       'Mensajero confirmó salida a ruta',
        }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        console.error(`[confirmRoute] order=${orderId} status=${res.status}`, errBody)
        if (!silent) showToast('Error al confirmar ruta', false)
        return false
      }
      setActionMap(prev => ({ ...prev, [orderId]: 'route_confirmed' }))
      if (!silent) {
        showToast('✓ Ruta confirmada — ya puedes marcar entregado', true)
        fetch('/api/sd-delivery/performance').then(r => r.json()).then(setPerf).catch(() => null)
      }
      return true
    } catch (err) {
      console.error(`[confirmRoute] network error order=${orderId}`, err)
      if (!silent) showToast('Error de red', false)
      return false
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  async function confirmClient(orderId: string) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      const res = await fetch(`/api/sd-delivery/orders/${orderId}/confirm-client`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        showToast(body.error ?? 'Error al registrar confirmación', false)
        return
      }
      setActionMap(prev => ({ ...prev, [orderId]: 'client_confirmed' }))
      // Cache the order so it stays visible in Confirmados/Listos even after the next fetch
      // (the order leaves sdNuevos once confirmation_status changes, before admin dispatches it)
      const orderToCache = sdNuevos.find(o => o.id === orderId)
      if (orderToCache) setConfirmedOrderCache(prev => new Map(prev).set(orderId, orderToCache))
      showToast('✓ Cliente confirmado — el admin asignará a ruta', true)
      fetch('/api/sd-delivery/performance').then(r => r.json()).then(setPerf).catch(() => null)
    } catch {
      showToast('Error de red', false)
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
      fetch('/api/sd-delivery/performance').then(r => r.json()).then(setPerf).catch(() => null)
    } catch {
      showToast('Error de red', false)
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  async function confirmZoneRoute(zoneId: string, orderIds: string[]) {
    const pending = orderIds.filter(id => !loadingRow[id])

    if (pending.length === 0) {
      showToast(`Sin pedidos pendientes en ${zoneId}`, false)
      return
    }

    let ok = 0
    for (const id of pending) {
      const success = await confirmRoute(id, true)
      if (success) ok++
    }

    if (ok === pending.length) {
      showToast(`✓ Ruta ${zoneId} iniciada — ${ok} pedido${ok !== 1 ? 's' : ''}`, true)
    } else if (ok > 0) {
      showToast(`Ruta ${zoneId}: ${ok} de ${pending.length} iniciados — ${pending.length - ok} fallaron`, true)
    } else {
      showToast(`Error al iniciar ruta ${zoneId} — verifica migración 026 en Supabase`, false)
    }
    fetch('/api/sd-delivery/performance').then(r => r.json()).then(setPerf).catch(() => null)
  }

  async function saveNote(orderId: string, note: string) {
    await postAction(orderId, 'note_added', 'note_added', undefined, note)
    showToast('Nota guardada', true)
  }

  async function saveReprogramar(orderId: string, note: string) {
    await postAction(orderId, 'rescheduled', 'rescheduled', undefined, note)
    showToast('Reprogramado registrado', true)
  }

  async function saveCustomerDeclined(orderId: string) {
    await postAction(orderId, 'customer_declined', 'customer_declined')
    showToast('Pedido marcado como "No desea" — retirado del flujo activo', true)
  }

  async function dispatchLocal(orderId: string) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      const res = await fetch(`/api/orders/${orderId}/dispatch-local`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        showToast(body.error ?? 'Error al despachar', false)
        return
      }
      showToast('✓ Despachado — pedido pasa a Rutas', true)
      await fetchData()
    } catch {
      showToast('Error de red al despachar', false)
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  function openMas(order: Order, pool: OrderPool) {
    setMasSheet({
      orderId: order.id,
      name:    order.customer_name ?? '',
      ds:      computeDisplayState(pool, actionMap[order.id], false),
      pool,
    })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 pb-[env(safe-area-inset-bottom,_0px)]">

      {/* ── Toast flotante ── */}
      {toast && (
        <div className={`fixed left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg
          text-sm font-semibold text-white transition-all
          bottom-[calc(env(safe-area-inset-bottom,_0px)_+_24px)]
          ${toast.ok ? 'bg-teal-600' : 'bg-red-600'}`}>
          {toast.msg}
        </div>
      )}

      {/* ── Modales ── */}
      {noteModal && (
        <NoteModal
          orderId={noteModal.orderId}
          name={noteModal.name}
          title={noteModal.mode === 'direccion' ? 'Dirección incorrecta' : 'Agregar nota'}
          placeholder={noteModal.mode === 'direccion'
            ? 'Describe la dirección correcta o el problema encontrado…'
            : 'Ej: Cliente fuera, reprogramar para mañana tarde…'}
          notePrefix={noteModal.mode === 'direccion' ? 'Dirección incorrecta: ' : undefined}
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
      {masSheet && (
        <MasSheet
          ctx={masSheet}
          onClose={() => setMasSheet(null)}
          onNoAnswer={id => postAction(id, 'no_answer', 'contacted', 'no_answer')}
          onReprogramar={(id, name) => setReModal({ orderId: id, name })}
          onDeclinado={id => saveCustomerDeclined(id)}
          onDireccionIncorrecta={(id, name) => setNoteModal({ orderId: id, name, mode: 'direccion' })}
          onOtroMotivo={(id, name) => setNoteModal({ orderId: id, name, mode: 'nota' })}
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
              <div className="flex items-center gap-2 md:gap-3 flex-wrap">
                <h1 className="text-xl md:text-2xl font-black text-white tabular-nums">
                  {loading ? '…' : activeList.length.toLocaleString()}
                </h1>
                {!loading && nuevosList.length > 0 && (
                  <span className="flex items-center gap-1.5 bg-blue-500/80 text-white
                                   text-xs font-bold px-2.5 py-1 rounded-full">
                    <Clock className="w-3 h-3" />
                    {nuevosList.length} por confirmar
                  </span>
                )}
                {!loading && nuevosList.filter(({ order }) => criticalityLabel(order) === 'critico').length > 0 && (
                  <span className="flex items-center gap-1.5 bg-red-500/80 text-white
                                   text-xs font-bold px-2.5 py-1 rounded-full animate-pulse">
                    <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    {nuevosList.filter(({ order }) => criticalityLabel(order) === 'critico').length} CRÍTICO
                    {nuevosList.filter(({ order }) => criticalityLabel(order) === 'critico').length !== 1 ? 'S' : ''}
                  </span>
                )}
              </div>
              <p className="text-white font-semibold text-sm md:text-base">Mi Ruta — Santo Domingo</p>
              <p className="hidden md:block text-teal-100 text-xs mt-0.5">
                Zona Gran Santo Domingo · Transporte local
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 md:gap-4 shrink-0">
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

      {/* ── Resumen del día — solo lo que ayuda a trabajar hoy, sin conteos de estados internos ── */}
      {perf && (
        <div className="bg-white rounded-xl border border-gray-200 px-3 py-2.5 md:px-5 md:py-3.5 shadow-sm space-y-2">
          <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-700">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span className="text-sm font-black tabular-nums leading-none">{perf.entregadosHoy}</span>
              <span className="text-[11px] font-medium">entregados</span>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-orange-50 text-orange-700 border border-orange-100">
              <Wallet className="w-3.5 h-3.5" />
              <span className="text-sm font-black tabular-nums leading-none">RD${codPendiente.toLocaleString('es-DO')}</span>
              <span className="text-[11px] font-medium">por cobrar</span>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100">
              <DollarSign className="w-3.5 h-3.5" />
              <span className="text-sm font-black tabular-nums leading-none">RD${codCobradoHoy.toLocaleString('es-DO')}</span>
              <span className="text-[11px] font-medium">cobrado hoy</span>
            </div>
            {gananciasHoyReal > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-teal-600 text-white">
                <DollarSign className="w-3.5 h-3.5" />
                <span className="text-sm font-black tabular-nums leading-none">RD${gananciasHoyReal.toLocaleString('es-DO')}</span>
                <span className="text-[11px] font-medium">comisión hoy</span>
              </div>
            )}
          </div>

          {/* Barra meta diaria — siempre visible desde 0/8, no solo tras la primera entrega:
              una meta que aparece a mitad del día no motiva a empezarlo. */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-gray-400 font-medium">Meta del día</span>
              <span className="text-gray-600 font-bold tabular-nums">
                {perf.entregadosHoy}/{SD_META_DIARIA}
              </span>
            </div>
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-1.5 bg-teal-500 rounded-full transition-all duration-700"
                style={{ width: `${Math.min((perf.entregadosHoy / SD_META_DIARIA) * 100, 100)}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Barra de control única: buscar · fecha · Historial ── */}
      {/* "Mi Ruta" es la pantalla por defecto (no compite visualmente con Historial):
          Historial es un destino secundario al que se entra con un tap, no un tab paralelo. */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSearchOpen(o => !o)}
            className={`flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg transition-colors shrink-0
              ${searchOpen ? 'bg-teal-600 text-white' : 'bg-white border border-gray-200 text-gray-500 hover:bg-gray-50'}`}
          >
            <Search className="w-4 h-4" />
          </button>

          <div className="flex bg-gray-100 rounded-lg p-1 gap-0.5 shrink-0">
            {([
              { key: 'hoy',   label: 'Hoy'   },
              { key: 'ayer',  label: 'Ayer'  },
              { key: 'todos', label: 'Todos' },
            ] as { key: DateFilter; label: string }[]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setDateFilter(key)}
                className={`px-3 min-h-[36px] rounded-md text-xs font-semibold transition-colors
                  ${dateFilter === key ? 'bg-white text-teal-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1" />

          <button
            onClick={() => setView(v => v === 'ruta' ? 'historial' : 'ruta')}
            className="flex items-center gap-1.5 px-3 min-h-[44px] rounded-lg text-sm font-semibold
                       text-gray-500 hover:text-teal-700 hover:bg-teal-50 transition-colors shrink-0"
          >
            {view === 'ruta' ? (
              <>
                Historial
                {historialAll.length > 0 && (
                  <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                    {historialAll.length}
                  </span>
                )}
              </>
            ) : (
              <>← Mi Ruta</>
            )}
          </button>
        </div>

        {searchOpen && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <input
              autoFocus
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Buscar por nombre, teléfono, guía, dirección…"
              className="w-full pl-9 pr-9 py-2.5 text-sm border border-gray-200 rounded-lg
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
        )}
      </div>

      {/* ── Spinner ── */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Spinner className="w-6 h-6 text-teal-500" />
        </div>
      )}

      {/* ══════════════════ VISTA: MI RUTA — agrupada por zona ══════════════════ */}
      {!loading && view === 'ruta' && (
        zoneGroups.length === 0 ? (
          <div className="bg-teal-50 border border-teal-200 rounded-xl px-5 py-10 text-center">
            <Package2 className="w-10 h-10 text-teal-400 mx-auto mb-3" />
            <p className="text-teal-700 font-medium">
              {searchQuery ? `Sin resultados para "${searchQuery}"` : 'No hay pedidos pendientes en este momento'}
            </p>
            {!searchQuery && (
              <p className="text-teal-600 text-sm mt-1">
                Los pedidos nuevos y en reparto de Santo Domingo aparecerán aquí, agrupados por zona
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {zoneGroups.map(group => {
              const zc            = ZONE_COLORS[group.zone.id as ZoneId] ?? ZONE_COLORS['otro']
              const isCollapsed   = collapsedZones.has(group.zone.id)
              const readyIds      = group.items
                .filter(({ order, pool }) => computeDisplayState(pool, actionMap[order.id], false) === 'confirmado_listo')
                .map(({ order }) => order.id)
              const anyBusy       = readyIds.some(id => !!loadingRow[id])

              return (
                <div key={group.zone.id} className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
                  {/* Cabecera de zona */}
                  <button
                    onClick={() => setCollapsedZones(prev => {
                      const next = new Set(prev)
                      if (next.has(group.zone.id)) next.delete(group.zone.id)
                      else next.add(group.zone.id)
                      return next
                    })}
                    className={`w-full flex items-center justify-between px-4 py-3 ${zc.bg} hover:brightness-95 transition-all`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Route className={`w-4 h-4 shrink-0 ${zc.text}`} />
                      <div className="min-w-0 text-left">
                        <p className={`font-black text-sm leading-tight ${zc.text}`}>🛵 {group.zone.routeLabel}</p>
                        <p className={`text-[10px] font-medium opacity-70 ${zc.text}`}>{group.zone.label}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <p className={`text-sm font-black tabular-nums ${zc.text}`}>
                          {group.items.length} pedido{group.items.length !== 1 ? 's' : ''}
                        </p>
                        {group.codTotal > 0 && (
                          <p className="text-xs text-gray-500 font-medium">
                            COD RD${group.codTotal.toLocaleString('es-DO')}
                          </p>
                        )}
                      </div>
                      {isCollapsed ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronUp className="w-4 h-4 text-gray-400" />}
                    </div>
                  </button>

                  {!isCollapsed && (
                    <div className="border-t border-gray-100">
                      {readyIds.length > 0 && (
                        <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between gap-3">
                          <span className="text-[11px] text-gray-500">
                            {readyIds.length} listo{readyIds.length !== 1 ? 's' : ''} para salir de esta zona
                          </span>
                          <button
                            onClick={() => confirmZoneRoute(group.zone.routeLabel, readyIds)}
                            disabled={anyBusy}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-teal-500 hover:bg-teal-600
                                       active:bg-teal-700 text-white text-xs font-bold transition-colors disabled:opacity-50 shrink-0"
                          >
                            {anyBusy ? <Spinner className="w-3.5 h-3.5 text-white" /> : <Truck className="w-3.5 h-3.5" />}
                            Iniciar ruta de zona
                          </button>
                        </div>
                      )}
                      <div className="p-3 space-y-2.5">
                        {group.items.map(({ order, pool }) => (
                          <SdCard
                            key={order.id}
                            order={order}
                            pool={pool}
                            accion={actionMap[order.id]}
                            busy={!!loadingRow[order.id]}
                            isProximaParada={order.id === proximaParadaId}
                            onAbrirConversacion={() => postAction(order.id, 'contacted', 'contacted')}
                            onLlamar={() => postAction(order.id, 'contacted', 'contacted')}
                            onClienteConfirma={() => confirmClient(order.id)}
                            onConfirmarRuta={() => confirmRoute(order.id)}
                            onDespacharLocal={() => dispatchLocal(order.id)}
                            onMarcarEntregado={() => markDelivered(order.id)}
                            onVolverARuta={() => confirmRoute(order.id)}
                            onAbrirMas={() => openMas(order, pool)}
                            reprogramadoMeta={reprogramadoMeta[order.id]}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      )}

      {/* ══════════════════ VISTA: HISTORIAL ══════════════════ */}
      {!loading && view === 'historial' && (
        <div className="bg-white rounded-xl border-2 border-teal-200 overflow-hidden shadow-sm">
          {historialPaged.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <Package2 className="w-10 h-10 text-gray-200 mx-auto mb-3" />
              <p className="text-gray-500 font-medium">
                {searchQuery ? `Sin resultados para "${searchQuery}"` : 'Aún no hay pedidos cerrados'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {historialPaged.map(({ order, kind, at }) => (
                <HistorialRow key={`${order.id}-${kind}`} order={order} kind={kind} at={at} />
              ))}
            </div>
          )}

          {historialTotalPages > 1 && (
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
                <span className="font-bold text-gray-800">{currentPage}</span>
                {' / '}
                <span className="font-bold text-gray-800">{historialTotalPages}</span>
                <span className="hidden md:inline text-gray-400"> · {historialFiltrado.length} resultados</span>
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(historialTotalPages, p + 1))}
                disabled={currentPage === historialTotalPages}
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

    </div>
  )
}
