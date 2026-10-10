-- ============================================================
-- 066_broadcast_c1_sending.sql
-- Sprint C.1 / C.1.2 — Broadcast operativo + Inbox humano.
--
-- PROPUESTA — NO APLICADA. Requiere revisión y autorización explícita.
-- Se aplica en el SQL Editor de Supabase (como el resto de las migraciones
-- del repo). Transacción única: falla todo o nada.
-- IDEMPOTENTE: re-ejecutarla después de aplicada no cambia nada ni falla
-- (IF NOT EXISTS / DROP … IF EXISTS antes de cada CREATE / ADD CONSTRAINT).
--
-- Qué agrega (todo aditivo, sin tocar filas existentes):
--   1. wa_broadcasts: estado 'paused', template interno de recompra,
--      auditoría de lanzamiento/pausa, clave idempotente de lanzamiento y
--      tope de envío.
--   2. wa_template_queue: estado 'send_unknown' (respuesta ambigua de Meta,
--      nunca se reintenta sola), código de error de Meta, template de
--      recompra en el CHECK de aislamiento y un teléfono por campaña.
--   3. wa_contact_preferences: baja de comunicaciones promocionales.
--   4. wa_broadcast_responses: respuestas de botones (intención).
--
-- Nombres de template — identificador INTERNO vs nombre en Meta:
--   La DB guarda SIEMPRE el identificador interno (los CHECK de abajo):
--     sd_broadcast_confirmation → Meta 'sd_broadcast_confirmation' (en)
--     sd_broadcast_repurchase   → Meta 'sd_broadcast_coordination' (es_DO)
--   El mapeo vive en src/lib/broadcast/templates.ts (META_TEMPLATE_CONTRACTS),
--   verificado contra la Graph API el 2026-10-09. 'sd_broadcast_coordination'
--   NO se admite como valor en la DB a propósito: un único identificador por
--   campaña, sin sinónimos.
--
-- Qué NO hace:
--   - No envía nada, no crea recipients, no cambia flags.
--   - No modifica el processor de automations (broadcast_id IS NULL sigue
--     siendo su barrera; ver src/lib/wa-queue/automation-queue.ts).
--
-- PRE-CHECK (solo lectura, antes de aplicar):
--   1) Nombres reales de los CHECK que se reemplazan (CHECK inline de 033/064
--      con nombre automático):
--      SELECT conrelid::regclass, conname FROM pg_constraint
--        WHERE conrelid IN ('wa_broadcasts'::regclass, 'wa_template_queue'::regclass) AND contype = 'c';
--      → deben existir EXACTAMENTE: wa_broadcasts_template_name_check,
--        wa_broadcasts_status_check, wa_template_queue_status_check,
--        wa_template_queue_broadcast_template_check. Si un nombre difiere, el
--        DROP IF EXISTS no lo quita y el CHECK viejo seguiría bloqueando
--        'paused' / 'send_unknown' / recompra: ajustar antes de aplicar.
--   2) FK usada por el historial (embed creator:profiles!wa_broadcasts_created_by_fkey):
--      SELECT conname FROM pg_constraint WHERE conrelid = 'wa_broadcasts'::regclass AND contype = 'f';
--      → debe incluir wa_broadcasts_created_by_fkey.
--   3) Duplicados que harían fallar el índice único de teléfono:
--      SELECT broadcast_id, phone_normalized, count(*) FROM wa_template_queue
--        WHERE broadcast_id IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;   → 0 filas
--   4) Estado actual (cualquier valor es compatible; solo se AMPLÍAN los CHECK):
--      SELECT status, count(*) FROM wa_broadcasts GROUP BY 1;
-- ============================================================

BEGIN;

-- ── 1. wa_broadcasts ─────────────────────────────────────────────────────────

ALTER TABLE wa_broadcasts DROP CONSTRAINT IF EXISTS wa_broadcasts_template_name_check;
ALTER TABLE wa_broadcasts ADD CONSTRAINT wa_broadcasts_template_name_check
  CHECK (template_name IN ('sd_broadcast_confirmation', 'sd_broadcast_repurchase'));

ALTER TABLE wa_broadcasts DROP CONSTRAINT IF EXISTS wa_broadcasts_status_check;
ALTER TABLE wa_broadcasts ADD CONSTRAINT wa_broadcasts_status_check
  CHECK (status IN ('draft', 'queued', 'processing', 'paused', 'completed', 'cancelled'));

ALTER TABLE wa_broadcasts
  ADD COLUMN IF NOT EXISTS launch_request_key UUID,
  ADD COLUMN IF NOT EXISTS launched_by        UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS launched_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS send_limit         INTEGER CHECK (send_limit IS NULL OR send_limit > 0),
  ADD COLUMN IF NOT EXISTS queued_count       INTEGER CHECK (queued_count IS NULL OR queued_count >= 0),
  ADD COLUMN IF NOT EXISTS launch_excluded_by_reason JSONB,
  ADD COLUMN IF NOT EXISTS paused_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_by          UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS resumed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resumed_by         UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS last_error         TEXT;

