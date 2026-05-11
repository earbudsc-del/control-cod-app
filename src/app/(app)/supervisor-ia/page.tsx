'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Brain, RefreshCw, AlertTriangle, CheckCircle2, Package,
  Bike, AlertCircle, Box, ShoppingCart, MapPinOff, ExternalLink,
  ChevronDown, ChevronUp, TrendingUp, Clock, Truck,
  ClipboardList, FileWarning, CircleDollarSign, ArrowRight,
  ShieldAlert, BarChart3, DollarSign, Star, Info,
  Check, XCircle, Filter, AlertOctagon,
  Users, Award, X, TrendingDown, Banknote, RotateCcw,
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
  customer_phone: string | null
  city: string | null
  province: string | null
  delivery_attempts: number
  last_attempt_reason: string | null
  raw_status: string | null
  normalized_status: string
  status_since: string | null
  shipment_created_at: string | null
  shopify_created_at: string | null
  cod_amount: number | null
  score: number
  level: string
  signals: string[]
}

interface CasoIndemnizable extends CasoAuditoria {
  iaReason: string
  confidenceScore: number
  isFalsePositive: boolean
  falsePositiveReason: string
  indemnCat: 'altamente_probable' | 'posible' | 'excluido'
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
  devolucionesAltamenteProbables: number
  devolucionesPosibles: number
  devolucionesExcluidasCount: number
}

interface AuditoriaData {
  generatedAt: string
  casosAuditoria: CasoAuditoria[]
  casosIndemnizablesDetalle: CasoIndemnizable[]
  courier: CourierMetrics
  agentes: AgentesMetrics
  dineroRiesgo: DineroRiesgo
}

// ─── Tipos Pagos Admin ───────────────────────────────────────────────────────

interface PaymentBreakdownItem {
  orderId:      string
  orderNumber:  string | null
  customerName: string | null
  resultado:    string
  pago:         number
  reason:       string
}

interface AgentPaymentData {
  agentId:         string
  agentName:       string | null
  role:            string
  score:           number
  level:           'Excelente' | 'Bueno' | 'Riesgo' | 'Deficiente'
  paymentEstimate: number
  breakdown:       PaymentBreakdownItem[]
  recomendacion:   'pagar_completo' | 'pagar_con_bono' | 'revisar' | 'posible_sobrepago'
  explicacion:     string
}

