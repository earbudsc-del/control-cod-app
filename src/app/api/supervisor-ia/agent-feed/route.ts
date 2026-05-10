import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const AGENT_ROLES = ['confirmation_agent', 'novelty_agent', 'delivery_agent'] as const
type AgentRole = typeof AGENT_ROLES[number]

export interface AgentAlert {
  id:        string
  severity:  'info' | 'warning' | 'critical'
  title:     string
  message:   string
  count?:    number
  href?:     string
}

export interface AgentFeedResponse {
  role:        AgentRole
  generatedAt: string
  alerts:      AgentAlert[]
  priorities:  AgentAlert[]
  coaching:    AgentAlert[]
}

function rdDayStart(): string {
  const dateStrRD = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = dateStrRD.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 4, 0, 0, 0)).toISOString()
}

// ── confirmation_agent feed ──────────────────────────────────────────────────

async function buildConfirmationFeed(supabase: Awaited<ReturnType<typeof createClient>>): Promise<Pick<AgentFeedResponse, 'alerts' | 'priorities' | 'coaching'>> {
  const now        = new Date()
  const cutoff24h  = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  const [
    totalPendingRes,
    pending24hRes,
    carritosPendingRes,
    sinCoberturaRes,
    reintentoRes,
  ] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('confirmation_status', 'pending')
      .eq('normalized_status', 'pending')
      .is('tracking_number', null),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('confirmation_status', 'pending')
      .eq('normalized_status', 'pending')
      .is('tracking_number', null)
      .lt('shopify_created_at', cutoff24h),

    supabase.from('abandoned_carts').select('id', { count: 'exact', head: true })
      .eq('recovery_status', 'pending'),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('confirmation_status', 'no_coverage'),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('confirmation_status', 'pending')
      .eq('normalized_status', 'pending')
      .is('tracking_number', null)
      .gte('delivery_attempts', 1),
  ])

  const totalPending   = totalPendingRes.count   ?? 0
  const pending24h     = pending24hRes.count      ?? 0
  const carritosPend   = carritosPendingRes.count ?? 0
  const sinCobertura   = sinCoberturaRes.count    ?? 0
  const reintentos     = reintentoRes.count       ?? 0
  const nuevos         = Math.max(0, totalPending - reintentos)

  const alerts: AgentAlert[]    = []
  const priorities: AgentAlert[] = []
  const coaching: AgentAlert[]   = []

  // Alertas críticas
  if (pending24h > 0) {
    alerts.push({
      id:       'pending-24h',
      severity: 'critical',
      title:    `${pending24h} pendiente${pending24h !== 1 ? 's' : ''} +24h`,
      message:  `Hay ${pending24h} pedido${pending24h !== 1 ? 's' : ''} sin confirmar con más de 24 horas. Prioriza estos antes que los nuevos.`,
      count:    pending24h,
      href:     '/confirmacion',
    })
  }

  // Reintentos importantes
  if (reintentos > 0) {
    alerts.push({
      id:       'reintentos',
      severity: pending24h > 20 ? 'warning' : 'info',
      title:    `${reintentos} reintento${reintentos !== 1 ? 's' : ''} pendiente${reintentos !== 1 ? 's' : ''}`,
      message:  `${reintentos} pedido${reintentos !== 1 ? 's' : ''} requieren reintento de contacto.`,
      count:    reintentos,
      href:     '/confirmacion',
    })
  }

  // Prioridades
  if (nuevos > 0) {
    priorities.push({
      id:       'nuevos',
      severity: 'info',
      title:    `${nuevos} pedido${nuevos !== 1 ? 's' : ''} nuevo${nuevos !== 1 ? 's' : ''}`,
      message:  `Tienes ${nuevos} pedido${nuevos !== 1 ? 's' : ''} nuevo${nuevos !== 1 ? 's' : ''} esperando confirmación.`,
      count:    nuevos,
      href:     '/confirmacion',
    })
  }

  if (carritosPend > 0) {
    priorities.push({
      id:       'carritos-pending',
      severity: carritosPend > 50 ? 'warning' : 'info',
      title:    `${carritosPend} carrito${carritosPend !== 1 ? 's' : ''} abandonado${carritosPend !== 1 ? 's' : ''}`,
      message:  `Hay ${carritosPend} carrito${carritosPend !== 1 ? 's' : ''} pendiente${carritosPend !== 1 ? 's' : ''} de recuperación.`,
      count:    carritosPend,
      href:     '/carritos-abandonados?status=pending',
    })
  }

  if (sinCobertura > 0) {
    priorities.push({
      id:       'sin-cobertura',
      severity: 'info',
      title:    `${sinCobertura} sin cobertura`,
      message:  `${sinCobertura} pedido${sinCobertura !== 1 ? 's' : ''} marcado${sinCobertura !== 1 ? 's' : ''} fuera de cobertura. Verifica si aplica Santo Domingo o transporte local.`,
      count:    sinCobertura,
      href:     '/confirmacion',
    })
  }

  // Coaching
  if (pending24h > 0 && nuevos > 0) {
    coaching.push({
      id:      'coaching-orden',
      severity:'info',
      title:   'Orden de prioridad',
      message: `Hoy tienes ${nuevos} nuevo${nuevos !== 1 ? 's' : ''} y ${pending24h} pendiente${pending24h !== 1 ? 's' : ''} +24h. Prioriza los atrasados primero, luego atiende los nuevos.`,
    })
  } else if (pending24h === 0 && totalPending > 0) {
    coaching.push({
      id:      'coaching-ok',
      severity:'info',
      title:   'Sin atrasados críticos',
      message: 'No tienes pedidos con más de 24h sin confirmar. Sigue al día con la cola.',
    })
  } else if (totalPending === 0) {
    coaching.push({
      id:      'coaching-clear',
      severity:'info',
      title:   'Cola al día',
      message: 'No tienes pedidos pendientes en confirmación. ¡Buen trabajo!',
    })
  }

  if (reintentos > 10) {
    coaching.push({
      id:      'coaching-reintentos',
      severity:'info',
      title:   'Reintentos importantes',
      message: `Tienes ${reintentos} pedidos que necesitan reintento. No descartes sin intentar en un horario diferente.`,
      href:    '/confirmacion',
    })
  }

  return { alerts, priorities, coaching }
}

