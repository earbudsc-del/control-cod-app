-- ============================================================
-- 021_abandoned_carts.sql  –  Carritos abandonados Shopify
-- ============================================================
-- Tabla para recuperación de ventas COD desde checkouts
-- abandonados de Shopify.
-- Acceso: admin, ia_supervisor, confirmation_agent.
-- ============================================================

CREATE TABLE abandoned_carts (
  id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  store_id             UUID        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_checkout_id  TEXT        NOT NULL,

  -- Datos del cliente
  customer_name        TEXT,
  customer_phone       TEXT,
  customer_email       TEXT,

  -- Carrito
  products_summary     TEXT,
  total_amount         NUMERIC(10,2),
  currency             TEXT        DEFAULT 'DOP',
  checkout_url         TEXT,

  -- Ubicación
  customer_address     TEXT,
  city                 TEXT,
  province             TEXT,

  -- Estado de recuperación
  recovery_status      TEXT        NOT NULL DEFAULT 'pending'
                         CHECK (recovery_status IN ('pending','contacted','no_answer','recovered','discarded')),
  recovery_attempts    INTEGER     NOT NULL DEFAULT 0,
  last_contacted_at    TIMESTAMPTZ,
  recovered_order_id   TEXT,

  -- Notas internas del agente
  notes                TEXT,

  -- Metadatos
  abandoned_at         TIMESTAMPTZ,
  source               TEXT        DEFAULT 'shopify',
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (store_id, shopify_checkout_id)
);

-- Índices operativos
CREATE INDEX ON abandoned_carts (store_id, recovery_status);
CREATE INDEX ON abandoned_carts (store_id, abandoned_at DESC);
CREATE INDEX ON abandoned_carts (customer_phone);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION update_abandoned_carts_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER abandoned_carts_updated_at
  BEFORE UPDATE ON abandoned_carts
  FOR EACH ROW EXECUTE FUNCTION update_abandoned_carts_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE abandoned_carts ENABLE ROW LEVEL SECURITY;

-- Solo admin, ia_supervisor y confirmation_agent tienen acceso
CREATE POLICY "abandoned_carts_select" ON abandoned_carts
  FOR SELECT USING (
    store_id = get_user_store_id()
    AND get_user_role() IN ('admin', 'ia_supervisor', 'confirmation_agent')
  );

CREATE POLICY "abandoned_carts_insert" ON abandoned_carts
  FOR INSERT WITH CHECK (
    store_id = get_user_store_id()
    AND get_user_role() IN ('admin', 'ia_supervisor', 'confirmation_agent')
  );

CREATE POLICY "abandoned_carts_update" ON abandoned_carts
  FOR UPDATE USING (
    store_id = get_user_store_id()
    AND get_user_role() IN ('admin', 'ia_supervisor', 'confirmation_agent')
  );
