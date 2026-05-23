-- ============================================================
-- 027_sd_delivery_secondary_actions.sql
--
-- Agrega 'customer_declined' al CHECK constraint de
-- agent_actions.action_type para soportar el botón "No desea"
-- del flujo SD local.
--
-- customer_declined: el cliente comunica que ya no quiere el
-- pedido, sacándolo del flujo activo de forma auditable.
--
-- No se modifican otros constraints ni funciones RLS porque:
--   - is_agent_or_above() ya incluye santo_domingo_delivery_agent
--     (fue corregido en migración 026)
--   - El INSERT lo hace el agente autenticado via /api/orders/[id]/actions
--     que ya pasa el check de rol
-- ============================================================

ALTER TABLE agent_actions
  DROP CONSTRAINT IF EXISTS agent_actions_action_type_check;

ALTER TABLE agent_actions
  ADD CONSTRAINT agent_actions_action_type_check
  CHECK (action_type IN (
    'contacted',
    'confirmed',
    'rescheduled',
    'recovered',
    'courier_claim',
    'note_added',
    'status_updated',
    'returned',
    'delivered',
    'route_confirmed',
    'customer_declined'
  ));
