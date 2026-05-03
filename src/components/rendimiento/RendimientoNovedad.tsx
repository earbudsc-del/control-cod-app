'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Spinner } from '@/components/ui/spinner'
import {
  TrendingUp, TrendingDown, Minus,
  CheckCircle2, Phone, PhoneMissed, XCircle, AlertTriangle,
  Target, RefreshCw, ArrowRight, Bot,
  Info, ShieldAlert, CircleCheck,
} from 'lucide-react'
import {
  generateNoveltyFeedback,
  type FeedbackLevel,
  type NoveltyPerf,
} from '@/lib/supervisor/novelty-feedback'

// ── Score (0–100) ─────────────────────────────────────────────────────────────
// Base de 40 pts para que el score no arranque en 0.
//   Tasa recuperación → 36 pts máx  (trabajados = 0 → 0 pts, sin penalización)
//   Volumen trabajo   → 15 pts máx  (meta: 20 novedades/día)
//   Cola al día       →  9 pts máx  (≥15 atrasados = 0 pts, lineal)

const META_TRABAJO    = 20
const META_ATRASADOS  = 15
const SCORE_BASE      = 40
const SCORE_NORM      = (100 - SCORE_BASE) / 100  // 0.60

function calcScore(perf: NoveltyPerf): number {
  const tasaScore = perf.novedadesTrabajadasHoy > 0 && perf.tasaRecuperacionHoy !== null
    ? Math.min(perf.tasaRecuperacionHoy, 100) * 0.60 * SCORE_NORM
    : 0
  const volScore  = Math.min(perf.novedadesTrabajadasHoy / META_TRABAJO, 1) * 25 * SCORE_NORM
  const colaScore = Math.max(0, 1 - Math.min(perf.atrasadosPendientes / META_ATRASADOS, 1)) * 15 * SCORE_NORM
  return Math.min(100, Math.round(SCORE_BASE + tasaScore + volScore + colaScore))
}

function scoreColor(s: number) {
  if (s >= 75) return { text: 'text-green-700',  border: 'border-green-400',  bg: 'bg-green-50',  label: 'Excelente'       }
  if (s >= 50) return { text: 'text-amber-700',  border: 'border-amber-400',  bg: 'bg-amber-50',  label: 'En progreso'     }
  return           { text: 'text-red-700',    border: 'border-red-400',    bg: 'bg-red-50',    label: 'Necesita mejora' }
}

function tasaColor(tasa: number | null): string {
  if (tasa === null) return 'text-gray-400'
  if (tasa >= 70)    return 'text-green-700'
  if (tasa >= 40)    return 'text-amber-700'
  return                    'text-red-700'
}

function TrendIcon({ hoy, ayer }: { hoy: number; ayer: number }) {
  if (ayer === 0) return <Minus className="w-4 h-4 text-gray-400" />
  if (hoy > ayer) return <TrendingUp   className="w-4 h-4 text-green-500" />
  if (hoy < ayer) return <TrendingDown className="w-4 h-4 text-red-500" />
  return               <Minus         className="w-4 h-4 text-gray-400" />
}

// ── Componente principal ──────────────────────────────────────────────────────

const META_REPROGRAMADOS = 20

