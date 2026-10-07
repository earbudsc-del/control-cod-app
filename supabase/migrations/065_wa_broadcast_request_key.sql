-- ============================================================
-- 065_wa_broadcast_request_key.sql
-- Sprint Broadcast B.1 — idempotencia real (DB-level) al crear drafts.
--
-- Cada apertura del modal "Preparar WhatsApp" genera una request_key (UUID).
-- POST /api/admin/broadcasts la envía; si dos requests concurrentes llegan con
-- la misma (store_id, request_key), el UNIQUE garantiza que solo UNA fila
-- exista. La request perdedora recibe 23505 y el servidor devuelve el draft
-- ya creado (nunca 500, nunca un segundo draft).
--
-- La key vive en una columna explícita — no escondida en selection_filter.
--
-- Tabla vacía al momento de escribir esta migración (wa_broadcasts = 0 filas
-- en producción, verificado en el post-check de A.2). Por eso la columna
-- puede ser NOT NULL sin DEFAULT ni backfill. El guard de abajo aborta la
-- migración completa si eso dejara de ser cierto, en vez de inventar keys.
--
-- PRE-CHECK (solo lectura): SELECT count(*) FROM wa_broadcasts;  → esperado 0
--
-- ROLLBACK conceptual (si hiciera falta, antes de que exista código que la use):
--   ALTER TABLE wa_broadcasts DROP CONSTRAINT wa_broadcasts_store_request_key_key;
--   ALTER TABLE wa_broadcasts DROP COLUMN request_key;
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM wa_broadcasts) THEN
    RAISE EXCEPTION '065: wa_broadcasts no está vacía — definir backfill de request_key antes de aplicar';
  END IF;
END $$;

ALTER TABLE wa_broadcasts
  ADD COLUMN request_key UUID NOT NULL;

-- Unicidad por tienda. El índice único que crea el constraint también sirve
-- para el lookup de replay (WHERE store_id = $1 AND request_key = $2).
ALTER TABLE wa_broadcasts
  ADD CONSTRAINT wa_broadcasts_store_request_key_key UNIQUE (store_id, request_key);

-- ============================================================
-- VERIFICACIÓN (manual, después de aplicar)
-- ============================================================
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
--  WHERE table_name = 'wa_broadcasts' AND column_name = 'request_key';
--   → request_key | uuid | NO
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'wa_broadcasts'::regclass AND conname = 'wa_broadcasts_store_request_key_key';
--   → UNIQUE (store_id, request_key)
