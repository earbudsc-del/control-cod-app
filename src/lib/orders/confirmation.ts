import type { createClient } from '@/lib/supabase/server'
import { isSantoDomingoOrder } from '@/lib/alert-helpers'

// Lógica compartida del flujo de confirmación de pedidos.
// Usada por:
//   - POST /api/orders/[id]/confirmation (acción manual del agente)
//   - webhook de WhatsApp (Fase 6C — botones "Confirmar" / "No, gracias")
//
// SD V2: al confirmar un pedido de Santo Domingo sin guía EFI, se despacha
// automáticamente (normalized_status='en_reparto') en la misma transacción,
// sin importar qué canal confirmó (agente, mensajero, webhook o, a futuro,
// Génesis) — todos pasan por esta función.

export type ConfirmAction = 'confirmed' | 'no_answer' | 'wrong_number' | 'cancelled' | 'no_coverage' | 'rescheduled' | 'reopened'
export type ConfirmMethod = 'call' | 'whatsapp' | 'other'

type SupabaseClient = Awaited<ReturnType<typeof createClient>>

const MAX_ATTEMPTS = 3

function computeConfidence(
  action: ConfirmAction,
  method: ConfirmMethod,
  newAttempts: number,
  duplicateAlert: boolean,
): string {
  if (action === 'confirmed') {
    if (method === 'call') return duplicateAlert ? 'medium' : 'high'
    // whatsapp o other: duplicado baja a low
    return duplicateAlert ? 'low' : 'medium'
  }
  if (action === 'no_answer' || action === 'rescheduled') return newAttempts >= MAX_ATTEMPTS ? 'risky' : 'low'
  // wrong_number, cancelled
  return 'risky'
}

export interface ApplyConfirmationActionParams {
  supabase: SupabaseClient
  orderId:  string
  action:   ConfirmAction
  method:   ConfirmMethod
  // Solo se usa para la nota interna de 'no_coverage'. Null en flujos sin sesión (webhook).
  userId?:  string | null
  // true para flujos automáticos (webhook): exige confirmation_status='pending'
  // y bloquea pedidos ya delivered/returned. false (default) preserva el
  // comportamiento histórico del endpoint manual — el agente puede sobreescribir.
  guardAutomated?: boolean
  // Motivo obligatorio — solo se usa (y se exige) para action='reopened'.
  reason?: string
}

export type ApplyConfirmationActionResult =
  | {
      ok: true
      confirmation_attempts:   number
      confirmation_status:     string
      confirmation_confidence: string
      auto_dispatched:         boolean
    }
  | {
      ok: false
      reason:
        | 'not_found' | 'not_pending' | 'terminal_status' | 'db_error'
        // Guardas específicas de action='reopened' (ver applyReopen más abajo).
        // 'forbidden' y 'reason_too_long' se revalidan dentro del RPC — no
        // solo aquí — ver reopen_confirmed_order() en la migración 052.
        | 'reason_required' | 'reason_too_long' | 'forbidden'
        | 'not_confirmed' | 'has_tracking' | 'already_paid' | 'dispatched' | 'conflict'
    }

