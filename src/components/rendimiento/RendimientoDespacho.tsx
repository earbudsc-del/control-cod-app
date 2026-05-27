'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Spinner } from '@/components/ui/spinner'
import {
  RefreshCw, Target, Zap, Trophy, TrendingUp, TrendingDown, Minus,
  CheckCircle2, Clock, Star, Package, Truck, AlertTriangle,
  BarChart3, Activity, ChevronRight, Flame,
} from 'lucide-react'
import type { DispatchScoreData } from '@/lib/dispatch-agent'
import { DISPATCH_SLA_HORAS } from '@/lib/dispatch-agent'

// ── Level config ───────────────────────────────────────────────────────────────

const LEVEL_CFG = {
  Excelente: {
    text:   'text-green-700',
    bg:     'bg-green-50',
    badge:  'bg-green-100 text-green-800',
    bar:    'bg-green-500',
    border: 'border-green-300',
    ring:   'stroke-green-500',
    hero:   'from-green-600 via-green-500 to-emerald-500',
    heroShadow: 'shadow-green-200/50',
  },
  Bueno: {
    text:   'text-blue-700',
    bg:     'bg-blue-50',
    badge:  'bg-blue-100 text-blue-800',
    bar:    'bg-blue-500',
    border: 'border-blue-300',
    ring:   'stroke-blue-500',
    hero:   'from-blue-600 via-blue-500 to-indigo-500',
    heroShadow: 'shadow-blue-200/50',
  },
  Riesgo: {
    text:   'text-amber-700',
    bg:     'bg-amber-50',
    badge:  'bg-amber-100 text-amber-800',
    bar:    'bg-amber-500',
    border: 'border-amber-300',
    ring:   'stroke-amber-500',
    hero:   'from-amber-600 via-amber-500 to-orange-500',
    heroShadow: 'shadow-amber-200/50',
  },
  Deficiente: {
    text:   'text-red-700',
    bg:     'bg-red-50',
    badge:  'bg-red-100 text-red-800',
    bar:    'bg-red-500',
    border: 'border-red-300',
    ring:   'stroke-red-500',
    hero:   'from-red-600 via-red-500 to-rose-500',
    heroShadow: 'shadow-red-200/50',
  },
} as const
type Level = keyof typeof LEVEL_CFG

// ── Alerta config ──────────────────────────────────────────────────────────────

const ALERT_CFG = {
  danger:  'bg-red-50 border-red-200 text-red-800',
  warning: 'bg-amber-50 border-amber-200 text-amber-800',
  success: 'bg-green-50 border-green-200 text-green-800',
  info:    'bg-blue-50 border-blue-200 text-blue-800',
} as const

// ── Progress ring SVG ─────────────────────────────────────────────────────────

function ProgressRing({
  pct, size = 120, stroke = 10, color = 'stroke-blue-500', children,
}: {
  pct: number; size?: number; stroke?: number; color?: string; children?: React.ReactNode
}) {
  const r    = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const dash = (Math.min(pct, 100) / 100) * circ
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="currentColor" strokeWidth={stroke} className="text-gray-100" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          strokeWidth={stroke} className={color}
          strokeDasharray={circ} strokeDashoffset={circ - dash}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.8s ease' }} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  )
}

// ── Delta badge ────────────────────────────────────────────────────────────────

function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-gray-400 text-xs">—</span>
  const up  = value > 0
  const cls = up ? 'text-green-600' : value < 0 ? 'text-red-500' : 'text-gray-400'
  const Icon = up ? TrendingUp : value < 0 ? TrendingDown : Minus
  return (
    <span className={`flex items-center gap-0.5 text-xs font-bold ${cls}`}>
      <Icon className="w-3.5 h-3.5" />
      {value > 0 ? '+' : ''}{value}
    </span>
  )
}

