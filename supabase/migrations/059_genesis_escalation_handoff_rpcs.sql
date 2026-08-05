-- ============================================================
-- 059_genesis_escalation_handoff_rpcs.sql
-- Fase 1A del Cerebro Comercial de Génesis — RPCs transaccionales de
-- escalamiento y handoff humano.
--
-- ORDEN DE APLICACIÓN: depende de 055, 056, 057 y 058 (invalida runs
-- activos usando el mismo vocabulario de estados que las RPCs de 058).
--
-- Ver docs/GENESIS_COMMERCIAL_BRAIN_V1.md, sección "Fase 1 — Adenda:
-- revisión final de lock e idempotencia" (R1.10) para el diseño completo.
--
-- DOS CATEGORÍAS DE SEGURIDAD EN ESTE ARCHIVO
--   - escalate_genesis_conversation / check_genesis_escalation_sla:
--     "backend Génesis" — GRANT solo a service_role, mismo criterio que
--     las 4 funciones de 058. Ninguna decide por sí misma cuándo escalar
--     o revisar SLA con criterio de negocio humano; son ejecutadas por el
--     backend (heurística) o por un futuro cron.
--   - take_genesis_conversation / release_genesis_conversation:
--     "agentes humanos" — SECURITY DEFINER + GRANT a `authenticated`,
--     identidad derivada exclusivamente de auth.uid() (nunca de un
--     parámetro del cliente), rol revalidado dentro de la función — mismo
--     patrón que 052_reopen_confirmed_order_rpc.sql y
--     054_resolve_customer_identity_rpc.sql ya establecieron en este
--     proyecto. Reutilizan is_wa_inbox_role()/get_user_role()/
--     get_user_store_id() (002_rls.sql, 030/039_*.sql) en vez de
--     reimplementar la misma lista de roles.
--
-- REDUCCIÓN A 4 FUNCIONES (documento, sección 9 del encargo de esta fase)
--   "Resolver escalamiento" se fusiona dentro de release_genesis_conversation
--   (liberar una conversación con un escalamiento abierto lo resuelve como
--   parte de la misma transacción) — no existe una función separada
--   "resolve_genesis_escalation" en Fase 1A porque no tiene ningún
--   consumidor propio distinto de release (instrucción explícita: "No
--   agregues funciones que todavía no tengan un consumidor claro").
-- ============================================================

-- ────────────────────────────────────────────────────────────────────────
-- 1. escalate_genesis_conversation
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION escalate_genesis_conversation(
  p_conversation_id UUID,
  p_run_id          UUID DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL,
  p_summary         TEXT DEFAULT NULL
)
RETURNS TABLE (escalation_id UUID, outcome TEXT, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_store_id           UUID;
  v_priority           TEXT;
  v_new_escalation_id  UUID;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN (
    'requested_by_customer', 'transfer_payment', 'adverse_reaction', 'legal_threat',
    'fraud', 'angry_customer', 'low_confidence', 'repeated_failure', 'cancellation_after_dispatch'
  ) THEN
    RETURN QUERY SELECT NULL::UUID, 'invalid_reason'::TEXT,
      format('p_reason inválido o vacío: %s', COALESCE(p_reason, 'NULL'))::TEXT;
    RETURN;
  END IF;

  SELECT store_id INTO v_store_id FROM wa_conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::UUID, 'not_found'::TEXT, 'Conversación no encontrada.'::TEXT;
    RETURN;
  END IF;

  -- Validación run_id ↔ conversation_id/store_id (Fase 1A.1, corrección
  -- post-auditoría) — p_run_id nunca se insertaba validado: un run_id de
  -- otra conversación (o de otra tienda) se aceptaba silenciosamente,
  -- corrompiendo la trazabilidad de genesis_escalations.run_id sin ningún
  -- error. NULL sigue siendo legítimo sin validar nada (ver 056/057: todo
  -- escalamiento heurístico nace ligado a un run en el alcance de Fase 1A,
  -- pero la columna es nullable a propósito — no se fuerza aquí). Si se
  -- provee un run_id inválido: no se inserta la escalación, no se toca
  -- wa_conversations, no se invalida ningún run — se sale antes de
  -- cualquier escritura.
  IF p_run_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM genesis_message_runs
      WHERE id = p_run_id
        AND conversation_id = p_conversation_id
        AND store_id = v_store_id
    ) THEN
      RETURN QUERY SELECT NULL::UUID, 'invalid_run'::TEXT,
        format('p_run_id %s no existe, no pertenece a la conversación indicada, o no pertenece a la misma tienda.', p_run_id)::TEXT;
      RETURN;
    END IF;
  END IF;

  -- Prioridad derivada determinísticamente (R1.8.4 / F1.8.4) — editable
  -- manualmente después por admin/ia_supervisor (fuera de alcance de Fase
  -- 1A: la UI de edición es una fase posterior; el valor inicial ya queda
  -- correcto desde este INSERT).
  v_priority := CASE p_reason
    WHEN 'adverse_reaction'            THEN 'critical'
    WHEN 'legal_threat'                THEN 'critical'
    WHEN 'fraud'                       THEN 'critical'
    WHEN 'cancellation_after_dispatch' THEN 'critical'
    WHEN 'requested_by_customer'       THEN 'high'
    WHEN 'transfer_payment'            THEN 'high'
    WHEN 'angry_customer'              THEN 'high'
    WHEN 'low_confidence'              THEN 'medium'
    WHEN 'repeated_failure'            THEN 'medium'
  END;

  BEGIN
    INSERT INTO genesis_escalations (
      store_id, conversation_id, run_id, escalation_type, priority, summary,
      next_escalation_check_at
    ) VALUES (
      v_store_id, p_conversation_id, p_run_id, p_reason, v_priority, p_summary,
      now() + INTERVAL '24 hours'
      -- Umbral V1 fijo a 24h dentro de esta función. La configurabilidad
      -- pedida por el negocio ("24 horas, configurable") es de alcance de
      -- una fase posterior que exponga el valor como parámetro/config de
      -- tienda — no se inventa aquí un mecanismo de configuración sin
      -- ningún consumidor todavía.
    )
    RETURNING id INTO v_new_escalation_id;

  EXCEPTION WHEN unique_violation THEN
    -- idx_genesis_escalations_one_open (057) — ya hay un escalamiento
    -- abierto para esta conversación. No se crea un segundo; se informa.
    RETURN QUERY SELECT NULL::UUID, 'already_escalated'::TEXT,
      'Ya existe un escalamiento abierto para esta conversación.'::TEXT;
    RETURN;
  END;

  -- Invalidar cualquier run activo — revoca su capacidad de enviar y
  -- conserva su trazabilidad (nunca se borra, solo cambia de estado).
  UPDATE genesis_message_runs
  SET status = 'escalated',
      escalation_id = v_new_escalation_id,
      failed_at = now(),
      lock_token = NULL,
      lock_expires_at = NULL
  WHERE conversation_id = p_conversation_id
    AND status IN ('claimed', 'processing', 'generated', 'sending');

  -- Revocar el mutex, cambiar el estado grueso, dejar la conversación sin
  -- asignar (nunca una asignación forzada — coherente con que la cola de
  -- escalamiento es de conversaciones DISPONIBLES para tomar, no
  -- asignaciones automáticas).
  UPDATE wa_conversations
  SET genesis_status       = 'escalated',
      escalation_reason    = p_reason,
      escalation_priority  = v_priority,
      escalation_summary   = p_summary,
      escalated_at         = now(),
      escalated_by         = 'genesis',
      ai_lock_token        = NULL,
      ai_lock_expires_at   = NULL
  WHERE id = p_conversation_id;

  -- Nota explícita pedida: esta función NUNCA envía ningún mensaje al
  -- cliente. El mensaje de transición ("te voy a conectar con alguien...")
  -- es responsabilidad exclusiva del backend que invoca esta RPC, y solo
  -- debe enviarse después de que esta función confirme outcome='escalated'
  -- (ver docs/GENESIS_COMMERCIAL_BRAIN_V1.md sección 9.4/R1 — fuera de
  -- alcance de código en Fase 1A).
  RETURN QUERY SELECT v_new_escalation_id, 'escalated'::TEXT, NULL::TEXT;
END;
$$;

COMMENT ON FUNCTION escalate_genesis_conversation(UUID, UUID, TEXT, TEXT) IS
  'Contrato transaccional de escalamiento — invalida el run activo, revoca el lock, cambia genesis_status, crea el registro histórico en genesis_escalations. Si cualquier paso falla, la transacción completa se revierte (nunca queda una conversación "pausada sin registro"). Nunca envía mensajes al cliente. Fase 1A.1: si p_run_id no es NULL, se valida que exista, pertenezca a p_conversation_id y a la misma tienda antes de escribir nada — outcome=invalid_run sin escrituras parciales si no cumple.';

-- ────────────────────────────────────────────────────────────────────────
-- 2. take_genesis_conversation
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION take_genesis_conversation(
  p_conversation_id UUID
)
RETURNS TABLE (outcome TEXT, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id    UUID := auth.uid();
  v_caller_store UUID;
  v_conv_store   UUID;
BEGIN
  IF v_caller_id IS NULL OR NOT is_wa_inbox_role() THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, 'Requiere sesión autenticada con acceso al Inbox.'::TEXT;
    RETURN;
  END IF;

  v_caller_store := get_user_store_id();

  SELECT store_id INTO v_conv_store FROM wa_conversations WHERE id = p_conversation_id FOR UPDATE;

  IF NOT FOUND OR v_conv_store IS DISTINCT FROM v_caller_store THEN
    -- 'not_found' en ambos casos — no revelar la existencia de una
    -- conversación de otra tienda, mismo criterio que
    -- 052_reopen_confirmed_order_rpc.sql ya usa para orders.
    RETURN QUERY SELECT 'not_found'::TEXT, 'Conversación no encontrada.'::TEXT;
    RETURN;
  END IF;

  -- Invalidar cualquier run activo — un humano tomando la conversación
  -- revoca la capacidad de envío de Génesis con el mismo criterio que un
  -- escalamiento (R1.10.2), aunque este caso no crea ninguna fila en
  -- genesis_escalations (no es un escalamiento, es una toma manual).
  UPDATE genesis_message_runs
  SET status = 'skipped_human_active',
      failed_at = now(),
      lock_token = NULL,
      lock_expires_at = NULL
  WHERE conversation_id = p_conversation_id
    AND status IN ('claimed', 'processing', 'generated', 'sending');

  UPDATE wa_conversations
  SET assigned_to        = v_caller_id,
      ai_enabled         = false,
      genesis_status     = 'paused_by_human',
      ai_lock_token      = NULL,
      ai_lock_expires_at = NULL
  WHERE id = p_conversation_id;

  RETURN QUERY SELECT 'taken'::TEXT, NULL::TEXT;
END;
$$;

COMMENT ON FUNCTION take_genesis_conversation(UUID) IS
  'Equivalente transaccional de PATCH /api/whatsapp/conversations/[id]/take, con la adición de invalidar cualquier run activo de Génesis en la misma transacción. Cualquier rol con acceso al Inbox (excepto viewer) puede tomar cualquier conversación de su tienda, incluidas las escaladas — la restricción de admin/ia_supervisor aplica solo a DEVOLVER escalamientos críticos (release_genesis_conversation), nunca a tomarlos.';

-- ────────────────────────────────────────────────────────────────────────
-- 3. release_genesis_conversation
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION release_genesis_conversation(
  p_conversation_id    UUID,
  -- Fase 1A.1 (corrección post-auditoría): default cambiado de true a
  -- false. Regla de negocio aprobada — "liberar una conversación NO debe
  -- reactivar automáticamente Génesis". Con el default anterior, cualquier
  -- llamador que invocara esta RPC sin pasar el parámetro explícitamente
  -- reactivaba IA por accidente. Ahora el comportamiento sin parámetro es
  -- el seguro (queda unassigned, Génesis inactiva) — reactivar exige un
  -- true explícito. Ver COMMENT ON FUNCTION más abajo para el contrato
  -- completo.
  p_reactivate_genesis BOOLEAN DEFAULT false,
  p_resolution_note    TEXT DEFAULT NULL
)
RETURNS TABLE (outcome TEXT, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id           UUID := auth.uid();
  v_caller_role         TEXT;
  v_caller_store        UUID;
  v_conv_store          UUID;
  v_conv_assigned_to    UUID;
  v_open_escalation_id  UUID;
  v_open_priority       TEXT;
BEGIN
  IF v_caller_id IS NULL OR NOT is_wa_inbox_role() THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, 'Requiere sesión autenticada con acceso al Inbox.'::TEXT;
    RETURN;
  END IF;

  v_caller_role  := get_user_role();
  v_caller_store := get_user_store_id();

  SELECT store_id, assigned_to INTO v_conv_store, v_conv_assigned_to
  FROM wa_conversations WHERE id = p_conversation_id FOR UPDATE;

  IF NOT FOUND OR v_conv_store IS DISTINCT FROM v_caller_store THEN
    RETURN QUERY SELECT 'not_found'::TEXT, 'Conversación no encontrada.'::TEXT;
    RETURN;
  END IF;

  SELECT id, priority INTO v_open_escalation_id, v_open_priority
  FROM genesis_escalations
  WHERE conversation_id = p_conversation_id AND status = 'open'
  FOR UPDATE;

  -- ── Guardas de rol — decisión de negocio ya cerrada ─────────────────────
  IF v_open_escalation_id IS NOT NULL AND v_open_priority = 'critical' THEN
    -- Escalamiento crítico abierto: solo admin/ia_supervisor pueden
    -- devolver la conversación a Génesis o resolverlo, sin importar quién
    -- esté actualmente asignado.
    IF v_caller_role NOT IN ('admin', 'ia_supervisor') THEN
      RETURN QUERY SELECT 'forbidden'::TEXT,
        'Solo admin/ia_supervisor pueden resolver un escalamiento crítico.'::TEXT;
      RETURN;
    END IF;
  ELSE
    -- Sin escalamiento, o escalamiento no crítico: mismo criterio que el
    -- endpoint PATCH /release ya vigente hoy — solo quien tiene la
    -- conversación asignada puede liberarla (sin excepción de admin aquí,
    -- deliberadamente conservador para no ampliar el comportamiento actual
    -- más allá de lo pedido en esta fase).
    IF v_conv_assigned_to IS DISTINCT FROM v_caller_id THEN
      RETURN QUERY SELECT 'forbidden'::TEXT,
        'Solo el agente actualmente asignado puede liberar esta conversación.'::TEXT;
      RETURN;
    END IF;
  END IF;

  -- ── Resolver el escalamiento abierto, si lo hay ─────────────────────────
  IF v_open_escalation_id IS NOT NULL THEN
    UPDATE genesis_escalations
    SET status = 'resolved',
        resolved_at = now(),
        resolved_by = v_caller_id,
        resolution_note = p_resolution_note
    WHERE id = v_open_escalation_id;
  END IF;

  -- ── Limpiar campos activos, decidir reactivar o dejar inactiva ──────────
  -- No se toca genesis_message_runs aquí: los runs terminales de esta
  -- conversación (skipped_human_active/escalated) permanecen exactamente
  -- como están — es, precisamente, el "punto de corte" pedido: al
  -- reactivarse, solo un mensaje NUEVO (sin fila previa en
  -- genesis_message_runs) puede ser reclamado; claim_genesis_run nunca
  -- reintenta un estado terminal (ver migración 058).
  UPDATE wa_conversations
  SET assigned_to          = NULL,
      ai_enabled           = p_reactivate_genesis,
      genesis_status       = CASE WHEN p_reactivate_genesis THEN 'active' ELSE 'inactive' END,
      escalation_reason    = NULL,
      escalation_priority  = NULL,
      escalation_summary   = NULL,
      escalated_at         = NULL,
      escalated_by         = NULL
  WHERE id = p_conversation_id;

  IF p_reactivate_genesis THEN
    RETURN QUERY SELECT 'resumed_genesis'::TEXT, NULL::TEXT;
  ELSE
    RETURN QUERY SELECT 'released_unassigned'::TEXT, NULL::TEXT;
  END IF;
END;
$$;

COMMENT ON FUNCTION release_genesis_conversation(UUID, BOOLEAN, TEXT) IS
  'Equivalente transaccional extendido de PATCH /api/whatsapp/conversations/[id]/release. A diferencia del endpoint actual (que siempre reactiva ai_enabled=true incondicionalmente), distingue resumed_genesis de released_unassigned vía p_reactivate_genesis — DEFAULT false desde Fase 1A.1 (liberar nunca reactiva Génesis por accidente). Contrato: (1) Liberar sin pasar el parámetro, o con false explícito, → outcome=released_unassigned, queda unassigned con Génesis inactiva (ai_enabled=false, genesis_status=inactive). (2) Liberar con p_reactivate_genesis=true → outcome=resumed_genesis, reanuda Génesis (ai_enabled=true, genesis_status=active), sujeto a las mismas guardas de rol que cualquier release. (3) Si hay un escalamiento CRÍTICO abierto, solo admin/ia_supervisor puede llamar esta función con cualquier valor del parámetro — ni siquiera pueden reanudar Génesis un agente no autorizado, sin importar qué reciba el parámetro. Resuelve cualquier escalamiento abierto como parte de la misma transacción — no existe una RPC separada "resolve" en Fase 1A.';

-- ────────────────────────────────────────────────────────────────────────
-- 4. check_genesis_escalation_sla
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_genesis_escalation_sla()
RETURNS TABLE (escalation_id UUID, conversation_id UUID, elevated BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec RECORD;
BEGIN
  -- SKIP LOCKED: si esta función se invoca dos veces de forma concurrente
  -- (ej. dos disparos de cron solapados en una fase futura), cada
  -- invocación toma solo las filas que la otra no está tocando ya — nunca
  -- eleva la misma fila dos veces ni se bloquea esperando a la otra.
  FOR v_rec IN
    SELECT ge.id, ge.conversation_id, ge.priority
    FROM genesis_escalations ge
    WHERE ge.status = 'open'
      AND ge.next_escalation_check_at IS NOT NULL
      AND ge.next_escalation_check_at < now()
      AND ge.sla_alert_sent_at IS NULL
    ORDER BY ge.escalated_at ASC
    FOR UPDATE OF ge SKIP LOCKED
  LOOP
    UPDATE genesis_escalations
    SET priority = 'critical',
        sla_alert_sent_at = now()
    WHERE id = v_rec.id;

    -- Reflejar la nueva prioridad en el snapshot de wa_conversations
    -- también, solo si sigue siendo el escalamiento activo de esa
    -- conversación (defensa — no debería haber cambiado entre el SELECT y
    -- aquí, dado el FOR UPDATE, pero se guarda explícito por claridad).
    UPDATE wa_conversations
    SET escalation_priority = 'critical'
    WHERE id = v_rec.conversation_id AND genesis_status = 'escalated';

    escalation_id  := v_rec.id;
    conversation_id := v_rec.conversation_id;
    elevated       := (v_rec.priority IS DISTINCT FROM 'critical');
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION check_genesis_escalation_sla() IS
  'Infraestructura de re-escalamiento a 24h (umbral fijo en escalate_genesis_conversation, ver nota ahí sobre configurabilidad futura). Idempotente: sla_alert_sent_at impide elevar la misma fila dos veces. NUNCA reactiva Génesis — solo eleva prioridad y marca la alerta como enviada. Sin cron ni alerta UI en Fase 1A — este es solo el mecanismo de base que un futuro cron invocará.';

-- ============================================================
-- GRANTS
-- ============================================================
REVOKE ALL ON FUNCTION escalate_genesis_conversation(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION take_genesis_conversation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_genesis_conversation(UUID, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION check_genesis_escalation_sla() FROM PUBLIC;

-- Backend Génesis / futuro cron — nunca invocables por un usuario final.
GRANT EXECUTE ON FUNCTION escalate_genesis_conversation(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION check_genesis_escalation_sla() TO service_role;

-- Agentes humanos autenticados — la función misma revalida rol con
-- is_wa_inbox_role()/get_user_role(), nunca confía solo en este GRANT.
GRANT EXECUTE ON FUNCTION take_genesis_conversation(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION release_genesis_conversation(UUID, BOOLEAN, TEXT) TO authenticated;

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente después de aplicar, no automatizada)
-- ============================================================
-- SELECT routine_name, grantee, privilege_type FROM information_schema.routine_privileges
-- WHERE routine_name IN ('escalate_genesis_conversation','take_genesis_conversation','release_genesis_conversation','check_genesis_escalation_sla');
-- Resultado esperado: escalate_genesis_conversation y
-- check_genesis_escalation_sla → solo 'service_role'; take/release → solo
-- 'authenticated'.
--
-- Como agente autenticado (rol != viewer), sobre una conversación real de
-- su propia tienda:
--   SELECT * FROM take_genesis_conversation('<conv real>');
--   -- outcome='taken'
--   SELECT * FROM release_genesis_conversation('<misma conv>', true);
--   -- outcome='resumed_genesis'
--
-- Como admin, forzando un escalamiento crítico de prueba (vía service_role
-- primero) y luego intentando liberarlo con un rol no autorizado — debe
-- fallar con outcome='forbidden'.
--
-- Con el cliente de service role, p_run_id de una conversación distinta:
--   SELECT * FROM escalate_genesis_conversation('<conv real A>', '<run_id que pertenece a conv B>', 'fraud', NULL);
--   -- outcome='invalid_run', escalation_id=NULL — verificar que NO se creó
--   -- fila en genesis_escalations ni se tocó wa_conversations de conv A.

-- ============================================================
-- ROLLBACK (si hace falta deshacer esta migración)
-- ============================================================
-- REVOKE EXECUTE ON FUNCTION release_genesis_conversation(UUID, BOOLEAN, TEXT) FROM authenticated;
-- REVOKE EXECUTE ON FUNCTION take_genesis_conversation(UUID) FROM authenticated;
-- REVOKE EXECUTE ON FUNCTION check_genesis_escalation_sla() FROM service_role;
-- REVOKE EXECUTE ON FUNCTION escalate_genesis_conversation(UUID, UUID, TEXT, TEXT) FROM service_role;
-- DROP FUNCTION IF EXISTS check_genesis_escalation_sla();
-- DROP FUNCTION IF EXISTS release_genesis_conversation(UUID, BOOLEAN, TEXT);
-- DROP FUNCTION IF EXISTS take_genesis_conversation(UUID);
-- DROP FUNCTION IF EXISTS escalate_genesis_conversation(UUID, UUID, TEXT, TEXT);
-- No afecta ninguna tabla — es aditivo, solo funciones.
