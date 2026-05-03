-- ============================================================
-- 013_roles.sql  –  Roles operativos especializados
-- ============================================================
-- Extiende profiles.role con roles especializados sin romper
-- datos existentes. Agrega helper is_agent_or_above() y
-- actualiza las políticas RLS que usaban IN ('admin','agent').
-- ============================================================

-- ------------------------------------------------------------
-- 1. Expandir CHECK de profiles.role
--    PostgreSQL nombra el constraint inline como
--    profiles_role_check — se elimina y recrea.
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
    'agent',    -- conservado: backward compatibility con usuarios existentes
    'viewer'
  ));

-- ------------------------------------------------------------
-- 2. Helper: is_agent_or_above()
--    Devuelve TRUE para cualquier rol operativo.
--    Usar en políticas INSERT/UPDATE que antes decían
--    get_user_role() IN ('admin','agent').
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_agent_or_above()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT get_user_role() IN (
    'admin',
    'ia_supervisor',
    'confirmation_agent',
    'novelty_agent',
    'delivery_agent',
    'agent'
  )
$$;

-- ------------------------------------------------------------
-- 3. Actualizar políticas de 002_rls.sql
--    Solo las que usaban get_user_role() IN ('admin','agent').
--    Las políticas admin-only no se tocan.
-- ------------------------------------------------------------

-- imports_insert
DROP POLICY IF EXISTS "imports_insert" ON imports;
CREATE POLICY "imports_insert" ON imports
  FOR INSERT WITH CHECK (
    store_id = get_user_store_id()
    AND is_agent_or_above()
  );

-- orders_insert
DROP POLICY IF EXISTS "orders_insert" ON orders;
CREATE POLICY "orders_insert" ON orders
  FOR INSERT WITH CHECK (
    store_id = get_user_store_id()
    AND is_agent_or_above()
  );

-- orders_update
DROP POLICY IF EXISTS "orders_update" ON orders;
CREATE POLICY "orders_update" ON orders
  FOR UPDATE USING (
    store_id = get_user_store_id()
    AND is_agent_or_above()
  );

-- notes_insert
DROP POLICY IF EXISTS "notes_insert" ON notes;
CREATE POLICY "notes_insert" ON notes
  FOR INSERT WITH CHECK (
    is_agent_or_above()
    AND EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND orders.store_id = get_user_store_id()
    )
  );

-- actions_insert
DROP POLICY IF EXISTS "actions_insert" ON agent_actions;
CREATE POLICY "actions_insert" ON agent_actions
  FOR INSERT WITH CHECK (
    is_agent_or_above()
    AND EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND orders.store_id = get_user_store_id()
    )
  );

-- assignments_manage
DROP POLICY IF EXISTS "assignments_manage" ON order_assignments;
CREATE POLICY "assignments_manage" ON order_assignments
  FOR ALL USING (
    is_agent_or_above()
    AND EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND orders.store_id = get_user_store_id()
    )
  );

-- attempts_manage
DROP POLICY IF EXISTS "attempts_manage" ON delivery_attempt_records;
CREATE POLICY "attempts_manage" ON delivery_attempt_records
  FOR ALL USING (
    is_agent_or_above()
    AND EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND orders.store_id = get_user_store_id()
    )
  );

-- ------------------------------------------------------------
-- 4. Actualizar políticas de 012_tasks.sql
--    tasks_select y tasks_update: ia_supervisor ve todo (como admin)
--    tasks_insert: cualquier rol operativo puede crear tareas
-- ------------------------------------------------------------

-- tasks_select: admin e ia_supervisor ven todas las tareas de la tienda;
--              el resto solo ve las asignadas a su usuario
DROP POLICY IF EXISTS "tasks_select" ON tasks;
CREATE POLICY "tasks_select" ON tasks
  FOR SELECT USING (
    store_id = get_user_store_id()
    AND (
      get_user_role() IN ('admin', 'ia_supervisor')
      OR assigned_to = auth.uid()
    )
  );

-- tasks_insert
DROP POLICY IF EXISTS "tasks_insert" ON tasks;
CREATE POLICY "tasks_insert" ON tasks
  FOR INSERT WITH CHECK (
    store_id = get_user_store_id()
    AND is_agent_or_above()
  );

-- tasks_update: admin e ia_supervisor pueden editar cualquier tarea;
--              agentes solo las asignadas a ellos
DROP POLICY IF EXISTS "tasks_update" ON tasks;
CREATE POLICY "tasks_update" ON tasks
  FOR UPDATE USING (
    store_id = get_user_store_id()
    AND (
      get_user_role() IN ('admin', 'ia_supervisor')
      OR assigned_to = auth.uid()
    )
  );