-- Lanzar dos veces con la misma clave = mismo lanzamiento (replay).
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_broadcasts_launch_request_key
  ON wa_broadcasts (store_id, launch_request_key)
  WHERE launch_request_key IS NOT NULL;

-- A lo sumo UNA campaña activa por tienda — ahora también cuenta 'paused'
-- (una campaña pausada sigue teniendo destinatarios pendientes).
DROP INDEX IF EXISTS idx_wa_broadcasts_one_running;
CREATE UNIQUE INDEX idx_wa_broadcasts_one_running
  ON wa_broadcasts (store_id)
  WHERE status IN ('queued', 'processing', 'paused');

-- ── 2. wa_template_queue ─────────────────────────────────────────────────────

ALTER TABLE wa_template_queue DROP CONSTRAINT IF EXISTS wa_template_queue_status_check;
ALTER TABLE wa_template_queue ADD CONSTRAINT wa_template_queue_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'skipped', 'failed', 'send_unknown'));

ALTER TABLE wa_template_queue DROP CONSTRAINT IF EXISTS wa_template_queue_broadcast_template_check;
ALTER TABLE wa_template_queue ADD CONSTRAINT wa_template_queue_broadcast_template_check
  CHECK ((broadcast_id IS NOT NULL) = (template_name IN ('sd_broadcast_confirmation', 'sd_broadcast_repurchase')));

ALTER TABLE wa_template_queue
  ADD COLUMN IF NOT EXISTS meta_error_code TEXT;

-- Un mismo número nunca recibe dos veces la misma campaña, aunque tenga
-- varios pedidos (la elegibilidad ya los excluye; esto es la red de la DB).
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_template_queue_broadcast_phone
  ON wa_template_queue (broadcast_id, phone_normalized)
  WHERE broadcast_id IS NOT NULL;

-- Lookup de respuestas/estados por wamid.
CREATE INDEX IF NOT EXISTS idx_wa_template_queue_wa_message_id
  ON wa_template_queue (wa_message_id)
  WHERE wa_message_id IS NOT NULL;

-- ── 3. wa_contact_preferences — baja promocional ─────────────────────────────
-- Distinto de rechazar un pedido ("Ya no lo deseo") o una oferta puntual
-- ("Ahora no"): solo una solicitud clara de no recibir mensajes
-- promocionales crea marketing_opt_out=true.

CREATE TABLE IF NOT EXISTS wa_contact_preferences (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id          UUID        NOT NULL REFERENCES stores(id),
  phone_normalized  TEXT        NOT NULL,
  marketing_opt_out BOOLEAN     NOT NULL DEFAULT false,
  opted_out_at      TIMESTAMPTZ,
  opt_out_source    TEXT        CHECK (opt_out_source IS NULL OR opt_out_source IN ('customer_keyword', 'agent')),
  opt_out_reason    TEXT,
  opted_out_by      UUID        REFERENCES profiles(id),
  source_message_id UUID        REFERENCES wa_messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, phone_normalized)
);

ALTER TABLE wa_contact_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_contact_preferences_select" ON wa_contact_preferences;
CREATE POLICY "wa_contact_preferences_select" ON wa_contact_preferences
  FOR SELECT USING (store_id = get_user_store_id() AND is_wa_inbox_role());
-- Escrituras: solo service role (webhook / endpoints server-side).

-- ── 4. wa_broadcast_responses — respuestas de botones ────────────────────────
-- queue_id ON DELETE SET NULL: la cola cae en cascada al borrar un pedido
-- (033: order_id ON DELETE CASCADE); la respuesta registrada se conserva
-- (sin recipient) en vez de bloquear el borrado.

CREATE TABLE IF NOT EXISTS wa_broadcast_responses (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id            UUID        NOT NULL REFERENCES stores(id),
  conversation_id     UUID        NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
  inbound_message_id  UUID        NOT NULL REFERENCES wa_messages(id) ON DELETE CASCADE,
  broadcast_id        UUID        REFERENCES wa_broadcasts(id),
  queue_id            UUID        REFERENCES wa_template_queue(id) ON DELETE SET NULL,
  order_id            UUID        REFERENCES orders(id) ON DELETE SET NULL,
  template_name       TEXT,
  button_text         TEXT,
  button_payload      TEXT,
  intent              TEXT        NOT NULL CHECK (intent IN (
                                    'confirm_interest', 'decline_order',
                                    'repurchase_interest', 'repurchase_decline', 'unknown')),
  association         TEXT        NOT NULL CHECK (association IN ('payload', 'context_wamid', 'none')),
  handled_at          TIMESTAMPTZ,
  handled_by          UUID        REFERENCES profiles(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inbound_message_id)   -- webhook duplicado → una sola fila
);

