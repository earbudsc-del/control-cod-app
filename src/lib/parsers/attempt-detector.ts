import type { NormalizedStatus } from '@/types'

export interface StatusPattern {
  pattern: string
  normalized_status: NormalizedStatus
  attempt_increment: number
  is_at_risk_trigger: boolean
  priority: number
}

export interface DetectionResult {
  normalized_status: NormalizedStatus
  attempt_increment: number
  is_at_risk: boolean
  explicit_attempt_count: number | null
}

// Patrones por defecto — en producción se leen de la base de datos
export const DEFAULT_PATTERNS: StatusPattern[] = [
  { pattern: 'entregado',               normalized_status: 'delivered',        attempt_increment: 0, is_at_risk_trigger: false, priority: 10 },
  { pattern: 'devuelto',                normalized_status: 'returned',         attempt_increment: 0, is_at_risk_trigger: true,  priority: 10 },
  { pattern: 'devuelta',                normalized_status: 'returned',         attempt_increment: 0, is_at_risk_trigger: true,  priority: 10 },
  { pattern: 'devolucion',              normalized_status: 'returned',         attempt_increment: 0, is_at_risk_trigger: true,  priority: 10 },
  { pattern: 'devolución',              normalized_status: 'returned',         attempt_increment: 0, is_at_risk_trigger: true,  priority: 10 },
  { pattern: 'entregada a origen',      normalized_status: 'returned',         attempt_increment: 0, is_at_risk_trigger: true,  priority: 10 },
  { pattern: 'dev. entregada a origen', normalized_status: 'returned',         attempt_increment: 0, is_at_risk_trigger: true,  priority: 10 },
  { pattern: 'retornado',               normalized_status: 'returned',         attempt_increment: 0, is_at_risk_trigger: true,  priority: 10 },
  { pattern: 'retorno',                 normalized_status: 'returned',         attempt_increment: 0, is_at_risk_trigger: true,  priority: 10 },
  { pattern: 'regresado',               normalized_status: 'returned',         attempt_increment: 0, is_at_risk_trigger: true,  priority: 10 },
  { pattern: 'cancelada por transportadora', normalized_status: 'returned',    attempt_increment: 0, is_at_risk_trigger: true,  priority: 10 },
  { pattern: 'tercer intento',          normalized_status: 'failed_attempt',   attempt_increment: 0, is_at_risk_trigger: true,  priority: 9  },
  { pattern: '3er intento',             normalized_status: 'failed_attempt',   attempt_increment: 0, is_at_risk_trigger: true,  priority: 9  },
  { pattern: 'segundo intento',         normalized_status: 'failed_attempt',   attempt_increment: 0, is_at_risk_trigger: true,  priority: 9  },
  { pattern: '2do intento',             normalized_status: 'failed_attempt',   attempt_increment: 0, is_at_risk_trigger: true,  priority: 9  },
  { pattern: 'primer intento',          normalized_status: 'failed_attempt',   attempt_increment: 0, is_at_risk_trigger: true,  priority: 8  },
  { pattern: '1er intento',             normalized_status: 'failed_attempt',   attempt_increment: 0, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'no contacto',             normalized_status: 'failed_attempt',   attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'no localizado',           normalized_status: 'failed_attempt',   attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'cliente ausente',         normalized_status: 'failed_attempt',   attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'no fue posible entregar', normalized_status: 'failed_attempt',   attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'no se pudo entregar',     normalized_status: 'failed_attempt',   attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'intento fallido',         normalized_status: 'failed_attempt',   attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'visitado',                normalized_status: 'failed_attempt',   attempt_increment: 1, is_at_risk_trigger: true,  priority: 7  },
  { pattern: 'domicilio cerrado',       normalized_status: 'failed_attempt',   attempt_increment: 1, is_at_risk_trigger: true,  priority: 7  },
  { pattern: 'nadie en casa',           normalized_status: 'failed_attempt',   attempt_increment: 1, is_at_risk_trigger: true,  priority: 7  },
  { pattern: 'novedad',                  normalized_status: 'novedad',          attempt_increment: 1, is_at_risk_trigger: true,  priority: 9  },
  { pattern: 'ausente',                  normalized_status: 'novedad',          attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'zona peligrosa',           normalized_status: 'novedad',          attempt_increment: 1, is_at_risk_trigger: true,  priority: 9  },
  { pattern: 'devuelto por novedad',     normalized_status: 'novedad',          attempt_increment: 1, is_at_risk_trigger: true,  priority: 9  },
  { pattern: 'dirección incorrecta',     normalized_status: 'novedad',          attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'direccion incorrecta',     normalized_status: 'novedad',          attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'dirección no encontrada',  normalized_status: 'novedad',          attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'direccion no encontrada',  normalized_status: 'novedad',          attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'rechazado',                normalized_status: 'novedad',          attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'rehusado',                 normalized_status: 'novedad',          attempt_increment: 1, is_at_risk_trigger: true,  priority: 8  },
  { pattern: 'para entrega hoy',        normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 8  },
  { pattern: 'en reparto',              normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 7  },
  { pattern: 'en_reparto',              normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 7  },
  { pattern: 'salió para entrega',      normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 7  },
  { pattern: 'en entrega',              normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 7  },
  { pattern: 'reparto',                 normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 6  },
  { pattern: 'en despacho',             normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 6  },
  { pattern: 'en ruta',                 normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 6  },
  { pattern: 'en camino',               normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 6  },
  { pattern: 'salió a reparto',         normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 6  },
  { pattern: 'con mensajero',           normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 6  },
  { pattern: 'despacho',                normalized_status: 'en_reparto',       attempt_increment: 0, is_at_risk_trigger: false, priority: 5  },
  { pattern: 'reprogramado',            normalized_status: 'out_for_delivery', attempt_increment: 0, is_at_risk_trigger: false, priority: 6  },
  { pattern: 'en tránsito',             normalized_status: 'in_transit',       attempt_increment: 0, is_at_risk_trigger: false, priority: 4  },
  { pattern: 'en transito',             normalized_status: 'in_transit',       attempt_increment: 0, is_at_risk_trigger: false, priority: 4  },
  { pattern: 'recibido en agencia',     normalized_status: 'in_transit',       attempt_increment: 0, is_at_risk_trigger: false, priority: 4  },
  { pattern: 'recibido',                normalized_status: 'in_transit',       attempt_increment: 0, is_at_risk_trigger: false, priority: 3  },
  { pattern: 'generada',               normalized_status: 'in_transit',       attempt_increment: 0, is_at_risk_trigger: false, priority: 3  },
  { pattern: 'procesando',             normalized_status: 'pending',          attempt_increment: 0, is_at_risk_trigger: false, priority: 2  },
  { pattern: 'pendiente',               normalized_status: 'pending',          attempt_increment: 0, is_at_risk_trigger: false, priority: 2  },
  { pattern: 'en espera',               normalized_status: 'pending',          attempt_increment: 0, is_at_risk_trigger: false, priority: 2  },
]

