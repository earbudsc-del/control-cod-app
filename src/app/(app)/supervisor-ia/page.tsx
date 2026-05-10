'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Brain, RefreshCw, AlertTriangle, CheckCircle2, Package,
  Bike, AlertCircle, Box, ShoppingCart, MapPinOff, ExternalLink,
  ChevronDown, ChevronUp, TrendingUp, Clock, Truck,
  ClipboardList, FileWarning, CircleDollarSign, ArrowRight,
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
  const [data, setData]           = useState<MetricsData | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [showIndemn, setShowIndemn] = useState(false)

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

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

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

  const recomendaciones = generarRecomendaciones(data)
  const { resumen, prioridades } = generarReporte(data)
  const criticasCount   = recomendaciones.filter(r => r.prioridad === 'crítica').length

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
            onClick={fetchData}
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