export async function applyConfirmationAction({
  supabase,
  orderId,
  action,
  method,
  userId = null,
  guardAutomated = false,
  reason,
}: ApplyConfirmationActionParams): Promise<ApplyConfirmationActionResult> {
  const { data: order } = await supabase
    .from('orders')
    .select('confirmation_attempts, duplicate_alert, confirmation_status, normalized_status, city, province, customer_address, tracking_number, payment_status')
    .eq('id', orderId)
    .single()

  if (!order) return { ok: false, reason: 'not_found' }

  // 'reopened' es una reversión administrativa, no un intento de contacto —
  // vive en su propia rama, ANTES de la lógica genérica de intentos/confianza
  // de abajo (que sí aplica a los 6 flujos de "intento de confirmación").
  // Nunca debe incrementar confirmation_attempts ni tocar
  // confirmation_method/confidence: no es un intento, es deshacer uno previo.
  //
  // Toda la lógica de guardas + el UPDATE de orders + el INSERT de
  // agent_actions ocurren dentro de reopen_confirmed_order() (migración 052)
  // como una única transacción de Postgres — nunca como dos escrituras
  // HTTP/PostgREST separadas. Ver esa migración para el detalle de
  // concurrencia (SELECT ... FOR UPDATE), la distinción auto-despacho vs
  // despacho local manual, y la revalidación de identidad/rol/tienda.
  //
  // userId NO se reenvía al RPC: la identidad del actor se deriva
  // exclusivamente de auth.uid() dentro de la función — nunca de un
  // parámetro del cliente (ver migración 052, sección "Seguridad de
  // identidad y RBAC"). Pasarlo aquí sería exactamente el tipo de
  // confianza ciega que esa revisión eliminó.
  if (action === 'reopened') {
    return applyReopen(supabase, orderId, reason)
  }

  if (guardAutomated) {
    if (order.confirmation_status !== 'pending') return { ok: false, reason: 'not_pending' }
    if (order.normalized_status === 'delivered' || order.normalized_status === 'returned') {
      return { ok: false, reason: 'terminal_status' }
    }
  }

  const attempts   = (order.confirmation_attempts ?? 0) + 1
  const confidence = computeConfidence(action, method, attempts, !!order.duplicate_alert)

  // 'cancelled' manual (agente humano, con sesión real — el camino normal
  // de POST /api/orders/[id]/confirmation) pasa por la RPC transaccional
  // cancel_confirmed_order() (migración 060): SELECT ... FOR UPDATE +
  // guardas + UPDATE orders + INSERT agent_actions(customer_declined)
  // ocurren en una única transacción real — antes eran dos escrituras
  // PostgREST separadas (mismo problema de atomicidad ya resuelto para
  // 'reopened' en la migración 052).
  //
  // El camino automatizado (guardAutomated=true — webhook de WhatsApp,
  // botón "No, gracias") NO pasa por aquí: corre con createServiceClient()
  // (sin sesión real → auth.uid() sería NULL dentro del RPC) y ya está
  // excluido por el guard de arriba a confirmation_status='pending' —
  // estructuralmente incompatible con normalized_status='en_reparto' (solo
  // ocurre después de confirmar), así que ese camino jamás necesita el
  // INSERT atómico de customer_declined. Sigue el switch de abajo, sin
  // cambios respecto a antes de esta migración.
  if (action === 'cancelled' && !guardAutomated) {
    return applyCancel(supabase, orderId, attempts, method, confidence)
  }

  const updates: Record<string, unknown> = {
    confirmation_attempts:     attempts,
    last_confirmation_attempt: new Date().toISOString(),
    confirmation_method:       method,
    confirmation_confidence:   confidence,
  }

  // SD V2: pedido de Santo Domingo sin guía EFI → se despacha en el mismo update.
  const isSdAutoDispatch =
    action === 'confirmed' &&
    !order.tracking_number &&
    isSantoDomingoOrder(order.city, order.province, order.customer_address)

  switch (action) {
    case 'confirmed':
      updates.confirmation_status   = 'confirmed'
      updates.customer_confirmed    = true
      updates.customer_confirmed_at = new Date().toISOString()
      if (isSdAutoDispatch) {
        updates.normalized_status = 'en_reparto'
        updates.status_since      = new Date().toISOString()
      }
      break
    case 'no_answer':
      // Solo degrada a 'unreachable' pedidos que nunca fueron confirmados.
      // Un pedido ya confirmado que no contesta un contacto de seguimiento
      // (ej. reconfirmar antes de despachar) sigue siendo 'confirmed' — este
      // intento es solo un registro de contacto, no una reversión silenciosa
      // de la confirmación (ver auditoría "conservar acciones tras confirmar",
      // 2026-08-07).
      if (attempts >= MAX_ATTEMPTS && order.confirmation_status !== 'confirmed') {
        updates.confirmation_status = 'unreachable'
      }
      break
    case 'wrong_number':
      updates.confirmation_status = 'unreachable'
      break
    case 'cancelled':
      // Solo alcanzable aquí con guardAutomated=true (automatización sin
      // sesión real — ver el early-return de applyCancel() más arriba para
      // el camino manual, migración 060). Comportamiento sin cambios
      // respecto a antes de esa migración: mismas guardas, mismo UPDATE
      // directo — este camino nunca inserta agent_actions(customer_declined)
      // porque guardAutomated ya exige confirmation_status='pending' arriba,
      // estructuralmente incompatible con normalized_status='en_reparto'.
      if (order.normalized_status === 'delivered' || order.normalized_status === 'returned') {
        return { ok: false, reason: 'terminal_status' }
      }
      if (order.payment_status === 'paid') {
        return { ok: false, reason: 'already_paid' }
      }
      if (order.tracking_number) {
        return { ok: false, reason: 'has_tracking' }
      }
      updates.confirmation_status = 'cancelled'
      updates.customer_confirmed  = false
      break
    case 'no_coverage':
      updates.confirmation_status = 'no_coverage'
      break
    case 'rescheduled':
      // confirmation_status no se toca — sea cual sea el estado actual
      // (pending para seguimiento, o confirmed si el cliente ya había
      // confirmado y ahora hay que reprogramar la entrega), reprogramar
      // nunca deshace una confirmación previa.
      break
  }

  const { error } = await supabase.from('orders').update(updates).eq('id', orderId)
  if (error) {
    console.error('[confirmation] Supabase update error — action:', action, '| code:', error.code, '| message:', error.message, '| details:', error.details)
    return { ok: false, reason: 'db_error' }
  }

  if (action === 'no_coverage' && userId) {
    await supabase.from('notes').insert({
      order_id:   orderId,
      created_by: userId,
      content:    'Pedido marcado como Sin cobertura',
    })
  }

  if (action === 'rescheduled' && userId) {
    await supabase.from('agent_actions').insert({
      order_id:    orderId,
      agent_id:    userId,
      action_type: 'rescheduled',
    })
  }

  // Nota: 'cancelled' ya NO inserta agent_actions(customer_declined) aquí —
  // ese INSERT vive ahora dentro de cancel_confirmed_order() (migración
  // 060), atómico con el UPDATE de orders. El único caller que llega a este
  // punto del código para 'cancelled' es el camino automatizado
  // (guardAutomated=true), que por construcción nunca tiene
  // normalized_status='en_reparto' (ver comentario en applyCancel más
  // arriba) — nunca habría necesitado ese INSERT de todas formas.

  if (isSdAutoDispatch && userId) {
    await supabase.from('agent_actions').insert({
      order_id:    orderId,
      agent_id:    userId,
      action_type: 'local_dispatched',
      notes:       'Auto-despachado al confirmar — pedido SD sin guía EFI',
    })
  }

  return {
    ok: true,
    confirmation_attempts:   attempts,
    // 'no_answer' (sin degradar) y 'rescheduled' no incluyen
    // confirmation_status en `updates` a propósito — no lo tocan en DB. El
    // fallback debe reflejar lo que YA HABÍA en la fila (order.confirmation_status),
    // no asumir 'pending': desde que estas dos acciones también se aplican
    // sobre pedidos ya confirmados (ver auditoría "conservar acciones tras
    // confirmar", 2026-08-07), asumir 'pending' aquí le mentiría al caller
    // sobre un pedido que sigue 'confirmed' en la base de datos.
    confirmation_status:     (updates.confirmation_status as string | undefined) ?? order.confirmation_status ?? 'pending',
    confirmation_confidence: confidence,
    auto_dispatched:         isSdAutoDispatch,
  }
}