// ── novelty_agent feed ───────────────────────────────────────────────────────

async function buildNoveltyFeed(supabase: Awaited<ReturnType<typeof createClient>>): Promise<Pick<AgentFeedResponse, 'alerts' | 'priorities' | 'coaching'>> {
  const now       = new Date()
  const cutoff48h = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
  const cutoff7d  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString()
  const cutoff14d = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()

  const nov7OrFilter  = `status_since.lt.${cutoff7d},and(status_since.is.null,updated_at.lt.${cutoff7d})`
  const nov14OrFilter = `status_since.lt.${cutoff14d},and(status_since.is.null,updated_at.lt.${cutoff14d})`
  const trOrFilter    = `status_since.lt.${cutoff48h},and(status_since.is.null,shipment_created_at.lt.${cutoff48h}),and(status_since.is.null,shipment_created_at.is.null,created_at.lt.${cutoff48h})`

  const [
    novedadesActivasRes,
    novedad2IntRes,
    novedad7dRes,
    novedad14dRes,
    transitoCriticoRes,
    generadasCriticasRes,
    posIndemnRes,
  ] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('normalized_status', 'novedad'),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('normalized_status', 'novedad')
      .gte('delivery_attempts', 2),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('normalized_status', 'novedad')
      .or(nov7OrFilter),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('normalized_status', 'novedad')
      .or(nov14OrFilter),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('normalized_status', 'in_transit')
      .not('raw_status', 'ilike', '%generada%')
      .not('raw_status', 'ilike', '%anulada%')
      .not('raw_status', 'ilike', '%cancelada%')
      .or(trOrFilter),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('normalized_status', 'in_transit')
      .ilike('raw_status', '%generada%')
      .or(trOrFilter),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('normalized_status', 'returned')
      .gte('delivery_attempts', 2),
  ])

  const novedadesActivas  = novedadesActivasRes.count  ?? 0
  const novedad2Int       = novedad2IntRes.count        ?? 0
  const novedad7d         = novedad7dRes.count          ?? 0
  const novedad14d        = novedad14dRes.count         ?? 0
  const transitoCritico   = transitoCriticoRes.count    ?? 0
  const generadasCriticas = generadasCriticasRes.count  ?? 0
  const posIndemn         = posIndemnRes.count          ?? 0

  const alerts: AgentAlert[]    = []
  const priorities: AgentAlert[] = []
  const coaching: AgentAlert[]   = []

  // Alertas críticas
  if (novedad2Int > 0) {
    alerts.push({
      id:       'novedad-2-intentos',
      severity: novedad2Int > 20 ? 'critical' : 'warning',
      title:    `${novedad2Int} novedades con 2+ intentos`,
      message:  `Tienes ${novedad2Int} novedad${novedad2Int !== 1 ? 'es' : ''} con 2 o más intentos fallidos. No reprogrames sin contactar al cliente.`,
      count:    novedad2Int,
      href:     '/novedad?filter=2-intentos',
    })
  }

  if (novedad14d > 0) {
    alerts.push({
      id:       'novedad-14d',
      severity: 'critical',
      title:    `${novedad14d} novedades +14 días`,
      message:  `${novedad14d} novedad${novedad14d !== 1 ? 'es' : ''} llevan más de 14 días sin resolverse. Alto riesgo de devolución o indemnización.`,
      count:    novedad14d,
      href:     '/novedad',
    })
  }

  if (generadasCriticas > 0) {
    alerts.push({
      id:       'generadas-criticas',
      severity: 'critical',
      title:    `${generadasCriticas} generadas críticas +48h`,
      message:  `${generadasCriticas} guía${generadasCriticas !== 1 ? 's' : ''} generada${generadasCriticas !== 1 ? 's' : ''} llevan más de 48h sin movimiento. Escala con la transportadora.`,
      count:    generadasCriticas,
      href:     '/transito?tab=generadas',
    })
  }

  // Prioridades
  if (novedad7d > 0) {
    priorities.push({
      id:       'novedad-7d',
      severity: 'warning',
      title:    `${novedad7d} novedades +7 días`,
      message:  `${novedad7d} novedad${novedad7d !== 1 ? 'es' : ''} con más de 7 días sin resolver.`,
      count:    novedad7d,
      href:     '/novedad',
    })
  }

  if (transitoCritico > 0) {
    priorities.push({
      id:       'transito-critico',
      severity: 'warning',
      title:    `${transitoCritico} tránsito crítico +48h`,
      message:  `${transitoCritico} guía${transitoCritico !== 1 ? 's' : ''} en tránsito real llevan más de 48h sin actualización.`,
      count:    transitoCritico,
      href:     '/transito?tab=transito',
    })
  }

  if (novedadesActivas > 0) {
    priorities.push({
      id:       'novedades-activas',
      severity: 'info',
      title:    `${novedadesActivas} novedades activas`,
      message:  `Total de novedades activas en tu módulo.`,
      count:    novedadesActivas,
      href:     '/novedad',
    })
  }

  if (posIndemn > 0) {
    priorities.push({
      id:       'posibles-indemnizaciones',
      severity: 'warning',
      title:    `${posIndemn} posibles indemnizaciones`,
      message:  `${posIndemn} devolución${posIndemn !== 1 ? 'es' : ''} con 2+ intentos — posibles reclamos de indemnización.`,
      count:    posIndemn,
      href:     '/supervisor-ia#indemnizaciones',
    })
  }

  // Coaching
  if (novedad2Int > 0) {
    coaching.push({
      id:      'coaching-2intentos',
      severity:'info',
      title:   'No reprogrames sin confirmar',
      message: `Tienes ${novedad2Int} novedades con 2 intentos. Antes de reprogramar, confirma disponibilidad del cliente y dirección correcta.`,
    })
  }

  if (novedad14d > 0 || generadasCriticas > 0) {
    coaching.push({
      id:      'coaching-criticos',
      severity:'info',
      title:   'Casos críticos requieren acción hoy',
      message: 'Este grupo puede convertirse en devolución o indemnización si no se atiende hoy. Prioriza estos antes que el resto.',
    })
  }

  if (alerts.length === 0 && priorities.length === 0) {
    coaching.push({
      id:      'coaching-ok',
      severity:'info',
      title:   'Sin casos críticos',
      message: 'Buen trabajo, no tienes casos críticos ahora. Mantén las novedades al día.',
    })
  }

  return { alerts, priorities, coaching }
}

