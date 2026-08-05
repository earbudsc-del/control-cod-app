-- ============================================================
-- 056_genesis_message_runs.sql
-- Fase 1A del Cerebro Comercial de Génesis — tabla de ejecuciones lógicas
-- por mensaje inbound.
--
-- ORDEN DE APLICACIÓN: depende de 055_genesis_conversation_lock.sql
-- (referencia wa_conversations.id, ya existente desde 030, pero el diseño
-- completo de esta fase asume que 055 ya corrió).
--
-- Ver docs/GENESIS_COMMERCIAL_BRAIN_V1.md, sección "Fase 1 — Adenda:
-- revisión final de lock e idempotencia" (R1.2, R1.3, R1.11) para el diseño
-- completo, incluida la máquina de estados de 10 valores y la justificación
-- de cada campo.
--
-- PROPÓSITO
--   Una fila por intento lógico de respuesta de Génesis a un mensaje
--   inbound. UNIQUE(conversation_id, inbound_message_id) garantiza que
--   nunca puede existir más de una "ejecución lógica" por mensaje —
--   reintentos tras crash/expiración de lock reutilizan la MISMA fila
--   (attempt_count incrementado), nunca crean una segunda.
--
-- CORRIGE LA CONTRADICCIÓN DE LA REVISIÓN ANTERIOR
--   La versión previa del diseño (F1.4 original, ya marcada como superada
--   en el propio documento) proponía una sola columna
--   wa_conversations.last_ai_processed_message_id, actualizada en el mismo
--   instante de reclamar el lock — lo que permitía marcar un mensaje como
--   "procesado" antes de saber si algo se llegaría a enviar. Esta tabla la
--   reemplaza: 'claimed' (esta migración, ver CHECK de status) nunca es
--   sinónimo de 'sent' — son dos de los 10 valores posibles y solo 'sent'
--   certifica éxito irreversible.
--
-- DEPENDENCIA CIRCULAR RESUELTA — escalation_id
--   genesis_escalations (migración 057) tiene run_id → genesis_message_runs.id.
--   Esta tabla necesita, a su vez, un vínculo hacia genesis_escalations para
--   el caso "este run fue invalidado por un escalamiento" (R1.10). Como
--   genesis_escalations todavía no existe cuando esta migración corre, la
--   columna escalation_id se crea aquí SIN la FK (solo UUID), y la
--   constraint FOREIGN KEY se agrega en 057_genesis_escalations.sql una vez
--   que la tabla destino ya existe. Patrón estándar de Postgres para
--   dependencias circulares entre dos tablas nuevas de la misma fase.
--
-- store_id EN LA CLAVE ÚNICA — decisión explícita, no un descuido
--   store_id se mantiene como columna denormalizada (mismo patrón que
--   wa_messages.store_id, migración 030 — RLS directo sin JOIN) pero
--   DELIBERADAMENTE NO forma parte de la UNIQUE. conversation_id ya
--   determina store_id de forma transitiva (una conversación pertenece a
--   una sola tienda, FK a wa_conversations), así que agregarlo a la clave
--   sería redundante — no incorrecto, solo sin ningún caso real que
--   distinga (store_id, conversation_id, X) de (conversation_id, X). Se
--   documenta explícitamente porque el propio encargo de esta fase pidió
--   confirmar este punto antes de implementar.
--
-- VALIDACIÓN direction='inbound' — NO es una CHECK constraint de esta tabla
--   Postgres no puede expresar "el mensaje referenciado por inbound_message_id
--   debe tener wa_messages.direction='inbound'" como CHECK constraint sin un
--   trigger (los CHECK no pueden consultar otras tablas). La validación vive
--   en claim_genesis_run() (migración 058), que consulta wa_messages
--   explícitamente antes de crear/reclamar la fila y devuelve
--   outcome='invalid_message' si direction != 'inbound' o si el mensaje no
--   pertenece a la conversación indicada. Ver migración 058 para el detalle.
-- ============================================================