function extractExplicitAttemptCount(text: string): number | null {
  const lower = text.toLowerCase()
  if (lower.includes('tercer intento') || lower.includes('3er intento') || /3\.?\s*intento/.test(lower)) return 3
  if (lower.includes('segundo intento') || lower.includes('2do intento') || /2\.?\s*intento/.test(lower)) return 2
  if (lower.includes('primer intento') || lower.includes('1er intento') || /1\.?\s*intento/.test(lower)) return 1
  return null
}

export function detectStatus(
  rawStatus: string,
  patterns: StatusPattern[] = DEFAULT_PATTERNS,
): DetectionResult {
  if (!rawStatus?.trim()) {
    return { normalized_status: 'unknown', attempt_increment: 0, is_at_risk: false, explicit_attempt_count: null }
  }

  const lower = rawStatus.toLowerCase().trim()
  const sorted = [...patterns].sort((a, b) => b.priority - a.priority)

  for (const p of sorted) {
    if (lower.includes(p.pattern.toLowerCase())) {
      const explicit = extractExplicitAttemptCount(lower)
      return {
        normalized_status: p.normalized_status,
        attempt_increment: explicit !== null ? 0 : p.attempt_increment,
        is_at_risk: p.is_at_risk_trigger,
        explicit_attempt_count: explicit,
      }
    }
  }

  return { normalized_status: 'unknown', attempt_increment: 0, is_at_risk: false, explicit_attempt_count: null }
}
