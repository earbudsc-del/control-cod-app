import type { SupabaseClient } from '@supabase/supabase-js'
import { parseEFITracking } from './efi-parser'
import { parseEFIDate } from './parse-efi-date'

const EFI_BASE = 'https://effi.com.co/tracking/index'

export interface UpdateResult {
  success:             boolean
  orderId:             string
  error?:              string
  normalized_status?:  string
  delivery_attempts?:  number
  last_attempt_reason: string | null
}

function isValidEstadoText(s: string | null): boolean {
  if (!s) return false
  const n = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  return !n.includes('histor') && !n.includes('novedades')
}

export async function updateOrderTracking(
  orderId:        string,
  trackingNumber: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:       SupabaseClient<any>,
): Promise<UpdateResult> {
  const efiUrl = `${EFI_BASE}/${encodeURIComponent(trackingNumber.trim())}`

  let html: string
  try {
    const res = await fetch(efiUrl, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-419,es;q=0.9',
        'Cache-Control':   'no-cache',
      },
      cache:  'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      return { success: false, orderId, error: `EFI HTTP ${res.status}`, last_attempt_reason: null }
    }
    html = await res.text()
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error de red'
    return { success: false, orderId, error: `No se pudo consultar EFI: ${msg}`, last_attempt_reason: null }
  }

  const tracking = parseEFITracking(html, trackingNumber)
  if (!tracking.encontrado) {
    return { success: false, orderId, error: 'Guía no encontrada en EFI', last_attempt_reason: null }
  }

  const updates: Record<string, unknown> = {
    normalized_status:    tracking.normalized_status,
    delivery_attempts:    tracking.attempts,
    last_tracking_update: new Date().toISOString(),
  }

  if (tracking.estado_actual && isValidEstadoText(tracking.estado_actual)) {
    updates.raw_status = tracking.estado_actual
  }
  if (tracking.last_attempt_reason)            updates.last_attempt_reason  = tracking.last_attempt_reason
  if (tracking.historial_estados.length  > 0)  updates.tracking_history     = tracking.historial_estados
  if (tracking.historial_novedades.length > 0) updates.tracking_novedades   = tracking.historial_novedades

  // ── Fechas reales de eventos EFI ────────────────────────────────────────────
  // Cada campo solo se incluye en el UPDATE si el parser devuelve una fecha válida.
  // parseEFIDate retorna null ante cualquier string vacío o formato desconocido.

  // shipment_created_at: fecha de creación del envío en la transportadora
  const shipmentCreatedAt = parseEFIDate(tracking.fecha_creacion)
  if (shipmentCreatedAt) updates.shipment_created_at = shipmentCreatedAt

  // last_novedad_at: fecha del último intento fallido / novedad según EFI
  // Usa el mismo índice que ya usa el parser para last_attempt_reason
  const lastNovedad   = tracking.historial_novedades.at(-1)
  const lastNovedadAt = parseEFIDate(lastNovedad?.fecha)
  if (lastNovedadAt) updates.last_novedad_at = lastNovedadAt

  // status_since: fecha en que EFI registró el estado actual
  // EFI devuelve historial_estados en orden descendente (más reciente primero)
  const firstEstado = tracking.historial_estados.at(0)
  const statusSince = parseEFIDate(firstEstado?.fecha)
  if (statusSince) updates.status_since = statusSince

  const { error: updateErr } = await supabase
    .from('orders')
    .update(updates)
    .eq('id', orderId)

  if (updateErr) {
    return { success: false, orderId, error: updateErr.message, last_attempt_reason: null }
  }

  // Fallback: si el pedido quedó en novedad pero no hay fecha real de EFI,
  // fijar last_novedad_at = ahora — solo si el campo sigue NULL en DB.
  // El filtro .is() garantiza que nunca pisamos un valor ya existente.
  if (tracking.normalized_status === 'novedad' && !lastNovedadAt) {
    await supabase
      .from('orders')
      .update({ last_novedad_at: new Date().toISOString() })
      .eq('id', orderId)
      .is('last_novedad_at', null)
  }

  return {
    success:             true,
    orderId,
    normalized_status:   tracking.normalized_status,
    delivery_attempts:   tracking.attempts,
    last_attempt_reason: tracking.last_attempt_reason,
  }
}
