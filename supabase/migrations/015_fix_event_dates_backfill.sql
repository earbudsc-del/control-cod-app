-- ============================================================
-- 015_fix_event_dates_backfill.sql
-- Corrige el backfill de fechas EFI: el formato real es
-- "YYYY-MM-DD HH:MI AM" (no "DD/MM/YYYY HH24:MI" como asumía 014).
--
-- Ejemplo real observado en tracking_history:
--   {"fecha": "2026-04-24 11:51 AM", "estado": "En reparto"}
--
-- Estrategia:
--   1. Crear función auxiliar _try_parse_efi_date que maneja ambos
--      formatos con excepción silenciosa.
--   2. Backfill status_since  ← tracking_history[0].fecha
--   3. Backfill last_novedad_at ← tracking_novedades[last].fecha
--   4. shipment_created_at no tiene fuente en JSONB → queda NULL
--      hasta la próxima ejecución del cron de tracking.
--   5. Drop de la función auxiliar al final (cleanup).
--
-- Reglas:
--   - Solo actualiza filas donde el campo sigue NULL.
--   - Si el parseo falla, la fila queda NULL (no rompe).
--   - No toca filas que ya tienen valor (014 pudo haber poblado alguna).
--   - No elimina ni modifica tracking_history ni tracking_novedades.
-- ============================================================

-- ── 1. Función auxiliar de parseo seguro ─────────────────────────────────────
-- Maneja ambos formatos observados en EFI Commerce:
--   Formato A (actual):  "2026-04-24 11:51 AM"  →  YYYY-MM-DD HH12:MI AM
--   Formato B (legado):  "13/04/2025 10:15"     →  DD/MM/YYYY HH24:MI
--   Formato C (legado):  "13/04/2025"           →  DD/MM/YYYY
-- Retorna NULL ante cualquier otro string o excepción.

CREATE OR REPLACE FUNCTION _try_parse_efi_date(raw TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
  s TEXT := TRIM(COALESCE(raw, ''));
BEGIN
  IF s = '' THEN RETURN NULL; END IF;

  -- Formato A: YYYY-MM-DD HH:MI AM/PM  (formato real de EFI 2025-2026)
  IF s ~ '^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} [AaPp][Mm]$' THEN
    RETURN TO_TIMESTAMP(s, 'YYYY-MM-DD HH12:MI AM');
  END IF;

  -- Formato B: DD/MM/YYYY HH24:MI  (formato anterior / legado)
  IF s ~ '^\d{1,2}/\d{1,2}/\d{4} \d{1,2}:\d{2}$' THEN
    RETURN TO_TIMESTAMP(s, 'DD/MM/YYYY HH24:MI');
  END IF;

  -- Formato C: DD/MM/YYYY  (solo fecha, sin hora)
  IF s ~ '^\d{1,2}/\d{1,2}/\d{4}$' THEN
    RETURN TO_TIMESTAMP(s, 'DD/MM/YYYY');
  END IF;

  RETURN NULL;

EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- ── 2. Backfill de status_since ──────────────────────────────────────────────
-- Fuente: tracking_history[0].fecha  (índice 0 = evento más reciente en EFI)
-- Solo actualiza filas donde status_since IS NULL y el parseo produce valor.

UPDATE orders o
SET    status_since = parsed.dt
FROM (
  SELECT
    id,
    _try_parse_efi_date(
      TRIM((tracking_history -> 0) ->> 'fecha')
    ) AS dt
  FROM orders
  WHERE status_since IS NULL
    AND tracking_history IS NOT NULL
    AND jsonb_array_length(tracking_history) > 0
) parsed
WHERE o.id     = parsed.id
  AND parsed.dt IS NOT NULL;

-- ── 3. Backfill de last_novedad_at ───────────────────────────────────────────
-- Fuente: tracking_novedades[último].fecha
-- El último elemento es el intento más reciente (el array está en orden ascendente).
-- Solo actualiza filas donde last_novedad_at IS NULL.

UPDATE orders o
SET    last_novedad_at = parsed.dt
FROM (
  SELECT
    id,
    _try_parse_efi_date(
      TRIM(
        (tracking_novedades -> (jsonb_array_length(tracking_novedades) - 1))
        ->> 'fecha'
      )
    ) AS dt
  FROM orders
  WHERE last_novedad_at IS NULL
    AND tracking_novedades IS NOT NULL
    AND jsonb_array_length(tracking_novedades) > 0
) parsed
WHERE o.id     = parsed.id
  AND parsed.dt IS NOT NULL;

-- ── 4. shipment_created_at ───────────────────────────────────────────────────
-- fecha_creacion de EFI no se almacena en ningún JSONB existente.
-- No hay backfill posible desde datos históricos.
-- El cron de tracking poblará este campo a partir de la próxima ejecución.

-- ── 5. Cleanup ───────────────────────────────────────────────────────────────
DROP FUNCTION _try_parse_efi_date(TEXT);
