export type FeedbackLevel = 'success' | 'warning' | 'danger' | 'info'

export interface SupervisorFeedback {
  id:             string
  level:          FeedbackLevel
  title:          string
  message:        string
  recommendation: string
}

export interface ConfirmPerf {
  confirmadosHoy:        number
  contactadosHoy:        number
  noRespondieronHoy:     number
  canceladosHoy:         number
  tasaConfirmacionHoy:   number | null
  tasaAyer:              number | null
  atrasadosPendientes:   number
}

const LEVEL_ORDER: Record<FeedbackLevel, number> = {
  danger:  0,
  warning: 1,
  info:    2,
  success: 3,
}

export function generateSupervisorFeedback(perf: ConfirmPerf): SupervisorFeedback[] {
  const items: SupervisorFeedback[] = []
  const { confirmadosHoy, contactadosHoy, noRespondieronHoy, canceladosHoy,
          tasaConfirmacionHoy, tasaAyer, atrasadosPendientes } = perf

  // Regla 1: Volumen bajo
  if (contactadosHoy < 10) {
    items.push({
      id:             'low-volume',
      level:          'warning',
      title:          'Ritmo de contacto bajo',
      message:        `Solo has contactado ${contactadosHoy} cliente${contactadosHoy !== 1 ? 's' : ''} hoy. El objetivo mínimo es 10 antes del mediodía.`,
      recommendation: 'Revisa la cola de nuevos pedidos y prioriza los más recientes.',
    })
  }

  // Regla 2: Tasa baja con volumen suficiente
  if (tasaConfirmacionHoy !== null && tasaConfirmacionHoy < 40 && contactadosHoy >= 10) {
    items.push({
      id:             'low-rate',
      level:          'danger',
      title:          'Tasa de confirmación crítica',
      message:        `Tu tasa es ${tasaConfirmacionHoy}%, muy por debajo del mínimo del 40%.`,
      recommendation: 'Asegúrate de registrar cada resultado correctamente. Si el cliente no contestó, márquelo como "no responde" y no como cancelado.',
    })
  }

  // Regla 3: Tasa excelente
  if (tasaConfirmacionHoy !== null && tasaConfirmacionHoy >= 70 && contactadosHoy >= 5) {
    items.push({
      id:             'great-rate',
      level:          'success',
      title:          'Excelente tasa de confirmación',
      message:        `Llevas un ${tasaConfirmacionHoy}% de confirmaciones hoy. Sigue así.`,
      recommendation: 'Mantén el ritmo y enfócate en reducir los pedidos atrasados.',
    })
  }

  // Regla 4: Pedidos atrasados
  if (atrasadosPendientes >= 5) {
    items.push({
      id:             'overdue-critical',
      level:          'danger',
      title:          'Cola de atrasados crítica',
      message:        `Tienes ${atrasadosPendientes} pedidos con más de 48h sin confirmar.`,
      recommendation: 'Atiéndelos primero antes de nuevos pedidos. Escala al supervisor los que no puedas resolver.',
    })
  } else if (atrasadosPendientes > 0) {
    items.push({
      id:             'overdue-warning',
      level:          'warning',
      title:          'Pedidos atrasados pendientes',
      message:        `Tienes ${atrasadosPendientes} pedido${atrasadosPendientes !== 1 ? 's' : ''} con más de 48h sin confirmar.`,
      recommendation: 'Priorízalos al inicio de tu jornada antes de atender pedidos nuevos.',
    })
  }

  // Regla 5: Alta tasa de no responden
  if (contactadosHoy > 0 && noRespondieronHoy >= 5 && noRespondieronHoy / contactadosHoy > 0.4) {
    items.push({
      id:             'no-answer-high',
      level:          'info',
      title:          'Muchos clientes sin respuesta',
      message:        `El ${Math.round((noRespondieronHoy / contactadosHoy) * 100)}% de tus contactos de hoy no respondieron (${noRespondieronHoy} de ${contactadosHoy}).`,
      recommendation: 'Prueba contactar en horarios distintos: entre 11am–1pm y 5pm–7pm suele haber mejor respuesta.',
    })
  }

  // Regla 6: Varios cancelados
  if (canceladosHoy >= 3) {
    items.push({
      id:             'cancellations',
      level:          'info',
      title:          `${canceladosHoy} pedidos cancelados hoy`,
      message:        'Un número elevado de cancelaciones puede indicar problemas con los pedidos o el proceso de contacto.',
      recommendation: 'Revisa si hay un patrón (misma ciudad, mismo producto) y comenta al supervisor si se repite.',
    })
  }

  // Regla 7: Tendencia negativa vs ayer
  if (
    tasaConfirmacionHoy !== null &&
    tasaAyer !== null &&
    tasaAyer > 0 &&
    contactadosHoy >= 5 &&
    tasaConfirmacionHoy < tasaAyer
  ) {
    const diff = tasaAyer - tasaConfirmacionHoy
    items.push({
      id:             'downward-trend',
      level:          'warning',
      title:          'Tasa inferior a ayer',
      message:        `Hoy llevas ${tasaConfirmacionHoy}% vs ${tasaAyer}% de ayer (−${diff} puntos).`,
      recommendation: 'Identifica qué funcionó ayer y trata de replicarlo. Revisa si cambiaste el guión de contacto.',
    })
  }

  // Regla 8: Meta alcanzada
  if (confirmadosHoy >= 25) {
    items.push({
      id:             'meta-reached',
      level:          'success',
      title:          '¡Meta del día alcanzada!',
      message:        `Has confirmado ${confirmadosHoy} pedidos hoy, superando el objetivo de 25.`,
      recommendation: 'Aprovecha el resto de la jornada para reducir la cola de atrasados.',
    })
  }

  return items.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}
