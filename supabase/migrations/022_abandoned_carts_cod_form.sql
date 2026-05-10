-- ============================================================
-- 022_abandoned_carts_cod_form.sql
-- Extiende abandoned_carts para soportar leads parciales de
-- formularios COD (modelo EasySell / COD form).
-- ============================================================
-- Problema resuelto: el sync de Shopify checkouts.json devuelve
-- 0 carritos porque el flujo es COD form, no checkout nativo.
-- Solución: la tabla ahora acepta leads sin shopify_checkout_id.
-- ============================================================

-- 1. Hacer shopify_checkout_id nullable
ALTER TABLE abandoned_carts ALTER COLUMN shopify_checkout_id DROP NOT NULL;

-- 2. Reemplazar unique constraint absoluto por índice único condicional
--    (solo aplica cuando hay un checkout_id real de Shopify)
ALTER TABLE abandoned_carts
  DROP CONSTRAINT IF EXISTS abandoned_carts_store_id_shopify_checkout_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS abandoned_carts_shopify_checkout_unique
  ON abandoned_carts (store_id, shopify_checkout_id)
  WHERE shopify_checkout_id IS NOT NULL;

-- 3. Campos adicionales para leads de formulario COD
ALTER TABLE abandoned_carts
  ADD COLUMN IF NOT EXISTS product_id    TEXT,
  ADD COLUMN IF NOT EXISTS variant_id    TEXT,
  ADD COLUMN IF NOT EXISTS page_url      TEXT,
  ADD COLUMN IF NOT EXISTS referrer      TEXT,
  ADD COLUMN IF NOT EXISTS utm_source    TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign  TEXT,
  ADD COLUMN IF NOT EXISTS utm_content   TEXT,
  ADD COLUMN IF NOT EXISTS session_id    TEXT;

-- 4. Índice para deduplicación COD form: phone + source + store
CREATE INDEX IF NOT EXISTS abandoned_carts_phone_source_idx
  ON abandoned_carts (store_id, customer_phone, source, abandoned_at DESC);

-- 5. Comentarios para claridad operativa
COMMENT ON COLUMN abandoned_carts.source IS
  'shopify_abandoned_checkout | cod_form_lead | manual_import | shopify (legacy)';
COMMENT ON COLUMN abandoned_carts.shopify_checkout_id IS
  'NULL para leads COD form. Unique solo cuando no es NULL.';
COMMENT ON COLUMN abandoned_carts.session_id IS
  'cart_token o session UUID del frontend COD, para deduplicación';
