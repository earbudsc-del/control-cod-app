-- ============================================================
-- 008_add_novedad.sql
-- Agrega 'novedad' como estado normalizado para pedidos
-- con excepciones de entrega que requieren seguimiento activo.
--
-- ORDEN:
--   1. Ampliar CHECK de status_patterns
--   2. Ampliar CHECK de orders
--   3. Agregar columnas de seguimiento novedad
--   4. Insertar patrones
--   5. Reclasificar pedidos existentes
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. CHECK constraint de status_patterns
-- ─────────────────────────────────────────────────────────────
ALTER TABLE status_patterns
  DROP CONSTRAINT IF EXISTS status_patterns_normalized_status_check;

ALTER TABLE status_patterns
  ADD CONSTRAINT status_patterns_normalized_status_check
  CHECK (normalized_status IN (
    'pending',
    'in_transit',
    'out_for_delivery',
    'en_reparto',
    'novedad',
    'delivered',
    'failed_attempt',
    'returned',
    'unknown'
  ));

-- ─────────────────────────────────────────────────────────────
-- 2. CHECK constraint de orders
-- ─────────────────────────────────────────────────────────────
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_normalized_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_normalized_status_check
  CHECK (normalized_status IN (
    'pending',
    'in_transit',
    'out_for_delivery',
    'en_reparto',
    'novedad',
    'delivered',
    'failed_attempt',
    'returned',
    'unknown'
  ));

-- ─────────────────────────────────────────────────────────────
-- 3. Columnas de seguimiento para el módulo de novedades
--    (preparadas para uso futuro — no rompen flujo existente)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS novedad_motivo      TEXT,
  ADD COLUMN IF NOT EXISTS novedad_contactado  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS novedad_reprogramado BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS novedad_no_salvable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS novedad_updated_at  TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────
-- 4. Patrones de estado para novedades EFI Commerce
-- ─────────────────────────────────────────────────────────────
INSERT INTO status_patterns
  (pattern, normalized_status, attempt_increment, is_at_risk_trigger, priority)
VALUES
  ('novedad',                  'novedad', 1, true, 9),
  ('zona peligrosa',           'novedad', 1, true, 9),
  ('direccion incorrecta',     'novedad', 1, true, 8),
  ('dirección incorrecta',     'novedad', 1, true, 8),
  ('direccion no encontrada',  'novedad', 1, true, 8),
  ('dirección no encontrada',  'novedad', 1, true, 8),
  ('rechazado',                'novedad', 1, true, 8),
  ('rehusado',                 'novedad', 1, true, 8),
  ('devuelto por novedad',     'novedad', 1, true, 9),
  ('entrega fallida novedad',  'novedad', 1, true, 9),
  ('en espera de instrucciones','novedad', 0, true, 7)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 5. Reclasificar pedidos existentes con novedades en raw_status
-- ─────────────────────────────────────────────────────────────
UPDATE orders
SET
  normalized_status = 'novedad',
  novedad_motivo    = raw_status,
  updated_at        = NOW()
WHERE normalized_status NOT IN ('delivered', 'returned')
  AND raw_status IS NOT NULL
  AND (
    LOWER(raw_status) LIKE '%novedad%'                     OR
    LOWER(raw_status) LIKE '%zona peligrosa%'              OR
    LOWER(raw_status) LIKE '%direccion incorrecta%'        OR
    LOWER(raw_status) LIKE '%dirección incorrecta%'        OR
    LOWER(raw_status) LIKE '%direccion no encontrada%'     OR
    LOWER(raw_status) LIKE '%dirección no encontrada%'     OR
    LOWER(raw_status) LIKE '%rechazado%'                   OR
    LOWER(raw_status) LIKE '%rehusado%'                    OR
    LOWER(raw_status) LIKE '%en espera de instrucciones%'
  );
