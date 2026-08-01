-- ============================================================
-- 051_agent_actions_reopened_type.sql
-- Agrega 'reopened' al CHECK constraint de agent_actions.action_type.
--
-- Soporta la acción "Reabrir pedido" (Fase 1 de la auditoría de deshacer-
-- confirmación/cancelación, 2026-07-31): permite volver un pedido
-- confirmado por error a confirmation_status='pending' dejando un registro
-- auditable (agent_id, created_at, motivo en notes) en vez de una escritura
-- silenciosa sin rastro — ver applyConfirmationAction() en
-- src/lib/orders/confirmation.ts, único punto de escritura autorizado
-- (Principio 4 de docs/ARCHITECTURE_RUTA_COD_V1.md).
--
-- Deliberadamente NO se incluye 'cancelled' en esta migración. Ese
-- action_type ya se intenta insertar hoy desde
-- src/app/api/orders/[id]/mark-anulada/route.ts pero nunca estuvo en este
-- CHECK (falla silenciosamente desde que existe ese endpoint) — se resuelve
-- en la fase de "Cancelar pedido"/"Cancelar guía", junto con el resto de esa
-- feature, no aquí.
-- ============================================================

ALTER TABLE agent_actions DROP CONSTRAINT IF EXISTS agent_actions_action_type_check;
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_action_type_check
  CHECK (action_type IN (
    'contacted','confirmed','rescheduled','recovered','courier_claim',
    'note_added','status_updated','returned','delivered',
    'route_confirmed','customer_declined','local_dispatched','paid',
    'reopened'
  ));

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente después de aplicar, no automatizada)
-- ============================================================
-- BEGIN;
--   INSERT INTO agent_actions (order_id, agent_id, action_type, notes)
--   VALUES ('<un id real cualquiera>', '<un profile id real>', 'reopened', 'prueba');
--   -- debe completar sin error 23514
-- ROLLBACK;
