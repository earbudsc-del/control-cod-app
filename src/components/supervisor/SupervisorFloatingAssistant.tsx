'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Bot, X, ChevronRight, AlertTriangle, AlertOctagon,
  Info, CheckCircle2, RefreshCw, Clock,
} from 'lucide-react'
import type { AgentFeedResponse, AgentAlert } from '@/app/api/supervisor-ia/agent-feed/route'
import type { UserRole } from '@/types'

// ── Roles que ven el asistente ────────────────────────────────────────────────

const AGENT_ROLES: UserRole[] = ['confirmation_agent', 'novelty_agent', 'delivery_agent']

// ── Estilos por severidad ─────────────────────────────────────────────────────

const SEVERITY_STYLES = {
  critical: {
    bar:   'bg-red-500',
    badge: 'bg-red-100 text-red-700',
    label: 'Crítico',
    Icon:  AlertOctagon,
    btn:   'bg-red-600 hover:bg-red-700',
  },
  warning: {
    bar:   'bg-amber-400',
    badge: 'bg-amber-100 text-amber-700',
    label: 'Importante',
    Icon:  AlertTriangle,
    btn:   'bg-amber-600 hover:bg-amber-700',
  },
  info: {
    bar:   'bg-blue-400',
    badge: 'bg-blue-100 text-blue-700',
    label: 'Info',
    Icon:  Info,
    btn:   'bg-blue-600 hover:bg-blue-700',
  },
} as const

// ── Etiqueta del rol ──────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  confirmation_agent: 'Agente de Confirmación',
  novelty_agent:      'Agente de Novedad',
  delivery_agent:     'Agente de Reparto',
}

// ── Componente de alerta individual ──────────────────────────────────────────

