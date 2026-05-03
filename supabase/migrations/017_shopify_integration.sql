-- ============================================================
-- 017_shopify_integration.sql
-- Soporte para pedidos que entran desde Shopify vía webhook.
-- ============================================================

-- 1. Permitir tracking_number nulo
--    Los pedidos de Shopify llegan sin guía (se asigna después al despachar a EFI).
--    El cron de auto-tracking ya filtra .not('tracking_number', 'is', null).
ALTER TABLE orders ALTER COLUMN tracking_number DROP NOT NULL;

-- 2. Origen del pedido
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'csv_import'
    CHECK (source IN ('csv_import', 'shopify_webhook', 'manual'));

-- 3. Fecha de creación en Shopify (preserva la fecha real del pedido)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shopify_created_at TIMESTAMPTZ;

-- 4. Índice único parcial para shopify_order_id por tienda
--    Garantiza idempotencia ante reintentos de webhook a nivel de DB.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_shopify_unique
  ON orders (store_id, shopify_order_id)
  WHERE shopify_order_id IS NOT NULL;

-- 5. Índice de búsqueda rápida por shopify_order_id
CREATE INDEX IF NOT EXISTS idx_orders_shopify_order_id
  ON orders (shopify_order_id);

-- 6. Recrear vista orders_with_sla
--    Necesario porque o.* en la vista queda fijo al momento de creación;
--    los nuevos campos (source, shopify_created_at) no aparecen sin esto.
DROP VIEW IF EXISTS orders_with_sla;

CREATE VIEW orders_with_sla AS
SELECT
  o.*,
  CASE
    WHEN o.sla_deadline IS NULL THEN 'none'
    WHEN o.sla_breached = true  THEN 'breached'
    WHEN o.sla_deadline - now() < INTERVAL '2 hours' THEN 'warning'
    ELSE 'ok'
  END                                                    AS sla_status,
  EXTRACT(EPOCH FROM (o.sla_deadline - now())) / 3600    AS sla_hours_remaining,
  p.full_name                                            AS assigned_name
FROM orders o
LEFT JOIN profiles p ON p.id = o.assigned_to;
