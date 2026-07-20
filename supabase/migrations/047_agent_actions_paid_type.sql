-- ============================================================
-- 047_agent_actions_paid_type.sql
-- Agrega 'paid' al CHECK constraint de agent_actions.action_type.
--
-- Hasta ahora la acción 'paid' de Ruta COD (case 'paid' en
-- POST /api/v1/deliveries/orders/[id]/actions) se registraba con el
-- action_type genérico 'status_updated' + una nota de texto ("COD cobrado —
-- RD$...") porque no existía un tipo dedicado. Con payment_status como
-- fuente de verdad (046), conviene que la auditoría en agent_actions también
-- sea explícita y consultable sin parsear texto. No quita ningún action_type
-- existente ni reescribe filas históricas (quedan como 'status_updated').
-- ============================================================

ALTER TABLE agent_actions DROP CONSTRAINT IF EXISTS agent_actions_action_type_check;
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_action_type_check
  CHECK (action_type IN (
    'contacted','confirmed','rescheduled','recovered','courier_claim',
    'note_added','status_updated','returned','delivered',
    'route_confirmed','customer_declined','local_dispatched','paid'
  ));
