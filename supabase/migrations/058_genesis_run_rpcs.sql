-- ============================================================
-- 058_genesis_run_rpcs.sql
-- Fase 1A del Cerebro Comercial de Génesis — RPCs transaccionales de ciclo
-- de vida de un run (claim → renew → begin_send → finish).
--
-- ORDEN DE APLICACIÓN: depende de 055, 056 y 057 (lee/escribe las 3 tablas).
--
-- Ver docs/GENESIS_COMMERCIAL_BRAIN_V1.md, sección "Fase 1 — Adenda:
-- revisión final de lock e idempotencia" (R1.5, R1.9) para el diseño
-- completo de cada función.
--
-- CATEGORÍA DE SEGURIDAD: "RPCs de backend Génesis" (no de agentes humanos)
--   Las 4 funciones de este archivo son invocadas exclusivamente por el
--   backend de Génesis (createServiceClient(), mismo cliente que ya usa
--   src/lib/genesis/respond.ts hoy — sin conectarlas todavía, eso es una
--   fase posterior). GRANT EXECUTE únicamente a `service_role`, nunca a
--   `authenticated` ni `anon` — ningún usuario final debe poder invocar
--   directamente "reclamar un turno de IA" o "marcar como enviado".
--   SECURITY DEFINER + SET search_path = public, pg_temp en las 4, mismo
--   patrón que 054_resolve_customer_identity_rpc.sql ya estableció para su
--   propia función hermana de service_role (documentada ahí como
--   "Compatibilidad futura", implementada aquí por primera vez en este
--   proyecto).
--
-- REDUCCIÓN DE 5 CANDIDATAS A 4 FUNCIONES (documento, sección R1.9)
--   validate_genesis_send se fusionó dentro de begin_genesis_send (la
--   validación Y la transición a 'sending' son la misma operación atómica).
--   complete_genesis_run/fail_genesis_run se fusionaron en finish_genesis_run,
--   parametrizada por p_outcome.
--
-- CONCURRENCIA — por qué NO se usa pg_advisory_xact_lock aquí
--   054_resolve_customer_identity_rpc.sql usa un advisory lock explícito
--   para serializar por identidad. Aquí no hace falta: claim_genesis_run
--   abre con `SELECT ... FROM wa_conversations WHERE id = p_conversation_id
--   FOR UPDATE` — cualquier segunda invocación concurrente para la MISMA
--   conversación (sea el mismo mensaje o uno distinto) queda bloqueada por
--   Postgres a nivel de fila hasta que la primera transacción termine
--   (COMMIT/ROLLBACK). Esto ya serializa completamente las llamadas
--   concurrentes de claim para una conversación — más estricto que lo
--   mínimo necesario (serializa TODA la conversación, no solo el mismo
--   inbound_message_id), pero es exactamente el efecto colateral deseado:
--   es, en sí mismo, el mecanismo de exclusión mutua a nivel de conversación
--   que el documento pedía (R1.3.1), sin necesidad de infraestructura
--   adicional. El EXCEPTION WHEN unique_violation dentro de
--   claim_genesis_run es, por lo tanto, una defensa adicional para el caso
--   límite de que dos transacciones lean la misma fila inexistente antes de
--   que la primera confirme su INSERT — no la vía principal de
--   serialización.
--
-- FASE 1A.1 — UN SOLO RUN ACTIVO POR CONVERSACIÓN (corrección post-auditoría)
--   La serialización descrita arriba ya bloqueaba correctamente dos
--   invocaciones concurrentes para la MISMA conversación a nivel de
--   Postgres, pero el código original de claim_genesis_run nunca
--   aprovechaba esa serialización para preguntar "¿ya hay otro run activo
--   para esta conversación con un inbound_message_id distinto?" — solo
--   comprobaba duplicados del MISMO mensaje. Resultado: dos mensajes
--   inbound distintos de la misma conversación podían terminar con dos
--   runs activos simultáneos (dos llamadas a OpenAI en paralelo sobre el
--   mismo hilo), y el segundo claim sobreescribía silenciosamente
--   wa_conversations.ai_lock_token del primero. Fase 1A.1 agrega: (a) el
--   índice único parcial idx_genesis_runs_one_active_per_conversation
--   (migración 056) como garantía estructural de último recurso, y (b) un
--   chequeo proactivo dentro de claim_genesis_run — usando la misma
--   serialización por FOR UPDATE de wa_conversations ya descrita arriba,
--   sin necesitar locking adicional — que devuelve outcome=
--   'conversation_busy' sin crear una segunda fila ni tocar el lock
--   vigente del run activo.
--
-- VOCABULARIO DE OUTCOMES — diferencias deliberadas respecto a la lista
-- candidata del encargo de esta fase (no todas se implementan literalmente)
--   'forbidden': no es un outcome alcanzable en la práctica para estas 4
--     funciones — el GRANT EXECUTE únicamente a service_role hace que
--     cualquier invocación desde `authenticated`/`anon` falle con un error
--     de permisos de Postgres (42501) ANTES de entrar al cuerpo de la
--     función. Se documenta aquí en vez de agregar una rama de código
--     inalcanzable.
--   'conflict': la carrera de creación (EXCEPTION WHEN unique_violation en
--     claim_genesis_run) se resuelve a un outcome MÁS específico
--     ('already_sent' o 'already_processing', según lo que encuentre al
--     releer) en vez de un 'conflict' genérico — da al llamador información
--     directamente accionable, mismo criterio que 'conflict_recovered' ya
--     usa 054_resolve_customer_identity_rpc.sql en vez de un 'conflict' sin
--     detalle.
--   'conversation_busy' (Fase 1A.1): outcome específico para el caso "ya
--     hay OTRO run activo para esta conversación" — distinto de
--     'already_processing' (que es para el MISMO inbound_message_id). Ver
--     nota "FASE 1A.1" más abajo en este archivo.
-- ============================================================

