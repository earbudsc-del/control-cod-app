'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Brain, RefreshCw, AlertTriangle, CheckCircle2, Package,
  Bike, AlertCircle, Box, ShoppingCart, MapPinOff, ExternalLink,
  ChevronDown, ChevronUp, TrendingUp, Clock, Truck,
  ClipboardList, FileWarning, CircleDollarSign, ArrowRight,
  ShieldAlert, BarChart3, DollarSign, Star, Info,
} from 'lucide-react'

// ─── Tipos ──────────────────────────────────────────────────────────────────

interface Operacion {
  nuevosHoy: number
  confirmadosHoy: number
  carritosRecuperadosHoy: number
  entregadosHoy: number
  novedadesActivas: number
  reparto48h: number
  transito48h: number
  generadas48h: number
  fueraCobertura: number
}

interface Alertas {
  sinConfirmar24h: number
  reparto48h: number
  transito48h: number
  generadas48h: number
  novedad2Intentos: number
  novedad7dias: number
  novedad14dias: number
  guiasAnuladas: number
  posiblesIndemnizables: number
  fueraCobertura: number
  carritosPendientes: number
}

interface ModuloConfirmacion {
  nuevosHoy: number
  confirmadosHoy: number
  inalcanzables: number
  cancelados: number
  sinCobertura: number
  pendientes24h: number
}

interface ModuloNovedad {
  activas: number
  recuperadasHoy: number
  dosIntentos: number
  mas7dias: number
  mas14dias: number
  posiblesIndemnizables: number
}

interface ModuloReparto {
  enReparto: number
  criticos48h: number
  entregadosHoy: number
}

interface ModuloTransito {
  generadas: number
  enTransito: number
  criticas48h: number
  anuladas: number
}

interface ModuloCarritos {
  pendientes: number
  contactadosHoy: number
  recuperadosHoy: number
  recuperadosTotal: number
}

interface IndemnizableItem {
  id: string
  tracking_number: string
  order_number: string | null
  customer_name: string | null
  customer_phone: string | null
  city: string | null
  province: string | null
  delivery_attempts: number
  last_attempt_reason: string | null
  raw_status: string | null
  normalized_status: string
  cod_amount: number | null
}

interface Novedad2Item {
  id: string
  tracking_number: string
  customer_name: string | null
  city: string | null
  province: string | null
  delivery_attempts: number
  last_attempt_reason: string | null
  customer_phone: string | null
  cod_amount: number | null
}

interface MetricsData {
  generatedAt: string
  operacion: Operacion
  alertas: Alertas
  modulos: {
    confirmacion: ModuloConfirmacion
    novedad: ModuloNovedad
    reparto: ModuloReparto
    transito: ModuloTransito
    carritos: ModuloCarritos
  }
  indemnizables: IndemnizableItem[]
  novedad2IntentosLista: Novedad2Item[]
}

// ─── Tipos Fase 2 ────────────────────────────────────────────────────────────

interface CasoAuditoria {
  id: string
  tracking_number: string
  order_number: string | null
  customer_name: string | null
  city: string | null
  province: string | null
  delivery_attempts: number
  last_attempt_reason: string | null
  raw_status: string | null
  normalized_status: string
  status_since: string | null
  cod_amount: number | null
  score: number
  level: string
  signals: string[]
}

interface CourierMetrics {
  totalProcesados: number
  entregados: number
  devueltos: number
  novedades: number
  retrasos72h: number
  intentosSospechosos: number
  coberturaDudosa: number
  anuladasSospechosas: number
  tasaEntrega: number
  tasaDevolucion: number
  tasaRetraso72h: number
  tasaNovedades: number
}

interface AgentesMetrics {
  confirmation: {
    confirmadosHoy: number
    inalcanzablesTotal: number
    canceladosTotal: number
    pendientesEnCola: number
    fueraCobertura: number
  }
  novedad: {
    novedadesActivas: number
    recuperadasHoy: number
    dosIntentosActivos: number
    masViejas14dias: number
    indemnizacionesDetectadas: number
  }
  delivery: {
    enRepartoTotal: number
    entregadosHoy: number
    repartoCritico48h: number
    claimsRegistrados: number
  }
}

interface DineroRiesgo {
  devolucionesIndemnizables: number
  pedidosEnRiesgoNovedad: number
  repartoRetraso72h: number
  totalEnRiesgo: number
}

interface AuditoriaData {
  generatedAt: string
  casosAuditoria: CasoAuditoria[]
  courier: CourierMetrics
  agentes: AgentesMetrics
  dineroRiesgo: DineroRiesgo
}

// ─── Motor de recomendaciones ────────────────────────────────────────────────

type RecomPriority = 'crítica' | 'alta' | 'media' | 'baja'

interface Recomendacion {
  id: string
  prioridad: RecomPriority
  modulo: string
  cantidad: number
  mensaje: string
  accion: string
  link: string
}

function pl(n: number, singular: string, plural: string) {
  return n === 1 ? singular : plural
}

function generarRecomendaciones(m: MetricsData): Recomendacion[] {
  const recom: Recomendacion[] = []

  if (m.operacion.reparto48h > 0) {
    recom.push({
      id: 'reparto-48h',
      prioridad: 'crítica',
      modulo: 'Reparto',
      cantidad: m.operacion.reparto48h,
      mensaje: `Hay ${m.operacion.reparto48h} ${pl(m.operacion.reparto48h, 'guía', 'guías')} en reparto +48h. Escalar con transportadora.`,
      accion: 'Ver reparto crítico',
      link: '/reparto?filter=critical',
    })
  }

  if (m.operacion.generadas48h > 0) {
    recom.push({
      id: 'generadas-48h',
      prioridad: 'crítica',
      modulo: 'Tránsito · Generadas',
      cantidad: m.operacion.generadas48h,
      mensaje: `Hay ${m.operacion.generadas48h} ${pl(m.operacion.generadas48h, 'guía generada', 'guías generadas')} +48h. Verificar recogida/despacho.`,
      accion: 'Ver generadas críticas',
      link: '/transito?tab=generadas',
    })
  }

  if (m.operacion.transito48h > 0) {
    recom.push({
      id: 'transito-48h',
      prioridad: 'crítica',
      modulo: 'Tránsito',
      cantidad: m.operacion.transito48h,
      mensaje: `Hay ${m.operacion.transito48h} ${pl(m.operacion.transito48h, 'guía', 'guías')} en tránsito +48h. Posible novedad sin registrar.`,
      accion: 'Ver tránsito crítico',
      link: '/transito?tab=transito',
    })
  }

  if (m.alertas.novedad14dias > 0) {
    recom.push({
      id: 'novedad-14dias',
      prioridad: 'alta',
      modulo: 'Novedad',
      cantidad: m.alertas.novedad14dias,
      mensaje: `Hay ${m.alertas.novedad14dias} ${pl(m.alertas.novedad14dias, 'novedad', 'novedades')} con +14 días. Evaluar cierre o reclamar indemnización.`,
      accion: 'Ver novedades +14 días',
      link: '/novedad',
    })
  }

  if (m.alertas.novedad2Intentos > 0) {
    recom.push({
      id: 'novedad-2-intentos',
      prioridad: 'alta',
      modulo: 'Novedad',
      cantidad: m.alertas.novedad2Intentos,
      mensaje: `Hay ${m.alertas.novedad2Intentos} ${pl(m.alertas.novedad2Intentos, 'novedad', 'novedades')} con 2 intentos. No reprogramar sin confirmar cliente.`,
      accion: 'Ver 2 intentos',
      link: '/novedad?filter=2-intentos',
    })
  }

  if (m.alertas.sinConfirmar24h > 0) {
    recom.push({
      id: 'sin-confirmar-24h',
      prioridad: 'alta',
      modulo: 'Confirmación',
      cantidad: m.alertas.sinConfirmar24h,
      mensaje: `Hay ${m.alertas.sinConfirmar24h} ${pl(m.alertas.sinConfirmar24h, 'pedido', 'pedidos')} sin confirmar +24h. Asignar agente de confirmación.`,
      accion: 'Ir a confirmación',
      link: '/confirmacion',
    })
  }

  if (m.alertas.novedad7dias > 0) {
    recom.push({
      id: 'novedad-7dias',
      prioridad: 'media',
      modulo: 'Novedad',
      cantidad: m.alertas.novedad7dias,
      mensaje: `Hay ${m.alertas.novedad7dias} ${pl(m.alertas.novedad7dias, 'novedad', 'novedades')} con +7 días sin resolver.`,
      accion: 'Ver novedades',
      link: '/novedad',
    })
  }

  if (m.alertas.carritosPendientes > 0) {
    recom.push({
      id: 'carritos-pendientes',
      prioridad: 'media',
      modulo: 'Carritos abandonados',
      cantidad: m.alertas.carritosPendientes,
      mensaje: `Hay ${m.alertas.carritosPendientes} ${pl(m.alertas.carritosPendientes, 'carrito', 'carritos')} abandonado${m.alertas.carritosPendientes === 1 ? '' : 's'} pendiente${m.alertas.carritosPendientes === 1 ? '' : 's'}. Asignar agente de confirmación.`,
      accion: 'Ver carritos pendientes',
      link: '/carritos-abandonados?status=pending',
    })
  }

  if (m.operacion.fueraCobertura > 0) {
    recom.push({
      id: 'fuera-cobertura',
      prioridad: 'baja',
      modulo: 'Confirmación',
      cantidad: m.operacion.fueraCobertura,
      mensaje: `Hay ${m.operacion.fueraCobertura} ${pl(m.operacion.fueraCobertura, 'pedido', 'pedidos')} fuera de cobertura. Revisar antes de confirmar.`,
      accion: 'Ver sin cobertura',
      link: '/confirmacion',
    })
  }

  const PRIO: Record<RecomPriority, number> = { 'crítica': 0, 'alta': 1, 'media': 2, 'baja': 3 }
  return recom.sort((a, b) => PRIO[a.prioridad] - PRIO[b.prioridad])
}

