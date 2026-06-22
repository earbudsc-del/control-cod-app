-- ============================================================
-- 036_ai_agent_genesis.sql
-- Infraestructura configurable del agente IA (Génesis) — Fase 7A.
--
-- Solo estructura: configuración + base de conocimiento editable
-- por admin desde Configuración → Génesis IA.
--
-- NO conecta a ningún proveedor IA (OpenAI/Gemini) todavía.
-- NO se conecta al Inbox WhatsApp todavía.
-- api_key_ref guarda únicamente el NOMBRE de la env var que
-- contendrá la API key real — la key nunca se almacena en DB.
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. ai_agent_config
-- Una fila por store. Perfil, proveedor, prompt y modo del agente.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE ai_agent_config (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id       UUID        NOT NULL UNIQUE REFERENCES stores(id),
  agent_name     TEXT        NOT NULL DEFAULT 'Génesis',
  provider       TEXT        CHECK (provider IN ('openai','gemini')),
  model          TEXT,
  api_key_ref    TEXT,
  -- Nombre de la variable de entorno (ej. 'GENESIS_OPENAI_KEY').
  -- La API key real vive en env vars de Vercel, nunca en esta tabla.
  system_prompt  TEXT,
  mode           TEXT        NOT NULL DEFAULT 'off'
                               CHECK (mode IN ('off','suggest','auto','after_hours')),
  is_active      BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────
-- 2. ai_agent_knowledge_sections
-- Múltiples filas por store. Base de conocimiento + reglas
-- operativas, modeladas como bloques editables independientes
-- (mismo patrón que status_patterns).
-- ──────────────────────────────────────────────────────────────
CREATE TABLE ai_agent_knowledge_sections (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id     UUID        NOT NULL REFERENCES stores(id),
  section_key  TEXT        NOT NULL,
  label        TEXT        NOT NULL,
  content      TEXT,
  priority     INTEGER     NOT NULL DEFAULT 0,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, section_key)
);

CREATE INDEX idx_ai_knowledge_store
  ON ai_agent_knowledge_sections (store_id, priority DESC);

-- ============================================================
-- TRIGGERS — reutiliza fn_update_updated_at() de migración 003
-- ============================================================

CREATE TRIGGER trg_ai_agent_config_updated_at
  BEFORE UPDATE ON ai_agent_config
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();

CREATE TRIGGER trg_ai_knowledge_sections_updated_at
  BEFORE UPDATE ON ai_agent_knowledge_sections
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY — solo admin de la misma tienda
-- ============================================================

ALTER TABLE ai_agent_config             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_knowledge_sections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_agent_config_admin_all" ON ai_agent_config
  FOR ALL USING (
    store_id = get_user_store_id() AND get_user_role() = 'admin'
  ) WITH CHECK (
    store_id = get_user_store_id() AND get_user_role() = 'admin'
  );

CREATE POLICY "ai_knowledge_sections_admin_all" ON ai_agent_knowledge_sections
  FOR ALL USING (
    store_id = get_user_store_id() AND get_user_role() = 'admin'
  ) WITH CHECK (
    store_id = get_user_store_id() AND get_user_role() = 'admin'
  );

-- ============================================================
-- BACKFILL — crea config + secciones default para tiendas existentes
-- Idempotente: seguro de re-ejecutar.
-- ============================================================

INSERT INTO ai_agent_config (store_id)
SELECT id FROM stores
ON CONFLICT (store_id) DO NOTHING;

INSERT INTO ai_agent_knowledge_sections (store_id, section_key, label, priority)
SELECT s.id, k.section_key, k.label, k.priority
FROM stores s
CROSS JOIN (VALUES
  ('luma_teeth',         'LÜMA Teeth',                        100),
  ('renuva',             'Renuva',                             90),
  ('ofertas',            'Ofertas activas',                    80),
  ('cobertura',          'Ciudades con cobertura',              70),
  ('misspellings',       'Errores ortográficos frecuentes',     60),
  ('address_validation', 'Validación de direcciones',           55),
  ('reglas_cod',         'Reglas COD',                          50),
  ('objeciones',         'Objeciones frecuentes',                40),
  ('politica_entrega',   'Política de entrega',                  30),
  ('escalamiento',       'Cuándo escalar a humano',               20)
) AS k(section_key, label, priority)
ON CONFLICT (store_id, section_key) DO NOTHING;

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente para confirmar)
-- ============================================================
-- SELECT * FROM ai_agent_config;
-- SELECT store_id, section_key, label, priority, is_active
--   FROM ai_agent_knowledge_sections ORDER BY store_id, priority DESC;
