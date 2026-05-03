-- ============================================================
-- 007_add_en_reparto.sql
-- Agrega 'en_reparto' como estado normalizado propio,
-- distinto de 'out_for_delivery' (reprogramado/futuro).
--
-- ORDEN OBLIGATORIO:
--   1. Ampliar CHECK de status_patterns  ← primero, o los INSERT fallan
--   2. Ampliar CHECK de orders
--   3. Insertar/actualizar patrones
--   4. Reclasificar pedidos existentes
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
    'delivered',
    'failed_attempt',
    'returned',
    'unknown'
  ));

-- ─────────────────────────────────────────────────────────────
-- 3. Patrones de estado (status_patterns)
-- ─────────────────────────────────────────────────────────────

-- 3a. Migrar patrones existentes que ya apuntaban a out_for_delivery
--     pero significan "entrega hoy"
UPDATE status_patterns
SET normalized_status = 'en_reparto'
WHERE pattern IN (
  'en reparto',
  'en_reparto',
  'EN_REPARTO',
  'reparto',
  'en despacho',
  'despacho',
  'asignado',
  'en entrega',
  'para entrega hoy',
  'salió para entrega',
  'en ruta',
  'en camino',
  'salió a reparto',
  'con mensajero'
);

-- 3b. Insertar los que no existían aún
INSERT INTO status_patterns
  (pattern, normalized_status, attempt_increment, is_at_risk_trigger, priority)
VALUES
  ('en reparto',         'en_reparto', 0, false, 7),
  ('en_reparto',         'en_reparto', 0, false, 7),
  ('EN_REPARTO',         'en_reparto', 0, false, 7),
  ('reparto',            'en_reparto', 0, false, 6),
  ('en despacho',        'en_reparto', 0, false, 6),
  ('despacho',           'en_reparto', 0, false, 5),
  ('asignado',           'en_reparto', 0, false, 5),
  ('en entrega',         'en_reparto', 0, false, 7),
  ('para entrega hoy',   'en_reparto', 0, false, 8),
  ('salió para entrega', 'en_reparto', 0, false, 7),
  ('en ruta',            'en_reparto', 0, false, 6),
  ('en camino',          'en_reparto', 0, false, 6),
  ('salió a reparto',    'en_reparto', 0, false, 6),
  ('con mensajero',      'en_reparto', 0, false, 6)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 4. Reclasificar pedidos importados antes de esta migración
-- ─────────────────────────────────────────────────────────────
UPDATE orders
SET
  normalized_status = 'en_reparto',
  updated_at        = NOW()
WHERE normalized_status IN ('out_for_delivery', 'unknown')
  AND raw_status IS NOT NULL
  AND (
    LOWER(raw_status) LIKE '%en reparto%'          OR
    LOWER(raw_status) LIKE '%en_reparto%'          OR
    LOWER(raw_status) LIKE '%reparto%'             OR
    LOWER(raw_status) LIKE '%en despacho%'         OR
    LOWER(raw_status) LIKE '%en entrega%'          OR
    LOWER(raw_status) LIKE '%para entrega hoy%'    OR
    LOWER(raw_status) LIKE '%salió para entrega%'  OR
    LOWER(raw_status) LIKE '%en ruta%'             OR
    LOWER(raw_status) LIKE '%en camino%'           OR
    LOWER(raw_status) LIKE '%con mensajero%'       OR
    LOWER(raw_status) LIKE '%salió a reparto%'
  );
