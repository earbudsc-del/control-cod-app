-- ============================================================
-- 053_customer_identity.sql
-- Customer Intelligence Engine — Fase 1: infraestructura de identidad.
--
-- Ver docs/CUSTOMER_INTELLIGENCE_ARCHITECTURE_V1.md (secciones 1-3, 8.1-8.2, 11).
--
-- Alcance de esta migración — SOLO identidad:
--   - customers: identidad básica por cliente, por tienda (sin RFM, sin
--     comportamiento COD, sin consentimiento, sin campos de Génesis — esos
--     se agregan en fases posteriores vía ALTER TABLE aditivo).
--   - customer_identifiers: identificadores secundarios (teléfonos
--     alternativos, email, shopify_customer_id) con historial de reemplazo.
--
-- Explícitamente NO en esta migración:
--   - Ninguna columna ni FK hacia orders, wa_contacts, wa_conversations,
--     wa_messages ni abandoned_carts. Ninguna de esas tablas se modifica.
--   - customers.wa_contact_id (se agrega cuando se autorice conectar el
--     Inbox, no ahora).
--   - Ningún backfill de datos existentes.
--
-- Corrección de diseño respecto al documento de arquitectura (sección 2.2):
--   El documento define UNIQUE(identifier_type, value_normalized) como
--   restricción GLOBAL. Pero la sección 10 del mismo documento establece
--   identidad por tienda — el mismo teléfono debe poder pertenecer a un
--   customer distinto en cada tienda. Aquí se corrige a
--   UNIQUE(store_id, identifier_type, value_normalized), con store_id
--   denormalizado en customer_identifiers (mismo patrón que
--   wa_messages.store_id en 030_whatsapp_base.sql, "para RLS directo sin
--   JOIN").
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. customers
-- Identidad básica de un cliente, por tienda. phone_primary usa el mismo
-- formato (11 dígitos, sin '+') que ya escriben orders.customer_phone y
-- wa_contacts.phone_normalized hoy (normalizePhoneRD) — para que una futura
-- fase de conexión compare strings iguales sin transformar nada.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE customers (
  id                   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id             UUID        NOT NULL REFERENCES stores(id),
  phone_primary        TEXT        NOT NULL,
  full_name            TEXT,
  email                TEXT,
  shopify_customer_id  TEXT,
  -- Hoy siempre NULL — no existe ningún escritor todavía (requeriría tocar
  -- el webhook de Shopify, fuera de alcance de esta fase).
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, phone_primary)
);

-- ──────────────────────────────────────────────────────────────
-- 2. customer_identifiers
-- Identificadores secundarios de un cliente (teléfonos alternativos, email,
-- shopify_customer_id). El UNIQUE es la barrera dura contra que dos
-- customers de la MISMA tienda reclamen el mismo identificador a la vez —
-- store_id lo escopea para que el mismo teléfono sí pueda existir en dos
-- tiendas distintas (identidad no compartida entre tiendas, sección 10).
-- ──────────────────────────────────────────────────────────────
CREATE TABLE customer_identifiers (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id       UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  store_id          UUID        NOT NULL REFERENCES stores(id),
  -- Denormalizado desde customers.store_id — mismo patrón que
  -- wa_messages.store_id (030_whatsapp_base.sql): RLS directo sin JOIN,
  -- y aquí además necesario para que el UNIQUE de abajo quede escopeado
  -- por tienda en vez de global.
  identifier_type   TEXT        NOT NULL
                                  CHECK (identifier_type IN ('phone','email','shopify_customer_id')),
  value_normalized  TEXT        NOT NULL,
  is_primary        BOOLEAN     NOT NULL DEFAULT false,
  active            BOOLEAN     NOT NULL DEFAULT true,
  -- false = identificador reemplazado (ver replaced_by) — nunca se borra,
  -- se desactiva. Conserva el historial completo (sección 2.3).
  confidence        NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  -- 1.000 = fuente transaccional directa (pedido pagado, mensaje real).
  -- Menor confianza queda reservada para señales futuras de coincidencia
  -- por similitud (no usado en esta fase — no hay detección automática
  -- de duplicados todavía).
  source            TEXT        NOT NULL
                                  CHECK (source IN ('shopify_webhook','whatsapp_webhook','manual')),
  replaced_by       UUID        REFERENCES customer_identifiers(id),
  -- Encadena identificadores cuando un cliente cambia de número — nunca se
  -- borra el identificador viejo, se marca active=false y se apunta aquí.
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, identifier_type, value_normalized)
);

