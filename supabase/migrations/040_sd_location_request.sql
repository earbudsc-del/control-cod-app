-- ============================================================
-- 040_sd_location_request.sql
-- Sprint 3A — mensaje automático SD (confirmación + solicitud de
-- ubicación) y recepción de ubicación por WhatsApp.
--
-- No crea tablas nuevas para el job en sí: reutiliza wa_template_queue
-- (migración 033) con template_name='sd_location_request'. La UNIQUE
-- (order_id, template_name) ya existente es la clave de idempotencia
-- pedida en el spec — no requiere columnas ni tablas adicionales.
--
-- Sí necesita almacenar la ubicación recibida (no existía ningún lugar
-- para eso) y permitir message_type='location' en wa_messages.
-- ============================================================

-- ── 1. wa_messages: permitir mensajes inbound de tipo 'location' ──────────
ALTER TABLE wa_messages DROP CONSTRAINT IF EXISTS wa_messages_message_type_check;

ALTER TABLE wa_messages ADD CONSTRAINT wa_messages_message_type_check
  CHECK (message_type IN (
    'text','image','audio','video',
    'document','sticker','template','unknown',
    'interactive','button_reply','location'
  ));

-- ── 2. orders: ubicación recibida vía WhatsApp (pedidos SD) ───────────────
-- Preparación del enlace pedida en el spec — NO es el motor de rutas.
-- sd_location_status:
--   NULL       → nunca se recibió ubicación para este pedido
--   'received' → se asignó sin ambigüedad al pedido más reciente compatible
--   'ambiguous'→ el cliente tiene más de un pedido activo compatible;
--                se asignó al más reciente igualmente, pero debe revisarse
--                manualmente antes de confiar en la coordenada
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sd_location_lat DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sd_location_lng DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sd_location_received_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sd_location_status TEXT
  CHECK (sd_location_status IS NULL OR sd_location_status IN ('received', 'ambiguous'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sd_location_wa_msg_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sd_location_conversation_id UUID REFERENCES wa_conversations(id);

CREATE INDEX IF NOT EXISTS idx_orders_sd_location_status
  ON orders (sd_location_status)
  WHERE sd_location_status IS NOT NULL;

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente para confirmar)
-- ============================================================
-- SELECT conname FROM pg_constraint WHERE conname = 'wa_messages_message_type_check';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'orders' AND column_name LIKE 'sd_location%';
