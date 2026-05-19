import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  SD_META_DIARIA, SD_META_SEMANAL, SD_TARIFA_PROMEDIO,
  SD_ZONES, detectSdZone, calcBonuses,
} from '@/lib/sd-zones'
import type { SdBonus } from '@/lib/sd-zones'

export type { SdBonus }

type Level = 'Excelente' | 'Bueno' | 'Riesgo' | 'Deficiente'

export interface SdBadge {
  id:     string
  label:  string
  emoji:  string
  earned: boolean
}

export interface SdScoreData {
  // Conteos diarios
  entregadosHoy:     number
  entregadosAyer:    number
  enRutaHoy:        number
  contactadosHoy:   number
  noRespondenHoy:   number
  reprogramadosHoy: number
  // Conteos semanales
  entregadosSemana:     number
  reprogramadosSemana:  number
  noRespondenSemana:    number
  // Score
  score:  number
  level:  Level
  // Ganancias (SD agent SÍ puede ver esto — diferente a otros roles)
  gananciasHoy:       number
  gananciasAyer:      number
  gananciasSemana:    number
  promedioEntrega:    number
  // Metas
  metaDiaria:         number
  metaSemanal:        number
  progresoMetaDiaria: number   // % (0–100)
  progresoMetaSemanal:number   // % (0–100)
  // Gamificación
  streak:             number   // días consecutivos cumpliendo meta diaria
  streakMejor:        number   // mejor racha histórica (ultimos 30 días)
  // Zonas
  topZonas: Array<{ zonaId: string; label: string; count: number; ganancia: number }>
  // Calidad
  eficiencia: number           // % exitoso del total trabajado
  // Coaching
  coaching: string[]
  // Badges
  badges: SdBadge[]
  // Bonificaciones
  bonusHoy:    number          // RD$ bonos ganados hoy
  bonusSemana: number          // RD$ bonos ganados esta semana
  bonuses:     SdBonus[]       // detalle de cada bono con earned
}

// ── Helpers de fecha RD (UTC-4, sin DST) ───────────────────────────────────────

function rdDayISO(offsetDays = 0): string {
  const rdStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = rdStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + offsetDays, 4, 0, 0, 0)).toISOString()
}

function levelFromScore(score: number): Level {
  if (score >= 90) return 'Excelente'
  if (score >= 75) return 'Bueno'
  if (score >= 60) return 'Riesgo'
  return 'Deficiente'
}

// ── Cálculo de score SD ────────────────────────────────────────────────────────
// base = 40
// + min(entregadosSemana / metaSemanal, 1) × 30   → max 30
// + (eficiencia / 100) × 18                        → max 18
// + min(streak, 5) × 2                             → max 10 (streak bonus)
// − min(reprogramadosSemana, 5) × 2               → max −10 (penalización)

function calcSdScore(params: {
  entregadosSemana:    number
  eficiencia:          number
  streak:              number
  reprogramadosSemana: number
}): number {
  const { entregadosSemana, eficiencia, streak, reprogramadosSemana } = params
  const base          = 40
  const volumen       = Math.min(entregadosSemana / SD_META_SEMANAL, 1) * 30
  const efic          = (eficiencia / 100) * 18
  const streakBonus   = Math.min(streak, 5) * 2
  const reproPenalty  = Math.min(reprogramadosSemana, 5) * 2
  return Math.max(0, Math.min(100, Math.round(base + volumen + efic + streakBonus - reproPenalty)))
}

