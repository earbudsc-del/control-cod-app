'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Spinner } from '@/components/ui/spinner'
import {
  RefreshCw, Target, Flame, Zap, Trophy, TrendingUp, TrendingDown, Minus,
  CheckCircle2, MapPin, Clock, Star, Award, BarChart3, DollarSign,
  Navigation, Package, PhoneMissed, RotateCcw,
} from 'lucide-react'
import type { SdScoreData, SdBadge } from '@/app/api/sd-delivery/score/route'
import { ZONE_COLORS, SD_TARIFA_PROMEDIO } from '@/lib/sd-zones'
import type { ZoneId, SdBonus } from '@/lib/sd-zones'

// ── Level config ───────────────────────────────────────────────────────────────

const LEVEL_CFG = {
  Excelente: { text: 'text-green-700',  bg: 'bg-green-50',  badge: 'bg-green-100 text-green-800',  bar: 'bg-green-500',  border: 'border-green-300',  next: null,        nextMin: 100 },
  Bueno:     { text: 'text-blue-700',   bg: 'bg-blue-50',   badge: 'bg-blue-100 text-blue-800',    bar: 'bg-blue-500',   border: 'border-blue-300',   next: 'Excelente', nextMin: 90  },
  Riesgo:    { text: 'text-amber-700',  bg: 'bg-amber-50',  badge: 'bg-amber-100 text-amber-800',  bar: 'bg-amber-500',  border: 'border-amber-300',  next: 'Bueno',     nextMin: 75  },
  Deficiente:{ text: 'text-red-700',    bg: 'bg-red-50',    badge: 'bg-red-100 text-red-800',      bar: 'bg-red-500',    border: 'border-red-300',    next: 'Riesgo',    nextMin: 60  },
} as const

type Level = keyof typeof LEVEL_CFG

// ── Progress ring (SVG) ────────────────────────────────────────────────────────

function ProgressRing({
  pct, size = 120, stroke = 10, color = 'stroke-teal-500',
  children,
}: {
  pct: number; size?: number; stroke?: number; color?: string; children?: React.ReactNode
}) {
  const r     = (size - stroke) / 2
  const circ  = 2 * Math.PI * r
  const dash  = (Math.min(pct, 100) / 100) * circ

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="currentColor" strokeWidth={stroke} className="text-gray-100" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          strokeWidth={stroke}
          className={color}
          strokeDasharray={circ}
          strokeDashoffset={circ - dash}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.8s ease' }} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        {children}
      </div>
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
      {value > 0 ? '+' : ''}{value}%
    </span>
  )
}

// ── Stat card simple ───────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, icon: Icon, color = 'teal', delta,
}: {
  label: string; value: string | number; sub?: string
  icon?: React.ElementType; color?: string; delta?: number | null
}) {
  const colorCls: Record<string, string> = {
    teal:    'bg-teal-50 text-teal-600',
    blue:    'bg-blue-50 text-blue-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    amber:   'bg-amber-50 text-amber-600',
    violet:  'bg-violet-50 text-violet-600',
    indigo:  'bg-indigo-50 text-indigo-600',
  }
  const cls = colorCls[color] ?? colorCls['teal']

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex flex-col gap-1.5">
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

// ── Badge chip ─────────────────────────────────────────────────────────────────

function BadgeChip({ badge }: { badge: SdBadge }) {
  if (!badge.earned) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full
                      bg-gray-100 text-gray-400 text-xs font-medium opacity-50
                      border border-dashed border-gray-200">
        <span className="grayscale opacity-50">{badge.emoji}</span>
        {badge.label}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full
                    bg-amber-50 text-amber-800 text-xs font-bold border border-amber-200
                    shadow-sm">
      <span>{badge.emoji}</span>
      {badge.label}
    </div>
  )
}

// ── Bonus chip ─────────────────────────────────────────────────────────────────