CREATE TABLE genesis_message_runs (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id            UUID        NOT NULL REFERENCES stores(id),
  conversation_id     UUID        NOT NULL REFERENCES wa_conversations(id),
  inbound_message_id  UUID        NOT NULL REFERENCES wa_messages(id),
  -- El mensaje "ancla" del run — el más reciente de un eventual grupo de
  -- debounce (mecanismo NO implementado en Fase 1A). En Fase 1A, sin
  -- debounce activo, es simplemente el mensaje que disparó el intento.

  status              TEXT        NOT NULL DEFAULT 'claimed'
                                    CHECK (status IN (
                                      'claimed', 'processing', 'generated', 'sending',
                                      'sent', 'send_unknown',
                                      'failed_retryable', 'failed_terminal',
                                      'skipped_human_active', 'escalated'
                                    )),
  -- Máquina de estados de 10 valores — ver docs/GENESIS_COMMERCIAL_BRAIN_V1.md
  -- sección R1.2. Terminales: sent, send_unknown, failed_terminal,
  -- skipped_human_active, escalated. No-terminales (reclamables como retry
  -- tras expiración de lock): claimed, processing, generated, sending,
  -- failed_retryable (mientras attempt_count no agote el máximo, decisión
  -- de aplicación, no de esquema).

  lock_token          UUID,
  lock_expires_at     TIMESTAMPTZ,
  -- Copia propia del lock — fuente de verdad para begin_genesis_send()/
  -- renew_genesis_run() (nunca el mutex de wa_conversations). Ver R1.3.1.

  attempt_count       INT         NOT NULL DEFAULT 0,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_at        TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  -- sent_at/failed_at se mantienen separados (no un completed_at genérico)
  -- para que las métricas de fase futura no requieran filtrar por status en
  -- cada consulta — decisión de diseño explícita, R1.11.

  failure_code        TEXT
                                    CHECK (failure_code IS NULL OR failure_code IN (
                                      'openai_error', 'openai_timeout', 'validation_rejected',
                                      'meta_http_error', 'meta_timeout', 'persist_error',
                                      'lock_lost', 'crashed', 'max_attempts_exceeded',
                                      'conversation_busy_timeout'
                                    )),
  failure_detail      JSONB,

  outbound_message_id UUID        REFERENCES wa_messages(id),
  meta_message_id     TEXT,
  -- El wamid de Meta. Se escribe ANTES del INSERT de wa_messages (paso b de
  -- R1.4.2) — es la prueba durable de que Meta confirmó el envío, incluso si
  -- la persistencia del outbound falla después. Ver finish_genesis_run() y
  -- renew_genesis_run() en la migración 058.

  escalation_id       UUID,
  -- FK agregada en 057_genesis_escalations.sql (dependencia circular, ver
  -- cabecera de este archivo). Nullable siempre — la mayoría de los runs
  -- nunca se escalan.

  debounced_message_ids UUID[],
  -- Mensajes agrupados por el mecanismo de debounce (NO implementado en
  -- Fase 1A). Columna creada ahora porque forma parte del esquema estable
  -- de la tabla; permanece NULL/vacía hasta que exista un escritor real.

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (conversation_id, inbound_message_id)
);

COMMENT ON TABLE genesis_message_runs IS
  'Una fila por ejecución lógica de Génesis respondiendo a un mensaje inbound. UNIQUE(conversation_id, inbound_message_id) es la garantía estructural de "una sola ejecución lógica por mensaje" — reintentos reutilizan la misma fila. Mutaciones exclusivamente vía las RPCs de la migración 058 (claim/renew/begin/finish_genesis_run) — nunca INSERT/UPDATE directo, ver RLS más abajo.';
COMMENT ON COLUMN genesis_message_runs.status IS
  'Estado fino por-run. sent es el ÚNICO estado que certifica éxito irreversible (requiere meta_message_id + outbound_message_id + status=sent simultáneamente, escritos por finish_genesis_run). Nunca usar "claimed"/"processing" como sinónimo de enviado.';

