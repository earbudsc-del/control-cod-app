-- ============================================================
-- 023_abandoned_carts_draft_orders.sql
-- Extiende abandoned_carts para soportar Shopify Draft Orders
-- como fuente principal de abandonos en flujo COD.
-- ============================================================
-- Contexto: el flujo COD (tipo EasySell) crea Draft Orders
-- en Shopify (Admin → Orders → Drafts, ej. #D2256).
-- NO genera checkouts nativos, por eso checkouts.json devuelve 0.
-- ============================================================

-- 1. Campos de Draft Order
ALTER TABLE abandoned_carts
  ADD COLUMN IF NOT EXISTS shopify_draft_order_id   TEXT,
  ADD COLUMN IF NOT EXISTS shopify_draft_order_name TEXT,
  ADD COLUMN IF NOT EXISTS draft_status             TEXT,
  ADD COLUMN IF NOT EXISTS completed_at             TIMESTAMPTZ;

-- 2. Índice único condicional por draft order
--    (solo aplica cuando hay un draft_order_id real)
CREATE UNIQUE INDEX IF NOT EXISTS abandoned_carts_draft_order_unique
  ON abandoned_carts (store_id, shopify_draft_order_id)
  WHERE shopify_draft_order_id IS NOT NULL;

-- 3. Índice de búsqueda por nombre de draft (#D2256)
CREATE INDEX IF NOT EXISTS abandoned_carts_draft_name_idx
  ON abandoned_carts (store_id, shopify_draft_order_name)
  WHERE shopify_draft_order_name IS NOT NULL;

-- 4. Actualizar comentario de source
COMMENT ON COLUMN abandoned_carts.source IS
  'shopify_draft_order | shopify_abandoned_checkout | cod_form_lead | manual_import | shopify (legacy)';
COMMENT ON COLUMN abandoned_carts.shopify_draft_order_id IS
  'ID numérico del draft order de Shopify. Unique condicional por store.';
COMMENT ON COLUMN abandoned_carts.shopify_draft_order_name IS
  'Nombre legible del draft order, ej. #D2256';
COMMENT ON COLUMN abandoned_carts.draft_status IS
  'Estado del draft en Shopify: open | invoice_sent | completed';
COMMENT ON COLUMN abandoned_carts.completed_at IS
  'Timestamp en que el draft fue completado (convertido a pedido real)';