function BonusChip({ bonus }: { bonus: SdBonus }) {
  if (!bonus.earned) {
    return (
      <div className="flex items-start gap-2 px-3 py-2 rounded-xl
                      bg-gray-50 border border-dashed border-gray-200 opacity-60">
        <span className="text-base grayscale">{bonus.emoji}</span>
        <div>
          <p className="text-xs font-semibold text-gray-400">{bonus.label}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">{bonus.condition}</p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-xl
                    bg-amber-50 border border-amber-200 shadow-sm">
      <span className="text-base">{bonus.emoji}</span>
      <div>
        <div className="flex items-center gap-2">
          <p className="text-xs font-black text-amber-800">{bonus.label}</p>
          <span className="text-xs font-black text-amber-700 tabular-nums">
            +RD${bonus.amount.toLocaleString('es-DO')}
          </span>
        </div>
        <p className="text-[11px] text-amber-600 mt-0.5">{bonus.condition}</p>
      </div>
    </div>
  )
}

// ── Barra de progreso ─────────────────────────────────────────────────────────

function ProgressBar({
  pct, color = 'bg-teal-500', height = 'h-2.5', label, showPct = true,
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
        <div
          className={`${height} ${color} rounded-full transition-all duration-700 ease-out`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  )
}

// ── Componente principal ───────────────────────────────────────────────────────

export function RendimientoSD() {
  const [data, setData]     = useState<SdScoreData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/sd-delivery/score')
      if (!res.ok) throw new Error('fetch error')
      const json: SdScoreData = await res.json()
      setData(json)
      setLastUpdate(new Date())
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <div className="text-center space-y-3">
          <Spinner className="w-8 h-8 text-teal-500 mx-auto" />
          <p className="text-gray-500 text-sm">Cargando tu rendimiento…</p>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-64 gap-4 px-4">
        <p className="text-gray-500 text-center">No se pudo cargar el rendimiento.</p>
        <button onClick={fetchData}
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-semibold">
          <RefreshCw className="w-4 h-4" />Reintentar
        </button>
      </div>
    )
  }

  const lc = LEVEL_CFG[data.level as Level]
  const scoreRingColor =
    data.level === 'Excelente' ? 'stroke-green-500'
    : data.level === 'Bueno'   ? 'stroke-blue-500'
    : data.level === 'Riesgo'  ? 'stroke-amber-500'
    : 'stroke-red-500'

  const earnedBadges = data.badges.filter(b => b.earned)
  const faltanMeta   = Math.max(0, data.metaDiaria - data.entregadosHoy)

  return (
    <div className="space-y-5 pb-8">

      {/* ── Header de ganancias — hero motivador ── */}
      <div className="relative overflow-hidden rounded-2xl
                      bg-gradient-to-br from-teal-600 via-teal-500 to-emerald-500
                      shadow-lg shadow-teal-200/50 border border-teal-400/30">
        {/* Decoración */}
        <div className="absolute -right-6 -top-6 w-36 h-36 rounded-full bg-white/10" />
        <div className="absolute -right-2 -bottom-8 w-20 h-20 rounded-full bg-white/10" />
        <div className="absolute left-0 bottom-0 w-full h-12 bg-gradient-to-t from-black/10 to-transparent" />

        <div className="relative px-5 py-5 md:px-6 md:py-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-teal-100 text-sm font-semibold mb-0.5">Ganancias estimadas hoy</p>
              <h2 className="text-4xl md:text-5xl font-black text-white tabular-nums">
                RD${data.gananciasHoy.toLocaleString('es-DO')}
              </h2>
              <p className="text-teal-100 text-sm mt-1">
                {data.entregadosHoy} entrega{data.entregadosHoy !== 1 ? 's' : ''} ·
                {' '}RD${data.promedioEntrega}/entrega
              </p>
              {data.gananciasAyer > 0 && (
                <p className="text-teal-200 text-xs mt-0.5">
                  Ayer: RD${data.gananciasAyer.toLocaleString('es-DO')}
                </p>
              )}
            </div>
            <div className="shrink-0">
              <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center">
                <DollarSign className="w-6 h-6 text-white" />
              </div>
            </div>
          </div>

          {/* Meta del día */}
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-teal-100 font-medium flex items-center gap-1.5">
                <Target className="w-4 h-4" />
                Meta del día: {data.metaDiaria} entregas
              </span>
              <span className="text-white font-black tabular-nums">
                {data.entregadosHoy}/{data.metaDiaria}
              </span>
            </div>
            <div className="h-3 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-3 bg-white rounded-full transition-all duration-700"
                style={{ width: `${data.progresoMetaDiaria}%` }}
              />
            </div>
            <p className="text-teal-100 text-xs">
              {faltanMeta === 0
                ? '🎉 ¡Meta del día cumplida!'
                : `Te faltan ${faltanMeta} entrega${faltanMeta !== 1 ? 's' : ''} para tu meta`}
            </p>
          </div>
        </div>
      </div>

      {/* ── Score + Racha ── */}
      <div className="grid grid-cols-2 gap-3">
        {/* Score */}
        <div className={`bg-white rounded-2xl border-2 ${lc.border} shadow-sm p-4 flex flex-col items-center gap-2`}>
          <ProgressRing pct={data.score} size={100} stroke={9} color={scoreRingColor}>
            <div className="text-center">
              <p className="text-2xl font-black text-gray-900 tabular-nums leading-none">{data.score}</p>
              <p className="text-[10px] font-bold text-gray-400 leading-none mt-0.5">/ 100</p>
            </div>
          </ProgressRing>
          <div className="text-center">
            <span className={`text-xs font-black px-2.5 py-1 rounded-full ${lc.badge}`}>
              {data.level}
            </span>
            {lc.next && (
              <p className="text-[10px] text-gray-400 mt-1">
                {data.score < (lc.nextMin ?? 100)
                  ? `${(lc.nextMin ?? 100) - data.score}pts para ${lc.next}`
                  : `¡Nivel ${lc.next}!`}
              </p>
            )}
          </div>
          <p className="text-xs font-semibold text-gray-500">Score semanal</p>
        </div>

        {/* Racha */}
        <div className="bg-white rounded-2xl border-2 border-orange-200 shadow-sm p-4 flex flex-col items-center gap-2">
          <div className="w-20 h-20 flex flex-col items-center justify-center">
            <Flame className={`w-10 h-10 ${data.streak >= 1 ? 'text-orange-500' : 'text-gray-200'}`} />
          </div>
          <div className="text-center">
            <p className="text-3xl font-black text-gray-900 tabular-nums leading-none">{data.streak}</p>
            <p className="text-xs font-semibold text-gray-500 mt-0.5">
              {data.streak === 1 ? 'día seguido' : 'días seguidos'}
            </p>
          </div>
          <div className="text-center">
            {data.streak >= 3 && (
              <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-orange-100 text-orange-700">
                🔥 ¡Racha activa!
              </span>
            )}
            {data.streak < 3 && data.streak > 0 && (
              <span className="text-xs font-medium text-orange-600">
                {3 - data.streak} día{3 - data.streak !== 1 ? 's' : ''} para racha de fuego
              </span>
            )}
            {data.streak === 0 && (
              <span className="text-xs text-gray-400">Cumple {data.metaDiaria} entregas para iniciar racha</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Stats del día ── */}
      <div>
        <h2 className="text-sm font-black text-gray-500 uppercase tracking-wider mb-3">Hoy</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Entregados"    value={data.entregadosHoy}    icon={CheckCircle2} color="emerald" />
          <StatCard label="En ruta"       value={data.enRutaHoy}        icon={Navigation}   color="teal"    />
          <StatCard label="No responden"  value={data.noRespondenHoy}   icon={PhoneMissed}  color="amber"   />
          <StatCard label="Reprogramados" value={data.reprogramadosHoy} icon={RotateCcw}    color="violet"  />
        </div>
      </div>

      {/* ── Ganancias semana ── */}
      <div className="bg-gradient-to-r from-emerald-50 to-teal-50 rounded-2xl border border-teal-100 p-4 md:p-5">
        <h2 className="text-sm font-black text-teal-700 uppercase tracking-wider mb-4 flex items-center gap-2">
          <BarChart3 className="w-4 h-4" />Ganancias esta semana
        </h2>
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[
            { label: 'Esta semana',  value: data.gananciasSemana, highlight: true  },
            { label: 'Ayer',         value: data.gananciasAyer,   highlight: false },
            { label: 'Hoy',          value: data.gananciasHoy,    highlight: false },
          ].map(({ label, value, highlight }) => (
            <div key={label} className={`rounded-xl p-3 text-center ${highlight ? 'bg-white shadow-sm' : ''}`}>
              <p className={`text-lg md:text-xl font-black tabular-nums ${highlight ? 'text-teal-700' : 'text-gray-700'}`}>
                RD${value.toLocaleString('es-DO')}
              </p>
              <p className="text-[11px] text-gray-500 font-medium mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {/* Meta semanal progress */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-teal-700 font-semibold flex items-center gap-1.5">
              <Trophy className="w-3.5 h-3.5" />Meta semanal: {data.metaSemanal} entregas
            </span>
            <span className="font-black text-teal-800 tabular-nums">
              {data.entregadosSemana}/{data.metaSemanal}
            </span>
          </div>
          <div className="h-3 bg-teal-100 rounded-full overflow-hidden">
            <div
              className="h-3 bg-teal-500 rounded-full transition-all duration-700"
              style={{ width: `${data.progresoMetaSemanal}%` }}
            />
          </div>
          <p className="text-xs text-teal-600">
            {data.progresoMetaSemanal >= 100
              ? '🏆 ¡Meta semanal cumplida!'
              : `${data.metaSemanal - data.entregadosSemana} entregas para completar tu semana`}
          </p>
        </div>
      </div>

      {/* ── Top zonas ── */}
      {data.topZonas.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 md:p-5">
          <h2 className="text-sm font-black text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
            <MapPin className="w-4 h-4 text-teal-500" />Top zonas esta semana
          </h2>
          <div className="space-y-3">
            {data.topZonas.map((z, i) => {
              const zc = ZONE_COLORS[z.zonaId as ZoneId] ?? ZONE_COLORS['otro']
              const maxCount = data.topZonas[0].count
              const pct = Math.round((z.count / maxCount) * 100)
              return (
                <div key={z.zonaId} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-400 w-4 tabular-nums">{i + 1}</span>
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${zc.badge}`}>
                        {z.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-black text-gray-700 tabular-nums">{z.count} entregas</span>
                      <span className="text-gray-400">·</span>
                      <span className="text-teal-700 font-bold">RD${z.ganancia.toLocaleString('es-DO')}</span>
                    </div>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden ml-6">
                    <div
                      className={`h-2 ${zc.bar} rounded-full transition-all duration-700`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Eficiencia ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 md:p-5">
        <h2 className="text-sm font-black text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-500" />Eficiencia semanal
        </h2>
        <div className="flex items-center gap-4">
          <ProgressRing
            pct={data.eficiencia}
            size={80} stroke={8}
            color={data.eficiencia >= 80 ? 'stroke-green-500' : data.eficiencia >= 60 ? 'stroke-amber-500' : 'stroke-red-500'}
          >
            <p className="text-lg font-black text-gray-900 tabular-nums">{data.eficiencia}%</p>
          </ProgressRing>
          <div className="flex-1 space-y-2">
            <p className="text-sm font-semibold text-gray-700">
              {data.eficiencia >= 90 ? '⚡ Eficiencia excelente' : data.eficiencia >= 70 ? '👍 Buena eficiencia' : '⚠ Necesita mejorar'}
            </p>
            <div className="space-y-1 text-xs text-gray-500">
              <div className="flex justify-between">
                <span>Entregas exitosas</span>
                <span className="font-bold text-emerald-600">{data.entregadosSemana}</span>
              </div>
              <div className="flex justify-between">
                <span>Reprogramaciones</span>
                <span className="font-bold text-indigo-600">{data.reprogramadosSemana}</span>
              </div>
              <div className="flex justify-between">
                <span>No responden</span>
                <span className="font-bold text-amber-600">{data.noRespondenSemana}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Badges ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 md:p-5">
        <h2 className="text-sm font-black text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
          <Award className="w-4 h-4 text-amber-500" />
          Logros
          {earnedBadges.length > 0 && (
            <span className="ml-1 text-xs font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
              {earnedBadges.length} obtenidos
            </span>
          )}
        </h2>
        <div className="flex flex-wrap gap-2">
          {data.badges.map(b => <BadgeChip key={b.id} badge={b} />)}
        </div>
      </div>

      {/* ── Bonificaciones ── */}
      {data.bonuses && data.bonuses.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 md:p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-black text-gray-500 uppercase tracking-wider flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-amber-500" />
              Bonificaciones
            </h2>
            {(data.bonusHoy > 0 || data.bonusSemana > 0) && (
              <div className="flex items-center gap-2 text-xs">
                {data.bonusHoy > 0 && (
                  <span className="px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 font-bold">
                    +RD${data.bonusHoy.toLocaleString('es-DO')} hoy
                  </span>
                )}
                {data.bonusSemana > 0 && (
                  <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-700 font-bold">
                    +RD${data.bonusSemana.toLocaleString('es-DO')} semana
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="space-y-2">
            {data.bonuses.map(b => <BonusChip key={b.id} bonus={b} />)}
          </div>
        </div>
      )}

      {/* ── Coaching / motivación ── */}
      {data.coaching.length > 0 && (
        <div className="space-y-2">
          {data.coaching.map((msg, i) => (
            <div key={i}
              className="flex items-start gap-3 bg-gradient-to-r from-teal-50 to-transparent
                         border border-teal-100 rounded-xl px-4 py-3">
              <Star className="w-4 h-4 text-teal-500 shrink-0 mt-0.5" />
              <p className="text-sm text-teal-800 font-medium">{msg}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Footer con link ── */}
      <div className="flex items-center justify-between px-1">
        <p className="text-xs text-gray-400">
          Actualizado {lastUpdate.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs font-semibold text-teal-600 hover:text-teal-800
                       disabled:opacity-40 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
          <Link href="/sd-delivery"
            className="flex items-center gap-1.5 text-xs font-semibold text-teal-600 hover:text-teal-800">
            <Package className="w-3.5 h-3.5" />Ver pedidos
          </Link>
        </div>
      </div>

      {/* ── Guía de ganancias ── */}
      <details className="bg-gray-50 border border-gray-100 rounded-xl">
        <summary className="px-4 py-3 text-xs font-semibold text-gray-500 cursor-pointer
                            hover:text-gray-700 flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" />¿Cómo se calcula mi ganancia?
        </summary>
        <div className="px-4 pb-4 pt-1 space-y-1.5">
          <p className="text-[11px] font-bold text-gray-600 mb-2">Tarifas por zona</p>
          {[
            ['DN Centro (Naco, Piantini, Gazcue…)',    'RD$250/entrega'],
            ['SD Norte (Villa Mella, SDN)',             'RD$300/entrega'],
            ['SD Oeste (Herrera, Km 12, SDO)',          'RD$300/entrega'],
            ['SD Este (Los Mina, San Luis, SDE)',       'RD$300/entrega'],
            ['Zona Especial (Boca Chica, Caleta…)',     'RD$350/entrega'],
            [`Promedio estimado`,                       `RD$${SD_TARIFA_PROMEDIO}/entrega`],
          ].map(([zona, tarifa]) => (
            <div key={zona} className={`flex justify-between text-xs ${zona.startsWith('Promedio') ? 'border-t border-gray-200 pt-1.5 mt-1' : ''}`}>
              <span className="text-gray-600">{zona}</span>
              <span className={`font-bold ${zona.startsWith('Promedio') ? 'text-gray-700' : 'text-teal-700'}`}>{tarifa}</span>
            </div>
          ))}
          <p className="text-[10px] text-gray-400 mt-2">
            Las ganancias son estimadas con tarifa promedio. Las zonas especiales y periféricas pueden variar.
          </p>
          <p className="text-[11px] font-bold text-amber-700 mt-2">+ Bonificaciones adicionales disponibles</p>
        </div>
      </details>

    </div>
  )
}
