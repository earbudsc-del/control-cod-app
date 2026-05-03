-- ============================================================
-- 001_schema.sql  –  Esquema principal de tablas
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------
-- stores
-- ------------------------------------------------------------
CREATE TABLE stores (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  shopify_domain TEXT,
  is_active  BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- profiles  (extiende auth.users)
-- ------------------------------------------------------------
CREATE TABLE profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  store_id   UUID REFERENCES stores(id),
  full_name  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'viewer'
               CHECK (role IN ('admin', 'agent', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- sla_rules
-- ------------------------------------------------------------
CREATE TABLE sla_rules (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id             UUID REFERENCES stores(id),
  classification       TEXT NOT NULL
                         CHECK (classification IN ('urgent','critical','follow_up','claim')),
  max_inaction_hours   INTEGER NOT NULL,
  is_active            BOOLEAN DEFAULT true,
  UNIQUE (store_id, classification)
);

-- ------------------------------------------------------------
-- status_patterns  (mapeo configurable de texto EFI → estado)
-- ------------------------------------------------------------
CREATE TABLE status_patterns (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pattern             TEXT NOT NULL,
  normalized_status   TEXT NOT NULL
                        CHECK (normalized_status IN (
                          'pending','in_transit','out_for_delivery',
                          'delivered','failed_attempt','returned','unknown'
                        )),
  attempt_increment   INTEGER DEFAULT 0,
  is_at_risk_trigger  BOOLEAN DEFAULT false,
  priority            INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- imports
-- ------------------------------------------------------------
CREATE TABLE imports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id      UUID REFERENCES stores(id),
  filename      TEXT NOT NULL,
  imported_by   UUID REFERENCES profiles(id),
  record_count  INTEGER DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing','completed','failed')),
  error_log     JSONB,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- orders  (tabla principal — upsert por tracking_number)
-- ------------------------------------------------------------
CREATE TABLE orders (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id              UUID REFERENCES stores(id),
  import_id             UUID REFERENCES imports(id),
  tracking_number       TEXT NOT NULL,
  order_number          TEXT,
  customer_name         TEXT,
  customer_phone        TEXT,
  customer_address      TEXT,
  city                  TEXT,
  province              TEXT,
  product_summary       TEXT,
  cod_amount            NUMERIC(10,2),
  carrier               TEXT,
  raw_status            TEXT,
  normalized_status     TEXT NOT NULL DEFAULT 'unknown'
                          CHECK (normalized_status IN (
                            'pending','in_transit','out_for_delivery',
                            'delivered','failed_attempt','returned','unknown'
                          )),
  delivery_attempts     INTEGER DEFAULT 0,
  invalid_attempts      INTEGER DEFAULT 0,
  last_attempt_date     DATE,
  is_at_risk            BOOLEAN DEFAULT false,
  classification        TEXT
                          CHECK (classification IN ('urgent','critical','follow_up','claim')),
  assigned_to           UUID REFERENCES profiles(id),
  assigned_by           UUID REFERENCES profiles(id),
  assigned_at           TIMESTAMPTZ,
  follow_up_result      TEXT DEFAULT 'pending'
                          CHECK (follow_up_result IN (
                            'pending','delivered','returned','recovered','no_action'
                          )),
  last_action_at        TIMESTAMPTZ,
  customer_confirmed    BOOLEAN DEFAULT false,
  customer_confirmed_at TIMESTAMPTZ,
  last_contact_at       TIMESTAMPTZ,
  last_contact_result   TEXT
                          CHECK (last_contact_result IN (
                            'answered_confirmed','answered_rescheduled','answered_refused',
                            'no_answer','wrong_number','unreachable'
                          )),
  sla_deadline          TIMESTAMPTZ,
  sla_breached          BOOLEAN DEFAULT false,
  shopify_order_id      TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE (store_id, tracking_number)
);

-- ------------------------------------------------------------
-- notes
-- ------------------------------------------------------------
CREATE TABLE notes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_by  UUID REFERENCES profiles(id),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- agent_actions
-- ------------------------------------------------------------
CREATE TABLE agent_actions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id       UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  agent_id       UUID REFERENCES profiles(id),
  action_type    TEXT NOT NULL
                   CHECK (action_type IN (
                     'contacted','confirmed','rescheduled','recovered',
                     'courier_claim','note_added','status_updated','returned','delivered'
                   )),
  contact_result TEXT
                   CHECK (contact_result IN (
                     'answered_confirmed','answered_rescheduled','answered_refused',
                     'no_answer','wrong_number','unreachable'
                   )),
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- order_assignments  (historial de asignaciones)
-- ------------------------------------------------------------
CREATE TABLE order_assignments (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id       UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  assigned_to    UUID REFERENCES profiles(id),
  assigned_by    UUID REFERENCES profiles(id),
  assigned_at    TIMESTAMPTZ DEFAULT now(),
  unassigned_at  TIMESTAMPTZ,
  reason         TEXT
);

-- ------------------------------------------------------------
-- delivery_attempt_records
-- ------------------------------------------------------------
CREATE TABLE delivery_attempt_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  attempt_number  INTEGER NOT NULL,
  attempted_at    DATE,
  is_valid        BOOLEAN DEFAULT true,
  invalid_reason  TEXT
                    CHECK (invalid_reason IN (
                      'courier_no_call','courier_no_show','courier_mismanagement',
                      'wrong_address_used','other'
                    )),
  invalid_notes   TEXT,
  flagged_by      UUID REFERENCES profiles(id),
  flagged_at      TIMESTAMPTZ,
  source          TEXT DEFAULT 'efi_import'
                    CHECK (source IN ('efi_import','manual')),
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- order_history  (auditoría automática vía trigger)
-- ------------------------------------------------------------
CREATE TABLE order_history (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  changed_by  UUID REFERENCES profiles(id),
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Índices de búsqueda y filtrado
CREATE INDEX idx_orders_store        ON orders (store_id);
CREATE INDEX idx_orders_tracking     ON orders (tracking_number);
CREATE INDEX idx_orders_assigned     ON orders (assigned_to);
CREATE INDEX idx_orders_status       ON orders (normalized_status);
CREATE INDEX idx_orders_class        ON orders (classification);
CREATE INDEX idx_orders_risk         ON orders (is_at_risk);
CREATE INDEX idx_orders_sla          ON orders (sla_breached);
CREATE INDEX idx_agent_actions_order ON agent_actions (order_id);
CREATE INDEX idx_agent_actions_agent ON agent_actions (agent_id);
CREATE INDEX idx_notes_order         ON notes (order_id);
CREATE INDEX idx_history_order       ON order_history (order_id);
