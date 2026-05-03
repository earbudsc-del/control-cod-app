-- ============================================================
-- 016_refresh_orders_view.sql
-- Recrear orders_with_sla para incluir columnas añadidas en 007-015
-- (last_novedad_at, tracking_novedades, status_since, etc.).
--
-- CREATE OR REPLACE VIEW falla porque PostgreSQL registra las columnas
-- calculadas (sla_status, etc.) en posiciones fijas y al re-expandir
-- o.* con columnas nuevas las posiciones entran en conflicto.
-- Solución: DROP + CREATE (sin CASCADE — no hay otras vistas que dependan de ella).
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