function generarReporte(m: MetricsData): { resumen: string; prioridades: string[] } {
  const activas: string[] = []
  const alertas: string[] = []
  const prioridades: string[] = []

  if (m.operacion.nuevosHoy > 0)               activas.push(`${m.operacion.nuevosHoy} pedidos nuevos`)
  if (m.operacion.confirmadosHoy > 0)           activas.push(`${m.operacion.confirmadosHoy} confirmados`)
  if (m.operacion.entregadosHoy > 0)            activas.push(`${m.operacion.entregadosHoy} entregados`)
  if (m.operacion.carritosRecuperadosHoy > 0)   activas.push(`${m.operacion.carritosRecuperadosHoy} carritos recuperados`)

  if (m.operacion.reparto48h > 0)               alertas.push(`${m.operacion.reparto48h} en reparto +48h`)
  if (m.operacion.transito48h > 0)              alertas.push(`${m.operacion.transito48h} en tránsito +48h`)
  if (m.operacion.generadas48h > 0)             alertas.push(`${m.operacion.generadas48h} generadas +48h`)
  if (m.alertas.novedad14dias > 0)              alertas.push(`${m.alertas.novedad14dias} novedades +14 días`)
  if (m.alertas.novedad2Intentos > 0)           alertas.push(`${m.alertas.novedad2Intentos} novedades con 2 intentos`)
  if (m.alertas.sinConfirmar24h > 0)            alertas.push(`${m.alertas.sinConfirmar24h} pedidos sin confirmar +24h`)
  if (m.operacion.novedadesActivas > 0)         alertas.push(`${m.operacion.novedadesActivas} novedades activas`)

  // Prioridades ordenadas por urgencia
  if (m.operacion.reparto48h > 0 || m.operacion.generadas48h > 0)
    prioridades.push(`Crítico: resolver ${m.operacion.reparto48h + m.operacion.generadas48h} guías +48h (reparto/generadas)`)
  if (m.operacion.transito48h > 0)
    prioridades.push(`Crítico: escalar ${m.operacion.transito48h} tránsitos +48h con transportadora`)
  if (m.alertas.novedad2Intentos > 0)
    prioridades.push(`Acción: verificar ${m.alertas.novedad2Intentos} novedades con 2 intentos antes de reprogramar`)
  if (m.alertas.sinConfirmar24h > 0)
    prioridades.push(`Acción: confirmar ${m.alertas.sinConfirmar24h} pedidos pendientes +24h`)
  if (m.alertas.carritosPendientes > 0)
    prioridades.push(`Recovery: asignar recuperación de ${m.alertas.carritosPendientes} carritos abandonados`)

  let resumen = ''
  if (activas.length > 0) resumen += `Hoy: ${activas.join(', ')}. `
  if (alertas.length > 0) resumen += `Alertas: ${alertas.join(', ')}.`
  if (!resumen) resumen = 'Sin alertas críticas. Operación del día bajo control.'

  return { resumen: resumen.trim(), prioridades }
}

function getIndemnRecomendacion(order: IndemnizableItem): string {
  if (order.delivery_attempts >= 3) return 'Reclamar por múltiples intentos fallidos sin entrega'
  const reason = (order.last_attempt_reason ?? '').toLowerCase()
  if (reason.includes('cobertura') || reason.includes('zona')) return 'Reclamar — área en cobertura pero no entregado'
  if (reason.includes('rechaz')) return 'Verificar — posible rechazo sin contacto previo al cliente'
  if (reason.includes('direcci') || reason.includes('domicil')) return 'Verificar dirección y reclamar si fue correcta'
  return 'Revisar historial y evaluar reclamo de indemnización'
}

function getIndemnPriority(order: IndemnizableItem): { label: string; color: string } {
  if (order.delivery_attempts >= 3) return { label: 'Alta', color: 'bg-red-100 text-red-700' }
  const reason = (order.last_attempt_reason ?? '').toLowerCase()
  if (reason.includes('cobertura') || reason.includes('zona')) return { label: 'Alta', color: 'bg-red-100 text-red-700' }
  return { label: 'Media', color: 'bg-orange-100 text-orange-700' }
}

// ─── Helpers Fase 2 ──────────────────────────────────────────────────────────

const RISK_LEVEL_STYLE: Record<string, string> = {
  Crítico: 'bg-red-100 text-red-700 border-red-200',
  Alto:    'bg-orange-100 text-orange-700 border-orange-200',
  Medio:   'bg-amber-100 text-amber-700 border-amber-200',
  Bajo:    'bg-green-100 text-green-700 border-green-200',
}

const RISK_ROW_BG: Record<string, string> = {
  Crítico: 'bg-red-50',
  Alto:    'bg-orange-50',
  Medio:   'bg-amber-50/40',
  Bajo:    '',
}

const SIGNAL_COLOR: Record<string, string> = {
  'Posible intento falso':               'bg-red-100 text-red-700',
  'Riesgo alto devolución injusta':      'bg-red-100 text-red-700',
  'Caso potencialmente indemnizable':    'bg-orange-100 text-orange-700',
  'Courier posiblemente falló':          'bg-orange-100 text-orange-700',
  'Cliente probablemente sí quería recibir': 'bg-blue-100 text-blue-700',
  'Fuera cobertura dudoso':              'bg-purple-100 text-purple-700',
  'Retraso excesivo':                    'bg-amber-100 text-amber-700',
  'Reprogramación sospechosa':           'bg-amber-100 text-amber-700',
}

function fmtDOP(n: number): string {
  return new Intl.NumberFormat('es-DO', {
    style: 'currency', currency: 'DOP', minimumFractionDigits: 0,
  }).format(n)
}

function getStatusLabel(normalized: string): string {
  const map: Record<string, string> = {
    novedad:    'Novedad',
    returned:   'Devuelto',
    en_reparto: 'En reparto',
    in_transit: 'En tránsito',
    delivered:  'Entregado',
    pending:    'Pendiente',
  }
  return map[normalized] ?? normalized
}

function getStatusBadge(normalized: string): string {
  const map: Record<string, string> = {
    novedad:    'bg-amber-100 text-amber-700',
    returned:   'bg-red-100 text-red-700',
    en_reparto: 'bg-blue-100 text-blue-700',
    in_transit: 'bg-sky-100 text-sky-700',
    delivered:  'bg-green-100 text-green-700',
  }
  return map[normalized] ?? 'bg-gray-100 text-gray-600'
}