// Únicos outcomes que el RPC puede devolver además de 'ok' — deben
// mantenerse en sincronía exacta con los RETURN de
// supabase/migrations/052_reopen_confirmed_order_rpc.sql.
function isKnownReopenFailure(
  value: string,
): value is
  | 'not_found' | 'not_confirmed' | 'has_tracking' | 'already_paid' | 'terminal_status' | 'dispatched'
  | 'forbidden' | 'reason_required' | 'reason_too_long' {
  return (
    value === 'not_found' || value === 'not_confirmed' || value === 'has_tracking' ||
    value === 'already_paid' || value === 'terminal_status' || value === 'dispatched' ||
    value === 'forbidden' || value === 'reason_required' || value === 'reason_too_long'
  )
}

// Únicos outcomes que cancel_confirmed_order() puede devolver además de
// 'ok' — deben mantenerse en sincronía exacta con los RETURN de
// supabase/migrations/060_cancel_confirmed_order_rpc.sql.
function isKnownCancelFailure(
  value: string,
): value is 'not_found' | 'forbidden' | 'already_paid' | 'has_tracking' | 'terminal_status' {
  return (
    value === 'not_found' || value === 'forbidden' ||
    value === 'already_paid' || value === 'has_tracking' || value === 'terminal_status'
  )
}

