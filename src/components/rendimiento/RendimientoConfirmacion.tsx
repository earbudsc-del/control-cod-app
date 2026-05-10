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
  generateSupervisorFeedback,
  type FeedbackLevel,
} from '@/lib/supervisor/confirmation-feedback'

// ── Tipos ──────────────────────────────────────────────────────────────────────

interface Perf {
  // Hoy
  confirmadosHoy:        number
  contactadosHoy:        number
  noRespondieronHoy:     number
  canceladosHoy:         number
  numerosIncorrectosHoy: number
  tasaConfirmacionHoy:   number | null
  // Ayer
  confirmadosAyer:       number
  contactadosAyer:       number
  tasaAyer:              number | null
  // Cola
  atrasadosPendientes:   number
}

// ── Score (0–100) ─────────────────────────────────────────────────────────────
// Base de 40 pts para que el score no arranque en 0.
// Los 60 pts restantes se distribuyen entre los 3 componentes, normalizados.
//   Tasa confirmación → 36 pts máx  (sin contactos = 0, sin penalización)
//   Volumen contactos → 15 pts máx  (meta: 25 contactos/día)
//   Cola al día       →  9 pts máx  (≥10 atrasados = 0 pts, lineal)

const META_CONTACTOS = 25
const META_ATRASADOS = 10
const SCORE_BASE     = 40
const SCORE_NORM     = (100 - SCORE_BASE) / 100  // 0.60

function calcScore(perf: Perf): number {
  const tasaScore = perf.contactadosHoy > 0 && perf.tasaConfirmacionHoy !== null
    ? Math.min(perf.tasaConfirmacionHoy, 100) * 0.60 * SCORE_NORM
    : 0
  const volScore  = Math.min(perf.contactadosHoy / META_CONTACTOS, 1) * 25 * SCORE_NORM
  const colaScore = Math.max(0, 1 - Math.min(perf.atrasadosPendientes / META_ATRASADOS, 1)) * 15 * SCORE_NORM
  const scoreFinal = Math.min(100, Math.round(SCORE_BASE + tasaScore + volScore + colaScore))
  // DEBUG — quitar cuando se confirme el valor correcto
  console.log('[calcScore]', {
    rawPerf:    { contactadosHoy: perf.contactadosHoy, tasaConfirmacionHoy: perf.tasaConfirmacionHoy, atrasadosPendientes: perf.atrasadosPendientes },
    tasaScore,
    volScore,
    colaScore,
    SCORE_BASE,
    SCORE_NORM,
    scoreFinal,
  })
  return scoreFinal
}

function scoreColor(s: number) {
  if (s >= 75) return { text: 'text-green-700',  border: 'border-green-400',  bg: 'bg-green-50',  label: 'Excelente'      }
  if (s >= 50) return { text: 'text-amber-700',  border: 'border-amber-400',  bg: 'bg-amber-50',  label: 'En progreso'    }
  return           { text: 'text-red-700',    border: 'border-red-400',    bg: 'bg-red-50',    label: 'Necesita mejora' }
}

// ── Tasa helpers ──────────────────────────────────────────────────────────────

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

const META_CONFIRMADOS = 25

