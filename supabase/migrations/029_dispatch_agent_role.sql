-- ============================================================
-- 029_dispatch_agent_role.sql
--
-- Agrega el rol 'dispatch_agent' (Agente de despacho) al sistema.
--
-- El dispatch_agent:
--   - Trabaja pedidos YA confirmados por el agente de confirmación
--   - Accede al módulo /confirmados
--   - Puede asignar guías EFI a pedidos confirmados sin guía
--   - Puede despachar localmente (SD sin guía EFI)
--   - NO confirma pedidos nuevos
--   - NO gestiona novedades ni devoluciones
--   - NO ve métricas financieras sensibles
--
-- Cambios:
--   1. Ampliar CHECK de profiles.role
--   2. Actualizar is_agent_or_above() para incluir dispatch_agent
--      (necesario para RLS: orders_update, actions_insert, etc.)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Ampliar CHECK de profiles.role
--    Incluye todos los roles existentes + dispatch_agent
-- ------------------------------------------------------------
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'admin',
    'ia_supervisor',
    'confirmation_agent',
    'novelty_agent',
    'delivery_agent',
    'santo_domingo_delivery_agent',
    'dispatch_agent',
    'agent',
    'viewer'
  ));

-- ------------------------------------------------------------
-- 2. Actualizar is_agent_or_above() para incluir dispatch_agent
--    Función usada en políticas RLS:
--      - orders_update
--      - orders_insert
--      - actions_insert
--      - imports_insert
--      - notes_insert
--      - assignments_manage
--      - attempts_manage
--      - tasks_insert
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
    'dispatch_agent',
    'agent'
  )
$$;

-- ------------------------------------------------------------
-- Verificación (ejecutar manualmente para confirmar)
-- ------------------------------------------------------------
-- SELECT rolname FROM pg_roles WHERE rolname = 'dispatch_agent'; -- no aplica (es perfil, no rol DB)
-- SELECT conname, consrc FROM pg_constraint WHERE conname = 'profiles_role_check';
-- SELECT prosrc FROM pg_proc WHERE proname = 'is_agent_or_above';
