-- ============================================================
-- 026_sd_delivery_fixes.sql
--
-- Corrige los dos bugs críticos del flujo SD local:
--
-- BUG 2 (Iniciar ruta → "Error al confirmar ruta"):
--   La columna agent_actions.action_type tiene un CHECK constraint
--   que no incluye 'route_confirmed'. Cualquier intento de insertar
--   una acción route_confirmed falla con violación de constraint.
--
-- BUG 1 (Despachar local / Cliente confirma falla):
--   El rol 'santo_domingo_delivery_agent' no estaba en:
--   - profiles.role CHECK constraint → no se podían crear perfiles
--   - is_agent_or_above() DB function → RLS bloqueaba:
--       * orders UPDATE (confirm-client silently fails)
--       * agent_actions INSERT (confirm-client / postAction fails)
--
-- ORDEN OBLIGATORIO:
--   1. Ampliar CHECK de agent_actions.action_type
--   2. Ampliar CHECK de profiles.role
--   3. Actualizar función is_agent_or_above()
-- ============================================================

-- ------------------------------------------------------------
-- 1. Agregar 'route_confirmed' al CHECK de agent_actions
-- ------------------------------------------------------------
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
    'route_confirmed'
  ));

-- ------------------------------------------------------------
-- 2. Agregar 'santo_domingo_delivery_agent' al CHECK de profiles
-- ------------------------------------------------------------
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'admin',
    'ia_supervisor',
    'confirmation_agent',
    'novelty_agent',
    'delivery_agent',
    'santo_domingo_delivery_agent',
    'agent',
    'viewer'
  ));

-- ------------------------------------------------------------
-- 3. Actualizar is_agent_or_above() para incluir el nuevo rol
--    Función usada en políticas RLS de orders_update, actions_insert, etc.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_agent_or_above()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT get_user_role() IN (
    'admin',
    'ia_supervisor',
    'confirmation_agent',
    'novelty_agent',
    'delivery_agent',
    'santo_domingo_delivery_agent',
    'agent'
  )
$$;
