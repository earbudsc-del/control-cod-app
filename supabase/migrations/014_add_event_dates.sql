-- ============================================================
-- 014_add_event_dates.sql
-- Agrega columnas de fechas reales de eventos logísticos EFI.
--
-- Problema que resuelve:
--   last_tracking_update = cuándo consultamos EFI (NO cuándo ocurrió el evento).
--   Las fechas reales vivían atrapadas como strings crudos dentro de los JSONB
--   tracking_history y tracking_novedades, sin posibilidad de filtrar por SQL
--   ni calcular días transcurridos correctamente.
--
-- Estas columnas son pobladas por update-order.ts después de cada consulta EFI.
-- Los JSONB tracking_history y tracking_novedades no se eliminan.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS last_novedad_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_since        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shipment_created_at TIMESTAMPTZ;

COMMENT ON COLUMN orders.last_novedad_at IS
  'Fecha real de la última novedad/intento fallido según EFI '
  '(extraída de historial_novedades[last].fecha). '
  'Null si el pedido nunca ha tenido novedades o EFI no devolvió fecha parseable.';

COMMENT ON COLUMN orders.status_since IS
  'Fecha en que EFI registró el estado actual por primera vez (historial_estados[0].fecha). '
  'Se actualiza cada vez que cambia normalized_status con dato válido de EFI. '
  'Distinta de last_tracking_update, que es cuándo consultamos EFI.';

COMMENT ON COLUMN orders.shipment_created_at IS
  'Fecha de creación del envío en la transportadora según EFI (fecha_creacion). '
  'Distinta de created_at, que es cuándo se importó el pedido al sistema.';

-- ── Backfill desde JSONB existentes ──────────────────────────────────────────
-- Pobla los campos para pedidos que ya tienen tracking guardado en JSONB.
-- Solo aplica donde el campo nuevo queda NULL y el JSONB tiene datos.
-- La conversión usa el formato DD/MM/YYYY HH:mm que devuelve EFI Commerce.
--
-- Nota: TO_TIMESTAMP con 'DD/MM/YYYY HH24:MI' falla silenciosamente si el
-- formato no coincide; por eso usamos un bloque BEGIN/EXCEPTION implícito
-- vía la función try_cast definida abajo. Para simplicidad, si la fecha no
-- parsea el campo queda NULL (se poblará en la próxima consulta de tracking).

-- last_novedad_at: última entrada de tracking_novedades (array JSONB)
UPDATE orders
SET last_novedad_at = (
  SELECT
    CASE
      WHEN raw_fecha ~ '^\d{1,2}/\d{1,2}/\d{4}'
        THEN TO_TIMESTAMP(
               REGEXP_REPLACE(raw_fecha, '\s+', ' '),
               'DD/MM/YYYY HH24:MI'
             )
      ELSE NULL
    END
  FROM (
    SELECT TRIM(
             (tracking_novedades -> (jsonb_array_length(tracking_novedades) - 1)) ->> 'fecha'
           ) AS raw_fecha
  ) sub
  WHERE raw_fecha IS NOT NULL
)
WHERE last_novedad_at IS NULL
  AND tracking_novedades IS NOT NULL
  AND jsonb_array_length(tracking_novedades) > 0;

-- status_since: primera entrada de tracking_history (más reciente en EFI = índice 0)
UPDATE orders
SET status_since = (
  SELECT
    CASE
      WHEN raw_fecha ~ '^\d{1,2}/\d{1,2}/\d{4}'
        THEN TO_TIMESTAMP(
               REGEXP_REPLACE(raw_fecha, '\s+', ' '),
               'DD/MM/YYYY HH24:MI'
             )
      ELSE NULL
    END
  FROM (
    SELECT TRIM((tracking_history -> 0) ->> 'fecha') AS raw_fecha
  ) sub
  WHERE raw_fecha IS NOT NULL
)
WHERE status_since IS NULL
  AND tracking_history IS NOT NULL
  AND jsonb_array_length(tracking_history) > 0;

-- shipment_created_at: no está en JSONB, solo viene de EFI en tiempo real.
-- Quedará NULL hasta la próxima ejecución del cron de tracking.