// Genera recomendaciones mejoradas con señales de auditoría
function generarRecomendacionesV2(m: MetricsData, auditoria: AuditoriaData | null): Recomendacion[] {
  const recom: Recomendacion[] = []

  // ── Críticas ──
  if (m.operacion.reparto48h > 0) {
    recom.push({
      id: 'reparto-48h',
      prioridad: 'crítica',
      modulo: 'Reparto',
      cantidad: m.operacion.reparto48h,
      mensaje: `${m.operacion.reparto48h} ${pl(m.operacion.reparto48h, 'guía', 'guías')} en reparto +48h. Los retrasos prolongados elevan el riesgo de devolución injustificada.`,
      accion: 'Ver reparto crítico →',
      link: '/reparto?filter=critical',
    })
  }

  if (m.operacion.generadas48h > 0) {
    recom.push({
      id: 'generadas-48h',
      prioridad: 'crítica',
      modulo: 'Tránsito · Generadas',
      cantidad: m.operacion.generadas48h,
      mensaje: `${m.operacion.generadas48h} ${pl(m.operacion.generadas48h, 'guía generada', 'guías generadas')} +48h sin recogida. Posible bloqueo operativo o candidata a anulación.`,
      accion: 'Ver generadas críticas →',
      link: '/transito?tab=generadas',
    })
  }

  if (m.operacion.transito48h > 0) {
    recom.push({
      id: 'transito-48h',
      prioridad: 'crítica',
      modulo: 'Tránsito',
      cantidad: m.operacion.transito48h,
      mensaje: `${m.operacion.transito48h} ${pl(m.operacion.transito48h, 'guía', 'guías')} en tránsito +48h. Posible novedad sin registrar por el courier.`,
      accion: 'Ver tránsito crítico →',
      link: '/transito?tab=transito',
    })
  }

  // ── Señales de auditoría ──
  if (auditoria) {
    const criticos = auditoria.casosAuditoria.filter(c => c.level === 'Crítico').length
    const altos    = auditoria.casosAuditoria.filter(c => c.level === 'Alto').length

    if (criticos > 0) {
      recom.push({
        id: 'auditoria-criticos',
        prioridad: 'crítica',
        modulo: 'Auditoría IA',
        cantidad: criticos,
        mensaje: `Hay ${criticos} ${pl(criticos, 'caso', 'casos')} con score Crítico de mala gestión. Evaluar reclamo de indemnización a courier.`,
        accion: 'Ver auditoría →',
        link: '#auditoria',
      })
    }

    if (auditoria.courier.tasaDevolucion > 15) {
      recom.push({
        id: 'tasa-devolucion',
        prioridad: 'crítica',
        modulo: 'Courier',
        cantidad: auditoria.courier.devueltos,
        mensaje: `Tasa de devolución en ${auditoria.courier.tasaDevolucion}% (${auditoria.courier.devueltos} pedidos). Patrón de devoluciones elevado — revisar gestión courier.`,
        accion: 'Ver indemnizaciones →',
        link: '#indemnizaciones',
      })
    }

    if (altos > 0 && criticos === 0) {
      recom.push({
        id: 'auditoria-altos',
        prioridad: 'alta',
        modulo: 'Auditoría IA',
        cantidad: altos,
        mensaje: `Hay ${altos} ${pl(altos, 'caso', 'casos')} con score Alto de riesgo operacional. Verificar antes de reprogramar.`,
        accion: 'Ver auditoría →',
        link: '#auditoria',
      })
    }

    if (auditoria.courier.retrasos72h > 0) {
      recom.push({
        id: 'retrasos-72h',
        prioridad: 'alta',
        modulo: 'Courier',
        cantidad: auditoria.courier.retrasos72h,
        mensaje: `Los retrasos +72h están elevando riesgo de devolución. ${auditoria.courier.retrasos72h} ${pl(auditoria.courier.retrasos72h, 'caso', 'casos')} en reparto con demora crítica.`,
        accion: 'Ver reparto →',
        link: '/reparto?filter=critical',
      })
    }

    if (auditoria.courier.coberturaDudosa > 0) {
      recom.push({
        id: 'cobertura-dudosa',
        prioridad: 'alta',
        modulo: 'Confirmación',
        cantidad: auditoria.courier.coberturaDudosa,
        mensaje: `Existen ${auditoria.courier.coberturaDudosa} ${pl(auditoria.courier.coberturaDudosa, 'caso', 'casos')} fuera de cobertura posiblemente incorrectos. Verificar zonas.`,
        accion: 'Revisar cobertura →',
        link: '/confirmacion',
      })
    }
  }

  // ── Altas ──
  if (m.alertas.novedad14dias > 0) {
    recom.push({
      id: 'novedad-14dias',
      prioridad: 'alta',
      modulo: 'Novedad',
      cantidad: m.alertas.novedad14dias,
      mensaje: `${m.alertas.novedad14dias} ${pl(m.alertas.novedad14dias, 'novedad', 'novedades')} con +14 días sin resolver. Las guías con 3+ intentos mal documentados pueden reclamar indemnización.`,
      accion: 'Ver novedades +14 días →',
      link: '/novedad',
    })
  }

  if (m.alertas.novedad2Intentos > 0) {
    recom.push({
      id: 'novedad-2-intentos',
      prioridad: 'alta',
      modulo: 'Novedad',
      cantidad: m.alertas.novedad2Intentos,
      mensaje: `${m.alertas.novedad2Intentos} ${pl(m.alertas.novedad2Intentos, 'novedad', 'novedades')} con 2 intentos. No reprogramar sin confirmar disponibilidad del cliente — algunos intentos pueden ser falsos.`,
      accion: 'Ver 2 intentos →',
      link: '/novedad?filter=2-intentos',
    })
  }

  if (m.alertas.sinConfirmar24h > 0) {
    recom.push({
      id: 'sin-confirmar-24h',
      prioridad: 'alta',
      modulo: 'Confirmación',
      cantidad: m.alertas.sinConfirmar24h,
      mensaje: `${m.alertas.sinConfirmar24h} ${pl(m.alertas.sinConfirmar24h, 'pedido', 'pedidos')} sin confirmar +24h. Asignar agente de confirmación.`,
      accion: 'Ir a confirmación →',
      link: '/confirmacion',
    })
  }

  // ── Medias ──
  if (m.alertas.novedad7dias > 0) {
    recom.push({
      id: 'novedad-7dias',
      prioridad: 'media',
      modulo: 'Novedad',
      cantidad: m.alertas.novedad7dias,
      mensaje: `${m.alertas.novedad7dias} ${pl(m.alertas.novedad7dias, 'novedad', 'novedades')} con +7 días sin resolver.`,
      accion: 'Ver novedades →',
      link: '/novedad',
    })
  }

  if (m.alertas.carritosPendientes > 0) {
    recom.push({
      id: 'carritos-pendientes',
      prioridad: 'media',
      modulo: 'Carritos abandonados',
      cantidad: m.alertas.carritosPendientes,
      mensaje: `${m.alertas.carritosPendientes} ${pl(m.alertas.carritosPendientes, 'carrito', 'carritos')} abandonado${m.alertas.carritosPendientes === 1 ? '' : 's'} pendiente${m.alertas.carritosPendientes === 1 ? '' : 's'}. Asignar agente de confirmación.`,
      accion: 'Ver carritos pendientes →',
      link: '/carritos-abandonados?status=pending',
    })
  }

  // ── Bajas ──
  if (m.operacion.fueraCobertura > 0) {
    recom.push({
      id: 'fuera-cobertura',
      prioridad: 'baja',
      modulo: 'Confirmación',
      cantidad: m.operacion.fueraCobertura,
      mensaje: `${m.operacion.fueraCobertura} ${pl(m.operacion.fueraCobertura, 'pedido', 'pedidos')} fuera de cobertura. Revisar antes de confirmar — algunas zonas pueden estar cubiertas.`,
      accion: 'Ver sin cobertura →',
      link: '/confirmacion',
    })
  }

  const PRIO_ORDER: Record<RecomPriority, number> = { 'crítica': 0, 'alta': 1, 'media': 2, 'baja': 3 }
  return recom.sort((a, b) => PRIO_ORDER[a.prioridad] - PRIO_ORDER[b.prioridad])
}

// ─── Helpers de color ────────────────────────────────────────────────────────

const PRIO_STYLE: Record<RecomPriority, string> = {
  'crítica': 'bg-red-50 border-red-200 text-red-800',
  'alta':    'bg-orange-50 border-orange-200 text-orange-800',
  'media':   'bg-amber-50 border-amber-200 text-amber-800',
  'baja':    'bg-gray-50 border-gray-200 text-gray-700',
}

