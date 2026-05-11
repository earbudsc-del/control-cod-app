'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Spinner } from '@/components/ui/spinner'
import {
  RefreshCw, ArrowRight, TrendingUp, TrendingDown, Minus,
  CheckCircle2, Package, RotateCcw, MapPinOff, Gift, XCircle,
  Activity, Bot, Sparkles, ExternalLink, ChevronDown, ChevronUp, Target,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BreakdownItem {
  orderId:      string
  orderNumber:  string | null
  customerName: string | null
  resultado:    string
  reason:       string
}

interface ScoreData {
  role:  string
  score: number
  level: 'Excelente' | 'Bueno' | 'Riesgo' | 'Deficiente'
  metrics: {
    confirmadosSemana?:    number | null
    entregadosSemana?:     number | null
    devueltosSemana?:      number | null
    fueraCoberturaSemana?: number | null
    recuperadosSemana?:    number | null
    canceladosSemana?:     number | null
    deliveryRate?:         number | null
    [key: string]: number | null | undefined
  }
  breakdown: BreakdownItem[]
  coaching:  string[]
  trends: {
    confirmacionesDelta: number | null
    entregasDelta:       number | null
    devolucionesDelta:   number | null
    scoreDelta:          number | null
    thisPeriod:          Record<string, number>
    lastPeriod:          Record<string, number>
  }
}

// ── Level config ──────────────────────────────────────────────────────────────

const LEVEL: Record<ScoreData['level'], {
  text: string; border: string; bg: string; badge: string; bar: string
}> = {
  Excelente: { text: 'text-green-700',  border: 'border-green-400',  bg: 'bg-green-50',  badge: 'bg-green-100 text-green-800',  bar: 'bg-green-500' },
  Bueno:     { text: 'text-blue-700',   border: 'border-blue-400',   bg: 'bg-blue-50',   badge: 'bg-blue-100 text-blue-800',   bar: 'bg-blue-500'  },
  Riesgo:    { text: 'text-amber-700',  border: 'border-amber-400',  bg: 'bg-amber-50',  badge: 'bg-amber-100 text-amber-800',  bar: 'bg-amber-500' },
  Deficiente:{ text: 'text-red-700',    border: 'border-red-400',    bg: 'bg-red-50',    badge: 'bg-red-100 text-red-800',    bar: 'bg-red-500'   },
}

const LEVEL_THRESHOLDS: Record<ScoreData['level'], { min: number; max: number; next: string | null }> = {
  Deficiente: { min: 0,  max: 60, next: 'Riesgo'    },
  Riesgo:     { min: 60, max: 75, next: 'Bueno'     },
  Bueno:      { min: 75, max: 90, next: 'Excelente' },
  Excelente:  { min: 90, max: 100, next: null       },
}

// ── Resultado badge config ────────────────────────────────────────────────────

function resultadoBadge(resultado: string): string {
  if (resultado === 'Entregado')                return 'bg-green-100 text-green-700'
  if (resultado === 'Recuperado + entregado')   return 'bg-teal-100 text-teal-700'
  if (resultado === 'Devuelto')                 return 'bg-gray-100 text-gray-600'
  if (resultado === 'Sin respuesta al courier') return 'bg-amber-100 text-amber-700'
  if (resultado === 'Fuera cobertura')          return 'bg-orange-100 text-orange-700'
  if (resultado === 'Cancelado')                return 'bg-red-100 text-red-700'
  return 'bg-gray-100 text-gray-500'
}

// ── Delta display ─────────────────────────────────────────────────────────────

function Delta({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) return <span className="text-gray-400 text-xs">—</span>
  const positive = invert ? value < 0 : value > 0
  const cls = positive ? 'text-green-600' : value === 0 ? 'text-gray-400' : 'text-red-600'
  const Icon = value > 0 ? TrendingUp : value < 0 ? TrendingDown : Minus
  return (
    <span className={`flex items-center gap-0.5 text-xs font-bold ${cls}`}>
      <Icon className="w-3.5 h-3.5" />
      {value > 0 ? '+' : ''}{value}%
    </span>
  )
}

// ── Score decomposition bars ──────────────────────────────────────────────────
// Score formula (confirmation_agent):
//   base = 40
//   + (deliveryRate/100) × 36      → max 36 pts
//   + min(recuperados/5, 1) × 12   → max 12 pts
//   − (devueltos/confirmados) × 20 → max −20 pts  (penalización)
//   − min((fueraCobertura/confirmados)×10, 4) → max −4 pts

function ScoreBars({ score, lc, metrics }: {
  score: number
  lc: typeof LEVEL[ScoreData['level']]
  metrics: ScoreData['metrics']
}) {
  const dr    = metrics.deliveryRate    ?? 0
  const rec   = metrics.recuperadosSemana ?? 0
  const dev   = metrics.devueltosSemana   ?? 0
  const conf  = metrics.confirmadosSemana ?? 0
  const cob   = metrics.fueraCoberturaSemana ?? 0

  const pts = [
    { label: 'Delivery rate', pts: Math.round((dr / 100) * 36), max: 36 },
    { label: 'Recuperaciones', pts: Math.round(Math.min(rec / 5, 1) * 12), max: 12 },
    { label: 'Penaliz. devoluciones', pts: -Math.round(conf > 0 ? (dev / conf) * 20 : 0), max: 0, penalty: true },
    { label: 'Penaliz. cobertura', pts: -Math.round(conf > 0 ? Math.min((cob / conf) * 10, 4) : 0), max: 0, penalty: true },
  ]

  return (
    <div className="w-full space-y-1.5 mt-2 border-t border-gray-100 pt-3">
      {pts.map(({ label, pts: p, max, penalty }) => (
        <div key={label} className="flex items-center gap-2 text-xs">
          <span className="text-gray-500 flex-1 truncate text-[11px]">{label}</span>
          {!penalty ? (
            <>
              <div className="w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div className={`h-full rounded-full ${lc.bar}`} style={{ width: `${max > 0 ? (p / max) * 100 : 0}%` }} />
              </div>
              <span className={`font-bold tabular-nums w-8 text-right ${lc.text}`}>+{p}</span>
            </>
          ) : (
            <span className={`font-bold tabular-nums w-20 text-right text-xs ${p < 0 ? 'text-red-500' : 'text-gray-400'}`}>
              {p === 0 ? '0 pts' : `${p} pts`}
            </span>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 text-xs border-t border-gray-100 pt-1.5 mt-1">
        <span className="text-gray-500 flex-1 text-[11px]">Base</span>
        <span className="font-bold tabular-nums w-8 text-right text-gray-500">+40</span>
      </div>
    </div>
  )
}

// ── Level progress + achievements card ───────────────────────────────────────

function LevelProgressCard({
  score, level, lc, metrics, trends,
}: {
  score:   number
  level:   ScoreData['level']
  lc:      typeof LEVEL[ScoreData['level']]
  metrics: ScoreData['metrics']
  trends:  ScoreData['trends']
}) {
  const t   = LEVEL_THRESHOLDS[level]
  const pct = level === 'Excelente'
    ? 100
    : Math.max(0, Math.min(100, Math.round(((score - t.min) / (t.max - t.min)) * 100)))
  const ptsToNext = t.max - score

  const achievements: { label: string; cls: string }[] = []
  if ((metrics.deliveryRate      ?? 0) >= 70) achievements.push({ label: 'Alta entrega',    cls: 'bg-green-100 text-green-700'   })
  if ((metrics.recuperadosSemana ?? 0) >= 3)  achievements.push({ label: 'Alta recuperación', cls: 'bg-teal-100 text-teal-700'   })
  if ((metrics.devueltosSemana   ?? 0) === 0) achievements.push({ label: 'Sin devoluciones', cls: 'bg-blue-100 text-blue-700'   })
  if ((trends.scoreDelta         ?? 0) > 0)   achievements.push({ label: 'Mejorando',       cls: 'bg-indigo-100 text-indigo-700' })
  if ((metrics.confirmadosSemana ?? 0) >= 20) achievements.push({ label: 'Buen volumen',    cls: 'bg-purple-100 text-purple-700' })

  const goals: string[] = []
  if ((metrics.deliveryRate      ?? 0) < 70)  goals.push('Meta semanal: superar 70% de delivery rate')
  if ((metrics.devueltosSemana   ?? 0) > 2)   goals.push('Meta: reducir devoluciones este período')
  if ((metrics.recuperadosSemana ?? 0) < 3)   goals.push('Meta: lograr 3 recuperaciones de carrito')
  if ((metrics.fueraCoberturaSemana ?? 0) > 5) goals.push('Meta: verificar zonas antes de confirmar')

  return (
    <div className="bg-white rounded-2xl border-2 border-gray-200 p-6 flex flex-col gap-4 shadow-sm">

      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Progreso al siguiente nivel</span>
          {t.next
            ? <span className="text-xs text-gray-500"><span className={`font-black ${lc.text}`}>{ptsToNext} pts</span> para <span className="font-semibold">{t.next}</span></span>
            : <span className="text-xs font-bold text-green-600">Nivel máximo alcanzado</span>
          }
        </div>
        <div className="w-full h-3 rounded-full bg-gray-100 overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-700 ${lc.bar}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex justify-between mt-1 text-[10px] text-gray-400">
          <span>{level}</span>
          {t.next && <span>{t.next}</span>}
        </div>
      </div>

      {/* Achievements */}
      {achievements.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Logros esta semana</p>
          <div className="flex flex-wrap gap-1.5">
            {achievements.map(a => (
              <span key={a.label} className={`text-xs font-semibold px-2.5 py-1 rounded-full ${a.cls}`}>{a.label}</span>
            ))}
          </div>
        </div>
      )}

      {/* Goals */}
      {goals.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Metas operativas</p>
          <ul className="space-y-1.5">
            {goals.map(g => (
              <li key={g} className="flex items-start gap-2 text-xs text-gray-600">
                <span className={`mt-0.5 font-bold ${lc.text}`}>→</span>
                {g}
              </li>
            ))}
          </ul>
        </div>
      )}

      {achievements.length === 0 && goals.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Target className="w-4 h-4 text-indigo-400 shrink-0" />
          Alcanza logros mejorando tu delivery rate y recuperaciones.
        </div>
      )}
    </div>
  )
}

// ── KPI Cards ─────────────────────────────────────────────────────────────────

function KpiCards({ metrics }: { metrics: ScoreData['metrics'] }) {
  const cards = [
    { label: 'Confirmados',     value: metrics.confirmadosSemana,    Icon: CheckCircle2, cls: 'bg-indigo-50 border-indigo-200', num: 'text-indigo-700' },
    { label: 'Entregados',      value: metrics.entregadosSemana,     Icon: Package,      cls: 'bg-green-50 border-green-200',   num: 'text-green-700' },
    { label: 'Devueltos',       value: metrics.devueltosSemana,      Icon: RotateCcw,    cls: 'bg-gray-50 border-gray-200',     num: 'text-gray-600' },
    { label: 'Fuera cobertura', value: metrics.fueraCoberturaSemana, Icon: MapPinOff,    cls: 'bg-orange-50 border-orange-200', num: 'text-orange-700' },
    { label: 'Recuperados',     value: metrics.recuperadosSemana,    Icon: Gift,         cls: 'bg-teal-50 border-teal-200',     num: 'text-teal-700' },
    { label: 'Cancelados',      value: metrics.canceladosSemana,     Icon: XCircle,      cls: 'bg-red-50 border-red-200',       num: 'text-red-700' },
  ] as const

  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
      {cards.map(({ label, value, Icon, cls, num }) => (
        <div key={label} className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 ${cls}`}>
          <Icon className="w-4 h-4 opacity-60" />
          <span className={`text-2xl md:text-3xl font-black tabular-nums leading-none ${num}`}>{value ?? 0}</span>
          <span className="text-[10px] font-semibold text-center leading-tight opacity-75">{label}</span>
        </div>
      ))}
    </div>
  )
}

// ── Breakdown Table ───────────────────────────────────────────────────────────

function BreakdownTable({ breakdown }: { breakdown: BreakdownItem[] }) {
  const [expanded, setExpanded] = useState(false)
  const PAGE = 10
  const visible = expanded ? breakdown : breakdown.slice(0, PAGE)

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3.5 bg-gray-50 border-b border-gray-100">
        <Activity className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-bold text-gray-800">Historial operativo</h2>
        <span className="ml-auto text-xs text-gray-500">{breakdown.length} pedidos</span>
      </div>

      {breakdown.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-gray-400">
          No hay pedidos en los últimos 30 días con acción registrada.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Pedido</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Cliente</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Resultado</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Razón operativa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {visible.map((item) => (
                  <tr key={item.orderId} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/orders/${item.orderId}`}
                        className="flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-medium text-xs"
                      >
                        {item.orderNumber ?? item.orderId.slice(0, 8)}
                        <ExternalLink className="w-3 h-3" />
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 text-xs truncate max-w-[140px]">
                      {item.customerName ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${resultadoBadge(item.resultado)}`}>
                        {item.resultado}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{item.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-gray-50">
            {visible.map((item) => (
              <div key={item.orderId} className="px-4 py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Link href={`/orders/${item.orderId}`} className="text-xs font-bold text-indigo-600 flex items-center gap-1">
                      {item.orderNumber ?? item.orderId.slice(0, 8)}
                      <ExternalLink className="w-3 h-3" />
                    </Link>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${resultadoBadge(item.resultado)}`}>
                      {item.resultado}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 truncate">{item.customerName ?? '—'}</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">{item.reason}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Show more / less */}
          {breakdown.length > PAGE && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="w-full flex items-center justify-center gap-1.5 py-3 text-xs font-semibold text-gray-500 hover:text-gray-700 border-t border-gray-100 hover:bg-gray-50 transition-colors"
            >
              {expanded ? <><ChevronUp className="w-3.5 h-3.5" />Ver menos</> : <><ChevronDown className="w-3.5 h-3.5" />Ver {breakdown.length - PAGE} más</>}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── Trends ────────────────────────────────────────────────────────────────────

function TrendsSection({ trends }: { trends: ScoreData['trends'] }) {
  const rows = [
    { label: 'Confirmaciones',  delta: trends.confirmacionesDelta, this: trends.thisPeriod.confirmaciones, last: trends.lastPeriod.confirmaciones },
    { label: 'Entregas',        delta: trends.entregasDelta,       this: trends.thisPeriod.entregas,       last: trends.lastPeriod.entregas },
    { label: 'Devoluciones',    delta: trends.devolucionesDelta,   this: trends.thisPeriod.devoluciones,   last: trends.lastPeriod.devoluciones, invert: true },
    { label: 'Score',           delta: trends.scoreDelta,          this: undefined, last: undefined, isDelta: true },
  ]

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 bg-gray-50 border-b border-gray-100">
        <h2 className="text-sm font-bold text-gray-800">Esta semana vs semana pasada</h2>
      </div>
      <div className="divide-y divide-gray-50">
        {rows.map(row => (
          <div key={row.label} className="flex items-center px-5 py-3 gap-4">
            <span className="text-sm text-gray-600 flex-1">{row.label}</span>
            <Delta value={row.delta ?? null} invert={'invert' in row ? row.invert : false} />
            {!row.isDelta && (
              <>
                <div className="text-right w-20">
                  <span className="text-base font-black tabular-nums text-gray-800">{row.this ?? '—'}</span>
                  <span className="text-xs text-gray-400 ml-1">esta</span>
                </div>
                <div className="text-right w-20">
                  <span className="text-base font-black tabular-nums text-gray-400">{row.last ?? '—'}</span>
                  <span className="text-xs text-gray-300 ml-1">ant.</span>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Coaching ──────────────────────────────────────────────────────────────────

function CoachingSection({ coaching }: { coaching: string[] }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3.5 bg-gradient-to-r from-indigo-50 to-white border-b border-gray-100">
        <div className="flex items-center justify-center w-7 h-7 bg-indigo-600 rounded-lg shrink-0">
          <Bot className="w-4 h-4 text-white" />
        </div>
        <h2 className="text-sm font-bold text-gray-800">Coaching personalizado</h2>
        <Sparkles className="w-3.5 h-3.5 text-indigo-400 ml-auto" />
      </div>
      <div className="divide-y divide-gray-50">
        {coaching.length === 0 ? (
          <div className="flex items-center gap-3 px-5 py-4 text-sm text-gray-500">
            <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
            ¡Todo en orden! Sigue con el mismo ritmo.
          </div>
        ) : coaching.map((msg, i) => (
          <div key={i} className="flex items-start gap-3 px-5 py-3.5">
            <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-2 shrink-0" />
            <p className="text-sm text-gray-700 leading-snug">{msg}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function RendimientoConfirmacion() {
  const [data, setData]               = useState<ScoreData | null>(null)
  const [loading, setLoading]         = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/my-performance/score').then(r => r.json() as Promise<ScoreData>)
      setData(res)
      setLastRefresh(new Date())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 2 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-8 h-8 text-indigo-500" />
      </div>
    )
  }
  if (!data) return null

  const lc = LEVEL[data.level]

  return (
    <div className="space-y-5 max-w-4xl">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Mi rendimiento</h1>
          <p className="text-sm text-gray-500 mt-0.5">Datos reales de tu actividad — últimos 30 días</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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

      {/* ── Score + Level Progress ── */}
      <div className="grid md:grid-cols-2 gap-4">

        {/* Score card */}
        <div className={`bg-white rounded-2xl border-2 ${lc.border} p-6 flex flex-col items-center gap-3 shadow-sm`}>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Score IA — Semana</p>
          <div className={`w-32 h-32 rounded-full border-4 ${lc.border} ${lc.bg} flex flex-col items-center justify-center`}>
            <span className={`text-5xl font-black tabular-nums leading-none ${lc.text}`}>{data.score}</span>
            <span className="text-xs text-gray-400 font-medium mt-0.5">/ 100</span>
          </div>
          <span className={`text-sm font-bold px-3 py-1 rounded-full ${lc.badge}`}>{data.level}</span>
          <ScoreBars score={data.score} lc={lc} metrics={data.metrics} />
        </div>

        {/* Level progress + achievements + goals */}
        <LevelProgressCard
          score={data.score}
          level={data.level}
          lc={lc}
          metrics={data.metrics}
          trends={data.trends}
        />
      </div>

      {/* ── KPI Cards ── */}
      <KpiCards metrics={data.metrics} />

      {/* ── Delivery Rate highlight ── */}
      {(data.metrics.deliveryRate ?? 0) > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-4 shadow-sm flex items-center gap-4">
          <div className="flex-1">
            <p className="text-xs font-semibold text-gray-500 mb-1.5">Delivery rate (entregas / confirmados)</p>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-3 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    (data.metrics.deliveryRate ?? 0) >= 70 ? 'bg-green-500' :
                    (data.metrics.deliveryRate ?? 0) >= 50 ? 'bg-amber-500' : 'bg-red-500'
                  }`}
                  style={{ width: `${data.metrics.deliveryRate ?? 0}%` }}
                />
              </div>
              <span className={`text-2xl font-black tabular-nums ${
                (data.metrics.deliveryRate ?? 0) >= 70 ? 'text-green-700' :
                (data.metrics.deliveryRate ?? 0) >= 50 ? 'text-amber-700' : 'text-red-700'
              }`}>
                {data.metrics.deliveryRate ?? 0}%
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Breakdown ── */}
      <BreakdownTable breakdown={data.breakdown} />

      {/* ── Trends ── */}
      <TrendsSection trends={data.trends} />

      {/* ── Coaching ── */}
      <CoachingSection coaching={data.coaching} />

    </div>
  )
}
