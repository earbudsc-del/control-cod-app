-- ============================================================
-- 057_genesis_escalations.sql
-- Fase 1A del Cerebro Comercial de Génesis — historial y cola de
-- escalamientos a humano.
--
-- ORDEN DE APLICACIÓN: depende de 056_genesis_message_runs.sql (FK run_id).
--
-- Ver docs/GENESIS_COMMERCIAL_BRAIN_V1.md, sección "Fase 1 — Adenda:
-- revisión final de lock e idempotencia" (R1.10, R1.11) para el diseño
-- completo.
--
-- DESLINDE respecto a wa_conversations (migración 055)
--   wa_conversations.escalation_* es el SNAPSHOT del escalamiento
--   actualmente abierto (si lo hay) — lectura rápida sin JOIN para el
--   Inbox. Esta tabla es el HISTORIAL completo: una conversación puede
--   escalar, resolverse, y volver a escalar más adelante — cada evento es
--   una fila propia aquí, nunca sobrescrita. No se duplica reason/priority/
--   summary con un tercer lugar dentro de genesis_message_runs (que solo
--   guarda escalation_id, un FK hacia esta tabla) — ver migración 056.
--
-- CAMBIO RESPECTO AL DISEÑO ORIGINAL DEL DOCUMENTO
--   La Adenda (R1.11) ya reemplazó `source_message_id` por `run_id` para no
--   duplicar el mensaje de origen en dos tablas (se deriva vía
--   run_id → genesis_message_runs.inbound_message_id). Esta migración
--   implementa esa versión ya revisada, no la original de F1.15.
--
-- UN SOLO ESCALAMIENTO ABIERTO POR CONVERSACIÓN
--   Preferencia V1 del encargo de esta fase. Protegido con un índice único
--   parcial (idx_genesis_escalations_one_open), mismo patrón que ya usa el
--   proyecto para "una sola conversación activa por contacto"
--   (idx_wa_convs_one_active_per_contact, 030_whatsapp_base.sql:173-175).
--   escalate_genesis_conversation() (migración 059) debe manejar
--   explícitamente el conflicto de este índice y devolver
--   outcome='already_escalated' en vez de propagar el error crudo de
--   Postgres.
-- ============================================================

