-- Agrega 'local_dispatched' al CHECK constraint de agent_actions.
-- Registra el despacho local hecho por el mensajero SD (santo_domingo_delivery_agent)
-- desde /sd-delivery, sin requerir que el admin lo haga desde /confirmados.
-- No quita ningún action_type existente.

ALTER TABLE agent_actions DROP CONSTRAINT IF EXISTS agent_actions_action_type_check;
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_action_type_check
  CHECK (action_type IN (
    'contacted','confirmed','rescheduled','recovered','courier_claim',
    'note_added','status_updated','returned','delivered',
    'route_confirmed','customer_declined','local_dispatched'
  ));
