'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Spinner } from '@/components/ui/spinner'
import {
  RefreshCw, ArrowRight, TrendingUp, TrendingDown, Minus,
  CheckCircle2, Phone, AlertOctagon, Truck,
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
    entregadosSemana?:  number | null
    contactadosSemana?: number | null
    criticosActivos?:   number | null
    tasaEntrega?:       number | null
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

function resultadoBadge(resultado: string): string {
  if (resultado === 'Entregado')            return 'bg-green-100 text-green-700'
  if (resultado === 'Recuperado + entregado') return 'bg-teal-100 text-teal-700'
  if (resultado === 'Seguimiento activo')   return 'bg-amber-100 text-amber-700'
  if (resultado === 'Devuelto')             return 'bg-gray-100 text-gray-600'
  return 'bg-gray-100 text-gray-500'
}

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

// ── Score bars ────────────────────────────────────────────────────────────────
// Score formula (delivery_agent):
//   base = 40
//   + (tasaEntrega/100) × 36        → max 36 pts
//   + min(contactados/10, 1) × 12   → max 12 pts
//   + (criticos==0 ? 8 : 0)         → max 8 pts
//   − min(criticos×3, 20)           → max −20 pts

function ScoreBars({ lc, metrics }: {
  lc: typeof LEVEL[ScoreData['level']]
  metrics: ScoreData['metrics']
}) {
  const tasa        = metrics.tasaEntrega      ?? 0
  const contactados = metrics.contactadosSemana ?? 0
  const criticos    = metrics.criticosActivos   ?? 0

  const pts = [
    { label: 'Tasa de entrega',   pts: Math.round((tasa / 100) * 36), max: 36 },
    { label: 'Seguimiento',       pts: Math.round(Math.min(contactados / 10, 1) * 12), max: 12 },
    { label: 'Sin críticos +48h', pts: criticos === 0 ? 8 : 0, max: 8 },
    { label: 'Penaliz. críticos', pts: -Math.min(criticos * 3, 20), max: 0, penalty: true },
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
  if ((metrics.criticosActivos  ?? 0) === 0) achievements.push({ label: 'Sin críticos',    cls: 'bg-green-100 text-green-700'   })
  if ((metrics.tasaEntrega      ?? 0) >= 70) achievements.push({ label: 'Alta entrega',    cls: 'bg-teal-100 text-teal-700'    })
  if ((metrics.contactadosSemana ?? 0) >= 10) achievements.push({ label: 'Buen seguimiento', cls: 'bg-blue-100 text-blue-700'  })
  if ((trends.scoreDelta         ?? 0) > 0)  achievements.push({ label: 'Mejorando',       cls: 'bg-indigo-100 text-indigo-700' })
  if ((metrics.entregadosSemana  ?? 0) >= 10) achievements.push({ label: 'Alto volumen',   cls: 'bg-purple-100 text-purple-700' })

  const goals: string[] = []
  if ((metrics.criticosActivos  ?? 0) > 0)  goals.push('Meta: cero pedidos críticos +48h en reparto')
  if ((metrics.tasaEntrega      ?? 0) < 70) goals.push('Meta: superar 70% de tasa de entrega')
  if ((metrics.contactadosSemana ?? 0) < 10) goals.push('Meta: registrar todos los contactos con clientes')

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
          <Target className="w-4 h-4 text-amber-400 shrink-0" />
          Alcanza logros mejorando tu tasa de entrega y seguimiento.
        </div>
      )}
    </div>
  )
}

// ── KPI Cards ─────────────────────────────────────────────────────────────────