const PRIO_BADGE: Record<RecomPriority, string> = {
  'crítica': 'bg-red-100 text-red-700',
  'alta':    'bg-orange-100 text-orange-700',
  'media':   'bg-amber-100 text-amber-700',
  'baja':    'bg-gray-100 text-gray-600',
}

const PRIO_BTN: Record<RecomPriority, string> = {
  'crítica': 'bg-red-700 hover:bg-red-800 text-white',
  'alta':    'bg-orange-600 hover:bg-orange-700 text-white',
  'media':   'bg-amber-600 hover:bg-amber-700 text-white',
  'baja':    'bg-gray-600 hover:bg-gray-700 text-white',
}

// ─── Componentes helper ──────────────────────────────────────────────────────

function ClickableKpiCard({
  label, value, sub, color = 'gray', critical = false, href,
}: {
  label: string
  value: number
  sub?: string
  color?: 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'orange' | 'teal'
  critical?: boolean
  href: string
}) {
  const colorMap: Record<string, string> = {
    gray:   'bg-white border-gray-200 hover:border-gray-300',
    green:  'bg-green-50 border-green-200 hover:border-green-300',
    red:    'bg-red-50 border-red-200 hover:border-red-300',
    amber:  'bg-amber-50 border-amber-200 hover:border-amber-300',
    blue:   'bg-blue-50 border-blue-200 hover:border-blue-300',
    orange: 'bg-orange-50 border-orange-200 hover:border-orange-300',
    teal:   'bg-teal-50 border-teal-200 hover:border-teal-300',
  }
  const numColorMap: Record<string, string> = {
    gray:   'text-gray-800',
    green:  'text-green-700',
    red:    'text-red-700',
    amber:  'text-amber-700',
    blue:   'text-blue-700',
    orange: 'text-orange-700',
    teal:   'text-teal-700',
  }
  return (
    <Link
      href={href}
      className={`block rounded-lg border p-3 transition-all ${colorMap[color]} ${critical && value > 0 ? 'ring-2 ring-red-300' : ''}`}
    >
      <p className="text-xs text-gray-500 font-medium leading-tight mb-1">{label}</p>
      <p className={`text-2xl font-bold ${numColorMap[color]}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      <p className="text-[10px] text-gray-400 mt-1 flex items-center gap-0.5">
        Ver módulo <ArrowRight className="w-2.5 h-2.5" />
      </p>
    </Link>
  )
}

function AlertaRow({ label, count, link, prioridad, actionLabel }: {
  label: string
  count: number
  link: string
  prioridad: RecomPriority
  actionLabel?: string
}) {
  if (count === 0) return null
  return (
    <div className={`flex items-center justify-between px-4 py-2.5 rounded-lg border text-sm ${PRIO_STYLE[prioridad]}`}>
      <span className="font-medium flex-1 mr-3">{label}</span>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${PRIO_BADGE[prioridad]}`}>{count}</span>
        <Link
          href={link}
          className={`text-xs font-semibold px-2.5 py-1 rounded-md transition-colors ${PRIO_BTN[prioridad]}`}
        >
          {actionLabel ?? 'Ir al módulo'}
        </Link>
      </div>
    </div>
  )
}