-- ────────────────────────────────────────────────────────────────────────
-- 1. claim_genesis_run
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION claim_genesis_run(
  p_conversation_id    UUID,
  p_inbound_message_id UUID,
  p_lock_token         UUID,
  p_ttl_seconds        INT DEFAULT 60
)
RETURNS TABLE (
  run_id        UUID,
  outcome       TEXT,
  attempt_count INT,
  message       TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conv_store_id       UUID;
  v_conv_genesis_status TEXT;
  v_conv_assigned_to    UUID;
  v_conv_ai_enabled     BOOLEAN;
  v_msg_conv_id         UUID;
  v_msg_direction       TEXT;
  v_store_active        BOOLEAN;
  v_store_mode          TEXT;
  v_existing_run_id     UUID;
  v_existing_status     TEXT;
  v_existing_lock_exp   TIMESTAMPTZ;
  v_existing_attempt    INT;
  v_new_run_id          UUID;
  v_new_attempt         INT;
  v_other_active_run_id UUID;
  v_violated_constraint TEXT;
BEGIN
  -- ── 1/2. Conversación existe — lock de fila que serializa toda la
  --         concurrencia de esta conversación (ver nota de cabecera) ──────
  SELECT store_id, genesis_status, assigned_to, ai_enabled
    INTO v_conv_store_id, v_conv_genesis_status, v_conv_assigned_to, v_conv_ai_enabled
  FROM wa_conversations
  WHERE id = p_conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::UUID, 'not_found'::TEXT, 0, 'Conversación no encontrada.'::TEXT;
    RETURN;
  END IF;

  -- ── 3/4. El mensaje existe, pertenece a esta conversación, es inbound ──
  -- Nunca confiar en que el caller pase un inbound_message_id válido — se
  -- revalida siempre aquí, aunque el backend ya lo sepa por construcción.
  SELECT conversation_id, direction INTO v_msg_conv_id, v_msg_direction
  FROM wa_messages
  WHERE id = p_inbound_message_id;

  IF NOT FOUND OR v_msg_conv_id IS DISTINCT FROM p_conversation_id OR v_msg_direction != 'inbound' THEN
    RETURN QUERY SELECT NULL::UUID, 'invalid_message'::TEXT, 0,
      'inbound_message_id no existe, no pertenece a esta conversación, o direction != inbound.'::TEXT;
    RETURN;
  END IF;

  -- ── 5. ¿Puede Génesis operar aquí? ──────────────────────────────────────
  IF v_conv_assigned_to IS NOT NULL OR v_conv_genesis_status = 'paused_by_human' THEN
    RETURN QUERY SELECT NULL::UUID, 'skipped_human_active'::TEXT, 0,
      'La conversación tiene un agente humano asignado.'::TEXT;
    RETURN;
  END IF;

  IF v_conv_genesis_status = 'escalated' THEN
    RETURN QUERY SELECT NULL::UUID, 'skipped_escalated'::TEXT, 0,
      'La conversación tiene un escalamiento abierto.'::TEXT;
    RETURN;
  END IF;

  IF NOT v_conv_ai_enabled THEN
    RETURN QUERY SELECT NULL::UUID, 'disabled'::TEXT, 0, 'ai_enabled=false para esta conversación.'::TEXT;
    RETURN;
  END IF;

  SELECT is_active, mode INTO v_store_active, v_store_mode
  FROM ai_agent_config WHERE store_id = v_conv_store_id;

  IF v_store_active IS NOT TRUE OR v_store_mode IS DISTINCT FROM 'auto' THEN
    RETURN QUERY SELECT NULL::UUID, 'disabled'::TEXT, 0,
      'ai_agent_config.is_active=false o mode != auto para esta tienda.'::TEXT;
    RETURN;
  END IF;

  -- ── 6/7. ¿Ya existe una fila para (conversation_id, inbound_message_id)? ─
  -- attempt_count se califica con el nombre de tabla porque también es un
  -- parámetro OUT de esta función (RETURNS TABLE incluye attempt_count) —
  -- Postgres promueve cada columna de RETURNS TABLE a variable PL/pgSQL en
  -- todo el cuerpo, así que una referencia sin calificar es ambigua entre
  -- la columna real y esa variable (error 42702, detectado en runtime real
  -- durante la validación de Fase 1A, no visible en una revisión estática
  -- del SQL). Mismo motivo en las demás referencias de attempt_count más
  -- abajo en esta función.
  SELECT id, status, lock_expires_at, genesis_message_runs.attempt_count
    INTO v_existing_run_id, v_existing_status, v_existing_lock_exp, v_existing_attempt
  FROM genesis_message_runs
  WHERE conversation_id = p_conversation_id AND inbound_message_id = p_inbound_message_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_status = 'sent' THEN
      RETURN QUERY SELECT v_existing_run_id, 'already_sent'::TEXT, v_existing_attempt,
        'Este mensaje ya fue respondido con éxito — nunca se reprocesa.'::TEXT;
      RETURN;
    END IF;

    IF v_existing_status IN ('claimed', 'processing', 'generated', 'sending')
       AND v_existing_lock_exp IS NOT NULL AND v_existing_lock_exp > now() THEN
      RETURN QUERY SELECT v_existing_run_id, 'already_processing'::TEXT, v_existing_attempt,
        'Ya existe una ejecución activa y vigente para este mensaje.'::TEXT;
      RETURN;
    END IF;

    IF v_existing_status IN ('escalated', 'skipped_human_active', 'failed_terminal', 'send_unknown') THEN
      RETURN QUERY SELECT v_existing_run_id, v_existing_status, v_existing_attempt,
        'Este run terminó en un estado terminal que no admite reintento automático.'::TEXT;
      RETURN;
    END IF;

    -- Lock vencido (o nunca se llegó a fijar) sobre un estado no-terminal
    -- reintentable: 'claimed'/'processing'/'generated'/'sending' con lock
    -- vencido, o 'failed_retryable' — reclamar la MISMA fila como reintento.
    -- ── 9/10. Incrementar attempt_count, asignar nuevo token/expiración ────
    UPDATE genesis_message_runs
    SET lock_token = p_lock_token,
        lock_expires_at = now() + (p_ttl_seconds || ' seconds')::interval,
        status = 'claimed',
        attempt_count = genesis_message_runs.attempt_count + 1,
        started_at = now()
    WHERE id = v_existing_run_id
    RETURNING id, genesis_message_runs.attempt_count INTO v_new_run_id, v_new_attempt;

    -- ── 11. Mutex liviano de wa_conversations ───────────────────────────
    UPDATE wa_conversations
    SET ai_lock_token = p_lock_token,
        ai_lock_expires_at = now() + (p_ttl_seconds || ' seconds')::interval,
        genesis_status = 'processing'
    WHERE id = p_conversation_id;

    RETURN QUERY SELECT v_new_run_id, 'retry_claimed'::TEXT, v_new_attempt, NULL::TEXT;
    RETURN;
  END IF;

  -- ── 8/9/10. Primera vez para este mensaje ───────────────────────────────
  -- Chequeo proactivo — UN SOLO RUN ACTIVO POR CONVERSACIÓN (Fase 1A.1) ───
  -- Esta es la vía PRINCIPAL de la garantía, no el índice único parcial
  -- (idx_genesis_runs_one_active_per_conversation, migración 056) — ese
  -- índice es el respaldo estructural de último recurso. Este SELECT es
  -- 100% seguro bajo concurrencia real sin necesitar su propio FOR UPDATE:
  -- esta función ya sostiene el lock FOR UPDATE de wa_conversations desde
  -- su primera sentencia (paso 1/2) durante TODA la transacción, y todo
  -- mutador del set de runs activos de una conversación (esta misma
  -- función, begin_genesis_send, finish_genesis_run, escalate_genesis_
  -- conversation, take_genesis_conversation) también toca esa misma fila
  -- de wa_conversations antes de terminar — así que ninguna otra
  -- transacción puede insertar/modificar un run activo de ESTA conversación
  -- entre este SELECT y el INSERT de abajo sin bloquearse primero en esa
  -- fila, que ya es nuestra.
  SELECT id INTO v_other_active_run_id
  FROM genesis_message_runs
  WHERE conversation_id = p_conversation_id
    AND status IN ('claimed', 'processing', 'generated', 'sending')
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT v_other_active_run_id, 'conversation_busy'::TEXT, 0,
      'Ya existe un run activo para esta conversación con otro inbound_message_id — solo un run activo por conversación a la vez.'::TEXT;
    RETURN;
  END IF;

  -- ── Crear la fila ────────────────────────────────────────────────────
  BEGIN
    INSERT INTO genesis_message_runs (
      store_id, conversation_id, inbound_message_id, status,
      lock_token, lock_expires_at, attempt_count, started_at
    ) VALUES (
      v_conv_store_id, p_conversation_id, p_inbound_message_id, 'claimed',
      p_lock_token, now() + (p_ttl_seconds || ' seconds')::interval, 1, now()
    )
    RETURNING id, genesis_message_runs.attempt_count INTO v_new_run_id, v_new_attempt;

    -- ── 11. Mutex liviano de wa_conversations ───────────────────────────
    UPDATE wa_conversations
    SET ai_lock_token = p_lock_token,
        ai_lock_expires_at = now() + (p_ttl_seconds || ' seconds')::interval,
        genesis_status = 'processing'
    WHERE id = p_conversation_id;

    -- ── 12. Outcome tipado ───────────────────────────────────────────────
    RETURN QUERY SELECT v_new_run_id, 'claimed'::TEXT, v_new_attempt, NULL::TEXT;
    RETURN;

  EXCEPTION
    WHEN unique_violation THEN
      -- Ver nota arriba sobre por qué esto es defensa adicional, no la vía
      -- principal (el chequeo proactivo de arriba ya cubre el 100% de los
      -- casos alcanzables por estas RPCs bajo el locking descrito — este
      -- handler protege contra un futuro bug de la RPC o una escritura
      -- SECURITY DEFINER que se saltara ese chequeo).
      --
      -- Dos constraints distintas pueden disparar unique_violation aquí:
      --   1. UNIQUE(conversation_id, inbound_message_id) — el MISMO mensaje
      --      se está reclamando dos veces en paralelo.
      --   2. idx_genesis_runs_one_active_per_conversation — OTRO run ya
      --      activo para esta conversación ganó la carrera. Se distinguen
      --      por nombre de constraint, nunca se asume cuál fue.
      GET STACKED DIAGNOSTICS v_violated_constraint = CONSTRAINT_NAME;

      IF v_violated_constraint = 'idx_genesis_runs_one_active_per_conversation' THEN
        SELECT id INTO v_other_active_run_id
        FROM genesis_message_runs
        WHERE conversation_id = p_conversation_id
          AND status IN ('claimed', 'processing', 'generated', 'sending')
        LIMIT 1;
        RETURN QUERY SELECT v_other_active_run_id, 'conversation_busy'::TEXT, 0,
          'conflict recuperado — otro run ganó la carrera de "un solo run activo por conversación".'::TEXT;
        RETURN;
      END IF;

      -- Constraint distinta (o nombre no reconocido, ej. si el índice fue
      -- renombrado) → asumir el caso original: UNIQUE(conversation_id,
      -- inbound_message_id).
      SELECT id, status, genesis_message_runs.attempt_count INTO v_existing_run_id, v_existing_status, v_existing_attempt
      FROM genesis_message_runs
      WHERE conversation_id = p_conversation_id AND inbound_message_id = p_inbound_message_id;

      IF v_existing_status = 'sent' THEN
        RETURN QUERY SELECT v_existing_run_id, 'already_sent'::TEXT, v_existing_attempt, NULL::TEXT;
      ELSE
        RETURN QUERY SELECT v_existing_run_id, 'already_processing'::TEXT, v_existing_attempt,
          'conflict recuperado — otra ejecución ganó la carrera de creación.'::TEXT;
      END IF;
      RETURN;

    WHEN OTHERS THEN
      RETURN QUERY SELECT NULL::UUID, 'db_error'::TEXT, 0, SQLERRM::TEXT;
      RETURN;
  END;
END;
$$;

COMMENT ON FUNCTION claim_genesis_run(UUID, UUID, UUID, INT) IS
  'Único punto de entrada para que Génesis reclame el derecho de responder a un mensaje inbound. Nunca marca "processed"/"sent" — solo "claimed" o "retry_claimed". Idempotente por diseño: UNIQUE(conversation_id, inbound_message_id) en genesis_message_runs garantiza una sola ejecución lógica por mensaje. Además (Fase 1A.1), garantiza que nunca haya más de un run activo por conversación a la vez — un mensaje nuevo mientras otro run sigue activo recibe outcome=conversation_busy, sin crear una segunda fila ni tocar el lock del run vigente. Ver idx_genesis_runs_one_active_per_conversation (migración 056).';

-- ────────────────────────────────────────────────────────────────────────
-- 2. renew_genesis_run
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION renew_genesis_run(
  p_run_id          UUID,
  p_lock_token      UUID,
  p_extend_seconds  INT DEFAULT 30,
  p_new_status      TEXT DEFAULT NULL,
  p_meta_message_id TEXT DEFAULT NULL
)
RETURNS TABLE (outcome TEXT, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conversation_id UUID;
  v_current_status  TEXT;
  v_current_token   UUID;
  v_started_at      TIMESTAMPTZ;
BEGIN
  IF p_new_status IS NOT NULL AND p_new_status NOT IN ('processing', 'generated') THEN
    RETURN QUERY SELECT 'invalid_status_transition'::TEXT,
      format('renew_genesis_run no admite transicionar a %s — solo processing/generated.', p_new_status)::TEXT;
    RETURN;
  END IF;

  SELECT conversation_id, status, lock_token, started_at
    INTO v_conversation_id, v_current_status, v_current_token, v_started_at
  FROM genesis_message_runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, 'Run no encontrado.'::TEXT;
    RETURN;
  END IF;

  IF v_current_status NOT IN ('claimed', 'processing', 'generated', 'sending') THEN
    RETURN QUERY SELECT 'invalid_status_transition'::TEXT,
      format('El run ya está en un estado terminal (%s) — no se renueva un run terminal.', v_current_status)::TEXT;
    RETURN;
  END IF;

  IF v_current_token IS DISTINCT FROM p_lock_token THEN
    RETURN QUERY SELECT 'lost_lock'::TEXT, 'lock_token no coincide con el que tiene la fila.'::TEXT;
    RETURN;
  END IF;

  -- Límite total por ejecución (R1.5.3) — 90s desde started_at, independiente
  -- de cuántas renovaciones se hayan concedido antes.
  IF now() - v_started_at > INTERVAL '90 seconds' THEN
    RETURN QUERY SELECT 'lost_lock'::TEXT, 'Límite total de 90s por ejecución excedido — no se renueva.'::TEXT;
    RETURN;
  END IF;

  UPDATE genesis_message_runs
  SET lock_expires_at = now() + (p_extend_seconds || ' seconds')::interval,
      status = COALESCE(p_new_status, status),
      generated_at = CASE WHEN p_new_status = 'generated' THEN now() ELSE generated_at END,
      meta_message_id = COALESCE(p_meta_message_id, meta_message_id)
  WHERE id = p_run_id;

  UPDATE wa_conversations
  SET ai_lock_expires_at = now() + (p_extend_seconds || ' seconds')::interval
  WHERE id = v_conversation_id AND ai_lock_token = p_lock_token;

  RETURN QUERY SELECT 'renewed'::TEXT, NULL::TEXT;
END;
$$;

COMMENT ON FUNCTION renew_genesis_run(UUID, UUID, INT, TEXT, TEXT) IS
  'Extiende el TTL del lock en checkpoints (antes de OpenAI, tras OpenAI) y opcionalmente transiciona status/graba meta_message_id de forma temprana (R1.4.2 paso b) — nunca revive un run terminal.';

-- ────────────────────────────────────────────────────────────────────────
-- 3. begin_genesis_send — el "segundo chequeo" atómico antes de Meta
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION begin_genesis_send(
  p_run_id     UUID,
  p_lock_token UUID
)
RETURNS TABLE (allowed BOOLEAN, outcome TEXT, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conversation_id     UUID;
  v_run_status          TEXT;
  v_run_lock_token      UUID;
  v_run_lock_expires    TIMESTAMPTZ;
  v_outbound_already    UUID;
  v_conv_genesis_status TEXT;
  v_conv_assigned_to    UUID;
  v_conv_ai_enabled     BOOLEAN;
  v_conv_lock_token     UUID;
BEGIN
  SELECT conversation_id, status, lock_token, lock_expires_at, outbound_message_id
    INTO v_conversation_id, v_run_status, v_run_lock_token, v_run_lock_expires, v_outbound_already
  FROM genesis_message_runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::TEXT, 'Run no encontrado.'::TEXT;
    RETURN;
  END IF;

  IF v_outbound_already IS NOT NULL OR v_run_status = 'sent' THEN
    RETURN QUERY SELECT false, 'already_sent'::TEXT, 'Este run ya tiene un outbound vinculado.'::TEXT;
    RETURN;
  END IF;

  IF v_run_status != 'generated' THEN
    RETURN QUERY SELECT false, 'not_generated'::TEXT,
      format('El run está en status=%s — se requiere generated.', v_run_status)::TEXT;
    RETURN;
  END IF;

  IF v_run_lock_token IS DISTINCT FROM p_lock_token
     OR v_run_lock_expires IS NULL OR v_run_lock_expires <= now() THEN
    RETURN QUERY SELECT false, 'lost_lock'::TEXT, 'lock_token no coincide o ya venció.'::TEXT;
    RETURN;
  END IF;

  SELECT genesis_status, assigned_to, ai_enabled, ai_lock_token
    INTO v_conv_genesis_status, v_conv_assigned_to, v_conv_ai_enabled, v_conv_lock_token
  FROM wa_conversations
  WHERE id = v_conversation_id
  FOR UPDATE;

  IF v_conv_genesis_status != 'processing'
     OR v_conv_assigned_to IS NOT NULL
     OR NOT v_conv_ai_enabled
     OR v_conv_lock_token IS DISTINCT FROM p_lock_token THEN
    RETURN QUERY SELECT false, 'conversation_not_active'::TEXT,
      'La conversación ya no está disponible para que Génesis envíe (tomada, escalada, liberada o deshabilitada).'::TEXT;
    RETURN;
  END IF;

  -- Transición atómica 'generated' → 'sending' — es la regla dura "solo el
  -- poseedor del token vigente puede enviar": una segunda invocación con el
  -- mismo lock_token encuentra status='sending' (no 'generated') y falla en
  -- el chequeo de status de arriba, sin ventana para una doble transición.
  UPDATE genesis_message_runs SET status = 'sending' WHERE id = p_run_id;

  RETURN QUERY SELECT true, 'allowed'::TEXT, NULL::TEXT;
END;
$$;

COMMENT ON FUNCTION begin_genesis_send(UUID, UUID) IS
  'El segundo chequeo atómico inmediatamente antes de invocar sendWhatsAppText(). Verifica token, TTL, status del run, y que la conversación siga activa para Génesis — todo en una sola transacción, sin ventana entre "verificar" y "actuar" a nivel de base de datos.';

-- ────────────────────────────────────────────────────────────────────────
-- 4. finish_genesis_run
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION finish_genesis_run(
  p_run_id              UUID,
  p_lock_token          UUID,
  p_outcome             TEXT,
  p_meta_message_id     TEXT DEFAULT NULL,
  p_outbound_message_id UUID DEFAULT NULL,
  p_failure_code        TEXT DEFAULT NULL,
  p_failure_detail      JSONB DEFAULT NULL
)
RETURNS TABLE (outcome TEXT, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conversation_id    UUID;
  v_run_status         TEXT;
  v_run_lock_token     UUID;
  v_outbound_conv_id   UUID;
  v_outbound_direction TEXT;
BEGIN
  IF p_outcome NOT IN ('sent', 'send_unknown', 'failed_retryable', 'failed_terminal') THEN
    RETURN QUERY SELECT 'invalid_outcome'::TEXT, format('p_outcome inválido: %s', p_outcome)::TEXT;
    RETURN;
  END IF;

  SELECT conversation_id, status, lock_token
    INTO v_conversation_id, v_run_status, v_run_lock_token
  FROM genesis_message_runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, 'Run no encontrado.'::TEXT;
    RETURN;
  END IF;

  -- Regla dura: nunca transformar un run 'sent' en otro estado.
  IF v_run_status = 'sent' THEN
    IF p_outcome = 'sent' THEN
      RETURN QUERY SELECT 'already_finished'::TEXT, 'El run ya estaba sent — no-op idempotente.'::TEXT;
    ELSE
      RETURN QUERY SELECT 'invalid_transition'::TEXT, 'No se puede transicionar un run sent a otro estado.'::TEXT;
    END IF;
    RETURN;
  END IF;

  -- Camino normal: el lock_token debe coincidir. Camino de reconciliación
  -- tardía (R1.7, casos D/E/F — proceso muerto, persistencia fallida): se
  -- permite finalizar SIN el lock_token original si el run sigue en un
  -- estado no-terminal reintentable y su lock ya venció — es la única vía
  -- por la que un futuro job de reconciliación (fuera de alcance de Fase 1A,
  -- pero ya soportado por esta función) puede cerrar un run huérfano sin
  -- tener el token que se perdió junto con el proceso original.
  IF v_run_lock_token IS DISTINCT FROM p_lock_token THEN
    IF NOT EXISTS (
      SELECT 1 FROM genesis_message_runs
      WHERE id = p_run_id
        AND status IN ('claimed', 'processing', 'generated', 'sending', 'failed_retryable')
        AND (lock_expires_at IS NULL OR lock_expires_at <= now())
    ) THEN
      RETURN QUERY SELECT 'lost_lock'::TEXT, 'lock_token no coincide y el run no califica para reconciliación tardía.'::TEXT;
      RETURN;
    END IF;
  END IF;

  IF p_outbound_message_id IS NOT NULL THEN
    SELECT conversation_id, direction INTO v_outbound_conv_id, v_outbound_direction
    FROM wa_messages WHERE id = p_outbound_message_id;

    IF NOT FOUND OR v_outbound_conv_id IS DISTINCT FROM v_conversation_id OR v_outbound_direction != 'outbound' THEN
      RETURN QUERY SELECT 'invalid_outbound'::TEXT,
        'outbound_message_id no existe, no pertenece a esta conversación, o direction != outbound.'::TEXT;
      RETURN;
    END IF;
  END IF;

  UPDATE genesis_message_runs
  SET status = p_outcome,
      meta_message_id = COALESCE(p_meta_message_id, meta_message_id),
      outbound_message_id = COALESCE(p_outbound_message_id, outbound_message_id),
      failure_code = p_failure_code,
      failure_detail = p_failure_detail,
      sent_at = CASE WHEN p_outcome = 'sent' THEN now() ELSE sent_at END,
      failed_at = CASE WHEN p_outcome IN ('failed_retryable', 'failed_terminal', 'send_unknown') THEN now() ELSE failed_at END,
      lock_token = NULL,
      lock_expires_at = NULL
  WHERE id = p_run_id;

  -- El turno terminó — libera el mutex de wa_conversations (solo si sigue
  -- siendo el mismo lock que este run tenía; si ya lo tiene un reintento
  -- posterior, esta condición excluye la fila y no se pisa el estado más
  -- reciente) y vuelve a 'active' únicamente si seguía en 'processing'.
  UPDATE wa_conversations
  SET ai_lock_token = NULL,
      ai_lock_expires_at = NULL,
      genesis_status = CASE WHEN genesis_status = 'processing' THEN 'active' ELSE genesis_status END
  WHERE id = v_conversation_id
    AND (ai_lock_token = p_lock_token OR ai_lock_token IS NULL);

  RETURN QUERY SELECT p_outcome::TEXT, NULL::TEXT;
END;
$$;

COMMENT ON FUNCTION finish_genesis_run(UUID, UUID, TEXT, TEXT, UUID, TEXT, JSONB) IS
  'Escritura terminal del run — único punto que marca sent/send_unknown/failed_retryable/failed_terminal. Nunca reenvía nada: es la escritura de resultado de un envío que ya ocurrió (o falló) fuera de esta función. Idempotente ante una segunda invocación con outcome=sent.';

-- ============================================================
-- GRANTS — exclusivamente service_role
-- ============================================================
REVOKE ALL ON FUNCTION claim_genesis_run(UUID, UUID, UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION renew_genesis_run(UUID, UUID, INT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_genesis_send(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION finish_genesis_run(UUID, UUID, TEXT, TEXT, UUID, TEXT, JSONB) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION claim_genesis_run(UUID, UUID, UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION renew_genesis_run(UUID, UUID, INT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION begin_genesis_send(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION finish_genesis_run(UUID, UUID, TEXT, TEXT, UUID, TEXT, JSONB) TO service_role;
-- Nunca a authenticated ni anon — ver "CATEGORÍA DE SEGURIDAD" en la
-- cabecera de este archivo.

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente después de aplicar, no automatizada)
-- ============================================================
-- SELECT proname, prosecdef FROM pg_proc
-- WHERE proname IN ('claim_genesis_run','renew_genesis_run','begin_genesis_send','finish_genesis_run');
-- Resultado esperado: 4 filas, prosecdef = true en todas.
--
-- SELECT routine_name, grantee, privilege_type FROM information_schema.routine_privileges
-- WHERE routine_name IN ('claim_genesis_run','renew_genesis_run','begin_genesis_send','finish_genesis_run');
-- Resultado esperado: EXECUTE solo para 'service_role' (y el owner) en las 4.
--
-- Con el cliente de service role (nunca con una sesión de usuario, que ni
-- siquiera debería poder ver estas funciones vía RLS de information_schema):
--   SELECT * FROM claim_genesis_run('<conv real>', '<mensaje inbound real>', gen_random_uuid());
--   -- primera vez: outcome='claimed', attempt_count=1
--   SELECT * FROM claim_genesis_run('<misma conv>', '<mismo mensaje>', gen_random_uuid());
--   -- segunda vez, mismo mensaje, lock aún vigente: outcome='already_processing'
--   SELECT * FROM claim_genesis_run('<misma conv>', '<mensaje inbound DISTINTO>', gen_random_uuid());
--   -- mismo conversation_id, mensaje distinto, el primer run sigue activo:
--   -- outcome='conversation_busy', run_id = el run del PRIMER mensaje (no crea fila nueva)
--
-- SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_genesis_runs_one_active_per_conversation';
-- Resultado esperado: incluye "UNIQUE" y el mismo WHERE que
-- idx_genesis_runs_conversation_active (migración 056).

-- ============================================================
-- ROLLBACK (si hace falta deshacer esta migración)
-- ============================================================
-- REVOKE EXECUTE ON FUNCTION finish_genesis_run(UUID, UUID, TEXT, TEXT, UUID, TEXT, JSONB) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION begin_genesis_send(UUID, UUID) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION renew_genesis_run(UUID, UUID, INT, TEXT, TEXT) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION claim_genesis_run(UUID, UUID, UUID, INT) FROM service_role;
-- DROP FUNCTION IF EXISTS finish_genesis_run(UUID, UUID, TEXT, TEXT, UUID, TEXT, JSONB);
-- DROP FUNCTION IF EXISTS begin_genesis_send(UUID, UUID);
-- DROP FUNCTION IF EXISTS renew_genesis_run(UUID, UUID, INT, TEXT, TEXT);
-- DROP FUNCTION IF EXISTS claim_genesis_run(UUID, UUID, UUID, INT);
-- No afecta ninguna tabla — es aditivo, solo funciones.
