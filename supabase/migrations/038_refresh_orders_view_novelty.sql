-- ============================================================
-- 038_refresh_orders_view_novelty.sql
-- Recrear orders_with_sla para incluir las columnas del motor de novedades
-- añadidas en 037 (novelty_type, delivery_resolution, rescheduled_date,
-- rescheduled_note, last_escalation_at).
--
-- Mismo problema documentado en 016_refresh_orders_view.sql: la vista usa
-- `o.*`, y Postgres congela la lista de columnas al momento de crear la
-- vista — las columnas nuevas de `orders` no aparecen automáticamente.
-- Verificado empíricamente: tras aplicar 037, GET orders_with_sla?select=
-- novelty_type devuelve 42703 "column does not exist" aunque orders sí la
-- tiene. Sin esta migración, /api/orders y /api/orders/[id] (que leen desde
-- esta vista) nunca verían los campos nuevos.
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
