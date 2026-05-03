-- ============================================================
-- 002_rls.sql  –  Row Level Security
-- ============================================================

ALTER TABLE stores                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_rules                ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_patterns          ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_actions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_assignments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_attempt_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_history            ENABLE ROW LEVEL SECURITY;

-- Helpers (SECURITY DEFINER para evitar recursión en RLS)
CREATE OR REPLACE FUNCTION get_user_store_id()
RETURNS UUID LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT store_id FROM profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT role FROM profiles WHERE id = auth.uid()
$$;

-- ------------------------------------------------------------
-- stores
-- ------------------------------------------------------------
CREATE POLICY "store_select" ON stores
  FOR SELECT USING (id = get_user_store_id());

-- ------------------------------------------------------------
-- profiles
-- ------------------------------------------------------------
CREATE POLICY "profiles_select" ON profiles
  FOR SELECT USING (store_id = get_user_store_id());

CREATE POLICY "profiles_insert" ON profiles
  FOR INSERT WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "profiles_update" ON profiles
  FOR UPDATE USING (get_user_role() = 'admin' AND store_id = get_user_store_id());

-- ------------------------------------------------------------
-- sla_rules
-- ------------------------------------------------------------
CREATE POLICY "sla_select" ON sla_rules
  FOR SELECT USING (store_id = get_user_store_id() OR store_id IS NULL);

CREATE POLICY "sla_manage" ON sla_rules
  FOR ALL USING (get_user_role() = 'admin');

-- ------------------------------------------------------------
-- status_patterns  (global, solo admins modifican)
-- ------------------------------------------------------------
CREATE POLICY "patterns_select" ON status_patterns
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "patterns_manage" ON status_patterns
  FOR ALL USING (get_user_role() = 'admin');

-- ------------------------------------------------------------
-- imports
-- ------------------------------------------------------------
CREATE POLICY "imports_select" ON imports
  FOR SELECT USING (store_id = get_user_store_id());

CREATE POLICY "imports_insert" ON imports
  FOR INSERT WITH CHECK (
    store_id = get_user_store_id()
    AND get_user_role() IN ('admin','agent')
  );

CREATE POLICY "imports_update" ON imports
  FOR UPDATE USING (store_id = get_user_store_id());

-- ------------------------------------------------------------
-- orders
-- ------------------------------------------------------------
CREATE POLICY "orders_select" ON orders
  FOR SELECT USING (store_id = get_user_store_id());

CREATE POLICY "orders_insert" ON orders
  FOR INSERT WITH CHECK (
    store_id = get_user_store_id()
    AND get_user_role() IN ('admin','agent')
  );

CREATE POLICY "orders_update" ON orders
  FOR UPDATE USING (
    store_id = get_user_store_id()
    AND get_user_role() IN ('admin','agent')
  );

-- ------------------------------------------------------------
-- notes
-- ------------------------------------------------------------
CREATE POLICY "notes_select" ON notes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = notes.order_id
        AND orders.store_id = get_user_store_id()
    )
  );

CREATE POLICY "notes_insert" ON notes
  FOR INSERT WITH CHECK (
    get_user_role() IN ('admin','agent')
    AND EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND orders.store_id = get_user_store_id()
    )
  );

-- ------------------------------------------------------------
-- agent_actions
-- ------------------------------------------------------------
CREATE POLICY "actions_select" ON agent_actions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = agent_actions.order_id
        AND orders.store_id = get_user_store_id()
    )
  );

CREATE POLICY "actions_insert" ON agent_actions
  FOR INSERT WITH CHECK (
    get_user_role() IN ('admin','agent')
    AND EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND orders.store_id = get_user_store_id()
    )
  );

-- ------------------------------------------------------------
-- order_assignments
-- ------------------------------------------------------------
CREATE POLICY "assignments_select" ON order_assignments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_assignments.order_id
        AND orders.store_id = get_user_store_id()
    )
  );

CREATE POLICY "assignments_manage" ON order_assignments
  FOR ALL USING (
    get_user_role() IN ('admin','agent')
    AND EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND orders.store_id = get_user_store_id()
    )
  );

-- ------------------------------------------------------------
-- delivery_attempt_records
-- ------------------------------------------------------------
CREATE POLICY "attempts_select" ON delivery_attempt_records
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = delivery_attempt_records.order_id
        AND orders.store_id = get_user_store_id()
    )
  );

CREATE POLICY "attempts_manage" ON delivery_attempt_records
  FOR ALL USING (
    get_user_role() IN ('admin','agent')
    AND EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_id
        AND orders.store_id = get_user_store_id()
    )
  );

-- ------------------------------------------------------------
-- order_history  (solo lectura para todos)
-- ------------------------------------------------------------
CREATE POLICY "history_select" ON order_history
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_history.order_id
        AND orders.store_id = get_user_store_id()
    )
  );

CREATE POLICY "history_insert" ON order_history
  FOR INSERT WITH CHECK (true);
