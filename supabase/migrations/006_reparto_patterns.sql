-- ============================================================
-- 006_reparto_patterns.sql
-- Patrones específicos para el estado EN_REPARTO de EFI Commerce
-- Ejecutar en Supabase SQL Editor si el proyecto ya está en producción
-- ============================================================

INSERT INTO status_patterns
  (pattern, normalized_status, attempt_increment, is_at_risk_trigger, priority)
VALUES
  ('en reparto',      'out_for_delivery', 0, false, 6),
  ('en_reparto',      'out_for_delivery', 0, false, 6),
  ('EN_REPARTO',      'out_for_delivery', 0, false, 6),
  ('reparto',         'out_for_delivery', 0, false, 5),
  ('en despacho',     'out_for_delivery', 0, false, 5),
  ('despacho',        'out_for_delivery', 0, false, 4),
  ('asignado',        'out_for_delivery', 0, false, 4),
  ('en entrega',      'out_for_delivery', 0, false, 6),
  ('para entrega hoy','out_for_delivery', 0, false, 7),
  ('salió para entrega','out_for_delivery', 0, false, 6)
ON CONFLICT DO NOTHING;