-- ============================================================
-- ÍNDICES — solo los que tienen un consumidor identificado en Fase 1A/1B
-- ============================================================

-- Soporta "¿hay un run activo para esta conversación?" en flujos de
-- diagnóstico/reconciliación. El mutex del día a día sigue siendo
-- wa_conversations.ai_lock_token (más barato, ya en la fila que el llamador
-- típicamente ya tiene cargada) — este índice es para consultas que SÍ
-- necesitan el detalle completo del run, no el gate rápido.
CREATE INDEX idx_genesis_runs_conversation_active
  ON genesis_message_runs (conversation_id)
  WHERE status IN ('claimed', 'processing', 'generated', 'sending');

-- Soporta el job de reconciliación (R1.4.3, R1.8.3) — encontrar runs que
-- necesitan atención (reintento de persistencia, o alerta manual de
-- send_unknown). No se implementa el job en Fase 1A; el índice es aditivo y
-- barato de crear ahora junto con la tabla.
CREATE INDEX idx_genesis_runs_reconciliation
  ON genesis_message_runs (status, created_at)
  WHERE status IN ('failed_retryable', 'send_unknown');

-- Un solo run ACTIVO por conversación — garantía estructural agregada en
-- Fase 1A.1 (corrección aprobada tras la auditoría previa a la aplicación
-- de esta migración). Antes de este índice, claim_genesis_run() (migración
-- 058) solo evitaba duplicar la misma fila para (conversation_id,
-- inbound_message_id) — nada a nivel de esquema impedía que dos mensajes
-- inbound DISTINTOS de la misma conversación terminaran con dos runs
-- activos simultáneos (dos INSERT válidos, cada uno con su propio
-- inbound_message_id, ambos con status IN ('claimed','processing',
-- 'generated','sending')).
--
-- Este índice hace que el segundo INSERT/UPDATE que intente dejar dos
-- filas activas para la misma conversación falle con unique_violation.
-- claim_genesis_run() lo captura explícitamente (distinguiendo esta
-- constraint de la UNIQUE(conversation_id, inbound_message_id) original
-- vía GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME) y devuelve
-- outcome='conversation_busy' en vez de propagar el error crudo de
-- Postgres. La vía PRINCIPAL sigue siendo el chequeo proactivo dentro de
-- claim_genesis_run (SELECT ... WHERE conversation_id = ... AND status IN
-- (...) antes del INSERT) — ese chequeo ya es 100% seguro bajo concurrencia
-- real porque toda la función opera con wa_conversations bloqueada FOR
-- UPDATE desde su primera sentencia (ver cabecera de 058), y todo mutador
-- del set de runs activos de una conversación (claim/begin_send/finish/
-- escalate/take) también toca esa misma fila. Este índice es, por lo
-- tanto, la garantía de ÚLTIMO RECURSO a nivel de esquema — protege incluso
-- si un futuro bug en la RPC (o una escritura directa desde otra función
-- SECURITY DEFINER) se saltara el chequeo proactivo.
CREATE UNIQUE INDEX idx_genesis_runs_one_active_per_conversation
  ON genesis_message_runs (conversation_id)
  WHERE status IN ('claimed', 'processing', 'generated', 'sending');

-- No se crea un índice standalone sobre inbound_message_id: toda consulta
-- de idempotencia ya conoce conversation_id (parámetro obligatorio de
-- claim_genesis_run), así que el índice de la propia UNIQUE(conversation_id,
-- inbound_message_id) ya cubre el camino caliente sin necesidad de un
-- índice adicional.

-- Trigger de updated_at — reutiliza fn_update_updated_at() ya existente
-- (003_triggers.sql), mismo patrón que el resto del proyecto.
CREATE TRIGGER trg_genesis_message_runs_updated_at
  BEFORE UPDATE ON genesis_message_runs
  FOR EACH ROW EXECUTE FUNCTION fn_update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE genesis_message_runs ENABLE ROW LEVEL SECURITY;

