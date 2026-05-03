-- ============================================================
-- 018_duplicate_alert.sql
-- Detección de pedidos posiblemente duplicados en el webhook Shopify.
-- El sistema NO bloquea el pedido — solo lo marca para revisión del agente.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS duplicate_alert       BOOLEAN DEFAULT false,
  -- ON DELETE SET NULL: si el pedido original se elimina, este campo queda NULL
  ADD COLUMN IF NOT EXISTS duplicate_of_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS duplicate_reason      TEXT;

-- ── Índice para listar pedidos con alerta de duplicado ────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_duplicate_alert
  ON orders (store_id, duplicate_alert)
  WHERE duplicate_alert = true;

-- ── Recrear vista orders_with_sla ─────────────────────────────────────────────
-- Necesario para incluir los nuevos campos en o.*
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
