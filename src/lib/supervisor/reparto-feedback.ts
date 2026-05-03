export type FeedbackLevel = 'success' | 'warning' | 'danger' | 'info'

export interface SupervisorFeedback {
  id:             string
  level:          FeedbackLevel
  title:          string
  message:        string
  recommendation: string
}

export interface RepartoPerf {
  // Hoy
  entregadosHoy:   number
  contactadosHoy:  number
  incidenciasHoy:  number
  escaladosHoy:    number
  criticosActivos: number
  // Ayer
  entregadosAyer:  number
  contactadosAyer: number
}

const LEVEL_ORDER: Record<FeedbackLevel, number> = {
  danger: 0, warning: 1, info: 2, success: 3,
}

export function generateRepartoFeedback(perf: RepartoPerf): SupervisorFeedback[] {
  const items: SupervisorFeedback[] = []

  const {
    entregadosHoy, contactadosHoy, incidenciasHoy,
    escaladosHoy, criticosActivos,
    entregadosAyer, contactadosAyer,
  } = perf

  const tasaHoy  = contactadosHoy  > 0 ? Math.round((entregadosHoy  / contactadosHoy)  * 100) : null
  const tasaAyer = contactadosAyer > 0 ? Math.round((entregadosAyer / contactadosAyer) * 100) : null

  // ── 1. Cola crítica alta ──────────────────────────────────────────────────
  if (criticosActivos >= 5) {
    items.push({
      id:    'critical-queue-high',
      level: 'danger',
      title: 'Cola crítica alta',
      message: `Hay ${criticosActivos} pedidos con más de 48 horas en reparto sin novedad.`,
      recommendation: 'Prioriza contactar y escalar estos pedidos inmediatamente. Coordina con la mensajería.',
    })
  } else if (criticosActivos >= 2) {
    items.push({
      id:    'critical-queue-warning',
      level: 'warning',
      title: 'Pedidos críticos pendientes',
      message: `${criticosActivos} pedido${criticosActivos !== 1 ? 's' : ''} lleva${criticosActivos === 1 ? '' : 'n'} más de 48h en reparto.`,
      recommendation: 'Contacta al cliente y verifica con el mensajero para actualizar el estado.',
    })
  }

  // ── 2. Sin actividad ─────────────────────────────────────────────────────
  if (contactadosHoy === 0 && entregadosHoy === 0) {
    items.push({
      id:    'zero-activity',
      level: 'danger',
      title: 'Sin actividad registrada',
      message: 'No hay contactos ni entregas registradas hoy.',
      recommendation: 'Registra cada gestión en el sistema. Sin datos no hay visibilidad de tu operación.',
    })
  }

  // ── 3. Tasa de entrega baja ───────────────────────────────────────────────
  if (contactadosHoy >= 5 && tasaHoy !== null && tasaHoy < 40) {
    items.push({
      id:    'low-delivery-rate',
      level: 'warning',
      title: 'Tasa de entrega baja',
      message: `Solo ${entregadosHoy} de ${contactadosHoy} gestiones resultaron en entrega (${tasaHoy}%).`,
      recommendation: 'Verifica si hay problemas de dirección o disponibilidad del cliente. Escala los casos difíciles.',
    })
  }

  // ── 4. Alto número de incidencias ─────────────────────────────────────────
  if (contactadosHoy >= 3 && incidenciasHoy >= contactadosHoy * 0.5) {
    items.push({
      id:    'high-incidencias',
      level: 'warning',
      title: 'Muchos clientes sin respuesta',
      message: `${incidenciasHoy} de ${contactadosHoy} contactos no pudieron completarse (no responde o número incorrecto).`,
      recommendation: 'Intenta en distintos horarios. Para números incorrectos, verifica con el agente de confirmación.',
    })
  }

  // ── 5. Escalados frecuentes ───────────────────────────────────────────────
  if (escaladosHoy >= 3) {
    items.push({
      id:    'high-escalados',
      level: 'info',
      title: 'Varios escalados hoy',
      message: `Registraste ${escaladosHoy} reclamos a mensajería hoy.`,
      recommendation: 'Asegúrate de que cada reclamo tenga toda la información necesaria para que el courier pueda actuar.',
    })
  }

  // ── 6. Tendencia bajista vs ayer ─────────────────────────────────────────
  if (
    entregadosAyer >= 3 &&
    entregadosHoy  < entregadosAyer * 0.5 &&
    contactadosHoy >= 3
  ) {
    items.push({
      id:    'downward-trend',
      level: 'warning',
      title: 'Rendimiento por debajo de ayer',
      message: `Ayer entregaste ${entregadosAyer} pedidos, hoy llevas ${entregadosHoy}.`,
      recommendation: 'Revisa si hay un factor externo afectando las entregas hoy (zona, horario, clima).',
    })
  }

  // ── 7. Meta alcanzada ────────────────────────────────────────────────────
  if (entregadosHoy >= 10) {
    items.push({
      id:    'meta-reached',
      level: 'success',
      title: '¡Meta de entregas alcanzada!',
      message: `Superaste las 10 entregas del día con ${entregadosHoy} en total.`,
      recommendation: 'Excelente desempeño. Mantén el ritmo y apoya a gestionar los casos críticos restantes.',
    })
  }

  // ── 8. Gran rendimiento sin críticos ─────────────────────────────────────
  if (entregadosHoy >= 6 && criticosActivos === 0) {
    items.push({
      id:    'great-performance',
      level: 'success',
      title: 'Excelente desempeño hoy',
      message: `${entregadosHoy} entregas completadas y sin pedidos críticos en cola.`,
      recommendation: 'Sigue así. Registra cualquier novedad para mantener la operación transparente.',
    })
  }

  return items.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}