CREATE INDEX IF NOT EXISTS idx_wa_broadcast_responses_broadcast ON wa_broadcast_responses (broadcast_id, intent);
CREATE INDEX IF NOT EXISTS idx_wa_broadcast_responses_pending
  ON wa_broadcast_responses (store_id, conversation_id) WHERE handled_at IS NULL;

ALTER TABLE wa_broadcast_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_broadcast_responses_select" ON wa_broadcast_responses;
CREATE POLICY "wa_broadcast_responses_select" ON wa_broadcast_responses
  FOR SELECT USING (store_id = get_user_store_id() AND is_wa_inbox_role());
-- Escrituras: solo service role.

COMMIT;

-- ============================================================
-- VERIFICACIÓN (manual, después de aplicar)
-- ============================================================
-- Re-ejecutar este archivo completo → sin errores ni cambios (idempotencia).
-- SELECT count(*) FROM wa_template_queue WHERE broadcast_id IS NOT NULL;   → sin cambios
-- SELECT count(*) FROM wa_contact_preferences;                              → 0
-- SELECT count(*) FROM wa_broadcast_responses;                              → 0
-- SELECT confdeltype FROM pg_constraint
--   WHERE conrelid = 'wa_broadcast_responses'::regclass AND conname LIKE '%queue_id%';  → 'n' (SET NULL)
-- INSERT de prueba en wa_template_queue con template sd_broadcast_confirmation
--   y broadcast_id NULL → debe fallar (CHECK de aislamiento) — dentro de un
--   BEGIN … ROLLBACK para no dejar rastro.
--
-- ============================================================
-- ROLLBACK (solo si NO existen filas que dependan de lo nuevo:
--   wa_broadcasts en 'paused', wa_template_queue en 'send_unknown' o de
--   recompra, respuestas o preferencias registradas)
-- ============================================================
-- BEGIN;
-- DROP TABLE IF EXISTS wa_broadcast_responses;
-- DROP TABLE IF EXISTS wa_contact_preferences;
-- DROP INDEX IF EXISTS idx_wa_template_queue_wa_message_id;
-- DROP INDEX IF EXISTS idx_wa_template_queue_broadcast_phone;
-- ALTER TABLE wa_template_queue DROP COLUMN IF EXISTS meta_error_code;
-- ALTER TABLE wa_template_queue DROP CONSTRAINT IF EXISTS wa_template_queue_broadcast_template_check;
-- ALTER TABLE wa_template_queue ADD CONSTRAINT wa_template_queue_broadcast_template_check
--   CHECK ((broadcast_id IS NOT NULL) = (template_name = 'sd_broadcast_confirmation'));
-- ALTER TABLE wa_template_queue DROP CONSTRAINT IF EXISTS wa_template_queue_status_check;
-- ALTER TABLE wa_template_queue ADD CONSTRAINT wa_template_queue_status_check
--   CHECK (status IN ('pending', 'processing', 'sent', 'skipped', 'failed'));
-- DROP INDEX IF EXISTS idx_wa_broadcasts_one_running;
-- CREATE UNIQUE INDEX idx_wa_broadcasts_one_running ON wa_broadcasts (store_id)
--   WHERE status IN ('queued', 'processing');
-- DROP INDEX IF EXISTS idx_wa_broadcasts_launch_request_key;
-- ALTER TABLE wa_broadcasts
--   DROP COLUMN IF EXISTS launch_request_key, DROP COLUMN IF EXISTS launched_by,
--   DROP COLUMN IF EXISTS launched_at, DROP COLUMN IF EXISTS send_limit,
--   DROP COLUMN IF EXISTS queued_count, DROP COLUMN IF EXISTS launch_excluded_by_reason,
--   DROP COLUMN IF EXISTS paused_at, DROP COLUMN IF EXISTS paused_by,
--   DROP COLUMN IF EXISTS resumed_at, DROP COLUMN IF EXISTS resumed_by,
--   DROP COLUMN IF EXISTS last_error;
-- ALTER TABLE wa_broadcasts DROP CONSTRAINT IF EXISTS wa_broadcasts_status_check;
-- ALTER TABLE wa_broadcasts ADD CONSTRAINT wa_broadcasts_status_check
--   CHECK (status IN ('draft', 'queued', 'processing', 'completed', 'cancelled'));
-- ALTER TABLE wa_broadcasts DROP CONSTRAINT IF EXISTS wa_broadcasts_template_name_check;
-- ALTER TABLE wa_broadcasts ADD CONSTRAINT wa_broadcasts_template_name_check
--   CHECK (template_name IN ('sd_broadcast_confirmation'));
-- COMMIT;
