'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { StatusBadge } from '@/components/orders/status-badge'
import { ClassificationBadge } from '@/components/orders/classification-badge'
import { SlaBadge } from '@/components/orders/sla-badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  formatDate, formatCurrency, timeAgo, getSlaStatus, whatsAppUrl, callUrl,
} from '@/lib/utils'
import {
  ACTION_LABELS, CONTACT_RESULT_LABELS,
  type Order, type Note, type AgentAction, type OrderAssignment,
  type DeliveryAttemptRecord, type OrderHistory, type Profile,
  type ActionType, type ContactResult, type Classification,
  type InvalidReason, type FollowUpResult,
} from '@/types'
import {
  ArrowLeft, MessageSquare, MessageCircle, Phone, Zap, UserCheck, Clock,
  AlertTriangle, CheckCircle2, RotateCcw, ShieldAlert, RefreshCw,
  MapPinOff, Navigation, HelpCircle, AlertCircle, CreditCard, ArrowUpCircle,
} from 'lucide-react'
import { checkCoverage, isTransferOrder } from '@/lib/alert-helpers'
import { OrderCodLabelActions } from '@/components/order-label/OrderCodLabelActions'

interface OrderDetail {
  order:       Order
  notes:       Note[]
  actions:     AgentAction[]
  assignments: OrderAssignment[]
  attempts:    DeliveryAttemptRecord[]
  history:     OrderHistory[]
}

const INVALID_REASONS: { value: InvalidReason; label: string }[] = [
  { value: 'courier_no_call',       label: 'Mensajero no llamó' },
  { value: 'courier_no_show',       label: 'Mensajero no fue' },
  { value: 'courier_mismanagement', label: 'Mala gestión courier' },
  { value: 'wrong_address_used',    label: 'Dirección incorrecta' },
  { value: 'other',                 label: 'Otro' },
]

function buildOperativeWaMsg(order: Order): string {
  const nombre   = (order.customer_name ?? '').trim() || 'cliente'
  const producto = (order.product_summary ?? '').trim()
  const p        = producto.length > 32 ? producto.slice(0, 30) + '...' : producto || 'tu pedido'
  return [
    `Hola ${nombre} 😊,`,
    '',
    `Te contactamos por tu pedido de ${p}${order.tracking_number ? ` (guía ${order.tracking_number})` : ''}.`,
    '',
    '¿Podemos ayudarte con algo?',
  ].join('\n')
}

interface OrderOperativeContentProps {
  orderId:    string
  onBack?:    () => void
  onMutated?: () => void
}