// "Ya no desea" (manual, agente humano) — auditoría "conservar acciones
// tras confirmar" (2026-08-07), corrección de atomicidad (misma sesión,
// ronda 3). Antes de esta función, el case 'cancelled' hacía UPDATE orders
// + (cuando correspondía) INSERT agent_actions(customer_declined) como dos
// escrituras HTTP/PostgREST separadas — mismo problema ya resuelto para
// 'reopened' abajo. Vive dentro de este archivo — no es un motor nuevo —
// para respetar el Principio 4 de docs/ARCHITECTURE_RUTA_COD_V1.md:
// applyConfirmationAction() sigue siendo el único punto de entrada de la
// aplicación autorizado a mover confirmation_status. cancel_confirmed_order()
// es solo el mecanismo de persistencia — todas las guardas de negocio viven
// en el RPC (migración 060), revalidadas bajo lock, no solo aquí.
//
// attempts/method/confidence se calculan en TypeScript (computeConfidence
// es lógica de negocio pura, no algo que deba reimplementarse en SQL) y se
// pasan como parámetros — el RPC no decide nada de eso, solo persiste.
async function applyCancel(
  supabase: SupabaseClient,
  orderId: string,
  attempts: number,
  method: ConfirmMethod,
  confidence: string,
): Promise<ApplyConfirmationActionResult> {
  const { data, error } = await supabase.rpc('cancel_confirmed_order', {
    p_order_id:   orderId,
    p_attempts:   attempts,
    p_method:     method,
    p_confidence: confidence,
  })

  if (error) {
    console.error('[confirmation] cancel RPC error — order:', orderId, '| code:', error.code, '| message:', error.message)
    return { ok: false, reason: 'db_error' }
  }

  const outcome = data as string

  if (outcome === 'ok') {
    return {
      ok: true,
      confirmation_attempts:   attempts,
      confirmation_status:     'cancelled',
      confirmation_confidence: confidence,
      auto_dispatched:         false,
    }
  }

  if (isKnownCancelFailure(outcome)) return { ok: false, reason: outcome }

  // Cualquier valor no reconocido del RPC (nunca debería ocurrir si esta
  // función y la migración 060 están sincronizadas) se trata como conflicto
  // defensivo — nunca como éxito silencioso.
  console.error('[confirmation] cancel RPC devolvió un outcome inesperado:', outcome, '— order:', orderId)
  return { ok: false, reason: 'conflict' }
}

// "Reabrir pedido" — Fase 1 de la auditoría de deshacer-confirmación
// (2026-07-31). Reversión administrativa de una confirmación hecha por
// error: el pedido vuelve al flujo comercial (confirmation_status='pending'),
// nunca se borra su historial. Vive dentro de este archivo — no es un motor
// nuevo — para respetar el Principio 4 de docs/ARCHITECTURE_RUTA_COD_V1.md:
// applyConfirmationAction() sigue siendo el único punto de entrada de la
// aplicación autorizado a mover confirmation_status.
//
// La escritura real (revalidar guardas + UPDATE orders + INSERT
// agent_actions) ocurre dentro de reopen_confirmed_order() — una sola
// invocación de función de Postgres, es decir una única transacción real.
// Esto es deliberado, no un capricho: dos llamadas HTTP/PostgREST separadas
// (UPDATE y luego INSERT) permitían un fallo parcial real — el UPDATE podía
// tener éxito y el INSERT fallar después, dejando el pedido reabierto sin
// ningún registro de auditoría. Con el RPC, si el INSERT falla, Postgres
// revierte también el UPDATE de la misma invocación — no hay estado
// intermedio posible.
async function applyReopen(
  supabase: SupabaseClient,
  orderId: string,
  reason: string | undefined,
): Promise<ApplyConfirmationActionResult> {
  const trimmedReason = reason?.trim() ?? ''
  // Atajo de UX: evita un round-trip de red para el caso más común (textarea
  // vacío). No es la validación que realmente protege la integridad de los
  // datos — el RPC vuelve a exigir esto mismo (motivo no vacío + longitud
  // máxima) de forma autoritativa, sin confiar en que esta rama se haya
  // ejecutado (ver migración 052). Tampoco se valida userId aquí: la
  // identidad y el rol del actor se derivan de auth.uid() DENTRO del RPC,
  // nunca de un parámetro — no hay nada que este archivo pueda "confiar"
  // sobre quién llama más allá de invocar el RPC y dejar que él decida.
  if (!trimmedReason) return { ok: false, reason: 'reason_required' }

  const { data, error } = await supabase.rpc('reopen_confirmed_order', {
    p_order_id: orderId,
    p_reason:   trimmedReason,
  })

  if (error) {
    console.error('[confirmation] reopen RPC error — order:', orderId, '| code:', error.code, '| message:', error.message)
    return { ok: false, reason: 'db_error' }
  }

  const outcome = data as string

  if (outcome === 'ok') {
    return {
      ok: true,
      // 'reopened' nunca incrementa confirmation_attempts (no es un
      // intento de contacto) — no hay un valor significativo que devolver
      // aquí más allá de un placeholder; el caller (route.ts) no depende
      // de este campo para 'reopened'.
      confirmation_attempts:   0,
      confirmation_status:     'pending',
      confirmation_confidence: 'n/a',
      auto_dispatched:         false,
    }
  }

  if (isKnownReopenFailure(outcome)) return { ok: false, reason: outcome }

  // Cualquier valor no reconocido del RPC (nunca debería ocurrir si esta
  // función y la migración 052 están sincronizadas) se trata como conflicto
  // defensivo — nunca como éxito silencioso.
  console.error('[confirmation] reopen RPC devolvió un outcome inesperado:', outcome, '— order:', orderId)
  return { ok: false, reason: 'conflict' }
}
