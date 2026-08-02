// Customer Intelligence Engine — Fase 1 (identidad), corrección
// transaccional.
//
// IMPORTANTE: esta función no se invoca desde ningún webhook, endpoint ni
// componente todavía. Existe como infraestructura lista para conectarse en
// una fase futura autorizada explícitamente — no toca orders, wa_contacts,
// ni ningún flujo existente.
//
// Wrapper delgado sobre la RPC transaccional
// resolve_customer_identity(p_store_id, p_value_normalized, p_source,
// p_full_name, p_email) — ver
// supabase/migrations/054_resolve_customer_identity_rpc.sql. Toda la
// lógica de resolución/creación/concurrencia vive en esa función SQL, en
// una sola transacción — este archivo solo normaliza el teléfono y mapea
// la respuesta de la RPC a un contrato TypeScript tipado.
//
// Requiere una sesión de usuario autenticada (no service_role, no
// anónima) — la RPC la rechaza explícitamente con outcome='forbidden' en
// esos casos. Ver la nota "Compatibilidad futura" en la migración 054
// para cómo evolucionará esto hacia webhooks sin debilitar este contrato.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/customers/normalize-phone'
import type { CustomerIdentifierSource } from '@/types'

export interface ResolveCustomerParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:  SupabaseClient<any>
  storeId:   string
  phoneRaw:  string
  source:    CustomerIdentifierSource
  fullName?: string | null
  email?:    string | null
}

/**
 * Razones de fallo. Las primeras 4 son exactamente los `reason` que puede
 * devolver normalizePhone() — no se agrega ningún valor que el helper no
 * use ('invalid_country_code'/'invalid_format' NO existen en
 * normalizePhone(), por eso no aparecen aquí). El resto son outcomes de la
 * RPC (ver 054_resolve_customer_identity_rpc.sql).
 */
export type ResolveCustomerFailureReason =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'ambiguous_country_code'
  | 'forbidden'
  | 'store_mismatch'
  | 'invalid_input'
  | 'db_error'

export type ResolveCustomerResult =
  | {
      ok:              true
      customerId:      string
      created:         boolean
      /** Mismo formato que se persiste en DB — 11 dígitos sin '+' para RD,
       *  E.164 sin '+' en general (ver normalize-phone.ts). */
      normalizedPhone: string
    }
  | {
      ok:      false
      reason:  ResolveCustomerFailureReason
      message?: string
    }

interface RpcRow {
  customer_id: string | null
  created:     boolean
  outcome:     'found' | 'created' | 'conflict_recovered' | 'forbidden' | 'store_mismatch' | 'invalid_input' | 'db_error'
  message:     string | null
}

/**
 * Resuelve la identidad de un cliente a partir de un teléfono, creando el
 * customer + su identifier primario si no existía. Transaccional y seguro
 * ante concurrencia — ver 054_resolve_customer_identity_rpc.sql (advisory
 * lock + recuperación de unique_violation dentro de un único bloque
 * transaccional, nunca deja un customer huérfano).
 */
export async function resolveOrCreateCustomer(
  params: ResolveCustomerParams,
): Promise<ResolveCustomerResult> {
  const { supabase, storeId, phoneRaw, source, fullName = null, email = null } = params

  const phone = normalizePhone(phoneRaw)
  if (!phone.valid || !phone.normalized_e164) {
    return {
      ok:     false,
      reason: (phone.reason ?? 'empty') as ResolveCustomerFailureReason,
    }
  }

  // Mismo formato (sin '+') que ya usan orders.customer_phone y
  // wa_contacts.phone_normalized para RD — sin el '+' de E.164 para máxima
  // compatibilidad hacia adelante con esos campos.
  const valueNormalized = phone.normalized_e164.replace('+', '')

  const { data, error } = await supabase
    .rpc('resolve_customer_identity', {
      p_store_id:         storeId,
      p_value_normalized: valueNormalized,
      p_source:           source,
      p_full_name:        fullName,
      p_email:            email,
    })
    .single<RpcRow>()

  if (error) {
    // Fallo de transporte/infra (RPC no encontrada, red, etc.) — no un
    // outcome de negocio devuelto por la función. La función misma nunca
    // lanza excepciones SQL crudas (ver WHEN OTHERS en la migración), así
    // que llegar aquí significa que ni siquiera se pudo invocar.
    return { ok: false, reason: 'db_error', message: error.message }
  }

  if (!data) {
    return { ok: false, reason: 'db_error', message: 'La RPC no devolvió resultado.' }
  }

  if (data.outcome === 'found' || data.outcome === 'created' || data.outcome === 'conflict_recovered') {
    if (!data.customer_id) {
      return { ok: false, reason: 'db_error', message: 'La RPC devolvió un outcome exitoso sin customer_id.' }
    }
    return {
      ok:              true,
      customerId:      data.customer_id,
      created:         data.outcome === 'created',
      normalizedPhone: valueNormalized,
    }
  }

  return {
    ok:      false,
    reason:  data.outcome,
    message: data.message ?? undefined,
  }
}
