export type FeedbackLevel = 'success' | 'warning' | 'danger' | 'info'

export interface SupervisorFeedback {
  id:             string
  level:          FeedbackLevel
  title:          string
  message:        string
  recommendation: string
  href?:          string
}

export interface NoveltyPerf {
  // Hoy
  novedadesTrabajadasHoy:   number
  pedidosContactadosHoy:    number
  pedidosReprogramadosHoy:  number
  pedidosNoRespondenHoy:    number
  pedidosNoSalvablesHoy:    number
  tasaRecuperacionHoy:      number | null
  // Ayer
  trabajadosAyer:           number
  reprogramadosAyer:        number
  tasaAyer:                 number | null
  // Cola
  atrasadosPendientes:      number
}

const LEVEL_ORDER: Record<FeedbackLevel, number> = {
  danger:  0,
  warning: 1,
  info:    2,
  success: 3,
}

export function generateNoveltyFeedback(perf: NoveltyPerf): SupervisorFeedback[] {
  const items: SupervisorFeedback[] = []
  const {
    novedadesTrabajadasHoy, pedidosContactadosHoy, pedidosReprogramadosHoy,
    pedidosNoRespondenHoy, pedidosNoSalvablesHoy,
    tasaRecuperacionHoy, tasaAyer, atrasadosPendientes,
  } = perf

  // Regla 1: Volumen bajo
  if (novedadesTrabajadasHoy < 5) {
    items.push({
      id:             'low-volume',
      level:          'warning',
      title:          'Pocas novedades trabajadas',
      message:        `Solo has trabajado ${novedadesTrabajadasHoy} novedad${novedadesTrabajadasHoy !== 1 ? 'es' : ''} hoy. El objetivo mínimo es 5 antes del mediodía.`,
      recommendation: 'Revisa la cola de novedades y prioriza los pedidos con más intentos de entrega fallidos.',
      href:           '/novedad',
    })
  }

  // Regla 2: Tasa de recuperación baja con volumen suficiente
  if (tasaRecuperacionHoy !== null && tasaRecuperacionHoy < 40 && novedadesTrabajadasHoy >= 5) {
    items.push({
      id:             'low-recovery',
      level:          'danger',
      title:          'Tasa de recuperación crítica',
      message:        `Tu tasa de recuperación es ${tasaRecuperacionHoy}%, muy por debajo del mínimo del 40%.`,
      recommendation: 'Asegúrate de registrar correctamente cada resultado. Si el cliente no responde, intenta en un horario diferente antes de marcar como no salvable.',
      href:           '/novedad',
    })
  }

  // Regla 3: Tasa de recuperación excelente
  if (tasaRecuperacionHoy !== null && tasaRecuperacionHoy >= 70 && novedadesTrabajadasHoy >= 5) {
    items.push({
      id:             'great-recovery',
      level:          'success',
      title:          'Excelente tasa de recuperación',
      message:        `Llevas un ${tasaRecuperacionHoy}% de recuperación hoy. Sigue así.`,
      recommendation: 'Mantén el ritmo y enfócate en reducir los pedidos atrasados pendientes.',
      href:           '/novedad',
    })
  }

  // Regla 4: Cola de atrasados crítica
  if (atrasadosPendientes >= 8) {
    items.push({
      id:             'overdue-critical',
      level:          'danger',
      title:          'Cola de atrasados crítica',
      message:        `Tienes ${atrasadosPendientes} novedades con más de 24h sin gestionar.`,
      recommendation: 'Atiéndelos primero antes de nuevas novedades. Escala al supervisor los que no puedas resolver hoy.',
      href:           '/novedad',
    })
  } else if (atrasadosPendientes > 0) {
    items.push({
      id:             'overdue-warning',
      level:          'warning',
      title:          'Novedades atrasadas pendientes',
      message:        `Tienes ${atrasadosPendientes} novedad${atrasadosPendientes !== 1 ? 'es' : ''} con más de 24h sin gestionar.`,
      recommendation: 'Priorízalas al inicio de tu jornada antes de atender novedades nuevas.',
      href:           '/novedad',
    })
  }

  // Regla 5: Alta tasa de no responden
  if (pedidosContactadosHoy > 0 && pedidosNoRespondenHoy >= 4 && pedidosNoRespondenHoy / pedidosContactadosHoy > 0.4) {
    items.push({
      id:             'no-answer-high',
      level:          'info',
      title:          'Muchos clientes sin respuesta',
      message:        `El ${Math.round((pedidosNoRespondenHoy / pedidosContactadosHoy) * 100)}% de tus contactos hoy no respondieron (${pedidosNoRespondenHoy} de ${pedidosContactadosHoy}).`,
      recommendation: 'Prueba contactar entre 11am–1pm y 5pm–7pm. Si un cliente no responde en 2 intentos, coordina con el courier para reprogramar directamente.',
      href:           '/novedad',
    })
  }

  // Regla 6: Varios no salvables — posible problema de calidad
  if (pedidosNoSalvablesHoy >= 3) {
    items.push({
      id:             'high-no-salvable',
      level:          'info',
      title:          `${pedidosNoSalvablesHoy} pedidos marcados como no salvables`,
      message:        'Un número elevado de no salvables puede indicar problemas con la dirección, producto o proceso de contacto.',
      recommendation: 'Revisa si hay un patrón común (misma ciudad, mismo motivo de novedad) y comenta al supervisor.',
      href:           '/novedad',
    })
  }

  // Regla 7: Tendencia negativa vs ayer
  if (
    tasaRecuperacionHoy !== null &&
    tasaAyer !== null &&
    tasaAyer > 0 &&
    novedadesTrabajadasHoy >= 5 &&
    tasaRecuperacionHoy < tasaAyer
  ) {
    const diff = tasaAyer - tasaRecuperacionHoy
    items.push({
      id:             'downward-trend',
      level:          'warning',
      title:          'Tasa inferior a ayer',
      message:        `Hoy llevas ${tasaRecuperacionHoy}% vs ${tasaAyer}% de ayer (−${diff} puntos).`,
      recommendation: 'Identifica qué funcionó ayer y trata de replicarlo. Revisa si los pedidos de hoy tienen más intentos fallidos que los de ayer.',
      href:           '/novedad',
    })
  }

  // Regla 8: Meta de reprogramados alcanzada
  if (pedidosReprogramadosHoy >= 20) {
    items.push({
      id:             'meta-reached',
      level:          'success',
      title:          '¡Meta del día alcanzada!',
      message:        `Has reprogramado ${pedidosReprogramadosHoy} pedidos hoy, superando el objetivo de 20.`,
      recommendation: 'Aprovecha el resto de la jornada para reducir la cola de atrasados.',
      href:           '/novedad',
    })
  }

  return items.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}
