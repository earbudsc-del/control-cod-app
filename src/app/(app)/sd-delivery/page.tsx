'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Spinner } from '@/components/ui/spinner'
import { whatsAppUrl, callUrl } from '@/lib/utils'
import { isSantoDomingoOrder } from '@/lib/alert-helpers'
import { groupOrdersByZone, SD_META_DIARIA, SD_TARIFA_PROMEDIO, ZONE_COLORS } from '@/lib/sd-zones'
import type { ZoneId } from '@/lib/sd-zones'
import type { Order } from '@/types'
import {
  MapPin, RefreshCw, MessageCircle, Phone,
  CheckCircle2, PhoneMissed, ExternalLink,
  Search, TrendingUp, Package2,
  CalendarDays, RotateCcw, FileText, X,
  ChevronLeft, ChevronRight, Truck, Navigation,
  UserCheck, Clock, Route, DollarSign, ChevronDown, ChevronUp,
} from 'lucide-react'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type Tab        = 'nuevos' | 'confirmados' | 'en_ruta' | 'no_responden' | 'reprogramados' | 'entregados' | 'rutas'
type DateFilter = 'hoy' | 'ayer' | 'todos'
type OrderPool  = 'nuevo' | 'confirmado'
type LocalAccion = string | undefined

// Estados de visualización del card
type DisplayState =
  | 'nuevo'            // pool=nuevo, sin acción (necesita confirmación)
  | 'espera_despacho'  // pool=nuevo, client_confirmed (admin debe despachar)
  | 'confirmado_listo' // pool=confirmado, sin route_confirmed
  | 'en_ruta'          // pool=confirmado, route_confirmed
  | 'no_responde'      // no_answer (cualquier pool)
  | 'reprogramado'     // rescheduled (cualquier pool)
  | 'entregado'
  | 'cancelado'        // customer_declined — excluido de todos los tabs activos

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
  const h    = horasEnReparto(order)
  const dias = Math.floor(h / 24)
  const hrs  = Math.floor(h % 24)
  if (h < 1)      return 'Hace menos de 1h'
  if (h < 24)     return `Hace ${Math.floor(h)}h`
  if (dias === 1)  return hrs > 0 ? `Hace 1d ${hrs}h` : 'Hace 1 día'
  return hrs > 0 ? `Hace ${dias}d ${hrs}h` : `Hace ${dias} días`
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

function computeTab(state: DisplayState): Tab {
  if (state === 'nuevo')            return 'nuevos'
  if (state === 'espera_despacho')  return 'confirmados'
  if (state === 'confirmado_listo') return 'confirmados'
  if (state === 'en_ruta')          return 'en_ruta'
  if (state === 'no_responde')      return 'no_responden'
  if (state === 'reprogramado')     return 'reprogramados'
  return 'entregados'
}

const PAGE_SIZE = 40

// ── Modales ───────────────────────────────────────────────────────────────────

interface NoteModalProps {
  orderId: string
  name:    string
  onSave:  (orderId: string, note: string) => Promise<void>
  onClose: () => void
}

function NoteModal({ orderId, name, onSave, onClose }: NoteModalProps) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

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

// ── Card móvil ────────────────────────────────────────────────────────────────

interface SdCardProps {
  order:             Order
  pool:              OrderPool
  accion:            LocalAccion
  busy:              boolean
  isDelivered:       boolean
  onWA:              () => void
  onLlamar:          () => void
  onConfirmarRuta:   () => void
  onClienteConfirma: () => void
  onNoAnswer:        () => void
  onEntregado:       () => void
  onReprogramar:     () => void
  onNota:            () => void
  onDeclinado:       () => void
  onDispatchLocal:   () => void
}

