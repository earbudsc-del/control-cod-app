// Sprint Broadcast B.2.1 — semántica de las respuestas a los templates.
//
// DISEÑO PARA SPRINT C / GÉNESIS 2. Nada de esto está conectado: ningún
// webhook, processor ni Génesis lo llama todavía. Es la especificación
// ejecutable (pura, testeada) de qué DEBE pasar cuando el cliente pulsa un
// botón, siempre a través de los servicios canónicos de Control COD —
// Broadcast/Génesis nunca escriben `orders` directamente.
//
// Auditoría que fundamenta este diseño (B.2.1):
//   - applyConfirmationAction() (src/lib/orders/confirmation.ts) es la única
//     puerta de confirmación. Con guardAutomated:true exige
//     confirmation_status='pending' → para un pedido ya confirmado devuelve
//     'not_pending' sin tocar nada. Para SD sin tracking, confirmar también
//     auto-despacha (normalized_status='en_reparto').
//   - Cancelación canónica: sin sesión (webhook/Génesis) solo existe el camino
//     guardAutomated, que exige 'pending'. Un pedido 'confirmed' NO se puede
//     cancelar hoy desde un flujo automático (la RPC cancel_confirmed_order
//     exige auth.uid()). → gap para Sprint C.
//   - autoAssignSdOrder() NO existe como función (solo se menciona en un
//     comentario de sd-status.ts). La "asignación" SD es el auto-despacho de
//     applyConfirmationAction + las rutas derivadas de Ruta COD.
//   - Ubicación: el webhook (bloque 4b) guarda sd_location_* y solo confirma
//     si el pedido sigue 'pending' y la ubicación no es ambigua. Ubicación
//     válida conocida = sd_location_status='received' con lat/lng.
//   - Cambio de cod_amount: edit_local_sd_order() (migración 063) — auditado
//     y atómico, pero exige un humano (auth.uid() + rol). Génesis no puede
//     usarlo tal cual → gap para el descuento de recuperación.
//   - Creación de pedidos: hoy SOLO nacen de Shopify (webhook orders/create,
//     recover, imports). No existe puerta canónica local/WhatsApp.

import { MAX_RECOVERY_DISCOUNT_PCT, REPURCHASE_OFFER, type BroadcastCampaign, type BroadcastTemplateName } from './campaign'

export type CanonicalAction =
  | 'apply_confirmation_confirmed'      // applyConfirmationAction({action:'confirmed', guardAutomated:true})
  | 'record_positive_intent_only'       // NO reconfirmar: solo auditoría de intención (pedido ya confirmado)
  | 'start_genesis_recovery'            // "Ya no lo deseo": NO cancelar; Génesis intenta recuperar
  | 'create_new_repurchase_order'       // pedido NUEVO (nunca tocar el histórico) vía puerta canónica (gap)
  | 'record_campaign_declined'          // "Ahora no": solo auditoría de campaña
  | 'none'                              // estado no aplicable: no hacer nada y escalar

export type LocationStep = 'skip_already_known' | 'request_location' | 'not_applicable'

export interface ButtonResponsePlan {
  template:          BroadcastTemplateName
  button:            string
  meaning:           string
  canonicalAction:   CanonicalAction
  genesisHandoff:    boolean
  location:          LocationStep
  touchesHistoricalOrder: false      // invariante: nunca se modifica un pedido histórico Pagado
  cancelsImmediately:     false      // invariante: ningún botón cancela por sí solo
  offersDiscount:         false      // invariante: ningún botón ofrece descuento por sí solo
  notes:             string
}

export interface OrderStateForPlan {
  confirmation_status:     string | null
  payment_status:          string | null
  normalized_status:       string | null
  tracking_number:         string | null
  sd_location_status:      string | null
  sd_location_lat:         number | null
  sd_location_lng:         number | null
}

/** Ubicación válida ya conocida → no se vuelve a pedir. */
export function hasValidKnownLocation(o: Pick<OrderStateForPlan, 'sd_location_status' | 'sd_location_lat' | 'sd_location_lng'>): boolean {
  return o.sd_location_status === 'received' && o.sd_location_lat != null && o.sd_location_lng != null
}

const base = { touchesHistoricalOrder: false, cancelsImmediately: false, offersDiscount: false } as const

/**
 * Plan para una respuesta a sd_broadcast_confirmation. El MISMO botón se
 * interpreta según el estado canónico ACTUAL del pedido (no según el
 * segmento con el que se envió).
 */
