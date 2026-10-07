// Sprint Broadcast B — labels humanos para las razones técnicas de exclusión.
// La UI muestra el label; el reason técnico se conserva siempre en los datos.
// Puro / client-safe.

export const BROADCAST_REASON_LABELS: Record<string, string> = {
  not_shopify_order:                 'No es pedido Shopify',
  test_or_archived:                  'Pedido de prueba o archivado',
  confirmed:                         'Ya confirmado',
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
}

export const BROADCAST_STATUS_LABELS: Record<string, string> = {
  draft:      'Borrador',
  queued:     'En cola',
  processing: 'Procesando',
  completed:  'Completado',
  cancelled:  'Cancelado',
}
