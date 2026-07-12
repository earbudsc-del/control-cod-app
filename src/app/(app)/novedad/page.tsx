'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { whatsAppUrl, callUrl, daysSince, formatEventDate, timeAgo } from '@/lib/utils'
import { parseEFIDate } from '@/lib/tracking/parse-efi-date'
import { FlujoKpis } from '@/components/shared/flujo-kpis'
import { countConsecutiveNoContact, getLatestNovedadEvent } from '@/lib/novelty/novedad-history'
import type { NoveltyType, Order } from '@/types'
import {
  AlertCircle, RefreshCw, MessageCircle, Phone,
  CheckCircle2, PhoneMissed, XCircle, ExternalLink,
  MapPin, Search, TrendingUp, CalendarClock,
  Clock, ChevronLeft, ChevronRight,
  Package, DollarSign, Scale, User, HelpCircle, History, X,
} from 'lucide-react'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type Tab = 'sin-contacto' | 'contacto-realizado' | 'reprogramados' | 'no-salvables' | 'recuperadas' | 'indemnizacion'

interface NoveltyPerfData {
  novedadesTrabajadasHoy:  number
  pedidosContactadosHoy:   number
  pedidosReprogramadosHoy: number
  pedidosNoRespondenHoy:   number
  pedidosNoSalvablesHoy:   number
  tasaRecuperacionHoy:     number | null
  atrasadosPendientes:     number
  recuperadasHoy:          number
  recuperadasAyer:         number
}

interface RecuperadaEntry {
  order:        Order
  delivered_at: string
  confirmed:    boolean
}

interface OrdersResponse {
  data:       Order[]
  pagination: { total: number }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildNovedadMsg(nombre: string, producto: string | null | undefined): string {
  const n   = nombre.trim() || 'cliente'
  const raw = (producto ?? '').trim()
  const p   = raw.length > 32 ? raw.slice(0, 30) + '...' : raw || 'tu pedido'
  return [
    'Hola ' + n + ' 😊,',
    '',
    'Te escribimos por tu pedido de ' + p + ' 📦',
    '',
    'El mensajero intentó entregarlo, pero no se pudo completar en ese momento.',
    '',
    'Podemos coordinar una nueva entrega para finalizarlo sin inconvenientes.',
    '',
    'Indícanos por favor en qué horario puedes recibirlo,',
    'o deja a alguien encargado.',
    '',
    'Quedamos atentos 🙏',
  ].join('\n')
}

const TAB_META: { tab: Tab; label: string }[] = [
  { tab: 'sin-contacto',       label: 'Sin contacto'       },
  { tab: 'contacto-realizado', label: 'Contacto realizado' },
  { tab: 'reprogramados',      label: 'Reprogramados'      },
  { tab: 'no-salvables',       label: 'No salvables'       },
  { tab: 'recuperadas',        label: '✓ Entregadas'      },
  { tab: 'indemnizacion',      label: '⚖ Indemniz.'       },
]

// Días desde el último evento conocido (last_novedad_at → status_since → last_tracking_update)
function daysInNovedad(order: Order): number {
  const base = (
    order.last_novedad_at ??
    order.status_since ??
    order.last_tracking_update ??
    order.created_at
  ) as string
  return Math.floor((Date.now() - new Date(base).getTime()) / (1000 * 60 * 60 * 24))
}

type SuggestionSeverity = 'medium' | 'high' | 'critical'
interface NovedadSuggestion { text: string; severity: SuggestionSeverity }

function supervisorSuggestion(days: number): NovedadSuggestion | null {
  if (days >= 14) return { text: 'Riesgo crítico — escalar inmediatamente',  severity: 'critical' }
  if (days >= 7)  return { text: 'Contacto urgente antes de reprogramar',    severity: 'high'     }
  if (days >= 3)  return { text: 'Seguimiento pendiente',                    severity: 'medium'   }
  return null
}

// Medianoche RD en UTC (America/Santo_Domingo = UTC-4, sin DST)
function rdMidnightUTC(offsetDays = 0): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date())
  const y = parseInt(parts.find(p => p.type === 'year')!.value)
  const m = parseInt(parts.find(p => p.type === 'month')!.value)
  const d = parseInt(parts.find(p => p.type === 'day')!.value)
  return Date.UTC(y, m - 1, d + offsetDays, 4, 0, 0, 0)
}

// Fecha de hoy en RD como 'YYYY-MM-DD' — mismo formato que devuelve Supabase para columnas `date`
function rdTodayDateStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(new Date())
}

// Motivo real reportado por la transportadora. raw_status es casi siempre "Novedad"
// (sin información) — last_attempt_reason es el texto que realmente importa.
function motivoReal(order: Order): string | null {
  return order.last_attempt_reason ?? order.raw_status ?? null
}