interface AgentPaymentsResponse {
  generatedAt: string
  totalPago:   number
  agents:      AgentPaymentData[]
  nota:        string
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

// ─── Helpers de pagos admin ──────────────────────────────────────────────────

const RECOM_META: Record<string, { label: string; color: string }> = {
  pagar_completo:    { label: 'Pagar completo',           color: 'bg-green-100 text-green-700 border-green-200' },
  pagar_con_bono:    { label: 'Pagar con bono',           color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  revisar:           { label: 'Revisar antes de pagar',   color: 'bg-amber-100 text-amber-700 border-amber-200' },
  posible_sobrepago: { label: 'Posible sobrepago',        color: 'bg-red-100 text-red-700 border-red-200' },
}

const PAY_LEVEL_STYLE: Record<string, string> = {
  Excelente:  'bg-green-100 text-green-700',
  Bueno:      'bg-blue-100 text-blue-700',
  Riesgo:     'bg-amber-100 text-amber-700',
  Deficiente: 'bg-red-100 text-red-700',
}

const ROL_LABEL: Record<string, string> = {
  confirmation_agent: 'Confirmación',
  novelty_agent:      'Novedad',
  delivery_agent:     'Reparto',
}

function agentMetrics(agent: AgentPaymentData) {
  const entregados   = agent.breakdown.filter(b => b.resultado === 'Entregado' || b.resultado === 'Recuperado + entregado').length
  const recuperados  = agent.breakdown.filter(b => b.resultado.includes('Recuperado')).length
  const devueltos    = agent.breakdown.filter(b => b.resultado.includes('Devuelto')).length
  const sinCobertura = agent.breakdown.filter(b => b.resultado === 'Fuera cobertura' || b.resultado === 'Cancelado').length
  const criticos     = agent.breakdown.filter(b => b.resultado === 'Sin respuesta al courier' || b.resultado === '2+ intentos trabajados').length
  return { entregados, recuperados, devueltos, sinCobertura, criticos }
}

function generatePaymentInsights(agents: AgentPaymentData[]): string[] {
  if (agents.length === 0) return ['No hay agentes activos con datos de pago esta semana.']
  const insights: string[] = []

  const best = agents.reduce((a, b) => a.score > b.score ? a : b)
  if (best.score >= 90) {
    insights.push(`${best.agentName ?? 'El agente top'} lidera con score ${best.score} — rendimiento excelente esta semana.`)
  } else if (best.score >= 75) {
    insights.push(`${best.agentName ?? 'El agente top'} tiene el mejor score (${best.score}). Semana operativa positiva.`)
  }

  const conBono = agents.filter(a => a.recomendacion === 'pagar_con_bono')
  if (conBono.length > 0) {
    const nombres = conBono.map(a => a.agentName ?? a.role).join(', ')
    insights.push(`${nombres} ${conBono.length === 1 ? 'tiene' : 'tienen'} alta recuperación — considera bono por desempeño.`)
  }

  const riesgo = agents.filter(a => a.level === 'Riesgo' || a.level === 'Deficiente')
  if (riesgo.length > 0) {
    const nombres = riesgo.map(a => a.agentName ?? a.role).join(', ')
    insights.push(`${nombres} ${riesgo.length === 1 ? 'requiere' : 'requieren'} coaching antes de escalar pago.`)
  }

  const totalDev = agents.reduce((s, a) => s + a.breakdown.filter(b => b.resultado.includes('Devuelto')).length, 0)
  const totalEnt = agents.reduce((s, a) => s + a.breakdown.filter(b => b.resultado === 'Entregado' || b.resultado === 'Recuperado + entregado').length, 0)
  if (totalEnt + totalDev > 0 && (totalDev / (totalEnt + totalDev)) > 0.15) {
    insights.push(`La tasa de devoluciones (${Math.round((totalDev / (totalEnt + totalDev)) * 100)}%) está afectando la rentabilidad. Revisar gestión por agente.`)
  }

  const sobrepago = agents.filter(a => a.recomendacion === 'posible_sobrepago')
  if (sobrepago.length > 0) {
    insights.push(`Riesgo de sobrepago detectado en ${sobrepago.map(a => a.agentName ?? a.role).join(', ')}. Revisar antes de procesar pago.`)
  }

  const sinActividad = agents.filter(a => a.breakdown.every(b => b.pago === 0))
  if (sinActividad.length > 0) {
    insights.push(`${sinActividad.map(a => a.agentName ?? a.role).join(', ')} ${sinActividad.length === 1 ? 'no registra' : 'no registran'} actividad pagable esta semana.`)
  }

  if (insights.length === 0) {
    insights.push('Todos los agentes tienen rendimiento aceptable esta semana.')
  }

  return insights.slice(0, 5)
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

// ─── Helpers indemnizables ───────────────────────────────────────────────────

function calcDiasOperacion(caso: CasoIndemnizable): number {
  const sinceTs = caso.status_since ?? caso.shipment_created_at ?? caso.shopify_created_at
  if (!sinceTs) return 0
  return Math.floor((Date.now() - new Date(sinceTs).getTime()) / (1000 * 3600 * 24))
}

function getConfidenceBadge(score: number): string {
  if (score >= 65) return 'bg-red-100 text-red-700'
  if (score >= 30) return 'bg-amber-100 text-amber-700'
  return 'bg-gray-100 text-gray-500'
}

const INDEMN_SIGNAL_FILTER: Record<string, (c: CasoIndemnizable) => boolean> = {
  '3+ intentos': c => c.delivery_attempts >= 3,
  '2 intentos':  c => c.delivery_attempts === 2,
  '+72h':        c => c.signals.includes('Retraso excesivo'),
  'cobertura dudosa': c => c.signals.includes('Fuera cobertura dudoso'),
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
  // Pagos admin
  const [paymentsData, setPaymentsData]       = useState<AgentPaymentsResponse | null>(null)
  const [paymentsLoading, setPaymentsLoading] = useState(true)
  const [isAdmin, setIsAdmin]                 = useState<boolean | null>(null)
  const [selectedAgent, setSelectedAgent]     = useState<AgentPaymentData | null>(null)
  const [payFiltroRol, setPayFiltroRol]       = useState<string>('all')
  const [payFiltroNivel, setPayFiltroNivel]   = useState<string>('all')

  // Indemnizables detalle
  const [showIndemnDetalle, setShowIndemnDetalle] = useState(false)
  const [indemnFiltroNivel, setIndemnFiltroNivel] = useState<string>('all')
  const [indemnFiltroSignal, setIndemnFiltroSignal] = useState<string>('all')
  const [indemnRevisados, setIndemnRevisados] = useState<Set<string>>(new Set())
  const [indemnEscalados, setIndemnEscalados] = useState<Set<string>>(new Set())

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

  const fetchPayments = useCallback(async () => {
    try {
      setPaymentsLoading(true)
      const res = await fetch('/api/admin/agent-payments')
      if (res.status === 403) { setIsAdmin(false); return }
      if (!res.ok) return
      const json = await res.json()
      setPaymentsData(json)
      setIsAdmin(true)
    } catch {
      // silencioso — sección simplemente no aparece
    } finally {
      setPaymentsLoading(false)
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
    fetchPayments()
    const interval = setInterval(() => {
      fetchData()
      fetchAuditoria()
      fetchPayments()
    }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData, fetchAuditoria, fetchPayments])

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

      {/* ── Posibles indemnizaciones (anchor para compatibilidad) ── */}
      {/* La vista detallada está integrada en "Dinero en riesgo" abajo */}
      <div id="indemnizaciones" />

      {/* ══════════════════════════════════════════════════════════ */}
      {/* ── FASE 2: AUDITORÍA OPERATIVA IA ──────────────────────── */}
      {/* ══════════════════════════════════════════════════════════ */}

      {/* ── Dinero en riesgo + Detalle indemnizables ────────────── */}
      {auditoriaData && (() => {
        const indemnizables = auditoriaData.casosIndemnizablesDetalle ?? []
        const indemnFiltrados = indemnizables.filter(c => {
          if (c.isFalsePositive) return false
          if (indemnFiltroNivel !== 'all' && c.level !== indemnFiltroNivel) return false
          if (indemnFiltroSignal !== 'all') {
            const fn = INDEMN_SIGNAL_FILTER[indemnFiltroSignal]
            if (fn && !fn(c)) return false
          }
          return true
        })
        const altamenteProbList = indemnizables.filter(c => !c.isFalsePositive && c.indemnCat === 'altamente_probable')
        const posiblesList      = indemnizables.filter(c => !c.isFalsePositive && c.indemnCat === 'posible')
        const montoTotal = indemnizables.filter(c => !c.isFalsePositive).reduce((s, c) => s + (c.cod_amount ?? 0), 0)
        const montoPromedio = indemnizables.filter(c => !c.isFalsePositive).length > 0
          ? Math.round(montoTotal / indemnizables.filter(c => !c.isFalsePositive).length)
          : 0

        return (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-red-500" />
              Dinero en riesgo
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">

              {/* Card clickeable: Devoluciones indemnizables */}
              <button
                onClick={() => setShowIndemnDetalle(v => !v)}
                className={`text-left rounded-xl p-4 border transition-all hover:shadow-md ${
                  showIndemnDetalle
                    ? 'bg-red-100 border-red-400 ring-2 ring-red-300'
                    : 'bg-red-50 border-red-200 hover:border-red-400'
                }`}
              >
                <p className="text-xs text-red-600 font-medium mb-1">Devoluciones indemnizables</p>
                <p className="text-xl font-bold text-red-800">{fmtDOP(auditoriaData.dineroRiesgo.devolucionesIndemnizables)}</p>
                <p className="text-xs text-red-500 mt-0.5">{auditoriaData.courier.anuladasSospechosas} guías · 2+ intentos</p>
                <p className="text-[10px] text-red-400 mt-1.5 flex items-center gap-0.5 font-medium">
                  {showIndemnDetalle ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  {showIndemnDetalle ? 'Ocultar auditoría' : 'Auditar casos →'}
                </p>
              </button>

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

            {/* ── Detalle auditable de devoluciones indemnizables ── */}
            {showIndemnDetalle && (
              <div className="mt-4 border border-red-200 rounded-xl overflow-hidden">

                {/* Header + stats */}
                <div className="bg-red-50 px-4 py-3 border-b border-red-100">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 text-red-600" />
                      <span className="font-semibold text-sm text-red-800">Auditoría de devoluciones indemnizables</span>
                      <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-bold border border-red-200">
                        {indemnizables.filter(c => !c.isFalsePositive).length} casos
                      </span>
                    </div>
                    <button
                      onClick={() => setShowIndemnDetalle(false)}
                      className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1"
                    >
                      <ChevronUp className="w-3.5 h-3.5" /> Cerrar
                    </button>
                  </div>

                  {/* Stats bar */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                    <div className="bg-white rounded-lg border border-red-100 px-3 py-2">
                      <p className="text-[10px] text-gray-500 font-medium">Monto total</p>
                      <p className="text-sm font-bold text-red-800">{fmtDOP(montoTotal)}</p>
                    </div>
                    <div className="bg-white rounded-lg border border-red-100 px-3 py-2">
                      <p className="text-[10px] text-gray-500 font-medium">Promedio</p>
                      <p className="text-sm font-bold text-red-700">{fmtDOP(montoPromedio)}</p>
                    </div>
                    <div className="bg-white rounded-lg border border-red-100 px-3 py-2">
                      <p className="text-[10px] text-gray-500 font-medium">Alta prob.</p>
                      <p className="text-sm font-bold text-red-900">{fmtDOP(auditoriaData.dineroRiesgo.devolucionesAltamenteProbables ?? 0)}</p>
                      <p className="text-[10px] text-red-500">{altamenteProbList.length} casos · ≥65% conf.</p>
                    </div>
                    <div className="bg-white rounded-lg border border-orange-100 px-3 py-2">
                      <p className="text-[10px] text-gray-500 font-medium">Posibles</p>
                      <p className="text-sm font-bold text-orange-800">{fmtDOP(auditoriaData.dineroRiesgo.devolucionesPosibles ?? 0)}</p>
                      <p className="text-[10px] text-orange-500">{posiblesList.length} casos · 30–64% conf.</p>
                    </div>
                  </div>
                  {(auditoriaData.dineroRiesgo.devolucionesExcluidasCount ?? 0) > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-1.5 mb-3">
                      <XCircle className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                      {auditoriaData.dineroRiesgo.devolucionesExcluidasCount} caso{(auditoriaData.dineroRiesgo.devolucionesExcluidasCount ?? 0) > 1 ? 's' : ''} excluido{(auditoriaData.dineroRiesgo.devolucionesExcluidasCount ?? 0) > 1 ? 's' : ''} como falso positivo (cliente canceló, rechazó, teléfono incorrecto u otro).
                    </div>
                  )}

                  {/* Filtros nivel */}
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    <span className="text-xs text-gray-500 font-medium self-center">Nivel:</span>
                    {(['all', 'Crítico', 'Alto', 'Medio', 'Bajo'] as const).map(n => (
                      <button
                        key={n}
                        onClick={() => setIndemnFiltroNivel(n)}
                        className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                          indemnFiltroNivel === n
                            ? 'bg-red-700 text-white border-red-700'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-red-300'
                        }`}
                      >
                        {n === 'all' ? 'Todos' : n}
                      </button>
                    ))}
                  </div>
                  {/* Filtros señales */}
                  <div className="flex flex-wrap gap-1.5">
                    <span className="text-xs text-gray-500 font-medium self-center">Señal:</span>
                    {(['all', '3+ intentos', '2 intentos', '+72h', 'cobertura dudosa'] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => setIndemnFiltroSignal(s)}
                        className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                          indemnFiltroSignal === s
                            ? 'bg-gray-800 text-white border-gray-800'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                        }`}
                      >
                        {s === 'all' ? 'Todas' : s}
                      </button>
                    ))}
                  </div>
                </div>

                {indemnFiltrados.length === 0 && (
                  <div className="flex items-center gap-2 px-4 py-4 text-sm text-gray-500 bg-white">
                    <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                    No hay casos que coincidan con los filtros seleccionados.
                  </div>
                )}

                {indemnFiltrados.length > 0 && (
                  <>
                    {/* Desktop */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b border-gray-200 text-xs">
                          <tr>
                            <th className="text-left px-3 py-2.5 font-medium text-gray-600">Nivel / Score</th>
                            <th className="text-left px-3 py-2.5 font-medium text-gray-600">Guía / Pedido</th>
                            <th className="text-left px-3 py-2.5 font-medium text-gray-600">Cliente / Ciudad</th>
                            <th className="text-right px-3 py-2.5 font-medium text-gray-600">COD</th>
                            <th className="text-center px-3 py-2.5 font-medium text-gray-600">Int.</th>
                            <th className="text-center px-3 py-2.5 font-medium text-gray-600">Días op.</th>
                            <th className="text-center px-3 py-2.5 font-medium text-gray-600">Estado</th>
                            <th className="text-left px-3 py-2.5 font-medium text-gray-600">Razón IA</th>
                            <th className="text-left px-3 py-2.5 font-medium text-gray-600">Señales</th>
                            <th className="text-center px-3 py-2.5 font-medium text-gray-600">Conf.</th>
                            <th className="text-center px-3 py-2.5 font-medium text-gray-600">Acciones</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 bg-white">
                          {indemnFiltrados.map(caso => {
                            const dias = calcDiasOperacion(caso)
                            const revisado = indemnRevisados.has(caso.id)
                            const escalado = indemnEscalados.has(caso.id)
                            return (
                              <tr key={caso.id} className={`${RISK_ROW_BG[caso.level] ?? ''} ${revisado ? 'opacity-60' : ''}`}>
                                <td className="px-3 py-2.5">
                                  <div className="flex flex-col gap-0.5">
                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border inline-block ${RISK_LEVEL_STYLE[caso.level] ?? ''}`}>
                                      {caso.level}
                                    </span>
                                    <span className="text-[10px] font-mono text-gray-400">{caso.score}/100</span>
                                  </div>
                                </td>
                                <td className="px-3 py-2.5">
                                  <p className="font-mono text-[11px] text-gray-700">{caso.tracking_number}</p>
                                  {caso.order_number && <p className="text-[10px] text-gray-400">{caso.order_number}</p>}
                                </td>
                                <td className="px-3 py-2.5">
                                  <p className="font-medium text-gray-800 text-xs">{caso.customer_name ?? '—'}</p>
                                  <p className="text-[10px] text-gray-400">{[caso.city, caso.province].filter(Boolean).join(', ') || '—'}</p>
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  <span className="text-xs font-semibold text-gray-800">{caso.cod_amount ? fmtDOP(caso.cod_amount) : '—'}</span>
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${caso.delivery_attempts >= 3 ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
                                    {caso.delivery_attempts}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  <span className={`text-[10px] font-semibold ${dias >= 7 ? 'text-red-600' : dias >= 3 ? 'text-amber-600' : 'text-gray-600'}`}>
                                    {dias}d
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${getStatusBadge(caso.normalized_status)}`}>
                                    {getStatusLabel(caso.normalized_status)}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 max-w-[160px]">
                                  <p className="text-[11px] text-gray-700 leading-tight">{caso.iaReason}</p>
                                  {caso.last_attempt_reason && (
                                    <p className="text-[10px] text-gray-400 truncate mt-0.5" title={caso.last_attempt_reason}>
                                      {caso.last_attempt_reason}
                                    </p>
                                  )}
                                </td>
                                <td className="px-3 py-2.5">
                                  <div className="flex flex-wrap gap-0.5 max-w-[180px]">
                                    {caso.signals.slice(0, 2).map(s => (
                                      <span key={s} className={`text-[9px] font-medium px-1 py-0.5 rounded ${SIGNAL_COLOR[s] ?? 'bg-gray-100 text-gray-600'}`}>
                                        {s.length > 20 ? s.slice(0, 18) + '…' : s}
                                      </span>
                                    ))}
                                    {caso.signals.length > 2 && (
                                      <span className="text-[9px] text-gray-400">+{caso.signals.length - 2}</span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${getConfidenceBadge(caso.confidenceScore)}`}>
                                    {caso.confidenceScore}%
                                  </span>
                                </td>
                                <td className="px-3 py-2.5">
                                  <div className="flex flex-col gap-1 items-start">
                                    <Link
                                      href={`/orders/${caso.id}`}
                                      className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-indigo-600 hover:text-indigo-800 border border-indigo-200 px-1.5 py-0.5 rounded transition-colors whitespace-nowrap"
                                    >
                                      Ver pedido <ExternalLink className="w-2.5 h-2.5" />
                                    </Link>
                                    <button
                                      onClick={() => setIndemnRevisados(prev => {
                                        const next = new Set(prev)
                                        revisado ? next.delete(caso.id) : next.add(caso.id)
                                        return next
                                      })}
                                      className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded border transition-colors whitespace-nowrap ${
                                        revisado ? 'bg-green-100 text-green-700 border-green-200' : 'text-gray-500 border-gray-200 hover:border-green-300'
                                      }`}
                                    >
                                      <Check className="w-2.5 h-2.5" />
                                      {revisado ? 'Revisado' : 'Marcar revisado'}
                                    </button>
                                    <button
                                      onClick={() => setIndemnEscalados(prev => {
                                        const next = new Set(prev)
                                        escalado ? next.delete(caso.id) : next.add(caso.id)
                                        return next
                                      })}
                                      className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded border transition-colors whitespace-nowrap ${
                                        escalado ? 'bg-orange-100 text-orange-700 border-orange-200' : 'text-gray-500 border-gray-200 hover:border-orange-300'
                                      }`}
                                    >
                                      <AlertOctagon className="w-2.5 h-2.5" />
                                      {escalado ? 'Escalado' : 'Escalar'}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Mobile */}
                    <div className="md:hidden divide-y divide-gray-100 bg-white">
                      {indemnFiltrados.map(caso => {
                        const dias = calcDiasOperacion(caso)
                        const revisado = indemnRevisados.has(caso.id)
                        const escalado = indemnEscalados.has(caso.id)
                        return (
                          <div key={caso.id} className={`px-4 py-3 space-y-2 ${RISK_ROW_BG[caso.level] ?? ''} ${revisado ? 'opacity-60' : ''}`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${RISK_LEVEL_STYLE[caso.level] ?? ''}`}>
                                  {caso.level} · {caso.score}
                                </span>
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${getConfidenceBadge(caso.confidenceScore)}`}>
                                  {caso.confidenceScore}% conf.
                                </span>
                              </div>
                              {caso.cod_amount && (
                                <span className="text-xs font-bold text-gray-800">{fmtDOP(caso.cod_amount)}</span>
                              )}
                            </div>
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="font-medium text-gray-800 text-sm">{caso.customer_name ?? '—'}</p>
                                <p className="text-xs text-gray-500">{[caso.city, caso.province].filter(Boolean).join(', ') || '—'}</p>
                              </div>
                              <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${getStatusBadge(caso.normalized_status)}`}>
                                {getStatusLabel(caso.normalized_status)}
                              </span>
                            </div>
                            <p className="font-mono text-[11px] text-gray-500">{caso.tracking_number} {caso.order_number ? `· ${caso.order_number}` : ''}</p>
                            <p className="text-xs text-gray-600 font-medium">{caso.iaReason}</p>
                            <div className="flex items-center gap-2 text-xs text-gray-400">
                              <span>{caso.delivery_attempts} {caso.delivery_attempts === 1 ? 'intento' : 'intentos'}</span>
                              <span>·</span>
                              <span>{dias}d en operación</span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {caso.signals.slice(0, 3).map(s => (
                                <span key={s} className={`text-[9px] font-medium px-1 py-0.5 rounded ${SIGNAL_COLOR[s] ?? 'bg-gray-100 text-gray-600'}`}>
                                  {s.length > 22 ? s.slice(0, 20) + '…' : s}
                                </span>
                              ))}
                            </div>
                            <div className="flex items-center gap-2 pt-1">
                              <Link
                                href={`/orders/${caso.id}`}
                                className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 border border-indigo-200 px-2 py-1 rounded-md"
                              >
                                Ver pedido <ExternalLink className="w-3 h-3" />
                              </Link>
                              <button
                                onClick={() => setIndemnRevisados(prev => {
                                  const next = new Set(prev)
                                  revisado ? next.delete(caso.id) : next.add(caso.id)
                                  return next
                                })}
                                className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md border transition-colors ${
                                  revisado ? 'bg-green-100 text-green-700 border-green-200' : 'text-gray-500 border-gray-200'
                                }`}
                              >
                                <Check className="w-3 h-3" />
                                {revisado ? 'Revisado' : 'Revisar'}
                              </button>
                              <button
                                onClick={() => setIndemnEscalados(prev => {
                                  const next = new Set(prev)
                                  escalado ? next.delete(caso.id) : next.add(caso.id)
                                  return next
                                })}
                                className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md border transition-colors ${
                                  escalado ? 'bg-orange-100 text-orange-700 border-orange-200' : 'text-gray-500 border-gray-200'
                                }`}
                              >
                                <AlertOctagon className="w-3 h-3" />
                                {escalado ? 'Escalado' : 'Escalar'}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}

                {/* Footer con estadísticas */}
                {indemnFiltrados.length > 0 && (
                  <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-400 flex items-center gap-1">
                    <Info className="w-3 h-3 shrink-0" />
                    Mostrando {indemnFiltrados.length} de {indemnizables.filter(c => !c.isFalsePositive).length} casos auditables. Excluidos {auditoriaData.dineroRiesgo.devolucionesExcluidasCount ?? 0} falsos positivos. Confianza ≥65% = altamente probable · 30–64% = posible.
                  </div>
                )}
              </div>
            )}
          </section>
        )
      })()}

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

      {/* ══════════════════════════════════════════════════════════ */}
      {/* ── DEVOLUCIONES: Métricas operativas ────────────────────── */}
      {/* ══════════════════════════════════════════════════════════ */}

      {auditoriaData && (() => {
        const totalDev = auditoriaData.courier.devueltos
        const indemnizables = (auditoriaData.casosIndemnizablesDetalle ?? []).filter(c => !c.isFalsePositive)
        const altaProb = indemnizables.filter(c => c.indemnCat === 'altamente_probable').length
        const posible  = indemnizables.filter(c => c.indemnCat === 'posible').length
        const montoAlta = indemnizables.filter(c => c.indemnCat === 'altamente_probable')
          .reduce((s, c) => s + (c.cod_amount ?? 0), 0)

        return (
          <section id="devoluciones-supervisor">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-red-500" />
              Devoluciones
              {altaProb > 0 && (
                <span className="text-xs font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded-full normal-case tracking-normal">
                  {altaProb} alta prob.
                </span>
              )}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
              <Link href="/devoluciones" className="bg-white border border-gray-200 rounded-xl p-4 hover:shadow-sm hover:border-red-300 transition-all block">
                <p className="text-xs text-gray-500 mb-1">Total devueltas</p>
                <p className="text-xl font-bold text-gray-900">{totalDev}</p>
                <p className="text-xs text-gray-400 mt-0.5">Ver todas →</p>
              </Link>
              <Link href="/devoluciones?filter=alta-indemnizacion" className={`rounded-xl p-4 hover:shadow-sm transition-all block ${altaProb > 0 ? 'bg-red-50 border border-red-200 hover:border-red-400' : 'bg-white border border-gray-200'}`}>
                <p className={`text-xs mb-1 font-medium ${altaProb > 0 ? 'text-red-600' : 'text-gray-500'}`}>Alta prob. indem.</p>
                <p className={`text-xl font-bold ${altaProb > 0 ? 'text-red-800' : 'text-gray-700'}`}>{altaProb}</p>
                {isAdmin === true && montoAlta > 0 && (
                  <p className="text-xs text-red-500 mt-0.5 font-medium">{fmtDOP(montoAlta)}</p>
                )}
              </Link>
              <Link href="/devoluciones?filter=posible-indemnizacion" className="bg-amber-50 border border-amber-200 rounded-xl p-4 hover:shadow-sm hover:border-amber-400 transition-all block">
                <p className="text-xs text-amber-600 font-medium mb-1">Posible indem.</p>
                <p className="text-xl font-bold text-amber-800">{posible}</p>
                <p className="text-xs text-amber-400 mt-0.5">Requiere revisión</p>
              </Link>
              <Link href="/devoluciones?filter=3mas-intentos" className="bg-orange-50 border border-orange-200 rounded-xl p-4 hover:shadow-sm hover:border-orange-400 transition-all block">
                <p className="text-xs text-orange-600 font-medium mb-1">3+ intentos</p>
                <p className="text-xl font-bold text-orange-800">
                  {indemnizables.filter(c => c.delivery_attempts >= 3).length}
                </p>
                <p className="text-xs text-orange-400 mt-0.5">Ver en Devoluciones →</p>
              </Link>
            </div>
            {altaProb > 0 && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm">
                <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-red-800">
                    {altaProb} devolución{altaProb !== 1 ? 'es' : ''} con alta probabilidad de indemnización.
                  </span>
                  <span className="text-red-600"> Revisar antes de cerrar el caso.</span>
                  <Link href="/devoluciones?filter=alta-indemnizacion" className="ml-2 text-red-700 font-medium underline hover:text-red-900">
                    Ver casos →
                  </Link>
                </div>
              </div>
            )}
          </section>
        )
      })()}

      {/* ══════════════════════════════════════════════════════════ */}
      {/* ── PAGOS ADMIN: Rendimiento y pagos sugeridos ───────────── */}
      {/* ══════════════════════════════════════════════════════════ */}

      {isAdmin === true && (() => {
        const agents = paymentsData?.agents ?? []
        const filteredAgents = agents.filter(a => {
          if (payFiltroRol !== 'all' && a.role !== payFiltroRol) return false
          if (payFiltroNivel !== 'all' && a.level !== payFiltroNivel) return false
          return true
        })

        const totalPago      = paymentsData?.totalPago ?? 0
        const agentesActivos = agents.length
        const mejorScore     = agents.length > 0 ? Math.max(...agents.map(a => a.score)) : 0
        const enRiesgo       = agents.filter(a => a.level === 'Riesgo' || a.level === 'Deficiente').length
        const totalEntregas  = agents.reduce((s, a) => s + agentMetrics(a).entregados, 0)
        const totalRecup     = agents.reduce((s, a) => s + agentMetrics(a).recuperados, 0)
        const totalDevueltos = agents.reduce((s, a) => s + agentMetrics(a).devueltos, 0)
        const costoPorResult = totalEntregas > 0 ? Math.round(totalPago / totalEntregas) : 0
        const insights       = generatePaymentInsights(agents)

        return (
          <>
            {/* ── Sección header ─────────────────────────────────── */}
            <section id="pagos-agentes">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
                <Banknote className="w-4 h-4 text-green-600" />
                Rendimiento y pagos sugeridos
                <span className="text-xs font-normal text-gray-400 normal-case tracking-normal">(solo admin — semana actual)</span>
              </h2>

              {paymentsLoading && !paymentsData ? (
                <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-400 text-sm">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Calculando pagos…
                </div>
              ) : (
                <>
                  {/* ── Cards resumen ───────────────────────────────── */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                    <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                      <p className="text-xs text-green-600 font-medium mb-1">Pago total sugerido</p>
                      <p className="text-xl font-bold text-green-800">{fmtDOP(totalPago)}</p>
                      <p className="text-xs text-green-500 mt-0.5">semana actual</p>
                    </div>
                    <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                      <p className="text-xs text-blue-600 font-medium mb-1">Agentes activos</p>
                      <p className="text-xl font-bold text-blue-800">{agentesActivos}</p>
                      <p className="text-xs text-blue-500 mt-0.5">con actividad</p>
                    </div>
                    <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4">
                      <p className="text-xs text-indigo-600 font-medium mb-1">Mejor score</p>
                      <p className="text-xl font-bold text-indigo-800">{mejorScore}</p>
                      <p className="text-xs text-indigo-500 mt-0.5">de 100 pts</p>
                    </div>
                    <div className={`border rounded-xl p-4 ${enRiesgo > 0 ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
                      <p className={`text-xs font-medium mb-1 ${enRiesgo > 0 ? 'text-amber-600' : 'text-gray-500'}`}>Agentes en riesgo</p>
                      <p className={`text-xl font-bold ${enRiesgo > 0 ? 'text-amber-800' : 'text-gray-700'}`}>{enRiesgo}</p>
                      <p className={`text-xs mt-0.5 ${enRiesgo > 0 ? 'text-amber-500' : 'text-gray-400'}`}>Riesgo + Deficiente</p>
                    </div>
                    <div className="bg-white border border-gray-200 rounded-xl p-4">
                      <p className="text-xs text-gray-500 font-medium mb-1">Entregas atribuidas</p>
                      <p className="text-xl font-bold text-gray-800">{totalEntregas}</p>
                      <p className="text-xs text-gray-400 mt-0.5">confirmadas por courier</p>
                    </div>
                    <div className="bg-white border border-gray-200 rounded-xl p-4">
                      <p className="text-xs text-gray-500 font-medium mb-1">Recuperaciones</p>
                      <p className="text-xl font-bold text-gray-800">{totalRecup}</p>
                      <p className="text-xs text-gray-400 mt-0.5">carritos recuperados</p>
                    </div>
                    <div className={`border rounded-xl p-4 ${totalDevueltos > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'}`}>
                      <p className={`text-xs font-medium mb-1 ${totalDevueltos > 0 ? 'text-red-600' : 'text-gray-500'}`}>Devoluciones atribuidas</p>
                      <p className={`text-xl font-bold ${totalDevueltos > 0 ? 'text-red-700' : 'text-gray-700'}`}>{totalDevueltos}</p>
                      <p className={`text-xs mt-0.5 ${totalDevueltos > 0 ? 'text-red-400' : 'text-gray-400'}`}>impacto en rentabilidad</p>
                    </div>
                    <div className="bg-white border border-gray-200 rounded-xl p-4">
                      <p className="text-xs text-gray-500 font-medium mb-1">Costo/entrega</p>
                      <p className="text-xl font-bold text-gray-800">{costoPorResult > 0 ? fmtDOP(costoPorResult) : '—'}</p>
                      <p className="text-xs text-gray-400 mt-0.5">pago ÷ entregas</p>
                    </div>
                  </div>

                  {/* ── Filtros ─────────────────────────────────────── */}
                  <div className="flex flex-wrap gap-2 mb-4">
                    <div className="flex items-center gap-1 text-xs text-gray-500 font-medium">
                      <Filter className="w-3.5 h-3.5" /> Rol:
                    </div>
                    {(['all', 'confirmation_agent', 'novelty_agent', 'delivery_agent'] as const).map(r => (
                      <button
                        key={r}
                        onClick={() => setPayFiltroRol(r)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${payFiltroRol === r ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300'}`}
                      >
                        {r === 'all' ? 'Todos' : ROL_LABEL[r]}
                      </button>
                    ))}
                    <span className="mx-1 text-gray-200">|</span>
                    <div className="flex items-center gap-1 text-xs text-gray-500 font-medium">
                      Nivel:
                    </div>
                    {(['all', 'Excelente', 'Bueno', 'Riesgo', 'Deficiente'] as const).map(n => (
                      <button
                        key={n}
                        onClick={() => setPayFiltroNivel(n)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${payFiltroNivel === n ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300'}`}
                      >
                        {n === 'all' ? 'Todos' : n}
                      </button>
                    ))}
                  </div>

                  {/* ── Tabla principal por agente ──────────────────── */}
                  {filteredAgents.length === 0 ? (
                    <div className="flex items-center gap-2 px-4 py-4 bg-gray-50 border border-gray-200 rounded-xl text-gray-400 text-sm">
                      <Users className="w-4 h-4 shrink-0" />
                      Sin agentes con los filtros seleccionados.
                    </div>
                  ) : (
                    <>
                      {/* Desktop table */}
                      <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 border-b border-gray-100">
                            <tr>
                              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Agente</th>
                              <th className="text-left px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Rol</th>
                              <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Score</th>
                              <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Nivel</th>
                              <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Entregados</th>
                              <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Recuperados</th>
                              <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Devueltos</th>
                              <th className="text-center px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">F.Cob/Crít.</th>
                              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Pago sugerido</th>
                              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Recomendación IA</th>
                              <th className="px-4 py-3"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {filteredAgents.map(agent => {
                              const m = agentMetrics(agent)
                              const rec = RECOM_META[agent.recomendacion]
                              return (
                                <tr key={agent.agentId} className="hover:bg-gray-50 transition-colors">
                                  <td className="px-4 py-3">
                                    <span className="font-medium text-gray-800">{agent.agentName ?? '—'}</span>
                                  </td>
                                  <td className="px-3 py-3 text-gray-500 text-xs">{ROL_LABEL[agent.role] ?? agent.role}</td>
                                  <td className="px-3 py-3 text-center">
                                    <span className="font-bold text-gray-800">{agent.score}</span>
                                  </td>
                                  <td className="px-3 py-3 text-center">
                                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${PAY_LEVEL_STYLE[agent.level]}`}>
                                      {agent.level}
                                    </span>
                                  </td>
                                  <td className="px-3 py-3 text-center font-medium text-gray-700">{m.entregados}</td>
                                  <td className="px-3 py-3 text-center">
                                    <span className={m.recuperados > 0 ? 'font-semibold text-emerald-700' : 'text-gray-400'}>{m.recuperados}</span>
                                  </td>
                                  <td className="px-3 py-3 text-center">
                                    <span className={m.devueltos > 0 ? 'font-semibold text-red-600' : 'text-gray-400'}>{m.devueltos}</span>
                                  </td>
                                  <td className="px-3 py-3 text-center">
                                    <span className={m.sinCobertura + m.criticos > 0 ? 'font-semibold text-amber-600' : 'text-gray-400'}>{m.sinCobertura + m.criticos}</span>
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    <span className="font-bold text-gray-900">{fmtDOP(agent.paymentEstimate)}</span>
                                  </td>
                                  <td className="px-4 py-3">
                                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${rec?.color ?? ''}`}>
                                      {rec?.label ?? agent.recomendacion}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3">
                                    <button
                                      onClick={() => setSelectedAgent(agent)}
                                      className="text-xs text-indigo-600 hover:text-indigo-800 font-medium hover:underline whitespace-nowrap"
                                    >
                                      Ver detalle →
                                    </button>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* Mobile cards */}
                      <div className="md:hidden space-y-3">
                        {filteredAgents.map(agent => {
                          const m = agentMetrics(agent)
                          const rec = RECOM_META[agent.recomendacion]
                          return (
                            <div key={agent.agentId} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                              <div className="px-4 py-3 flex items-center justify-between border-b border-gray-100">
                                <div>
                                  <p className="font-semibold text-gray-800 text-sm">{agent.agentName ?? '—'}</p>
                                  <p className="text-xs text-gray-400">{ROL_LABEL[agent.role] ?? agent.role}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${PAY_LEVEL_STYLE[agent.level]}`}>{agent.level}</span>
                                  <span className="text-sm font-bold text-gray-700">{agent.score} pts</span>
                                </div>
                              </div>
                              <div className="px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                                <div className="flex justify-between"><span className="text-gray-500 text-xs">Entregados</span><span className="font-medium">{m.entregados}</span></div>
                                <div className="flex justify-between"><span className="text-gray-500 text-xs">Recuperados</span><span className={`font-medium ${m.recuperados > 0 ? 'text-emerald-700' : 'text-gray-400'}`}>{m.recuperados}</span></div>
                                <div className="flex justify-between"><span className="text-gray-500 text-xs">Devueltos</span><span className={`font-medium ${m.devueltos > 0 ? 'text-red-600' : 'text-gray-400'}`}>{m.devueltos}</span></div>
                                <div className="flex justify-between"><span className="text-gray-500 text-xs">F.Cob/Crít.</span><span className={`font-medium ${m.sinCobertura + m.criticos > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{m.sinCobertura + m.criticos}</span></div>
                              </div>
                              <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
                                <div>
                                  <p className="text-xs text-gray-400 mb-0.5">Pago sugerido</p>
                                  <p className="font-bold text-gray-900 text-base">{fmtDOP(agent.paymentEstimate)}</p>
                                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full border ${rec?.color ?? ''}`}>{rec?.label ?? agent.recomendacion}</span>
                                </div>
                                <button
                                  onClick={() => setSelectedAgent(agent)}
                                  className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold border border-indigo-200 rounded-lg px-3 py-1.5 hover:bg-indigo-50 transition-colors"
                                >
                                  Ver detalle →
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}

                  {/* ── Nota experimental ──────────────────────────── */}
                  {paymentsData?.nota && (
                    <p className="mt-3 text-xs text-gray-400 flex items-start gap-1">
                      <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      {paymentsData.nota}
                    </p>
                  )}
                </>
              )}
            </section>

            {/* ── Insights IA admin ───────────────────────────────── */}
            {agents.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
                  <Brain className="w-4 h-4 text-indigo-500" />
                  Insights del Supervisor IA — Pagos
                </h2>
                <div className="bg-indigo-50 border border-indigo-200 rounded-xl px-5 py-4 space-y-2">
                  {insights.map((insight, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm text-indigo-900">
                      <span className="flex-shrink-0 w-5 h-5 bg-indigo-200 text-indigo-800 rounded-full text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                      <span>{insight}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Drawer detalle por agente ───────────────────────── */}
            {selectedAgent && (() => {
              const agent = selectedAgent
              const rec = RECOM_META[agent.recomendacion]
              const m = agentMetrics(agent)
              return (
                <div className="fixed inset-0 z-50 flex items-start justify-end">
                  <div className="absolute inset-0 bg-black/40" onClick={() => setSelectedAgent(null)} />
                  <div className="relative z-10 bg-white h-full w-full max-w-lg shadow-2xl overflow-y-auto flex flex-col">
                    {/* Header */}
                    <div className="sticky top-0 bg-white border-b border-gray-200 px-5 py-4 flex items-center justify-between">
                      <div>
                        <p className="font-bold text-gray-900">{agent.agentName ?? '—'}</p>
                        <p className="text-xs text-gray-400">{ROL_LABEL[agent.role] ?? agent.role} · Detalle de pago</p>
                      </div>
                      <button
                        onClick={() => setSelectedAgent(null)}
                        className="p-2 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    <div className="p-5 space-y-5 pb-10">
                      {/* Métricas principales */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-gray-50 rounded-lg p-3 text-center">
                          <p className="text-xs text-gray-400 mb-1">Score</p>
                          <p className="text-2xl font-bold text-gray-900">{agent.score}</p>
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${PAY_LEVEL_STYLE[agent.level]}`}>{agent.level}</span>
                        </div>
                        <div className="bg-green-50 rounded-lg p-3 text-center">
                          <p className="text-xs text-green-500 mb-1">Pago sugerido</p>
                          <p className="text-2xl font-bold text-green-800">{fmtDOP(agent.paymentEstimate)}</p>
                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full border ${rec?.color ?? ''}`}>{rec?.label}</span>
                        </div>
                        <div className="bg-white border border-gray-200 rounded-lg p-3 text-center">
                          <p className="text-xs text-gray-400 mb-1">Entregas</p>
                          <p className="text-xl font-bold text-gray-800">{m.entregados}</p>
                        </div>
                        <div className="bg-white border border-gray-200 rounded-lg p-3 text-center">
                          <p className="text-xs text-gray-400 mb-1">Recuperaciones</p>
                          <p className={`text-xl font-bold ${m.recuperados > 0 ? 'text-emerald-700' : 'text-gray-400'}`}>{m.recuperados}</p>
                        </div>
                        <div className="bg-white border border-gray-200 rounded-lg p-3 text-center">
                          <p className="text-xs text-gray-400 mb-1">Devueltos</p>
                          <p className={`text-xl font-bold ${m.devueltos > 0 ? 'text-red-600' : 'text-gray-400'}`}>{m.devueltos}</p>
                        </div>
                        <div className="bg-white border border-gray-200 rounded-lg p-3 text-center">
                          <p className="text-xs text-gray-400 mb-1">F.Cob / Críticos</p>
                          <p className={`text-xl font-bold ${m.sinCobertura + m.criticos > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{m.sinCobertura + m.criticos}</p>
                        </div>
                      </div>

                      {/* Explicación pago */}
                      <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                        <p className="text-xs text-blue-600 font-semibold mb-1 uppercase tracking-wide">Explicación del pago sugerido</p>
                        <p className="text-sm text-blue-900">{agent.explicacion}</p>
                      </div>

                      {/* Coaching IA */}
                      <div>
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Coaching IA</p>
                        <div className="space-y-1.5">
                          {agent.level === 'Excelente' && agent.recomendacion === 'pagar_con_bono' && (
                            <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                              Rendimiento sobresaliente. Considera un bono para mantener la motivación.
                            </p>
                          )}
                          {agent.level === 'Excelente' && agent.recomendacion === 'pagar_completo' && (
                            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                              Excelente desempeño. Pago completo recomendado sin ajustes.
                            </p>
                          )}
                          {agent.level === 'Bueno' && (
                            <p className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                              Buen rendimiento general. Hay margen para mejorar la tasa de entrega.
                            </p>
                          )}
                          {agent.level === 'Riesgo' && (
                            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                              Rendimiento en zona de riesgo. Revisar calidad de gestión antes de procesar pago.
                            </p>
                          )}
                          {agent.level === 'Deficiente' && (
                            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                              Rendimiento bajo. Conversación de coaching recomendada antes de procesar pago.
                            </p>
                          )}
                          {m.devueltos > 3 && (
                            <p className="text-sm text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                              Alta tasa de devoluciones ({m.devueltos}). Evaluar si hay patrones repetibles.
                            </p>
                          )}
                          {m.recuperados > 2 && (
                            <p className="text-sm text-teal-700 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
                              Buena recuperación de carritos ({m.recuperados}). Habilidad operativa destacada.
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Breakdown monetario */}
                      <div>
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                          Pedidos trabajados — breakdown monetario ({agent.breakdown.length})
                        </p>
                        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                          <table className="w-full text-xs">
                            <thead className="bg-gray-50 border-b border-gray-100">
                              <tr>
                                <th className="text-left px-3 py-2 font-semibold text-gray-500">Pedido</th>
                                <th className="text-left px-3 py-2 font-semibold text-gray-500">Resultado</th>
                                <th className="text-right px-3 py-2 font-semibold text-gray-500">Pago</th>
                                <th className="px-3 py-2"></th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {agent.breakdown.map(b => (
                                <tr key={b.orderId} className="hover:bg-gray-50">
                                  <td className="px-3 py-2">
                                    <p className="font-medium text-gray-700">{b.orderNumber ?? '—'}</p>
                                    <p className="text-gray-400 truncate max-w-[110px]">{b.customerName ?? ''}</p>
                                  </td>
                                  <td className="px-3 py-2">
                                    <p className="text-gray-600">{b.resultado}</p>
                                    <p className="text-gray-400 text-[10px]">{b.reason}</p>
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    <span className={`font-bold ${b.pago > 0 ? 'text-green-700' : 'text-gray-400'}`}>
                                      {b.pago > 0 ? `RD$${b.pago}` : '—'}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2">
                                    <Link
                                      href={`/orders/${b.orderId}`}
                                      className="text-indigo-500 hover:text-indigo-700"
                                      onClick={() => setSelectedAgent(null)}
                                    >
                                      <ExternalLink className="w-3.5 h-3.5" />
                                    </Link>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })()}
          </>
        )
      })()}

    </div>
  )
}
