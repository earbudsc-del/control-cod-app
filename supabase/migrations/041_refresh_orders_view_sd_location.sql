-- ============================================================
-- 041_refresh_orders_view_sd_location.sql
-- Recrear orders_with_sla para incluir las columnas de ubicación SD
-- añadidas en 040_sd_location_request.sql (sd_location_lat, sd_location_lng,
-- sd_location_received_at, sd_location_status, sd_location_wa_msg_id,
-- sd_location_conversation_id).
--
-- Mismo problema documentado en 016_refresh_orders_view.sql y
-- 038_refresh_orders_view_novelty.sql: la vista usa `o.*`, y Postgres
-- congela la lista de columnas al momento de crear la vista — las columnas
-- nuevas de `orders` no aparecen automáticamente. Verificado empíricamente:
-- tras aplicar 040, SELECT sd_location_lat FROM orders_with_sla devuelve
-- 42703 "column does not exist" aunque orders sí la tiene. Sin esta
-- migración, /api/v1/deliveries/orders (que lee desde esta vista) nunca
-- vería los campos de ubicación SD nuevos.
--
-- Definición vigente — idéntica a 038, sin ningún cambio de lógica ni de
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
-- SELECT sd_location_lat, sd_location_lng, sd_location_received_at,
--        sd_location_status, sd_location_wa_msg_id, sd_location_conversation_id
-- FROM orders_with_sla
-- LIMIT 1;
-- Resultado esperado: 0 o 1 fila, sin error 42703.
