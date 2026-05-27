// ── Constantes y tipos del dispatch_agent ─────────────────────────────────────
// IMPORTANTE: este archivo NO puede importar nada de next/headers ni supabase/server.
// Lo usan tanto el API route (server) como el componente client RendimientoDespacho.

// ── Constantes operativas ─────────────────────────────────────────────────────

export const DISPATCH_META_DIARIA  = 10   // pedidos procesados / día
export const DISPATCH_META_SEMANAL = 50   // pedidos procesados / semana
export const DISPATCH_SLA_HORAS    = 4    // objetivo: despacho en ≤4h

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type DispatchLevel = 'Excelente' | 'Bueno' | 'Riesgo' | 'Deficiente'

export interface DispatchScoreData {
  // Agente
  agentName: string

  // Conteos diarios — hoy
  confirmadosProcesadosHoy:  number   // guiasEFI + despachosLocales hoy
  guiasEFIAsignadasHoy:      number
  despachosLocalesHoy:       number

  // Conteos — ayer (para comparación)
  confirmadosProcesadosAyer: number
  guiasEFIAsignadasAyer:     number
  despachosLocalesAyer:      number

  // Conteos semanales
  confirmadosSemana:         number
  guiasEFISemana:            number
  despachosLocalesSemana:    number

  // Backlog (toda la tienda — no solo del agente)
  pendientesSinGuia: number   // confirmed, sin guía, no despachado aún
  backlog24h:        number   // ídem pero llevan >24h esperando

  // Tiempo promedio confirmado → despachado (en minutos, null si sin datos)
  avgDispatchTimeMinutes: number | null

  // Score operativo (0–100, sin dinero)
  score: number
  level: DispatchLevel

  // Dimensiones del score (para mostrar desglose)
  scoreVolumen:   number   // 0–40
  scoreVelocidad: number   // 0–20
  scoreBacklog:   number   // 0–30
  scoreBase:      number   // 10 fijo

  // Progreso de metas
  metaDiaria:           number
  metaSemanal:          number
  progresoMetaDiaria:   number   // % 0–100
  progresoMetaSemanal:  number   // % 0–100

  // Productividad semanal (últimos 7 días)
  weeklyActivity: Array<{
    dayLabel:  string   // 'Lun', 'Mar', etc.
    dateKey:   string   // 'YYYY-MM-DD' (RD)
    processed: number
  }>

  // Alertas operativas
  alerts: Array<{
    type:    'danger' | 'warning' | 'success' | 'info'
    icon:    string
    message: string
  }>

  // Coaching / motivación
  coaching: string[]

  // Actividad reciente (últimas acciones del agente)
  recentActivity: Array<{
    orderId:     string
    orderNumber: string | null
    actionType:  'tracking_assigned' | 'local_dispatched'
    createdAt:   string
    notes:       string | null
  }>
}
