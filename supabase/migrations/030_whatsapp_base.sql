-- ============================================================
-- 030_whatsapp_base.sql
-- Tablas base del Inbox WhatsApp: wa_contacts, wa_conversations,
-- wa_messages.
--
-- Reglas de diseño:
--   - Ninguna tabla existente es modificada.
--   - RLS compatible con get_user_store_id() / get_user_role().
--   - El webhook usa createServiceClient() → bypassa RLS en writes.
--   - wa_messages incluye store_id denormalizado para RLS directo
--     y métricas futuras sin JOIN a wa_conversations.
--   - Un contacto puede tener solo UNA conversación activa (open o
--     pending) a la vez. Conversaciones cerradas no tienen límite.
--   - last_message_preview debe truncarse a 100-150 chars desde
--     el webhook antes de insertar. La columna acepta TEXT pero el
--     contrato de escritura es el webhook, no la DB constraint.
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. wa_contacts
-- Un contacto = un número de teléfono normalizado por tienda.
-- Creado y actualizado por el webhook al recibir mensajes.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE wa_contacts (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id         UUID        NOT NULL REFERENCES stores(id),
  phone_normalized TEXT        NOT NULL,
  -- E.164 sin "+" ni espacios: "18091234567"
  -- Normalizar antes de insertar: strip +, spaces, dashes, parens
  display_name     TEXT,
  -- Nombre del payload de Meta, o inferido de orders.customer_name al vincular
  wa_id            TEXT,
  -- WhatsApp internal contact ID devuelto por Meta
  order_id         UUID        REFERENCES orders(id) ON DELETE SET NULL,
  -- Pedido más reciente vinculado por phone match. Nullable.
  -- ON DELETE SET NULL: si el pedido se elimina, el contacto sigue existiendo.
  last_seen_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, phone_normalized)
  -- Un número = un contacto por tienda.
  -- Clave de deduplicación: ON CONFLICT (store_id, phone_normalized) DO UPDATE.
);

-- ──────────────────────────────────────────────────────────────
-- 2. wa_conversations
-- Hilo de conversación por contacto.
-- Un contacto solo puede tener UNA conversación activa (open/pending)
-- a la vez — enforced por índice único parcial (ver abajo).
-- Conversaciones cerradas son historial inmutable.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE wa_conversations (
  id                   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id             UUID        NOT NULL REFERENCES stores(id),
  -- Denormalizado desde wa_contacts para RLS directo sin JOIN
  contact_id           UUID        NOT NULL REFERENCES wa_contacts(id),
  status               TEXT        NOT NULL DEFAULT 'open'
                                     CHECK (status IN ('open','pending','closed')),
  assigned_to          UUID        REFERENCES profiles(id),
  -- Nullable: conversación sin asignar hasta que un agente la toma
  unread_count         INTEGER     NOT NULL DEFAULT 0,
  last_message_at      TIMESTAMPTZ,
  -- Actualizado por el webhook en cada mensaje entrante o saliente.
  -- Ordena la lista del inbox: conversaciones más recientes primero.
  last_message_preview TEXT,
  -- Snapshot del cuerpo del último mensaje para la lista de chats.
  -- CONTRATO: el webhook debe truncar a 100-150 chars antes de escribir.
  -- Ejemplo: LEFT(body, 150) || CASE WHEN length(body) > 150 THEN '…' ELSE '' END
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────
-- 3. wa_messages
-- Un registro por mensaje (entrante y saliente).
-- wa_msg_id es el ID de Meta — ancla de deduplicación absoluta.
-- store_id denormalizado para RLS directo y métricas sin JOIN.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE wa_messages (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id        UUID        NOT NULL REFERENCES stores(id),
  -- Denormalizado desde wa_conversations al insertar.
  -- Copiado por el webhook: store_id = conversation.store_id
  -- Permite RLS directo, queries de métricas y búsquedas globales
  -- sin JOIN a wa_conversations.
  conversation_id UUID        NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
  -- CASCADE: si se elimina la conversación, sus mensajes desaparecen.
  wa_msg_id       TEXT        NOT NULL,
  -- "wamid.HBgN..." — ID único asignado por Meta a cada mensaje.
  -- Clave de deduplicación: INSERT ... ON CONFLICT (wa_msg_id) DO NOTHING
  direction       TEXT        NOT NULL
                                CHECK (direction IN ('inbound','outbound')),
  message_type    TEXT        NOT NULL DEFAULT 'text'
                                CHECK (message_type IN (
                                  'text','image','audio','video',
                                  'document','sticker','template','unknown'
                                )),
  body            TEXT,
  -- Texto plano del mensaje. NULL si es media sin caption.
  raw_payload     JSONB,
  -- Payload completo del objeto "message" de Meta.
  -- Permite reprocesar sin perder info (media_id, context, etc.)
  status          TEXT        NOT NULL DEFAULT 'received'
                                CHECK (status IN (
                                  'pending',    -- outbound: en cola, aún no enviado
                                  'sent',       -- outbound: Meta confirmó envío
                                  'delivered',  -- Meta confirmó entrega al dispositivo
                                  'read',       -- el destinatario abrió el mensaje
                                  'failed',     -- error de Meta al enviar
                                  'received'    -- inbound: llegó al webhook
                                )),
  sent_by         UUID        REFERENCES profiles(id),
  -- NULL para mensajes inbound. UUID del agente para outbound (Fase 1B).
  error_code      TEXT,
  -- Código de error de Meta si status = 'failed' (ej: 131026 = outside window)
  sent_at         TIMESTAMPTZ,
  -- Timestamp original del campo "timestamp" del payload de Meta.
  -- Para inbound: cuándo el cliente lo envió.
  -- Para outbound: cuándo Meta lo procesó.
  delivered_at    TIMESTAMPTZ,
  -- Actualizado por el webhook cuando llega evento status=delivered
  read_at         TIMESTAMPTZ,
  -- Actualizado por el webhook cuando llega evento status=read
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wa_msg_id)
  -- Hard constraint a nivel DB.
  -- INSERT ... ON CONFLICT (wa_msg_id) DO NOTHING absorbe reintentos de Meta.
);