export function RendimientoConfirmacion() {
  const [perf, setPerf]           = useState<Perf | null>(null)
  const [loading, setLoading]     = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  const fetchData = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/confirmacion/performance').then(r => r.json() as Promise<Perf>)
    setPerf(res)
    setLastRefresh(new Date())
    setLoading(false)
  }, [])

  // Refresco adaptativo: 30 s cuando aún no hay contactos (primer contacto visible rápido),
  // 2 min cuando el agente ya está activo.
  useEffect(() => {
    fetchData()
    const ms = !perf || perf.contactadosHoy === 0 ? 30_000 : 2 * 60_000
    const interval = setInterval(fetchData, ms)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData, perf?.contactadosHoy === 0])

  if (loading && !perf) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-indigo-500" />
      </div>
    )
  }

  if (!perf) return null

  const score      = calcScore(perf)
  const scoreClr   = scoreColor(score)
  const progreso   = Math.min(Math.round((perf.confirmadosHoy / META_CONFIRMADOS) * 100), 100)
  const supervisor = generateSupervisorFeedback(perf)

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
            href="/confirmacion"
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5
                       bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
          >
            Ir a confirmar
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {/* ── Bloque 1 + 5: Score + Meta (columnas) ── */}
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
            {[
              {
                label: 'Tasa confirmación',
                pts:   perf.contactadosHoy > 0 && perf.tasaConfirmacionHoy !== null
                         ? Math.round(Math.min(perf.tasaConfirmacionHoy, 100) * 0.60 * SCORE_NORM)
                         : 0,
                max: Math.round(60 * SCORE_NORM),  // 36
              },
              {
                label: 'Volumen contactos',
                pts:   Math.round(Math.min(perf.contactadosHoy / META_CONTACTOS, 1) * 25 * SCORE_NORM),
                max: Math.round(25 * SCORE_NORM),  // 15
              },
              {
                label: 'Cola al día',
                pts:   Math.round(Math.max(0, 1 - Math.min(perf.atrasadosPendientes / META_ATRASADOS, 1)) * 15 * SCORE_NORM),
                max: Math.round(15 * SCORE_NORM),  // 9
              },
            ].map(({ label, pts, max }) => (
              <div key={label} className="flex items-center gap-2 text-xs">
                <span className="text-gray-500 flex-1 truncate">{label}</span>
                <div className="w-20 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${score >= 75 ? 'bg-green-400' : score >= 50 ? 'bg-amber-400' : 'bg-red-400'}`}
                    style={{ width: `${(pts / max) * 100}%` }}
                  />
                </div>
                <span className={`font-bold tabular-nums w-10 text-right ${scoreClr.text}`}>
                  {pts}/{max}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Meta + Feedback */}
        <div className="lg:col-span-3 space-y-4">

          {/* Bloque 5: Meta del día */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Target className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Meta del día</h2>
              <span className="ml-auto text-sm font-black tabular-nums text-indigo-700">
                {perf.confirmadosHoy} / {META_CONFIRMADOS}
              </span>
            </div>
            <div className="w-full h-3 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500
                  ${progreso >= 100 ? 'bg-green-500' : progreso >= 60 ? 'bg-indigo-500' : 'bg-indigo-400'}`}
                style={{ width: `${progreso}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-gray-500">
                {progreso >= 100
                  ? '¡Meta alcanzada!'
                  : `Faltan ${META_CONFIRMADOS - perf.confirmadosHoy} confirmaciones`}
              </span>
              <span className="text-xs font-bold text-indigo-600">{progreso}%</span>
            </div>
          </div>

        </div>
      </div>

      {/* ── Bloque 2: Tarjetas de métricas hoy ── */}
      <div className="grid grid-cols-5 gap-3">
        {([
          {
            label: 'Confirmados',
            count: perf.confirmadosHoy,
            Icon:  CheckCircle2,
            cls:   'bg-green-50 border-green-200 text-green-700',
            numCls:'text-green-700',
          },
          {
            label: 'Contactados',
            count: perf.contactadosHoy,
            Icon:  Phone,
            cls:   'bg-blue-50 border-blue-200 text-blue-700',
            numCls:'text-blue-700',
          },
          {
            label: 'No responden',
            count: perf.noRespondieronHoy,
            Icon:  PhoneMissed,
            cls:   'bg-amber-50 border-amber-200 text-amber-700',
            numCls:'text-amber-700',
          },
          {
            label: 'Cancelados',
            count: perf.canceladosHoy,
            Icon:  XCircle,
            cls:   'bg-gray-50 border-gray-200 text-gray-600',
            numCls:'text-gray-600',
          },
          {
            label: 'Nro incorrecto',
            count: perf.numerosIncorrectosHoy,
            Icon:  XCircle,
            cls:   'bg-red-50 border-red-200 text-red-700',
            numCls:'text-red-700',
          },
        ] as const).map(({ label, count, Icon, cls, numCls }) => (
          <div key={label} className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 ${cls}`}>
            <Icon className="w-5 h-5 opacity-60" />
            <span className={`text-3xl font-black tabular-nums leading-none ${numCls}`}>{count}</span>
            <span className="text-[11px] font-semibold text-center leading-tight opacity-80">{label}</span>
          </div>
        ))}
      </div>

      {/* ── Bloque 3: Comparación hoy vs ayer ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
          <h2 className="text-sm font-bold text-gray-700">Hoy vs Ayer</h2>
        </div>

        <div className="divide-y divide-gray-50">
          {[
            {
              label: 'Confirmados',
              hoy:   perf.confirmadosHoy,
              ayer:  perf.confirmadosAyer,
              fmt:   (n: number) => String(n),
            },
            {
              label: 'Contactados',
              hoy:   perf.contactadosHoy,
              ayer:  perf.contactadosAyer,
              fmt:   (n: number) => String(n),
            },
            {
              label: 'Tasa de confirmación',
              hoy:   perf.tasaConfirmacionHoy ?? 0,
              ayer:  perf.tasaAyer            ?? 0,
              fmt:   (n: number) => (perf.tasaConfirmacionHoy === null && n === 0)
                                      ? '—'
                                      : `${n}%`,
              extraHoy:  perf.tasaConfirmacionHoy !== null
                           ? tasaColor(perf.tasaConfirmacionHoy)
                           : 'text-gray-400',
              extraAyer: perf.tasaAyer !== null
                           ? tasaColor(perf.tasaAyer)
                           : 'text-gray-400',
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
  danger:  { bar: 'bg-red-500',    badge: 'bg-red-100 text-red-700',    label: 'Crítico', Icon: ShieldAlert   },
  warning: { bar: 'bg-amber-400',  badge: 'bg-amber-100 text-amber-700', label: 'Atención', Icon: AlertTriangle },
  info:    { bar: 'bg-blue-400',   badge: 'bg-blue-100 text-blue-700',  label: 'Info',     Icon: Info          },
  success: { bar: 'bg-green-500',  badge: 'bg-green-100 text-green-700', label: 'Bien',    Icon: CircleCheck   },
}

function SupervisorSection({ items }: { items: ReturnType<typeof generateSupervisorFeedback> }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">

      {/* Header */}
      <div className="flex items-center gap-2.5 px-5 py-3.5
                      bg-gradient-to-r from-indigo-50 to-white border-b border-gray-100">
        <div className="flex items-center justify-center w-7 h-7 bg-indigo-600 rounded-lg shrink-0">
          <Bot className="w-4 h-4 text-white" />
        </div>
        <h2 className="text-sm font-bold text-gray-800">Supervisor IA</h2>
        {items.length > 0 && (
          <span className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full
                           bg-indigo-100 text-indigo-700">
            {items.length} observación{items.length !== 1 ? 'es' : ''}
          </span>
        )}
      </div>

      {/* Cards */}
      <div className="divide-y divide-gray-50">
        {items.length === 0 && (
          <div className="flex items-center gap-3 px-5 py-4 text-sm text-gray-500">
            <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
            Sin observaciones. ¡Todo en orden!
          </div>
        )}
        {items.map(item => {
          const st = LEVEL_STYLES[item.level]
          const Icon = st.Icon
          return (
            <div key={item.id} className="flex gap-0 group">
              {/* left accent bar */}
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
                <div className="flex items-start justify-between gap-2 ml-6">
                  <p className="text-xs text-indigo-700 bg-indigo-50 rounded-lg px-3 py-1.5 leading-snug flex-1">
                    <span className="font-semibold">Recomendación:</span> {item.recommendation}
                  </p>
                  {item.href && (
                    <Link
                      href={item.href}
                      className="shrink-0 text-xs font-semibold px-2.5 py-1.5 rounded-lg
                                 bg-indigo-600 hover:bg-indigo-700 text-white transition-colors
                                 flex items-center gap-1"
                    >
                      Ver casos
                      <ArrowRight className="w-3 h-3" />
                    </Link>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
