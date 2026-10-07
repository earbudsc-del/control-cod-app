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
  completed:  'Completado',
  cancelled:  'Cancelado',
}

// B.2.1 — qué hará cada quick reply (diseño Sprint C; nada conectado aún).
export const BROADCAST_BUTTON_HINTS: Record<string, string> = {
  'Sí, confirmar':         'Confirma si está pendiente; si ya estaba confirmado, solo continúa la coordinación. Pide ubicación solo si falta.',
  'Ya no lo deseo':        'No cancela: Génesis intenta entender y recuperar. Cancela solo ante un "no" inequívoco.',
  'Sí, quiero aprovechar': 'Crea un pedido NUEVO de recompra (2 LÜMA Teeth, sin cepillo) sin volver a preguntar.',
  'Ahora no':              'Cierra esta oportunidad. No toca el pedido histórico.',
}
