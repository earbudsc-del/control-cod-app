// Sprint Broadcast B — labels humanos para las razones técnicas de exclusión.
// La UI muestra el label; el reason técnico se conserva siempre en los datos.
// Puro / client-safe.

export const BROADCAST_REASON_LABELS: Record<string, string> = {
  not_shopify_order:                 'No es pedido Shopify',
  test_or_archived:                  'Pedido de prueba o archivado',
  confirmed:                         'Ya confirmado (usar "Confirmados sin pagar")',
  confirmation_pending:              'Pendiente de confirmar (usar "Pendientes")',
  recent_purchase:                   'Compra Pagada dentro de la ventana',
  active_order_in_progress:          'Tiene un pedido activo en curso',
  repurchase_already_contacted:      'Ya contactado para recompra por esta compra',
  route_filter_mismatch:             'Fuera del filtro de ruta elegido',
  cancelled:                         'Cancelado',
  unreachable:                       'Inalcanzable',
  confirmation_not_pending:          'Ya confirmado/no pendiente',
  paid:                              'Pedido pagado',
  delivered:                         'Ya entregado',
  returned:                          'Devuelto',
  external_tracking:                 'Ya asignado a transportadora',
  not_santo_domingo:                 'Fuera de Santo Domingo',
  invalid_phone:                     'Teléfono inválido',
  broadcast_already_active:          'Ya contactado por broadcast (en curso)',
  broadcast_already_sent:            'Ya contactado por broadcast',
  broadcast_previous_attempt:        'Broadcast previo fallido/omitido',
  multiple_active_orders_same_phone: 'Múltiples pedidos pendientes para este teléfono',
  not_found:                         'Pedido no encontrado',
  // C.1 — exclusiones propias del envío real (al lanzar / antes de cada envío)
  offer_incompatible:                'Oferta distinta a la del template (no es el bundle Personal 2×1 con cepillo gratis y envío gratis)',
  media_asset_pending:               'Imagen de su oferta aún no existe',
  marketing_opt_out:                 'Pidió no recibir mensajes promocionales',
  phone_already_contacted:           'Este número ya recibió esta campaña',
}

export function broadcastReasonLabel(reason: string): string {
  return BROADCAST_REASON_LABELS[reason] ?? reason
}

export const BROADCAST_WARNING_LABELS: Record<string, string> = {
  location_received_but_pending: 'Ubicación recibida pero sigue pendiente (revisar)',
  already_in_route:              'Confirmado y ya en ruta del mensajero',
  requires_template_variables:   'Su oferta no calza con el texto fijo del template (requiere variables)',
  media_asset_pending:           'Imagen de su oferta aún no existe',
}

export const BROADCAST_STATUS_LABELS: Record<string, string> = {
  draft:      'Borrador',
  queued:     'En cola',
  processing: 'Procesando',
  paused:     'Pausado',
  completed:  'Completado',
  cancelled:  'Cancelado',
}

// C.1 — qué pasa con cada quick reply (atención humana; Génesis apagado).
export const BROADCAST_BUTTON_HINTS: Record<string, string> = {
  'Sí, confirmar':         'Llega al Inbox como "Quiere confirmar". Un agente confirma con el flujo existente; no se confirma solo.',
  'Ya no lo deseo':        'Llega al Inbox destacado. No cancela el pedido: un agente atiende y, si corresponde, cancela con el flujo existente.',
  'Sí, quiero aprovechar': 'Registra interés de recompra. No crea pedidos automáticamente.',
  'Ahora no':              'Registra que no le interesa ahora. No se insiste automáticamente.',
}

// C.1 — intención registrada al pulsar un botón. Intención ≠ acción: nada
// se confirma ni se cancela automáticamente.
export const BROADCAST_INTENT_LABELS: Record<string, string> = {
  confirm_interest:    'Quiere confirmar',
  decline_order:       'Ya no lo desea',
  repurchase_interest: 'Quiere aprovechar la recompra',
  repurchase_decline:  'Ahora no (recompra)',
  unknown:             'Respuesta sin campaña identificable',
}

// C.1 — estado de cada destinatario en la cola.
export const BROADCAST_QUEUE_STATUS_LABELS: Record<string, string> = {
  pending:      'Pendiente',
  processing:   'En proceso',
  sent:         'Aceptado por Meta',
  skipped:      'Omitido al revalidar',
  failed:       'Fallido',
  send_unknown: 'Resultado incierto — revisar',
}