-- SELECT: roles del Inbox pueden ver el historial de runs de su propia
-- tienda (útil para diagnóstico/soporte, aunque la UI que lo consuma es de
-- una fase posterior). Reutiliza is_wa_inbox_role() (migración 030/039) —
-- no se crea un helper nuevo para un perímetro que ya existe.
CREATE POLICY "genesis_message_runs_select" ON genesis_message_runs
  FOR SELECT USING (
    store_id = get_user_store_id()
    AND is_wa_inbox_role()
  );

-- INSERT/UPDATE/DELETE: sin ninguna política — bloqueados por defecto para
-- todo rol excepto el owner de las funciones SECURITY DEFINER (migración
-- 058), que escriben con los privilegios de quien las creó, sin pasar por
-- RLS. Ningún usuario autenticado ni service_role tiene una vía directa de
-- escritura sobre esta tabla fuera de esas RPCs — exactamente lo pedido:
-- "mutations únicamente mediante RPC/backend autorizado".

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente después de aplicar, no automatizada)
-- ============================================================
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_name = 'genesis_message_runs' ORDER BY ordinal_position;
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'genesis_message_runs'::regclass;
-- Resultado esperado: incluye la UNIQUE(conversation_id, inbound_message_id)
-- y los 2 CHECK (status, failure_code).
--
-- SELECT polname, cmd FROM pg_policies WHERE tablename = 'genesis_message_runs';
-- Resultado esperado: 1 sola política, SELECT.
--
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'genesis_message_runs';
-- Resultado esperado: 4 índices — el implícito de la UNIQUE(conversation_id,
-- inbound_message_id), idx_genesis_runs_conversation_active,
-- idx_genesis_runs_reconciliation, e idx_genesis_runs_one_active_per_conversation
-- (este último con indexdef que muestre "UNIQUE" y el mismo WHERE que
-- idx_genesis_runs_conversation_active).
--
-- INSERT INTO genesis_message_runs (store_id, conversation_id, inbound_message_id)
-- VALUES ('<uuid>', '<uuid>', '<uuid>');
-- Como usuario autenticado normal (no owner de función SECURITY DEFINER):
-- Resultado esperado: error de RLS (ninguna política WITH CHECK para INSERT).

-- ============================================================
-- ROLLBACK (si hace falta deshacer esta migración)
-- ============================================================
-- DROP POLICY IF EXISTS "genesis_message_runs_select" ON genesis_message_runs;
-- DROP TRIGGER IF EXISTS trg_genesis_message_runs_updated_at ON genesis_message_runs;
-- DROP INDEX IF EXISTS idx_genesis_runs_one_active_per_conversation;
-- DROP INDEX IF EXISTS idx_genesis_runs_reconciliation;
-- DROP INDEX IF EXISTS idx_genesis_runs_conversation_active;
-- DROP TABLE IF EXISTS genesis_message_runs;
-- ADVERTENCIA — CORREGIDO EN FASE 1A.1 (el comentario original de esta
-- sección tenía el orden invertido, ver hallazgo de la auditoría previa a
-- la aplicación de 055-059): este rollback debe ejecutarse DESPUÉS de
-- revertir 057, NUNCA antes. La razón es genesis_escalations.run_id
-- (definida dentro del propio CREATE TABLE de 057, no la FK diferida que
-- 057 agrega sobre ESTA tabla) — esa columna apunta HACIA
-- genesis_message_runs.id, así que mientras genesis_escalations exista,
-- Postgres rechaza el DROP TABLE genesis_message_runs con "cannot drop
-- table ... because other objects depend on it". El rollback de 057 ya
-- incluye, en el orden correcto, primero DROP de la FK diferida
-- (genesis_message_runs_escalation_id_fkey, que SÍ vive en esta tabla) y
-- luego DROP TABLE genesis_escalations — una vez que 057 terminó su
-- rollback completo, este DROP TABLE aquí ya no tiene ninguna dependencia
-- y se ejecuta sin error.
--
-- Orden completo de rollback de esta fase, de más reciente a más antigua:
--   059 → 058 → 057 → 056 → 055
