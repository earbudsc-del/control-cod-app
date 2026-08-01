'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { whatsAppUrl, callUrl, formatCurrency, formatEventDate } from '@/lib/utils'
import type { Order } from '@/types'
import {
  ClipboardList, RefreshCw, MessageCircle, Phone,
  CheckCircle2, PhoneMissed, XCircle, ExternalLink,
  MapPin, RotateCcw, Clock, Inbox, TrendingUp,
  MapPinOff, ChevronLeft, ChevronRight, Search, Truck,
  CalendarDays, ShoppingBag, Package, ListFilter, PackageCheck,
} from 'lucide-react'
import { AlertBadges } from '@/components/shared/alert-badges'
import { ConfirmActionModal } from '@/components/shared/confirm-action-modal'
import { checkCoverage, isSantoDomingoOrder } from '@/lib/alert-helpers'
import { MarkPaidButton } from '@/components/orders/mark-paid-button'
import { createClient as createBrowserClient } from '@/lib/supabase/client'
import { SelectionProvider, SelectionSync } from '@/components/selection/SelectionProvider'
import { SelectionCheckbox } from '@/components/selection/SelectionCheckbox'
import { SelectionHeaderCheckbox } from '@/components/selection/SelectionHeaderCheckbox'
import { SelectionBulkActionBar } from '@/components/selection/BulkActionBar'
import { PrintCodLabelsBatchButton } from '@/components/order-label/PrintCodLabelsBatchButton'

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3
const PAGE_SIZE    = 50
const MS_48H       = 48 * 60 * 60 * 1000
const MS_24H       = 24 * 60 * 60 * 1000

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewMode           = 'pedidos' | 'reintentar' | 'confirmados_sin_guia' | 'despachados' | 'santo_domingo' | 'fuera_de_cobertura'
type ContactMethod      = 'call' | 'whatsapp' | 'other'
type DateFilter         = 'hoy' | 'ayer' | '7dias' | '30dias' | 'personalizado'
type ConfirmStatusFilter = '' | 'pending' | 'reintentar' | 'confirmed' | 'cancelled' | 'no_coverage' | 'unreachable'
// Filtro de pago — solo aplica a la vista Santo Domingo (única superficie con
// payment_status/paid_at/paid_by). 'todos' = sin filtro de pago.
type SdPaymentFilter = 'todos' | 'pendiente' | 'pagado'

interface ConfirmStats {
  nuevos:             number
  reintentar:         number
  atrasados:          number
  confirmadosHoy:     number
  contactadosHoy:     number
  sinRespuesta:       number
  inalcanzables:      number
  noDesean:           number
  sinCobertura:       number
  pendingTotal:       number
  confirmadosSinGuia: number
  despachados:        number
  santoDomingoPendientes?:         number
  santoDomingoConfirmadosSinGuia?: number
  santoDomingoTotal?:              number
  fueraDeCoberturaTotal?:          number
  sdPorCobrar?:                    number
  entregadosSd?:                   number
}

interface ConfirmResult {
  confirmation_attempts:   number
  confirmation_status:     string
  confirmation_confidence: string
  auto_dispatched?:        boolean
}

interface AgentPerf {
  confirmadosHoy:        number
  contactadosHoy:        number
  noRespondieronHoy:     number
  canceladosHoy:         number
  numerosIncorrectosHoy: number
  sinCoberturaHoy:       number
  tasaConfirmacionHoy:   number | null
}

// ── UI maps ───────────────────────────────────────────────────────────────────

const CONFIDENCE: Record<string, { label: string; cls: string }> = {
  high:   { label: 'Seguro', cls: 'bg-green-100 text-green-700 border border-green-200' },
  medium: { label: 'Medio',  cls: 'bg-yellow-100 text-yellow-700 border border-yellow-200' },
  low:    { label: 'Bajo',   cls: 'bg-orange-100 text-orange-700 border border-orange-200' },
  risky:  { label: 'Riesgo', cls: 'bg-red-100 text-red-700 border border-red-200' },
}

const TERMINAL: Record<string, { label: string; color: string }> = {
  confirmed:    { label: 'Confirmado',     color: 'bg-green-100 text-green-700'   },
  wrong_number: { label: 'Nro incorrecto', color: 'bg-red-100 text-red-700'       },
  cancelled:    { label: 'Canceló',        color: 'bg-gray-100 text-gray-600'     },
  unreachable:  { label: 'Inalcanzable',   color: 'bg-red-100 text-red-700'       },
  no_coverage:  { label: 'Sin cobertura',  color: 'bg-orange-100 text-orange-700' },
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

// Para pedidos SD, confirmation_status por sí solo se queda "Confirmado" para
// siempre — nunca refleja que el pedido avanzó a entregado/pagado, porque esa
// información vive en normalized_status/payment_status (columnas separadas a
// propósito, ver 046_orders_payment_status.sql). Este badge es puramente
// visual: NO escribe ni deriva ningún campo, solo decide qué mostrar según la
// etapa operativa más avanzada. confirmation_status nunca se modifica aquí.
function getConfirmBadge(
  order: Order,
  terminalOverride?: string,
): { label: string; cls: string } {
  if (isSantoDomingoOrder(order.city, order.province, order.customer_address)) {
    if ((order.payment_status ?? 'pending') === 'paid') {
      return { label: 'Pagado', cls: 'bg-green-600 text-white' }
    }
    if (order.normalized_status === 'delivered') {
      return { label: 'Entregado', cls: 'bg-blue-100 text-blue-700' }
    }
  }
  const raw      = terminalOverride ?? (order.confirmation_status as string) ?? 'pending'
  const status   = raw === 'wrong_number' ? 'unreachable' : raw
  const attempts = order.confirmation_attempts ?? 0
  if (status === 'confirmed')   return { label: 'Confirmado',    cls: 'bg-green-100  text-green-700'  }
  if (status === 'cancelled')   return { label: 'Cancelado',     cls: 'bg-gray-100   text-gray-600'   }
  if (status === 'no_coverage') return { label: 'Sin cobertura', cls: 'bg-orange-100 text-orange-700' }
  if (status === 'unreachable') return { label: 'Inalcanzable',  cls: 'bg-red-100    text-red-700'    }
  if (attempts >= 1)            return { label: 'Reintentar',    cls: 'bg-amber-100  text-amber-700'  }
  return                               { label: 'Pendiente',     cls: 'bg-gray-100   text-gray-500'   }
}

function getLogisticsBadge(order: Order): { label: string; cls: string } {
  if (!order.tracking_number) return { label: 'Sin guía',    cls: 'bg-gray-100   text-gray-500'   }
  const ns  = order.normalized_status
  const raw = (order.raw_status ?? '').toLowerCase()
  if (ns === 'delivered') return { label: 'Entregada',   cls: 'bg-green-100  text-green-700'  }
  if (ns === 'returned')  return { label: 'Devuelta',    cls: 'bg-gray-200   text-gray-700'   }
  if (ns === 'novedad')   return { label: 'Novedad',     cls: 'bg-red-100    text-red-700'    }
  if (ns === 'en_reparto') return { label: 'En reparto',  cls: 'bg-orange-100 text-orange-700' }
  if (ns === 'in_transit') return { label: 'En tránsito', cls: 'bg-blue-100   text-blue-700'   }
  if (raw.includes('generada') || (ns === 'pending' && !!order.tracking_number))
                           return { label: 'Generada',    cls: 'bg-blue-50    text-blue-600'   }
  return                          { label: 'En tránsito', cls: 'bg-blue-100   text-blue-700'   }
}

function getDelayBadge(order: Order): { label: string; cls: string } | null {
  const ms = new Date(order.shopify_created_at ?? order.created_at).getTime()
  const hoursOld = (Date.now() - ms) / (1000 * 60 * 60)
  if (hoursOld >= 48) return { label: '+48h', cls: 'bg-red-100 text-red-700 font-bold animate-pulse' }
  if (hoursOld >= 24) return { label: '+24h', cls: 'bg-amber-100 text-amber-700 font-bold' }
  return null
}

// Pedido SD local ya despachado/entregado que todavía no tiene el cobro
// registrado — mismo criterio que "SD · Por cobrar" en /confirmados, para
// que el botón "Pagado" aparezca exactamente en el mismo universo de pedidos
// en ambos módulos. Ver POST /api/orders/[id]/mark-paid.
function isPagoPendiente(order: Order): boolean {
  return (
    !order.tracking_number &&
    (order.payment_status ?? 'pending') !== 'paid' &&
    (order.normalized_status === 'en_reparto' || order.normalized_status === 'delivered')
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rdMidnightUTC(offsetDays = 0): number {
  const rd    = new Date(Date.now() + offsetDays * 86_400_000)
  const rdStr = rd.toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' })
  const [y, m, d] = rdStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d, 4, 0, 0, 0)
}

function formatOrderTime(iso: string): string {
  const date      = new Date(iso)
  const now       = new Date()
  const time      = date.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', hour12: true })
  const today     = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86_400_000)
  const day       = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  if (day.getTime() === today.getTime())     return `Hoy ${time}`
  if (day.getTime() === yesterday.getTime()) return `Ayer ${time}`
  return date.toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: '2-digit' }) + ' ' + time
}

function effectiveMs(order: Order): number {
  return new Date(order.shopify_created_at ?? order.created_at).getTime()
}

function buildConfirmMsg(nombre: string, producto?: string | null, monto?: number | null): string {
  const n = nombre.trim() || 'cliente'
  const p = (producto ?? '').trim().slice(0, 30) || 'tu pedido'
  const m = monto ? ` Monto a cancelar: RD$${monto.toLocaleString('es-DO')}.` : ''
  return [`Hola ${n} 😊,`, '', `Tu pedido de ${p} 📦 está próximo a ser entregado.`, '',
          `Por favor confirmanos si podrás recibirlo.${m}`, '', 'Quedamos atentos 🙏'].join('\n')
}

function matchesStatusFilter(order: Order, sf: ConfirmStatusFilter): boolean {
  if (!sf) return true
  const status   = (order.confirmation_status as string) ?? 'pending'
  const attempts = order.confirmation_attempts ?? 0
  switch (sf) {
    case 'pending':     return status === 'pending' && attempts === 0
    case 'reintentar':  return status === 'pending' && attempts > 0
    case 'confirmed':   return status === 'confirmed'
    case 'cancelled':   return status === 'cancelled'
    case 'no_coverage': return status === 'no_coverage'
    case 'unreachable': return status === 'unreachable' || status === 'wrong_number'
    default: return true
  }
}

function buildDateParams(
  dateFilter: DateFilter | null,
  dateFrom: string,
  dateTo: string,
  dateApplied: boolean,
  skipFilter = false,
): string {
  if (!dateFilter || skipFilter) return ''
  const toISO = (ms: number) => encodeURIComponent(new Date(ms).toISOString())
  switch (dateFilter) {
    case 'hoy':   return `&from=${toISO(rdMidnightUTC(0))}&to=${toISO(rdMidnightUTC(1))}`
    case 'ayer':  return `&from=${toISO(rdMidnightUTC(-1))}&to=${toISO(rdMidnightUTC(0))}`
    case '7dias': return `&from=${toISO(rdMidnightUTC(-7))}&to=${toISO(rdMidnightUTC(1))}`
    case '30dias':return `&from=${toISO(rdMidnightUTC(-30))}&to=${toISO(rdMidnightUTC(1))}`
    case 'personalizado': {
      if (!dateApplied || !dateFrom || !dateTo) return ''
      const [fy, fm, fd] = dateFrom.split('-').map(Number)
      const [ty, tm, td] = dateTo.split('-').map(Number)
      return `&from=${toISO(Date.UTC(fy, fm-1, fd, 4, 0, 0, 0))}&to=${toISO(Date.UTC(ty, tm-1, td+1, 4, 0, 0, 0))}`
    }
  }
  return ''
}

// ── ConfirmacionCard (mobile — vistas Nuevos/Reintentar) ──────────────────────

interface ConfirmacionCardProps {
  order: Order; terminal: string | undefined; totalAttempts: number
  confidence: string | undefined; busy: boolean; isHighlighted: boolean
  onConfirmed: () => void; onNoAnswer: () => void
  onNoCoverage: () => void; onCancelled: () => void
  onSetMethod: (m: ContactMethod) => void
}