// ── delivery_agent feed ──────────────────────────────────────────────────────

async function buildDeliveryFeed(supabase: Awaited<ReturnType<typeof createClient>>): Promise<Pick<AgentFeedResponse, 'alerts' | 'priorities' | 'coaching'>> {
  const now        = new Date()
  const cutoff24h  = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const cutoff48h  = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
  const todayStart = rdDayStart()

  const repOrFilter24 = `status_since.lt.${cutoff24h},and(status_since.is.null,last_tracking_update.lt.${cutoff24h}),and(status_since.is.null,last_tracking_update.is.null,updated_at.lt.${cutoff24h})`
  const repOrFilter48 = `status_since.lt.${cutoff48h},and(status_since.is.null,last_tracking_update.lt.${cutoff48h}),and(status_since.is.null,last_tracking_update.is.null,updated_at.lt.${cutoff48h})`

  const [
    enRepartoRes,
    critico48hRes,
    critico24hRes,
    entregadosHoyRes,
  ] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('normalized_status', 'en_reparto'),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('normalized_status', 'en_reparto')
      .or(repOrFilter48),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('normalized_status', 'en_reparto')
      .or(repOrFilter24),

    supabase.from('orders').select('id', { count: 'exact', head: true })
      .eq('normalized_status', 'delivered')
      .gte('last_tracking_update', todayStart),
  ])

  const enReparto     = enRepartoRes.count     ?? 0
  const critico48h    = critico48hRes.count     ?? 0
  const critico24h    = Math.max(0, (critico24hRes.count ?? 0) - critico48h)
  const entregadosHoy = entregadosHoyRes.count  ?? 0

  const alerts: AgentAlert[]    = []
  const priorities: AgentAlert[] = []
  const coaching: AgentAlert[]   = []

  // Alertas críticas
  if (critico48h > 0) {
    alerts.push({
      id:       'reparto-critico-48h',
      severity: 'critical',
      title:    `${critico48h} guía${critico48h !== 1 ? 's' : ''} crítica${critico48h !== 1 ? 's' : ''} +48h`,
      message:  `${critico48h} guía${critico48h !== 1 ? 's' : ''} llevan más de 48h en reparto sin actualización. Requieren contacto inmediato.`,
      count:    critico48h,
      href:     '/reparto?filter=critical',
    })
  }

  if (critico24h > 0) {
    alerts.push({
      id:       'reparto-critico-24h',
      severity: 'warning',
      title:    `${critico24h} guía${critico24h !== 1 ? 's' : ''} en riesgo 24–48h`,
      message:  `${critico24h} guía${critico24h !== 1 ? 's' : ''} llevan entre 24 y 48h en reparto.`,
      count:    critico24h,
      href:     '/reparto?filter=risk',
    })
  }

  // Prioridades
  if (enReparto > 0) {
    priorities.push({
      id:       'en-reparto',
      severity: 'info',
      title:    `${enReparto} guía${enReparto !== 1 ? 's' : ''} en reparto`,
      message:  `Total de guías activas en tu módulo de reparto.`,
      count:    enReparto,
      href:     '/reparto',
    })
  }

  if (entregadosHoy > 0) {
    priorities.push({
      id:       'entregados-hoy',
      severity: 'info',
      title:    `${entregadosHoy} entregado${entregadosHoy !== 1 ? 's' : ''} hoy`,
      message:  `El courier confirmó ${entregadosHoy} entrega${entregadosHoy !== 1 ? 's' : ''} hoy.`,
      count:    entregadosHoy,
      href:     '/reparto',
    })
  }

  // Coaching
  if (critico48h > 0) {
    coaching.push({
      id:      'coaching-orden',
      severity:'info',
      title:   'Orden de prioridad',
      message: `Tienes ${enReparto} guías en reparto y ${critico48h} críticas +48h. Llama primero las críticas antes de contactar las recientes.`,
    })
  } else if (critico24h > 0) {
    coaching.push({
      id:      'coaching-riesgo',
      severity:'info',
      title:   'Guías en riesgo',
      message: `${critico24h} guías están entre 24–48h. Atiéndelas antes de que se vuelvan críticas.`,
    })
  } else if (enReparto === 0) {
    coaching.push({
      id:      'coaching-ok',
      severity:'info',
      title:   'Sin guías activas',
      message: 'No tienes guías en reparto actualmente.',
    })
  } else {
    coaching.push({
      id:      'coaching-normal',
      severity:'info',
      title:   'Operación normal',
      message: `Tienes ${enReparto} guías en reparto sin criticidad. Sigue el proceso normal de seguimiento.`,
    })
  }

  return { alerts, priorities, coaching }
}

// ── Handler ──────────────────────────────────────────────────────────────────

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

    const role = profile?.role as string
    if (!AGENT_ROLES.includes(role as AgentRole)) {
      return NextResponse.json({ error: 'Sin permisos' }, { status: 403 })
    }

    const agentRole = role as AgentRole
    let feed: Pick<AgentFeedResponse, 'alerts' | 'priorities' | 'coaching'>

    if (agentRole === 'confirmation_agent') {
      feed = await buildConfirmationFeed(supabase)
    } else if (agentRole === 'novelty_agent') {
      feed = await buildNoveltyFeed(supabase)
    } else {
      feed = await buildDeliveryFeed(supabase)
    }

    const response: AgentFeedResponse = {
      role:        agentRole,
      generatedAt: new Date().toISOString(),
      ...feed,
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error('[agent-feed] error:', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