CREATE TABLE genesis_escalations (
  id                       UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id                 UUID        NOT NULL REFERENCES stores(id),
  conversation_id          UUID        NOT NULL REFERENCES wa_conversations(id),
  run_id                   UUID        REFERENCES genesis_message_runs(id),
  -- Nullable: en el alcance heurístico de Fase 1A todo escalamiento nace
  -- ligado a un run (la detección ocurre durante 'processing'), pero no se
  -- fuerza NOT NULL sin necesidad — ver R1.11.

  escalation_type          TEXT        NOT NULL
                                        CHECK (escalation_type IN (
                                          'requested_by_customer', 'transfer_payment', 'adverse_reaction',
                                          'legal_threat', 'fraud', 'angry_customer', 'low_confidence',
                                          'repeated_failure', 'cancellation_after_dispatch'
                                        )),
  priority                 TEXT        NOT NULL
                                        CHECK (priority IN ('critical', 'high', 'medium')),
  status                   TEXT        NOT NULL DEFAULT 'open'
                                        CHECK (status IN ('open', 'resolved')),
  summary                  TEXT,

  escalated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  escalated_by             TEXT        NOT NULL DEFAULT 'genesis'
                                        CHECK (escalated_by IN ('genesis')),
  -- Único originador posible en Fase 1A — ver nota de compatibilidad futura
  -- al final de este archivo (mismo patrón que 054_resolve_customer_identity_rpc.sql
  -- documentó para service_role).

  assigned_to              UUID        REFERENCES profiles(id),
  -- Poblado si/cuando un agente toma la conversación mientras el
  -- escalamiento sigue abierto (take_genesis_conversation, migración 059).
  -- Distinto de wa_conversations.assigned_to en que este es un snapshot
  -- histórico de ESTE escalamiento puntual, no el estado actual de la
  -- conversación (que puede cambiar de dueño varias veces).

  resolved_at              TIMESTAMPTZ,
  resolved_by              UUID        REFERENCES profiles(id),
  resolution_note          TEXT,

  next_escalation_check_at TIMESTAMPTZ,
  sla_alert_sent_at        TIMESTAMPTZ,
  -- Infraestructura de re-escalamiento a 24h (R1.11 / check_genesis_escalation_sla,
  -- migración 059). Sin cron ni alerta UI en Fase 1A — solo la RPC idempotente
  -- que un futuro cron invocará.

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE genesis_escalations IS
  'Historial completo de escalamientos a humano — una fila por evento (una conversación puede escalar y resolverse más de una vez). El snapshot del escalamiento ABIERTO vive también, denormalizado, en wa_conversations.escalation_* (migración 055) para lectura rápida sin JOIN. Mutaciones exclusivamente vía las RPCs de la migración 059.';

-- ── Dependencia circular resuelta — FK diferida sobre genesis_message_runs ──
-- Ver cabecera de 056_genesis_message_runs.sql. Ahora que esta tabla existe,
-- se agrega la constraint que faltaba.
ALTER TABLE genesis_message_runs
  ADD CONSTRAINT genesis_message_runs_escalation_id_fkey
  FOREIGN KEY (escalation_id) REFERENCES genesis_escalations(id);

-- Un solo escalamiento ABIERTO por conversación — ver nota en la cabecera.
CREATE UNIQUE INDEX idx_genesis_escalations_one_open
  ON genesis_escalations (conversation_id)
  WHERE status = 'open';

-- Cola priorizada — soporta la futura vista de Inbox (no implementada en
-- Fase 1A, índice aditivo).
CREATE INDEX idx_genesis_escalations_open_priority
  ON genesis_escalations (priority, escalated_at)
  WHERE status = 'open';

-- Soporta check_genesis_escalation_sla() (migración 059).
CREATE INDEX idx_genesis_escalations_sla_check
  ON genesis_escalations (next_escalation_check_at)
  WHERE status = 'open' AND sla_alert_sent_at IS NULL;

CREATE TRIGGER trg_genesis_escalations_updated_at
  BEFORE UPDATE ON genesis_escalations
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE genesis_escalations ENABLE ROW LEVEL SECURITY;

-- SELECT: todos los roles del Inbox pueden ver la cola/historial de su
-- tienda — necesario para que cualquier agente vea qué hay disponible para
-- tomar, no solo admin/ia_supervisor (la restricción a esos dos roles es
-- específicamente sobre RESOLVER/DEVOLVER casos críticos, nunca sobre
-- verlos — ver migración 059).
CREATE POLICY "genesis_escalations_select" ON genesis_escalations
  FOR SELECT USING (
    store_id = get_user_store_id()
    AND is_wa_inbox_role()
  );

-- INSERT/UPDATE/DELETE: sin política — bloqueados para todo rol excepto las
-- RPCs SECURITY DEFINER de la migración 059. No se expone failure_detail
-- (esa columna vive en genesis_message_runs, no aquí) — summary/
-- resolution_note son texto operativo generado por el propio sistema o por
-- un agente humano a través de la RPC, no contienen nunca detalle crudo de
-- proveedor de IA.

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente después de aplicar, no automatizada)
-- ============================================================
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'genesis_message_runs'::regclass AND conname LIKE '%escalation%';
-- Resultado esperado: 1 fila — la FK diferida agregada arriba.
--
-- SELECT indexname FROM pg_indexes WHERE tablename = 'genesis_escalations';
-- Resultado esperado: 4 (PK + 3 creados arriba).
--
-- Probar el índice único parcial manualmente:
--   INSERT INTO genesis_escalations (store_id, conversation_id, escalation_type, priority)
--   VALUES ('<store>', '<conv>', 'requested_by_customer', 'high');
--   INSERT INTO genesis_escalations (store_id, conversation_id, escalation_type, priority)
--   VALUES ('<store>', '<misma conv>', 'fraud', 'critical');
-- Resultado esperado: el segundo INSERT falla con violación de
-- idx_genesis_escalations_one_open (23505) mientras el primero siga 'open'.

-- ============================================================
-- COMPATIBILIDAD FUTURA — escalated_by con más de un originador
-- ============================================================
-- Mismo criterio que 054_resolve_customer_identity_rpc.sql documentó para
-- su propio caso de servicio: si en una fase futura un humano puede
-- escalar manualmente una conversación (no solo Génesis por heurística),
-- NO se debilita el CHECK actual aceptando cualquier texto — se amplía el
-- CHECK explícitamente (ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT
-- con la lista ampliada, mismo patrón que profiles_role_check ya usa en
-- este proyecto, ver 013/026/029_*.sql) cuando exista ese caso de uso real,
-- no antes.

-- ============================================================
-- ROLLBACK (si hace falta deshacer esta migración)
-- ============================================================
-- DROP POLICY IF EXISTS "genesis_escalations_select" ON genesis_escalations;
-- DROP TRIGGER IF EXISTS trg_genesis_escalations_updated_at ON genesis_escalations;
-- ALTER TABLE genesis_message_runs DROP CONSTRAINT IF EXISTS genesis_message_runs_escalation_id_fkey;
-- DROP TABLE IF EXISTS genesis_escalations;
-- Los 3 índices de esta tabla se eliminan automáticamente con el DROP TABLE
-- (no requieren DROP INDEX explícito, a diferencia de los índices sobre
-- wa_conversations/genesis_message_runs en las migraciones anteriores).