export function planConfirmationResponse(button: 'Sí, confirmar' | 'Ya no lo deseo', o: OrderStateForPlan): ButtonResponsePlan {
  const template = 'sd_broadcast_confirmation' as const
  const terminal = o.payment_status === 'paid' || o.normalized_status === 'delivered'
    || o.normalized_status === 'returned' || o.confirmation_status === 'cancelled' || !!o.tracking_number
  const location: LocationStep = hasValidKnownLocation(o) ? 'skip_already_known' : 'request_location'

  if (terminal) {
    return { ...base, template, button, meaning: 'Pedido ya no coordinable (pagado/entregado/devuelto/cancelado/courier)',
      canonicalAction: 'none', genesisHandoff: true, location: 'not_applicable',
      notes: 'No tocar el pedido; Génesis/agente responde con el estado real.' }
  }

  if (button === 'Sí, confirmar') {
    if (o.confirmation_status === 'pending') {
      return { ...base, template, button, meaning: 'Confirma el pedido pendiente',
        canonicalAction: 'apply_confirmation_confirmed', genesisHandoff: false, location,
        notes: 'applyConfirmationAction(confirmed, method=whatsapp, guardAutomated) → SD auto-despacha (en_reparto). Pedir ubicación solo si no hay una válida.' }
    }
    if (o.confirmation_status === 'confirmed') {
      return { ...base, template, button, meaning: 'Intención positiva de continuar (ya estaba confirmado)',
        canonicalAction: 'record_positive_intent_only', genesisHandoff: false, location,
        notes: 'NO reconfirmar (no incrementar intentos, no reescribir confirmación). Mantener estado operativo actual.' }
    }
    return { ...base, template, button, meaning: 'Estado de confirmación no coordinable',
      canonicalAction: 'none', genesisHandoff: true, location: 'not_applicable', notes: 'Revisión manual.' }
  }

  // "Ya no lo deseo" → recuperación, nunca cancelación inmediata.
  return { ...base, template, button, meaning: 'Duda/rechazo — iniciar recuperación',
    canonicalAction: 'start_genesis_recovery', genesisHandoff: true, location: 'not_applicable',
    notes: 'Génesis identifica la objeción antes de cualquier descuento. Cancelación solo tras rechazo inequívoco, vía servicio canónico.' }
}

export function planRepurchaseResponse(button: 'Sí, quiero aprovechar' | 'Ahora no', knownLocation: boolean): ButtonResponsePlan {
  const template = 'sd_broadcast_repurchase' as const
  if (button === 'Sí, quiero aprovechar') {
    return { ...base, template, button, meaning: 'Intención clara de nueva compra',
      canonicalAction: 'create_new_repurchase_order', genesisHandoff: true,
      location: knownLocation ? 'skip_already_known' : 'request_location',
      notes: `No volver a preguntar si desea pedir. Crear pedido NUEVO: ${REPURCHASE_OFFER.pasteQty} LÜMA Teeth, sin cepillo, RD$${REPURCHASE_OFFER.price}. Reusar datos conocidos válidos; confirmar solo lo dudoso.` }
  }
  return { ...base, template, button, meaning: 'Pospone/rechaza esta campaña',
    canonicalAction: 'record_campaign_declined', genesisHandoff: false, location: 'not_applicable',
    notes: 'Cerrar la oportunidad. No recovery agresivo. No tocar payment_status ni confirmation_status del histórico.' }
}

/** Precio con descuento de recuperación (tope 10%). Para Sprint C/Génesis 2. */
export function recoveryDiscountedAmount(codAmount: number, pct: number): number {
  const p = Math.min(Math.max(pct, 0), MAX_RECOVERY_DISCOUNT_PCT)
  return Math.round(codAmount * (1 - p / 100))
}

// ── Contexto que Génesis 2 debe recibir tras un botón (handoff) ─────────────

export interface GenesisBroadcastHandoffContext {
  customer: {
    customer_id:      string | null   // customers (migración 053) si está resuelto
    phone_normalized: string
    name:             string | null
  }
  order: {                             // pedido canónico ACTUAL (releído, no el snapshot del envío)
    order_id:            string
    order_number:        string | null
    confirmation_status: string | null
    payment_status:      string | null
    normalized_status:   string | null
    tracking_number:     string | null
    product_summary:     string | null
    cod_amount:          number | null
    offer_kind:          string        // resolveCommercialOffer().kind
  }
  location: {
    known_address:       { address: string | null; city: string | null; province: string | null }
    whatsapp_location:   { status: string | null; lat: number | null; lng: number | null; received_at: string | null }
    has_valid_location:  boolean
  }
  broadcast: {
    broadcast_id:  string
    campaign:      BroadcastCampaign
    template_name: BroadcastTemplateName
    sent_at:       string | null
  }
  response: {
    button:        string
    received_at:   string
    plan:          ButtonResponsePlan
  }
  recovery: {
    state:                 'none' | 'in_progress' | 'saved' | 'cancelled_by_customer'
    objection:             string | null
    discount_offered:      boolean
    discount_offered_pct:  number | null
    discount_accepted:     boolean
    max_discount_pct:      typeof MAX_RECOVERY_DISCOUNT_PCT
  }
  conversation: {
    conversation_id: string
    recent_messages: Array<{ direction: 'inbound' | 'outbound'; body: string | null; sent_at: string }>
  }
}