function AlertItem({ alert, onClose }: { alert: AgentAlert; onClose: () => void }) {
  const st   = SEVERITY_STYLES[alert.severity]
  const Icon = st.Icon

  return (
    <div className="flex gap-0">
      <div className={`w-1 shrink-0 ${st.bar}`} />
      <div className="flex-1 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-70" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
              <span className="text-xs font-semibold text-gray-800 leading-tight">{alert.title}</span>
              <span className={`text-[9px] font-bold uppercase tracking-wide px-1 py-0.5 rounded-full ${st.badge}`}>
                {st.label}
              </span>
            </div>
            <p className="text-xs text-gray-600 leading-snug">{alert.message}</p>
          </div>
        </div>
        {alert.href && (
          <div className="mt-1.5 ml-5">
            <Link
              href={alert.href}
              onClick={onClose}
              className={`inline-flex items-center gap-1 text-[10px] font-semibold
                          px-2 py-1 rounded text-white transition-colors ${st.btn}`}
            >
              Ver casos
              <ChevronRight className="w-2.5 h-2.5" />
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Panel de sección ──────────────────────────────────────────────────────────

function SectionBlock({
  title, items, onClose,
}: {
  title:   string
  items:   AgentAlert[]
  onClose: () => void
}) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400 bg-gray-50 border-b border-gray-100">
        {title}
      </p>
      <div className="divide-y divide-gray-50">
        {items.map(a => <AlertItem key={a.id} alert={a} onClose={onClose} />)}
      </div>
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

interface Props {
  role: UserRole | string
}

export function SupervisorFloatingAssistant({ role }: Props) {
  const [open, setOpen]       = useState(false)
  const [feed, setFeed]       = useState<AgentFeedResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastAt, setLastAt]   = useState<Date | null>(null)
  const intervalRef           = useRef<ReturnType<typeof setInterval> | null>(null)

  // No mostrar para roles no-agente
  if (!AGENT_ROLES.includes(role as UserRole)) return null

  const fetchFeed = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/supervisor-ia/agent-feed')
      if (!res.ok) return
      const data: AgentFeedResponse = await res.json()
      setFeed(data)
      setLastAt(new Date())
    } catch {
      // silencioso — no interrumpir la UI del agente
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchFeed()
    intervalRef.current = setInterval(fetchFeed, 5 * 60 * 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [fetchFeed])

  // Cerrar panel con Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  const criticalCount = feed
    ? feed.alerts.filter(a => a.severity === 'critical').length
    : 0
  const totalCount = feed
    ? feed.alerts.length + feed.priorities.length
    : 0

  const hasCritical = criticalCount > 0

  return (
    <>
      {/* ── Botón flotante ── */}
      <button
        onClick={() => setOpen(o => !o)}
        className={`fixed bottom-6 right-6 z-40 flex items-center gap-2
                    px-3 py-2.5 rounded-xl shadow-lg border transition-all duration-200
                    ${hasCritical
                      ? 'bg-red-600 border-red-700 hover:bg-red-700 text-white'
                      : 'bg-gray-900 border-gray-700 hover:bg-gray-800 text-white'
                    }`}
        aria-label="Supervisor IA"
      >
        <div className="relative">
          {loading
            ? <RefreshCw className="w-4 h-4 animate-spin" />
            : <Bot className="w-4 h-4" />
          }
          {totalCount > 0 && (
            <span className={`absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-0.5
                              flex items-center justify-center rounded-full
                              text-[9px] font-black leading-none
                              ${hasCritical ? 'bg-white text-red-700' : 'bg-red-500 text-white'}`}>
              {totalCount > 99 ? '99+' : totalCount}
            </span>
          )}
        </div>
        <span className="hidden sm:block text-xs font-semibold">Supervisor IA</span>
      </button>

      {/* ── Overlay ── */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/30"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Panel lateral ── */}
      <div
        className={`fixed top-0 right-0 h-full w-80 max-w-[calc(100vw-3rem)] z-50
                    bg-white shadow-2xl border-l border-gray-200
                    flex flex-col transition-transform duration-300 ease-in-out
                    ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3.5 bg-gray-900 shrink-0">
          <div className="flex items-center justify-center w-7 h-7 bg-indigo-500 rounded-lg shrink-0">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-white leading-none">Supervisor IA</p>
            <p className="text-[10px] text-gray-400 mt-0.5 truncate">
              {feed ? ROLE_LABELS[feed.role] ?? feed.role : ROLE_LABELS[role] ?? role}
            </p>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="p-1.5 text-gray-400 hover:text-white rounded-lg transition-colors"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Timestamp + refresh */}
        <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
            <Clock className="w-3 h-3" />
            {lastAt
              ? `Actualizado ${lastAt.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}`
              : 'Cargando…'
            }
          </div>
          <button
            onClick={fetchFeed}
            disabled={loading}
            className="flex items-center gap-1 text-[10px] font-medium text-indigo-600
                       hover:text-indigo-800 disabled:opacity-40 transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        </div>

        {/* Contenido */}
        <div className="flex-1 overflow-y-auto">
          {loading && !feed && (
            <div className="flex items-center justify-center h-32">
              <RefreshCw className="w-5 h-5 text-gray-300 animate-spin" />
            </div>
          )}

          {!loading && !feed && (
            <div className="flex flex-col items-center justify-center h-32 gap-2 text-gray-400">
              <Bot className="w-6 h-6 opacity-30" />
              <p className="text-xs">Sin datos disponibles</p>
            </div>
          )}

          {feed && (
            <div className="divide-y divide-gray-100">
              <SectionBlock title="Alertas" items={feed.alerts} onClose={() => setOpen(false)} />
              <SectionBlock title="Prioridades del día" items={feed.priorities} onClose={() => setOpen(false)} />
              <SectionBlock title="Coaching" items={feed.coaching} onClose={() => setOpen(false)} />

              {feed.alerts.length === 0 && feed.priorities.length === 0 && feed.coaching.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-2 py-8 text-gray-400">
                  <CheckCircle2 className="w-8 h-8 text-green-400" />
                  <p className="text-sm font-medium text-gray-600">Todo en orden</p>
                  <p className="text-xs text-center px-4">No tienes casos críticos ni pendientes urgentes ahora.</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-100 shrink-0">
          <p className="text-[10px] text-gray-400 text-center">
            Se actualiza cada 5 min · Control COD
          </p>
        </div>
      </div>
    </>
  )
}