-- ============================================================
-- ÍNDICES
-- ============================================================

-- ── wa_contacts ───────────────────────────────────────────────
-- UNIQUE(store_id, phone_normalized) ya actúa como índice compuesto.
-- Cubre: lookup de contacto por (store_id, phone) en el webhook.

CREATE INDEX idx_wa_contacts_store
  ON wa_contacts (store_id);
-- Para listar todos los contactos de una tienda.

CREATE INDEX idx_wa_contacts_phone
  ON wa_contacts (phone_normalized);
-- Búsqueda cross-store por teléfono (normalización, diagnóstico).
-- Útil cuando el webhook recibe un número y no tiene el store_id
-- todavía confirmado.

-- ── wa_conversations ──────────────────────────────────────────
CREATE INDEX idx_wa_convs_store_last
  ON wa_conversations (store_id, last_message_at DESC NULLS LAST);
-- Ordena el inbox: conversaciones más recientes primero.
-- Query principal de GET /api/whatsapp/conversations.

CREATE INDEX idx_wa_convs_store_status
  ON wa_conversations (store_id, status);
-- Filtra por estado: Abiertos / Pendientes / Cerrados.

CREATE INDEX idx_wa_convs_contact
  ON wa_conversations (contact_id);
-- Busca la conversación activa de un contacto específico.
-- Usado por el webhook al recibir mensaje: existe conversación activa?

CREATE INDEX idx_wa_convs_assigned
  ON wa_conversations (assigned_to)
  WHERE assigned_to IS NOT NULL;
-- Filtra "mis conversaciones" para un agente. Índice parcial
-- que excluye las no asignadas (mayoría del tiempo).

-- Índice único parcial: un contacto solo puede tener UNA conversación
-- activa (open o pending) a la vez. Las conversaciones closed no cuentan.
-- El webhook debe cerrar la conversación existente antes de crear una nueva,
-- o reutilizar la existente si ya está open/pending.
CREATE UNIQUE INDEX idx_wa_convs_one_active_per_contact
  ON wa_conversations (contact_id)
  WHERE status != 'closed';

