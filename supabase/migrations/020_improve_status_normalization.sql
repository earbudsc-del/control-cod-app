-- ============================================================
-- 020_improve_status_normalization.sql
--
-- Objetivo: re-normalizar orders existentes cuyo raw_status
-- indica un estado real pero normalized_status es 'unknown'
-- (o cualquier otro estado menos específico).
--
-- DISEÑO DE SEGURIDAD:
--   • El orden de los UPDATE importa: returned → delivered → novedad → en_reparto.
--     Esto garantiza que "entregada a origen" y "dev. entregada a origen"
--     sean clasificados como returned, no como delivered.
--   • Solo se tocan filas cuyo raw_status coincide con el patrón objetivo.
--   • Ningún UPDATE toca filas ya correctamente clasificadas como
--     returned o delivered (estados terminales).
-- ============================================================


-- ── 1. RETURNED ──────────────────────────────────────────────────────────────
-- Prioridad máxima: cubre variantes de devolución/retorno.
-- "a origen" cubre "entregada a origen" y "dev. entregada a origen".
-- Se excluye solo 'returned' (ya está bien), no 'delivered': un pedido
-- que el CSV marcó como 'delivered' pero cuyo raw_status dice "devuelta"
-- debe corregirse.

UPDATE orders
SET
  normalized_status = 'returned',
  updated_at        = NOW()
WHERE normalized_status != 'returned'
  AND raw_status IS NOT NULL
  AND (
    LOWER(raw_status) LIKE '%devoluc%'            -- devolución, devolucion, devolucion entregada
    OR LOWER(raw_status) LIKE '%devuelto%'
    OR LOWER(raw_status) LIKE '%devuelta%'
    OR LOWER(raw_status) LIKE '%retornado%'
    OR LOWER(raw_status) LIKE '%retorno%'
    OR LOWER(raw_status) LIKE '%regresado%'
    OR LOWER(raw_status) LIKE '%a origen%'        -- entregada a origen, dev. entregada a origen
  );


-- ── 2. DELIVERED ─────────────────────────────────────────────────────────────
-- Solo aplica a filas que no quedaron como returned en el paso anterior.

UPDATE orders
SET
  normalized_status = 'delivered',
  updated_at        = NOW()
WHERE normalized_status NOT IN ('returned', 'delivered')
  AND raw_status IS NOT NULL
  AND (
    LOWER(raw_status) LIKE '%entregado%'           -- entregado, entregado al cliente
    OR LOWER(raw_status) LIKE '%entregada%'        -- entregada, entregada al cliente
    OR LOWER(raw_status) LIKE '%entrega exitosa%'
    OR LOWER(raw_status) LIKE '%entrega completada%'
  );


-- ── 3. NOVEDAD ───────────────────────────────────────────────────────────────
-- No tocar delivered ni returned.

UPDATE orders
SET
  normalized_status = 'novedad',
  updated_at        = NOW()
WHERE normalized_status NOT IN ('returned', 'delivered')
  AND raw_status IS NOT NULL
  AND (
    LOWER(raw_status) LIKE '%novedad%'
    OR LOWER(raw_status) LIKE '%ausente%'
    OR LOWER(raw_status) LIKE '%rechazado%'
    OR LOWER(raw_status) LIKE '%rehusado%'
    OR LOWER(raw_status) LIKE '%zona peligrosa%'
    OR LOWER(raw_status) LIKE '%no encontrado%'
    OR LOWER(raw_status) LIKE '%no encontrada%'
    OR LOWER(raw_status) LIKE '%direcci_n incorrecta%'   -- tilde o sin tilde
    OR LOWER(raw_status) LIKE '%direccion incorrecta%'
    OR LOWER(raw_status) LIKE '%dirección incorrecta%'
    OR LOWER(raw_status) LIKE '%direcci_n no encontrada%'
    OR LOWER(raw_status) LIKE '%direccion no encontrada%'
    OR LOWER(raw_status) LIKE '%dirección no encontrada%'
    OR LOWER(raw_status) LIKE '%no localizado%'
    OR LOWER(raw_status) LIKE '%devuelto por novedad%'
    OR LOWER(raw_status) LIKE '%en espera de instrucciones%'
  );


-- ── 4. EN_REPARTO ────────────────────────────────────────────────────────────
-- Solo aplica si el status no quedó en returned/delivered/novedad.

UPDATE orders
SET
  normalized_status = 'en_reparto',
  updated_at        = NOW()
WHERE normalized_status NOT IN ('returned', 'delivered', 'novedad')
  AND raw_status IS NOT NULL
  AND (
    LOWER(raw_status) LIKE '%en reparto%'
    OR LOWER(raw_status) LIKE '%en_reparto%'
    OR LOWER(raw_status) LIKE '%reparto%'
    OR LOWER(raw_status) LIKE '%en ruta%'
    OR LOWER(raw_status) LIKE '%en camino%'
    OR LOWER(raw_status) LIKE '%en entrega%'
    OR LOWER(raw_status) LIKE '%en despacho%'
    OR LOWER(raw_status) LIKE '%despacho%'
    OR LOWER(raw_status) LIKE '%mensajero%'
    OR LOWER(raw_status) LIKE '%con mensajero%'
    OR LOWER(raw_status) LIKE '%sali_ para entrega%'  -- salió / salio
    OR LOWER(raw_status) LIKE '%salio para entrega%'
    OR LOWER(raw_status) LIKE '%salió para entrega%'
    OR LOWER(raw_status) LIKE '%sali_ a reparto%'
    OR LOWER(raw_status) LIKE '%salio a reparto%'
    OR LOWER(raw_status) LIKE '%salió a reparto%'
    OR LOWER(raw_status) LIKE '%asignado%'
    OR LOWER(raw_status) LIKE '%para entrega hoy%'
  );


-- ── 5. Resumen de cambios (para verificar en SQL Editor) ─────────────────────
-- Ejecuta este SELECT después del script para ver cuántas filas cambiaron
-- por estado. El campo updated_at fue tocado por este script.
--
-- SELECT normalized_status, COUNT(*)
-- FROM orders
-- GROUP BY normalized_status
-- ORDER BY COUNT(*) DESC;
