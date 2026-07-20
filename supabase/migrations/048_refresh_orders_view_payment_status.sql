-- ============================================================
-- 048_refresh_orders_view_payment_status.sql
-- Recrear orders_with_sla para incluir payment_status/paid_at/paid_by,
-- añadidas en 046_orders_payment_status.sql. Mismo problema documentado en
-- 016/038/041/043_refresh_orders_view_*.sql: la vista usa `o.*`, y Postgres
-- congela la lista de columnas al momento de crear la vista.
--
-- Definición vigente — idéntica a 043, sin ningún cambio de lógica ni de
-- datos. Solo re-ejecuta el mismo DROP + CREATE para refrescar el snapshot
-- de columnas de `o.*`.
-- ============================================================

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

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente para confirmar)
-- ============================================================
-- SELECT payment_status, paid_at, paid_by FROM orders_with_sla LIMIT 1;
-- Resultado esperado: 0 o 1 fila, sin error 42703.