-- ── wa_messages ───────────────────────────────────────────────
CREATE INDEX idx_wa_msgs_conv_sent
  ON wa_messages (conversation_id, sent_at ASC NULLS LAST);
-- Carga el historial de mensajes de una conversación ordenado
-- cronológicamente. Query principal del chat abierto.

CREATE INDEX idx_wa_messages_store_sent
  ON wa_messages (store_id, sent_at DESC NULLS LAST);
-- Métricas globales por tienda: mensajes hoy, volumen, etc.
-- También útil para dashboards futuros sin JOIN.
-- UNIQUE(wa_msg_id) ya actúa como índice para deduplicación lookup.

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Reutilizar fn_update_updated_at() de migration 003 (ya existe).
-- No hay que recrearla ni modificarla.

CREATE TRIGGER trg_wa_contacts_updated_at
  BEFORE UPDATE ON wa_contacts
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();

CREATE TRIGGER trg_wa_conversations_updated_at
  BEFORE UPDATE ON wa_conversations
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();

-- wa_messages no tiene trigger de updated_at.
-- Los mensajes son esencialmente inmutables después de insertar.
-- Solo se actualizan delivered_at, read_at, status vía UPDATE directo
-- desde el webhook (createServiceClient) — no necesita trigger.

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE wa_contacts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_messages      ENABLE ROW LEVEL SECURITY;

-- ── Helper: roles con acceso al Inbox WhatsApp ────────────────
-- Complementa is_agent_or_above() (que cubre todos los roles operativos).
-- delivery_agent y santo_domingo_delivery_agent NO tienen inbox.
-- Se puede ampliar en migraciones futuras sin tocar esta.
CREATE OR REPLACE FUNCTION is_wa_inbox_role()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT get_user_role() IN (
    'admin',
    'ia_supervisor',
    'confirmation_agent',
    'dispatch_agent',
    'novelty_agent',
    'agent'
  )
$$;

-- ── wa_contacts ───────────────────────────────────────────────
-- SELECT: agentes del inbox pueden ver contactos de su tienda.
-- INSERT/UPDATE: solo el webhook vía createServiceClient() (bypassa RLS).
CREATE POLICY "wa_contacts_select" ON wa_contacts
  FOR SELECT USING (
    store_id = get_user_store_id()
    AND is_wa_inbox_role()
  );

-- ── wa_conversations ──────────────────────────────────────────
-- SELECT: agentes del inbox ven todas las conversaciones de su tienda.
CREATE POLICY "wa_conversations_select" ON wa_conversations
  FOR SELECT USING (
    store_id = get_user_store_id()
    AND is_wa_inbox_role()
  );

-- UPDATE: agentes pueden cambiar status, asignar, limpiar unread_count.
-- La granularidad de quién puede hacer qué se controla en la capa API,
-- no en RLS (mismo patrón que orders_update en 002_rls.sql).
CREATE POLICY "wa_conversations_update" ON wa_conversations
  FOR UPDATE USING (
    store_id = get_user_store_id()
    AND is_wa_inbox_role()
  );

-- ── wa_messages ───────────────────────────────────────────────
-- SELECT: usa store_id directo — sin EXISTS ni JOIN.
-- Más eficiente que la indirección a través de wa_conversations.
-- Posible gracias a la denormalización de store_id en la tabla.
CREATE POLICY "wa_messages_select" ON wa_messages
  FOR SELECT USING (
    store_id = get_user_store_id()
    AND is_wa_inbox_role()
  );

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente para confirmar)
-- ============================================================
-- SELECT tablename FROM pg_tables
-- WHERE schemaname = 'public' AND tablename LIKE 'wa_%'
-- ORDER BY tablename;
-- Resultado esperado: wa_contacts, wa_conversations, wa_messages
--
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename LIKE 'wa_%'
-- ORDER BY tablename, indexname;
-- Resultado esperado: 8 índices (incluye los de UNIQUE y PK)
--
-- SELECT proname FROM pg_proc WHERE proname = 'is_wa_inbox_role';
-- Resultado esperado: 1 row
