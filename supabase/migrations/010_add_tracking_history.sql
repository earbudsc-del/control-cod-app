-- ============================================================
-- 010_add_tracking_history.sql
-- Guarda el historial completo de estados y novedades de EFI.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tracking_history   JSONB,
  ADD COLUMN IF NOT EXISTS tracking_novedades JSONB;

COMMENT ON COLUMN orders.tracking_history IS
  'Historial de estados EFI: [{fecha, estado}]. Sobreescrito en cada actualización de tracking.';

COMMENT ON COLUMN orders.tracking_novedades IS
  'Historial de novedades EFI: [{fecha, mensaje}]. Sobreescrito en cada actualización de tracking.';