export function RendimientoNovedad() {
  const [perf, setPerf]               = useState<NoveltyPerf | null>(null)
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  const fetchData = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/novedad/performance').then(r => r.json() as Promise<NoveltyPerf>)
    setPerf(res)
    setLastRefresh(new Date())
    setLoading(false)
  }, [])

  // Refresco adaptativo: 30 s sin actividad, 2 min cuando hay trabajo registrado
  useEffect(() => {
    fetchData()
    const ms = !perf || perf.novedadesTrabajadasHoy === 0 ? 30_000 : 2 * 60_000
    const interval = setInterval(fetchData, ms)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData, perf?.novedadesTrabajadasHoy === 0])

  if (loading && !perf) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-red-500" />
      </div>
    )
  }

  if (!perf) return null

  const score      = calcScore(perf)
  const scoreClr   = scoreColor(score)
  const progreso   = Math.min(Math.round((perf.pedidosReprogramadosHoy / META_REPROGRAMADOS) * 100), 100)
  const supervisor = generateNoveltyFeedback(perf)

  // Pts de cada componente del score (para la barra de descomposición)
  const ptsData = [
    {
      label: 'Tasa recuperación',
      pts:   perf.novedadesTrabajadasHoy > 0 && perf.tasaRecuperacionHoy !== null
               ? Math.round(Math.min(perf.tasaRecuperacionHoy, 100) * 0.60 * SCORE_NORM)
               : 0,
      max: Math.round(60 * SCORE_NORM),  // 36
    },
    {
      label: 'Volumen trabajo',
      pts:   Math.round(Math.min(perf.novedadesTrabajadasHoy / META_TRABAJO, 1) * 25 * SCORE_NORM),
      max: Math.round(25 * SCORE_NORM),  // 15
    },
    {
      label: 'Cola al día',
      pts:   Math.round(Math.max(0, 1 - Math.min(perf.atrasadosPendientes / META_ATRASADOS, 1)) * 15 * SCORE_NORM),
      max: Math.round(15 * SCORE_NORM),  // 9
    },
  ]

  return (
    <div className="space-y-5 max-w-4xl">

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Mi rendimiento</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Seguimiento en tiempo real de tu desempeño hoy
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400">
            {lastRefresh.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5
                       bg-white border border-gray-200 rounded-lg hover:bg-gray-50
                       text-gray-600 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
          <Link
            href="/novedad"
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5
                       bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
          >
            Ir a novedades
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {/* ── Score + Meta ── */}
      <div className="grid lg:grid-cols-5 gap-4">

        {/* Score */}
        <div className={`lg:col-span-2 bg-white rounded-2xl border-2 ${scoreClr.border}
                         p-6 flex flex-col items-center justify-center gap-3 shadow-sm`}>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Score del día</p>
          <div className={`w-32 h-32 rounded-full border-4 ${scoreClr.border} ${scoreClr.bg}
                           flex flex-col items-center justify-center`}>
            <span className={`text-5xl font-black tabular-nums leading-none ${scoreClr.text}`}>
              {score}
            </span>
            <span className="text-xs text-gray-400 font-medium mt-0.5">/ 100</span>
          </div>
          <span className={`text-sm font-bold ${scoreClr.text}`}>{scoreClr.label}</span>

          {/* Descomposición del score */}
          <div className="w-full space-y-1.5 mt-1 border-t border-gray-100 pt-3">
            {ptsData.map(({ label, pts, max }) => (
              <div key={label} className="flex items-center gap-2 text-xs">
                <span className="text-gray-500 flex-1 truncate">{label}</span>
                <div className="w-20 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${score >= 75 ? 'bg-green-400' : score >= 50 ? 'bg-amber-400' : 'bg-red-400'}`}
                    style={{ width: `${max > 0 ? (pts / max) * 100 : 0}%` }}
                  />
                </div>
                <span className={`font-bold tabular-nums w-10 text-right ${scoreClr.text}`}>
                  {pts}/{max}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Meta del día */}
        <div className="lg:col-span-3 space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Target className="w-4 h-4 text-red-500" />
              <h2 className="text-sm font-bold text-gray-700">Meta del día</h2>
              <span className="ml-auto text-sm font-black tabular-nums text-red-700">
                {perf.pedidosReprogramadosHoy} / {META_REPROGRAMADOS}
              </span>
            </div>
            <div className="w-full h-3 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500
                  ${progreso >= 100 ? 'bg-green-500' : progreso >= 60 ? 'bg-red-500' : 'bg-red-400'}`}
                style={{ width: `${progreso}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-gray-500">
                {progreso >= 100
                  ? '¡Meta alcanzada!'
                  : `Faltan ${META_REPROGRAMADOS - perf.pedidosReprogramadosHoy} reprogramaciones`}
              </span>
              <span className="text-xs font-bold text-red-600">{progreso}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Tarjetas de métricas hoy ── */}
      <div className="grid grid-cols-5 gap-3">
        {([
          {
            label:  'Trabajados',
            count:  perf.novedadesTrabajadasHoy,
            Icon:   CheckCircle2,
            cls:    'bg-blue-50 border-blue-200 text-blue-700',
            numCls: 'text-blue-700',
          },
          {
            label:  'Reprogramados',
            count:  perf.pedidosReprogramadosHoy,
            Icon:   CheckCircle2,
            cls:    'bg-green-50 border-green-200 text-green-700',
            numCls: 'text-green-700',
          },
          {
            label:  'Contactados',
            count:  perf.pedidosContactadosHoy,
            Icon:   Phone,
            cls:    'bg-indigo-50 border-indigo-200 text-indigo-700',
            numCls: 'text-indigo-700',
          },
          {
            label:  'No responden',
            count:  perf.pedidosNoRespondenHoy,
            Icon:   PhoneMissed,
            cls:    'bg-amber-50 border-amber-200 text-amber-700',
            numCls: 'text-amber-700',
          },
          {
            label:  'No salvables',
            count:  perf.pedidosNoSalvablesHoy,
            Icon:   XCircle,
            cls:    'bg-red-50 border-red-200 text-red-700',
            numCls: 'text-red-700',
          },
        ] as const).map(({ label, count, Icon, cls, numCls }) => (
          <div key={label} className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 ${cls}`}>
            <Icon className="w-5 h-5 opacity-60" />
            <span className={`text-3xl font-black tabular-nums leading-none ${numCls}`}>{count}</span>
            <span className="text-[11px] font-semibold text-center leading-tight opacity-80">{label}</span>
          </div>
        ))}
      </div>

      {/* ── Hoy vs Ayer ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
          <h2 className="text-sm font-bold text-gray-700">Hoy vs Ayer</h2>
        </div>

        <div className="divide-y divide-gray-50">
          {[
            {
              label: 'Novedades trabajadas',
              hoy:   perf.novedadesTrabajadasHoy,
              ayer:  perf.trabajadosAyer,
              fmt:   (n: number) => String(n),
            },
            {
              label: 'Reprogramados',
              hoy:   perf.pedidosReprogramadosHoy,
              ayer:  perf.reprogramadosAyer,
              fmt:   (n: number) => String(n),
            },
            {
              label: 'Tasa de recuperación',
              hoy:   perf.tasaRecuperacionHoy ?? 0,
              ayer:  perf.tasaAyer            ?? 0,
              fmt:   (n: number) => (perf.tasaRecuperacionHoy === null && n === 0) ? '—' : `${n}%`,
              extraHoy:  perf.tasaRecuperacionHoy !== null ? tasaColor(perf.tasaRecuperacionHoy) : 'text-gray-400',
              extraAyer: perf.tasaAyer            !== null ? tasaColor(perf.tasaAyer)            : 'text-gray-400',
            },
          ].map(({ label, hoy, ayer, fmt, extraHoy, extraAyer }) => (
            <div key={label} className="flex items-center px-5 py-3 gap-4">
              <span className="text-sm text-gray-600 flex-1">{label}</span>
              <TrendIcon hoy={hoy} ayer={ayer} />
              <div className="w-24 text-right">
                <span className={`text-lg font-black tabular-nums ${extraHoy ?? 'text-gray-800'}`}>
                  {fmt(hoy)}
                </span>
                <span className="text-xs text-gray-400 ml-1">hoy</span>
              </div>
              <div className="w-24 text-right">
                <span className={`text-lg font-black tabular-nums ${extraAyer ?? 'text-gray-400'}`}>
                  {fmt(ayer)}
                </span>
                <span className="text-xs text-gray-300 ml-1">ayer</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Supervisor IA ── */}
      <SupervisorSection items={supervisor} />

    </div>
  )
}

// ── Supervisor IA section ─────────────────────────────────────────────────────

const LEVEL_STYLES: Record<FeedbackLevel, {
  bar:    string
  badge:  string
  label:  string
  Icon:   React.ElementType
}> = {
  danger:  { bar: 'bg-red-500',    badge: 'bg-red-100 text-red-700',     label: 'Crítico',  Icon: ShieldAlert   },
  warning: { bar: 'bg-amber-400',  badge: 'bg-amber-100 text-amber-700', label: 'Atención', Icon: AlertTriangle },
  info:    { bar: 'bg-blue-400',   badge: 'bg-blue-100 text-blue-700',   label: 'Info',     Icon: Info          },
  success: { bar: 'bg-green-500',  badge: 'bg-green-100 text-green-700', label: 'Bien',     Icon: CircleCheck   },
}

function SupervisorSection({ items }: { items: ReturnType<typeof generateNoveltyFeedback> }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">

      <div className="flex items-center gap-2.5 px-5 py-3.5
                      bg-gradient-to-r from-red-50 to-white border-b border-gray-100">
        <div className="flex items-center justify-center w-7 h-7 bg-red-600 rounded-lg shrink-0">
          <Bot className="w-4 h-4 text-white" />
        </div>
        <h2 className="text-sm font-bold text-gray-800">Supervisor IA</h2>
        {items.length > 0 && (
          <span className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full
                           bg-red-100 text-red-700">
            {items.length} observación{items.length !== 1 ? 'es' : ''}
          </span>
        )}
      </div>

      <div className="divide-y divide-gray-50">
        {items.length === 0 && (
          <div className="flex items-center gap-3 px-5 py-4 text-sm text-gray-500">
            <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
            Sin observaciones. ¡Todo en orden!
          </div>
        )}
        {items.map(item => {
          const st   = LEVEL_STYLES[item.level]
          const Icon = st.Icon
          return (
            <div key={item.id} className="flex gap-0 group">
              <div className={`w-1 shrink-0 ${st.bar}`} />
              <div className="flex-1 px-4 py-3.5">
                <div className="flex items-start gap-2 mb-1">
                  <Icon className="w-4 h-4 shrink-0 mt-0.5 opacity-70" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-800">{item.title}</span>
                      <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${st.badge}`}>
                        {st.label}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 mt-0.5 leading-snug">{item.message}</p>
                  </div>
                </div>
                <p className="text-xs text-red-700 bg-red-50 rounded-lg px-3 py-1.5 leading-snug ml-6">
                  <span className="font-semibold">Recomendación:</span> {item.recommendation}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