function ModuleCard({
  title, icon: Icon, color, rows, link,
}: {
  title: string
  icon: React.ElementType
  color: string
  rows: Array<{ label: string; value: number; highlight?: boolean }>
  link: string
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className={`px-4 py-3 flex items-center gap-2 ${color}`}>
        <Icon className="w-4 h-4" />
        <span className="font-semibold text-sm">{title}</span>
        <Link href={link} className="ml-auto flex items-center gap-1 text-xs opacity-70 hover:opacity-100 font-medium">
          Ir al módulo <ExternalLink className="w-3 h-3" />
        </Link>
      </div>
      <div className="divide-y divide-gray-100">
        {rows.map(row => (
          <div key={row.label} className={`flex items-center justify-between px-4 py-2 text-sm ${row.highlight && row.value > 0 ? 'bg-red-50' : ''}`}>
            <span className="text-gray-600">{row.label}</span>
            <span className={`font-semibold ${row.highlight && row.value > 0 ? 'text-red-700' : 'text-gray-800'}`}>
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Página principal ────────────────────────────────────────────────────────

export default function SupervisorIAPage() {
  const [data, setData]                       = useState<MetricsData | null>(null)
  const [loading, setLoading]                 = useState(true)
  const [error, setError]                     = useState<string | null>(null)
  const [showIndemn, setShowIndemn]           = useState(false)
  const [auditoriaData, setAuditoriaData]     = useState<AuditoriaData | null>(null)
  const [auditoriaLoading, setAuditoriaLoading] = useState(true)
  const [showAuditoria, setShowAuditoria]     = useState(false)
  const [auditFiltroNivel, setAuditFiltroNivel] = useState<string>('all')

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch('/api/supervisor-ia/metrics')
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error ?? 'Error al cargar métricas')
      }
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar datos del Supervisor IA')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchAuditoria = useCallback(async () => {
    try {
      setAuditoriaLoading(true)
      const res = await fetch('/api/supervisor-ia/auditoria')
      if (!res.ok) return
      const json = await res.json()
      setAuditoriaData(json)
    } catch {
      // Auditoría es secundaria — no bloquea el dashboard principal
    } finally {
      setAuditoriaLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    fetchAuditoria()
    const interval = setInterval(() => {
      fetchData()
      fetchAuditoria()
    }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData, fetchAuditoria])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-3" />
          <p className="text-gray-500 text-sm">Cargando Supervisor IA…</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-3" />
          <p className="text-gray-700 font-medium mb-1">Error al cargar</p>
          <p className="text-gray-500 text-sm mb-4">{error}</p>
          <button
            onClick={fetchData}
            className="text-sm text-indigo-600 hover:underline font-medium"
          >
            Reintentar
          </button>
        </div>
      </div>
    )
  }

  if (!data) return null

  const recomendaciones = generarRecomendacionesV2(data, auditoriaData)
  const { resumen, prioridades } = generarReporte(data)
  const criticasCount   = recomendaciones.filter(r => r.prioridad === 'crítica').length
  const casosAuditFiltrados = auditoriaData
    ? (auditFiltroNivel === 'all'
        ? auditoriaData.casosAuditoria
        : auditoriaData.casosAuditoria.filter(c => c.level === auditFiltroNivel))
    : []

  const lastUpdated = new Intl.DateTimeFormat('es-DO', {
    timeZone: 'America/Santo_Domingo',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(data.generatedAt))

  return (
    <div className="space-y-6 pb-8">

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 bg-indigo-600 rounded-xl shrink-0">
            <Brain className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Supervisor IA</h1>
            <p className="text-sm text-gray-500">Dashboard operativo · Actualizado {lastUpdated}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {criticasCount > 0 && (
            <span className="text-xs font-bold bg-red-100 text-red-700 px-3 py-1 rounded-full animate-pulse">
              {criticasCount} alerta{criticasCount > 1 ? 's' : ''} crítica{criticasCount > 1 ? 's' : ''}
            </span>
          )}
          <button
            onClick={() => { fetchData(); fetchAuditoria() }}
            disabled={loading}
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-indigo-600 border border-gray-200 rounded-lg px-3 py-1.5 hover:border-indigo-300 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        </div>
      </div>

      {/* ── Operación del día (cards clickeables) ───────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Operación del día</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <ClickableKpiCard label="Nuevos hoy"           value={data.operacion.nuevosHoy}              color="blue"   href="/confirmacion" />
          <ClickableKpiCard label="Confirmados hoy"       value={data.operacion.confirmadosHoy}         color="green"  href="/confirmados" />
          <ClickableKpiCard label="Entregados hoy"        value={data.operacion.entregadosHoy}          color="green"  href="/reparto" />
          <ClickableKpiCard label="Carritos recuperados"  value={data.operacion.carritosRecuperadosHoy} color="teal"   sub="hoy" href="/carritos-abandonados?status=recovered" />
          <ClickableKpiCard label="Novedades activas"     value={data.operacion.novedadesActivas}       color={data.operacion.novedadesActivas > 0 ? 'amber' : 'gray'} href="/novedad" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mt-3">
          <ClickableKpiCard label="Reparto crítico +48h"    value={data.operacion.reparto48h}    color={data.operacion.reparto48h > 0 ? 'red' : 'gray'}    critical href="/reparto?filter=critical" />
          <ClickableKpiCard label="Tránsito crítico +48h"   value={data.operacion.transito48h}   color={data.operacion.transito48h > 0 ? 'red' : 'gray'}   critical href="/transito?tab=transito" />
          <ClickableKpiCard label="Generadas críticas +48h" value={data.operacion.generadas48h}  color={data.operacion.generadas48h > 0 ? 'red' : 'gray'}  critical href="/transito?tab=generadas" />
          <ClickableKpiCard label="Fuera de cobertura"      value={data.operacion.fueraCobertura} color={data.operacion.fueraCobertura > 0 ? 'orange' : 'gray'} href="/confirmacion" />
        </div>
      </section>

      {/* ── Alertas críticas ────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Alertas críticas</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <AlertaRow label="Pedidos sin confirmar +24h"    count={data.alertas.sinConfirmar24h}       link="/confirmacion"                    prioridad="crítica" actionLabel="Ver casos" />
          <AlertaRow label="Reparto +48h"                  count={data.alertas.reparto48h}            link="/reparto?filter=critical"          prioridad="crítica" actionLabel="Ver casos" />
          <AlertaRow label="Tránsito +48h"                 count={data.alertas.transito48h}           link="/transito?tab=transito"            prioridad="crítica" actionLabel="Ver casos" />
          <AlertaRow label="Generadas +48h"                count={data.alertas.generadas48h}          link="/transito?tab=generadas"           prioridad="crítica" actionLabel="Ver casos" />
          <AlertaRow label="Novedades con 2 intentos"      count={data.alertas.novedad2Intentos}      link="/novedad?filter=2-intentos"        prioridad="alta"    actionLabel="Resolver" />
          <AlertaRow label="Novedades +14 días"            count={data.alertas.novedad14dias}         link="/novedad"                          prioridad="alta"    actionLabel="Ver casos" />
          <AlertaRow label="Novedades +7 días"             count={data.alertas.novedad7dias}          link="/novedad"                          prioridad="media"   actionLabel="Ver casos" />
          <AlertaRow label="Guías anuladas/canceladas"     count={data.alertas.guiasAnuladas}         link="/transito?tab=anuladas"            prioridad="media"   actionLabel="Ver anuladas" />
          <AlertaRow label="Posibles indemnizaciones"      count={data.alertas.posiblesIndemnizables} link="#indemnizaciones"                  prioridad="media"   actionLabel="Ver casos" />
          <AlertaRow label="Pedidos fuera de cobertura"    count={data.alertas.fueraCobertura}        link="/confirmacion"                     prioridad="baja"    actionLabel="Ir al módulo" />
          <AlertaRow label="Carritos abandonados pendientes" count={data.alertas.carritosPendientes}  link="/carritos-abandonados?status=pending" prioridad="media" actionLabel="Recuperar" />
        </div>
        {Object.values(data.alertas).every(v => v === 0) && (
          <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            Sin alertas críticas activas. Operación bajo control.
          </div>
        )}
      </section>

      {/* ── Reporte del día ─────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Reporte del día</h2>
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl px-5 py-4 space-y-3">
          <p className="text-sm text-indigo-900 leading-relaxed font-medium">{resumen}</p>
          {prioridades.length > 0 && (
            <div className="border-t border-indigo-200 pt-3 space-y-1.5">
              <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide mb-2">Prioridades del día</p>
              {prioridades.map((p, i) => (
                <div key={i} className="flex items-start gap-2 text-sm text-indigo-900">
                  <span className="flex-shrink-0 w-5 h-5 bg-indigo-200 text-indigo-800 rounded-full text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                  <span>{p}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Recomendaciones operativas ──────────────────────────── */}
      {recomendaciones.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Recomendaciones operativas</h2>
          <div className="space-y-2">
            {recomendaciones.map(r => (
              <div key={r.id} className={`rounded-xl border px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 ${PRIO_STYLE[r.prioridad]}`}>
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full uppercase tracking-wide ${PRIO_BADGE[r.prioridad]}`}>
                      {r.prioridad}
                    </span>
                    <span className="text-xs text-gray-500 font-medium">{r.modulo}</span>
                    <span className="text-xs font-bold text-gray-700">
                      {r.cantidad} afectado{r.cantidad > 1 ? 's' : ''}
                    </span>
                  </div>
                  <p className="text-sm font-medium">{r.mensaje}</p>
                </div>
                <Link
                  href={r.link}
                  className={`shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${PRIO_BTN[r.prioridad]}`}
                >
                  {r.accion} →
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Rendimiento por módulo ──────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Rendimiento por módulo</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">

          <ModuleCard
            title="Confirmación"
            icon={ClipboardList}
            color="bg-indigo-50 text-indigo-800 border-b border-indigo-100"
            link="/confirmacion"
            rows={[
              { label: 'Nuevos hoy',        value: data.modulos.confirmacion.nuevosHoy },
              { label: 'Confirmados hoy',   value: data.modulos.confirmacion.confirmadosHoy },
              { label: 'Inalcanzables',     value: data.modulos.confirmacion.inalcanzables },
              { label: 'Cancelados',        value: data.modulos.confirmacion.cancelados },
              { label: 'Sin cobertura',     value: data.modulos.confirmacion.sinCobertura },
              { label: 'Pendientes +24h',   value: data.modulos.confirmacion.pendientes24h, highlight: true },
            ]}
          />

          <ModuleCard
            title="Novedad"
            icon={AlertCircle}
            color="bg-red-50 text-red-800 border-b border-red-100"
            link="/novedad"
            rows={[
              { label: 'Activas',                value: data.modulos.novedad.activas },
              { label: 'Recuperadas hoy',        value: data.modulos.novedad.recuperadasHoy },
              { label: 'Con 2 intentos',         value: data.modulos.novedad.dosIntentos, highlight: true },
              { label: '+7 días',                value: data.modulos.novedad.mas7dias,    highlight: true },
              { label: '+14 días',               value: data.modulos.novedad.mas14dias,   highlight: true },
              { label: 'Posibles indemnizables', value: data.modulos.novedad.posiblesIndemnizables },
            ]}
          />

          <ModuleCard
            title="Reparto"
            icon={Bike}
            color="bg-amber-50 text-amber-800 border-b border-amber-100"
            link="/reparto"
            rows={[
              { label: 'En reparto',      value: data.modulos.reparto.enReparto },
              { label: 'Críticos +48h',   value: data.modulos.reparto.criticos48h,   highlight: true },
              { label: 'Entregados hoy',  value: data.modulos.reparto.entregadosHoy },
            ]}
          />

          <ModuleCard
            title="Tránsito"
            icon={Box}
            color="bg-blue-50 text-blue-800 border-b border-blue-100"
            link="/transito"
            rows={[
              { label: 'Generadas',      value: data.modulos.transito.generadas },
              { label: 'En tránsito',    value: data.modulos.transito.enTransito },
              { label: 'Críticas +48h',  value: data.modulos.transito.criticas48h, highlight: true },
              { label: 'Anuladas',       value: data.modulos.transito.anuladas },
            ]}
          />

          <ModuleCard
            title="Carritos abandonados"
            icon={ShoppingCart}
            color="bg-teal-50 text-teal-800 border-b border-teal-100"
            link="/carritos-abandonados"
            rows={[
              { label: 'Pendientes',        value: data.modulos.carritos.pendientes,       highlight: true },
              { label: 'Contactados hoy',   value: data.modulos.carritos.contactadosHoy },
              { label: 'Recuperados hoy',   value: data.modulos.carritos.recuperadosHoy },
              { label: 'Total recuperados', value: data.modulos.carritos.recuperadosTotal },
            ]}
          />

        </div>
      </section>

      {/* ── Posibles indemnizaciones ────────────────────────────── */}
      <section id="indemnizaciones">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Posibles indemnizaciones</h2>
          <button
            onClick={() => setShowIndemn(v => !v)}
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-indigo-600 transition-colors"
          >
            {showIndemn ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            {showIndemn ? 'Ocultar' : `Ver ${data.indemnizables.length} casos`}
          </button>
        </div>

        {!showIndemn && data.indemnizables.length > 0 && (
          <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 text-sm text-orange-800 flex items-center gap-2">
            <FileWarning className="w-4 h-4 shrink-0" />
            {data.indemnizables.length} pedido{data.indemnizables.length > 1 ? 's' : ''} devuelto{data.indemnizables.length > 1 ? 's' : ''} con 2+ intentos podrían reclamar indemnización a la transportadora.
          </div>
        )}

        {showIndemn && data.indemnizables.length === 0 && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-700 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            No hay casos de posible indemnización actualmente.
          </div>
        )}

        {showIndemn && data.indemnizables.length > 0 && (
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            {/* Desktop */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Guía</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Cliente</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Ciudad</th>
                    <th className="text-center px-4 py-2.5 font-medium text-gray-600">Intentos</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Razón</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Prioridad</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Recomendación</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.indemnizables.map(order => {
                    const prio = getIndemnPriority(order)
                    return (
                      <tr key={order.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-mono text-xs text-gray-700">
                          {order.tracking_number}
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-800">{order.customer_name ?? '—'}</p>
                          {order.order_number && <p className="text-xs text-gray-400">{order.order_number}</p>}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{order.city ?? '—'}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${order.delivery_attempts >= 3 ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
                            {order.delivery_attempts}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 max-w-[160px] truncate" title={order.last_attempt_reason ?? ''}>
                          {order.last_attempt_reason ?? '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${prio.color}`}>
                            {prio.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-700 max-w-[180px]">{getIndemnRecomendacion(order)}</td>
                        <td className="px-4 py-3">
                          <Link
                            href={`/orders/${order.id}`}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 border border-indigo-200 hover:border-indigo-300 px-2 py-1 rounded-md transition-colors"
                          >
                            Ver pedido <ExternalLink className="w-3 h-3" />
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {/* Mobile */}
            <div className="md:hidden divide-y divide-gray-100">
              {data.indemnizables.map(order => {
                const prio = getIndemnPriority(order)
                return (
                  <div key={order.id} className="px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-gray-500">{order.tracking_number}</span>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${prio.color}`}>{prio.label}</span>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${order.delivery_attempts >= 3 ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
                          {order.delivery_attempts} intentos
                        </span>
                      </div>
                    </div>
                    <p className="font-medium text-gray-800 text-sm">{order.customer_name ?? '—'}</p>
                    <p className="text-xs text-gray-500">{order.city ?? '—'} · {order.last_attempt_reason ?? '—'}</p>
                    <div className="flex items-center justify-between pt-1">
                      <p className="text-xs text-gray-600">{getIndemnRecomendacion(order)}</p>
                      <Link
                        href={`/orders/${order.id}`}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 border border-indigo-200 px-2 py-1 rounded-md ml-2 shrink-0"
                      >
                        Ver pedido <ExternalLink className="w-3 h-3" />
                      </Link>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════════ */}
      {/* ── FASE 2: AUDITORÍA OPERATIVA IA ──────────────────────── */}
      {/* ══════════════════════════════════════════════════════════ */}

      {/* ── Dinero en riesgo ───────────────────────────────────── */}
      {auditoriaData && (
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-red-500" />
            Dinero en riesgo
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-xs text-red-600 font-medium mb-1">Devoluciones indemnizables</p>
              <p className="text-xl font-bold text-red-800">{fmtDOP(auditoriaData.dineroRiesgo.devolucionesIndemnizables)}</p>
              <p className="text-xs text-red-500 mt-0.5">{auditoriaData.courier.anuladasSospechosas} guías · 2+ intentos</p>
            </div>
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
              <p className="text-xs text-orange-600 font-medium mb-1">Novedades en riesgo</p>
              <p className="text-xl font-bold text-orange-800">{fmtDOP(auditoriaData.dineroRiesgo.pedidosEnRiesgoNovedad)}</p>
              <p className="text-xs text-orange-500 mt-0.5">{auditoriaData.agentes.novedad.dosIntentosActivos} novedades · 2+ intentos</p>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <p className="text-xs text-amber-600 font-medium mb-1">Reparto retrasado +72h</p>
              <p className="text-xl font-bold text-amber-800">{fmtDOP(auditoriaData.dineroRiesgo.repartoRetraso72h)}</p>
              <p className="text-xs text-amber-500 mt-0.5">{auditoriaData.courier.retrasos72h} guías en riesgo</p>
            </div>
            <div className={`rounded-xl p-4 border ${auditoriaData.dineroRiesgo.totalEnRiesgo > 0 ? 'bg-red-100 border-red-300' : 'bg-gray-50 border-gray-200'}`}>
              <p className={`text-xs font-semibold mb-1 ${auditoriaData.dineroRiesgo.totalEnRiesgo > 0 ? 'text-red-700' : 'text-gray-500'}`}>Total en riesgo</p>
              <p className={`text-xl font-bold ${auditoriaData.dineroRiesgo.totalEnRiesgo > 0 ? 'text-red-900' : 'text-gray-700'}`}>{fmtDOP(auditoriaData.dineroRiesgo.totalEnRiesgo)}</p>
              <p className={`text-xs mt-0.5 ${auditoriaData.dineroRiesgo.totalEnRiesgo > 0 ? 'text-red-600' : 'text-gray-400'}`}>Suma acumulada</p>
            </div>
          </div>
        </section>
      )}

      {/* ── Auditoría Operativa IA ─────────────────────────────── */}
      <section id="auditoria">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-orange-500" />
            Auditoría Operativa IA
            {auditoriaData && (
              <span className="text-xs font-bold bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full normal-case tracking-normal">
                {auditoriaData.casosAuditoria.filter(c => c.level === 'Crítico').length} críticos
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            {(['all', 'Crítico', 'Alto', 'Medio', 'Bajo'] as const).map(nivel => (
              <button
                key={nivel}
                onClick={() => setAuditFiltroNivel(nivel)}
                className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                  auditFiltroNivel === nivel
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300'
                }`}
              >
                {nivel === 'all' ? 'Todos' : nivel}
              </button>
            ))}
            <button
              onClick={() => setShowAuditoria(v => !v)}
              className="flex items-center gap-1 text-sm text-gray-600 hover:text-indigo-600 transition-colors"
            >
              {showAuditoria ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              {showAuditoria ? 'Ocultar' : `Ver ${auditoriaData ? casosAuditFiltrados.length : '…'} casos`}
            </button>
          </div>
        </div>

        {/* Resumen de señales */}
        {auditoriaData && !showAuditoria && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
            {(['Crítico', 'Alto', 'Medio', 'Bajo'] as const).map(nivel => {
              const count = auditoriaData.casosAuditoria.filter(c => c.level === nivel).length
              return (
                <button
                  key={nivel}
                  onClick={() => { setAuditFiltroNivel(nivel); setShowAuditoria(true) }}
                  className={`rounded-lg border px-3 py-2.5 text-left transition-all hover:shadow-sm ${RISK_LEVEL_STYLE[nivel] ?? 'bg-gray-50 border-gray-200 text-gray-600'}`}
                >
                  <p className="text-xs font-semibold uppercase tracking-wide">{nivel}</p>
                  <p className="text-2xl font-bold mt-0.5">{count}</p>
                  <p className="text-xs opacity-70">casos</p>
                </button>
              )
            })}
          </div>
        )}

        {auditoriaLoading && !auditoriaData && (
          <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-500 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
            Cargando análisis operativo…
          </div>
        )}

        {showAuditoria && auditoriaData && casosAuditFiltrados.length === 0 && (
          <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            No hay casos {auditFiltroNivel !== 'all' ? `con nivel "${auditFiltroNivel}"` : 'sospechosos'} en este momento.
          </div>
        )}

        {showAuditoria && casosAuditFiltrados.length > 0 && (
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            {/* Desktop */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-3 py-2.5 font-medium text-gray-600">Score</th>
                    <th className="text-left px-3 py-2.5 font-medium text-gray-600">Guía</th>
                    <th className="text-left px-3 py-2.5 font-medium text-gray-600">Cliente</th>
                    <th className="text-left px-3 py-2.5 font-medium text-gray-600">Ciudad</th>
                    <th className="text-center px-3 py-2.5 font-medium text-gray-600">Estado</th>
                    <th className="text-center px-3 py-2.5 font-medium text-gray-600">Intentos</th>
                    <th className="text-left px-3 py-2.5 font-medium text-gray-600">Señales</th>
                    <th className="px-3 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {casosAuditFiltrados.slice(0, 50).map(caso => (
                    <tr key={caso.id} className={`hover:bg-gray-50 ${RISK_ROW_BG[caso.level] ?? ''}`}>
                      <td className="px-3 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${RISK_LEVEL_STYLE[caso.level] ?? 'bg-gray-100 text-gray-600'}`}>
                            {caso.level}
                          </span>
                          <span className="text-xs font-mono text-gray-500">{caso.score}/100</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-gray-700">{caso.tracking_number}</td>
                      <td className="px-3 py-3">
                        <p className="font-medium text-gray-800">{caso.customer_name ?? '—'}</p>
                        {caso.order_number && <p className="text-xs text-gray-400">{caso.order_number}</p>}
                      </td>
                      <td className="px-3 py-3 text-gray-600">{caso.city ?? '—'}</td>
                      <td className="px-3 py-3 text-center">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${getStatusBadge(caso.normalized_status)}`}>
                          {getStatusLabel(caso.normalized_status)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${caso.delivery_attempts >= 3 ? 'bg-red-100 text-red-700' : caso.delivery_attempts >= 2 ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-600'}`}>
                          {caso.delivery_attempts}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1 max-w-[260px]">
                          {caso.signals.slice(0, 3).map(signal => (
                            <span key={signal} className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${SIGNAL_COLOR[signal] ?? 'bg-gray-100 text-gray-600'}`}>
                              {signal}
                            </span>
                          ))}
                          {caso.signals.length > 3 && (
                            <span className="text-[10px] text-gray-400">+{caso.signals.length - 3}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <a
                          href={`/orders/${caso.id}`}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 border border-indigo-200 hover:border-indigo-300 px-2 py-1 rounded-md transition-colors"
                        >
                          Ver <ExternalLink className="w-3 h-3" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile */}
            <div className="md:hidden divide-y divide-gray-100">
              {casosAuditFiltrados.slice(0, 30).map(caso => (
                <div key={caso.id} className={`px-4 py-3 space-y-2 ${RISK_ROW_BG[caso.level] ?? ''}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-gray-500">{caso.tracking_number}</span>
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${RISK_LEVEL_STYLE[caso.level] ?? ''}`}>
                        {caso.level} · {caso.score}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-gray-800 text-sm">{caso.customer_name ?? '—'}</p>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${getStatusBadge(caso.normalized_status)}`}>
                      {getStatusLabel(caso.normalized_status)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">{caso.city ?? '—'} · {caso.delivery_attempts} {caso.delivery_attempts === 1 ? 'intento' : 'intentos'}</p>
                  <div className="flex flex-wrap gap-1">
                    {caso.signals.slice(0, 2).map(signal => (
                      <span key={signal} className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${SIGNAL_COLOR[signal] ?? 'bg-gray-100 text-gray-600'}`}>
                        {signal}
                      </span>
                    ))}
                  </div>
                  <a
                    href={`/orders/${caso.id}`}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 border border-indigo-200 px-2 py-1 rounded-md"
                  >
                    Ver pedido <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Score de gestión courier ───────────────────────────── */}
      {auditoriaData && (
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-blue-500" />
            Score de gestión courier
          </h2>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="bg-blue-50 px-4 py-3 flex items-center justify-between border-b border-blue-100">
              <div className="flex items-center gap-2">
                <Truck className="w-4 h-4 text-blue-600" />
                <span className="font-semibold text-sm text-blue-800">Eficiencia operacional EFI/Courier</span>
              </div>
              <span className="text-xs text-blue-600 font-medium">{auditoriaData.courier.totalProcesados} guías procesadas</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-gray-100">
              {/* Tasa entrega */}
              <div className="p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">% Entregas exitosas</p>
                <p className={`text-3xl font-bold ${auditoriaData.courier.tasaEntrega >= 70 ? 'text-green-600' : auditoriaData.courier.tasaEntrega >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                  {auditoriaData.courier.tasaEntrega}%
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{auditoriaData.courier.entregados} entregados</p>
              </div>
              {/* Tasa devolución */}
              <div className="p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">% Devoluciones</p>
                <p className={`text-3xl font-bold ${auditoriaData.courier.tasaDevolucion <= 5 ? 'text-green-600' : auditoriaData.courier.tasaDevolucion <= 15 ? 'text-amber-600' : 'text-red-600'}`}>
                  {auditoriaData.courier.tasaDevolucion}%
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{auditoriaData.courier.devueltos} devueltos</p>
              </div>
              {/* Tasa novedades */}
              <div className="p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">% Novedades activas</p>
                <p className={`text-3xl font-bold ${auditoriaData.courier.tasaNovedades <= 5 ? 'text-green-600' : auditoriaData.courier.tasaNovedades <= 15 ? 'text-amber-600' : 'text-red-600'}`}>
                  {auditoriaData.courier.tasaNovedades}%
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{auditoriaData.courier.novedades} activas</p>
              </div>
              {/* Retrasos 72h */}
              <div className="p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">% Retrasos +72h</p>
                <p className={`text-3xl font-bold ${auditoriaData.courier.tasaRetraso72h === 0 ? 'text-green-600' : auditoriaData.courier.tasaRetraso72h <= 5 ? 'text-amber-600' : 'text-red-600'}`}>
                  {auditoriaData.courier.tasaRetraso72h}%
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{auditoriaData.courier.retrasos72h} casos</p>
              </div>
            </div>
            {/* Fila señales de alerta */}
            <div className="border-t border-gray-100 grid grid-cols-2 sm:grid-cols-3 gap-0 divide-x divide-gray-100">
              <div className="px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-gray-600">Intentos sospechosos (2+)</span>
                <span className={`text-sm font-bold ${auditoriaData.courier.intentosSospechosos > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                  {auditoriaData.courier.intentosSospechosos}
                </span>
              </div>
              <div className="px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-gray-600">Cobertura dudosa</span>
                <span className={`text-sm font-bold ${auditoriaData.courier.coberturaDudosa > 0 ? 'text-purple-600' : 'text-green-600'}`}>
                  {auditoriaData.courier.coberturaDudosa}
                </span>
              </div>
              <div className="px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-gray-600">Devoluciones sospechosas</span>
                <span className={`text-sm font-bold ${auditoriaData.courier.anuladasSospechosas > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {auditoriaData.courier.anuladasSospechosas}
                </span>
              </div>
            </div>
            {/* Nota de interpretación */}
            <div className="border-t border-gray-100 px-4 py-2 bg-gray-50">
              <p className="text-xs text-gray-400 flex items-center gap-1">
                <Info className="w-3 h-3 shrink-0" />
                Referencia: entrega ≥70% bueno · devolución ≤5% bueno · retrasos 0% ideal. Métricas globales de toda la operación.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ── Score de agentes ───────────────────────────────────── */}
      {auditoriaData && (
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
            <Star className="w-4 h-4 text-indigo-500" />
            Score operativo de agentes
            <span className="text-xs font-normal text-gray-400 normal-case tracking-normal">(Fase 2 — métricas globales)</span>
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

            {/* confirmation_agent */}
            <div className="bg-white rounded-xl border border-indigo-200 overflow-hidden">
              <div className="bg-indigo-50 px-4 py-3 border-b border-indigo-100 flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-indigo-600" />
                <div>
                  <p className="text-sm font-semibold text-indigo-800">confirmation_agent</p>
                  <p className="text-xs text-indigo-500">Agente de confirmación</p>
                </div>
              </div>
              <div className="divide-y divide-gray-100">
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Pedidos confirmados hoy</span>
                  <span className={`font-bold ${auditoriaData.agentes.confirmation.confirmadosHoy > 0 ? 'text-green-700' : 'text-gray-400'}`}>
                    {auditoriaData.agentes.confirmation.confirmadosHoy}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">En cola (sin confirmar)</span>
                  <span className={`font-bold ${auditoriaData.agentes.confirmation.pendientesEnCola > 0 ? 'text-amber-700' : 'text-green-600'}`}>
                    {auditoriaData.agentes.confirmation.pendientesEnCola}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Inalcanzables totales</span>
                  <span className="font-bold text-gray-700">{auditoriaData.agentes.confirmation.inalcanzablesTotal}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Cancelados totales</span>
                  <span className="font-bold text-gray-700">{auditoriaData.agentes.confirmation.canceladosTotal}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Fuera de cobertura</span>
                  <span className={`font-bold ${auditoriaData.agentes.confirmation.fueraCobertura > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                    {auditoriaData.agentes.confirmation.fueraCobertura}
                  </span>
                </div>
              </div>
            </div>

            {/* novelty_agent */}
            <div className="bg-white rounded-xl border border-red-200 overflow-hidden">
              <div className="bg-red-50 px-4 py-3 border-b border-red-100 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-600" />
                <div>
                  <p className="text-sm font-semibold text-red-800">novelty_agent</p>
                  <p className="text-xs text-red-500">Agente de novedad</p>
                </div>
              </div>
              <div className="divide-y divide-gray-100">
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Novedades activas</span>
                  <span className={`font-bold ${auditoriaData.agentes.novedad.novedadesActivas > 0 ? 'text-amber-700' : 'text-green-600'}`}>
                    {auditoriaData.agentes.novedad.novedadesActivas}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Recuperadas hoy</span>
                  <span className={`font-bold ${auditoriaData.agentes.novedad.recuperadasHoy > 0 ? 'text-green-700' : 'text-gray-400'}`}>
                    {auditoriaData.agentes.novedad.recuperadasHoy}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Casos críticos (2+ intentos)</span>
                  <span className={`font-bold ${auditoriaData.agentes.novedad.dosIntentosActivos > 0 ? 'text-red-700' : 'text-green-600'}`}>
                    {auditoriaData.agentes.novedad.dosIntentosActivos}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Novedades +14 días</span>
                  <span className={`font-bold ${auditoriaData.agentes.novedad.masViejas14dias > 0 ? 'text-red-700' : 'text-green-600'}`}>
                    {auditoriaData.agentes.novedad.masViejas14dias}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Indemnizaciones detectadas</span>
                  <span className={`font-bold ${auditoriaData.agentes.novedad.indemnizacionesDetectadas > 0 ? 'text-orange-700' : 'text-gray-400'}`}>
                    {auditoriaData.agentes.novedad.indemnizacionesDetectadas}
                  </span>
                </div>
              </div>
            </div>

            {/* delivery_agent */}
            <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
              <div className="bg-amber-50 px-4 py-3 border-b border-amber-100 flex items-center gap-2">
                <Bike className="w-4 h-4 text-amber-600" />
                <div>
                  <p className="text-sm font-semibold text-amber-800">delivery_agent</p>
                  <p className="text-xs text-amber-500">Agente de reparto</p>
                </div>
              </div>
              <div className="divide-y divide-gray-100">
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">En reparto (total)</span>
                  <span className={`font-bold ${auditoriaData.agentes.delivery.enRepartoTotal > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                    {auditoriaData.agentes.delivery.enRepartoTotal}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Entregados hoy (courier)</span>
                  <span className={`font-bold ${auditoriaData.agentes.delivery.entregadosHoy > 0 ? 'text-green-700' : 'text-gray-400'}`}>
                    {auditoriaData.agentes.delivery.entregadosHoy}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Reparto crítico +48h</span>
                  <span className={`font-bold ${auditoriaData.agentes.delivery.repartoCritico48h > 0 ? 'text-red-700' : 'text-green-600'}`}>
                    {auditoriaData.agentes.delivery.repartoCritico48h}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-gray-600">Claims registrados</span>
                  <span className="font-bold text-gray-700">{auditoriaData.agentes.delivery.claimsRegistrados}</span>
                </div>
              </div>
            </div>

          </div>
          {/* Nota coaching futuro */}
          <div className="mt-3 flex items-start gap-2 px-4 py-3 bg-indigo-50 border border-indigo-100 rounded-lg">
            <Info className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
            <p className="text-xs text-indigo-700">
              <strong>Fase 3:</strong> El coaching IA dejará feedback individual a agentes, recomendará mejoras personalizadas y generará tareas automáticas basadas en patrones detectados. Esta sección muestra métricas globales mientras se prepara la arquitectura de agentes.
            </p>
          </div>
        </section>
      )}

      {/* ── Tareas sugeridas por agente ─────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Tareas sugeridas por agente</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

          {/* Agente de confirmación */}
          <div className="bg-white rounded-xl border border-indigo-200 overflow-hidden">
            <div className="bg-indigo-50 px-4 py-2.5 flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-indigo-600" />
              <span className="text-sm font-semibold text-indigo-800">Agente de confirmación</span>
            </div>
            <ul className="divide-y divide-gray-100 text-sm">
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="/confirmacion" className="text-gray-700 hover:text-indigo-600">Contactar pedidos nuevos</Link>
                {data.operacion.nuevosHoy > 0 && <span className="text-xs font-bold text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded-full">{data.operacion.nuevosHoy}</span>}
              </li>
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="/confirmacion" className="text-gray-700 hover:text-indigo-600">Reintentar pendientes</Link>
                {data.alertas.sinConfirmar24h > 0 && <span className="text-xs font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full">{data.alertas.sinConfirmar24h}</span>}
              </li>
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="/carritos-abandonados?status=pending" className="text-gray-700 hover:text-indigo-600">Recuperar carritos</Link>
                {data.alertas.carritosPendientes > 0 && <span className="text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">{data.alertas.carritosPendientes}</span>}
              </li>
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="/confirmacion" className="text-gray-700 hover:text-indigo-600">Revisar sin cobertura</Link>
                {data.operacion.fueraCobertura > 0 && <span className="text-xs font-bold text-orange-700 bg-orange-100 px-2 py-0.5 rounded-full">{data.operacion.fueraCobertura}</span>}
              </li>
            </ul>
          </div>

          {/* Agente de novedad */}
          <div className="bg-white rounded-xl border border-red-200 overflow-hidden">
            <div className="bg-red-50 px-4 py-2.5 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-600" />
              <span className="text-sm font-semibold text-red-800">Agente de novedad</span>
            </div>
            <ul className="divide-y divide-gray-100 text-sm">
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="/novedad" className="text-gray-700 hover:text-red-600">Escalar novedades críticas</Link>
                {data.modulos.novedad.activas > 0 && <span className="text-xs font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full">{data.modulos.novedad.activas}</span>}
              </li>
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="/novedad?filter=2-intentos" className="text-gray-700 hover:text-red-600">Novedades con 2 intentos</Link>
                {data.alertas.novedad2Intentos > 0 && <span className="text-xs font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full">{data.alertas.novedad2Intentos}</span>}
              </li>
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="/transito?tab=generadas" className="text-gray-700 hover:text-red-600">Revisar generadas +48h</Link>
                {data.operacion.generadas48h > 0 && <span className="text-xs font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full">{data.operacion.generadas48h}</span>}
              </li>
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="#indemnizaciones" className="text-gray-700 hover:text-red-600">Preparar reclamos indemnización</Link>
                {data.alertas.posiblesIndemnizables > 0 && <span className="text-xs font-bold text-orange-700 bg-orange-100 px-2 py-0.5 rounded-full">{data.alertas.posiblesIndemnizables}</span>}
              </li>
              <li className="px-4 py-2.5 text-gray-600 text-xs italic">
                No reprogramar con 2 intentos sin contacto previo al cliente.
              </li>
            </ul>
          </div>

          {/* Agente de reparto */}
          <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
            <div className="bg-amber-50 px-4 py-2.5 flex items-center gap-2">
              <Bike className="w-4 h-4 text-amber-600" />
              <span className="text-sm font-semibold text-amber-800">Agente de reparto</span>
            </div>
            <ul className="divide-y divide-gray-100 text-sm">
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="/reparto" className="text-gray-700 hover:text-amber-600">Llamar guías en reparto</Link>
                {data.modulos.reparto.enReparto > 0 && <span className="text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">{data.modulos.reparto.enReparto}</span>}
              </li>
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="/reparto?filter=critical" className="text-gray-700 hover:text-amber-600">Priorizar reparto +48h</Link>
                {data.modulos.reparto.criticos48h > 0 && <span className="text-xs font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full">{data.modulos.reparto.criticos48h}</span>}
              </li>
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="/reparto" className="text-gray-700 hover:text-amber-600">Reportar incidencias</Link>
              </li>
              <li className="px-4 py-2.5 flex justify-between items-center">
                <Link href="/reparto" className="text-gray-700 hover:text-amber-600">Validar entregas del día</Link>
                {data.modulos.reparto.entregadosHoy > 0 && <span className="text-xs font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">{data.modulos.reparto.entregadosHoy}</span>}
              </li>
            </ul>
          </div>

        </div>
      </section>

    </div>
  )
}