function KpiCards({ metrics }: { metrics: ScoreData['metrics'] }) {
  const criticos = metrics.criticosActivos ?? 0
  const cards = [
    { label: 'Entregados',   value: metrics.entregadosSemana,  Icon: CheckCircle2, cls: 'bg-green-50 border-green-200',   num: 'text-green-700' },
    { label: 'Contactados',  value: metrics.contactadosSemana, Icon: Phone,        cls: 'bg-blue-50 border-blue-200',     num: 'text-blue-700' },
    { label: 'Tasa entrega', value: metrics.tasaEntrega,       Icon: Truck,        cls: 'bg-indigo-50 border-indigo-200', num: 'text-indigo-700', suffix: '%' },
    { label: 'Críticos +48h',value: criticos,                  Icon: AlertOctagon, cls: `${criticos > 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`, num: `${criticos > 0 ? 'text-red-700' : 'text-gray-400'}` },
  ] as const

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map(({ label, value, Icon, cls, num, ...rest }) => (
        <div key={label} className={`flex flex-col items-center gap-1.5 p-4 rounded-xl border-2 ${cls}`}>
          <Icon className="w-5 h-5 opacity-60" />
          <span className={`text-3xl font-black tabular-nums leading-none ${num}`}>
            {value ?? 0}{'suffix' in rest && rest.suffix ? rest.suffix : ''}
          </span>
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
      <div className="flex items-center gap-3 px-5 py-3.5 bg-gray-50 border-b border-gray-100">
        <Activity className="w-4 h-4 text-amber-500" />
        <h2 className="text-sm font-bold text-gray-800">Historial operativo</h2>
        <span className="ml-auto text-xs text-gray-500">{breakdown.length} pedidos</span>
      </div>

      {breakdown.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-gray-400">
          No hay acciones registradas en los últimos 30 días.
        </div>
      ) : (
        <>
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
                      <Link href={`/orders/${item.orderId}`} className="flex items-center gap-1 text-amber-600 hover:text-amber-800 font-medium text-xs">
                        {item.orderNumber ?? item.orderId.slice(0, 8)}
                        <ExternalLink className="w-3 h-3" />
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 text-xs truncate max-w-[140px]">{item.customerName ?? '—'}</td>
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

          <div className="md:hidden divide-y divide-gray-50">
            {visible.map((item) => (
              <div key={item.orderId} className="px-4 py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Link href={`/orders/${item.orderId}`} className="text-xs font-bold text-amber-600 flex items-center gap-1">
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
    { label: 'Entregas',     delta: trends.entregasDelta, this: trends.thisPeriod.entregas,     last: trends.lastPeriod.entregas },
    { label: 'Contactados',  delta: null,                 this: trends.thisPeriod.contactados,  last: trends.lastPeriod.contactados },
    { label: 'Tasa entrega', delta: null,                 this: trends.thisPeriod.tasaEntrega,  last: trends.lastPeriod.tasaEntrega, suffix: '%' },
    { label: 'Score',        delta: trends.scoreDelta, isDelta: true },
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
            <Delta value={row.delta ?? null} />
            {!row.isDelta && (
              <>
                <div className="text-right w-20">
                  <span className="text-base font-black tabular-nums text-gray-800">
                    {row.this ?? '—'}{'suffix' in row && row.suffix ? row.suffix : ''}
                  </span>
                  <span className="text-xs text-gray-400 ml-1">esta</span>
                </div>
                <div className="text-right w-20">
                  <span className="text-base font-black tabular-nums text-gray-400">
                    {row.last ?? '—'}{'suffix' in row && row.suffix ? row.suffix : ''}
                  </span>
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
      <div className="flex items-center gap-2.5 px-5 py-3.5 bg-gradient-to-r from-amber-50 to-white border-b border-gray-100">
        <div className="flex items-center justify-center w-7 h-7 bg-amber-600 rounded-lg shrink-0">
          <Bot className="w-4 h-4 text-white" />
        </div>
        <h2 className="text-sm font-bold text-gray-800">Coaching personalizado</h2>
        <Sparkles className="w-3.5 h-3.5 text-amber-400 ml-auto" />
      </div>
      <div className="divide-y divide-gray-50">
        {coaching.length === 0 ? (
          <div className="flex items-center gap-3 px-5 py-4 text-sm text-gray-500">
            <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
            ¡Todo en orden! Sigue con el mismo ritmo.
          </div>
        ) : coaching.map((msg, i) => (
          <div key={i} className="flex items-start gap-3 px-5 py-3.5">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-2 shrink-0" />
            <p className="text-sm text-gray-700 leading-snug">{msg}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function RendimientoReparto() {
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
        <Spinner className="w-8 h-8 text-amber-500" />
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
          <button onClick={fetchData} disabled={loading} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600 transition-colors disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
          <Link href="/reparto" className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition-colors">
            Ir a reparto <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {/* ── Critical alert ── */}
      {(data.metrics.criticosActivos ?? 0) > 0 && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <AlertOctagon className="w-5 h-5 text-red-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-red-700">
              {data.metrics.criticosActivos} pedido{data.metrics.criticosActivos !== 1 ? 's' : ''} crítico{data.metrics.criticosActivos !== 1 ? 's' : ''} +48h
            </p>
            <p className="text-xs text-red-600">Escala estos pedidos con Effi / transportadora</p>
          </div>
          <Link href="/reparto?filter=critical" className="text-xs font-semibold text-red-700 hover:text-red-800 whitespace-nowrap">
            Ver →
          </Link>
        </div>
      )}

      {/* ── Score + Level Progress ── */}
      <div className="grid md:grid-cols-2 gap-4">

        {/* Score */}
        <div className={`bg-white rounded-2xl border-2 ${lc.border} p-6 flex flex-col items-center gap-3 shadow-sm`}>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Score IA — Semana</p>
          <div className={`w-32 h-32 rounded-full border-4 ${lc.border} ${lc.bg} flex flex-col items-center justify-center`}>
            <span className={`text-5xl font-black tabular-nums leading-none ${lc.text}`}>{data.score}</span>
            <span className="text-xs text-gray-400 font-medium mt-0.5">/ 100</span>
          </div>
          <span className={`text-sm font-bold px-3 py-1 rounded-full ${lc.badge}`}>{data.level}</span>
          <ScoreBars lc={lc} metrics={data.metrics} />
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

      {/* ── Breakdown ── */}
      <BreakdownTable breakdown={data.breakdown} />

      {/* ── Trends ── */}
      <TrendsSection trends={data.trends} />

      {/* ── Coaching ── */}
      <CoachingSection coaching={data.coaching} />

    </div>
  )
}
