import type { createServiceClient } from '@/lib/supabase/server'

type SupabaseClient = Awaited<ReturnType<typeof createServiceClient>>

export interface AgentActionRow {
  order_id: string
  action_type: string
  contact_result: string | null
  created_at: string
}

// Mismos 4 action_type que reduceLatestActions() (src/lib/deliveries/sd-status.ts)
// realmente consume — el resto del historial de agent_actions (note_added,
// delivered, confirmed, paid, local_dispatched, reopened, ...) es irrelevante
// para el estado que expone Ruta COD y nunca se pide.
const RELEVANT_ACTION_TYPES = ['route_confirmed', 'rescheduled', 'customer_declined', 'contacted'] as const

// Tamaño máximo de order_id por chunk. Reproducido empíricamente contra
// producción (Sprint Crítico 3, solo lectura, sin escrituras): la misma
// query con .in('order_id', [...]) construye una URL para PostgREST/Kong
// cuyo tamaño crece con la cantidad de IDs — a partir de ~400 IDs (~15KB de
// query string) la request falla con `TypeError: fetch failed` (fallo de
// transporte, no un error HTTP limpio de Postgres); con 300 IDs (~11.7KB)
// todavía funcionaba. 100 IDs (~3.9-4KB) deja margen amplio bajo ese umbral
// incluso si el volumen real de pedidos SD sigue creciendo. No es un valor
// arbitrario — ver auditoría del Sprint Crítico 3 para la tabla de medición
// completa por volumen.
export const AGENT_ACTIONS_CHUNK_SIZE = 100

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export interface LoadAgentActionsOptions {
  chunkSize?: number
  // Corte de fecha opcional (ISO string) — cuando se provee, cada chunk
  // agrega `.gte('created_at', since)` ADEMÁS de los filtros existentes
  // (order_id + action_type). Ausente = comportamiento idéntico al de
  // siempre, sin corte de fecha. Añadido para reusar este helper en
  // POST /api/v1/deliveries/routes/[id]/complete, que necesita exactamente
  // esa ventana de 7 días y antes duplicaba el patrón .in() sin chunking
  // porque el helper no lo soportaba.
  since?: string
}

// Carga agent_actions para un conjunto de orderIds de cualquier tamaño sin
// construir el .in() gigante que rompe a nivel de transporte HTTP con alto
// volumen (ver AGENT_ACTIONS_CHUNK_SIZE arriba). Reemplaza la única query
// .in(orderIds) que antes vivía inline en GET /api/v1/deliveries/orders.
//
// Secuencial a propósito — NO Promise.all de los chunks. Con miles de
// pedidos, lanzar N chunks en paralelo sin límite solo traslada el cuello
// de botella de "una URL gigante" a "N conexiones simultáneas sin control";
// secuencial es la opción más simple que no introduce ese problema nuevo.
// El costo es latencia (unos pocos cientos de ms extra por chunk), no
// escalabilidad — aceptable para un endpoint con polling de 15s
// (pollAfterSeconds) y no bloqueante para el usuario final.
//
// No traga errores: si CUALQUIER chunk falla, la función lanza de inmediato
// — reduceLatestActions() necesita el conjunto COMPLETO de acciones para
// calcular el estado correcto de cada pedido (cancelado/en_ruta/no_responde/
// reprogramado dependen todos de esto). Un resultado parcial silencioso
// sería peor que ningún resultado: pedidos reales quedarían mostrando un
// estado comercial incorrecto en vez de que el endpoint falle visiblemente.
// El caller (GET /api/v1/deliveries/orders) decide qué HTTP status devolver
// ante ese fallo — ver comentario ahí.
//
// Retrocompatible: los 4 callers existentes (a la fecha de este cambio)
// llaman `loadAgentActionsForOrders(client, orderIds)` sin tercer argumento
// — ninguno pasaba `chunkSize` como número posicional, así que cambiar ese
// parámetro de `number` a `LoadAgentActionsOptions` no rompe ningún call
// site real (verificado con grep antes de este cambio).
export async function loadAgentActionsForOrders(
  supabase: SupabaseClient,
  orderIds: string[],
  options: LoadAgentActionsOptions = {},
): Promise<AgentActionRow[]> {
  if (orderIds.length === 0) return []

  const { chunkSize = AGENT_ACTIONS_CHUNK_SIZE, since } = options
  const idChunks = chunk(orderIds, chunkSize)
  const allRows: AgentActionRow[] = []

  for (const ids of idChunks) {
    let query = supabase
      .from('agent_actions')
      .select('order_id, action_type, contact_result, created_at')
      .in('order_id', ids)
      .in('action_type', RELEVANT_ACTION_TYPES)

    if (since) query = query.gte('created_at', since)

    const { data, error } = await query.order('created_at', { ascending: false })

    if (error) {
      throw new Error(`agent_actions chunk falló (${ids.length} ids): ${error.message}`)
    }
    allRows.push(...((data ?? []) as AgentActionRow[]))
  }

  // reduceLatestActions() asume que la primera fila que ve por order_id es
  // la más reciente — cada chunk llega ya ordenado desc, pero concatenar
  // varios chunks en secuencia NO garantiza que el arreglo combinado quede
  // globalmente ordenado por created_at. Se reordena una sola vez sobre el
  // total antes de devolver.
  allRows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  return allRows
}