// ── Main handler ───────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'santo_domingo_delivery_agent' && profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Acceso denegado' }, { status: 403 })
    }

    const agentId = user.id

    // ── Rangos de tiempo ─────────────────────────────────────────────────────
    const todayIso     = rdDayISO(0)
    const yesterdayIso = rdDayISO(-1)
    const weekIso      = rdDayISO(-7)
    const month30Iso   = rdDayISO(-30)

    // ── Conteos diarios (queries paralelas) ───────────────────────────────────
    const [
      { count: entregadosHoy },
      { count: entregadosAyer },
      { count: enRutaHoy },
      { count: contactadosHoy },
      { count: noRespondenHoy },
      { count: reprogramadosHoy },
      { count: entregadosSemana },
      { count: reprogramadosSemana },
      { count: noRespondenSemana },
    ] = await Promise.all([
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'delivered').gte('created_at', todayIso),
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'delivered')
        .gte('created_at', yesterdayIso).lt('created_at', todayIso),
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'route_confirmed').gte('created_at', todayIso),
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'contacted').gte('created_at', todayIso),
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'contacted').eq('contact_result', 'no_answer').gte('created_at', todayIso),
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'rescheduled').gte('created_at', todayIso),
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'delivered').gte('created_at', weekIso),
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'rescheduled').gte('created_at', weekIso),
      supabase.from('agent_actions').select('*', { count: 'exact', head: true })
        .eq('agent_id', agentId).eq('action_type', 'contacted').eq('contact_result', 'no_answer').gte('created_at', weekIso),
    ])

    const eHoy    = entregadosHoy    ?? 0
    const eAyer   = entregadosAyer   ?? 0
    const eSemana = entregadosSemana ?? 0
    const rHoy    = reprogramadosHoy    ?? 0
    const rSemana = reprogramadosSemana ?? 0
    const nSemana = noRespondenSemana   ?? 0

    // ── Streak — últimos 30 días ─────────────────────────────────────────────
    // Traer conteo de entregados por día de los últimos 30 días
    const { data: rawDeliveries } = await supabase
      .from('agent_actions')
      .select('created_at')
      .eq('agent_id', agentId)
      .eq('action_type', 'delivered')
      .gte('created_at', month30Iso)
      .order('created_at', { ascending: false })

    // Agrupar por día RD
    const dayCountMap: Record<string, number> = {}
    for (const row of rawDeliveries ?? []) {
      const dayKey = new Date(row.created_at)
        .toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' })
      dayCountMap[dayKey] = (dayCountMap[dayKey] ?? 0) + 1
    }

    // Calcular racha actual (desde hoy hacia atrás)
    let streak = 0
    let streakMejor = 0
    let tempStreak  = 0
    for (let i = 0; i < 30; i++) {
      const dayIso = rdDayISO(-i)
      const dayKey = new Date(dayIso)
        .toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' })
      const count = dayCountMap[dayKey] ?? 0
      if (count >= SD_META_DIARIA) {
        if (i === 0 || streak > 0) streak++
        tempStreak++
        streakMejor = Math.max(streakMejor, tempStreak)
      } else {
        if (i > 0) tempStreak = 0  // reset rolling
        if (streak === 0 && i === 0) {
          // hoy no alcanzó meta — streak sigue en 0
        }
      }
    }

    // ── Ganancias estimadas ──────────────────────────────────────────────────
    // Tarifa promedio ponderada (mayoría en zonas RD$300, DN Centro RD$250)
    const gananciasHoy    = eHoy    * SD_TARIFA_PROMEDIO
    const gananciasAyer   = eAyer   * SD_TARIFA_PROMEDIO
    const gananciasSemana = eSemana * SD_TARIFA_PROMEDIO
    const promedioEntrega = SD_TARIFA_PROMEDIO

    // ── Progreso de metas ────────────────────────────────────────────────────
    const progresoMetaDiaria  = Math.min(Math.round((eHoy    / SD_META_DIARIA)  * 100), 100)
    const progresoMetaSemanal = Math.min(Math.round((eSemana / SD_META_SEMANAL) * 100), 100)

    // ── Eficiencia ───────────────────────────────────────────────────────────
    const totalTrabajadosSemana = eSemana + rSemana + nSemana
    const eficiencia = totalTrabajadosSemana > 0
      ? Math.round((eSemana / totalTrabajadosSemana) * 100)
      : 0

    // ── Score ────────────────────────────────────────────────────────────────
    const score = calcSdScore({ entregadosSemana: eSemana, eficiencia, streak, reprogramadosSemana: rSemana })
    const level = levelFromScore(score)

    // ── Top zonas ────────────────────────────────────────────────────────────
    // Trae las últimas acciones delivered con order_id para detectar zona
    const { data: deliveredActions } = await supabase
      .from('agent_actions')
      .select('order_id')
      .eq('agent_id', agentId)
      .eq('action_type', 'delivered')
      .gte('created_at', weekIso)
      .limit(200)

    const orderIds = (deliveredActions ?? []).map(a => a.order_id).filter(Boolean)

    let topZonas: SdScoreData['topZonas'] = []
    if (orderIds.length > 0) {
      const { data: ordersData } = await supabase
        .from('orders')
        .select('id, city, province, customer_address')
        .in('id', orderIds)

      const zoneCount: Record<string, { count: number; zona: typeof SD_ZONES[0] }> = {}
      for (const o of ordersData ?? []) {
        const zona = detectSdZone(o.city, o.province, o.customer_address)
        if (!zoneCount[zona.id]) zoneCount[zona.id] = { count: 0, zona }
        zoneCount[zona.id].count++
      }
      topZonas = Object.entries(zoneCount)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5)
        .map(([, v]) => ({
          zonaId:  v.zona.id,
          label:   v.zona.label,
          count:   v.count,
          ganancia: v.count * v.zona.tarifa,
        }))
    }

    // ── Bonificaciones ───────────────────────────────────────────────────────
    const { bonusHoy, bonusSemana, bonuses } = calcBonuses({
      entregadosHoy:      eHoy,
      entregadosSemana:   eSemana,
      eficiencia,
      reprogramadosSemana: rSemana,
      streak,
    })

    // ── Coaching ─────────────────────────────────────────────────────────────
    const coaching: string[] = []
    const faltanMeta = Math.max(0, SD_META_DIARIA - eHoy)
    if (faltanMeta === 0) {
      coaching.push(`¡Meta diaria cumplida! Llevas ${eHoy} entregas hoy.${bonusHoy > 0 ? ` +RD$${bonusHoy} bono.` : ''} ¡Excelente!`)
    } else if (faltanMeta <= 2) {
      coaching.push(`¡Casi! Te faltan ${faltanMeta} entrega${faltanMeta > 1 ? 's' : ''} para tu meta del día${bonusHoy === 0 ? ` y el bono de RD$100` : ''}.`)
    } else {
      coaching.push(`Hoy llevas ${eHoy} entregas. Llega a ${SD_META_DIARIA} para tu meta y bono diario.`)
    }
    if (streak >= 3)          coaching.push(`🔥 Llevas ${streak} días seguidos cumpliendo tu meta. ¡Racha imparable!`)
    if (eficiencia >= 90)     coaching.push(`⚡ Eficiencia ${eficiencia}%. ¡Bono de eficiencia desbloqueado!`)
    if (eficiencia >= 70 && eficiencia < 90) coaching.push(`Eficiencia ${eficiencia}%. Sin reprogramaciones esta semana ganas +RD$300 de bono.`)
    if (rSemana >= 3)         coaching.push(`${rSemana} reprogramaciones esta semana. Confirma con el cliente antes de salir para mantener tu bono.`)
    if (eSemana >= 20)        coaching.push(`¡${eSemana} entregas esta semana! Vas por la meta semanal (+RD$500 de bono).`)
    if (bonusSemana > 0)      coaching.push(`🎉 Llevas RD$${bonusSemana.toLocaleString()} en bonos esta semana. ¡Sigue así!`)
    if (coaching.length > 4)  coaching.splice(4)

    // ── Badges ───────────────────────────────────────────────────────────────
    const badges: SdBadge[] = [
      { id: 'primera_entrega', label: 'Primera entrega',     emoji: '📦', earned: eHoy >= 1               },
      { id: 'meta_diaria',     label: 'Meta diaria',         emoji: '🎯', earned: eHoy >= SD_META_DIARIA   },
      { id: 'racha_3',         label: '3 días de racha',     emoji: '🔥', earned: streak >= 3              },
      { id: 'racha_5',         label: '5 días de racha',     emoji: '💪', earned: streak >= 5              },
      { id: 'velocista',       label: 'Eficiencia 90%+',     emoji: '⚡', earned: eficiencia >= 90         },
      { id: '20_semana',       label: '20 entregas semana',  emoji: '🚀', earned: eSemana >= 20            },
      { id: 'meta_semanal',    label: 'Meta semanal',        emoji: '🏆', earned: eSemana >= SD_META_SEMANAL },
    ]

    const result: SdScoreData = {
      entregadosHoy:     eHoy,
      entregadosAyer:    eAyer,
      enRutaHoy:        enRutaHoy        ?? 0,
      contactadosHoy:   contactadosHoy   ?? 0,
      noRespondenHoy:   noRespondenHoy   ?? 0,
      reprogramadosHoy: rHoy,
      entregadosSemana:     eSemana,
      reprogramadosSemana:  rSemana,
      noRespondenSemana:    nSemana,
      score,
      level,
      gananciasHoy,
      gananciasAyer,
      gananciasSemana,
      promedioEntrega,
      metaDiaria:          SD_META_DIARIA,
      metaSemanal:         SD_META_SEMANAL,
      progresoMetaDiaria,
      progresoMetaSemanal,
      streak,
      streakMejor,
      topZonas,
      eficiencia,
      coaching,
      badges,
      bonusHoy,
      bonusSemana,
      bonuses,
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[GET /api/sd-delivery/score]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