// ── KPI card ───────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, icon: Icon, color = 'blue', delta, highlight = false,
}: {
  label: string; value: string | number; sub?: string
  icon?: React.ElementType; color?: string; delta?: number | null; highlight?: boolean
}) {
  const colorMap: Record<string, string> = {
    blue:    'bg-blue-50 text-blue-600',
    indigo:  'bg-indigo-50 text-indigo-600',
    teal:    'bg-teal-50 text-teal-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    amber:   'bg-amber-50 text-amber-600',
    red:     'bg-red-50 text-red-600',
    violet:  'bg-violet-50 text-violet-600',
    slate:   'bg-slate-50 text-slate-600',
  }
  const cls = colorMap[color] ?? colorMap['blue']
  return (
    <div className={`bg-white rounded-xl border shadow-sm p-4 flex flex-col gap-1.5 ${
      highlight ? 'border-blue-200 ring-1 ring-blue-100' : 'border-gray-100'
    }`}>
      <div className="flex items-center justify-between">
        {Icon && (
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${cls}`}>
            <Icon className="w-4 h-4" />
          </div>
        )}
        {delta !== undefined && delta !== null && <Delta value={delta} />}
      </div>
      <p className="text-2xl font-black text-gray-900 tabular-nums leading-none mt-1">{value}</p>
      <p className="text-xs font-semibold text-gray-500 leading-snug">{label}</p>
      {sub && <p className="text-[11px] text-gray-400">{sub}</p>}
    </div>
  )
}

// ── Progress bar ───────────────────────────────────────────────────────────────

function ProgressBar({
  pct, color = 'bg-blue-500', height = 'h-2.5', label, showPct = true,
}: {
  pct: number; color?: string; height?: string; label?: string; showPct?: boolean
}) {
  return (
    <div className="space-y-1">
      {(label || showPct) && (
        <div className="flex items-center justify-between text-xs">
          {label && <span className="text-gray-600 font-medium">{label}</span>}
          {showPct && <span className="font-bold text-gray-700 tabular-nums">{pct}%</span>}
        </div>
      )}
      <div className={`w-full ${height} bg-gray-100 rounded-full overflow-hidden`}>
        <div className={`${height} ${color} rounded-full transition-all duration-700 ease-out`}
          style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  )
}

// ── Score dimension bar ────────────────────────────────────────────────────────

function ScoreDim({
  label, value, max, color, description,
}: { label: string; value: number; max: number; color: string; description: string }) {
  const pct = Math.round((value / max) * 100)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <div>
          <span className="font-bold text-gray-700">{label}</span>
          <span className="text-gray-400 ml-1.5">{description}</span>
        </div>
        <span className="font-black text-gray-800 tabular-nums">{value}<span className="text-gray-400 font-normal">/{max}</span></span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-2 ${color} rounded-full transition-all duration-700`}
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// ── Mini bar chart (productividad semanal) ─────────────────────────────────────

function WeekChart({
  data, maxGoal,
}: {
  data: DispatchScoreData['weeklyActivity']
  maxGoal: number
}) {
  const maxVal = Math.max(...data.map(d => d.processed), maxGoal, 1)
  const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' })
  return (
    <div className="flex items-end gap-1.5 h-20">
      {data.map(day => {
        const pct     = (day.processed / maxVal) * 100
        const isToday = day.dateKey === today
        const hitGoal = day.processed >= maxGoal
        return (
          <div key={day.dateKey} className="flex-1 flex flex-col items-center gap-1">
            <div className="w-full flex flex-col justify-end h-14 relative">
              {/* Meta line */}
              <div className="absolute w-full border-t border-dashed border-gray-300"
                style={{ bottom: `${(maxGoal / maxVal) * 100}%` }} />
              <div
                className={`w-full rounded-t-sm transition-all duration-700 ${
                  hitGoal ? 'bg-green-500' : isToday ? 'bg-blue-500' : 'bg-gray-300'
                }`}
                style={{ height: `${Math.max(pct, day.processed > 0 ? 8 : 0)}%` }}
              />
            </div>
            <span className={`text-[10px] font-semibold tabular-nums ${
              isToday ? 'text-blue-600 font-black' : 'text-gray-500'
            }`}>
              {day.dayLabel}
            </span>
            {day.processed > 0 && (
              <span className="text-[9px] text-gray-400 tabular-nums">{day.processed}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Formato de tiempo relativo ─────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins   = Math.floor(diffMs / 60000)
  if (mins < 60)  return `Hace ${mins}min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)   return `Hace ${hrs}h`
  return `Hace ${Math.floor(hrs / 24)}d`
}

function formatAvgTime(minutes: number | null): string {
  if (minutes === null) return '—'
  if (minutes < 60) return `${minutes}min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}min` : `${h}h`
}

// ── Componente principal ───────────────────────────────────────────────────────

export function RendimientoDespacho() {
  const [data, setData]         = useState<DispatchScoreData | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/dispatch-agent/score')
      if (!res.ok) throw new Error('fetch error')
      const json: DispatchScoreData = await res.json()
      setData(json)
      setLastUpdate(new Date())
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <div className="text-center space-y-3">
          <Spinner className="w-8 h-8 text-blue-500 mx-auto" />
          <p className="text-gray-500 text-sm">Cargando tu centro de control…</p>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-64 gap-4 px-4">
        <p className="text-gray-500 text-center">No se pudo cargar el rendimiento.</p>
        <button onClick={fetchData}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold">
          <RefreshCw className="w-4 h-4" />Reintentar
        </button>
      </div>
    )
  }

  const lc           = LEVEL_CFG[data.level as Level]
  const deltaHoyAyer = data.confirmadosProcesadosAyer > 0
    ? Math.round(((data.confirmadosProcesadosHoy - data.confirmadosProcesadosAyer) / data.confirmadosProcesadosAyer) * 100)
    : null

  // Alertas de tipo danger primero, luego warning, info, success
  const sortedAlerts = [...data.alerts].sort((a, b) => {
    const order = { danger: 0, warning: 1, info: 2, success: 3 }
    return order[a.type] - order[b.type]
  })

  const slaOk = data.avgDispatchTimeMinutes !== null
    && data.avgDispatchTimeMinutes <= DISPATCH_SLA_HORAS * 60

  return (
    <div className="space-y-5 pb-8">

      {/* ── Hero header — estado operativo ──────────────────────────────────── */}
      <div className={`relative overflow-hidden rounded-2xl
                      bg-gradient-to-br ${lc.hero}
                      shadow-lg ${lc.heroShadow} border border-white/20`}>
        {/* Decoración */}
        <div className="absolute -right-6 -top-6 w-36 h-36 rounded-full bg-white/10" />
        <div className="absolute -right-2 -bottom-8 w-20 h-20 rounded-full bg-white/10" />
        <div className="absolute left-0 bottom-0 w-full h-12 bg-gradient-to-t from-black/10 to-transparent" />

        <div className="relative px-5 py-5 md:px-6 md:py-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              {/* Nombre y rol */}
              <p className="text-white/70 text-xs font-semibold uppercase tracking-wider mb-0.5">
                Agente de despacho
              </p>
              <h1 className="text-xl font-black text-white truncate">
                {data.agentName}
              </h1>

              {/* Procesados hoy */}
              <div className="mt-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-5xl font-black text-white tabular-nums leading-none">
                    {data.confirmadosProcesadosHoy}
                  </span>
                  <div>
                    <p className="text-white/80 text-sm font-semibold leading-tight">procesados</p>
                    <p className="text-white/60 text-xs">hoy</p>
                  </div>
                  {deltaHoyAyer !== null && (
                    <span className={`text-xs font-black px-2 py-0.5 rounded-full ${
                      deltaHoyAyer >= 0 ? 'bg-white/20 text-white' : 'bg-black/20 text-white/80'
                    }`}>
                      {deltaHoyAyer >= 0 ? '+' : ''}{deltaHoyAyer}% vs ayer
                    </span>
                  )}
                </div>
                <p className="text-white/70 text-xs mt-1">
                  {data.guiasEFIAsignadasHoy} guías EFI · {data.despachosLocalesHoy} despachos locales
                </p>
              </div>
            </div>

            {/* Score ring */}
            <div className="shrink-0">
              <ProgressRing pct={data.score} size={72} stroke={7} color="stroke-white">
                <div className="text-center">
                  <p className="text-xl font-black text-white tabular-nums leading-none">{data.score}</p>
                  <p className="text-[9px] text-white/60 font-bold">SCORE</p>
                </div>
              </ProgressRing>
            </div>
          </div>

          {/* Meta del día */}
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/80 font-medium flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5" />
                Meta diaria: {data.metaDiaria} pedidos
              </span>
              <span className="text-white font-black tabular-nums">
                {data.confirmadosProcesadosHoy}/{data.metaDiaria}
              </span>
            </div>
            <div className="h-2.5 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-2.5 bg-white rounded-full transition-all duration-700"
                style={{ width: `${data.progresoMetaDiaria}%` }}
              />
            </div>
            {data.progresoMetaDiaria >= 100
              ? <p className="text-white/90 text-xs">🎉 ¡Meta del día cumplida!</p>
              : <p className="text-white/70 text-xs">
                  Te faltan {data.metaDiaria - data.confirmadosProcesadosHoy} para completar hoy
                </p>
            }
          </div>
        </div>
      </div>

      {/* ── Alertas operativas ───────────────────────────────────────────────── */}
      {sortedAlerts.length > 0 && (
        <div className="space-y-2">
          {sortedAlerts.map((alert, i) => (
            <div key={i}
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${ALERT_CFG[alert.type]}`}>
              <span className="text-base shrink-0 mt-0.5">{alert.icon}</span>
              <p className="text-sm font-semibold">{alert.message}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── KPIs principales ─────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-black text-gray-400 uppercase tracking-wider mb-3">
          Actividad del día
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <KpiCard
            label="Guías EFI asignadas"
            value={data.guiasEFIAsignadasHoy}
            sub={`Ayer: ${data.guiasEFIAsignadasAyer}`}
            icon={Package}
            color="indigo"
            delta={data.guiasEFIAsignadasAyer > 0
              ? data.guiasEFIAsignadasHoy - data.guiasEFIAsignadasAyer
              : null}
            highlight
          />
          <KpiCard
            label="Despachos locales"
            value={data.despachosLocalesHoy}
            sub={`Ayer: ${data.despachosLocalesAyer}`}
            icon={Truck}
            color="teal"
            delta={data.despachosLocalesAyer > 0
              ? data.despachosLocalesHoy - data.despachosLocalesAyer
              : null}
          />
        </div>
      </div>

      {/* ── Backlog ────────────────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-black text-gray-400 uppercase tracking-wider mb-3">
          Backlog operativo
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <KpiCard
            label="Pendientes sin guía"
            value={data.pendientesSinGuia}
            sub="Confirmados sin asignar"
            icon={Package}
            color={data.pendientesSinGuia >= 20 ? 'amber' : data.pendientesSinGuia >= 10 ? 'amber' : 'slate'}
          />
          <KpiCard
            label="Backlog +24h"
            value={data.backlog24h}
            sub="Esperan más de un día"
            icon={AlertTriangle}
            color={data.backlog24h >= 5 ? 'red' : data.backlog24h > 0 ? 'amber' : 'emerald'}
          />
        </div>
      </div>

      {/* ── SLA + tiempo promedio ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className={`w-4 h-4 ${slaOk ? 'text-green-500' : 'text-amber-500'}`} />
            <span className="text-xs font-bold text-gray-600 uppercase tracking-wider">Tiempo prom.</span>
          </div>
          <p className={`text-2xl font-black tabular-nums ${
            slaOk ? 'text-green-700' : data.avgDispatchTimeMinutes === null ? 'text-gray-400' : 'text-amber-700'
          }`}>
            {formatAvgTime(data.avgDispatchTimeMinutes)}
          </p>
          <p className="text-[11px] text-gray-400 mt-1">confirmado → despachado</p>
          <p className={`text-[11px] mt-1 font-semibold ${slaOk ? 'text-green-600' : 'text-gray-400'}`}>
            SLA: &lt;{DISPATCH_SLA_HORAS}h {slaOk ? '✓ cumplido' : ''}
          </p>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4 text-blue-500" />
            <span className="text-xs font-bold text-gray-600 uppercase tracking-wider">Semana</span>
          </div>
          <p className="text-2xl font-black text-gray-900 tabular-nums">
            {data.confirmadosSemana}
          </p>
          <p className="text-[11px] text-gray-400 mt-1">procesados esta semana</p>
          <ProgressBar
            pct={data.progresoMetaSemanal}
            color={data.progresoMetaSemanal >= 100 ? 'bg-green-500' : 'bg-blue-500'}
            height="h-1.5"
            showPct={false}
          />
          <p className="text-[10px] text-gray-400 mt-1">Meta: {data.metaSemanal}</p>
        </div>
      </div>

      {/* ── Score operativo desglosado ────────────────────────────────────────── */}
      <div className={`bg-white rounded-2xl border-2 ${lc.border} shadow-sm p-4 md:p-5`}>
        <div className="flex items-center gap-3 mb-5">
          <ProgressRing pct={data.score} size={80} stroke={8} color={lc.ring}>
            <div className="text-center">
              <p className="text-xl font-black text-gray-900 tabular-nums leading-none">{data.score}</p>
              <p className="text-[9px] text-gray-400 font-bold mt-0.5">/ 100</p>
            </div>
          </ProgressRing>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-sm font-black px-3 py-1 rounded-full ${lc.badge}`}>
                {data.level}
              </span>
            </div>
            <h2 className="text-xs font-black text-gray-400 uppercase tracking-wider mb-0.5">
              Score operativo
            </h2>
            <p className="text-xs text-gray-500">
              Sin métricas de dinero — solo rendimiento
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <ScoreDim
            label="Volumen"
            value={data.scoreVolumen}
            max={40}
            color={lc.bar}
            description="pedidos procesados / semana"
          />
          <ScoreDim
            label="Velocidad"
            value={data.scoreVelocidad}
            max={20}
            color={data.scoreVelocidad >= 16 ? 'bg-green-500' : data.scoreVelocidad >= 10 ? 'bg-amber-500' : 'bg-red-500'}
            description={`SLA: <${DISPATCH_SLA_HORAS}h`}
          />
          <ScoreDim
            label="Backlog"
            value={data.scoreBacklog}
            max={30}
            color={data.scoreBacklog >= 25 ? 'bg-green-500' : data.scoreBacklog >= 15 ? 'bg-amber-500' : 'bg-red-500'}
            description="pedidos >24h sin despachar"
          />
        </div>

        {/* Próximo nivel */}
        {data.level !== 'Excelente' && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-500">
              {data.level === 'Deficiente' && `Necesitas ${60 - data.score} pts para nivel Riesgo`}
              {data.level === 'Riesgo'     && `Necesitas ${75 - data.score} pts para nivel Bueno`}
              {data.level === 'Bueno'      && `Necesitas ${90 - data.score} pts para nivel Excelente`}
            </p>
          </div>
        )}
      </div>

      {/* ── Objetivos diarios ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 md:p-5">
        <h2 className="text-xs font-black text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
          <Target className="w-4 h-4 text-blue-500" />Objetivos del día
        </h2>
        <div className="space-y-3">
          {/* Objetivo 1: pedidos */}
          <div className="flex items-center gap-3">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
              data.progresoMetaDiaria >= 100 ? 'bg-green-100' : 'bg-gray-100'
            }`}>
              {data.progresoMetaDiaria >= 100
                ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                : <span className="text-xs font-black text-gray-400">{data.progresoMetaDiaria}%</span>
              }
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-semibold text-gray-700">Procesar {data.metaDiaria} pedidos</span>
                <span className="font-black text-gray-600 tabular-nums">
                  {data.confirmadosProcesadosHoy}/{data.metaDiaria}
                </span>
              </div>
              <ProgressBar
                pct={data.progresoMetaDiaria}
                color={data.progresoMetaDiaria >= 100 ? 'bg-green-500' : 'bg-blue-500'}
                height="h-1.5" showPct={false}
              />
            </div>
          </div>

          {/* Objetivo 2: backlog */}
          <div className="flex items-center gap-3">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
              data.backlog24h === 0 ? 'bg-green-100' : 'bg-amber-100'
            }`}>
              {data.backlog24h === 0
                ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                : <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              }
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-gray-700">Mantener backlog &lt;10 pedidos</span>
                <span className={`font-black tabular-nums ${
                  data.pendientesSinGuia < 10 ? 'text-green-600' : 'text-amber-600'
                }`}>{data.pendientesSinGuia} actuales</span>
              </div>
            </div>
          </div>

          {/* Objetivo 3: SLA */}
          <div className="flex items-center gap-3">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
              slaOk ? 'bg-green-100' : 'bg-gray-100'
            }`}>
              {slaOk
                ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                : <Clock className="w-3.5 h-3.5 text-gray-400" />
              }
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-gray-700">SLA despacho &lt;{DISPATCH_SLA_HORAS}h</span>
                <span className={`font-black tabular-nums ${
                  slaOk ? 'text-green-600' : data.avgDispatchTimeMinutes === null ? 'text-gray-400' : 'text-amber-600'
                }`}>
                  {data.avgDispatchTimeMinutes === null ? '—' : formatAvgTime(data.avgDispatchTimeMinutes)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Productividad semanal ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 md:p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-black text-gray-400 uppercase tracking-wider flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-blue-500" />Productividad semanal
          </h2>
          <div className="flex items-center gap-3 text-[10px] text-gray-400">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" />Meta cumplida</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />Hoy</span>
          </div>
        </div>
        <WeekChart data={data.weeklyActivity} maxGoal={data.metaDiaria} />

        {/* Totales semanales */}
        <div className="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-gray-50">
          {[
            { label: 'Semana', value: data.confirmadosSemana, bold: true },
            { label: 'EFI',    value: data.guiasEFISemana,   bold: false },
            { label: 'Local',  value: data.despachosLocalesSemana, bold: false },
          ].map(({ label, value, bold }) => (
            <div key={label} className="text-center">
              <p className={`tabular-nums ${bold ? 'text-lg font-black text-blue-700' : 'text-base font-bold text-gray-700'}`}>
                {value}
              </p>
              <p className="text-[10px] text-gray-400">{label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Coaching ──────────────────────────────────────────────────────────── */}
      {data.coaching.length > 0 && (
        <div className="space-y-2">
          {data.coaching.map((msg, i) => (
            <div key={i}
              className="flex items-start gap-3 bg-gradient-to-r from-blue-50 to-transparent
                         border border-blue-100 rounded-xl px-4 py-3">
              <Star className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <p className="text-sm text-blue-900 font-medium">{msg}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Actividad reciente ────────────────────────────────────────────────── */}
      {data.recentActivity.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 md:p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-black text-gray-400 uppercase tracking-wider flex items-center gap-2">
              <Flame className="w-4 h-4 text-blue-500" />Actividad reciente
            </h2>
            <Link href="/confirmados"
              className="flex items-center gap-1 text-xs text-blue-600 font-semibold hover:text-blue-800">
              Ver pedidos <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <div className="space-y-2">
            {data.recentActivity.map((act, i) => (
              <div key={i}
                className="flex items-center justify-between gap-3 py-2
                           border-b border-gray-50 last:border-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                    act.actionType === 'tracking_assigned'
                      ? 'bg-indigo-100 text-indigo-600'
                      : 'bg-teal-100 text-teal-600'
                  }`}>
                    {act.actionType === 'tracking_assigned'
                      ? <Package className="w-3.5 h-3.5" />
                      : <Truck className="w-3.5 h-3.5" />
                    }
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-gray-800 truncate">
                      {act.orderNumber ? `#${act.orderNumber}` : act.orderId.slice(0, 8)}
                    </p>
                    <p className="text-[11px] text-gray-500">
                      {act.actionType === 'tracking_assigned' ? 'Guía EFI asignada' : 'Despacho local SD'}
                    </p>
                  </div>
                </div>
                <span className="text-[11px] text-gray-400 shrink-0">{timeAgo(act.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Footer ────────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-1">
        <p className="text-xs text-gray-400">
          Actualizado {lastUpdate.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800
                       disabled:opacity-40 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
          <Link href="/confirmados"
            className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800">
            <Package className="w-3.5 h-3.5" />Ver confirmados
          </Link>
        </div>
      </div>

      {/* ── Cómo se calcula el score ──────────────────────────────────────────── */}
      <details className="bg-gray-50 border border-gray-100 rounded-xl">
        <summary className="px-4 py-3 text-xs font-semibold text-gray-500 cursor-pointer
                            hover:text-gray-700 flex items-center gap-2">
          <TrendingUp className="w-3.5 h-3.5" />¿Cómo se calcula el score operativo?
        </summary>
        <div className="px-4 pb-4 pt-1 space-y-2">
          {[
            ['Volumen (40pts)',   `Pedidos procesados vs meta semanal (${DISPATCH_SLA_HORAS * 60 > 0 ? '' : ''}${50})`],
            ['Velocidad (20pts)', `Tiempo promedio de despacho (SLA: <${DISPATCH_SLA_HORAS}h = 16pts, <2h = 20pts)`],
            ['Backlog (30pts)',   'Sin pedidos >24h sin despachar = 30pts máx, -3pts por cada uno'],
            ['Base (10pts)',      'Puntos base por operar'],
          ].map(([dim, desc]) => (
            <div key={dim} className="flex gap-2 text-xs">
              <span className="font-black text-blue-700 shrink-0 w-32">{dim}</span>
              <span className="text-gray-600">{desc}</span>
            </div>
          ))}
          <p className="text-[10px] text-gray-400 mt-2 border-t border-gray-200 pt-2">
            El score es 100% operativo. No incluye dinero, pagos ni rentabilidad.
            El admin puede ver métricas financieras en su propia vista.
          </p>
        </div>
      </details>

    </div>
  )
}