-- ============================================================
-- ÍNDICES
-- ============================================================

CREATE INDEX idx_customers_store
  ON customers (store_id);

CREATE INDEX idx_customer_identifiers_customer
  ON customer_identifiers (customer_id);

CREATE INDEX idx_customer_identifiers_store
  ON customer_identifiers (store_id);
-- UNIQUE(store_id, identifier_type, value_normalized) ya cubre el lookup
-- principal (resolución de identidad por teléfono dentro de una tienda);
-- este índice adicional soporta listar todos los identificadores de una
-- tienda sin pasar por customer_id.

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Reutiliza fn_update_updated_at() de 003_triggers.sql (ya existe).
-- customer_identifiers no lleva trigger de updated_at — sus filas son
-- casi-inmutables una vez creadas (solo active/replaced_by cambian, vía
-- código de aplicación explícito, no por un touch genérico), mismo criterio
-- que wa_messages.
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE customers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_identifiers  ENABLE ROW LEVEL SECURITY;

-- Roles con acceso de lectura a identidad de cliente — ver matriz completa
-- en docs/CUSTOMER_INTELLIGENCE_ARCHITECTURE_V1.md sección 11. Fail-closed
-- por diseño: solo estos 5 roles, nadie más ve estas tablas todavía.
-- santo_domingo_delivery_agent/delivery_agent quedan fuera a propósito
-- (verán, en una fase futura, solo una vista operativa reducida — no la
-- tabla completa con RFM/insights cuando esos campos existan).
CREATE OR REPLACE FUNCTION is_customer_intel_role()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT get_user_role() IN (
    'admin',
    'ia_supervisor',
    'confirmation_agent',
    'dispatch_agent',
    'novelty_agent'
  )
$$;

-- Solo SELECT — igual que wa_contacts hoy (030_whatsapp_base.sql): las
-- escrituras las hace exclusivamente código de aplicación con
-- createServiceClient() (bypassa RLS). No existe ningún endpoint ni UI que
-- necesite escribir estas tablas desde el navegador en esta fase.
CREATE POLICY "customers_select" ON customers
  FOR SELECT USING (
    store_id = get_user_store_id()
    AND is_customer_intel_role()
  );

CREATE POLICY "customer_identifiers_select" ON customer_identifiers
  FOR SELECT USING (
    store_id = get_user_store_id()
    AND is_customer_intel_role()
  );

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente para confirmar)
-- ============================================================
-- SELECT tablename FROM pg_tables
-- WHERE schemaname = 'public' AND tablename IN ('customers','customer_identifiers');
-- Resultado esperado: 2 filas
--
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename IN ('customers','customer_identifiers')
-- ORDER BY tablename, indexname;
-- Resultado esperado: 5 índices (incluye PK + UNIQUE de cada tabla)
--
-- SELECT proname FROM pg_proc WHERE proname = 'is_customer_intel_role';
-- Resultado esperado: 1 fila
--
-- ============================================================
-- ROLLBACK (si hace falta deshacer esta migración)
-- ============================================================
-- DROP POLICY IF EXISTS "customer_identifiers_select" ON customer_identifiers;
-- DROP POLICY IF EXISTS "customers_select" ON customers;
-- DROP TABLE IF EXISTS customer_identifiers;
-- DROP TABLE IF EXISTS customers;
-- DROP FUNCTION IF EXISTS is_customer_intel_role();