function ConfirmacionCard({
  order, terminal, totalAttempts, confidence,
  busy, isHighlighted, onConfirmed, onNoAnswer, onNoCoverage, onCancelled, onSetMethod,
}: ConfirmacionCardProps) {
  const nombre  = order.customer_name ?? ''
  const waUrl   = whatsAppUrl(order.customer_phone, buildConfirmMsg(nombre, order.product_summary, order.cod_amount))
  const telUrl  = callUrl(order.customer_phone)
  const hasPhone = !!order.customer_phone
  const cov     = checkCoverage(order.customer_address, order.city, order.province)
  const hasDup  = !!order.duplicate_alert
  const hasAlert = hasDup || cov.isOutOfCoverage || cov.isUnknownZone
  const delay   = getDelayBadge(order)

  const confBadge  = getConfirmBadge(order, terminal)
  const confBadge2 = confidence ? CONFIDENCE[confidence] : null

  return (
    <div className={`p-4 space-y-3
      ${isHighlighted
        ? 'bg-blue-50/80 ring-2 ring-inset ring-blue-400'
        : hasAlert ? 'bg-amber-50/50' : 'bg-white'}`}>

      {/* Fila 1: selección + orden# + hora + delay badge + alertas */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <div className="pt-0.5">
            <SelectionCheckbox id={order.id} label={`Seleccionar pedido ${order.order_number ?? order.id}`} />
          </div>
          <div className="min-w-0">
            <p className="font-mono text-xs text-gray-400">
              {order.order_number ?? '—'}
              <span className="mx-1 text-gray-300">·</span>
              {formatOrderTime(order.shopify_created_at ?? order.created_at)}
            </p>
            {delay && (
              <span className={`inline-flex text-[10px] px-1.5 py-0.5 rounded-full mt-0.5 ${delay.cls}`}>
                {delay.label}
              </span>
            )}
          </div>
        </div>
        <AlertBadges duplicateAlert={order.duplicate_alert}
          customerAddress={order.customer_address} city={order.city} province={order.province}
          productSummary={order.product_summary} />
      </div>

      {/* Fila 2: cliente + teléfono */}
      <div>
        <p className="font-semibold text-gray-900 text-sm leading-tight">{nombre || '—'}</p>
        <p className="font-mono text-xs text-gray-500 mt-0.5">{order.customer_phone ?? '—'}</p>
      </div>

      {/* Fila 3: ciudad + producto */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 text-gray-600">
          <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
          <span className="text-xs">{order.city || '—'}</span>
        </div>
        {order.product_summary && (
          <span className="text-[10px] text-gray-400 truncate max-w-[180px]">{order.product_summary}</span>
        )}
      </div>

      {/* Fila 4: monto + estado + confianza */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-green-700">{formatCurrency(order.cod_amount)}</span>
        {totalAttempts > 0 && (
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full
            ${totalAttempts >= MAX_ATTEMPTS ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
            {totalAttempts}/{MAX_ATTEMPTS}
          </span>
        )}
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${confBadge.cls}`}>
          {confBadge.label}
        </span>
        {confBadge2 && (
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${confBadge2.cls}`}>
            {confBadge2.label}
          </span>
        )}
      </div>

      {/* Acciones */}
      {busy ? (
        <div className="flex items-center justify-center py-2">
          <Spinner className="w-5 h-5 text-indigo-500" />
        </div>
      ) : terminal ? (
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold
                         px-3 py-1.5 rounded-full
                         ${TERMINAL[terminal]?.color ?? 'bg-gray-100 text-gray-600'}`}>
          <CheckCircle2 className="w-3.5 h-3.5" />
          {TERMINAL[terminal]?.label ?? terminal}
        </span>
      ) : (
        <div className="space-y-2">
          {hasPhone && (
            <div className="flex gap-2">
              {waUrl && (
                <a href={waUrl} target="_blank" rel="noopener noreferrer"
                   onClick={() => onSetMethod('whatsapp')}
                   className="flex-1 flex items-center justify-center gap-2 min-h-[44px]
                              bg-green-500 hover:bg-green-600 text-white text-sm font-semibold
                              rounded-xl transition-colors shadow-sm">
                  <MessageCircle className="w-4 h-4" />WhatsApp
                </a>
              )}
              {telUrl && (
                <a href={telUrl} onClick={() => onSetMethod('call')}
                   className="flex-1 flex items-center justify-center gap-2 min-h-[44px]
                              bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold
                              rounded-xl transition-colors shadow-sm">
                  <Phone className="w-4 h-4" />Llamar
                </a>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={onConfirmed}
              className="flex items-center justify-center gap-1.5 min-h-[44px]
                         bg-green-100 hover:bg-green-200 text-green-700 text-sm font-medium rounded-xl">
              <CheckCircle2 className="w-4 h-4 shrink-0" />Confirmó
            </button>
            <button onClick={onNoAnswer}
              className="flex items-center justify-center gap-1.5 min-h-[44px]
                         bg-amber-100 hover:bg-amber-200 text-amber-700 text-sm font-medium rounded-xl">
              <PhoneMissed className="w-4 h-4 shrink-0" />No contesta
            </button>
            <button onClick={onNoCoverage}
              className="flex items-center justify-center gap-1.5 min-h-[44px]
                         bg-orange-100 hover:bg-orange-200 text-orange-700 text-sm font-medium rounded-xl">
              <MapPinOff className="w-4 h-4 shrink-0" />Sin cobertura
            </button>
            <button onClick={onCancelled}
              className="flex items-center justify-center gap-1.5 min-h-[44px]
                         bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-xl">
              <XCircle className="w-4 h-4 shrink-0" />Canceló
            </button>
          </div>
        </div>
      )}
      <Link href={`/orders/${order.id}`}
        className="flex items-center justify-center gap-1.5 w-full min-h-[36px]
                   text-xs font-medium text-indigo-600 hover:text-indigo-800
                   border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors">
        <ExternalLink className="w-3.5 h-3.5" />Ver detalle
      </Link>
    </div>
  )
}

// ── PedidoCard (mobile — vista Pedidos) ────────────────────────────────────────

interface PedidoCardProps {
  order: Order; busy: boolean; terminal?: string
  onConfirmed: () => void; onNoAnswer: () => void
  onNoCoverage: () => void; onCancelled: () => void
  onSetMethod: (m: ContactMethod) => void
  onPaidSuccess?: () => void
}

function PedidoCard({ order, busy, terminal, onConfirmed, onNoAnswer, onNoCoverage, onCancelled, onSetMethod, onPaidSuccess }: PedidoCardProps) {
  const nombre    = order.customer_name ?? ''
  const waUrl     = whatsAppUrl(order.customer_phone, buildConfirmMsg(nombre, order.product_summary, order.cod_amount))
  const telUrl    = callUrl(order.customer_phone)
  const hasPhone  = !!order.customer_phone
  const isPending = !terminal && (order.confirmation_status as string) === 'pending' && !order.tracking_number
  const confBadge = getConfirmBadge(order, terminal)
  const logBadge  = getLogisticsBadge(order)
  const delay     = getDelayBadge(order)

  return (
    <div className="p-4 space-y-2.5 bg-white">
      {/* Selección + Fecha + orden# */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <div className="pt-0.5">
            <SelectionCheckbox id={order.id} label={`Seleccionar pedido ${order.order_number ?? order.id}`} />
          </div>
          <div>
            <p className="text-xs text-gray-500 font-mono">
              {order.order_number ?? '—'}
              <span className="mx-1 text-gray-300">·</span>
              {formatOrderTime(order.shopify_created_at ?? order.created_at)}
            </p>
            {delay && (
              <span className={`inline-flex text-[10px] px-1.5 py-0.5 rounded-full mt-0.5 ${delay.cls}`}>
                {delay.label}
              </span>
            )}
          </div>
        </div>
        <AlertBadges duplicateAlert={order.duplicate_alert}
          customerAddress={order.customer_address} city={order.city} province={order.province}
          productSummary={order.product_summary} />
      </div>

      {/* Cliente */}
      <div>
        <p className="font-semibold text-gray-900 text-sm">{nombre || '—'}</p>
        <p className="font-mono text-xs text-gray-500">{order.customer_phone ?? '—'}</p>
      </div>

      {/* Ciudad + monto */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-gray-600 min-w-0">
          <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
          <span className="text-xs truncate">{order.city || '—'}</span>
        </div>
        <span className="text-sm font-bold text-green-700 shrink-0">{formatCurrency(order.cod_amount)}</span>
      </div>

      {/* Badges de estado */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${confBadge.cls}`}>
          {confBadge.label}
        </span>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${logBadge.cls}`}>
          {logBadge.label}
        </span>
      </div>

      {/* Fecha de pago + quién lo marcó — solo cuando el badge financiero es "Pagado" */}
      {confBadge.label === 'Pagado' && (
        <p className="text-[11px] text-gray-500">
          {order.paid_at ? formatEventDate(order.paid_at) : 'Fecha de pago no disponible'}
          <span className="mx-1 text-gray-300">·</span>
          Por: {order.paid_by_name ?? 'Usuario no disponible'}
        </p>
      )}

      {/* Pagado (pedido SD ya despachado/entregado, pago pendiente) */}
      {isPagoPendiente(order) && onPaidSuccess && (
        <MarkPaidButton orderId={order.id} onSuccess={onPaidSuccess} className="w-full flex items-center justify-center gap-1.5 min-h-[40px] bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-xl shadow-sm" />
      )}

      {/* Acciones (solo si pendiente sin tracking) */}
      {isPending && (
        busy ? (
          <div className="flex justify-center py-1"><Spinner className="w-4 h-4 text-indigo-500" /></div>
        ) : (
          <div className="space-y-1.5">
            {hasPhone && (
              <div className="flex gap-1.5">
                {waUrl && (
                  <a href={waUrl} target="_blank" rel="noopener noreferrer"
                     onClick={() => onSetMethod('whatsapp')}
                     className="flex-1 flex items-center justify-center gap-1.5 min-h-[40px]
                                bg-green-500 hover:bg-green-600 text-white text-xs font-semibold rounded-xl">
                    <MessageCircle className="w-3.5 h-3.5" />WA
                  </a>
                )}
                {telUrl && (
                  <a href={telUrl} onClick={() => onSetMethod('call')}
                     className="flex-1 flex items-center justify-center gap-1.5 min-h-[40px]
                                bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-xl">
                    <Phone className="w-3.5 h-3.5" />Llamar
                  </a>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-1">
              <button onClick={onConfirmed}
                className="flex items-center justify-center gap-1 min-h-[36px]
                           bg-green-100 hover:bg-green-200 text-green-700 text-xs font-medium rounded-lg">
                <CheckCircle2 className="w-3.5 h-3.5" />Confirmó
              </button>
              <button onClick={onNoAnswer}
                className="flex items-center justify-center gap-1 min-h-[36px]
                           bg-amber-100 hover:bg-amber-200 text-amber-700 text-xs font-medium rounded-lg">
                <PhoneMissed className="w-3.5 h-3.5" />No contesta
              </button>
              <button onClick={onNoCoverage}
                className="flex items-center justify-center gap-1 min-h-[36px]
                           bg-orange-100 hover:bg-orange-200 text-orange-700 text-xs font-medium rounded-lg">
                <MapPinOff className="w-3.5 h-3.5" />Sin cobertura
              </button>
              <button onClick={onCancelled}
                className="flex items-center justify-center gap-1 min-h-[36px]
                           bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium rounded-lg">
                <XCircle className="w-3.5 h-3.5" />Canceló
              </button>
            </div>
          </div>
        )
      )}
      <Link href={`/orders/${order.id}`}
        className="flex items-center justify-center gap-1.5 w-full min-h-[34px]
                   text-xs font-medium text-indigo-600 hover:text-indigo-800
                   border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors">
        <ExternalLink className="w-3.5 h-3.5" />Ver detalle
      </Link>
    </div>
  )
}

// ── ReadOnlyCard (mobile — Confirmados sin guía / Despachados) ─────────────────

function ReadOnlyCard({ order, onReopen }: { order: Order; onReopen?: (order: Order) => void }) {
  const confBadge = getConfirmBadge(order)
  const logBadge  = getLogisticsBadge(order)
  return (
    <div className="p-4 space-y-2 bg-white">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <div className="pt-0.5">
            <SelectionCheckbox id={order.id} label={`Seleccionar pedido ${order.order_number ?? order.id}`} />
          </div>
          <p className="text-xs font-mono text-gray-400">
            {order.order_number ?? '—'}
            <span className="mx-1 text-gray-300">·</span>
            {formatOrderTime(order.shopify_created_at ?? order.created_at)}
          </p>
        </div>
        <AlertBadges duplicateAlert={order.duplicate_alert}
          customerAddress={order.customer_address} city={order.city} province={order.province}
          productSummary={order.product_summary} />
      </div>
      <p className="font-semibold text-gray-900 text-sm">{order.customer_name || '—'}</p>
      <p className="text-xs text-gray-500">{order.customer_phone ?? '—'}</p>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-gray-600">
          <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
          <span className="text-xs">{order.city || '—'}</span>
        </div>
        <span className="text-sm font-bold text-green-700">{formatCurrency(order.cod_amount)}</span>
      </div>
      {order.tracking_number && (
        <p className="font-mono text-[10px] text-gray-400">{order.tracking_number}</p>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${confBadge.cls}`}>
          {confBadge.label}
        </span>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${logBadge.cls}`}>
          {logBadge.label}
        </span>
      </div>
      {onReopen && (
        <button
          onClick={() => onReopen(order)}
          className="flex items-center justify-center gap-1.5 w-full min-h-[34px]
                     text-xs font-semibold text-amber-700 border border-amber-200
                     rounded-lg hover:bg-amber-50 transition-colors">
          <RotateCcw className="w-3.5 h-3.5" />Reabrir pedido
        </button>
      )}
      <Link href={`/orders/${order.id}`}
        className="flex items-center justify-center gap-1.5 w-full min-h-[34px]
                   text-xs font-medium text-indigo-600 hover:text-indigo-800
                   border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors">
        <ExternalLink className="w-3.5 h-3.5" />Ver detalle
      </Link>
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function ConfirmacionPage() {
  const trackingParam = useSearchParams().get('tracking')
  const rowRefs       = useRef<Map<string, HTMLElement>>(new Map())
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── View mode ───────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>('pedidos')

  // ── Shared ──────────────────────────────────────────────────────────────────
  const [stats, setStats]             = useState<ConfirmStats | null>(null)
  const [perf, setPerf]               = useState<AgentPerf | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [toast, setToast]             = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  // ── Rol del usuario actual — gate de "Reabrir pedido" (solo admin/confirmation_agent) ──
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null)
  useEffect(() => {
    const supabase = createBrowserClient()
    supabase.auth.getUser().then(async ({ data }) => {
      const uid = data.user?.id ?? null
      if (!uid) return
      const { data: profile } = await supabase
        .from('profiles').select('role').eq('id', uid).maybeSingle()
      setCurrentUserRole(profile?.role ?? null)
    })
  }, [])
  const canReopen = currentUserRole === 'admin' || currentUserRole === 'confirmation_agent'

  // ── Reabrir pedido (modal) ───────────────────────────────────────────────────
  const [reopenTarget, setReopenTarget] = useState<Order | null>(null)
  const [reopenBusy, setReopenBusy]     = useState(false)
  const [reopenError, setReopenError]   = useState<string | null>(null)

  async function submitReopen(reason: string) {
    if (!reopenTarget) return
    setReopenBusy(true)
    setReopenError(null)
    try {
      const res = await fetch(`/api/orders/${reopenTarget.id}/confirmation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopened', reason }),
      })
      const data = await res.json()
      if (!res.ok) {
        setReopenError(data.error ?? 'No se pudo reabrir el pedido')
        return
      }
      setConfirmadosData(prev => prev.filter(o => o.id !== reopenTarget.id))
      setReopenTarget(null)
      showToast('✓ Pedido reabierto — vuelve a la cola de confirmación', 'success')
      fetchStats()
    } catch {
      setReopenError('Error de red al reabrir el pedido')
    } finally {
      setReopenBusy(false)
    }
  }

  // ── Search + date + status (shared) ────────────────────────────────────────
  const [searchQuery, setSearchQuery]     = useState('')
  const [dateFilter, setDateFilter]       = useState<DateFilter | null>(null)
  const [dateFrom, setDateFrom]           = useState('')
  const [dateTo, setDateTo]               = useState('')
  const [dateApplied, setDateApplied]     = useState(false)
  const [statusFilter, setStatusFilter]   = useState<ConfirmStatusFilter>('')

  // ── Vista "Pedidos" (server-paginated) ──────────────────────────────────────
  const [pedidosData, setPedidosData]     = useState<Order[]>([])
  const [pedidosTotal, setPedidosTotal]   = useState(0)
  const [pedidosPage, setPedidosPage]     = useState(1)
  const [pedidosPages, setPedidosPages]   = useState(0)
  const [pedidosLoading, setPedidosLoading] = useState(false)

  // ── Cola operativa (Nuevos / Reintentar) ────────────────────────────────────
  const [orders, setOrders]               = useState<Order[]>([])
  const [queueTotal, setQueueTotal]       = useState(0)
  const [queueLoading, setQueueLoading]   = useState(false)
  const [terminalMap, setTerminalMap]     = useState<Record<string, string>>({})
  const [attemptsMap, setAttemptsMap]     = useState<Record<string, number>>({})
  const [loadingRow, setLoadingRow]       = useState<Record<string, boolean>>({})
  const [methodMap, setMethodMap]         = useState<Record<string, ContactMethod>>({})
  const [confidenceMap, setConfidenceMap] = useState<Record<string, string>>({})
  const [currentPage, setCurrentPage]     = useState(1)

  // ── Confirmados sin guía ────────────────────────────────────────────────────
  const [confirmadosData, setConfirmadosData]       = useState<Order[]>([])
  const [confirmadosLoading, setConfirmadosLoading] = useState(false)
  const [confirmadosLoaded, setConfirmadosLoaded]   = useState(false)

  // ── Despachados ─────────────────────────────────────────────────────────────
  const [despachadosData, setDespachadosData]       = useState<Order[]>([])
  const [despachadosLoading, setDespachadosLoading] = useState(false)
  const [despachadosLoaded, setDespachadosLoaded]   = useState(false)

  // ── Santo Domingo (server-paginated) ────────────────────────────────────────
  const [sdData, setSdData]       = useState<Order[]>([])
  const [sdTotal, setSdTotal]     = useState(0)
  const [sdPage, setSdPage]       = useState(1)
  const [sdPages, setSdPages]     = useState(0)
  const [sdLoading, setSdLoading] = useState(false)
  const [sdPaymentFilter, setSdPaymentFilter] = useState<SdPaymentFilter>('todos')

  // ── Fuera de cobertura (server-paginated) ────────────────────────────────────
  const [fcdData, setFcdData]       = useState<Order[]>([])
  const [fcdTotal, setFcdTotal]     = useState(0)
  const [fcdPage, setFcdPage]       = useState(1)
  const [fcdPages, setFcdPages]     = useState(0)
  const [fcdLoading, setFcdLoading] = useState(false)

  // ── Fetch: stats + perf ─────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    const [statsRes, perfRes] = await Promise.all([
      fetch('/api/confirmacion/stats').then(r => r.json() as Promise<ConfirmStats>),
      fetch('/api/confirmacion/performance').then(r => r.json() as Promise<AgentPerf>),
    ])
    setStats(statsRes)
    setPerf(perfRes)
  }, [])

  // ── Fetch: pedidos (server-paginated) ───────────────────────────────────────
  const fetchPedidos = useCallback(async (page: number, sq: string, df: DateFilter | null, dFrom: string, dTo: string, dApplied: boolean, sf: ConfirmStatusFilter = '') => {
    setPedidosLoading(true)
    try {
      const searchQs = sq ? `&search=${encodeURIComponent(sq)}` : ''
      const dateQs   = buildDateParams(df, dFrom, dTo, dApplied)
      const statusQs = sf ? `&status=${encodeURIComponent(sf)}` : ''
      const res      = await fetch(`/api/confirmacion/pedidos?page=${page}&limit=50${searchQs}${dateQs}${statusQs}`)
        .then(r => r.json() as Promise<{ data: Order[]; total: number; page: number; pages: number }>)
      setPedidosData(res.data  ?? [])
      setPedidosTotal(res.total ?? 0)
      setPedidosPage(res.page   ?? page)
      setPedidosPages(res.pages ?? 0)
    } finally {
      setPedidosLoading(false)
    }
  }, [])

  // ── Fetch: cola (Nuevos/Reintentar) ─────────────────────────────────────────
  const fetchQueue = useCallback(async () => {
    setQueueLoading(true)
    try {
      const res  = await fetch('/api/confirmacion').then(r => r.json() as Promise<{ data: Order[]; total: number }>)
      const data = res.data ?? []
      setOrders(data)
      setQueueTotal(res.total ?? 0)
      const initConf: Record<string, string> = {}
      const initAtt:  Record<string, number> = {}
      for (const o of data) {
        if (o.confirmation_confidence) initConf[o.id] = o.confirmation_confidence
        if (o.confirmation_attempts)   initAtt[o.id]  = o.confirmation_attempts
      }
      setConfidenceMap(prev => ({ ...initConf, ...prev }))
      setAttemptsMap(prev   => ({ ...initAtt,  ...prev }))
    } finally {
      setQueueLoading(false)
    }
  }, [])

  // ── Fetch: confirmados sin guía ─────────────────────────────────────────────
  const fetchConfirmados = useCallback(async () => {
    setConfirmadosLoading(true)
    try {
      const res = await fetch('/api/confirmados').then(r => r.json() as Promise<{ data: Order[] }>)
      setConfirmadosData(res.data ?? [])
      setConfirmadosLoaded(true)
    } finally {
      setConfirmadosLoading(false)
    }
  }, [])

  // ── Fetch: despachados ──────────────────────────────────────────────────────
  const fetchDespachados = useCallback(async () => {
    setDespachadosLoading(true)
    try {
      const res = await fetch('/api/despachados').then(r => r.json() as Promise<{ data: Order[] }>)
      setDespachadosData(res.data ?? [])
      setDespachadosLoaded(true)
    } finally {
      setDespachadosLoading(false)
    }
  }, [])

  // ── Fetch: Santo Domingo (server-paginated) ─────────────────────────────────
  const fetchSD = useCallback(async (
    page: number, sq: string, sf: ConfirmStatusFilter = '', pf: SdPaymentFilter = 'todos',
    df: DateFilter | null = null, dFrom = '', dTo = '', dApplied = false,
  ) => {
    setSdLoading(true)
    try {
      const searchQs  = sq ? `&search=${encodeURIComponent(sq)}` : ''
      const statusQs  = sf ? `&status=${encodeURIComponent(sf)}` : ''
      const paymentQs = pf === 'pendiente' ? '&payment=pending' : pf === 'pagado' ? '&payment=paid' : ''
      const dateQs    = buildDateParams(df, dFrom, dTo, dApplied)
      const res = await fetch(`/api/confirmacion/pedidos?filter=santo_domingo&page=${page}&limit=50${searchQs}${statusQs}${paymentQs}${dateQs}`)
        .then(r => r.json() as Promise<{ data: Order[]; total: number; page: number; pages: number }>)
      setSdData(res.data   ?? [])
      setSdTotal(res.total ?? 0)
      setSdPage(res.page   ?? page)
      setSdPages(res.pages ?? 0)
    } finally {
      setSdLoading(false)
    }
  }, [])

  // ── Fetch: Fuera de cobertura (server-paginated) ─────────────────────────────
  const fetchFCD = useCallback(async (
    page: number, sq: string, sf: ConfirmStatusFilter = '',
    df: DateFilter | null = null, dFrom = '', dTo = '', dApplied = false,
  ) => {
    setFcdLoading(true)
    try {
      const searchQs = sq ? `&search=${encodeURIComponent(sq)}` : ''
      const statusQs = sf ? `&status=${encodeURIComponent(sf)}` : ''
      const dateQs   = buildDateParams(df, dFrom, dTo, dApplied)
      const res = await fetch(`/api/confirmacion/pedidos?filter=fuera_de_cobertura&page=${page}&limit=50${searchQs}${statusQs}${dateQs}`)
        .then(r => r.json() as Promise<{ data: Order[]; total: number; page: number; pages: number }>)
      setFcdData(res.data   ?? [])
      setFcdTotal(res.total ?? 0)
      setFcdPage(res.page   ?? page)
      setFcdPages(res.pages ?? 0)
    } finally {
      setFcdLoading(false)
    }
  }, [])

  // ── Refresh maestro ─────────────────────────────────────────────────────────
  const refreshAll = useCallback(() => {
    setLastRefresh(new Date())
    fetchStats()
    if (viewMode === 'pedidos')
      fetchPedidos(pedidosPage, searchQuery, dateFilter, dateFrom, dateTo, dateApplied, statusFilter)
    if (viewMode === 'reintentar')           fetchQueue()
    if (viewMode === 'confirmados_sin_guia') fetchConfirmados()
    if (viewMode === 'despachados')          fetchDespachados()
    if (viewMode === 'santo_domingo')
      fetchSD(sdPage, searchQuery, statusFilter, sdPaymentFilter, dateFilter, dateFrom, dateTo, dateApplied)
    if (viewMode === 'fuera_de_cobertura')
      fetchFCD(fcdPage, searchQuery, statusFilter, dateFilter, dateFrom, dateTo, dateApplied)
  }, [viewMode, pedidosPage, sdPage, fcdPage, searchQuery, dateFilter, dateFrom, dateTo, dateApplied, statusFilter,
      sdPaymentFilter, fetchStats, fetchPedidos, fetchQueue, fetchConfirmados, fetchDespachados, fetchSD, fetchFCD])

  // ── Mount: pre-cargar todo ──────────────────────────────────────────────────
  useEffect(() => {
    fetchStats()
    fetchPedidos(1, '', null, '', '', false)
    fetchQueue()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Auto-refresh 3 min ──────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(refreshAll, 3 * 60 * 1000)
    return () => clearInterval(id)
  }, [refreshAll])

  // ── Cambio de viewMode ──────────────────────────────────────────────────────
  useEffect(() => {
    setCurrentPage(1)
    if (viewMode === 'pedidos')
      fetchPedidos(1, searchQuery, dateFilter, dateFrom, dateTo, dateApplied, statusFilter)
    if (viewMode === 'reintentar')                          fetchQueue()
    if (viewMode === 'confirmados_sin_guia' && !confirmadosLoaded) fetchConfirmados()
    if (viewMode === 'despachados'          && !despachadosLoaded) fetchDespachados()
    if (viewMode === 'santo_domingo') {
      setSdPage(1)
      fetchSD(1, searchQuery, statusFilter, sdPaymentFilter, dateFilter, dateFrom, dateTo, dateApplied)
    }
    if (viewMode === 'fuera_de_cobertura') {
      setFcdPage(1)
      fetchFCD(1, searchQuery, statusFilter, dateFilter, dateFrom, dateTo, dateApplied)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode])

  // ── Cambios en búsqueda/fecha/estado → re-fetch pedidos ─────────────────────
  useEffect(() => {
    if (viewMode !== 'pedidos') return
    setPedidosPage(1)
    fetchPedidos(1, searchQuery, dateFilter, dateFrom, dateTo, dateApplied, statusFilter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, dateFilter, dateApplied, statusFilter])

  // ── Cambio de página en pedidos ─────────────────────────────────────────────
  useEffect(() => {
    if (viewMode === 'pedidos')
      fetchPedidos(pedidosPage, searchQuery, dateFilter, dateFrom, dateTo, dateApplied, statusFilter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pedidosPage])

  // ── Búsqueda/estado/pago/fecha en tab Santo Domingo — todos los filtros    ──
  // activos deben combinarse (AND), no reemplazarse: cualquier cambio de
  // búsqueda, estado, pago o período dispara un refetch con TODOS los
  // filtros vigentes (ver buildDateParams + fetchSD).
  useEffect(() => {
    if (viewMode !== 'santo_domingo') return
    setSdPage(1)
    fetchSD(1, searchQuery, statusFilter, sdPaymentFilter, dateFilter, dateFrom, dateTo, dateApplied)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, statusFilter, sdPaymentFilter, dateFilter, dateApplied])

  // ── Cambio de página en Santo Domingo ────────────────────────────────────────
  useEffect(() => {
    if (viewMode === 'santo_domingo')
      fetchSD(sdPage, searchQuery, statusFilter, sdPaymentFilter, dateFilter, dateFrom, dateTo, dateApplied)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdPage])

  // ── Búsqueda/estado/fecha en tab Fuera de cobertura ─────────────────────────
  useEffect(() => {
    if (viewMode !== 'fuera_de_cobertura') return
    setFcdPage(1)
    fetchFCD(1, searchQuery, statusFilter, dateFilter, dateFrom, dateTo, dateApplied)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, statusFilter, dateFilter, dateApplied])

  // ── Cambio de página en Fuera de cobertura ───────────────────────────────────
  useEffect(() => {
    if (viewMode === 'fuera_de_cobertura')
      fetchFCD(fcdPage, searchQuery, statusFilter, dateFilter, dateFrom, dateTo, dateApplied)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fcdPage])

  // ── Scroll a pedido con tracking param ─────────────────────────────────────
  useEffect(() => {
    if (!trackingParam || orders.length === 0) return
    const match = orders.find(o => o.tracking_number === trackingParam)
    if (match) {
      setTimeout(() => {
        rowRefs.current.get(match.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 100)
    }
  }, [orders, trackingParam])

  // ── displayedOrders (cola: Nuevos / Reintentar) ─────────────────────────────
  const displayedOrders = useMemo(() => {
    if (viewMode === 'reintentar') {
      return orders
        .filter(o => { const a = o.confirmation_attempts ?? 0; return a >= 1 && a <= 2 })
        .sort((a, b) => {
          const ta = a.last_confirmation_attempt ? new Date(a.last_confirmation_attempt).getTime() : 0
          const tb = b.last_confirmation_attempt ? new Date(b.last_confirmation_attempt).getTime() : 0
          return ta - tb
        })
    }
    return []
  }, [orders, viewMode])

  // ── effectiveDateRange para vistas de cola (client-side) ────────────────────
  const effectiveDateRange = useMemo((): { from: number; to: number } | null => {
    if (!dateFilter) return null
    const todayMs    = rdMidnightUTC(0)
    const tomorrowMs = rdMidnightUTC(1)
    switch (dateFilter) {
      case 'hoy':   return { from: todayMs,           to: tomorrowMs }
      case 'ayer':  return { from: rdMidnightUTC(-1),  to: todayMs    }
      case '7dias': return { from: rdMidnightUTC(-7),  to: tomorrowMs }
      case '30dias':return { from: rdMidnightUTC(-30), to: tomorrowMs }
      case 'personalizado': {
        if (!dateApplied || !dateFrom || !dateTo) return null
        const [fy, fm, fd] = dateFrom.split('-').map(Number)
        const [ty, tm, td] = dateTo.split('-').map(Number)
        return { from: Date.UTC(fy, fm-1, fd, 4, 0, 0, 0), to: Date.UTC(ty, tm-1, td+1, 4, 0, 0, 0) }
      }
    }
    return null
  }, [dateFilter, dateFrom, dateTo, dateApplied])

  const filteredOrders = useMemo(() => {
    let result = displayedOrders
    if (effectiveDateRange) {
      const { from, to } = effectiveDateRange
      result = result.filter(o => { const ts = effectiveMs(o); return ts >= from && ts < to })
    }
    if (statusFilter) {
      result = result.filter(o => matchesStatusFilter(o, statusFilter))
    }
    const q = searchQuery.trim().toLowerCase()
    if (!q) return result
    return result.filter(o =>
      (o.customer_name  ?? '').toLowerCase().includes(q) ||
      (o.customer_phone ?? '').toLowerCase().includes(q) ||
      (o.order_number   ?? '').toLowerCase().includes(q),
    )
  }, [displayedOrders, effectiveDateRange, searchQuery, statusFilter])

  const pagedOrders  = useMemo(
    () => filteredOrders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredOrders, currentPage],
  )
  const totalPages = Math.ceil(filteredOrders.length / PAGE_SIZE)

  useEffect(() => { setCurrentPage(1) }, [searchQuery, dateFilter, dateApplied, viewMode, statusFilter])

  // ── Toast ───────────────────────────────────────────────────────────────────
  function showToast(msg: string, type: 'success' | 'error') {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ msg, type })
    toastTimerRef.current = setTimeout(() => setToast(null), 3000)
  }

  // ── Acción de confirmación ──────────────────────────────────────────────────
  async function postConfirmation(orderId: string, action: string) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      const method = methodMap[orderId] ?? 'other'
      const res = await fetch(`/api/orders/${orderId}/confirmation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, method }),
      })
      if (!res.ok) { showToast('Error al procesar la acción. Intenta de nuevo.', 'error'); return }
      const data = await res.json() as ConfirmResult
      setConfidenceMap(prev => ({ ...prev, [orderId]: data.confirmation_confidence }))
      if (action === 'no_answer') {
        setAttemptsMap(prev => ({ ...prev, [orderId]: data.confirmation_attempts }))
        if (data.confirmation_status === 'unreachable') {
          setTerminalMap(prev => ({ ...prev, [orderId]: 'unreachable' }))
          showToast('Pedido marcado como inalcanzable', 'success')
        } else {
          showToast(`Intento ${data.confirmation_attempts}/${MAX_ATTEMPTS} registrado`, 'success')
        }
      } else {
        setTerminalMap(prev => ({ ...prev, [orderId]: action }))
        const TOAST_MSG: Record<string, string> = {
          confirmed:   '✓ Pedido confirmado',
          cancelled:   'Pedido cancelado',
          no_coverage: 'Pedido marcado como Sin cobertura',
        }
        const msg = action === 'confirmed' && data.auto_dispatched
          ? '✓ Confirmado y despachado a mensajero SD'
          : TOAST_MSG[action] ?? 'Acción registrada'
        showToast(msg, 'success')
        if (action !== 'confirmed') {
          setTimeout(() => setOrders(prev => prev.filter(o => o.id !== orderId)), 1500)
        } else if (data.auto_dispatched) {
          // El pedido SD se auto-despachó a en_reparto en el mismo request de
          // confirmación (ver applyConfirmationAction). Reflejarlo aquí de
          // inmediato — si no, el pedido queda con normalized_status='pending'
          // en el array local hasta el próximo refetch (cada 3 min o manual),
          // y el botón "Pagado" (que depende de normalized_status='en_reparto'
          // vía isPagoPendiente) no aparece hasta entonces.
          const patch = (o: Order): Order =>
            o.id === orderId
              ? { ...o, normalized_status: 'en_reparto', confirmation_status: 'confirmed' }
              : o
          setSdData(prev => prev.map(patch))
          setPedidosData(prev => prev.map(patch))
        }
      }
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  const confirmedCount = Object.values(terminalMap).filter(a => a === 'confirmed').length

  // ── Counts para los tabs ────────────────────────────────────────────────────
  const viewCounts: Record<ViewMode, number> = useMemo(() => ({
    pedidos:              pedidosTotal,
    reintentar:           stats?.reintentar         ?? 0,
    confirmados_sin_guia: stats?.confirmadosSinGuia ?? 0,
    despachados:          stats?.despachados         ?? 0,
    // Preferir el total real cargado de la paginación; si aún no se cargó, usar stats
    santo_domingo:        sdTotal  > 0 ? sdTotal  : (stats?.santoDomingoTotal    ?? 0),
    fuera_de_cobertura:   fcdTotal > 0 ? fcdTotal : (stats?.fueraDeCoberturaTotal ?? 0),
  }), [pedidosTotal, stats, sdTotal, fcdTotal])

  // ── Loading del view actual ─────────────────────────────────────────────────
  const isLoading =
    (viewMode === 'pedidos'              && pedidosLoading)     ||
    (viewMode === 'reintentar'           && queueLoading)       ||
    (viewMode === 'confirmados_sin_guia' && confirmadosLoading) ||
    (viewMode === 'despachados'          && despachadosLoading) ||
    (viewMode === 'santo_domingo'        && sdLoading)          ||
    (viewMode === 'fuera_de_cobertura'   && fcdLoading)

  // ── Datos del view actual ───────────────────────────────────────────────────
  const currentData: Order[] =
    viewMode === 'pedidos'              ? pedidosData    :
    viewMode === 'reintentar'           ? pagedOrders    :
    viewMode === 'confirmados_sin_guia' ? confirmadosData:
    viewMode === 'despachados'          ? despachadosData:
    viewMode === 'santo_domingo'        ? sdData         :
    viewMode === 'fuera_de_cobertura'   ? fcdData        :
    []

  // Para confirmados/despachados (carga total client-side) aplicamos statusFilter en cliente
  const clientFilteredData: Order[] =
    (viewMode === 'confirmados_sin_guia' || viewMode === 'despachados') && statusFilter
      ? currentData.filter(o => matchesStatusFilter(o, statusFilter))
      : currentData

  // ── Metadatos de vistas ─────────────────────────────────────────────────────
  const VIEW_META: { mode: ViewMode; label: string; Icon: React.ElementType; color: string }[] = [
    { mode: 'pedidos',              label: 'Pedidos',       Icon: ShoppingBag,  color: 'indigo' },
    { mode: 'reintentar',           label: 'Reintentar',    Icon: RotateCcw,    color: 'amber'  },
    { mode: 'confirmados_sin_guia', label: 'Confirmados',   Icon: CheckCircle2, color: 'green'  },
    { mode: 'despachados',          label: 'Despachados',   Icon: Truck,        color: 'blue'   },
    { mode: 'santo_domingo',        label: 'Sto. Domingo',  Icon: MapPin,       color: 'teal'   },
    { mode: 'fuera_de_cobertura',   label: 'Sin cobertura', Icon: MapPinOff,    color: 'red'    },
  ]

  // ── Helpers de render ───────────────────────────────────────────────────────
  function renderActionButtons(order: Order) {
    const terminal  = terminalMap[order.id]
    const busy      = !!loadingRow[order.id]
    const isPending = !terminal && (order.confirmation_status as string) === 'pending' && !order.tracking_number
    if (busy)     return <Spinner className="w-4 h-4 text-indigo-500" />
    if (terminal) return (
      <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full
                        ${TERMINAL[terminal]?.color ?? 'bg-gray-100 text-gray-600'}`}>
        <CheckCircle2 className="w-3 h-3" />{TERMINAL[terminal]?.label ?? terminal}
      </span>
    )
    if (!isPending) return null
    return (
      <div className="grid grid-cols-2 gap-1">
        <button onClick={() => postConfirmation(order.id, 'confirmed')}
          className="flex items-center gap-1 bg-green-100 hover:bg-green-200
                     text-green-700 text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap">
          <CheckCircle2 className="w-3 h-3 shrink-0" />Confirmó
        </button>
        <button onClick={() => postConfirmation(order.id, 'no_answer')}
          className="flex items-center gap-1 bg-amber-100 hover:bg-amber-200
                     text-amber-700 text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap">
          <PhoneMissed className="w-3 h-3 shrink-0" />No contesta
        </button>
        <button onClick={() => postConfirmation(order.id, 'no_coverage')}
          className="flex items-center gap-1 bg-orange-100 hover:bg-orange-200
                     text-orange-700 text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap">
          <MapPinOff className="w-3 h-3 shrink-0" />Sin cobertura
        </button>
        <button onClick={() => postConfirmation(order.id, 'cancelled')}
          className="flex items-center gap-1 bg-gray-100 hover:bg-gray-200
                     text-gray-700 text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap">
          <XCircle className="w-3 h-3 shrink-0" />Canceló
        </button>
      </div>
    )
  }

  function renderActionButtonsSD(order: Order) {
    const terminal  = terminalMap[order.id]
    const busy      = !!loadingRow[order.id]
    const isPending = !terminal && (order.confirmation_status as string) === 'pending' && !order.tracking_number
    if (busy)     return <Spinner className="w-4 h-4 text-indigo-500" />
    if (terminal) return (
      <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full
                        ${TERMINAL[terminal]?.color ?? 'bg-gray-100 text-gray-600'}`}>
        <CheckCircle2 className="w-3 h-3" />{TERMINAL[terminal]?.label ?? terminal}
      </span>
    )
    if (!isPending) return null
    // WhatsApp/Llamar NO se repiten aquí — el llamador (columna "Acción" de la
    // tabla Pedidos/Santo Domingo) ya los renderiza una sola vez antes de
    // invocar esta función. Antes había un segundo bloque WA/Llamar duplicado
    // dentro de este componente (fix 2026-07-20).
    return (
      <div className="grid grid-cols-2 gap-1">
        <button onClick={() => postConfirmation(order.id, 'confirmed')}
          className="flex items-center gap-1 bg-green-100 hover:bg-green-200
                     text-green-700 text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap">
          <CheckCircle2 className="w-3 h-3 shrink-0" />Confirmó
        </button>
        <button onClick={() => postConfirmation(order.id, 'no_answer')}
          className="flex items-center gap-1 bg-amber-100 hover:bg-amber-200
                     text-amber-700 text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap">
          <PhoneMissed className="w-3 h-3 shrink-0" />No responde
        </button>
        <button onClick={() => postConfirmation(order.id, 'rescheduled')}
          className="flex items-center gap-1 bg-blue-100 hover:bg-blue-200
                     text-blue-700 text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap">
          <RotateCcw className="w-3 h-3 shrink-0" />Reprogramar
        </button>
        <button onClick={() => postConfirmation(order.id, 'cancelled')}
          className="flex items-center gap-1 bg-gray-100 hover:bg-gray-200
                     text-gray-700 text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap">
          <XCircle className="w-3 h-3 shrink-0" />Ya no desea
        </button>
      </div>
    )
  }

  // ── Render principal ────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <SelectionProvider>
      {/* Vistas server-paginadas (pedidos/santo_domingo/fuera_de_cobertura) solo
          conocen la página actual — la selección en esas vistas se acota a la
          página visible. Reintentar/Confirmados/Despachados cargan el listado
          completo client-side, así que la selección persiste entre páginas. */}
      <SelectionSync
        knownIds={viewMode === 'reintentar' ? filteredOrders.map(o => o.id) : clientFilteredData.map(o => o.id)}
      />

      {/* ── Toast ── */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3
                         rounded-xl shadow-xl text-sm font-semibold animate-in
                         ${toast.type === 'success' ? 'bg-gray-900 text-white' : 'bg-red-600 text-white'}`}>
          {toast.type === 'success'
            ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
            : <XCircle      className="w-4 h-4 text-white shrink-0" />}
          {toast.msg}
        </div>
      )}

      {/* ── Modal: Reabrir pedido ── */}
      <ConfirmActionModal
        open={!!reopenTarget}
        title="Reabrir pedido"
        warning="El pedido volverá a la cola de confirmación (pendiente). Esta acción no borra el historial — queda registrada con tu usuario y el motivo que indiques."
        order={{
          orderNumber:  reopenTarget?.order_number ?? null,
          customerName: reopenTarget?.customer_name ?? null,
          // Hardcoded, no getConfirmBadge(reopenTarget) aquí a propósito:
          // GET /api/confirmados (fuente de confirmadosData) no selecciona
          // confirmation_status — getConfirmBadge() caería a su default
          // 'pending' y mostraría "Pendiente" para TODO pedido, sin importar
          // su estado real (bug verificado en vivo durante la validación de
          // esta fase). El botón "Reabrir pedido" solo se muestra en esta
          // vista ("Confirmados sin guía"), cuyo filtro de servidor ya
          // garantiza confirmation_status='confirmed' para cada fila — el
          // literal es exacto, no una suposición.
          statusLabel: 'Confirmado',
        }}
        confirmLabel="Reabrir pedido"
        busy={reopenBusy}
        error={reopenError}
        onConfirm={submitReopen}
        onClose={() => { setReopenTarget(null); setReopenError(null) }}
      />

      {/* ── Banner ── */}
      <div className="relative overflow-hidden rounded-2xl
                      bg-gradient-to-r from-indigo-500 to-purple-600
                      border-2 border-indigo-400 shadow-lg shadow-indigo-200/50">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white" />
          <div className="absolute -right-2 -bottom-10 w-24 h-24 rounded-full bg-white" />
        </div>
        <div className="relative px-4 py-4 md:px-6 md:py-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 md:gap-4">
            <div className="flex items-center justify-center w-10 h-10 md:w-12 md:h-12 bg-white/20 rounded-xl">
              <Package className="w-5 h-5 md:w-6 md:h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2 md:gap-3">
                <h1 className="text-xl md:text-2xl font-black text-white tabular-nums">
                  {isLoading ? '…' : viewCounts[viewMode].toLocaleString()}
                </h1>
                <span className="flex items-center gap-1.5 bg-white/20 text-white
                                 text-xs font-bold px-2.5 py-1 rounded-full capitalize">
                  {viewMode === 'pedidos'             ? 'total'
                   : viewMode === 'santo_domingo'    ? 'Sto. Domingo'
                   : viewMode === 'fuera_de_cobertura' ? 'Sin cobertura'
                   : viewMode.replace('_', ' ')}
                </span>
              </div>
              <p className="text-white font-semibold text-sm md:text-base">Pedidos Shopify</p>
              <p className="hidden md:block text-indigo-100 text-xs mt-0.5">
                {viewMode === 'pedidos'
                  ? 'Vista completa · Navegación estilo Shopify'
                  : viewMode === 'reintentar'
                    ? '1–2 intentos sin respuesta'
                    : viewMode === 'confirmados_sin_guia'
                      ? 'Confirmados · Pendiente de despacho'
                      : viewMode === 'santo_domingo'
                        ? 'SD/DN · Transporte local · Todas las fechas'
                        : viewMode === 'fuera_de_cobertura'
                          ? 'Sin cobertura · Pedidos no entregables · Todas las fechas'
                          : 'Con guía asignada · En logística'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 md:gap-4 shrink-0">
            {confirmedCount > 0 && (
              <span className="hidden md:inline text-sm text-green-200 font-semibold">
                ✓ {confirmedCount} confirmados esta sesión
              </span>
            )}
            <p className="text-indigo-100 text-xs">
              {lastRefresh.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
            </p>
            <button onClick={refreshAll} disabled={isLoading}
              className="flex items-center gap-2 bg-white/20 hover:bg-white/30 text-white
                         text-sm font-medium px-3 md:px-4 py-2 rounded-lg transition-colors disabled:opacity-50">
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              <span className="hidden md:inline">Refrescar</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Rendimiento del agente hoy ── */}
      {perf && (
        <div className="bg-white rounded-xl border border-gray-200 px-4 md:px-5 py-3.5 shadow-sm">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 shrink-0">
              <TrendingUp className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Mi día</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap flex-1">
              {([
                { label: 'Confirmados',   count: perf.confirmadosHoy,    cls: 'bg-green-100  text-green-700'  },
                { label: 'Contactados',   count: perf.contactadosHoy,    cls: 'bg-blue-100   text-blue-700'   },
                { label: 'No responden',  count: perf.noRespondieronHoy, cls: 'bg-amber-100  text-amber-700'  },
                { label: 'Cancelados',    count: perf.canceladosHoy,     cls: 'bg-gray-100   text-gray-600'   },
                { label: 'Sin cobertura', count: perf.sinCoberturaHoy,   cls: 'bg-orange-100 text-orange-700' },
              ] as const).map(({ label, count, cls }) => (
                <div key={label} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${cls}`}>
                  <span className="text-sm font-black tabular-nums leading-none">{count}</span>
                  <span className="text-[11px] font-medium">{label}</span>
                </div>
              ))}
            </div>
            {perf.tasaConfirmacionHoy !== null ? (
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg shrink-0
                ${perf.tasaConfirmacionHoy >= 70
                  ? 'bg-green-100 text-green-700'
                  : perf.tasaConfirmacionHoy >= 40
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-red-100 text-red-700'}`}>
                <span className="text-[11px] font-semibold opacity-60 leading-none">Tasa</span>
                <span className="text-xl font-black tabular-nums leading-none">{perf.tasaConfirmacionHoy}%</span>
              </div>
            ) : (
              <span className="text-xs text-gray-400 shrink-0">Sin contactos hoy</span>
            )}
          </div>
        </div>
      )}

      {/* ── Pipeline de navegación ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <div className="flex items-stretch divide-x divide-gray-100 min-w-[320px]">
            <div className="flex-1 flex items-center gap-2 md:gap-3 px-3 md:px-5 py-3.5 bg-indigo-600">
              <ClipboardList className="w-4 md:w-5 h-4 md:h-5 text-indigo-200 shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-indigo-200 uppercase tracking-wider">Paso 1</p>
                <p className="text-xs md:text-sm font-bold text-white leading-tight">Confirmación</p>
                <p className="text-xl md:text-2xl font-black tabular-nums text-white leading-none">
                  {isLoading && viewMode === 'pedidos' ? '…' : (stats?.pendingTotal ?? queueTotal)}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-center w-7 md:w-8 bg-gray-50 shrink-0">
              <ChevronRight className="w-4 h-4 text-gray-300" />
            </div>
            <Link href="/confirmados"
              className="flex-1 flex items-center gap-2 md:gap-3 px-3 md:px-5 py-3.5 hover:bg-green-50 transition-colors group">
              <CheckCircle2 className="w-4 md:w-5 h-4 md:h-5 text-gray-300 group-hover:text-green-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Paso 2</p>
                <p className="text-xs md:text-sm font-bold text-gray-600 group-hover:text-green-700 leading-tight">Sin guía</p>
                <p className="text-xl md:text-2xl font-black tabular-nums text-green-600 leading-none">
                  {stats ? stats.confirmadosSinGuia : '…'}
                </p>
              </div>
            </Link>
            <div className="flex items-center justify-center w-7 md:w-8 bg-gray-50 shrink-0">
              <ChevronRight className="w-4 h-4 text-gray-300" />
            </div>
            <Link href="/despachados"
              className="flex-1 flex items-center gap-2 md:gap-3 px-3 md:px-5 py-3.5 hover:bg-blue-50 transition-colors group">
              <Truck className="w-4 md:w-5 h-4 md:h-5 text-gray-300 group-hover:text-blue-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Paso 3</p>
                <p className="text-xs md:text-sm font-bold text-gray-600 group-hover:text-blue-700 leading-tight">Despachados</p>
                <p className="text-xl md:text-2xl font-black tabular-nums text-blue-600 leading-none">
                  {stats ? stats.despachados : '…'}
                </p>
              </div>
            </Link>
            <div className="flex items-center justify-center w-7 md:w-8 bg-gray-50 shrink-0">
              <ChevronRight className="w-4 h-4 text-gray-300" />
            </div>
            <Link href="/confirmados?tab=entregados"
              className="flex-1 flex items-center gap-2 md:gap-3 px-3 md:px-5 py-3.5 hover:bg-emerald-50 transition-colors group">
              <PackageCheck className="w-4 md:w-5 h-4 md:h-5 text-gray-300 group-hover:text-emerald-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Paso 4</p>
                <p className="text-xs md:text-sm font-bold text-gray-600 group-hover:text-emerald-700 leading-tight">Entregados</p>
                <p className="text-xl md:text-2xl font-black tabular-nums text-emerald-600 leading-none">
                  {stats ? stats.entregadosSd : '…'}
                </p>
              </div>
            </Link>
          </div>
        </div>
      </div>

      {/* ── Stats cards operativas ── */}
      {stats && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
            {/* KPI visual — no navega a ningún tab */}
            <div className="flex items-center gap-2 md:gap-3 p-3 md:p-4 rounded-xl border-2
                            border-indigo-200 bg-indigo-50 text-indigo-700">
              <div className="flex-1 min-w-0">
                <p className="text-2xl md:text-3xl font-black tabular-nums leading-none">{stats.nuevos}</p>
                <p className="text-xs md:text-sm font-bold mt-1">Nuevos hoy</p>
                <p className="hidden md:block text-xs opacity-60 mt-0.5 truncate">Pending · sin guía · 0 intentos</p>
              </div>
              <Inbox className="w-6 md:w-7 h-6 md:h-7 opacity-25 shrink-0" />
            </div>
            {/* Tabs operativos — navegan a su vista */}
            {([
              { mode: 'reintentar'           as ViewMode, count: stats.reintentar,         label: 'Reintentar',          sub: '1–2 intentos sin resp.', Icon: RotateCcw,    base: 'border-amber-200 bg-amber-50 text-amber-700',  active: 'border-amber-400  bg-amber-100  text-amber-800  ring-2 ring-amber-300/50'  },
              { mode: 'confirmados_sin_guia' as ViewMode, count: stats.confirmadosSinGuia, label: 'Confirmados sin guía', sub: 'Listos para despacho',   Icon: CheckCircle2, base: 'border-green-200 bg-green-50 text-green-700',  active: 'border-green-400  bg-green-100  text-green-800  ring-2 ring-green-300/50'  },
              { mode: 'despachados'          as ViewMode, count: stats.despachados,        label: 'Despachados',          sub: 'Con guía en logística',  Icon: Truck,        base: 'border-blue-200  bg-blue-50  text-blue-700',   active: 'border-blue-400   bg-blue-100   text-blue-800   ring-2 ring-blue-300/50'   },
            ]).map(({ mode, count, label, sub, Icon, base, active }) => (
              <button key={mode}
                onClick={() => setViewMode(prev => prev === mode ? 'pedidos' : mode)}
                className={`flex items-center gap-2 md:gap-3 p-3 md:p-4 rounded-xl border-2 text-left transition-all
                  ${viewMode === mode ? active : `${base} hover:opacity-80`}`}>
                <div className="flex-1 min-w-0">
                  <p className="text-2xl md:text-3xl font-black tabular-nums leading-none">{count}</p>
                  <p className="text-xs md:text-sm font-bold mt-1">{label}</p>
                  <p className="hidden md:block text-xs opacity-60 mt-0.5 truncate">{sub}</p>
                </div>
                <Icon className="w-6 md:w-7 h-6 md:h-7 opacity-25 shrink-0" />
              </button>
            ))}
          </div>

          {/* ── Tabs rápidos: Santo Domingo + Fuera de cobertura ── */}
          <div className="grid grid-cols-2 gap-2 md:gap-3">
            {([
              {
                mode:   'santo_domingo'      as ViewMode,
                count:  viewCounts.santo_domingo,
                label:  'Santo Domingo',
                sub:    'SD/DN · Transporte local · Todas las fechas',
                Icon:   MapPin,
                base:   'border-teal-200 bg-teal-50 text-teal-700',
                active: 'border-teal-400  bg-teal-100  text-teal-800  ring-2 ring-teal-300/50',
              },
              {
                mode:   'fuera_de_cobertura' as ViewMode,
                count:  viewCounts.fuera_de_cobertura,
                label:  'Fuera de cobertura',
                sub:    'Sin cobertura · Pedidos no entregables · Todas las fechas',
                Icon:   MapPinOff,
                base:   'border-red-200 bg-red-50 text-red-700',
                active: 'border-red-400  bg-red-100  text-red-800  ring-2 ring-red-300/50',
              },
            ]).map(({ mode, count, label, sub, Icon, base, active }) => (
              <button key={mode}
                onClick={() => setViewMode(prev => prev === mode ? 'pedidos' : mode)}
                className={`flex items-center gap-2 md:gap-3 p-3 md:p-4 rounded-xl border-2 text-left transition-all
                  ${viewMode === mode ? active : `${base} hover:opacity-80`}`}>
                <div className="flex-1 min-w-0">
                  <p className="text-2xl md:text-3xl font-black tabular-nums leading-none">{count}</p>
                  <p className="text-xs md:text-sm font-bold mt-1">{label}</p>
                  <p className="hidden md:block text-xs opacity-60 mt-0.5 truncate">{sub}</p>
                </div>
                <Icon className="w-6 md:w-7 h-6 md:h-7 opacity-25 shrink-0" />
              </button>
            ))}
          </div>

          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
            {([
              { label: 'Confirm. hoy',   count: stats.confirmadosHoy, cls: 'bg-green-50   text-green-700   border-green-100'  },
              { label: 'Contactados hoy',count: stats.contactadosHoy, cls: 'bg-blue-50    text-blue-700    border-blue-100'   },
              { label: 'Sin respuesta',  count: stats.sinRespuesta,   cls: 'bg-amber-50   text-amber-700   border-amber-100'  },
              { label: 'Inalcanzables',  count: stats.inalcanzables,  cls: 'bg-red-50     text-red-700     border-red-100'    },
              { label: 'No desean',      count: stats.noDesean,       cls: 'bg-gray-50    text-gray-600    border-gray-200'   },
              { label: 'Sin cobertura',  count: stats.sinCobertura,   cls: 'bg-orange-50  text-orange-700  border-orange-100' },
            ] as const).map(({ label, count, cls }) => (
              <div key={label} className={`flex flex-col items-center justify-center p-3 rounded-lg border ${cls}`}>
                <p className="text-xl font-black tabular-nums leading-none">{count}</p>
                <p className="text-[10px] font-medium mt-1 text-center leading-tight opacity-80">{label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Tabla / Vista principal ── */}
      <div className="bg-white rounded-xl border-2 border-indigo-200 overflow-hidden shadow-sm">

        {/* Header informativo */}
        <div className="px-4 md:px-5 py-3 bg-indigo-50 border-b border-indigo-200 flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-indigo-600 shrink-0" />
          <p className="text-xs md:text-sm font-semibold text-indigo-800">
            {viewMode === 'pedidos'
              ? 'Todos los pedidos Shopify · Orden cronológico'
              : viewMode === 'reintentar'
                ? 'Reintentar · 1–2 intentos sin respuesta'
                : viewMode === 'confirmados_sin_guia'
                  ? 'Confirmados sin guía · Pendiente de despacho (solo lectura)'
                  : viewMode === 'santo_domingo'
                    ? `Santo Domingo · Zona SD/DN${dateFilter ? '' : ' · Todas las fechas'} · 50 por página`
                    : viewMode === 'fuera_de_cobertura'
                      ? `Fuera de cobertura · Sin cobertura${dateFilter ? '' : ' · Todas las fechas'} · 50 por página`
                      : 'Despachados · Con guía en logística (solo lectura)'}
          </p>
        </div>

        {/* ── Buscador ── */}
        <div className="px-4 py-2.5 border-b border-indigo-100">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
            <input type="text" value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Buscar por nombre, teléfono, #orden o guía..."
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400
                         placeholder:text-gray-400 bg-white" />
          </div>
        </div>

        {/* ── Filtro de fecha ── */}
        <div className="px-3 py-2 border-b border-indigo-100 flex items-center gap-1.5 flex-wrap bg-gray-50/60">
          <CalendarDays className="w-3.5 h-3.5 text-gray-400 shrink-0" />
          {(['hoy', 'ayer', '7dias', '30dias'] as DateFilter[]).map(f => (
            <button key={f}
              onClick={() => { setDateFilter(prev => prev === f ? null : f); setCurrentPage(1) }}
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors shrink-0
                ${dateFilter === f
                  ? 'bg-indigo-500 text-white border-indigo-500'
                  : 'text-gray-600 border-gray-200 hover:border-indigo-300 hover:text-indigo-600 bg-white'}`}>
              {f === 'hoy' ? 'Hoy' : f === 'ayer' ? 'Ayer' : f === '7dias' ? '7 días' : '30 días'}
            </button>
          ))}
          <button
            onClick={() => { setDateFilter(prev => prev === 'personalizado' ? null : 'personalizado'); setCurrentPage(1) }}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors shrink-0
              ${dateFilter === 'personalizado'
                ? 'bg-indigo-500 text-white border-indigo-500'
                : 'text-gray-600 border-gray-200 hover:border-indigo-300 hover:text-indigo-600 bg-white'}`}>
            Rango
          </button>
          {dateFilter === 'personalizado' && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                className="text-[11px] border border-gray-200 rounded px-2 py-1
                           focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white" />
              <span className="text-[10px] text-gray-400">—</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                className="text-[11px] border border-gray-200 rounded px-2 py-1
                           focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white" />
              <button onClick={() => { setDateApplied(true); setPedidosPage(1); setCurrentPage(1) }}
                className="text-[11px] bg-indigo-600 text-white px-2.5 py-1 rounded-full hover:bg-indigo-700 shrink-0">
                Aplicar
              </button>
            </div>
          )}
          {dateFilter && (
            <button onClick={() => { setDateFilter(null); setDateFrom(''); setDateTo(''); setDateApplied(false); setCurrentPage(1); setPedidosPage(1) }}
              className="text-[11px] text-gray-400 hover:text-red-500 ml-auto shrink-0">
              ✕ Limpiar
            </button>
          )}
        </div>

        {/* ── Filtro de estado ── */}
        <div className="px-3 py-2 border-b border-indigo-100 flex items-center gap-2 flex-wrap bg-gray-50/60">
          <ListFilter className="w-3.5 h-3.5 text-gray-400 shrink-0" />
          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value as ConfirmStatusFilter); setCurrentPage(1) }}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors cursor-pointer
              ${statusFilter
                ? 'bg-indigo-500 text-white border-indigo-500'
                : 'text-gray-600 border-gray-200 bg-white hover:border-indigo-300 hover:text-indigo-600'}`}>
            <option value=''>Estado: Todos</option>
            <option value='pending'>Pendiente</option>
            <option value='reintentar'>No contesta</option>
            <option value='confirmed'>Confirmado</option>
            <option value='cancelled'>Canceló</option>
            <option value='no_coverage'>Sin cobertura</option>
            <option value='unreachable'>Inalcanzable</option>
          </select>
          {statusFilter && (
            <button
              onClick={() => { setStatusFilter(''); setCurrentPage(1) }}
              className="text-[11px] text-gray-400 hover:text-red-500 ml-auto shrink-0">
              ✕ Limpiar
            </button>
          )}
        </div>

        {/* ── Filtro de pago (solo Santo Domingo — única vista con payment_status) ── */}
        {viewMode === 'santo_domingo' && (
          <div className="px-3 py-2 border-b border-indigo-100 flex items-center gap-1.5 flex-wrap bg-teal-50/40">
            <span className="text-[11px] font-semibold text-teal-800 mr-0.5">Pago:</span>
            {([
              { key: 'todos',     label: 'Todos' },
              { key: 'pendiente', label: 'Pendientes' },
              { key: 'pagado',    label: 'Pagados' },
            ] as { key: SdPaymentFilter; label: string }[]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSdPaymentFilter(key)}
                className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors
                  ${sdPaymentFilter === key
                    ? 'bg-teal-600 text-white border-teal-600'
                    : 'text-teal-700 border-teal-200 bg-white hover:border-teal-400'}`}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* ── Tab bar (5 vistas) ── */}
        <>
          {/* Mobile: select */}
          <div className="md:hidden px-3 py-2 border-b border-indigo-100">
            <select value={viewMode} onChange={e => setViewMode(e.target.value as ViewMode)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white">
              {VIEW_META.map(({ mode, label }) => (
                <option key={mode} value={mode}>{label} ({viewCounts[mode]})</option>
              ))}
            </select>
          </div>
          {/* Desktop: tabs */}
          <div className="hidden md:flex overflow-x-auto border-b border-indigo-100">
            <div className="flex min-w-max">
              {VIEW_META.map(({ mode, label }) => (
                <button key={mode} onClick={() => setViewMode(mode)}
                  className={`flex items-center gap-1.5 min-h-[40px] px-4 py-2 text-xs font-semibold
                              border-b-2 transition-colors whitespace-nowrap
                    ${viewMode === mode
                      ? 'border-indigo-500 text-indigo-700 bg-indigo-50/60'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}>
                  {label}
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full
                    ${viewMode === mode ? 'bg-indigo-500 text-white' : 'bg-gray-100 text-gray-500'}`}>
                    {viewCounts[mode]}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>

        {/* ── Contenido ── */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner className="w-6 h-6 text-indigo-500" />
          </div>
        ) : clientFilteredData.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-gray-500 font-medium">No hay pedidos en esta vista</p>
            {viewMode === 'reintentar' && (
              <button onClick={() => setViewMode('pedidos')}
                className="text-indigo-500 text-sm mt-2 hover:underline">
                Ver todos los pedidos
              </button>
            )}
          </div>
        ) : (
          <>
            {/* ──────────────────────────────────────────────────────────────── */}
            {/* VISTA: PEDIDOS / SANTO DOMINGO (estilo Shopify) */}
            {/* Santo Domingo reutiliza el mismo rendering que Pedidos,          */}
            {/* pero con sdData en lugar de pedidosData.                        */}
            {/* ──────────────────────────────────────────────────────────────── */}
            {(viewMode === 'pedidos' || viewMode === 'santo_domingo') && (() => {
              const displayData = viewMode === 'santo_domingo' ? sdData : pedidosData
              return (
              <>
                {/* Mobile cards */}
                <div className="md:hidden divide-y divide-gray-100">
                  {displayData.map(order => (
                    <div key={order.id} ref={el => { if (el) rowRefs.current.set(order.id, el) }}>
                      <PedidoCard
                        order={order} busy={!!loadingRow[order.id]} terminal={terminalMap[order.id]}
                        onConfirmed={() => postConfirmation(order.id, 'confirmed')}
                        onNoAnswer={() => postConfirmation(order.id, 'no_answer')}
                        onNoCoverage={() => postConfirmation(order.id, 'no_coverage')}
                        onCancelled={() => postConfirmation(order.id, 'cancelled')}
                        onSetMethod={m => setMethodMap(prev => ({ ...prev, [order.id]: m }))}
                        onPaidSuccess={() => {
                          showToast('✓ Pedido marcado como pagado', 'success')
                          const patch = (o: Order): Order =>
                            o.id === order.id ? { ...o, payment_status: 'paid', normalized_status: 'delivered' } : o
                          setSdData(prev => prev.map(patch))
                          setPedidosData(prev => prev.map(patch))
                          if (viewMode === 'santo_domingo') fetchSD(sdPage, searchQuery, statusFilter, sdPaymentFilter)
                          else fetchPedidos(pedidosPage, searchQuery, dateFilter, dateFrom, dateTo, dateApplied, statusFilter)
                          fetchStats()
                        }}
                      />
                    </div>
                  ))}
                </div>
                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-3 w-8">
                          <SelectionHeaderCheckbox visibleIds={displayData.map(o => o.id)} />
                        </th>
                        {['Fecha / Orden', 'Cliente', 'Ciudad / Producto', 'Monto',
                          'Estado confirm.', 'Estado logística', 'Acción', ''].map(h => (
                          <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-gray-600 whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {displayData.map(order => {
                        const nombre      = order.customer_name ?? ''
                        const waUrl       = whatsAppUrl(order.customer_phone, buildConfirmMsg(nombre, order.product_summary, order.cod_amount))
                        const telUrl      = callUrl(order.customer_phone)
                        const hasPhone    = !!order.customer_phone
                        const terminal    = terminalMap[order.id]
                        const confBadge   = getConfirmBadge(order, terminal)
                        const logBadge    = getLogisticsBadge(order)
                        const delay       = getDelayBadge(order)
                        const isPending   = !terminal && (order.confirmation_status as string) === 'pending' && !order.tracking_number
                        const hasDup      = !!order.duplicate_alert
                        const cov         = checkCoverage(order.customer_address, order.city, order.province)
                        const hasAlert    = hasDup || cov.isOutOfCoverage || cov.isUnknownZone
                        return (
                          <tr key={order.id}
                            ref={el => { if (el) rowRefs.current.set(order.id, el) }}
                            className={`transition-colors group
                              ${hasAlert ? 'bg-amber-50/30 hover:bg-amber-50/60' : 'hover:bg-gray-50/60'}`}>
                            <td className="px-3 py-2.5">
                              <SelectionCheckbox id={order.id} label={`Seleccionar pedido ${order.order_number ?? order.id}`} />
                            </td>

                            {/* Fecha / Orden */}
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <p className="text-xs font-semibold text-gray-700">
                                {formatOrderTime(order.shopify_created_at ?? order.created_at)}
                              </p>
                              <p className="font-mono text-[10px] text-gray-400 mt-0.5">
                                {order.order_number ?? '—'}
                              </p>
                              {delay && (
                                <span className={`inline-flex text-[10px] px-1.5 py-0.5 rounded-full mt-0.5 ${delay.cls}`}>
                                  {delay.label}
                                </span>
                              )}
                            </td>

                            {/* Cliente */}
                            <td className="px-3 py-2.5">
                              <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[150px]">
                                {nombre || '—'}
                              </p>
                              <p className="font-mono text-xs text-gray-500 mt-0.5">
                                {order.customer_phone ?? '—'}
                              </p>
                              <AlertBadges duplicateAlert={order.duplicate_alert}
                                customerAddress={order.customer_address}
                                city={order.city} province={order.province} />
                            </td>

                            {/* Ciudad / Producto */}
                            <td className="px-3 py-2.5 max-w-[130px]">
                              <div className="flex items-center gap-1 text-gray-700">
                                <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                                <span className="text-xs truncate">{order.city || '—'}</span>
                              </div>
                              <p className="text-[10px] text-gray-400 truncate mt-0.5">
                                {order.product_summary ?? ''}
                              </p>
                            </td>

                            {/* Monto */}
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <p className="text-sm font-semibold text-green-700">
                                {formatCurrency(order.cod_amount)}
                              </p>
                            </td>

                            {/* Estado confirmación */}
                            <td className="px-3 py-2.5">
                              <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full ${confBadge.cls}`}>
                                {confBadge.label}
                              </span>
                              {confBadge.label === 'Pagado' && (
                                <p className="text-[10px] text-gray-500 mt-0.5 whitespace-nowrap">
                                  {order.paid_at ? formatEventDate(order.paid_at) : 'Fecha de pago no disponible'}
                                  <br />Por: {order.paid_by_name ?? 'Usuario no disponible'}
                                </p>
                              )}
                            </td>

                            {/* Estado logística */}
                            <td className="px-3 py-2.5">
                              <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full ${logBadge.cls}`}>
                                {logBadge.label}
                              </span>
                              {order.tracking_number && (
                                <p className="font-mono text-[10px] text-gray-400 mt-0.5 truncate max-w-[120px]">
                                  {order.tracking_number}
                                </p>
                              )}
                            </td>

                            {/* Acción */}
                            <td className="px-3 py-2.5">
                              {viewMode === 'santo_domingo' && isPagoPendiente(order) ? (
                                <MarkPaidButton
                                  orderId={order.id}
                                  onSuccess={() => {
                                    showToast('✓ Pedido marcado como pagado', 'success')
                                    setSdData(prev => prev.map(o =>
                                      o.id === order.id ? { ...o, payment_status: 'paid', normalized_status: 'delivered' } : o))
                                    fetchSD(sdPage, searchQuery, statusFilter, sdPaymentFilter)
                                    fetchStats()
                                  }}
                                />
                              ) : isPending ? (
                                <div className="flex flex-col gap-1">
                                  {hasPhone && (
                                    <div className="flex gap-1">
                                      {waUrl && (
                                        <a href={waUrl} target="_blank" rel="noopener noreferrer"
                                           onClick={() => setMethodMap(prev => ({ ...prev, [order.id]: 'whatsapp' }))}
                                           className="flex items-center gap-1 bg-green-500 hover:bg-green-600
                                                      text-white text-[11px] font-semibold px-2 py-1 rounded-lg">
                                          <MessageCircle className="w-3 h-3" />WhatsApp
                                        </a>
                                      )}
                                      {telUrl && (
                                        <a href={telUrl}
                                           onClick={() => setMethodMap(prev => ({ ...prev, [order.id]: 'call' }))}
                                           className="flex items-center gap-1 bg-blue-500 hover:bg-blue-600
                                                      text-white text-[11px] font-semibold px-2 py-1 rounded-lg">
                                          <Phone className="w-3 h-3" />Llamar
                                        </a>
                                      )}
                                    </div>
                                  )}
                                  {viewMode === 'santo_domingo' ? renderActionButtonsSD(order) : renderActionButtons(order)}
                                </div>
                              ) : (
                                viewMode === 'santo_domingo' ? renderActionButtonsSD(order) : renderActionButtons(order)
                              )}
                            </td>

                            {/* Ver detalle */}
                            <td className="px-3 py-2.5">
                              <Link href={`/orders/${order.id}`}
                                className="inline-flex items-center gap-1 text-xs font-medium
                                           text-indigo-600 hover:text-indigo-800 whitespace-nowrap hover:underline">
                                <ExternalLink className="w-3 h-3" />Ver
                              </Link>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
              )
            })()}

            {/* ──────────────────────────────────────────────────────────────── */}
            {/* VISTA: REINTENTAR (cola operativa con acciones) */}
            {/* ──────────────────────────────────────────────────────────────── */}
            {viewMode === 'reintentar' && (
              <>
                {/* Mobile cards */}
                <div className="md:hidden divide-y divide-indigo-50">
                  {pagedOrders.map(order => {
                    const terminal      = terminalMap[order.id]
                    const sessionAtt    = attemptsMap[order.id]
                    const totalAttempts = sessionAtt ?? (order.confirmation_attempts ?? 0)
                    const confidence    = confidenceMap[order.id] ?? order.confirmation_confidence ?? undefined
                    const busy          = !!loadingRow[order.id]
                    const isHighlighted = !!(trackingParam && order.tracking_number === trackingParam)
                    return (
                      <div key={order.id} ref={el => { if (el) rowRefs.current.set(order.id, el) }}>
                        <ConfirmacionCard
                          order={order} terminal={terminal} totalAttempts={totalAttempts}
                          confidence={confidence} busy={busy} isHighlighted={isHighlighted}
                          onConfirmed={() => postConfirmation(order.id, 'confirmed')}
                          onNoAnswer={() => postConfirmation(order.id, 'no_answer')}
                          onNoCoverage={() => postConfirmation(order.id, 'no_coverage')}
                          onCancelled={() => postConfirmation(order.id, 'cancelled')}
                          onSetMethod={m => setMethodMap(prev => ({ ...prev, [order.id]: m }))}
                        />
                      </div>
                    )
                  })}
                </div>
                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-indigo-50/60 border-b border-indigo-100">
                      <tr>
                        <th className="px-4 py-3 w-8">
                          <SelectionHeaderCheckbox visibleIds={pagedOrders.map(o => o.id)} />
                        </th>
                        {['Cliente','Ubicación','Monto','Estado','Intentos','Contactar','Acción',''].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-indigo-800 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-indigo-50">
                      {pagedOrders.map(order => {
                        const nombre        = order.customer_name ?? ''
                        const waUrl         = whatsAppUrl(order.customer_phone, buildConfirmMsg(nombre, order.product_summary, order.cod_amount))
                        const telUrl        = callUrl(order.customer_phone)
                        const hasPhone      = !!order.customer_phone
                        const busy          = !!loadingRow[order.id]
                        const terminal      = terminalMap[order.id]
                        const sessionAtt    = attemptsMap[order.id]
                        const totalAttempts = sessionAtt ?? (order.confirmation_attempts ?? 0)
                        const delay         = getDelayBadge(order)
                        const hasDup        = !!order.duplicate_alert
                        const cov           = checkCoverage(order.customer_address, order.city, order.province)
                        const hasAlert      = hasDup || cov.isOutOfCoverage || cov.isUnknownZone
                        const isHighlighted = !!(trackingParam && order.tracking_number === trackingParam)
                        const confBadge     = getConfirmBadge(order, terminal)
                        const confidence    = confidenceMap[order.id] ?? order.confirmation_confidence
                        return (
                          <tr key={order.id}
                            ref={el => { if (el) rowRefs.current.set(order.id, el) }}
                            className={`transition-colors group
                              ${isHighlighted ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/60'
                                : hasAlert ? 'bg-amber-50/40 hover:bg-amber-50/70'
                                  : 'hover:bg-indigo-50/30'}`}>
                            <td className="px-3 py-2.5">
                              <SelectionCheckbox id={order.id} label={`Seleccionar pedido ${order.order_number ?? order.id}`} />
                            </td>

                            <td className="px-3 py-2.5">
                              <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[160px]">
                                {nombre || '—'}
                              </p>
                              <p className="font-mono text-xs text-gray-500 mt-0.5">{order.customer_phone ?? '—'}</p>
                              <p className="font-mono text-[10px] text-gray-400 mt-0.5">
                                {order.order_number ?? '—'} · {formatOrderTime(order.shopify_created_at ?? order.created_at)}
                              </p>
                              {delay && (
                                <span className={`inline-flex text-[10px] px-1.5 py-0.5 rounded-full mt-0.5 ${delay.cls}`}>
                                  {delay.label}
                                </span>
                              )}
                              <AlertBadges duplicateAlert={order.duplicate_alert}
                                customerAddress={order.customer_address}
                                city={order.city} province={order.province} />
                            </td>

                            <td className="px-3 py-2.5 max-w-[140px]">
                              <div className="flex items-center gap-1 text-gray-700">
                                <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                                <span className="text-xs truncate">{order.city || '—'}</span>
                              </div>
                              <p className="text-[10px] text-gray-400 truncate mt-0.5">{order.product_summary ?? ''}</p>
                            </td>

                            <td className="px-3 py-2.5">
                              <p className="text-sm font-semibold text-green-700 whitespace-nowrap">
                                {formatCurrency(order.cod_amount)}
                              </p>
                            </td>

                            <td className="px-3 py-2.5">
                              <div className="flex flex-col gap-1">
                                <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full w-fit ${confBadge.cls}`}>
                                  {confBadge.label}
                                </span>
                                {confidence && CONFIDENCE[confidence] && (
                                  <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full w-fit ${CONFIDENCE[confidence].cls}`}>
                                    {CONFIDENCE[confidence].label}
                                  </span>
                                )}
                              </div>
                            </td>

                            <td className="px-3 py-2.5">
                              {totalAttempts > 0 ? (
                                <span className={`text-xs font-bold px-2 py-0.5 rounded-full
                                  ${totalAttempts >= MAX_ATTEMPTS ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                                  {totalAttempts}/{MAX_ATTEMPTS}
                                </span>
                              ) : <span className="text-xs text-gray-400">—</span>}
                            </td>

                            <td className="px-3 py-2.5">
                              {hasPhone ? (
                                <div className="flex items-center gap-2">
                                  {waUrl && (
                                    <a href={waUrl} target="_blank" rel="noopener noreferrer"
                                       onClick={() => setMethodMap(prev => ({ ...prev, [order.id]: 'whatsapp' }))}
                                       className="flex items-center gap-1 bg-green-500 hover:bg-green-600
                                                  text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg shadow-sm">
                                      <MessageCircle className="w-3.5 h-3.5" />WA
                                    </a>
                                  )}
                                  {telUrl && (
                                    <a href={telUrl}
                                       onClick={() => setMethodMap(prev => ({ ...prev, [order.id]: 'call' }))}
                                       className="flex items-center gap-1 bg-blue-500 hover:bg-blue-600
                                                  text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg shadow-sm">
                                      <Phone className="w-3.5 h-3.5" />Llamar
                                    </a>
                                  )}
                                </div>
                              ) : <span className="text-xs text-gray-300 italic">Sin teléfono</span>}
                            </td>

                            <td className="px-3 py-2.5">
                              {busy ? <Spinner className="w-4 h-4 text-indigo-500" />
                                : renderActionButtons(order)}
                            </td>

                            <td className="px-3 py-2.5">
                              <Link href={`/orders/${order.id}`}
                                className="inline-flex items-center gap-1 text-xs font-medium
                                           text-indigo-600 hover:text-indigo-800 whitespace-nowrap hover:underline">
                                <ExternalLink className="w-3 h-3" />Ver
                              </Link>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* ──────────────────────────────────────────────────────────────── */}
            {/* VISTAS: CONFIRMADOS SIN GUÍA / DESPACHADOS / FUERA COBERTURA    */}
            {/* (read-only — misma estructura de tabla, sin botones de acción)   */}
            {/* ──────────────────────────────────────────────────────────────── */}
            {(viewMode === 'confirmados_sin_guia' || viewMode === 'despachados' || viewMode === 'fuera_de_cobertura') && (
              <>
                {/* Mobile cards */}
                <div className="md:hidden divide-y divide-gray-100">
                  {clientFilteredData.map(order => (
                    <div key={order.id}>
                      <ReadOnlyCard
                        order={order}
                        onReopen={viewMode === 'confirmados_sin_guia' && canReopen ? setReopenTarget : undefined}
                      />
                    </div>
                  ))}
                </div>
                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-3 w-8">
                          <SelectionHeaderCheckbox visibleIds={clientFilteredData.map(o => o.id)} />
                        </th>
                        {['Fecha / Orden', 'Cliente', 'Ciudad', 'Monto',
                          'Estado confirm.', 'Estado logística',
                          ...(viewMode === 'despachados' ? ['Guía / Último mov.'] : []),
                          ...(viewMode === 'confirmados_sin_guia' && canReopen ? ['Acción'] : []),
                          ''].map(h => (
                          <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {clientFilteredData.map(order => {
                        const confBadge = getConfirmBadge(order)
                        const logBadge  = getLogisticsBadge(order)
                        const hasDup    = !!order.duplicate_alert
                        const cov       = checkCoverage(order.customer_address, order.city, order.province)
                        const hasAlert  = hasDup || cov.isOutOfCoverage || cov.isUnknownZone
                        return (
                          <tr key={order.id}
                            className={`transition-colors hover:bg-gray-50/60
                              ${hasAlert ? 'bg-amber-50/20' : ''}`}>
                            <td className="px-3 py-2.5">
                              <SelectionCheckbox id={order.id} label={`Seleccionar pedido ${order.order_number ?? order.id}`} />
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <p className="text-xs font-semibold text-gray-700">
                                {formatOrderTime(order.shopify_created_at ?? order.created_at)}
                              </p>
                              <p className="font-mono text-[10px] text-gray-400 mt-0.5">{order.order_number ?? '—'}</p>
                            </td>
                            <td className="px-3 py-2.5">
                              <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[150px]">
                                {order.customer_name || '—'}
                              </p>
                              <p className="font-mono text-xs text-gray-500 mt-0.5">{order.customer_phone ?? '—'}</p>
                              <AlertBadges duplicateAlert={order.duplicate_alert}
                                customerAddress={order.customer_address}
                                city={order.city} province={order.province} />
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-1 text-gray-700">
                                <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                                <span className="text-xs truncate max-w-[100px]">{order.city || '—'}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <p className="text-sm font-semibold text-green-700">{formatCurrency(order.cod_amount)}</p>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full ${confBadge.cls}`}>
                                {confBadge.label}
                              </span>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full ${logBadge.cls}`}>
                                {logBadge.label}
                              </span>
                            </td>
                            {viewMode === 'despachados' && (
                              <td className="px-3 py-2.5">
                                <p className="font-mono text-[10px] text-gray-500 truncate max-w-[120px]">
                                  {order.tracking_number ?? '—'}
                                </p>
                                {order.last_tracking_update && (
                                  <p className="text-[10px] text-gray-400 mt-0.5">
                                    {formatOrderTime(order.last_tracking_update)}
                                  </p>
                                )}
                              </td>
                            )}
                            {viewMode === 'confirmados_sin_guia' && canReopen && (
                              <td className="px-3 py-2.5">
                                <button
                                  onClick={() => setReopenTarget(order)}
                                  className="inline-flex items-center gap-1 text-xs font-semibold
                                             text-amber-700 border border-amber-200 rounded-lg px-2 py-1
                                             hover:bg-amber-50 whitespace-nowrap">
                                  <RotateCcw className="w-3 h-3" />Reabrir
                                </button>
                              </td>
                            )}
                            <td className="px-3 py-2.5">
                              <Link href={`/orders/${order.id}`}
                                className="inline-flex items-center gap-1 text-xs font-medium
                                           text-indigo-600 hover:text-indigo-800 whitespace-nowrap hover:underline">
                                <ExternalLink className="w-3 h-3" />Ver
                              </Link>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        {/* ── Paginación ── */}
        {viewMode === 'pedidos' && !pedidosLoading && pedidosPages > 1 && (
          <div className="flex items-center justify-between px-4 md:px-5 py-3 border-t border-indigo-100 bg-indigo-50/40">
            <button onClick={() => setPedidosPage(p => Math.max(1, p - 1))} disabled={pedidosPage === 1}
              className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg
                         border border-indigo-200 text-indigo-700 bg-white hover:bg-indigo-50
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="w-3.5 h-3.5" />Anterior
            </button>
            <span className="text-xs text-gray-500 tabular-nums">
              <span className="hidden md:inline">Página </span>
              <span className="font-bold text-gray-800">{pedidosPage}</span>
              <span className="hidden md:inline"> de </span><span className="md:hidden">/</span>
              <span className="font-bold text-gray-800">{pedidosPages}</span>
              <span className="hidden md:inline"> · <span className="text-gray-400">{pedidosTotal} pedidos</span></span>
            </span>
            <button onClick={() => setPedidosPage(p => Math.min(pedidosPages, p + 1))} disabled={pedidosPage === pedidosPages}
              className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg
                         border border-indigo-200 text-indigo-700 bg-white hover:bg-indigo-50
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Siguiente<ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {viewMode === 'reintentar' && !queueLoading && totalPages > 1 && (
          <div className="flex items-center justify-between px-4 md:px-5 py-3 border-t border-indigo-100 bg-indigo-50/40">
            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}
              className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg
                         border border-indigo-200 text-indigo-700 bg-white hover:bg-indigo-50
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="w-3.5 h-3.5" />Anterior
            </button>
            <span className="text-xs text-gray-500 tabular-nums">
              <span className="font-bold text-gray-800">{currentPage}</span>
              <span className="md:hidden">/</span>
              <span className="hidden md:inline"> de </span>
              <span className="font-bold text-gray-800">{totalPages}</span>
              <span className="hidden md:inline"> · <span className="text-gray-400">{filteredOrders.length} resultados</span></span>
            </span>
            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}
              className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg
                         border border-indigo-200 text-indigo-700 bg-white hover:bg-indigo-50
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Siguiente<ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* ── Paginación: Santo Domingo ── */}
        {viewMode === 'santo_domingo' && !sdLoading && sdPages > 1 && (
          <div className="flex items-center justify-between px-4 md:px-5 py-3 border-t border-teal-100 bg-teal-50/40">
            <button onClick={() => setSdPage(p => Math.max(1, p - 1))} disabled={sdPage === 1}
              className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg
                         border border-teal-200 text-teal-700 bg-white hover:bg-teal-50
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="w-3.5 h-3.5" />Anterior
            </button>
            <span className="text-xs text-gray-500 tabular-nums">
              <span className="hidden md:inline">Página </span>
              <span className="font-bold text-gray-800">{sdPage}</span>
              <span className="hidden md:inline"> de </span><span className="md:hidden">/</span>
              <span className="font-bold text-gray-800">{sdPages}</span>
              <span className="hidden md:inline"> · <span className="text-gray-400">{sdTotal} pedidos SD</span></span>
            </span>
            <button onClick={() => setSdPage(p => Math.min(sdPages, p + 1))} disabled={sdPage === sdPages}
              className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg
                         border border-teal-200 text-teal-700 bg-white hover:bg-teal-50
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Siguiente<ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* ── Paginación: Fuera de cobertura ── */}
        {viewMode === 'fuera_de_cobertura' && !fcdLoading && fcdPages > 1 && (
          <div className="flex items-center justify-between px-4 md:px-5 py-3 border-t border-red-100 bg-red-50/40">
            <button onClick={() => setFcdPage(p => Math.max(1, p - 1))} disabled={fcdPage === 1}
              className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg
                         border border-red-200 text-red-700 bg-white hover:bg-red-50
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="w-3.5 h-3.5" />Anterior
            </button>
            <span className="text-xs text-gray-500 tabular-nums">
              <span className="hidden md:inline">Página </span>
              <span className="font-bold text-gray-800">{fcdPage}</span>
              <span className="hidden md:inline"> de </span><span className="md:hidden">/</span>
              <span className="font-bold text-gray-800">{fcdPages}</span>
              <span className="hidden md:inline"> · <span className="text-gray-400">{fcdTotal} sin cobertura</span></span>
            </span>
            <button onClick={() => setFcdPage(p => Math.min(fcdPages, p + 1))} disabled={fcdPage === fcdPages}
              className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg
                         border border-red-200 text-red-700 bg-white hover:bg-red-50
                         disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Siguiente<ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      <SelectionBulkActionBar>
        <PrintCodLabelsBatchButton />
      </SelectionBulkActionBar>
      </SelectionProvider>
    </div>
  )
}
