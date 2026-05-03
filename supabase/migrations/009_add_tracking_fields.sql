-- ============================================================
-- 009_add_tracking_fields.sql
-- Agrega campos para sincronización manual de tracking EFI.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS last_tracking_update TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_attempt_reason  TEXT;

COMMENT ON COLUMN orders.last_tracking_update IS
  'Timestamp de la última vez que se consultó el tracking en EFI manualmente.';

COMMENT ON COLUMN orders.last_attempt_reason IS
  'Texto de la última novedad/excepción registrada en EFI al momento del último tracking.';
