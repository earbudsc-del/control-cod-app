-- ============================================================
-- 055_genesis_conversation_lock.sql
-- Fase 1A del Cerebro Comercial de Génesis — infraestructura de control de
-- concurrencia y escalamiento a nivel de conversación.
--
-- Ver docs/GENESIS_COMMERCIAL_BRAIN_V1.md, sección "Fase 1 — Adenda: revisión
-- final de lock e idempotencia" (R1.3, R1.11) para el diseño completo.
--
-- ALCANCE DE ESTA MIGRACIÓN — SOLO wa_conversations
--   Agrega el mutex liviano de conversación (ai_lock_token/ai_lock_expires_at)
--   y el estado grueso de control de Génesis (genesis_status) + los campos
--   de escalamiento vigente (snapshot actual, no historial — el historial
--   completo vive en genesis_escalations, migración 057).
--
-- EXPLÍCITAMENTE NO EN ESTA MIGRACIÓN (ni en ninguna de 055-059)
--   - No se toca wa_messages, ai_agent_config, ai_agent_knowledge_sections.
--   - No se modifica ningún endpoint ni src/lib/genesis/respond.ts — estas
--     columnas quedan sin ningún escritor/lector hasta una fase posterior
--     de integración, explícitamente fuera de alcance de Fase 1A.
--   - No se agregan pending_debounce_message_id/debounce_fires_at, aunque
--     el documento de arquitectura los proponía. DESVIACIÓN DELIBERADA
--     (ver sección "Diferencias encontradas" del reporte de entrega de esta
--     fase): el mecanismo de debounce es código de aplicación, explícitamente
--     excluido de Fase 1A ("No implementes debounce en código"). Crear
--     columnas sin ningún escritor previsto en esta fase viola el principio
--     ya cerrado en el propio documento ("pocos campos con semántica clara").
--     Se agregan en la migración que efectivamente implemente el debounce.
--
-- COMPATIBILIDAD CON FILAS EXISTENTES
--   genesis_status default 'active' es un estado NEUTRO — no activa ni
--   desactiva a Génesis en ninguna conversación. La activación real sigue
--   dependiendo exclusivamente de wa_conversations.ai_enabled y
--   ai_agent_config.is_active/mode (sin cambios, ambos fuera de esta
--   migración). Una conversación con ai_enabled=false hoy sigue con
--   ai_enabled=false después de esta migración — genesis_status='active'
--   solo describe "no hay ningún run en curso ni escalamiento abierto",
--   que es verdad para toda fila existente (no puede haber runs porque
--   genesis_message_runs todavía no existe).
--
-- QUINTO VALOR DE genesis_status — 'inactive' — AGREGADO EN IMPLEMENTACIÓN,
-- NO EN EL DISEÑO ORIGINAL DEL DOCUMENTO
--   El documento (R1.4/F1.4) definía 4 valores: active/processing/escalated/
--   paused_by_human. Al diseñar release_genesis_conversation() (migración
--   059) surgió un caso real que ninguno de los 4 representa: un agente
--   libera una conversación SIN reactivar a Génesis (outcome
--   'released_unassigned', pedido explícitamente en la Fase 1A —
--   distinto de 'resumed_genesis'). Ese estado ya existe hoy de forma
--   implícita en el sistema (assigned_to=NULL + ai_enabled=false, la
--   combinación "sin asignar" ya documentada en assign/route.ts:4-14) pero
--   nunca tuvo nombre en genesis_status. Se agrega 'inactive' para nombrarlo
--   explícitamente en vez de forzarlo dentro de otro valor con semántica
--   distinta. No cambia el comportamiento de ninguna fila existente (el
--   default sigue siendo 'active').
--
-- ROLLBACK
--   Ver bloque al final de este archivo.
-- ============================================================

