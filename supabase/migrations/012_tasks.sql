-- ============================================================
-- 012_tasks.sql  –  Sistema de tareas por pedido
-- ============================================================

CREATE TABLE tasks (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id       UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  store_id       UUID NOT NULL REFERENCES stores(id),
  assigned_to    UUID REFERENCES profiles(id),
  assigned_by    UUID REFERENCES profiles(id),
  task_type      TEXT NOT NULL
                   CHECK (task_type IN ('follow_up','novedad','confirmation','recovery')),
  priority       TEXT NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('high','medium','low')),
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','in_progress','completed','expired','escalated')),
  due_at         TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  result         TEXT
                   CHECK (result IN ('delivered','recovered','no_answer','rescheduled','returned')),
  notes          TEXT,
  assigned_by_ia BOOLEAN DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- Índices
CREATE INDEX idx_tasks_order    ON tasks (order_id);
CREATE INDEX idx_tasks_assigned ON tasks (assigned_to);
CREATE INDEX idx_tasks_status   ON tasks (status);
CREATE INDEX idx_tasks_store    ON tasks (store_id);
CREATE INDEX idx_tasks_due      ON tasks (due_at);

-- Auto-actualizar updated_at (reutiliza función del 003_triggers.sql)
CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Admins ven todas las tareas de su tienda
-- Agentes solo ven las tareas asignadas a ellos
CREATE POLICY "tasks_select" ON tasks
  FOR SELECT USING (
    store_id = get_user_store_id()
    AND (
      get_user_role() = 'admin'
      OR assigned_to = auth.uid()
    )
  );

-- Solo admin y agentes pueden crear tareas (el supervisor IA usa service role, bypass automático)
CREATE POLICY "tasks_insert" ON tasks
  FOR INSERT WITH CHECK (
    store_id = get_user_store_id()
    AND get_user_role() IN ('admin','agent')
  );

-- Admin puede actualizar cualquier tarea; agente solo las suyas
CREATE POLICY "tasks_update" ON tasks
  FOR UPDATE USING (
    store_id = get_user_store_id()
    AND (
      get_user_role() = 'admin'
      OR assigned_to = auth.uid()
    )
  );
