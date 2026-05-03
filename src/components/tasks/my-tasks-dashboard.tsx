'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import {
  TASK_TYPE_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_COLORS,
  type TaskType,
  type TaskPriority,
} from '@/types'
import { Search, ArrowRight, Clock, MapPin, Phone, CheckCircle, CalendarClock, PhoneMissed, XCircle, AlertTriangle } from 'lucide-react'
import { daysSince } from '@/lib/utils'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface TaskOrder {
  tracking_number:      string | null
  order_number:         string | null
  customer_name:        string | null
  customer_phone:       string | null
  city:                 string | null
  normalized_status:    string
  delivery_attempts:    number
  status_since:         string | null
  last_novedad_at:      string | null
  duplicate_alert:      boolean | null
  duplicate_of_order_id: string | null
}

export interface TaskForDashboard {
  id:        string
  order_id:  string | null
  task_type: string
  priority:  string
  status:    string
  due_at:    string | null
  notes:     string | null
  created_at: string
  pedido:    TaskOrder | TaskOrder[] | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function actionHref(taskType: string, tracking: string | null): string {
  if (!tracking) return '/my-tasks'
  const t = encodeURIComponent(tracking)
  switch (taskType) {
    case 'novedad':
    case 'recovery':     return `/novedad?tracking=${t}`
    case 'confirmation': return `/confirmacion?tracking=${t}`
    case 'follow_up':    return `/reparto?tracking=${t}`
    default:             return '/my-tasks'
  }
}

const ACTION_LABEL: Record<string, string> = {
  novedad:      'Ir a Novedades',
  recovery:     'Ir a Novedades',
  confirmation: 'Ir a Confirmación',
  follow_up:    'Ir a Reparto',
}

// ─── Badge de acción registrada (novedad) ─────────────────────────────────────

const ACTION_BADGE_NOVEDAD: Record<string, { label: string; color: string }> = {
  contacted:   { label: 'Contactado',   color: 'bg-blue-100 text-blue-700'    },
  rescheduled: { label: 'Reprogramado', color: 'bg-indigo-100 text-indigo-700' },
  no_answer:   { label: 'No responde',  color: 'bg-amber-100 text-amber-700'  },
  no_salvable: { label: 'No salvable',  color: 'bg-red-100 text-red-700'      },
}

// ─── Tipos de props ───────────────────────────────────────────────────────────

interface DashboardProps {
  tasks:            TaskForDashboard[]
  summaryTitle:     string
  resolvedToday:    number
  resolvedThisWeek: number
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function MyTasksDashboard({ tasks, summaryTitle, resolvedToday, resolvedThisWeek }: DashboardProps) {
  const [query,          setQuery]    = useState('')
  const [filterPriority, setFilterP]  = useState<string>('all')
  const [filterType,     setFilterT]  = useState<string>('all')
  const [filterStatus,   setFilterSt] = useState<string>('all')

  const activeFilters = filterPriority !== 'all' || filterType !== 'all' || filterStatus !== 'all'

  const router = useRouter()
  const [loadingRow, setLoadingRow] = useState<Record<string, boolean>>({})
  const [actionMap,  setActionMap]  = useState<Record<string, string>>({})

  async function handleNovedadAction(
    taskId: string,
    orderId: string,
    actionKey: string,
    actionType: string,
    contactResult: string | null,
    taskBody: Record<string, unknown>,
  ) {
    setLoadingRow(prev => ({ ...prev, [taskId]: true }))
    try {
      await Promise.all([
        fetch(`/api/orders/${orderId}/actions`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action_type: actionType, contact_result: contactResult }),
        }),
        fetch(`/api/tasks/${taskId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(taskBody),
        }),
      ])
      setActionMap(prev => ({ ...prev, [taskId]: actionKey }))
      router.refresh()
    } finally {
      setLoadingRow(prev => ({ ...prev, [taskId]: false }))
    }
  }

  async function handleNoSalvable(taskId: string, orderId: string) {
    setLoadingRow(prev => ({ ...prev, [taskId]: true }))
    try {
      await Promise.all([
        fetch(`/api/orders/${orderId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ follow_up_result: 'no_action' }),
        }),
        fetch(`/api/tasks/${taskId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ status: 'completed', result: 'no_action' }),
        }),
      ])
      setActionMap(prev => ({ ...prev, [taskId]: 'no_salvable' }))
      router.refresh()
    } finally {
      setLoadingRow(prev => ({ ...prev, [taskId]: false }))
    }
  }

  const kpi = useMemo(() => ({
    open:       tasks.filter(t => t.status === 'open').length,
    inProgress: tasks.filter(t => t.status === 'in_progress').length,
    urgent:     tasks.filter(t => t.priority === 'high').length,
  }), [tasks])

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    return tasks.filter(task => {
      const pedido = Array.isArray(task.pedido) ? task.pedido[0] : task.pedido

      if (q) {
        const haystack = [
          pedido?.tracking_number ?? '',
          pedido?.customer_name   ?? '',
          pedido?.customer_phone  ?? '',
        ].join(' ').toLowerCase()
        if (!haystack.includes(q)) return false
      }

      if (filterPriority !== 'all' && task.priority   !== filterPriority) return false
      if (filterType     !== 'all' && task.task_type  !== filterType)     return false
      if (filterStatus   !== 'all' && task.status     !== filterStatus)   return false

      return true
    })
  }, [tasks, query, filterPriority, filterType, filterStatus])

  const availableTypes = [...new Set(tasks.map(t => t.task_type))]

  return (
    <div className="space-y-4">

      {/* ── Mini-dashboard de rendimiento ── */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
          {summaryTitle}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">

          <div className={`rounded-xl border px-3 py-2.5 text-center ${kpi.open > 0 ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-100'}`}>
            <p className={`text-xl font-bold tabular-nums ${kpi.open > 0 ? 'text-blue-700' : 'text-gray-400'}`}>{kpi.open}</p>
            <p className={`text-xs mt-0.5 ${kpi.open > 0 ? 'text-blue-600' : 'text-gray-400'}`}>Abiertas</p>
          </div>

          <div className={`rounded-xl border px-3 py-2.5 text-center ${kpi.urgent > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100'}`}>
            <p className={`text-xl font-bold tabular-nums ${kpi.urgent > 0 ? 'text-red-700' : 'text-gray-400'}`}>{kpi.urgent}</p>
            <p className={`text-xs mt-0.5 ${kpi.urgent > 0 ? 'text-red-600' : 'text-gray-400'}`}>Urgentes</p>
          </div>

          <div className={`rounded-xl border px-3 py-2.5 text-center ${kpi.inProgress > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-100'}`}>
            <p className={`text-xl font-bold tabular-nums ${kpi.inProgress > 0 ? 'text-amber-700' : 'text-gray-400'}`}>{kpi.inProgress}</p>
            <p className={`text-xs mt-0.5 ${kpi.inProgress > 0 ? 'text-amber-600' : 'text-gray-400'}`}>En progreso</p>
          </div>

          <div className={`rounded-xl border px-3 py-2.5 text-center ${resolvedToday > 0 ? 'bg-green-50 border-green-200' : 'bg-white border-gray-100'}`}>
            <p className={`text-xl font-bold tabular-nums ${resolvedToday > 0 ? 'text-green-700' : 'text-gray-400'}`}>{resolvedToday}</p>
            <p className={`text-xs mt-0.5 ${resolvedToday > 0 ? 'text-green-600' : 'text-gray-400'}`}>Resueltas hoy</p>
          </div>

          <div className={`rounded-xl border px-3 py-2.5 text-center ${resolvedThisWeek > 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-gray-100'}`}>
            <p className={`text-xl font-bold tabular-nums ${resolvedThisWeek > 0 ? 'text-emerald-700' : 'text-gray-400'}`}>{resolvedThisWeek}</p>
            <p className={`text-xs mt-0.5 ${resolvedThisWeek > 0 ? 'text-emerald-600' : 'text-gray-400'}`}>Esta semana</p>
          </div>

        </div>
      </div>

      {/* ── Sin tareas activas ── */}
      {tasks.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-10 text-center">
          <p className="font-medium text-gray-500">No tienes tareas pendientes</p>
          <p className="mt-1 text-sm text-gray-400">
            Las tareas aparecerán aquí cuando se te asignen pedidos.
          </p>
        </div>
      )}

      {/* ── Lista activa ── */}
      {tasks.length > 0 && (<>

        {/* Buscador + filtros */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Buscar por guía, cliente o teléfono…"
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                         bg-white placeholder:text-gray-400"
            />
          </div>

          <div className="flex gap-2 flex-wrap">
            <select
              value={filterPriority}
              onChange={e => setFilterP(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white
                         focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-600"
            >
              <option value="all">Prioridad</option>
              <option value="high">Alta</option>
              <option value="medium">Media</option>
              <option value="low">Baja</option>
            </select>

            <select
              value={filterType}
              onChange={e => setFilterT(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white
                         focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-600"
            >
              <option value="all">Tipo</option>
              {availableTypes.map(t => (
                <option key={t} value={t}>
                  {TASK_TYPE_LABELS[t as TaskType] ?? t}
                </option>
              ))}
            </select>

            <select
              value={filterStatus}
              onChange={e => setFilterSt(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white
                         focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-600"
            >
              <option value="all">Estado</option>
              <option value="open">Abierta</option>
              <option value="in_progress">En progreso</option>
            </select>

            {(query || activeFilters) && (
              <button
                onClick={() => { setQuery(''); setFilterP('all'); setFilterT('all'); setFilterSt('all') }}
                className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2 rounded-lg
                           border border-gray-200 bg-white hover:bg-gray-50 transition-colors"
              >
                Limpiar
              </button>
            )}
          </div>
        </div>

        {/* Conteo de resultados cuando hay filtros activos */}
        {(query || activeFilters) && (
          <p className="text-sm text-gray-500">
            {filtered.length} resultado{filtered.length !== 1 ? 's' : ''} de {tasks.length} tareas
          </p>
        )}

        {/* Sin resultados de búsqueda */}
        {filtered.length === 0 && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-10 text-center">
            <p className="font-medium text-gray-500">Sin resultados para esta búsqueda</p>
            <button
              onClick={() => { setQuery(''); setFilterP('all'); setFilterT('all'); setFilterSt('all') }}
              className="mt-2 text-sm text-blue-600 hover:underline"
            >
              Limpiar filtros
            </button>
          </div>
        )}

        {/* Tarjetas */}
        <div className="space-y-3">
          {filtered.map(task => {
            const pedido    = Array.isArray(task.pedido) ? task.pedido[0] : task.pedido
            const baseDate  = task.task_type === 'novedad'
              ? (pedido?.last_novedad_at ?? null)
              : (pedido?.status_since ?? null)
            const eventDate = baseDate ?? task.created_at
            const dateLabel = daysSince(eventDate)
            const href      = actionHref(task.task_type, pedido?.tracking_number ?? null)
            const label     = ACTION_LABEL[task.task_type] ?? 'Ver tarea'
            const isNovedad = task.task_type === 'novedad' || task.task_type === 'recovery'
            const accion    = actionMap[task.id]
            const busy      = !!loadingRow[task.id]

            return (
              <div
                key={task.id}
                className="bg-white border border-gray-200 rounded-xl p-4
                           hover:border-gray-300 hover:shadow-sm transition-all"
              >
                <div className="flex items-start justify-between gap-4">

                  {/* Info */}
                  <div className="flex-1 min-w-0">

                    {/* Badges */}
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <Badge className={TASK_PRIORITY_COLORS[task.priority as TaskPriority]}>
                        {TASK_PRIORITY_LABELS[task.priority as TaskPriority] ?? task.priority}
                      </Badge>
                      <span className="inline-flex items-center text-xs px-2 py-0.5 rounded-full
                                      bg-gray-100 text-gray-600 font-medium">
                        {TASK_TYPE_LABELS[task.task_type as TaskType] ?? task.task_type}
                      </span>
                      <span className="text-xs text-gray-400">
                        {task.status === 'open' ? 'Abierta' : 'En progreso'}
                      </span>
                      {task.task_type === 'confirmation' && pedido?.duplicate_alert && (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full
                                         bg-amber-100 text-amber-700 font-semibold border border-amber-200">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          POSIBLE DUPLICADO
                        </span>
                      )}
                    </div>

                    {/* Guía */}
                    {pedido?.tracking_number && (
                      <p className="font-mono text-sm font-semibold text-gray-900 mb-1">
                        {pedido.tracking_number}
                      </p>
                    )}

                    {/* Cliente, teléfono, ciudad */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600">
                      {pedido?.customer_name && (
                        <span>{pedido.customer_name}</span>
                      )}
                      {pedido?.customer_phone && (
                        <span className="flex items-center gap-1 font-mono text-xs text-gray-500">
                          <Phone className="w-3 h-3 shrink-0" />
                          {pedido.customer_phone}
                        </span>
                      )}
                      {pedido?.city && (
                        <span className="flex items-center gap-1 text-xs text-gray-500">
                          <MapPin className="w-3 h-3 shrink-0" />
                          {pedido.city}
                        </span>
                      )}
                    </div>

                    {/* Estado actual del pedido */}
                    {pedido?.normalized_status && (
                      <p className="mt-1 text-xs text-gray-400">
                        Pedido: <span className="font-medium text-gray-600">{pedido.normalized_status}</span>
                        {(pedido.delivery_attempts ?? 0) > 0 && (
                          <span className="ml-2 text-orange-600 font-medium">
                            · {pedido.delivery_attempts} intento{pedido.delivery_attempts !== 1 ? 's' : ''}
                          </span>
                        )}
                      </p>
                    )}

                    {/* Alerta de duplicado — solo en tareas de confirmación */}
                    {task.task_type === 'confirmation' && pedido?.duplicate_alert && pedido?.duplicate_of_order_id && (
                      <p className="mt-1.5 text-xs text-amber-600">
                        Este pedido tiene el mismo teléfono que otro pedido reciente.{' '}
                        <Link
                          href={`/orders/${pedido.duplicate_of_order_id}`}
                          className="underline font-medium hover:text-amber-800"
                        >
                          Ver pedido original →
                        </Link>
                      </p>
                    )}

                    {/* Nota */}
                    {task.notes && (
                      <p className="mt-1.5 text-xs text-gray-400 italic truncate max-w-md" title={task.notes}>
                        {task.notes}
                      </p>
                    )}

                    {/* Antigüedad del evento logístico */}
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-gray-400">
                      <Clock className="w-3 h-3 shrink-0" />
                      {dateLabel}
                      {dateLabel.startsWith('Hace') && parseInt(dateLabel.split(' ')[1]) >= 3 && (
                        <span className="text-red-500 font-semibold"> · urgente</span>
                      )}
                    </p>

                    {/* Acciones inline — solo para tareas de novedad/recovery */}
                    {isNovedad && task.order_id && (
                      accion ? (
                        <span className={`mt-2 inline-flex items-center gap-1 text-xs font-semibold
                                          px-2.5 py-1 rounded-full
                                          ${ACTION_BADGE_NOVEDAD[accion]?.color ?? 'bg-gray-100 text-gray-600'}`}>
                          <CheckCircle className="w-3 h-3" />
                          {ACTION_BADGE_NOVEDAD[accion]?.label ?? accion}
                        </span>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <button
                            disabled={busy}
                            onClick={() => handleNovedadAction(task.id, task.order_id!, 'contacted', 'contacted', null, { status: 'in_progress' })}
                            className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg
                                       bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors disabled:opacity-40"
                          >
                            <CheckCircle className="w-3 h-3" /> Contactado
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => handleNovedadAction(task.id, task.order_id!, 'rescheduled', 'rescheduled', null, { status: 'completed', result: 'rescheduled' })}
                            className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg
                                       bg-indigo-100 hover:bg-indigo-200 text-indigo-700 transition-colors disabled:opacity-40"
                          >
                            <CalendarClock className="w-3 h-3" /> Reprogramar
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => handleNovedadAction(task.id, task.order_id!, 'no_answer', 'contacted', 'no_answer', { status: 'in_progress' })}
                            className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg
                                       bg-amber-100 hover:bg-amber-200 text-amber-700 transition-colors disabled:opacity-40"
                          >
                            <PhoneMissed className="w-3 h-3" /> No responde
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => handleNoSalvable(task.id, task.order_id!)}
                            className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg
                                       bg-red-100 hover:bg-red-200 text-red-700 transition-colors disabled:opacity-40"
                          >
                            <XCircle className="w-3 h-3" /> No salvable
                          </button>
                        </div>
                      )
                    )}
                  </div>

                  {/* Botones acción */}
                  <div className="shrink-0 flex flex-col gap-1.5 items-end">
                    <Link
                      href={href}
                      className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700
                                 text-white text-xs font-semibold px-3 py-2 rounded-lg
                                 transition-colors shadow-sm whitespace-nowrap"
                    >
                      {label}
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                    {task.order_id && (
                      <Link
                        href={`/orders/${task.order_id}`}
                        className="text-xs text-gray-400 hover:text-gray-700
                                   hover:underline whitespace-nowrap transition-colors"
                      >
                        Ver detalle
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

      </>)}
    </div>
  )
}
