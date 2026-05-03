-- ============================================================
-- 019_confirmation_confidence.sql
-- Nivel de confianza de confirmación de pedido COD.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS confirmation_method TEXT
    CHECK (confirmation_method IN ('call', 'whatsapp', 'other')),
  ADD COLUMN IF NOT EXISTS confirmation_confidence TEXT
    CHECK (confirmation_confidence IN ('high', 'medium', 'low', 'risky'));

COMMENT ON COLUMN orders.confirmation_method IS
  'Canal usado para la confirmación: call | whatsapp | other';
COMMENT ON COLUMN orders.confirmation_confidence IS
  'Nivel de confianza de la confirmación: high | medium | low | risky';

-- Recrear vista para incluir los nuevos campos (patrón establecido en 017 y 018)
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