export function OrderOperativeContent({ orderId, onBack, onMutated }: OrderOperativeContentProps) {
  const [detail, setDetail]           = useState<OrderDetail | null>(null)
  const [loadError, setLoadError]     = useState<string | null>(null)
  const [loading, setLoading]         = useState(true)
  const [agents, setAgents]           = useState<Profile[]>([])
  const [noteText, setNoteText]       = useState('')
  const [savingNote, setSavingNote]   = useState(false)
  const [actionType, setActionType]   = useState<ActionType>('contacted')
  const [contactResult, setContactResult] = useState<ContactResult>('no_answer')
  const [actionNotes, setActionNotes]     = useState('')
  const [savingAction, setSavingAction]   = useState(false)
  const [actionFeedback, setActionFeedback] = useState<'success' | 'error' | null>(null)
  const [selectedAgent, setSelectedAgent]   = useState('')
  const [assignFeedback, setAssignFeedback] = useState<'success' | 'error' | null>(null)
  const [showHistorial, setShowHistorial]   = useState(false)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [waConversationId, setWaConversationId] = useState<string | null>(null)
  const [escalating, setEscalating] = useState(false)
  const [escalateFeedback, setEscalateFeedback] = useState<'success' | 'error' | null>(null)

  async function load() {
    setLoadError(null)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [detailRes, agentsRes, tasksRes]: [any, any, { tasks: any[] }] = await Promise.all([
        fetch(`/api/orders/${orderId}`).then(r => r.json()),
        fetch('/api/profiles').then(r => r.json()),
        fetch('/api/my-tasks').then(r => r.json()),
      ])

      // La API puede devolver { error: '...' } en vez de la estructura esperada
      if (!detailRes?.order) {
        setLoadError(detailRes?.error ?? 'Pedido no encontrado')
        return
      }

      setDetail(detailRes)
      setAgents(Array.isArray(agentsRes) ? agentsRes : [])
      setSelectedAgent(detailRes.order?.assigned_to ?? '')
      const task = (tasksRes.tasks ?? []).find((t: { order_id: string | null }) => t.order_id === orderId)
      setTaskId(task?.id ?? null)
    } catch (err) {
      console.error('[OrderOperativeContent] load error:', err)
      setLoadError('Error al cargar el pedido. Verifica tu conexión e intenta de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  async function patchTask(body: Record<string, unknown>) {
    if (!taskId) return
    await fetch(`/api/tasks/${taskId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
  }

  useEffect(() => { load() }, [orderId])

  useEffect(() => {
    setWaConversationId(null)
    fetch(`/api/orders/${orderId}/whatsapp-conversation`)
      .then(r => r.ok ? r.json() : null)
      .then(json => setWaConversationId(json?.conversationId ?? null))
      .catch(() => setWaConversationId(null))
  }, [orderId])

  async function handleAddNote() {
    if (!noteText.trim()) return
    setSavingNote(true)
    await fetch(`/api/orders/${orderId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: noteText }),
    })
    setNoteText('')
    setSavingNote(false)
    load()
    onMutated?.()
  }

  async function handleAddAction() {
    setSavingAction(true)
    setActionFeedback(null)
    const taskBody = actionType === 'rescheduled'
      ? { status: 'completed', result: 'rescheduled' }
      : { status: 'in_progress' }
    const [res] = await Promise.all([
      fetch(`/api/orders/${orderId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_type: actionType,
          contact_result: actionType === 'contacted' ? contactResult : undefined,
          notes: actionNotes || undefined,
        }),
      }),
      patchTask(taskBody),
    ])
    setActionNotes('')
    setSavingAction(false)
    if (res.ok) {
      setActionFeedback('success')
      load()
      onMutated?.()
    } else {
      setActionFeedback('error')
    }
    setTimeout(() => setActionFeedback(null), 3_000)
  }

  async function handleEscalar() {
    setEscalating(true)
    setEscalateFeedback(null)
    try {
      const res = await fetch(`/api/orders/${orderId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_type: 'courier_claim', notes: 'Escalado desde detalle operativo' }),
      })
      setEscalateFeedback(res.ok ? 'success' : 'error')
      if (res.ok) {
        load()
        onMutated?.()
      }
    } finally {
      setEscalating(false)
      setTimeout(() => setEscalateFeedback(null), 3_000)
    }
  }

  async function handleFollowUpResult(value: FollowUpResult) {
    const TASK_RESULT: Partial<Record<FollowUpResult, string>> = {
      delivered: 'delivered',
      returned:  'returned',
      recovered: 'recovered',
      no_action: 'no_action',
    }
    await fetch(`/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ follow_up_result: value }),
    })
    const taskResult = TASK_RESULT[value]
    if (taskResult) {
      await patchTask({ status: 'completed', result: taskResult })
    }
    load()
    onMutated?.()
  }

  async function handleAssign() {
    setAssignFeedback(null)
    const res = await fetch(`/api/orders/${orderId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_to: selectedAgent || null }),
    })
    if (res.ok) {
      setAssignFeedback('success')
      load()
      onMutated?.()
    } else {
      setAssignFeedback('error')
    }
    setTimeout(() => setAssignFeedback(null), 3_000)
  }

  async function handleClassification(cls: Classification | null) {
    await fetch(`/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classification: cls }),
    })
    load()
    onMutated?.()
  }

  async function handleInvalidateAttempt(attemptId: string, reason: InvalidReason) {
    await fetch(`/api/orders/${orderId}/attempts/${attemptId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_valid: false, invalid_reason: reason }),
    })
    load()
    onMutated?.()
  }

  // ── Estados de carga y error ────────────────────────────────────────────────

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Spinner className="w-8 h-8 text-blue-600" />
    </div>
  )

  if (loadError) return (
    <div className="flex flex-col items-center justify-center h-64 gap-4 px-4 text-center">
      <AlertCircle className="w-10 h-10 text-red-400" />
      <div>
        <p className="text-gray-700 font-medium">No se pudo cargar el pedido</p>
        <p className="text-gray-500 text-sm mt-1">{loadError}</p>
      </div>
      <div className="flex gap-3">
        <button
          onClick={load}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium
                     bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Reintentar
        </button>
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium
                       border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Volver
          </button>
        )}
      </div>
    </div>
  )

  // Doble guardia: null y estructura inesperada (detail sin order)
  if (!detail?.order) return (
    <div className="px-4 py-8 text-center">
      <p className="text-gray-500">Pedido no encontrado.</p>
      {onBack && (
        <button onClick={onBack} className="text-blue-600 text-sm mt-2 hover:underline">
          Volver
        </button>
      )}
    </div>
  )

  const { order } = detail
  // Arrays con fallback defensivo — protege contra respuestas de API malformadas
  const notes       = detail.notes       ?? []
  const actions     = detail.actions     ?? []
  const assignments = detail.assignments ?? []
  const attempts    = detail.attempts    ?? []
  const history     = detail.history     ?? []

  const slaStatus  = getSlaStatus(order.sla_deadline, order.sla_breached)
  const coverage   = checkCoverage(order.customer_address, order.city, order.province)
  const isTransfer = isTransferOrder(order.product_summary)
  const waUrl      = whatsAppUrl(order.customer_phone, buildOperativeWaMsg(order))
  const telUrl     = callUrl(order.customer_phone)

  return (
    <div className="space-y-4 md:space-y-6 max-w-5xl">

      {/* Header */}
      <div className="flex items-start gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="mt-1 p-1 -ml-1 text-gray-400 hover:text-gray-600 rounded-lg
                       hover:bg-gray-100 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg md:text-xl font-bold font-mono text-gray-900 break-all">
              {order.tracking_number}
            </h1>
            <StatusBadge status={order.normalized_status} />
            {order.classification && <ClassificationBadge classification={order.classification} />}
            {order.is_at_risk && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700 font-medium">
                <AlertTriangle className="w-3 h-3" /> En riesgo
              </span>
            )}
            {order.customer_confirmed && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">
                <CheckCircle2 className="w-3 h-3" /> Cliente confirmó
              </span>
            )}
          </div>
          {order.order_number && (
            <p className="text-sm text-gray-500 mt-1">Pedido EFI: {order.order_number}</p>
          )}
        </div>
        {order.classification && (
          <SlaBadge status={slaStatus} deadline={order.sla_deadline} />
        )}
      </div>

      {/* Barra de acciones rápidas — gestión activa sin salir de este panel */}
      <div className="flex flex-wrap items-center gap-2">
        {waConversationId ? (
          <a
            href={`/inbox?conversation=${waConversationId}`}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 bg-green-600 text-white px-3.5 py-2 rounded-lg
                       text-sm font-semibold hover:bg-green-700 transition-colors"
          >
            <MessageSquare className="w-4 h-4" />
            Abrir conversación (Inbox)
          </a>
        ) : waUrl ? (
          <a
            href={waUrl}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 bg-green-500 text-white px-3.5 py-2 rounded-lg
                       text-sm font-semibold hover:bg-green-600 transition-colors"
          >
            <MessageCircle className="w-4 h-4" />
            WhatsApp
          </a>
        ) : null}
        {telUrl && (
          <a
            href={telUrl}
            className="flex items-center gap-2 bg-blue-500 text-white px-3.5 py-2 rounded-lg
                       text-sm font-semibold hover:bg-blue-600 transition-colors"
          >
            <Phone className="w-4 h-4" />
            Llamar
          </a>
        )}
        <button
          onClick={handleEscalar}
          disabled={escalating}
          className="flex items-center gap-2 bg-orange-100 text-orange-700 px-3.5 py-2 rounded-lg
                     text-sm font-semibold hover:bg-orange-200 transition-colors disabled:opacity-50"
        >
          {escalating ? <Spinner className="w-4 h-4" /> : <ArrowUpCircle className="w-4 h-4" />}
          Escalar / Incidencia
        </button>
        <OrderCodLabelActions order={order} />
        {escalateFeedback && (
          <span className={`text-sm font-medium
            ${escalateFeedback === 'success' ? 'text-green-600' : 'text-red-600'}`}>
            {escalateFeedback === 'success' ? 'Escalado registrado' : 'Error al escalar'}
          </span>
        )}
      </div>

      {/* Banner duplicado */}
      {order.duplicate_alert && order.duplicate_of_order_id && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 md:px-5 md:py-4
                        flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold text-amber-800 text-sm">⚠️ Pedido duplicado detectado</p>
            <p className="text-sm text-amber-700 mt-0.5">
              Este cliente ya tiene otro pedido reciente con el mismo teléfono.{' '}
              <Link
                href={`/orders/${order.duplicate_of_order_id}`}
                className="underline font-medium hover:text-amber-900"
              >
                Ver pedido anterior →
              </Link>
            </p>
          </div>
        </div>
      )}

      {/* Banner fuera de cobertura */}
      {coverage.isOutOfCoverage && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 md:px-5 md:py-4
                        flex items-start gap-3">
          <MapPinOff className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold text-red-800 text-sm">🚫 Posible zona fuera de cobertura</p>
            <p className="text-sm text-red-700 mt-0.5">
              Verificar antes de confirmar o despachar.
              {coverage.matchedZones.length > 0 && (
                <> Zona detectada: <strong>{coverage.matchedZones.join(', ')}</strong>.</>
              )}
            </p>
          </div>
        </div>
      )}

      {/* Banner destino especial */}
      {!coverage.isOutOfCoverage && coverage.isSpecialDestination && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 md:px-5 md:py-4
                        flex items-start gap-3">
          <Navigation className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold text-blue-800 text-sm">Destino especial — coordinación requerida</p>
            <p className="text-sm text-blue-700 mt-0.5">
              Esta zona requiere coordinación adicional antes del despacho.
              {coverage.matchedZones.length > 0 && (
                <> Zona detectada: <strong>{coverage.matchedZones.join(', ')}</strong>.</>
              )}
            </p>
          </div>
        </div>
      )}

      {/* Banner zona desconocida */}
      {!coverage.isOutOfCoverage && !coverage.isSpecialDestination && coverage.isUnknownZone && (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 md:px-5 md:py-4
                        flex items-start gap-3">
          <HelpCircle className="w-5 h-5 text-yellow-500 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold text-yellow-800 text-sm">🟡 Zona no verificada</p>
            <p className="text-sm text-yellow-700 mt-0.5">
              Confirmar ubicación exacta antes de despachar. La ciudad no está registrada en la matriz de cobertura.
            </p>
          </div>
        </div>
      )}

      {/* Banner transferencia LÜMA */}
      {isTransfer && (
        <div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 md:px-5 md:py-4
                        flex items-start gap-3">
          <CreditCard className="w-5 h-5 text-violet-600 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold text-violet-800 text-sm">💳 TRANSFERENCIA · NO COD</p>
            <p className="text-sm text-violet-700 mt-0.5">
              Promoción LÜMA 3 unidades — pagada por transferencia bancaria. No despachar como COD.
            </p>
          </div>
        </div>
      )}

      {/* Grid principal — 1 col en móvil, 3 en lg */}
      <div className="grid lg:grid-cols-3 gap-4 md:gap-6">

        {/* Columna izquierda */}
        <div className="lg:col-span-2 space-y-4">

          {/* Info del pedido */}
          <div className="bg-white rounded-xl border border-gray-100 p-4 md:p-5">
            <h2 className="font-semibold text-gray-900 text-sm mb-4">Información del pedido</h2>
            <dl className="grid grid-cols-2 gap-x-4 md:gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Cliente</dt>
                <dd className="font-medium text-gray-800">{order.customer_name ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Teléfono</dt>
                <dd className="font-medium text-gray-800 break-all">{order.customer_phone ?? '—'}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-gray-400 text-xs mb-0.5">Dirección</dt>
                <dd className="font-medium text-gray-800">{order.customer_address ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Ciudad</dt>
                <dd>{order.city ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Provincia</dt>
                <dd>{order.province ?? '—'}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-gray-400 text-xs mb-0.5">Producto</dt>
                <dd>{order.product_summary ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Monto COD</dt>
                <dd className="font-bold text-green-700">{formatCurrency(order.cod_amount)}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Carrier</dt>
                <dd>{order.carrier ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-gray-400 text-xs mb-0.5">Último contacto</dt>
                <dd>{order.last_contact_at ? timeAgo(order.last_contact_at) : '—'}</dd>
              </div>
              {order.last_contact_result && (
                <div className="col-span-2">
                  <dt className="text-gray-400 text-xs mb-0.5">Resultado contacto</dt>
                  <dd>{CONTACT_RESULT_LABELS[order.last_contact_result]}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* Tracking EFI */}
          {(order.delivery_attempts > 0 || order.last_tracking_update || order.last_attempt_reason) && (
            <div className="bg-white rounded-xl border border-gray-100 p-4 md:p-5">
              <h2 className="font-semibold text-gray-900 text-sm mb-4 flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-gray-400" />
                Tracking EFI
              </h2>

              {/* Métricas — 2 cols en móvil, 3 en sm+ */}
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 md:gap-x-6 gap-y-3 text-sm">
                <div>
                  <dt className="text-gray-400 text-xs mb-0.5">Intentos de entrega</dt>
                  <dd className={`font-bold text-base ${
                    order.delivery_attempts >= 3 ? 'text-red-600' :
                    order.delivery_attempts >= 2 ? 'text-amber-600' :
                    order.delivery_attempts >= 1 ? 'text-gray-700' : 'text-gray-400'
                  }`}>
                    {order.delivery_attempts > 0 ? order.delivery_attempts : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-400 text-xs mb-0.5">Estado EFI</dt>
                  <dd className="text-gray-600 italic text-xs leading-tight mt-0.5">{order.raw_status ?? '—'}</dd>
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <dt className="text-gray-400 text-xs mb-0.5">Última actualización</dt>
                  <dd className="text-gray-600 text-xs leading-tight mt-0.5">
                    {order.last_tracking_update ? formatDate(order.last_tracking_update, true) : '—'}
                  </dd>
                </div>
              </dl>

              {/* Última observación */}
              {order.last_attempt_reason && (
                <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <p className="text-xs font-semibold text-amber-700 mb-1">
                    Última observación del mensajero
                  </p>
                  <p className="text-sm text-amber-900">{order.last_attempt_reason}</p>
                </div>
              )}

              {/* Historial de novedades */}
              {order.tracking_novedades && order.tracking_novedades.length > 0 && (
                <div className="mt-4 border-t border-gray-50 pt-4">
                  <p className="text-xs font-semibold text-gray-600 mb-2">
                    Historial de observaciones ({order.tracking_novedades.length})
                  </p>
                  <div className="space-y-2">
                    {order.tracking_novedades.map((n, i) => (
                      <div key={i} className="flex gap-3 p-2.5 rounded-lg bg-amber-50 border border-amber-100">
                        <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-amber-900 leading-snug">{n.mensaje}</p>
                          <p className="text-xs text-amber-500 mt-0.5">{n.fecha}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Historial de estados */}
              {order.tracking_history && order.tracking_history.length > 0 && (
                <div className="mt-4 border-t border-gray-50 pt-4">
                  <button
                    onClick={() => setShowHistorial(v => !v)}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                  >
                    {showHistorial
                      ? 'Ocultar historial de estados'
                      : `Ver historial de estados (${order.tracking_history.length})`}
                  </button>
                  {showHistorial && (
                    <div className="mt-3 space-y-1">
                      {order.tracking_history.map((e, i) => (
                        <div key={i} className="flex gap-3 text-xs text-gray-600">
                          <span className="text-gray-400 whitespace-nowrap shrink-0">{e.fecha}</span>
                          <span>{e.estado}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Intentos de entrega */}
          {attempts.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 p-4 md:p-5">
              <h2 className="font-semibold text-gray-900 text-sm mb-4">
                Intentos de entrega
                <span className="ml-2 text-xs text-gray-400 font-normal">
                  {attempts.filter(a => a.is_valid).length} válidos ·{' '}
                  {attempts.filter(a => !a.is_valid).length} inválidos
                </span>
              </h2>
              <div className="space-y-2">
                {attempts.map(attempt => (
                  <div key={attempt.id} className={`flex items-start gap-3 p-3 rounded-lg
                    ${!attempt.is_valid ? 'bg-red-50 border border-red-100' : 'bg-gray-50'}`}>
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center
                                    text-xs font-bold shrink-0 mt-0.5
                      ${!attempt.is_valid ? 'bg-red-200 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
                      {attempt.attempt_number}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-700">
                        Intento #{attempt.attempt_number}
                        {attempt.attempted_at && ` · ${formatDate(attempt.attempted_at)}`}
                        {attempt.source === 'manual' && (
                          <span className="ml-1 text-xs text-gray-400">(manual)</span>
                        )}
                      </p>
                      {!attempt.is_valid && attempt.invalid_reason && (
                        <p className="text-xs text-red-600 mt-0.5">
                          Invalidado: {INVALID_REASONS.find(r => r.value === attempt.invalid_reason)?.label}
                          {attempt.invalid_notes && ` — ${attempt.invalid_notes}`}
                        </p>
                      )}
                      {attempt.is_valid && (
                        <div className="flex gap-1 mt-1.5 flex-wrap">
                          {INVALID_REASONS.slice(0, 2).map(r => (
                            <button
                              key={r.value}
                              onClick={() => handleInvalidateAttempt(attempt.id, r.value)}
                              className="text-xs px-2 py-1 rounded border border-red-200
                                         text-red-600 hover:bg-red-50 transition-colors"
                              title={r.label}
                            >
                              {r.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Acciones del agente */}
          <div className="bg-white rounded-xl border border-gray-100 p-4 md:p-5">
            <h2 className="font-semibold text-gray-900 text-sm mb-4">Registrar acción</h2>
            <div className="space-y-3">
              <div className="flex gap-2 flex-col sm:flex-row">
                <select
                  value={actionType}
                  onChange={e => setActionType(e.target.value as ActionType)}
                  className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2
                             focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {(Object.keys(ACTION_LABELS) as ActionType[])
                    .filter(t => t !== 'note_added')
                    .map(t => (
                      <option key={t} value={t}>{ACTION_LABELS[t]}</option>
                    ))}
                </select>
                {actionType === 'contacted' && (
                  <select
                    value={contactResult}
                    onChange={e => setContactResult(e.target.value as ContactResult)}
                    className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2
                               focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {(Object.keys(CONTACT_RESULT_LABELS) as ContactResult[]).map(r => (
                      <option key={r} value={r}>{CONTACT_RESULT_LABELS[r]}</option>
                    ))}
                  </select>
                )}
              </div>
              <input
                value={actionNotes}
                onChange={e => setActionNotes(e.target.value)}
                placeholder="Nota sobre esta acción (opcional)"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex items-center gap-3">
                <Button onClick={handleAddAction} disabled={savingAction} size="sm">
                  {savingAction ? <Spinner className="w-4 h-4" /> : <Zap className="w-4 h-4" />}
                  Registrar acción
                </Button>
                {actionFeedback && (
                  <span className={`text-sm font-medium
                    ${actionFeedback === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                    {actionFeedback === 'success' ? 'Acción registrada' : 'Error al registrar'}
                  </span>
                )}
              </div>
            </div>

            {/* Timeline de acciones */}
            {actions.length > 0 && (
              <div className="mt-5 space-y-2 border-t border-gray-50 pt-4">
                {actions.map(action => (
                  <div key={action.id} className="flex gap-3 text-sm">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-800">
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        <span className="font-medium">{(action as any).profile?.full_name ?? '—'}</span>
                        {' — '}
                        {ACTION_LABELS[action.action_type]}
                        {action.contact_result && (
                          <span className="text-gray-500">
                            {' · '}{CONTACT_RESULT_LABELS[action.contact_result]}
                          </span>
                        )}
                      </p>
                      {action.notes && (
                        <p className="text-xs text-gray-500 mt-0.5">{action.notes}</p>
                      )}
                      <p className="text-xs text-gray-400 mt-0.5">{timeAgo(action.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Notas internas */}
          <div className="bg-white rounded-xl border border-gray-100 p-4 md:p-5">
            <h2 className="font-semibold text-gray-900 text-sm mb-4 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-gray-400" />
              Notas internas
              {notes.length > 0 && (
                <span className="text-xs text-gray-400 font-normal">({notes.length})</span>
              )}
            </h2>

            <div className="flex gap-2">
              <textarea
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                placeholder="Agregar nota interna…"
                rows={2}
                className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2
                           focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              <Button onClick={handleAddNote} disabled={savingNote || !noteText.trim()} size="sm">
                {savingNote ? <Spinner className="w-4 h-4" /> : 'Agregar'}
              </Button>
            </div>

            <div className="mt-4 space-y-3">
              {notes.map(note => (
                <div key={note.id} className="bg-gray-50 rounded-lg p-3">
                  <p className="text-sm text-gray-800">{note.content}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {(note as any).profile?.full_name ?? '—'} · {timeAgo(note.created_at)}
                  </p>
                </div>
              ))}
              {notes.length === 0 && (
                <p className="text-sm text-gray-400">Sin notas aún</p>
              )}
            </div>
          </div>
        </div>

        {/* Columna derecha — panel de control */}
        <div className="space-y-4">

          {/* Asignar responsable */}
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <h3 className="font-semibold text-gray-900 text-sm mb-3 flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-gray-400" />
              Responsable
            </h3>
            <select
              value={selectedAgent}
              onChange={e => setSelectedAgent(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2
                         focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
            >
              <option value="">Sin asignar</option>
              {agents.filter(a => a.role !== 'viewer').map(a => (
                <option key={a.id} value={a.id}>{a.full_name}</option>
              ))}
            </select>
            <Button size="sm" variant="secondary" className="w-full" onClick={handleAssign}>
              Actualizar
            </Button>
            {assignFeedback && (
              <p className={`text-xs font-medium mt-1
                ${assignFeedback === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                {assignFeedback === 'success' ? 'Responsable actualizado' : 'Error actualizando'}
              </p>
            )}

            {assignments.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-50">
                <p className="text-xs text-gray-400 mb-2">Historial de asignaciones</p>
                {assignments.map(a => (
                  <p key={a.id} className="text-xs text-gray-600">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {(a as any).assigned_profile?.full_name ?? '—'}
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    <span className="text-gray-400"> por {(a as any).assigned_by_profile?.full_name ?? '—'}</span>
                    <span className="text-gray-300"> · {formatDate(a.assigned_at)}</span>
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* Clasificación */}
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <h3 className="font-semibold text-gray-900 text-sm mb-3">Clasificación</h3>
            <div className="grid grid-cols-2 gap-2">
              {([null, 'critical', 'urgent', 'follow_up', 'claim'] as (Classification | null)[]).map(cls => (
                <button
                  key={cls ?? 'none'}
                  onClick={() => handleClassification(cls)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors
                    ${order.classification === cls
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                >
                  {cls === null       ? 'Sin clasificar' :
                   cls === 'critical' ? 'Crítico'        :
                   cls === 'urgent'   ? 'Urgente'        :
                   cls === 'follow_up'? 'Seguimiento'    : 'Reclamo'}
                </button>
              ))}
            </div>
          </div>

          {/* Resultado del seguimiento */}
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <h3 className="font-semibold text-gray-900 text-sm mb-3">Resultado final</h3>
            <div className="space-y-1.5">
              {([
                { value: 'pending',   label: 'Pendiente',  icon: Clock,         color: 'text-gray-600'  },
                { value: 'delivered', label: 'Entregado',  icon: CheckCircle2,  color: 'text-green-600' },
                { value: 'returned',  label: 'Devuelto',   icon: RotateCcw,     color: 'text-red-600'   },
                { value: 'recovered', label: 'Recuperado', icon: ShieldAlert,   color: 'text-blue-600'  },
                { value: 'no_action', label: 'Sin acción', icon: AlertTriangle, color: 'text-amber-600' },
              ] as { value: FollowUpResult; label: string; icon: React.ElementType; color: string }[]).map(
                ({ value, label, icon: Icon, color }) => (
                  <button
                    key={value}
                    onClick={() => handleFollowUpResult(value)}
                    className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm
                                text-left border transition-colors
                      ${order.follow_up_result === value
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-100 hover:bg-gray-50'
                      }`}
                  >
                    <Icon className={`w-4 h-4 ${color}`} />
                    <span className={order.follow_up_result === value
                      ? 'font-medium text-blue-700'
                      : 'text-gray-700'}>
                      {label}
                    </span>
                  </button>
                )
              )}
            </div>
          </div>

          {/* Historial de cambios */}
          {history.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <h3 className="font-semibold text-gray-900 text-sm mb-3 flex items-center gap-2">
                <Clock className="w-4 h-4 text-gray-400" />
                Historial
              </h3>
              <div className="space-y-2">
                {history.slice(0, 8).map(h => (
                  <div key={h.id} className="text-xs text-gray-600">
                    <span className="font-medium">{h.field}</span>
                    {' '}{h.old_value ?? 'vacío'} →{' '}
                    <span className="text-blue-700">{h.new_value ?? 'vacío'}</span>
                    <p className="text-gray-400">
                      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                      {(h as any).profile?.full_name ?? 'Sistema'} · {timeAgo(h.created_at)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
