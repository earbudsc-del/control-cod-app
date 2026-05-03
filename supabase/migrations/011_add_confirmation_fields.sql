-- ============================================================
-- 011_add_confirmation_fields.sql
-- Módulo de confirmación de pedidos COD antes del despacho.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS confirmation_status TEXT DEFAULT 'pending'
    CHECK (confirmation_status IN ('pending', 'confirmed', 'unreachable', 'cancelled')),
  ADD COLUMN IF NOT EXISTS confirmation_attempts INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_confirmation_attempt TIMESTAMPTZ;

COMMENT ON COLUMN orders.confirmation_status IS
  'Estado de confirmación del cliente: pending|confirmed|unreachable|cancelled';
COMMENT ON COLUMN orders.confirmation_attempts IS
  'Número de intentos de confirmación realizados (máx 3).';
COMMENT ON COLUMN orders.last_confirmation_attempt IS
  'Timestamp del último intento de confirmación.';