function SdCard({
  order, pool, accion, busy, isDelivered,
  onWA, onLlamar, onConfirmarRuta, onClienteConfirma, onNoAnswer, onEntregado, onReprogramar, onNota, onDeclinado, onDispatchLocal,
}: SdCardProps) {
  const nombre  = order.customer_name ?? ''
  const waMsg   = pool === 'nuevo'
    ? buildWaMsgNuevo(nombre, order.product_summary)
    : buildWaMsg(nombre, order.product_summary)
  const waUrl    = whatsAppUrl(order.customer_phone, waMsg)
  const telUrl   = callUrl(order.customer_phone)
  const hasPhone = !!order.customer_phone
  const crit     = criticalityLabel(order)
  const ds       = computeDisplayState(pool, accion, isDelivered)

  const ubicacion = order.city
    || order.province
    || (order.customer_address ? order.customer_address.slice(0, 24) : null)

  const cardBg =
    ds === 'entregado'        ? 'bg-green-50/40'
    : ds === 'en_ruta'        ? 'bg-teal-50/30'
    : ds === 'nuevo'          ? 'bg-blue-50/30'
    : ds === 'espera_despacho'? 'bg-purple-50/20'
    : ds === 'reprogramado'   ? 'bg-orange-50/30'
    : crit === 'critico'      ? 'bg-red-50/20'
    : crit === 'riesgo'       ? 'bg-orange-50/20'
    : 'bg-white'

  return (
    <div className={`p-4 border-b border-teal-100 ${cardBg}`}>

      {/* Cabecera: identificador + badge de estado */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-bold text-gray-900 truncate">
            {order.tracking_number ?? order.order_number ?? '—'}
          </p>
          {order.tracking_number && order.order_number && (
            <p className="font-mono text-[10px] text-gray-400 mt-0.5">{order.order_number}</p>
          )}
          {(() => { const { relative, absolute } = formatOrderDate(order, pool); return (
            <p className="text-[10px] text-gray-400 mt-0.5" title={absolute}>
              <span className="font-medium">{relative}</span>
              <span className="ml-1 opacity-70">· {absolute}</span>
            </p>
          ); })()}
        </div>
        {ds === 'entregado' && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700 shrink-0">
            <CheckCircle2 className="inline w-3 h-3 mr-0.5" />Entregado
          </span>
        )}
        {ds === 'en_ruta' && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 shrink-0">
            <Navigation className="inline w-3 h-3 mr-0.5" />En ruta
          </span>
        )}
        {ds === 'no_responde' && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 shrink-0">
            <PhoneMissed className="inline w-3 h-3 mr-0.5" />No responde
            {pool === 'nuevo' && <span className="ml-1 opacity-70">· pendiente conf.</span>}
          </span>
        )}
        {ds === 'reprogramado' && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 shrink-0">
            <RotateCcw className="inline w-3 h-3 mr-0.5" />Reprogramado
          </span>
        )}
        {ds === 'nuevo' && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 shrink-0">
            <Clock className="inline w-3 h-3 mr-0.5" />Por confirmar
          </span>
        )}
        {ds === 'espera_despacho' && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 shrink-0">
            <UserCheck className="inline w-3 h-3 mr-0.5" />Listo · esperando despacho
          </span>
        )}
        {ds === 'confirmado_listo' && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0
            ${crit === 'critico' ? 'bg-red-100 text-red-700 animate-pulse'
              : crit === 'riesgo'  ? 'bg-orange-100 text-orange-700'
              : 'bg-gray-100 text-gray-500'}`}>
            {tiempoLabel(order)}
          </span>
        )}
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

      {/* Producto — visible para nuevos */}
      {ds === 'nuevo' && order.product_summary && (
        <p className="text-xs text-blue-700 font-medium mt-1 truncate" title={order.product_summary}>
          📦 {order.product_summary.slice(0, 55)}
        </p>
      )}

      {/* Ubicación */}
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

      {order.delivery_attempts > 0 && ds !== 'entregado' && (
        <p className="text-[11px] text-amber-600 font-medium mt-1">
          {order.delivery_attempts} intento{order.delivery_attempts > 1 ? 's' : ''} previos
        </p>
      )}

      {/* WA + Llamar — visibles excepto entregado y espera_despacho */}
      {hasPhone && ds !== 'entregado' && ds !== 'espera_despacho' && !busy && (
        <div className="flex gap-2 mt-3">
          {waUrl && (
            <a href={waUrl} target="_blank" rel="noopener noreferrer" onClick={onWA}
               className="flex-1 flex items-center justify-center gap-1.5
                          bg-green-500 text-white py-2.5 rounded-xl text-sm font-semibold
                          active:bg-green-700 transition-colors">
              <MessageCircle className="w-4 h-4" />WhatsApp
            </a>
          )}
          {telUrl && (
            <a href={telUrl} onClick={onLlamar}
               className="flex-1 flex items-center justify-center gap-1.5
                          bg-blue-500 text-white py-2.5 rounded-xl text-sm font-semibold
                          active:bg-blue-700 transition-colors">
              <Phone className="w-4 h-4" />Llamar
            </a>
          )}
        </div>
      )}

      {/* Acciones según displayState */}
      <div className="mt-3">
        {ds === 'entregado' ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold
                           px-3 py-1.5 rounded-full bg-green-100 text-green-700">
            <CheckCircle2 className="w-3.5 h-3.5" />Entregado — registrado
          </span>

        ) : busy ? (
          <Spinner className="w-5 h-5 text-teal-500" />

        ) : ds === 'nuevo' ? (
          <div className="space-y-2">
            <button
              onClick={onClienteConfirma}
              className="w-full flex items-center justify-center gap-2
                         bg-blue-600 active:bg-blue-700 text-white
                         text-sm font-bold py-3.5 min-h-[52px] rounded-xl transition-colors">
              <UserCheck className="w-5 h-5" />Cliente confirma
            </button>
            <button onClick={onNoAnswer}
              className="w-full flex items-center justify-center gap-1.5
                         bg-amber-100 active:bg-amber-200 text-amber-700
                         text-sm font-medium py-3 min-h-[44px] rounded-xl transition-colors">
              <PhoneMissed className="w-4 h-4" />No responde
            </button>
          </div>

        ) : ds === 'espera_despacho' ? (
          <button
            onClick={onDispatchLocal}
            className="w-full flex items-center justify-center gap-2
                       bg-indigo-600 active:bg-indigo-700 text-white
                       text-sm font-bold py-3.5 min-h-[52px] rounded-xl transition-colors">
            <Truck className="w-5 h-5" />Despachar local
          </button>

        ) : ds === 'confirmado_listo' ? (
          <div className="space-y-2">
            <button
              onClick={onConfirmarRuta}
              className="w-full flex items-center justify-center gap-2
                         bg-teal-500 active:bg-teal-600 text-white
                         text-sm font-bold py-3.5 min-h-[52px] rounded-xl transition-colors">
              <Truck className="w-5 h-5" />Confirmar ruta
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={onNoAnswer}
                className="flex items-center justify-center gap-1.5
                           bg-amber-100 active:bg-amber-200 text-amber-700
                           text-sm font-medium py-3 min-h-[44px] rounded-xl transition-colors">
                <PhoneMissed className="w-4 h-4" />No responde
              </button>
              <button onClick={onNota}
                className="flex items-center justify-center gap-1.5
                           bg-gray-100 active:bg-gray-200 text-gray-600
                           text-sm font-medium py-3 min-h-[44px] rounded-xl transition-colors">
                <FileText className="w-4 h-4" />Nota
              </button>
            </div>
          </div>

        ) : ds === 'en_ruta' ? (
          <div className="space-y-2">
            <button
              onClick={onEntregado}
              className="w-full flex items-center justify-center gap-2
                         bg-emerald-500 active:bg-emerald-600 text-white
                         text-sm font-bold py-3.5 min-h-[52px] rounded-xl transition-colors">
              <CheckCircle2 className="w-5 h-5" />Marcar entregado
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={onNoAnswer}
                className="flex items-center justify-center gap-1
                           bg-amber-100 active:bg-amber-200 text-amber-700
                           text-xs font-medium py-3 min-h-[44px] rounded-xl transition-colors">
                <PhoneMissed className="w-3.5 h-3.5" /><span>No resp.</span>
              </button>
              <button onClick={onReprogramar}
                className="flex items-center justify-center gap-1
                           bg-indigo-100 active:bg-indigo-200 text-indigo-700
                           text-xs font-medium py-3 min-h-[44px] rounded-xl transition-colors">
                <RotateCcw className="w-3.5 h-3.5" /><span>Reprog.</span>
              </button>
              <button onClick={onDeclinado}
                className="flex items-center justify-center gap-1
                           bg-red-100 active:bg-red-200 text-red-700
                           text-xs font-medium py-3 min-h-[44px] rounded-xl transition-colors">
                <X className="w-3.5 h-3.5" /><span>No desea</span>
              </button>
              <button onClick={onNota}
                className="flex items-center justify-center gap-1
                           bg-gray-100 active:bg-gray-200 text-gray-600
                           text-xs font-medium py-3 min-h-[44px] rounded-xl transition-colors">
                <FileText className="w-3.5 h-3.5" /><span>Nota</span>
              </button>
            </div>
          </div>

        ) : ds === 'no_responde' ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold
                               px-3 py-1.5 rounded-full bg-amber-100 text-amber-700">
                <PhoneMissed className="w-3.5 h-3.5" />No responde
                {pool === 'nuevo' && <span className="text-[10px] opacity-70 ml-1">· pendiente conf.</span>}
              </span>
              <button onClick={onNota}
                className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-teal-600 ml-2">
                <FileText className="w-3 h-3" />Nota
              </button>
            </div>
            {pool === 'nuevo' && (
              <button
                onClick={onClienteConfirma}
                className="w-full flex items-center justify-center gap-2
                           bg-blue-100 active:bg-blue-200 text-blue-700
                           text-xs font-semibold py-2.5 rounded-xl transition-colors">
                <UserCheck className="w-3.5 h-3.5" />El cliente llamó y confirma
              </button>
            )}
          </div>
        ) : ds === 'reprogramado' ? (
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold
                             px-3 py-1.5 rounded-full bg-orange-100 text-orange-700">
              <RotateCcw className="w-3.5 h-3.5" />Reprogramado
            </span>
            <button onClick={onNota}
              className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-teal-600 ml-2">
              <FileText className="w-3 h-3" />Nota
            </button>
          </div>
        ) : null}
      </div>

      {/* Ver detalle */}
      <div className="mt-3 flex items-center justify-end">
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

  const [activeTab, setActiveTab]       = useState<Tab>('nuevos')
  const [dateFilter, setDateFilter]     = useState<DateFilter>('hoy')
  const [searchQuery, setSearchQuery]   = useState('')
  const [currentPage, setCurrentPage]   = useState(1)

  const [actionMap, setActionMap]       = useState<Record<string, string>>({})
  const [confirmedOrderCache, setConfirmedOrderCache] = useState<Map<string, Order>>(new Map())
  const [loadingRow, setLoadingRow]     = useState<Record<string, boolean>>({})
  const [noteModal, setNoteModal]       = useState<{ orderId: string; name: string } | null>(null)
  const [reModal, setReModal]           = useState<{ orderId: string; name: string } | null>(null)
  const [toast, setToast]               = useState<{ msg: string; ok: boolean } | null>(null)

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [enRepartoRes, nuevosRes, confirmedRes, deliveredRes, perfRes, routeConfirmedRes, sdActionsRes]:
        [OrdersResponse, OrdersResponse, OrdersResponse, DeliveredEntry[], SdPerfData, { ids: string[], orders: Order[] }, Record<string, 'no_answer' | 'rescheduled' | 'customer_declined'>] =
        await Promise.all([
          fetch('/api/orders?status=en_reparto&limit=500&page=1&sortBy=status_since_asc').then(r => r.json()),
          fetch('/api/orders?confirmationStatus=pending&limit=300').then(r => r.json()),
          fetch('/api/orders?confirmationStatus=confirmed&limit=200').then(r => r.json()),
          fetch('/api/reparto/entregados').then(r => r.json()),
          fetch('/api/sd-delivery/performance').then(r => r.json()),
          fetch('/api/sd-delivery/route-confirmed-ids').then(r => r.json()).catch(() => ({ ids: [], orders: [] })),
          fetch('/api/sd-delivery/sd-actions').then(r => r.json()).catch(() => ({})),
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

      setActionMap(prev => {
        const next = { ...prev }

        // Seed secondary actions (no_answer, rescheduled, customer_declined) from DB.
        // The sd-actions endpoint only returns a secondary action when it is MORE RECENT
        // than route_confirmed for that order, so applying these first is safe:
        // route_confirmed seeding below will not override them (its guard checks next[id]).
        // Terminal states (delivered, client_confirmed) are never overridden.
        const noOverride = new Set(['delivered', 'client_confirmed'])
        for (const [id, secondaryAction] of Object.entries(sdActionsRes)) {
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

  // ── Listas por tab ─────────────────────────────────────────────────────────

  const nuevosList = useMemo(
    () => filteredPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], false) === 'nuevo',
    ),
    [filteredPooled, actionMap],
  )

  // Confirmados/Listos tab: only pre-dispatch orders (client confirmed, admin hasn't dispatched).
  // confirmado_listo orders appear exclusively in Rutas so they visibly leave this tab after dispatch.
  const confirmadosList = useMemo(
    () => filteredPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], false) === 'espera_despacho',
    ),
    [filteredPooled, actionMap],
  )

  // Uses allPooled (not filteredPooled) so orders in-route are always visible regardless of
  // their dispatch date. An order confirmed for route must stay in "En ruta" even if its
  // status_since is from a previous day or the date filter was changed between sessions.
  const enRutaList = useMemo(
    () => allPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], false) === 'en_ruta',
    ),
    [allPooled, actionMap],
  )

  // Uses allPooled (not filteredPooled) so no-response orders persist regardless of date filter,
  // matching the same immunity-from-date-filter guarantee as enRutaList and reprogramadosList.
  const noRespondenList = useMemo(
    () => allPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], false) === 'no_responde',
    ),
    [allPooled, actionMap],
  )

  // Uses allPooled (not filteredPooled) so rescheduled orders persist regardless of date filter,
  // matching the same immunity-from-date-filter guarantee as enRutaList.
  const reprogramadosList = useMemo(
    () => allPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], false) === 'reprogramado',
    ),
    [allPooled, actionMap],
  )

  // Rutas: only confirmado_listo orders — no date filter so all pending routes are visible
  const rutasList = useMemo(
    () => allPooled.filter(({ order, pool }) =>
      computeDisplayState(pool, actionMap[order.id], deliveredDbIds.has(order.id)) === 'confirmado_listo',
    ),
    [allPooled, actionMap, deliveredDbIds],
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

  // ── Conteos ────────────────────────────────────────────────────────────────

  const tabCounts = useMemo(() => ({
    nuevos:        nuevosList.length,
    confirmados:   confirmadosList.length,
    en_ruta:       enRutaList.length,
    no_responden:  noRespondenList.length,
    reprogramados: reprogramadosList.length,
    entregados:    entregadosFiltrados.length,
    rutas:         rutasList.length,
  }), [nuevosList, confirmadosList, enRutaList, noRespondenList, reprogramadosList, entregadosFiltrados, rutasList])

  const totalActive = allPooled.length

  // ── Agrupación por zona ────────────────────────────────────────────────────
  // Only groups confirmado_listo orders — same source as Rutas tab

  const zoneGroups = useMemo(
    () => groupOrdersByZone(rutasList.map(p => p.order)),
    [rutasList],
  )

  // ── Ganancias estimadas hoy ────────────────────────────────────────────────
  // Promedio RD$270 × entregas del día (sdDeliveredDb + sessionDelivered)

  const gananciasHoyEst = useMemo(
    () => allDelivered.filter(e => isToday(e.reported_at)).length * SD_TARIFA_PROMEDIO,
    [allDelivered],
  )

  const [expandedZones, setExpandedZones] = useState<Set<string>>(new Set())

  // ── displayedPooled / displayedEntregados ──────────────────────────────────

  const displayedPooled = useMemo((): PooledOrder[] => {
    let base: PooledOrder[]
    if (activeTab === 'nuevos')           base = nuevosList
    else if (activeTab === 'confirmados')  base = confirmadosList
    else if (activeTab === 'en_ruta')      base = enRutaList
    else if (activeTab === 'no_responden') base = noRespondenList
    else if (activeTab === 'reprogramados') base = reprogramadosList
    else if (activeTab === 'rutas')        return []  // rutas has own render
    else return []

    if (!searchQuery.trim()) return base
    const q = searchQuery.toLowerCase()
    return base.filter(({ order: o }) =>
      (o.tracking_number  ?? '').toLowerCase().includes(q) ||
      (o.customer_name    ?? '').toLowerCase().includes(q) ||
      (o.customer_phone   ?? '').toLowerCase().includes(q) ||
      (o.customer_address ?? '').toLowerCase().includes(q) ||
      (o.city             ?? '').toLowerCase().includes(q) ||
      (o.order_number     ?? '').toLowerCase().includes(q),
    )
  }, [activeTab, nuevosList, confirmadosList, enRutaList, noRespondenList, searchQuery])

  const displayedEntregados = useMemo(() => {
    if (activeTab !== 'entregados') return []
    if (!searchQuery.trim()) return entregadosFiltrados
    const q = searchQuery.toLowerCase()
    return entregadosFiltrados.filter(({ order: o }) =>
      (o.tracking_number ?? '').toLowerCase().includes(q) ||
      (o.customer_name   ?? '').toLowerCase().includes(q) ||
      (o.customer_phone  ?? '').toLowerCase().includes(q),
    )
  }, [activeTab, entregadosFiltrados, searchQuery])

  const totalDisplay  = activeTab === 'entregados' ? displayedEntregados.length
    : activeTab === 'rutas' ? 0  // rutas has its own render, no pagination
    : displayedPooled.length
  const totalPages    = Math.ceil(totalDisplay / PAGE_SIZE)

  const pagedPooled = useMemo(
    () => displayedPooled.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [displayedPooled, currentPage],
  )
  const pagedEntregados = useMemo(
    () => displayedEntregados.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [displayedEntregados, currentPage],
  )

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

  // ── Render ─────────────────────────────────────────────────────────────────

  const TAB_META: { tab: Tab; label: string; shortLabel: string }[] = [
    { tab: 'nuevos',        label: 'Nuevos / Por confirmar', shortLabel: 'Nuevos'     },
    { tab: 'confirmados',   label: 'Confirmados / Listos',   shortLabel: 'Listos'     },
    { tab: 'rutas',         label: 'Rutas',                  shortLabel: 'Rutas'      },
    { tab: 'en_ruta',       label: 'En ruta',                shortLabel: 'En ruta'    },
    { tab: 'no_responden',  label: 'No responden',           shortLabel: 'N/Resp.'    },
    { tab: 'reprogramados', label: 'Reprogramados',          shortLabel: 'Reprog.'    },
    { tab: 'entregados',    label: 'Entregados',             shortLabel: 'Entregados' },
  ]

  // Ayuda visual: color del tab por estado
  function tabBadgeColors(tab: Tab, active: boolean) {
    if (!active) return 'bg-gray-100 text-gray-500'
    if (tab === 'rutas')        return 'bg-indigo-500 text-white'
    if (tab === 'nuevos')       return 'bg-blue-500 text-white'
    if (tab === 'confirmados')  return 'bg-teal-500 text-white'
    if (tab === 'en_ruta')      return 'bg-teal-600 text-white'
    if (tab === 'no_responden')  return 'bg-amber-500 text-white'
    if (tab === 'reprogramados') return 'bg-orange-500 text-white'
    return 'bg-emerald-500 text-white'
  }

  function tabActiveColors(tab: Tab) {
    if (tab === 'rutas')        return 'border-indigo-500 text-indigo-700 bg-indigo-50/60'
    if (tab === 'nuevos')       return 'border-blue-500 text-blue-700 bg-blue-50/60'
    if (tab === 'confirmados')  return 'border-teal-500 text-teal-700 bg-teal-50/60'
    if (tab === 'en_ruta')      return 'border-teal-600 text-teal-800 bg-teal-50/80'
    if (tab === 'no_responden')  return 'border-amber-500 text-amber-700 bg-amber-50/60'
    if (tab === 'reprogramados') return 'border-orange-500 text-orange-700 bg-orange-50/60'
    return 'border-emerald-500 text-emerald-700 bg-emerald-50/60'
  }

  return (
    <div className="space-y-4 pb-[env(safe-area-inset-bottom,_0px)]">

      {/* ── Toast flotante — posición sobre safe area iOS ── */}
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
              <div className="flex items-center gap-2 md:gap-3 flex-wrap">
                <h1 className="text-xl md:text-2xl font-black text-white tabular-nums">
                  {loading ? '…' : totalActive.toLocaleString()}
                </h1>
                {!loading && tabCounts.nuevos > 0 && (
                  <span className="flex items-center gap-1.5 bg-blue-500/80 text-white
                                   text-xs font-bold px-2.5 py-1 rounded-full">
                    <Clock className="w-3 h-3" />
                    {tabCounts.nuevos} por confirmar
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
              <p className="text-white font-semibold text-sm md:text-base">Entregas Santo Domingo</p>
              <p className="hidden md:block text-teal-100 text-xs mt-0.5">
                Zona Gran Santo Domingo · Transporte local
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 md:gap-4 shrink-0">
            {gananciasHoyEst > 0 && (
              <div className="flex flex-col items-end">
                <span className="text-xs font-black text-white tabular-nums">
                  RD${gananciasHoyEst.toLocaleString('es-DO')}
                </span>
                <span className="text-[10px] text-teal-200 font-medium">estimado hoy</span>
              </div>
            )}
            {gananciasHoyEst === 0 && (perf?.entregadosHoy ?? 0) === 0 && (
              <span className="hidden md:flex items-center gap-1 text-xs text-teal-100">
                <DollarSign className="w-3 h-3" />Meta: {SD_META_DIARIA} entregas
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
                { label: 'Entregados',   count: perf.entregadosHoy,    cls: 'bg-emerald-100 text-emerald-700' },
                { label: 'Confirmados',  count: perf.confirmedHoy,     cls: 'bg-blue-100    text-blue-700'    },
                { label: 'En ruta',      count: perf.enRutaHoy,        cls: 'bg-teal-100    text-teal-700'    },
                { label: 'No responden', count: perf.noRespondenHoy,   cls: 'bg-amber-100   text-amber-700'   },
                { label: 'Reprogramados',count: perf.reprogramadosHoy, cls: 'bg-indigo-100  text-indigo-700'  },
              ] as const).map(({ label, count, cls }) => (
                <div key={label} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${cls}`}>
                  <span className="text-sm font-black tabular-nums leading-none">{count}</span>
                  <span className="text-[11px] font-medium">{label}</span>
                </div>
              ))}
            </div>
            {/* Ganancias estimadas */}
            {gananciasHoyEst > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-teal-600 text-white shrink-0">
                <DollarSign className="w-3 h-3" />
                <span className="text-sm font-black tabular-nums leading-none">
                  RD${gananciasHoyEst.toLocaleString('es-DO')}
                </span>
              </div>
            )}
          </div>
          {/* Barra meta diaria */}
          {perf.entregadosHoy > 0 && (
            <div className="mt-2.5 space-y-1">
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
          )}
        </div>
      )}

      {/* ── Filtro de fecha ── */}
      <div className="flex gap-2">
        {([
          { key: 'hoy',   label: 'Hoy'   },
          { key: 'ayer',  label: 'Ayer'  },
          { key: 'todos', label: 'Todos' },
        ] as { key: DateFilter; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setDateFilter(key)}
            className={`flex items-center gap-1.5 px-3 py-2.5 min-h-[44px] rounded-lg text-sm font-semibold transition-colors
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
      {!loading && totalActive === 0 && allDelivered.length === 0 && (
        <div className="bg-teal-50 border border-teal-200 rounded-xl px-5 py-8 text-center">
          <Package2 className="w-10 h-10 text-teal-400 mx-auto mb-3" />
          <p className="text-teal-700 font-medium">No hay pedidos SD en este momento</p>
          <p className="text-teal-600 text-sm mt-1">
            Los pedidos nuevos y en reparto de Santo Domingo aparecerán aquí
          </p>
        </div>
      )}

      {/* ── Tabla principal ── */}
      {(loading || totalActive > 0 || allDelivered.length > 0) && (
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

          {/* Tabs — sticky en móvil para no perder orientación al hacer scroll */}
          {!loading && (
            <div className="flex border-b border-teal-100 overflow-x-auto
                            sticky top-14 md:top-0 z-10 bg-white">
              {TAB_META.map(({ tab, label, shortLabel }) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center gap-1.5 px-3 sm:px-4 py-2.5 min-h-[44px] text-xs font-semibold
                              border-b-2 transition-colors whitespace-nowrap shrink-0
                    ${activeTab === tab
                      ? tabActiveColors(tab)
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                >
                  <span className="sm:hidden">{shortLabel}</span>
                  <span className="hidden sm:inline">{label}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full
                    ${tabBadgeColors(tab, activeTab === tab)}`}>
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
          {!loading && activeTab !== 'rutas' && totalDisplay === 0 && (totalActive > 0 || allDelivered.length > 0) && (
            <div className="px-5 py-10 text-center">
              <p className="text-gray-500 font-medium">
                {searchQuery
                  ? `Sin resultados para "${searchQuery}"`
                  : 'No hay pedidos en esta categoría'}
              </p>
              <button onClick={() => { setActiveTab('nuevos'); setSearchQuery('') }}
                className="text-teal-600 text-sm mt-2 hover:underline">
                Ver nuevos
              </button>
            </div>
          )}

          {/* ── Tab Rutas — agrupación por zona ── */}
          {!loading && activeTab === 'rutas' && (
            <div className="divide-y divide-indigo-50">

              {/* Banner explicativo */}
              <div className="px-4 py-3 bg-indigo-50/60 border-b border-indigo-100 flex items-start gap-2.5">
                <Route className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-bold text-indigo-700">Pedidos agrupados listos para salir</p>
                  <p className="text-[11px] text-indigo-500 mt-0.5">
                    Generadas automáticamente desde <strong>Confirmados/Listos</strong>.
                    Expande una zona y pulsa <strong>Iniciar ruta</strong> para confirmar la salida de todos sus pedidos.
                  </p>
                </div>
              </div>

              {zoneGroups.length === 0 ? (
                <div className="px-5 py-10 text-center">
                  <Route className="w-8 h-8 text-gray-200 mx-auto mb-3" />
                  <p className="text-gray-500 font-medium text-sm">No hay pedidos listos para despachar</p>
                  <p className="text-gray-400 text-xs mt-1">Despacha pedidos desde el tab "Confirmados/Listos"</p>
                  <button
                    onClick={() => setActiveTab('confirmados')}
                    className="text-teal-600 text-sm mt-2 hover:underline"
                  >
                    Ver esperando despacho →
                  </button>
                </div>
              ) : (
                zoneGroups.map(group => {
                  const zc         = ZONE_COLORS[group.zone.id as ZoneId] ?? ZONE_COLORS['otro']
                  const isExpanded = expandedZones.has(group.zone.id)
                  const zoneOrderIds = group.orders.map(o => o.id)
                  const anyBusy      = zoneOrderIds.some(id => !!loadingRow[id])
                  return (
                    <div key={group.zone.id}>

                      {/* Cabecera de zona — toggle */}
                      <button
                        onClick={() => setExpandedZones(prev => {
                          const next = new Set(prev)
                          if (next.has(group.zone.id)) next.delete(group.zone.id)
                          else next.add(group.zone.id)
                          return next
                        })}
                        className={`w-full flex items-center justify-between px-4 py-3
                                    ${zc.bg} hover:brightness-95 transition-all`}
                      >
                        <div className="flex items-center gap-2.5">
                          <Route className={`w-4 h-4 shrink-0 ${zc.text}`} />
                          <span className={`font-black text-sm ${zc.text}`}>{group.zone.routeLabel}</span>
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${zc.badge}`}>
                            {group.zone.label}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <p className={`text-sm font-black tabular-nums ${zc.text}`}>
                              {group.orders.length} pedido{group.orders.length !== 1 ? 's' : ''}
                            </p>
                            <p className="text-xs text-gray-500 font-medium">
                              ≈ RD${group.gananciaEstimada.toLocaleString('es-DO')}
                            </p>
                          </div>
                          {isExpanded
                            ? <ChevronUp className="w-4 h-4 text-gray-400" />
                            : <ChevronDown className="w-4 h-4 text-gray-400" />
                          }
                        </div>
                      </button>

                      {/* Barra colapsada: COD + ganancia */}
                      {!isExpanded && group.codTotal > 0 && (
                        <div className="px-4 py-1.5 border-t border-gray-50 flex items-center gap-3 text-[11px] text-gray-400">
                          <span>COD: <strong className="text-gray-600">RD${group.codTotal.toLocaleString('es-DO')}</strong></span>
                          <span>·</span>
                          <span>Ganancia: <strong className={zc.text}>RD${group.gananciaEstimada.toLocaleString('es-DO')}</strong></span>
                        </div>
                      )}

                      {/* Vista expandida */}
                      {isExpanded && (
                        <div className="border-t border-gray-100">

                          {/* Acción de zona: totales + Iniciar ruta */}
                          <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100
                                          flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 text-[11px] text-gray-500 flex-wrap">
                              <span>
                                COD total:{' '}
                                <strong className="text-gray-700">
                                  RD${group.codTotal.toLocaleString('es-DO')}
                                </strong>
                              </span>
                              <span>·</span>
                              <span>
                                Ganancia est.:{' '}
                                <strong className={zc.text}>
                                  RD${group.gananciaEstimada.toLocaleString('es-DO')}
                                </strong>
                              </span>
                            </div>
                            <button
                              onClick={() => confirmZoneRoute(group.zone.routeLabel, zoneOrderIds)}
                              disabled={anyBusy}
                              className="flex items-center gap-1.5 px-3 py-2 rounded-lg
                                         bg-teal-500 hover:bg-teal-600 active:bg-teal-700
                                         text-white text-xs font-bold transition-colors
                                         disabled:opacity-50 shrink-0"
                            >
                              {anyBusy
                                ? <Spinner className="w-3.5 h-3.5 text-white" />
                                : <Truck className="w-3.5 h-3.5" />
                              }
                              Iniciar ruta
                            </button>
                          </div>

                          {/* Lista de pedidos */}
                          <div className="divide-y divide-gray-50">
                            {group.orders.map(order => {
                              const ubicacion = order.city || order.province || order.customer_address?.slice(0, 24)
                              const orderMap  = mapsUrl(order)
                              return (
                                <div key={order.id} className="px-4 py-3">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                      <p className="font-mono text-xs font-bold text-gray-900 truncate">
                                        {order.tracking_number ?? order.order_number ?? '—'}
                                      </p>
                                      <p className="text-sm font-semibold text-gray-800 truncate">
                                        {order.customer_name ?? '—'}
                                      </p>
                                      <p className="text-xs text-gray-500 font-mono mt-0.5">
                                        {order.customer_phone || '—'}
                                      </p>
                                      {ubicacion && (
                                        <div className="flex items-center gap-1 mt-0.5 text-xs text-gray-400">
                                          <MapPin className="w-3 h-3 shrink-0" />
                                          <span className="truncate">{ubicacion}</span>
                                          {orderMap && (
                                            <a href={orderMap} target="_blank" rel="noopener noreferrer"
                                               className="shrink-0 text-teal-600 ml-0.5">
                                              <ExternalLink className="w-3 h-3" />
                                            </a>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                                      {order.cod_amount != null && order.cod_amount > 0 && (
                                        <span className="text-xs font-black text-emerald-700 bg-emerald-50
                                                         border border-emerald-200 px-2 py-0.5 rounded-lg tabular-nums whitespace-nowrap">
                                          RD${order.cod_amount.toLocaleString('es-DO')}
                                        </span>
                                      )}
                                      <Link
                                        href={`/orders/${order.id}`}
                                        className="text-[10px] text-teal-600 hover:text-teal-800 font-medium whitespace-nowrap"
                                      >
                                        Ver →
                                      </Link>
                                    </div>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          )}

          {/* ── Cards móvil — tabs activos (no entregados) ── */}
          {!loading && activeTab !== 'entregados' && activeTab !== 'rutas' && pagedPooled.length > 0 && (
            <div className="md:hidden divide-y divide-teal-50">
              {pagedPooled.map(({ order, pool }) => {
                const accion      = actionMap[order.id]
                const busy        = !!loadingRow[order.id]
                const isDelivered = accion === 'delivered' || deliveredDbIds.has(order.id)
                return (
                  <SdCard
                    key={order.id}
                    order={order}
                    pool={pool}
                    accion={accion}
                    busy={busy}
                    isDelivered={isDelivered}
                    onWA={() => postAction(order.id, 'contacted', 'contacted')}
                    onLlamar={() => postAction(order.id, 'contacted', 'contacted')}
                    onConfirmarRuta={() => confirmRoute(order.id)}
                    onClienteConfirma={() => confirmClient(order.id)}
                    onNoAnswer={() => postAction(order.id, 'no_answer', 'contacted', 'no_answer')}
                    onEntregado={() => markDelivered(order.id)}
                    onReprogramar={() => setReModal({ orderId: order.id, name: order.customer_name ?? '' })}
                    onNota={() => setNoteModal({ orderId: order.id, name: order.customer_name ?? '' })}
                    onDeclinado={() => saveCustomerDeclined(order.id)}
                    onDispatchLocal={() => dispatchLocal(order.id)}
                  />
                )
              })}
            </div>
          )}

          {/* ── Cards móvil — tab Entregados ── */}
          {!loading && activeTab === 'entregados' && pagedEntregados.length > 0 && (
            <div className="md:hidden divide-y divide-teal-50">
              {pagedEntregados.map(({ order }) => (
                <SdCard
                  key={order.id}
                  order={order}
                  pool="confirmado"
                  accion="delivered"
                  busy={false}
                  isDelivered={true}
                  onWA={() => {}}
                  onLlamar={() => {}}
                  onConfirmarRuta={() => {}}
                  onClienteConfirma={() => {}}
                  onNoAnswer={() => {}}
                  onEntregado={() => {}}
                  onReprogramar={() => {}}
                  onNota={() => {}}
                  onDeclinado={() => {}}
                  onDispatchLocal={() => {}}
                />
              ))}
            </div>
          )}

          {/* ── Tabla desktop — tabs activos ── */}
          {!loading && activeTab !== 'entregados' && activeTab !== 'rutas' && pagedPooled.length > 0 && (
            <table className="hidden md:table w-full text-sm">
              <thead className="bg-teal-50/60 border-b border-teal-100">
                <tr>
                  {['Pedido', 'Cliente', 'Ubicación', 'Estado/Tiempo', 'Contactar', 'Acciones', ''].map(h => (
                    <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-teal-800 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-teal-50">
                {pagedPooled.map(({ order, pool }) => {
                  const nombre      = order.customer_name ?? ''
                  const waMsg       = pool === 'nuevo'
                    ? buildWaMsgNuevo(nombre, order.product_summary)
                    : buildWaMsg(nombre, order.product_summary)
                  const waUrl       = whatsAppUrl(order.customer_phone, waMsg)
                  const telUrl      = callUrl(order.customer_phone)
                  const hasPhone    = !!order.customer_phone
                  const accion      = actionMap[order.id]
                  const busy        = !!loadingRow[order.id]
                  const isDelivered = accion === 'delivered' || deliveredDbIds.has(order.id)
                  const ds          = computeDisplayState(pool, accion, isDelivered)
                  const crit        = criticalityLabel(order)
                  const ubicacion   = order.city || order.province || (order.customer_address?.slice(0, 20))

                  const rowBg =
                    ds === 'entregado'        ? 'bg-green-50/30'
                    : ds === 'en_ruta'        ? 'bg-teal-50/20 hover:bg-teal-50/40'
                    : ds === 'nuevo'          ? 'bg-blue-50/20 hover:bg-blue-50/40'
                    : ds === 'espera_despacho'? 'bg-purple-50/10 hover:bg-purple-50/30'
                    : crit === 'critico'      ? 'bg-red-50/20 hover:bg-red-50/40'
                    : crit === 'riesgo'       ? 'bg-orange-50/15 hover:bg-orange-50/30'
                    : 'hover:bg-teal-50/30'

                  return (
                    <tr key={order.id} className={`transition-colors ${rowBg}`}>
                      {/* Pedido */}
                      <td className="px-3 py-2.5">
                        <p className="font-mono text-xs font-semibold text-gray-900 whitespace-nowrap">
                          {order.tracking_number ?? order.order_number ?? '—'}
                        </p>
                        {order.tracking_number && order.order_number && (
                          <p className="font-mono text-[10px] text-gray-400 mt-0.5">{order.order_number}</p>
                        )}
                        {pool === 'nuevo' && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold
                                           px-1 py-0.5 rounded bg-blue-100 text-blue-700 mt-0.5">
                            <Clock className="w-2.5 h-2.5" />Por confirmar
                          </span>
                        )}
                        {(() => { const { relative, absolute } = formatOrderDate(order, pool); return (
                          <p className="text-[9px] text-gray-400 mt-0.5 whitespace-nowrap" title={absolute}>
                            {relative} · {absolute}
                          </p>
                        ); })()}
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

                      {/* Estado/Tiempo */}
                      <td className="px-3 py-2.5">
                        {ds === 'nuevo' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold
                                           px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200">
                            <Clock className="w-3 h-3" />Por confirmar
                          </span>
                        ) : ds === 'espera_despacho' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold
                                           px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 border border-purple-200">
                            <UserCheck className="w-3 h-3" />Confirmado
                          </span>
                        ) : ds === 'entregado' ? (
                          <span className="text-[10px] text-green-600 font-semibold">Entregado</span>
                        ) : (
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
                        )}
                      </td>

                      {/* Contactar */}
                      <td className="px-3 py-2.5">
                        {hasPhone && ds !== 'entregado' && ds !== 'espera_despacho' ? (
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
                          <span className="text-xs text-gray-300 italic">—</span>
                        )}
                      </td>

                      {/* Acciones */}
                      <td className="px-3 py-2.5">
                        {busy ? (
                          <Spinner className="w-4 h-4 text-teal-500" />
                        ) : ds === 'nuevo' ? (
                          <div className="flex flex-wrap gap-1">
                            <button onClick={() => confirmClient(order.id)}
                              className="flex items-center gap-1 bg-blue-600 hover:bg-blue-700
                                         text-white text-[11px] font-bold px-2 py-1.5 rounded transition-colors whitespace-nowrap">
                              <UserCheck className="w-3 h-3" />Cliente confirma
                            </button>
                            <button onClick={() => postAction(order.id, 'no_answer', 'contacted', 'no_answer')}
                              className="flex items-center gap-1 bg-amber-100 hover:bg-amber-200
                                         text-amber-700 text-[11px] font-medium px-2 py-1.5 rounded transition-colors whitespace-nowrap">
                              <PhoneMissed className="w-3 h-3" />No resp.
                            </button>
                          </div>
                        ) : ds === 'espera_despacho' ? (
                          <button onClick={() => dispatchLocal(order.id)}
                            className="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700
                                       text-white text-[11px] font-bold px-2 py-1.5 rounded transition-colors whitespace-nowrap">
                            <Truck className="w-3 h-3" />Despachar local
                          </button>
                        ) : ds === 'confirmado_listo' ? (
                          <div className="flex flex-wrap gap-1">
                            <button onClick={() => confirmRoute(order.id)}
                              className="flex items-center gap-1 bg-teal-500 hover:bg-teal-600
                                         text-white text-[11px] font-bold px-2 py-1.5 rounded transition-colors whitespace-nowrap">
                              <Truck className="w-3 h-3" />Confirmar ruta
                            </button>
                            <button onClick={() => postAction(order.id, 'no_answer', 'contacted', 'no_answer')}
                              className="flex items-center gap-1 bg-amber-100 hover:bg-amber-200
                                         text-amber-700 text-[11px] font-medium px-2 py-1.5 rounded transition-colors whitespace-nowrap">
                              <PhoneMissed className="w-3 h-3" />No resp.
                            </button>
                            <button onClick={() => setNoteModal({ orderId: order.id, name: nombre })}
                              className="flex items-center gap-1 bg-gray-100 hover:bg-gray-200
                                         text-gray-600 text-[11px] font-medium px-2 py-1.5 rounded transition-colors">
                              <FileText className="w-3 h-3" />
                            </button>
                          </div>
                        ) : ds === 'en_ruta' ? (
                          <div className="flex flex-wrap gap-1">
                            <button onClick={() => markDelivered(order.id)}
                              className="flex items-center gap-1 bg-emerald-500 hover:bg-emerald-600
                                         text-white text-[11px] font-bold px-2 py-1.5 rounded transition-colors whitespace-nowrap">
                              <CheckCircle2 className="w-3 h-3" />Marcar entregado
                            </button>
                            <button onClick={() => postAction(order.id, 'no_answer', 'contacted', 'no_answer')}
                              className="flex items-center gap-1 bg-amber-100 hover:bg-amber-200
                                         text-amber-700 text-[11px] font-medium px-2 py-1.5 rounded transition-colors whitespace-nowrap">
                              <PhoneMissed className="w-3 h-3" />No resp.
                            </button>
                            <button onClick={() => setReModal({ orderId: order.id, name: nombre })}
                              className="flex items-center gap-1 bg-indigo-100 hover:bg-indigo-200
                                         text-indigo-700 text-[11px] font-medium px-2 py-1.5 rounded transition-colors whitespace-nowrap">
                              <RotateCcw className="w-3 h-3" />Reprogram.
                            </button>
                            <button onClick={() => saveCustomerDeclined(order.id)}
                              className="flex items-center gap-1 bg-red-100 hover:bg-red-200
                                         text-red-700 text-[11px] font-medium px-2 py-1.5 rounded transition-colors whitespace-nowrap">
                              <X className="w-3 h-3" />No desea
                            </button>
                            <button onClick={() => setNoteModal({ orderId: order.id, name: nombre })}
                              className="flex items-center gap-1 bg-gray-100 hover:bg-gray-200
                                         text-gray-600 text-[11px] font-medium px-2 py-1.5 rounded transition-colors">
                              <FileText className="w-3 h-3" />
                            </button>
                          </div>
                        ) : ds === 'no_responde' ? (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="inline-flex items-center gap-1 text-xs font-semibold
                                             px-2 py-1 rounded-full bg-amber-100 text-amber-700">
                              <PhoneMissed className="w-3 h-3" />No responde
                            </span>
                            {pool === 'nuevo' && (
                              <button onClick={() => confirmClient(order.id)}
                                className="flex items-center gap-1 bg-blue-100 hover:bg-blue-200
                                           text-blue-700 text-[11px] font-medium px-2 py-1 rounded transition-colors whitespace-nowrap">
                                <UserCheck className="w-3 h-3" />Confirma ahora
                              </button>
                            )}
                            <button onClick={() => setNoteModal({ orderId: order.id, name: nombre })}
                              className="flex items-center gap-1 bg-gray-100 hover:bg-gray-200
                                         text-gray-600 text-[11px] font-medium px-1.5 py-1 rounded transition-colors">
                              <FileText className="w-3 h-3" />
                            </button>
                          </div>
                        ) : ds === 'reprogramado' ? (
                          <div className="flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-xs font-semibold
                                             px-2 py-1 rounded-full bg-orange-100 text-orange-700">
                              <RotateCcw className="w-3 h-3" />Reprogramado
                            </span>
                            <button onClick={() => setNoteModal({ orderId: order.id, name: nombre })}
                              className="flex items-center gap-1 bg-gray-100 hover:bg-gray-200
                                         text-gray-600 text-[11px] font-medium px-1.5 py-1 rounded transition-colors">
                              <FileText className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold
                                           px-2 py-1 rounded-full bg-green-100 text-green-700">
                            <CheckCircle2 className="w-3 h-3" />Entregado
                          </span>
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

          {/* ── Tabla desktop — tab Entregados ── */}
          {!loading && activeTab === 'entregados' && pagedEntregados.length > 0 && (
            <table className="hidden md:table w-full text-sm">
              <thead className="bg-emerald-50/60 border-b border-teal-100">
                <tr>
                  {['Guía', 'Cliente', 'Teléfono', 'Entregado', ''].map(h => (
                    <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-emerald-800 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-teal-50">
                {pagedEntregados.map(({ order, reported_at }) => (
                  <tr key={order.id} className="bg-green-50/20 hover:bg-green-50/40 transition-colors">
                    <td className="px-3 py-2.5 font-mono text-xs font-semibold text-gray-900">
                      {order.tracking_number ?? order.order_number ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 font-medium text-gray-900 truncate max-w-[160px]">
                      {order.customer_name || '—'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-gray-500">
                      {order.customer_phone || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-emerald-700 font-semibold whitespace-nowrap">
                      <CheckCircle2 className="inline w-3 h-3 mr-1" />
                      {new Date(reported_at).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-3 py-2.5">
                      <Link href={`/orders/${order.id}`}
                        className="inline-flex items-center gap-1 text-xs font-medium
                                   text-teal-600 hover:text-teal-800 whitespace-nowrap hover:underline">
                        <ExternalLink className="w-3 h-3" />Ver
                      </Link>
                    </td>
                  </tr>
                ))}
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
                <span className="font-bold text-gray-800">{currentPage}</span>
                {' / '}
                <span className="font-bold text-gray-800">{totalPages}</span>
                <span className="hidden md:inline text-gray-400"> · {totalDisplay} resultados</span>
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
          <strong className="text-gray-700">Flujo nuevo:</strong>{' '}
          <strong className="text-blue-700">Nuevos</strong> → llamar/WA → <strong className="text-blue-700">Cliente confirma</strong> → el admin asigna a ruta →{' '}
          aparece en <strong className="text-teal-700">Confirmados</strong> → <strong className="text-teal-700">Confirmar ruta</strong> al salir →{' '}
          <strong className="text-emerald-700">Marcar entregado</strong>.
          Si no responde: <strong className="text-amber-700">No responde</strong> (queda en seguimiento).
        </p>
      </div>

    </div>
  )
}