// Si Gintracom ya reportó una fecha ("...fecha de entrega 2026 07 13") la extrae
// como sugerencia. Nunca se acepta automáticamente — solo pre-rellena el formulario.
function extractGintracomDate(reason: string | null | undefined): string | null {
  if (!reason) return null
  const m = /(\d{4})\s+(\d{2})\s+(\d{2})/.exec(reason)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

// Código de color único por clasificación — se usa idéntico en KPI, badge,
// playbook y acento de la tarjeta para que todo el sistema "entrene" al
// agente con el mismo lenguaje visual en todas partes.
type NoveltyColor = 'amber' | 'blue' | 'purple' | 'orange'

const COLOR_STYLES: Record<NoveltyColor, {
  badge: string; kpiBase: string; kpiActive: string; kpiHover: string
  playbookBg: string; playbookBorder: string; playbookTitle: string; playbookCheck: string
  cardAccent: string
}> = {
  amber: {
    badge: 'bg-amber-100 text-amber-700',
    kpiBase: 'border-amber-200 bg-amber-50 text-amber-700',
    kpiActive: 'border-amber-400 bg-amber-100 text-amber-800 ring-2 ring-amber-300/50',
    kpiHover: 'hover:bg-amber-100',
    playbookBg: 'bg-amber-50', playbookBorder: 'border-amber-200', playbookTitle: 'text-amber-800', playbookCheck: 'text-amber-600',
    cardAccent: 'border-l-4 border-l-amber-400',
  },
  blue: {
    badge: 'bg-blue-100 text-blue-700',
    kpiBase: 'border-blue-200 bg-blue-50 text-blue-700',
    kpiActive: 'border-blue-400 bg-blue-100 text-blue-800 ring-2 ring-blue-300/50',
    kpiHover: 'hover:bg-blue-100',
    playbookBg: 'bg-blue-50', playbookBorder: 'border-blue-200', playbookTitle: 'text-blue-800', playbookCheck: 'text-blue-600',
    cardAccent: 'border-l-4 border-l-blue-400',
  },
  purple: {
    badge: 'bg-purple-100 text-purple-700',
    kpiBase: 'border-purple-200 bg-purple-50 text-purple-700',
    kpiActive: 'border-purple-400 bg-purple-100 text-purple-800 ring-2 ring-purple-300/50',
    kpiHover: 'hover:bg-purple-100',
    playbookBg: 'bg-purple-50', playbookBorder: 'border-purple-200', playbookTitle: 'text-purple-800', playbookCheck: 'text-purple-600',
    cardAccent: 'border-l-4 border-l-purple-400',
  },
  orange: {
    badge: 'bg-orange-100 text-orange-700',
    kpiBase: 'border-orange-200 bg-orange-50 text-orange-700',
    kpiActive: 'border-orange-400 bg-orange-100 text-orange-800 ring-2 ring-orange-300/50',
    kpiHover: 'hover:bg-orange-100',
    playbookBg: 'bg-orange-50', playbookBorder: 'border-orange-200', playbookTitle: 'text-orange-800', playbookCheck: 'text-orange-600',
    cardAccent: 'border-l-4 border-l-orange-400',
  },
}

interface NoveltyBadge { label: string; color: NoveltyColor; Icon: typeof PhoneMissed; tooltip: string }

function noveltyBadge(order: Order): NoveltyBadge {
  if (order.delivery_resolution === 'rescheduled') {
    return { label: 'Reprogramado', color: 'purple', Icon: CalendarClock, tooltip: 'Existe un acuerdo pendiente de seguimiento.' }
  }
  if (order.novelty_type === 'contacted') {
    return { label: 'Contacto realizado', color: 'blue', Icon: MessageCircle, tooltip: 'El cliente ya habló con Gintracom.' }
  }
  if (order.novelty_type === 'no_contact') {
    return { label: 'Sin contacto', color: 'amber', Icon: PhoneMissed, tooltip: 'Gintracom nunca logró comunicarse con el cliente.' }
  }
  return { label: 'Comunicación por confirmar', color: 'orange', Icon: HelpCircle, tooltip: 'No sabemos si Gintracom logró hablar con el cliente.' }
}

interface Playbook { title: string; color: NoveltyColor; items: string[] }

function playbookFor(order: Order): Playbook {
  if (order.delivery_resolution === 'rescheduled') {
    return {
      title: 'Dar seguimiento al acuerdo',
      color: 'purple',
      items: [
        'Confirmar que el cliente sigue disponible en la fecha acordada',
        'Verificar si el acuerdo sigue vigente',
        'Si está vencido, contactar de nuevo',
        'Actualizar el resultado tras el intento',
      ],
    }
  }
  if (order.novelty_type === 'contacted') {
    return {
      title: 'Coordinar siguiente intento',
      color: 'blue',
      items: [
        'Entender el motivo',
        'Coordinar nueva entrega',
        'Confirmar disponibilidad',
        'Reprogramar si aplica',
      ],
    }
  }
  // no_contact o sin confirmar todavía usan el mismo playbook operativo
  return {
    title: 'Restablecer comunicación',
    color: 'amber',
    items: [
      'Contactar al cliente',
      'Verificar teléfono',
      'Confirmar dirección',
      'Pedir responder llamadas o WhatsApp de Gintracom',
    ],
  }
}

// "Último acuerdo incumplido": hubo una reprogramación pero un nuevo intento
// fallido de la transportadora reabrió el caso — se conserva como contexto,
// nunca como reprogramación activa (eso solo lo determina delivery_resolution).
function acuerdoIncumplido(order: Order): boolean {
  return order.delivery_resolution === 'pending' && !!order.rescheduled_date
}

// Acuerdo vencido: reprogramación activa cuya fecha ya pasó sin nueva gestión.
function isVencido(order: Order): boolean {
  return order.delivery_resolution === 'rescheduled' && !!order.rescheduled_date && order.rescheduled_date < rdTodayDateStr()
}

function lastActionLabel(order: Order): string {
  return order.last_action_at ? timeAgo(order.last_action_at) : 'Sin gestión'
}

const PAGE_SIZE = 50

// ── Modal: confirmar reprogramación con fecha ─────────────────────────────────

function ReprogramarModal({
  order, onClose, onSave, saving, error,
}: {
  order:  Order
  onClose: () => void
  onSave: (date: string, note: string | null) => void
  saving: boolean
  error:  string | null
}) {
  const suggested = extractGintracomDate(order.last_attempt_reason)
  const [date, setDate] = useState(suggested ?? '')
  const [note, setNote] = useState('')

  function quickDate(offsetDays: number) {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    setDate(d.toISOString().slice(0, 10))
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md p-5 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-gray-900">Reprogramar entrega</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-gray-500">
          {order.tracking_number} · {order.customer_name ?? 'Cliente'}
        </p>

        {suggested && (
          <div className="flex items-start gap-2 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
            <CalendarClock className="w-4 h-4 text-purple-500 shrink-0 mt-0.5" />
            <p className="text-xs text-purple-700">
              Sugerido por la transportadora: <strong>{suggested}</strong> — confirma o corrígela antes de guardar.
            </p>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => quickDate(1)}
            className="flex-1 text-sm font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"
          >
            Mañana
          </button>
          <button
            onClick={() => quickDate(2)}
            className="flex-1 text-sm font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"
          >
            Pasado mañana
          </button>
        </div>

        <div>
          <label className="text-xs font-semibold text-gray-600">Fecha acordada *</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1
                       focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-300"
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-gray-600">Nota (opcional)</label>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Ej: después de las 5, llamar antes de ir, entregar en el trabajo…"
            rows={2}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1 resize-none
                       focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-300"
          />
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button
            onClick={onClose}
            className="flex-1 text-sm font-medium px-3 py-2.5 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            Cancelar
          </button>
          <button
            onClick={() => date && onSave(date, note.trim() || null)}
            disabled={!date || saving}
            className="flex-1 flex items-center justify-center gap-1.5 text-sm font-semibold px-3 py-2.5 rounded-xl
                       bg-purple-600 hover:bg-purple-700 text-white transition-colors disabled:opacity-40"
          >
            {saving ? <Spinner className="w-4 h-4" /> : 'Guardar reprogramación'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Subcomponente: Card móvil de novedad activa ───────────────────────────────

interface NovedadCardProps {
  order:         Order
  busy:          boolean
  novedadSrc:    string | null
  sug:           NovedadSuggestion | null
  onContacted:   () => void
  onNoAnswer:    () => void
  onReprogramar: () => void
  onNoSalvable:  () => void
  onRecuperada:  () => void
  onConfirm:     (type: NoveltyType) => void
  isHighlighted: boolean
}

function NovedadCard({
  order, busy, novedadSrc, sug,
  onContacted, onNoAnswer, onReprogramar, onNoSalvable, onRecuperada, onConfirm,
  isHighlighted,
}: NovedadCardProps) {
  const nombre    = order.customer_name ?? ''
  const intentos  = order.delivery_attempts ?? 0
  const waUrl     = whatsAppUrl(order.customer_phone, buildNovedadMsg(nombre, order.product_summary))
  const telUrl    = callUrl(order.customer_phone)
  const hasPhone  = !!order.customer_phone
  const noSalv       = order.follow_up_result === 'no_action'
  const isRecuperada = order.follow_up_result === 'recovered'
  const needsConfirm = order.novelty_type == null && order.delivery_resolution !== 'rescheduled'
  const badge     = noveltyBadge(order)
  const playbook  = playbookFor(order)
  const incumplido = acuerdoIncumplido(order)
  const motivo    = motivoReal(order)

  const ubicacion = order.city
    || order.province
    || (order.customer_address ? order.customer_address.slice(0, 30) : null)

  const vencido = isVencido(order)
  const style   = COLOR_STYLES[badge.color]
  const pbStyle = COLOR_STYLES[playbook.color]
  const BadgeIcon = badge.Icon
  const consecutiveNoContact = order.novelty_type === 'no_contact'
    ? countConsecutiveNoContact(order.tracking_novedades)
    : 0

  const cardBg = noSalv || isRecuperada
    ? 'bg-gray-50 border-gray-200'
    : 'bg-white border-gray-200'

  return (
    <div className={`rounded-xl border-2 p-4 space-y-3 shadow-sm transition-colors
      ${cardBg} ${!noSalv && !isRecuperada ? style.cardAccent : ''} ${isHighlighted ? 'ring-2 ring-blue-400 border-blue-300' : ''}`}>

      {/* 1. Badge de clasificación — lo primero que se lee */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="font-mono text-[10px] text-gray-400 truncate">
            {order.tracking_number ?? '—'}{order.order_number ? ` · ${order.order_number}` : ''}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span title={badge.tooltip}
                  className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full ${style.badge}`}>
              <BadgeIcon className="w-3.5 h-3.5" />
              {badge.label.toUpperCase()}
            </span>
            {vencido && (
              <span title="El acuerdo pasó su fecha sin nueva gestión"
                    className="inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full bg-red-100 text-red-700">
                <AlertCircle className="w-3 h-3" />Acuerdo vencido
              </span>
            )}
            {consecutiveNoContact >= 2 && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-800">
                {consecutiveNoContact} intentos consecutivos sin contacto
              </span>
            )}
          </div>
          {needsConfirm && (
            <p className="text-[10px] text-orange-600">No sabemos si Gintracom logró hablar con el cliente.</p>
          )}
        </div>
        <span className="shrink-0 text-[10px] font-bold text-gray-400 tabular-nums">{intentos} int.</span>
      </div>

      {/* 2. Cliente */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 text-sm leading-tight truncate">
            {nombre || '—'}
          </p>
          <p className="font-mono text-xs text-gray-500 mt-0.5">
            {order.customer_phone ?? 'Sin teléfono'}
          </p>
        </div>
        {order.cod_amount != null && (
          <div className="shrink-0 flex items-center gap-1 text-gray-700">
            <DollarSign className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-sm font-bold tabular-nums">
              {order.cod_amount.toLocaleString('es-DO')}
            </span>
          </div>
        )}
      </div>

      {/* 3. Motivo de Gintracom */}
      {motivo && (
        <div>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Motivo de Gintracom</p>
          <p className="text-xs text-gray-700 mt-0.5">{motivo}</p>
        </div>
      )}

      {/* 4. Playbook — bloque visual con checklist */}
      {!noSalv && !isRecuperada && (
        <div className={`rounded-lg border px-3 py-2.5 ${pbStyle.playbookBg} ${pbStyle.playbookBorder}`}>
          <p className={`text-[11px] font-bold flex items-center gap-1.5 ${pbStyle.playbookTitle}`}>
            Qué debes hacer
          </p>
          <ul className="mt-1.5 space-y-1">
            {playbook.items.map(item => (
              <li key={item} className="text-[11px] text-gray-700 flex items-start gap-1.5">
                <span className={`font-bold shrink-0 ${pbStyle.playbookCheck}`}>✓</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 5. Acciones — WhatsApp es el CTA dominante */}
      {hasPhone && !noSalv && !isRecuperada && (
        <div className="space-y-2">
          {waUrl && (
            <a href={waUrl} target="_blank" rel="noopener noreferrer"
               className="flex items-center justify-center gap-2 w-full
                          bg-green-500 hover:bg-green-600 active:bg-green-700
                          text-white text-base font-bold px-3 py-3.5 rounded-xl
                          transition-colors shadow-md shadow-green-200/60">
              <MessageCircle className="w-5 h-5" />Escribir por WhatsApp
            </a>
          )}
          {telUrl && (
            <a href={telUrl}
               className="flex items-center justify-center gap-2 w-full
                          bg-blue-50 hover:bg-blue-100 active:bg-blue-200
                          text-blue-700 text-sm font-semibold px-3 py-2.5 rounded-xl
                          border border-blue-200 transition-colors">
              <Phone className="w-4 h-4" />Llamar
            </a>
          )}
        </div>
      )}

      <div className="space-y-2">
        {noSalv ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold
                           px-3 py-2 rounded-xl bg-gray-100 text-gray-500 w-full justify-center">
            <XCircle className="w-4 h-4" />No salvable
          </span>
        ) : isRecuperada ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold
                           px-3 py-2 rounded-xl bg-green-100 text-green-700 w-full justify-center">
            <CheckCircle2 className="w-4 h-4" />Recuperado
          </span>
        ) : busy ? (
          <div className="flex justify-center py-2">
            <Spinner className="w-5 h-5 text-red-500" />
          </div>
        ) : needsConfirm ? (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-gray-700 text-center">
              ¿La transportadora logró comunicarse con el cliente?
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onConfirm('contacted')}
                className="flex items-center justify-center gap-1.5 bg-blue-100 hover:bg-blue-200
                           text-blue-700 text-sm font-medium px-3 py-2.5 rounded-xl transition-colors">
                Sí
              </button>
              <button
                onClick={() => onConfirm('no_contact')}
                className="flex items-center justify-center gap-1.5 bg-red-100 hover:bg-red-200
                           text-red-700 text-sm font-medium px-3 py-2.5 rounded-xl transition-colors">
                No
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onContacted}
              className="flex items-center justify-center gap-1.5
                         bg-slate-100 hover:bg-slate-200 active:bg-slate-300
                         text-slate-700 text-sm font-medium px-3 py-2.5 rounded-xl
                         transition-colors">
              <CheckCircle2 className="w-4 h-4 shrink-0" />Contactado
            </button>
            <button
              onClick={onReprogramar}
              className="flex items-center justify-center gap-1.5
                         bg-purple-100 hover:bg-purple-200 active:bg-purple-300
                         text-purple-700 text-sm font-medium px-3 py-2.5 rounded-xl
                         transition-colors">
              <CalendarClock className="w-4 h-4 shrink-0" />Reprogramar
            </button>
            <button
              onClick={onNoAnswer}
              className="flex items-center justify-center gap-1.5
                         bg-amber-100 hover:bg-amber-200 active:bg-amber-300
                         text-amber-700 text-sm font-medium px-3 py-2.5 rounded-xl
                         transition-colors">
              <PhoneMissed className="w-4 h-4 shrink-0" />No responde
            </button>
            <button
              onClick={onNoSalvable}
              className="flex items-center justify-center gap-1.5
                         bg-red-100 hover:bg-red-200 active:bg-red-300
                         text-red-700 text-sm font-medium px-3 py-2.5 rounded-xl
                         transition-colors">
              <XCircle className="w-4 h-4 shrink-0" />No salv.
            </button>
            <button
              onClick={onRecuperada}
              className="col-span-2 flex items-center justify-center gap-1.5
                         bg-green-100 hover:bg-green-200 active:bg-green-300
                         text-green-700 text-sm font-medium px-3 py-2.5 rounded-xl
                         transition-colors">
              <CheckCircle2 className="w-4 h-4 shrink-0" />Recuperado
            </button>
          </div>
        )}
      </div>

      {/* 6. Información secundaria */}
      <div className="border-t border-gray-100 pt-2 space-y-1.5">
        {(ubicacion || order.customer_address) && (
          <div className="flex items-start gap-1.5 text-gray-500">
            <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs truncate">{ubicacion || '—'}</p>
              {order.city && order.province && order.city !== order.province && (
                <p className="text-[10px] text-gray-400">{order.province}</p>
              )}
            </div>
          </div>
        )}
        {order.product_summary && (
          <div className="flex items-start gap-1.5">
            <Package className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
            <p className="text-xs text-gray-600 line-clamp-2">{order.product_summary}</p>
          </div>
        )}
        {order.delivery_resolution === 'rescheduled' && order.rescheduled_date && (
          <div className="flex items-start gap-1.5">
            <CalendarClock className="w-3.5 h-3.5 text-purple-500 shrink-0 mt-0.5" />
            <p className="text-xs text-purple-700 font-semibold">
              {order.rescheduled_date}{order.rescheduled_note ? ` · ${order.rescheduled_note}` : ''}
            </p>
          </div>
        )}
        {incumplido && (
          <div className="flex items-start gap-1.5">
            <History className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-gray-400">
              Último acuerdo incumplido — {order.rescheduled_date}
              {order.rescheduled_note ? ` · ${order.rescheduled_note}` : ''}
            </p>
          </div>
        )}
        <div className="flex items-center gap-3 flex-wrap text-[10px] text-gray-400">
          {novedadSrc && (
            <span className="flex items-center gap-1">
              <Clock className="w-2.5 h-2.5 shrink-0" />
              Última novedad: {timeAgo(novedadSrc)}
            </span>
          )}
          <span>Última gestión: {lastActionLabel(order)}</span>
          {order.last_escalation_at && (
            <span className="text-orange-600 font-medium">Escalado {timeAgo(order.last_escalation_at)}</span>
          )}
        </div>
        {sug && (
          <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full leading-tight
            ${sug.severity === 'critical'
              ? 'bg-red-200 text-red-800'
              : sug.severity === 'high'
                ? 'bg-orange-200 text-orange-800'
                : 'bg-amber-100 text-amber-700'
            }`}>
            {sug.text}
          </span>
        )}
      </div>

      <Link
        href={`/orders/${order.id}`}
        className="flex items-center justify-center gap-1.5 text-sm font-medium
                   text-red-600 hover:text-red-800 border border-red-200 hover:border-red-400
                   bg-white hover:bg-red-50 px-3 py-2.5 rounded-xl transition-colors w-full">
        <ExternalLink className="w-4 h-4" />
        Ver detalle
      </Link>
    </div>
  )
}

// ── Subcomponente: Card móvil de entregada ────────────────────────────────────

function EntregadaCard({ order, delivered_at }: { order: Order; delivered_at: string }) {
  const intentos  = order.delivery_attempts ?? 0
  const ubicacion = order.city
    || order.province
    || (order.customer_address ? order.customer_address.slice(0, 30) : null)

  return (
    <div className="rounded-xl border border-green-200 bg-white p-4 space-y-3 shadow-sm">
      {/* Orden + tracking */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {order.order_number && (
            <p className="text-xs font-bold text-gray-400 mb-0.5">{order.order_number}</p>
          )}
          <p className="font-mono text-sm font-semibold text-gray-900 truncate">
            {order.tracking_number ?? '—'}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
          <span className="text-xs text-green-700 font-semibold">
            {formatEventDate(delivered_at)}
          </span>
        </div>
      </div>

      {/* Cliente */}
      <div>
        <p className="font-semibold text-gray-900 text-sm">{order.customer_name ?? '—'}</p>
        <p className="font-mono text-xs text-gray-500 mt-0.5">{order.customer_phone ?? '—'}</p>
      </div>

      {/* Ubicación */}
      {ubicacion && (
        <div className="flex items-start gap-1.5 text-gray-600">
          <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs truncate">{ubicacion}</p>
            {order.city && order.province && order.city !== order.province && (
              <p className="text-[10px] text-gray-400">{order.province}</p>
            )}
          </div>
        </div>
      )}

      {/* Fecha completa */}
      <p className="text-[10px] text-gray-400">
        {new Date(delivered_at).toLocaleDateString('es-DO', {
          day: '2-digit', month: 'short',
          hour: '2-digit', minute: '2-digit',
          timeZone: 'America/Santo_Domingo',
        })}
      </p>

      {/* Intentos previos */}
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center gap-1 text-xs font-bold
                         px-2.5 py-1 rounded-full tabular-nums
          ${intentos >= 3
            ? 'bg-red-100 text-red-700'
            : intentos === 2
              ? 'bg-orange-100 text-orange-700'
              : intentos === 1
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-gray-100 text-gray-500'
          }`}>
          {intentos} intento{intentos !== 1 ? 's' : ''} previos
        </span>
        {order.last_attempt_reason && (
          <p className="text-[10px] text-gray-400 truncate max-w-[120px]"
             title={order.last_attempt_reason}>
            {order.last_attempt_reason}
          </p>
        )}
      </div>

      <Link
        href={`/orders/${order.id}`}
        className="flex items-center justify-center gap-1.5 text-sm font-medium
                   text-green-600 hover:text-green-800 border border-green-200 hover:border-green-400
                   bg-white hover:bg-green-50 px-3 py-2.5 rounded-xl transition-colors w-full">
        <ExternalLink className="w-4 h-4" />
        Ver detalle
      </Link>
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function NovedadPage() {
  const searchParamsObj = useSearchParams()
  const trackingParam   = searchParamsObj.get('tracking')
  const rowRefs         = useRef<Map<string, HTMLTableRowElement>>(new Map())

  const [allOrders, setAllOrders]     = useState<Order[]>([])
  const [perf, setPerf]               = useState<NoveltyPerfData | null>(null)
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  const initNovedadTab = (): Tab => {
    const f = searchParamsObj.get('filter')
    if (f === 'indemnizacion') return 'indemnizacion'
    return 'sin-contacto'
  }
  const [activeTab, setActiveTab]     = useState<Tab>(initNovedadTab)
  const [indemnizacionOrders, setIndemnizacionOrders] = useState<Order[]>([])
  const [searchQuery, setSearchQuery] = useState('')

  const [loadingRow, setLoadingRow] = useState<Record<string, boolean>>({})
  const [taskMap, setTaskMap]       = useState<Record<string, string>>({})
  const [recuperadasDbOrders, setRecuperadasDbOrders] = useState<RecuperadaEntry[]>([])
  const [entregadasFilter, setEntregadasFilter] = useState<'hoy' | 'ayer' | null>(null)
  const [currentPage, setCurrentPage] = useState(1)

  const [reprogramandoId, setReprogramandoId] = useState<string | null>(null)
  const [reprogError, setReprogError]         = useState<string | null>(null)
  const [reprogSaving, setReprogSaving]       = useState(false)

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [ordersRes, perfRes, tasksRes, recuperadasRes, indemnizacionRes]: [OrdersResponse, NoveltyPerfData, { tasks: any[] }, RecuperadaEntry[], OrdersResponse] =
        await Promise.all([
          fetch('/api/orders?status=novedad&limit=200&page=1').then(r => r.json()),
          fetch('/api/novedad/performance').then(r => r.json()),
          fetch('/api/my-tasks').then(r => r.json()),
          fetch('/api/novedad/recuperadas').then(r => r.json()),
          fetch('/api/orders?status=indemnizacion&limit=200&page=1').then(r => r.json()),
        ])

      setAllOrders(ordersRes.data ?? [])
      setPerf(perfRes)
      setRecuperadasDbOrders(Array.isArray(recuperadasRes) ? recuperadasRes : [])
      setIndemnizacionOrders(indemnizacionRes.data ?? [])

      const map: Record<string, string> = {}
      for (const t of (tasksRes.tasks ?? [])) {
        if (t.order_id && (t.task_type === 'novedad' || t.task_type === 'recovery')) {
          map[t.order_id] = t.id
        }
      }
      setTaskMap(map)
      setLastRefresh(new Date())
    } catch (err) {
      console.error('[novedad/fetchData]', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 3 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Scroll al pedido indicado por ?tracking=
  useEffect(() => {
    if (!trackingParam || allOrders.length === 0) return
    const match = allOrders.find(o => o.tracking_number === trackingParam)
    if (match) setTimeout(() => {
      rowRefs.current.get(match.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
  }, [allOrders, trackingParam])

  // Reset paginación al cambiar tab, búsqueda o filtro de fecha
  useEffect(() => { setCurrentPage(1) }, [activeTab, searchQuery, entregadasFilter])

  // ── Acciones ──────────────────────────────────────────────────────────────

  function handleTabChange(tab: Tab) {
    setActiveTab(tab)
    if (tab !== 'recuperadas') setEntregadasFilter(null)
    setCurrentPage(1)
  }

  async function patchTask(orderId: string, body: Record<string, unknown>) {
    const taskId = taskMap[orderId]
    if (!taskId) return
    await fetch(`/api/tasks/${taskId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
  }

  // Único punto de escritura para acciones de Novedades — siempre pasa por el
  // motor de dominio (/api/orders/[id]/actions → recordNoveltyAction), nunca
  // escribe directamente novelty_type/delivery_resolution desde el cliente.
  async function postNoveltyAction(orderId: string, body: Record<string, unknown>): Promise<boolean> {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      const res = await fetch(`/api/orders/${orderId}/actions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      if (res.ok) {
        const payload = await res.json()
        if (payload?.order) {
          setAllOrders(prev => prev.map(o => o.id === orderId ? { ...o, ...payload.order } : o))
        }
        return true
      }
      const errBody = await res.json().catch(() => ({}))
      setReprogError(errBody?.error ?? 'No se pudo guardar la acción')
      return false
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  async function handleContacted(orderId: string) {
    const ok = await postNoveltyAction(orderId, { action_type: 'contacted' })
    if (ok) patchTask(orderId, { status: 'in_progress' })
  }

  async function handleNoAnswer(orderId: string) {
    const ok = await postNoveltyAction(orderId, { action_type: 'contacted', contact_result: 'no_answer' })
    if (ok) patchTask(orderId, { status: 'in_progress' })
  }

  async function handleConfirm(orderId: string, confirmedType: NoveltyType) {
    await postNoveltyAction(orderId, { action_type: 'contacted', confirm_communication: confirmedType })
  }

  async function handleReschedule(orderId: string, date: string, note: string | null) {
    setReprogSaving(true)
    setReprogError(null)
    try {
      const ok = await postNoveltyAction(orderId, {
        action_type: 'rescheduled',
        rescheduled_date: date,
        rescheduled_note: note,
      })
      if (ok) {
        await patchTask(orderId, { status: 'completed', result: 'rescheduled' })
        setReprogramandoId(null)
      }
    } finally {
      setReprogSaving(false)
    }
  }

  async function markNoSalvable(orderId: string) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      const [patchRes] = await Promise.all([
        fetch(`/api/orders/${orderId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ follow_up_result: 'no_action' }),
        }),
        patchTask(orderId, { status: 'completed', result: 'no_action' }),
      ])
      if (patchRes.ok) {
        const updated = await patchRes.json()
        setAllOrders(prev => prev.map(o => o.id === orderId ? { ...o, ...updated } : o))
      }
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  async function markRecuperada(orderId: string) {
    setLoadingRow(prev => ({ ...prev, [orderId]: true }))
    try {
      await Promise.all([
        fetch(`/api/orders/${orderId}/actions`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action_type: 'recovered' }),
        }),
        fetch(`/api/orders/${orderId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ follow_up_result: 'recovered' }),
        }),
        patchTask(orderId, { status: 'completed', result: 'recovered' }),
      ])
      setAllOrders(prev =>
        prev.map(o => o.id === orderId ? { ...o, follow_up_result: 'recovered' } : o)
      )
    } finally {
      setLoadingRow(prev => ({ ...prev, [orderId]: false }))
    }
  }

  // ── Datos derivados ────────────────────────────────────────────────────────

  const activeOrders = useMemo(
    () => allOrders.filter(o => o.follow_up_result !== 'no_action' && o.follow_up_result !== 'recovered'),
    [allOrders],
  )
  const noSalvables = useMemo(
    () => allOrders.filter(o => o.follow_up_result === 'no_action'),
    [allOrders],
  )
  const reprogramadosList = useMemo(() => {
    const list = activeOrders.filter(o => o.delivery_resolution === 'rescheduled')
    const today = rdTodayDateStr()
    const priority = (o: Order) => {
      if (!o.rescheduled_date) return 3
      if (o.rescheduled_date < today) return 0 // vencido
      if (o.rescheduled_date === today) return 1 // hoy
      return 2 // próximo
    }
    return [...list].sort((a, b) => {
      const pa = priority(a), pb = priority(b)
      if (pa !== pb) return pa - pb
      return (a.rescheduled_date ?? '').localeCompare(b.rescheduled_date ?? '')
    })
  }, [activeOrders])

  const sinContactoList = useMemo(
    () => activeOrders.filter(o =>
      o.delivery_resolution !== 'rescheduled' &&
      (o.novelty_type === 'no_contact' || o.novelty_type == null)
    ),
    [activeOrders],
  )
  const contactoRealizadoList = useMemo(
    () => activeOrders.filter(o =>
      o.delivery_resolution !== 'rescheduled' && o.novelty_type === 'contacted'
    ),
    [activeOrders],
  )

  const displayedOrders = useMemo(() => {
    if (activeTab === 'recuperadas') return []
    if (activeTab === 'indemnizacion') return []

    let base: Order[]
    switch (activeTab) {
      case 'sin-contacto':       base = sinContactoList;        break
      case 'contacto-realizado': base = contactoRealizadoList;  break
      case 'reprogramados':      base = reprogramadosList;      break
      case 'no-salvables':       base = noSalvables;            break
      default:                   base = []
    }

    if (activeTab !== 'reprogramados') {
      base = [...base].sort((a, b) => (b.delivery_attempts ?? 0) - (a.delivery_attempts ?? 0))
    }

    if (!searchQuery.trim()) return base
    const q = searchQuery.toLowerCase()
    return base.filter(o =>
      (o.tracking_number     ?? '').toLowerCase().includes(q) ||
      (o.customer_name       ?? '').toLowerCase().includes(q) ||
      (o.customer_phone      ?? '').toLowerCase().includes(q) ||
      (o.city                ?? '').toLowerCase().includes(q) ||
      (o.last_attempt_reason ?? '').toLowerCase().includes(q) ||
      (o.raw_status          ?? '').toLowerCase().includes(q)
    )
  }, [sinContactoList, contactoRealizadoList, reprogramadosList, noSalvables, activeTab, searchQuery])

  const tabCounts = useMemo<Record<Tab, number>>(() => ({
    'sin-contacto':       sinContactoList.length,
    'contacto-realizado': contactoRealizadoList.length,
    reprogramados:        reprogramadosList.length,
    'no-salvables':       noSalvables.length,
    recuperadas:          recuperadasDbOrders.length,
    indemnizacion:        indemnizacionOrders.length,
  }), [sinContactoList, contactoRealizadoList, reprogramadosList, noSalvables, recuperadasDbOrders, indemnizacionOrders])

  const displayedRecuperadas = useMemo(() => {
    let entries = [...recuperadasDbOrders]
    if (entregadasFilter) {
      const todayMs     = rdMidnightUTC(0)
      const yesterdayMs = rdMidnightUTC(-1)
      entries = entries.filter(e => {
        const ts = new Date(e.delivered_at).getTime()
        if (entregadasFilter === 'hoy') return ts >= todayMs
        return ts >= yesterdayMs && ts < todayMs
      })
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      entries = entries.filter(e =>
        (e.order.tracking_number ?? '').toLowerCase().includes(q) ||
        (e.order.customer_name   ?? '').toLowerCase().includes(q) ||
        (e.order.customer_phone  ?? '').toLowerCase().includes(q) ||
        (e.order.city            ?? '').toLowerCase().includes(q)
      )
    }
    return entries
  }, [recuperadasDbOrders, entregadasFilter, searchQuery])

  // Paginación
  const pagedOrders = useMemo(
    () => displayedOrders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [displayedOrders, currentPage],
  )
  const totalPagesNovedad = Math.ceil(displayedOrders.length / PAGE_SIZE)

  const pagedRecuperadas = useMemo(
    () => displayedRecuperadas.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [displayedRecuperadas, currentPage],
  )
  const totalPagesRecuperadas = Math.ceil(displayedRecuperadas.length / PAGE_SIZE)

  const totalReprogramados = reprogramadosList.length

  const reprogramandoOrder = reprogramandoId ? allOrders.find(o => o.id === reprogramandoId) ?? null : null

  // ── Render ─────────────────────────────────────────────────────────────────

  const totalPages = activeTab === 'recuperadas' ? totalPagesRecuperadas : activeTab === 'indemnizacion' ? 1 : totalPagesNovedad
  const activeCount = activeTab === 'recuperadas' ? displayedRecuperadas.length : activeTab === 'indemnizacion' ? indemnizacionOrders.length : displayedOrders.length

  const infoBannerText = activeTab === 'contacto-realizado'
    ? 'Objetivo: coordinar el siguiente intento de entrega.'
    : activeTab === 'reprogramados'
      ? 'Da seguimiento a los acuerdos — prioriza los vencidos.'
      : 'Objetivo: restablecer comunicación entre cliente y transportadora.'

  return (
    <div className="space-y-3 md:space-y-4">

      {/* ── Banner — compacto en móvil ── */}
      <div className="relative overflow-hidden rounded-2xl
                      bg-gradient-to-r from-red-500 to-rose-600
                      border-2 border-red-400 shadow-lg shadow-red-200/50">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white" />
          <div className="absolute -right-2 -bottom-10 w-24 h-24 rounded-full bg-white" />
        </div>
        <div className="relative px-4 py-3 md:px-6 md:py-5">
          {/* Fila principal */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-9 h-9 md:w-12 md:h-12 bg-white/20 rounded-xl shrink-0">
                <AlertCircle className="w-5 h-5 md:w-6 md:h-6 text-white" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl md:text-2xl font-black text-white tabular-nums">
                    {loading ? '…' : activeOrders.length.toLocaleString()}
                  </h1>
                  {!loading && activeOrders.length > 0 && (
                    <span className="flex items-center gap-1.5 bg-white/20 text-white
                                     text-[10px] md:text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">
                      <span className="w-1.5 h-1.5 rounded-full bg-white" />
                      PENDIENTES
                    </span>
                  )}
                </div>
                <p className="text-white font-semibold text-sm md:text-base">Gestión de novedades</p>
                {/* Subtítulo solo en desktop */}
                <p className="hidden md:block text-red-100 text-xs mt-0.5">
                  Clasifica rápidamente cada incidencia y aplica el playbook correcto para recuperar la entrega
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* Reprogramados */}
              {totalReprogramados > 0 && (
                <span className="hidden md:block text-sm text-green-200 font-semibold">
                  ✓ {totalReprogramados} reprogramado{totalReprogramados !== 1 ? 's' : ''}
                </span>
              )}
              <p className="text-red-100 text-[10px] md:text-xs hidden sm:block">
                {lastRefresh.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
              </p>
              <button
                onClick={fetchData}
                disabled={loading}
                className="flex items-center gap-1.5 bg-white/20 hover:bg-white/30 text-white
                           text-xs md:text-sm font-medium px-3 py-2 rounded-lg transition-colors
                           disabled:opacity-50 min-h-[36px]"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Refrescar</span>
              </button>
            </div>
          </div>

          {/* Reprogramados en móvil — fila separada */}
          {totalReprogramados > 0 && (
            <p className="md:hidden text-xs text-green-200 font-semibold mt-2">
              ✓ {totalReprogramados} reprogramado{totalReprogramados !== 1 ? 's' : ''}
            </p>
          )}
        </div>
      </div>

      {/* ── Pipeline logístico ── */}
      <FlujoKpis />

      {/* ── Métricas del agente hoy ── */}
      {perf && (
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 md:px-5 md:py-3.5 shadow-sm">
          <div className="flex items-center gap-2 md:gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 shrink-0">
              <TrendingUp className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Mi día</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap flex-1">
              {([
                { label: 'Trabajados',    count: perf.novedadesTrabajadasHoy,  cls: 'bg-blue-100   text-blue-700'   },
                { label: 'Reprogramados', count: perf.pedidosReprogramadosHoy, cls: 'bg-purple-100 text-purple-700' },
                { label: 'Contactados',   count: perf.pedidosContactadosHoy,   cls: 'bg-slate-100  text-slate-700'  },
                { label: 'No responden',  count: perf.pedidosNoRespondenHoy,   cls: 'bg-amber-100  text-amber-700'  },
                { label: 'No salvables',  count: perf.pedidosNoSalvablesHoy,   cls: 'bg-red-100    text-red-700'    },
              ] as const).map(({ label, count, cls }) => (
                <div key={label} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${cls}`}>
                  <span className="text-sm font-black tabular-nums leading-none">{count}</span>
                  <span className="text-[11px] font-medium">{label}</span>
                </div>
              ))}
            </div>
            {perf.tasaRecuperacionHoy !== null ? (
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg shrink-0
                ${perf.tasaRecuperacionHoy >= 70
                  ? 'bg-green-100 text-green-700'
                  : perf.tasaRecuperacionHoy >= 40
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-red-100 text-red-700'
                }`}>
                <span className="text-[11px] font-semibold opacity-60 leading-none">Recuperación</span>
                <span className="text-xl font-black tabular-nums leading-none">
                  {perf.tasaRecuperacionHoy}%
                </span>
              </div>
            ) : (
              <span className="text-xs text-gray-400 shrink-0">Sin gestiones hoy</span>
            )}
          </div>
        </div>
      )}

      {/* ── Dashboard operativo ── */}
      <div className="space-y-2">

        {/* Fila 1: tarjetas de acción — 2 columnas en móvil, 3 en desktop */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 md:gap-3">
          {([
            {
              tab:         'sin-contacto' as Tab,
              count:       sinContactoList.length,
              label:       'Sin contacto',
              explanation: 'Gintracom no logró hablar con el cliente.',
              objetivo:    'Restablecer la comunicación.',
              Icon:        PhoneMissed,
              style:       COLOR_STYLES.amber,
            },
            {
              tab:         'contacto-realizado' as Tab,
              count:       contactoRealizadoList.length,
              label:       'Contacto realizado',
              explanation: 'El cliente ya habló con Gintracom.',
              objetivo:    'Coordinar la siguiente entrega.',
              Icon:        MessageCircle,
              style:       COLOR_STYLES.blue,
            },
            {
              tab:         'reprogramados' as Tab,
              count:       reprogramadosList.length,
              label:       'Reprogramados',
              explanation: 'Existe una fecha acordada.',
              objetivo:    'Dar seguimiento al acuerdo.',
              Icon:        CalendarClock,
              style:       COLOR_STYLES.purple,
            },
          ] as const).map(({ tab, count, label, explanation, objetivo, Icon, style }, idx) => (
            <button
              key={tab}
              onClick={() => handleTabChange(tab)}
              className={`flex items-center gap-2 md:gap-3 p-3 md:p-4 rounded-xl border-2 text-left transition-all
                ${idx === 0 ? 'col-span-2 md:col-span-1' : ''}
                ${activeTab === tab ? style.kpiActive : `${style.kpiBase} ${style.kpiHover}`}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Icon className="w-5 h-5 md:w-6 md:h-6 opacity-70 shrink-0" />
                  <p className="text-2xl md:text-3xl font-black tabular-nums leading-none">{count}</p>
                </div>
                <p className="text-xs md:text-sm font-bold mt-1.5">{label}</p>
                <p className="text-[10px] md:text-[11px] opacity-70 mt-0.5 leading-snug">{explanation}</p>
                <p className="text-[9px] md:text-[10px] font-semibold mt-1 opacity-90">Objetivo: {objetivo}</p>
              </div>
            </button>
          ))}
        </div>

        {/* Fila 2: métricas informativas — 3 columnas en móvil (scroll), 6 en desktop */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">

          {/* Entregadas hoy */}
          <button
            onClick={() => {
              setActiveTab('recuperadas')
              setEntregadasFilter(f => (activeTab === 'recuperadas' && f === 'hoy') ? null : 'hoy')
              setCurrentPage(1)
            }}
            className={`flex flex-col items-center justify-center p-2.5 md:p-3 rounded-lg border transition-all
              ${activeTab === 'recuperadas' && entregadasFilter === 'hoy'
                ? 'bg-green-100 border-green-400 ring-2 ring-green-300/50 text-green-800'
                : 'bg-green-50 text-green-700 border-green-100 hover:bg-green-100 hover:border-green-300 cursor-pointer'
              }`}
          >
            <p className="text-lg md:text-xl font-black tabular-nums leading-none">{perf?.recuperadasHoy ?? '…'}</p>
            <p className="text-[9px] md:text-[10px] font-medium mt-1 text-center leading-tight opacity-80">Entregadas hoy</p>
          </button>

          {/* Entregadas ayer */}
          <button
            onClick={() => {
              setActiveTab('recuperadas')
              setEntregadasFilter(f => (activeTab === 'recuperadas' && f === 'ayer') ? null : 'ayer')
              setCurrentPage(1)
            }}
            className={`flex flex-col items-center justify-center p-2.5 md:p-3 rounded-lg border transition-all
              ${activeTab === 'recuperadas' && entregadasFilter === 'ayer'
                ? 'bg-green-100 border-green-400 ring-2 ring-green-300/50 text-green-800'
                : 'bg-green-50/60 text-green-600 border-green-100 hover:bg-green-100 hover:border-green-300 cursor-pointer'
              }`}
          >
            <p className="text-lg md:text-xl font-black tabular-nums leading-none">{perf?.recuperadasAyer ?? '…'}</p>
            <p className="text-[9px] md:text-[10px] font-medium mt-1 text-center leading-tight opacity-80">Entregadas ayer</p>
          </button>

          {([
            {
              label: 'Reprogramados hoy',
              count: perf?.pedidosReprogramadosHoy ?? '…',
              cls:   'bg-purple-50 text-purple-700 border-purple-100',
            },
            {
              label: 'Contactados hoy',
              count: perf?.pedidosContactadosHoy ?? '…',
              cls:   'bg-blue-50 text-blue-700 border-blue-100',
            },
            {
              label: 'Sin respuesta hoy',
              count: perf?.pedidosNoRespondenHoy ?? '…',
              cls:   'bg-amber-50 text-amber-700 border-amber-100',
            },
            {
              label: 'No salvables hoy',
              count: perf?.pedidosNoSalvablesHoy ?? '…',
              cls:   'bg-gray-50 text-gray-600 border-gray-200',
            },
          ] as const).map(({ label, count, cls }) => (
            <div key={label}
                 className={`flex flex-col items-center justify-center p-2.5 md:p-3 rounded-lg border ${cls}`}>
              <p className="text-lg md:text-xl font-black tabular-nums leading-none">{count}</p>
              <p className="text-[9px] md:text-[10px] font-medium mt-1 text-center leading-tight opacity-80">{label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Sin novedades activas ── */}
      {!loading && activeOrders.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-6 text-center">
          <p className="text-green-700 font-medium">No hay pedidos con novedad activos</p>
          <p className="text-green-600 text-sm mt-1">
            Los pedidos aparecerán aquí cuando su estado sea NOVEDAD
          </p>
        </div>
      )}

      {/* ── Tabla/Cards + buscador + tabs ── */}
      {(loading || allOrders.length > 0 || recuperadasDbOrders.length > 0 || indemnizacionOrders.length > 0) && (
        <div className="bg-white rounded-xl border-2 border-red-200 overflow-hidden shadow-sm">

          {/* Info header */}
          <div className="px-4 py-2.5 md:px-5 md:py-3 bg-red-50 border-b border-red-200 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            <p className="text-xs md:text-sm font-semibold text-red-800">
              {infoBannerText}
            </p>
          </div>

          {/* Buscador */}
          <div className="px-3 py-2.5 md:px-4 md:py-3 border-b border-red-100 bg-white">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Buscar guía, nombre, teléfono, ciudad, motivo…"
                className="w-full pl-9 pr-4 py-2.5 md:py-2 text-sm border border-gray-200 rounded-lg
                           focus:outline-none focus:ring-2 focus:ring-red-300 focus:border-red-300
                           placeholder:text-gray-400"
              />
            </div>
          </div>

          {/* Tabs de filtro — touch-friendly */}
          {!loading && (
            <div className="flex border-b border-red-100 overflow-x-auto">
              {TAB_META.map(({ tab, label }) => {
                const isActive = activeTab === tab
                const count = tab === 'recuperadas' && entregadasFilter
                  ? displayedRecuperadas.length
                  : tabCounts[tab]
                return (
                  <button
                    key={tab}
                    onClick={() => handleTabChange(tab)}
                    className={`flex items-center gap-1.5 px-3 md:px-4 py-3 md:py-2.5
                                text-xs font-semibold border-b-2 transition-colors
                                whitespace-nowrap shrink-0 min-h-[44px]
                      ${isActive
                        ? 'border-red-500 text-red-700 bg-red-50/60'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                      }`}
                  >
                    {label}
                    {tab === 'recuperadas' && entregadasFilter && (
                      <span className="text-[9px] bg-green-500 text-white px-1.5 py-0.5 rounded-full font-bold">
                        {entregadasFilter}
                      </span>
                    )}
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full
                      ${isActive
                        ? 'bg-red-500 text-white'
                        : 'bg-gray-100 text-gray-500'
                      }`}>
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Vista vacía de tab */}
          {!loading && activeCount === 0 && (allOrders.length > 0 || recuperadasDbOrders.length > 0) && (
            <div className="px-5 py-10 text-center">
              <p className="text-gray-500 font-medium">
                {searchQuery
                  ? `Sin resultados para "${searchQuery}"`
                  : 'No hay pedidos en esta categoría'}
              </p>
              <button
                onClick={() => { handleTabChange('sin-contacto'); setSearchQuery('') }}
                className="text-red-500 text-sm mt-2 hover:underline"
              >
                Ver Sin contacto
              </button>
            </div>
          )}

          {/* Spinner */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Spinner className="w-6 h-6 text-red-500" />
            </div>
          )}

          {/* ── MOBILE: Cards novedades activas (< md) ── */}
          {!loading && activeTab !== 'recuperadas' && activeTab !== 'indemnizacion' && pagedOrders.length > 0 && (
            <div className="md:hidden divide-y divide-red-50">
              <div className="p-3 space-y-3">
                {pagedOrders.map(order => {
                  const busy = !!loadingRow[order.id]

                  const lastRawFecha = getLatestNovedadEvent(order.tracking_novedades)?.fecha ?? null
                  const novedadSrc   = order.last_novedad_at ?? (lastRawFecha ? parseEFIDate(lastRawFecha) : null)

                  const dias = daysInNovedad(order)
                  const intentos = order.delivery_attempts ?? 0
                  const sug  = intentos === 2 ? supervisorSuggestion(dias) : null

                  const isHighlighted = !!(trackingParam && order.tracking_number === trackingParam)

                  return (
                    <NovedadCard
                      key={order.id}
                      order={order}
                      busy={busy}
                      novedadSrc={novedadSrc}
                      sug={sug}
                      onContacted={() => handleContacted(order.id)}
                      onNoAnswer={() => handleNoAnswer(order.id)}
                      onReprogramar={() => { setReprogError(null); setReprogramandoId(order.id) }}
                      onNoSalvable={() => markNoSalvable(order.id)}
                      onRecuperada={() => markRecuperada(order.id)}
                      onConfirm={type => handleConfirm(order.id, type)}
                      isHighlighted={isHighlighted}
                    />
                  )
                })}
              </div>
            </div>
          )}

          {/* ── DESKTOP: Tabla novedades activas (≥ md) ── */}
          {!loading && activeTab !== 'recuperadas' && activeTab !== 'indemnizacion' && pagedOrders.length > 0 && (
            <table className="hidden md:table w-full text-sm">
              <thead className="bg-red-50/60 border-b border-red-100">
                <tr>
                  {['Guía', 'Cliente', 'Ciudad', 'Novedad', 'Contactar', 'Acción', ''].map(h => (
                    <th key={h}
                        className="px-3 py-3 text-left text-xs font-semibold text-red-800 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-red-50">
                {pagedOrders.map(order => {
                  const nombre    = order.customer_name ?? ''
                  const intentos  = order.delivery_attempts ?? 0
                  const waUrl     = whatsAppUrl(order.customer_phone, buildNovedadMsg(nombre, order.product_summary))
                  const telUrl    = callUrl(order.customer_phone)
                  const hasPhone  = !!order.customer_phone
                  const busy      = !!loadingRow[order.id]
                  const noSalv       = order.follow_up_result === 'no_action'
                  const isRecuperada = order.follow_up_result === 'recovered'
                  const needsConfirm = order.novelty_type == null && order.delivery_resolution !== 'rescheduled'
                  const badge     = noveltyBadge(order)
                  const playbook  = playbookFor(order)
                  const incumplido = acuerdoIncumplido(order)
                  const motivo    = motivoReal(order)

                  const lastRawFecha = getLatestNovedadEvent(order.tracking_novedades)?.fecha ?? null
                  const novedadSrc   = order.last_novedad_at ?? (lastRawFecha ? parseEFIDate(lastRawFecha) : null)

                  const dias = daysInNovedad(order)
                  const sug  = intentos === 2 ? supervisorSuggestion(dias) : null

                  const rowClass = noSalv || isRecuperada
                    ? 'bg-gray-50/60'
                    : intentos >= 3
                      ? 'bg-red-50/30 hover:bg-red-50/60'
                      : intentos === 2
                        ? 'bg-orange-50/20 hover:bg-orange-50/40'
                        : 'hover:bg-gray-50/40'

                  const isHighlighted = trackingParam && order.tracking_number === trackingParam

                  return (
                    <tr
                      key={order.id}
                      ref={el => { if (el) rowRefs.current.set(order.id, el) }}
                      className={`transition-colors group ${rowClass}
                        ${isHighlighted ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/60' : ''}`}
                    >

                      {/* Guía */}
                      <td className="px-3 py-2.5">
                        <p className="font-mono text-xs font-semibold text-gray-900 whitespace-nowrap">
                          {order.tracking_number ?? '—'}
                        </p>
                        {order.order_number && (
                          <p className="font-mono text-[10px] text-gray-400 mt-0.5">
                            {order.order_number}
                          </p>
                        )}
                        {novedadSrc && (
                          <p className="text-[10px] text-gray-400 mt-0.5 whitespace-nowrap">
                            {daysSince(novedadSrc)}
                          </p>
                        )}
                        <span className={`inline-flex text-[9px] font-bold px-1.5 py-0.5 rounded-full mt-1
                          ${intentos >= 3 ? 'bg-red-100 text-red-700' : intentos === 2 ? 'bg-orange-100 text-orange-700' : 'bg-yellow-100 text-yellow-700'}`}>
                          {intentos} int.
                        </span>
                      </td>

                      {/* Cliente */}
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[150px]">
                          {nombre || '—'}
                        </p>
                        <p className="font-mono text-xs text-gray-500 mt-0.5">
                          {order.customer_phone ?? '—'}
                        </p>
                      </td>

                      {/* Ciudad */}
                      <td className="px-3 py-2.5">
                        {(() => {
                          const ubicacion = order.city
                            || order.province
                            || (order.customer_address ? order.customer_address.slice(0, 22) : null)
                          return (
                            <div className="flex items-start gap-1 text-gray-600">
                              <MapPin className="w-3 h-3 text-gray-400 shrink-0 mt-0.5" />
                              <span className="text-xs truncate max-w-[100px]">{ubicacion || '—'}</span>
                            </div>
                          )
                        })()}
                        {order.city && order.province && order.city !== order.province && (
                          <p className="text-[10px] text-gray-400 mt-0.5 ml-4 truncate max-w-[100px]">
                            {order.province}
                          </p>
                        )}
                      </td>

                      {/* Novedad: badge + motivo + última gestión + reprogramación + playbook */}
                      <td className="px-3 py-2.5 max-w-[240px]">
                        <div className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-1">
                            <span title={badge.tooltip}
                                  className={`self-start inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${COLOR_STYLES[badge.color].badge}`}>
                              <badge.Icon className="w-2.5 h-2.5" />
                              {badge.label.toUpperCase()}
                            </span>
                            {isVencido(order) && (
                              <span title="El acuerdo pasó su fecha sin nueva gestión"
                                    className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
                                <AlertCircle className="w-2.5 h-2.5" />Vencido
                              </span>
                            )}
                            {order.novelty_type === 'no_contact' && countConsecutiveNoContact(order.tracking_novedades) >= 2 && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-800">
                                {countConsecutiveNoContact(order.tracking_novedades)} consec. sin contacto
                              </span>
                            )}
                          </div>
                          {motivo && (
                            <div>
                              <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wide">Motivo de Gintracom</p>
                              <p className="text-xs text-gray-700 truncate" title={motivo}>{motivo}</p>
                            </div>
                          )}
                          <p className="text-[10px] text-gray-400">
                            Última novedad: {novedadSrc ? timeAgo(novedadSrc) : '—'} · Gestión: {lastActionLabel(order)}
                            {order.last_escalation_at && <span className="text-orange-600 ml-1">· Escalado {timeAgo(order.last_escalation_at)}</span>}
                          </p>
                          {order.delivery_resolution === 'rescheduled' && order.rescheduled_date && (
                            <p className="text-[10px] font-semibold text-purple-700">
                              {order.rescheduled_date}{order.rescheduled_note ? ` · ${order.rescheduled_note}` : ''}
                            </p>
                          )}
                          {incumplido && (
                            <p className="text-[10px] text-gray-400">
                              Último acuerdo incumplido — {order.rescheduled_date}
                            </p>
                          )}
                          {sug ? (
                            <span className={`self-start text-[10px] font-semibold px-1.5 py-0.5 rounded-full leading-tight
                              ${sug.severity === 'critical' ? 'bg-red-200 text-red-800' : sug.severity === 'high' ? 'bg-orange-200 text-orange-800' : 'bg-amber-100 text-amber-700'}`}>
                              {sug.text}
                            </span>
                          ) : !noSalv && !isRecuperada ? (
                            <p className={`text-[10px] italic font-medium ${COLOR_STYLES[playbook.color].playbookTitle}`}>{playbook.title}</p>
                          ) : null}
                        </div>
                      </td>

                      {/* Contactar */}
                      <td className="px-3 py-2.5">
                        {hasPhone ? (
                          <div className="flex items-center gap-1.5">
                            {waUrl && (
                              <a href={waUrl} target="_blank" rel="noopener noreferrer"
                                 className="flex items-center gap-1 bg-green-500 hover:bg-green-600
                                            text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg
                                            transition-colors shadow-sm">
                                <MessageCircle className="w-3.5 h-3.5" />WA
                              </a>
                            )}
                            {telUrl && (
                              <a href={telUrl}
                                 className="flex items-center gap-1 bg-blue-500 hover:bg-blue-600
                                            text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg
                                            transition-colors shadow-sm">
                                <Phone className="w-3.5 h-3.5" />Llamar
                              </a>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-300 italic">Sin teléfono</span>
                        )}
                      </td>

                      {/* Acción */}
                      <td className="px-3 py-2.5">
                        {noSalv ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold
                                           px-2.5 py-1 rounded-full bg-gray-100 text-gray-500">
                            <XCircle className="w-3 h-3" />No salvable
                          </span>
                        ) : isRecuperada ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold
                                           px-2.5 py-1 rounded-full bg-green-100 text-green-700">
                            <CheckCircle2 className="w-3 h-3" />Recuperado
                          </span>
                        ) : busy ? (
                          <Spinner className="w-4 h-4 text-red-500" />
                        ) : needsConfirm ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleConfirm(order.id, 'contacted')}
                              className="bg-blue-100 hover:bg-blue-200 text-blue-700 text-[11px] font-medium px-2 py-1 rounded"
                            >
                              Sí contactó
                            </button>
                            <button
                              onClick={() => handleConfirm(order.id, 'no_contact')}
                              className="bg-red-100 hover:bg-red-200 text-red-700 text-[11px] font-medium px-2 py-1 rounded"
                            >
                              No
                            </button>
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-1">
                            <button
                              onClick={() => handleContacted(order.id)}
                              className="flex items-center gap-1 bg-slate-100 hover:bg-slate-200
                                         text-slate-700 text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <CheckCircle2 className="w-3 h-3 shrink-0" />Contactado
                            </button>
                            <button
                              onClick={() => { setReprogError(null); setReprogramandoId(order.id) }}
                              className="flex items-center gap-1 bg-purple-100 hover:bg-purple-200
                                         text-purple-700 text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <CalendarClock className="w-3 h-3 shrink-0" />Reprogramar
                            </button>
                            <button
                              onClick={() => handleNoAnswer(order.id)}
                              className="flex items-center gap-1 bg-amber-100 hover:bg-amber-200
                                         text-amber-700 text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <PhoneMissed className="w-3 h-3 shrink-0" />No resp.
                            </button>
                            <button
                              onClick={() => markNoSalvable(order.id)}
                              className="flex items-center gap-1 bg-red-100 hover:bg-red-200
                                         text-red-700 text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <XCircle className="w-3 h-3 shrink-0" />No salv.
                            </button>
                            <button
                              onClick={() => markRecuperada(order.id)}
                              className="col-span-2 flex items-center justify-center gap-1
                                         bg-green-100 hover:bg-green-200 text-green-700
                                         text-[11px] font-medium px-2 py-1 rounded
                                         transition-colors whitespace-nowrap"
                            >
                              <CheckCircle2 className="w-3 h-3 shrink-0" />Recuperado
                            </button>
                          </div>
                        )}
                      </td>

                      {/* Ver detalle */}
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/orders/${order.id}`}
                          className="inline-flex items-center gap-1 text-xs font-medium
                                     text-red-600 hover:text-red-800 whitespace-nowrap hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Ver detalle
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {/* ── MOBILE: Cards entregadas (< md) ── */}
          {!loading && activeTab === 'recuperadas' && pagedRecuperadas.length > 0 && (
            <div className="md:hidden p-3 space-y-3">
              {pagedRecuperadas.map(({ order, delivered_at }) => (
                <EntregadaCard key={order.id} order={order} delivered_at={delivered_at} />
              ))}
            </div>
          )}

          {/* ── DESKTOP: Tabla ✓ Entregadas (≥ md) ── */}
          {!loading && activeTab === 'recuperadas' && pagedRecuperadas.length > 0 && (
            <table className="hidden md:table w-full text-sm">
              <thead className="bg-green-50/60 border-b border-green-100">
                <tr>
                  {['Guía', 'Cliente', 'Teléfono', 'Ubicación', 'Entregado', 'Intentos previos', ''].map(h => (
                    <th key={h}
                        className="px-3 py-3 text-left text-xs font-semibold text-green-800 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-green-50">
                {pagedRecuperadas.map(({ order, delivered_at }) => {
                  const intentos = order.delivery_attempts ?? 0
                  const ubicacion = order.city
                    || order.province
                    || (order.customer_address ? order.customer_address.slice(0, 28) : null)

                  return (
                    <tr key={order.id} className="hover:bg-green-50/30 transition-colors">

                      <td className="px-3 py-2.5">
                        <p className="font-mono text-xs font-semibold text-gray-900 whitespace-nowrap">
                          {order.tracking_number ?? '—'}
                        </p>
                        {order.order_number && (
                          <p className="font-mono text-[10px] text-gray-400 mt-0.5">
                            {order.order_number}
                          </p>
                        )}
                      </td>

                      <td className="px-3 py-2.5">
                        <p className="font-medium text-gray-900 text-sm leading-tight truncate max-w-[160px]">
                          {order.customer_name ?? '—'}
                        </p>
                      </td>

                      <td className="px-3 py-2.5">
                        <p className="font-mono text-xs text-gray-600">
                          {order.customer_phone ?? '—'}
                        </p>
                      </td>

                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-1 text-gray-600">
                          <MapPin className="w-3 h-3 text-gray-400 shrink-0 mt-0.5" />
                          <span className="text-xs truncate max-w-[120px]">{ubicacion || '—'}</span>
                        </div>
                        {order.city && order.province && order.city !== order.province && (
                          <p className="text-[10px] text-gray-400 mt-0.5 ml-4 truncate max-w-[120px]">
                            {order.province}
                          </p>
                        )}
                      </td>

                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                          <span className="text-xs text-green-700 font-semibold">
                            {formatEventDate(delivered_at)}
                          </span>
                        </div>
                        <p className="text-[10px] text-gray-400 mt-0.5 ml-4">
                          {new Date(delivered_at).toLocaleDateString('es-DO', {
                            day: '2-digit', month: 'short',
                            hour: '2-digit', minute: '2-digit',
                            timeZone: 'America/Santo_Domingo',
                          })}
                        </p>
                      </td>

                      <td className="px-3 py-2.5">
                        <span className={`inline-flex items-center gap-1 text-xs font-bold
                                         px-2 py-0.5 rounded-full tabular-nums
                          ${intentos >= 3
                            ? 'bg-red-100 text-red-700'
                            : intentos === 2
                              ? 'bg-orange-100 text-orange-700'
                              : intentos === 1
                                ? 'bg-yellow-100 text-yellow-700'
                                : 'bg-gray-100 text-gray-500'
                          }`}>
                          {intentos} intento{intentos !== 1 ? 's' : ''}
                        </span>
                        {order.last_attempt_reason && (
                          <p className="text-[10px] text-gray-400 mt-0.5 truncate max-w-[100px]"
                             title={order.last_attempt_reason}>
                            {order.last_attempt_reason}
                          </p>
                        )}
                      </td>

                      <td className="px-3 py-2.5">
                        <Link
                          href={`/orders/${order.id}`}
                          className="inline-flex items-center gap-1 text-xs font-medium
                                     text-green-600 hover:text-green-800 whitespace-nowrap hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Ver detalle
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {/* ── MOBILE: Cards indemnizacion (< md) ── */}
          {!loading && activeTab === 'indemnizacion' && indemnizacionOrders.length > 0 && (
            <div className="md:hidden p-3 space-y-3">
              {indemnizacionOrders.map(order => {
                const ubicacion = order.city || order.province || ''
                const lastUpdate = order.last_tracking_update ?? order.created_at
                return (
                  <div key={order.id} className="bg-violet-50/60 border border-violet-200 rounded-xl p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-xs font-bold text-violet-800 truncate">
                          {order.tracking_number}
                        </p>
                        <p className="text-[10px] text-violet-500">
                          {order.order_number ? `#${order.order_number}` : ''}
                        </p>
                      </div>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-100 text-violet-700 border border-violet-200 shrink-0">
                        <Scale className="w-3 h-3" />
                        Indemnización
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <User className="w-3 h-3 text-violet-400 shrink-0" />
                      <p className="text-xs font-semibold text-gray-800 truncate">{order.customer_name}</p>
                    </div>
                    {order.customer_phone && (
                      <div className="flex items-center gap-1.5">
                        <Phone className="w-3 h-3 text-violet-400 shrink-0" />
                        <a href={`tel:${order.customer_phone}`}
                           className="text-xs text-violet-700 hover:underline">{order.customer_phone}</a>
                      </div>
                    )}
                    {ubicacion && (
                      <div className="flex items-center gap-1.5">
                        <MapPin className="w-3 h-3 text-violet-400 shrink-0" />
                        <span className="text-xs text-gray-600 truncate">{ubicacion}</span>
                      </div>
                    )}
                    {lastUpdate && (
                      <p className="text-[10px] text-gray-400">
                        Última act.: {formatEventDate(lastUpdate)}
                      </p>
                    )}
                    <Link
                      href={`/orders/${order.id}`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-violet-600 hover:text-violet-800 hover:underline"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Ver detalle
                    </Link>
                  </div>
                )
              })}
            </div>
          )}

          {/* ── DESKTOP: Tabla indemnizacion (≥ md) ── */}
          {!loading && activeTab === 'indemnizacion' && indemnizacionOrders.length > 0 && (
            <table className="hidden md:table w-full text-sm">
              <thead className="bg-violet-50/60 border-b border-violet-100">
                <tr>
                  {['Guía / Pedido', 'Cliente', 'Teléfono', 'Ubicación', 'Última actualización', ''].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-violet-700 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-violet-50">
                {indemnizacionOrders.map(order => {
                  const ubicacion = order.city || order.province || '—'
                  const lastUpdate = order.last_tracking_update ?? order.created_at
                  return (
                    <tr key={order.id} className="hover:bg-violet-50/40 transition-colors">
                      <td className="px-3 py-2.5">
                        <p className="text-xs font-bold text-violet-800">{order.tracking_number}</p>
                        {order.order_number && (
                          <p className="text-[10px] text-gray-400">#{order.order_number}</p>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="text-xs font-semibold text-gray-800">{order.customer_name}</p>
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-violet-100 text-violet-700 mt-0.5">
                          <Scale className="w-2.5 h-2.5" />
                          Indemnización
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {order.customer_phone ? (
                          <a href={`tel:${order.customer_phone}`}
                             className="text-xs text-violet-700 hover:underline">{order.customer_phone}</a>
                        ) : <span className="text-xs text-gray-400">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-start gap-1 text-gray-600">
                          <MapPin className="w-3 h-3 text-gray-400 shrink-0 mt-0.5" />
                          <span className="text-xs truncate max-w-[120px]">{ubicacion}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {lastUpdate ? (
                          <span className="text-xs text-gray-500">{formatEventDate(lastUpdate)}</span>
                        ) : <span className="text-xs text-gray-400">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/orders/${order.id}`}
                          className="inline-flex items-center gap-1 text-xs font-medium
                                     text-violet-600 hover:text-violet-800 whitespace-nowrap hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Ver detalle
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {/* ── Empty state indemnizacion ── */}
          {!loading && activeTab === 'indemnizacion' && indemnizacionOrders.length === 0 && (
            <div className="py-12 text-center">
              <Scale className="w-10 h-10 text-violet-300 mx-auto mb-3" />
              <p className="text-sm font-semibold text-gray-500">Sin indemnizaciones activas</p>
            </div>
          )}

          {/* Paginación */}
          {!loading && totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 md:px-5 border-t border-red-100 bg-red-50/40">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg
                           border border-red-200 text-red-700 bg-white hover:bg-red-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors
                           min-h-[40px]"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Anterior
              </button>
              <span className="text-xs text-gray-500 tabular-nums text-center">
                <span className="font-bold text-gray-800">{currentPage}</span>/{' '}
                <span className="font-bold text-gray-800">{totalPages}</span>
                <span className="hidden sm:inline">
                  {' '}·{' '}
                  <span className="text-gray-400">
                    {activeCount} resultado{activeCount !== 1 ? 's' : ''}
                  </span>
                </span>
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg
                           border border-red-200 text-red-700 bg-white hover:bg-red-50
                           disabled:opacity-40 disabled:cursor-not-allowed transition-colors
                           min-h-[40px]"
              >
                Siguiente
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {!loading && allOrders.length > 200 && (
            <div className="px-5 py-3 bg-red-50 border-t border-red-100 text-center">
              <p className="text-xs text-red-700">
                Mostrando 200 de más pedidos.{' '}
                <Link href="/orders?status=novedad" className="font-semibold underline">
                  Ver todos en Pedidos
                </Link>
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Flujo recomendado ── */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl px-4 py-3 md:px-5 md:py-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          <strong className="text-gray-700">Flujo recomendado:</strong>{' '}
          Restablece o confirma la comunicación con el cliente →
          Coordina el próximo intento y, si hay acuerdo real de fecha, regístralo en &quot;Reprogramar&quot; →
          Si no hay forma de contactar tras varios intentos, marca &quot;No salv.&quot; para gestionar la devolución.
        </p>
      </div>

      {/* ── Modal de reprogramación ── */}
      {reprogramandoOrder && (
        <ReprogramarModal
          order={reprogramandoOrder}
          saving={reprogSaving}
          error={reprogError}
          onClose={() => { setReprogramandoId(null); setReprogError(null) }}
          onSave={(date, note) => handleReschedule(reprogramandoOrder.id, date, note)}
        />
      )}
    </div>
  )
}
