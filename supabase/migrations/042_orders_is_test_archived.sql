-- ============================================================
-- 042_orders_is_test_archived.sql
-- Fase de estabilización Ruta COD — política segura para "archivar pedido
-- de prueba" sin borrado físico (sección 7 del pedido de estabilización).
--
-- No reutiliza normalized_status/confirmation_status (ninguno de los dos
-- CHECK constraints vigentes admite un valor "archivado"/"test" y no es su
-- responsabilidad semántica — esos campos describen el estado logístico y
-- de confirmación real del pedido, no si es un dato de prueba). Columnas
-- nuevas, aditivas, sin tocar ningún constraint existente.
--
-- is_test:     marca manual del admin ("esto es un pedido de prueba/ejemplo,
--              no debe aparecer en listas operativas"). Nunca lo setea
--              ningún flujo automático (webhook, cron, importación) — solo
--              el endpoint admin de archivado.
-- archived_at: momento en que se archivó. NULL = nunca archivado.
-- ============================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_is_test ON orders (is_test) WHERE is_test = true;

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente para confirmar)
-- ============================================================
-- SELECT is_test, archived_at FROM orders LIMIT 1;
-- Resultado esperado: is_test=false, archived_at=NULL para pedidos existentes.