ALTER TABLE wa_conversations
  ADD COLUMN genesis_status TEXT NOT NULL DEFAULT 'active'
    CHECK (genesis_status IN ('active', 'processing', 'escalated', 'paused_by_human', 'inactive')),
  -- active            → sin run en curso, sin escalamiento abierto, Génesis puede intentar reclamar.
  -- processing        → existe un genesis_message_runs activo para esta conversación ahora mismo.
  -- escalated         → escalamiento abierto (ver genesis_escalations); Génesis no puede reclamar.
  -- paused_by_human    → un agente tomó la conversación (assigned_to poblado); Génesis no puede reclamar.
  -- inactive          → liberada explícitamente sin reactivar a Génesis (assigned_to=NULL, ai_enabled=false).
  ADD COLUMN escalation_reason TEXT
    CHECK (escalation_reason IS NULL OR escalation_reason IN (
      'requested_by_customer', 'transfer_payment', 'adverse_reaction', 'legal_threat',
      'fraud', 'angry_customer', 'low_confidence', 'repeated_failure', 'cancellation_after_dispatch'
    )),
  ADD COLUMN escalation_priority TEXT
    CHECK (escalation_priority IS NULL OR escalation_priority IN ('critical', 'high', 'medium')),
  ADD COLUMN escalation_summary TEXT,
  ADD COLUMN escalated_at TIMESTAMPTZ,
  ADD COLUMN escalated_by TEXT
    CHECK (escalated_by IS NULL OR escalated_by IN ('genesis')),
  -- Snapshot del escalamiento ACTIVO (si lo hay) — para lectura rápida sin
  -- JOIN desde el Inbox. El historial completo (incluye resueltos) vive en
  -- genesis_escalations (migración 057). Ambos se limpian/escriben juntos,
  -- siempre desde las RPCs de la migración 059 — nunca por separado.
  ADD COLUMN ai_lock_token UUID,
  ADD COLUMN ai_lock_expires_at TIMESTAMPTZ;
  -- Mutex liviano de conversación — ver docs/GENESIS_COMMERCIAL_BRAIN_V1.md
  -- sección R1.3.1. Es un espejo del lock del run activo (genesis_message_runs.
  -- lock_token/lock_expires_at, migración 056), NO la fuente de verdad para
  -- decisiones de validación de un run (esas siempre verifican su propia
  -- copia) — sirve exclusivamente para que un mensaje entrante nuevo pueda
  -- responder "¿está ocupada esta conversación?" sin consultar
  -- genesis_message_runs.

COMMENT ON COLUMN wa_conversations.genesis_status IS
  'Estado grueso de control de Génesis para esta conversación. No confundir con el status fino por-mensaje de genesis_message_runs.status (migración 056) — ver docs/GENESIS_COMMERCIAL_BRAIN_V1.md sección R1.3.1.';
COMMENT ON COLUMN wa_conversations.ai_lock_token IS
  'Mutex liviano — copia del lock_token del run activo en genesis_message_runs, si existe. Nunca se usa como fuente de verdad para begin_genesis_send()/renew_genesis_run(), que siempre verifican el lock_token propio del run.';

-- Índice parcial — solo las conversaciones con lock activo importan para
-- cualquier consulta de "¿está ocupada?"; el resto (la inmensa mayoría en
-- cualquier momento dado) no necesita entrar en el índice.
CREATE INDEX idx_wa_conversations_genesis_lock
  ON wa_conversations (ai_lock_token)
  WHERE ai_lock_token IS NOT NULL;

-- Índice parcial — soporta la futura cola de escalamiento del Inbox
-- (fuera de alcance de Fase 1A, pero el índice es aditivo y barato de crear
-- ahora junto con las columnas que indexa).
CREATE INDEX idx_wa_conversations_genesis_escalated
  ON wa_conversations (escalation_priority, escalated_at)
  WHERE genesis_status = 'escalated';

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente después de aplicar, no automatizada)
-- ============================================================
-- SELECT column_name, data_type, column_default, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'wa_conversations' AND column_name LIKE 'genesis_%' OR column_name LIKE 'ai_lock_%' OR column_name LIKE 'escalat%'
-- ORDER BY column_name;
-- Resultado esperado: 8 columnas nuevas, genesis_status con default 'active'.
--
-- SELECT count(*) FROM wa_conversations WHERE genesis_status != 'active';
-- Resultado esperado: 0 (todas las filas existentes son 'active' por default).
--
-- SELECT count(*) FROM wa_conversations WHERE ai_enabled = false AND genesis_status = 'active';
-- Resultado esperado: puede ser > 0 — confirma que esta migración NO
-- reactivó ninguna conversación que hoy tiene ai_enabled=false; genesis_status
-- y ai_enabled son ejes independientes, tal como se documenta arriba.

-- ============================================================
-- ROLLBACK (si hace falta deshacer esta migración)
-- ============================================================
-- DROP INDEX IF EXISTS idx_wa_conversations_genesis_escalated;
-- DROP INDEX IF EXISTS idx_wa_conversations_genesis_lock;
-- ALTER TABLE wa_conversations
--   DROP COLUMN IF EXISTS ai_lock_expires_at,
--   DROP COLUMN IF EXISTS ai_lock_token,
--   DROP COLUMN IF EXISTS escalated_by,
--   DROP COLUMN IF EXISTS escalated_at,
--   DROP COLUMN IF EXISTS escalation_summary,
--   DROP COLUMN IF EXISTS escalation_priority,
--   DROP COLUMN IF EXISTS escalation_reason,
--   DROP COLUMN IF EXISTS genesis_status;
-- No afecta ninguna otra tabla — es aditivo y no tiene dependientes hasta
-- que se aplique 056 (que si ya está aplicada, debe revertirse primero).
