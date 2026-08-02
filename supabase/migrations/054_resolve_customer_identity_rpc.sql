-- ============================================================
-- 054_resolve_customer_identity_rpc.sql
-- Customer Intelligence Engine — Fase 1, corrección: resolver de identidad
-- transaccional.
--
-- ORDEN DE APLICACIÓN: depende de 053_customer_identity.sql (requiere que
-- las tablas customers/customer_identifiers ya existan). No aplicar esta
-- migración antes que esa.
--
-- PROPÓSITO
-- Reemplaza la lógica de src/lib/customers/resolve-customer.ts (dos
-- .insert() independientes vía PostgREST, sin transacción) por una única
-- función PL/pgSQL que resuelve o crea la identidad de un cliente en una
-- sola transacción de base de datos. Elimina el riesgo de dejar un
-- `customers` huérfano (sin `customer_identifiers`) si el segundo INSERT
-- falla después de que el primero ya se confirmó — algo que la versión
-- anterior no podía garantizar porque cada .insert() de PostgREST es su
-- propia transacción independiente.
--
-- SEGURIDAD (resumen — detalle en cada bloque más abajo)
--   - SECURITY DEFINER: la función necesita escribir en customers/
--     customer_identifiers aunque el rol que la invoca (`authenticated`)
--     no tenga ninguna política INSERT sobre esas tablas — ese es
--     precisamente el punto: la función es la única puerta de escritura
--     controlada, en vez de abrir una política INSERT amplia.
--   - search_path fijado explícitamente (`SET search_path = public,
--     pg_temp`) para blindar contra secuestro de search_path — riesgo
--     estándar de toda función SECURITY DEFINER que no lo fija.
--   - No confía en p_store_id del caller: lo contrasta contra
--     get_user_store_id() (la tienda real de la sesión autenticada,
--     resuelta desde profiles vía auth.uid()) y devuelve
--     outcome='store_mismatch' si no coinciden.
--   - Rechaza explícitamente: sesiones anónimas (auth.uid() IS NULL) y
--     roles fuera de la lista mínima autorizada (mismo conjunto que
--     is_customer_intel_role(), definida en 053) — outcome='forbidden'.
--   - GRANT EXECUTE únicamente a `authenticated` — nunca a `anon`. No se
--     otorga a `service_role` explícitamente porque no hace falta
--     (service_role ya tiene privilegios que ignoran GRANT/RLS) y,
--     además, la función RECHAZA a service_role de todos modos porque
--     auth.uid() es NULL para ese rol — ver nota "Compatibilidad futura"
--     más abajo.
--
-- CONCURRENCIA
--   pg_advisory_xact_lock() sobre un hash de (store_id, identifier_type,
--   value_normalized) serializa las llamadas concurrentes para la MISMA
--   identidad — la segunda llamada espera a que la primera termine (y
--   libere el lock automáticamente al hacer COMMIT/ROLLBACK de su
--   transacción) antes de hacer su propio SELECT, así que normalmente
--   nunca llega a competir por el INSERT. Como defensa adicional (por si
--   algo escribe sin pasar por esta función, ej. un futuro path de
--   servicio), el bloque de inserts también atrapa unique_violation con
--   un SAVEPOINT implícito (BEGIN...EXCEPTION) que revierte AMBOS inserts
--   de ese bloque si el segundo falla — nunca queda un customer huérfano.
--
-- ROLLBACK (si hace falta deshacer esta migración)
--   REVOKE EXECUTE ON FUNCTION resolve_customer_identity(UUID,TEXT,TEXT,TEXT,TEXT) FROM authenticated;
--   DROP FUNCTION IF EXISTS resolve_customer_identity(UUID,TEXT,TEXT,TEXT,TEXT);
--   No afecta 053 ni ninguna otra tabla — es aditivo, una sola función.
-- ============================================================

CREATE OR REPLACE FUNCTION resolve_customer_identity(
  p_store_id        UUID,
  p_value_normalized TEXT,
  p_source          TEXT,
  p_full_name       TEXT DEFAULT NULL,
  p_email           TEXT DEFAULT NULL
)
RETURNS TABLE (
  customer_id UUID,
  created     BOOLEAN,
  outcome     TEXT,
  message     TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_role  TEXT;
  v_caller_store UUID;
  v_customer_id  UUID;
  v_created      BOOLEAN := false;
  v_lock_key     BIGINT;
BEGIN
  -- ── 1. Validar usuario y tienda ─────────────────────────────────────
  -- Nunca confiar en p_store_id por sí solo. auth.uid() NULL = sesión
  -- anónima (o service_role, que no tiene un usuario específico) → rechazar.
  IF auth.uid() IS NULL THEN
    RETURN QUERY SELECT NULL::UUID, false, 'forbidden'::TEXT,
      'Requiere sesión autenticada — no se admite invocación anónima ni service_role en esta fase.'::TEXT;
    RETURN;
  END IF;

  v_caller_role  := get_user_role();
  v_caller_store := get_user_store_id();

  -- Lista mínima necesaria: los mismos 5 roles ya aprobados para leer
  -- identidad de cliente en 053_customer_identity.sql
  -- (is_customer_intel_role()) — no se amplía aquí sin necesidad concreta,
  -- aunque esta operación en sí no expone datos sensibles de otros
  -- clientes (solo confirma/crea una identidad), se mantiene el mismo
  -- perímetro ya decidido para toda la superficie de Customer Intelligence.
  IF v_caller_role IS NULL OR v_caller_role NOT IN (
    'admin', 'ia_supervisor', 'confirmation_agent', 'dispatch_agent', 'novelty_agent'
  ) THEN
    RETURN QUERY SELECT NULL::UUID, false, 'forbidden'::TEXT,
      format('Rol no autorizado para resolver identidad de cliente: %s', COALESCE(v_caller_role, 'sin perfil'))::TEXT;
    RETURN;
  END IF;

  IF v_caller_store IS NULL OR v_caller_store IS DISTINCT FROM p_store_id THEN
    RETURN QUERY SELECT NULL::UUID, false, 'store_mismatch'::TEXT,
      'p_store_id no coincide con la tienda del usuario autenticado — no se puede resolver identidad en otra tienda.'::TEXT;
    RETURN;
  END IF;

  -- ── 2. Validar input básico (defensa adicional — normalizePhone() ya
  --      corrió en TypeScript antes de llegar aquí; esto cubre invocación
  --      directa de la RPC sin pasar por el wrapper) ────────────────────
  IF p_value_normalized IS NULL OR length(trim(p_value_normalized)) = 0 THEN
    RETURN QUERY SELECT NULL::UUID, false, 'invalid_input'::TEXT, 'p_value_normalized vacío.'::TEXT;
    RETURN;
  END IF;

  IF p_source IS NULL OR p_source NOT IN ('shopify_webhook', 'whatsapp_webhook', 'manual') THEN
    RETURN QUERY SELECT NULL::UUID, false, 'invalid_input'::TEXT,
      format('p_source inválido: %s', COALESCE(p_source, 'NULL'))::TEXT;
    RETURN;
  END IF;

  -- ── 3. Advisory lock — serializa por (store_id, identifier_type='phone',
  --      value_normalized). Se libera solo al terminar la transacción de
  --      esta llamada (COMMIT o ROLLBACK), nunca hay que liberarlo a mano. ─
  v_lock_key := hashtextextended(p_store_id::TEXT || ':phone:' || p_value_normalized, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- ── 4. Buscar identifier activo existente ───────────────────────────
  SELECT ci.customer_id INTO v_customer_id
  FROM customer_identifiers ci
  WHERE ci.store_id = p_store_id
    AND ci.identifier_type = 'phone'
    AND ci.value_normalized = p_value_normalized
    AND ci.active = true;

  IF v_customer_id IS NOT NULL THEN
    -- Encontrado. NO se actualiza last_seen_at aquí: el documento de
    -- arquitectura (sección 11) ata last_seen_at a eventos específicos
    -- (mensaje recibido, etc.), no a "alguien invocó el resolver" en
    -- general — no hay regla aprobada que autorice ese touch en esta
    -- fase. Tampoco se actualiza full_name/email (instrucción explícita).
    RETURN QUERY SELECT v_customer_id, false, 'found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  -- ── 5. No existe — crear customer + identifier en un solo bloque
  --      transaccional. Si el segundo INSERT falla por unique_violation
  --      (defensa adicional — no debería ocurrir bajo el advisory lock,
  --      salvo un escritor que no pase por esta función), el SAVEPOINT
  --      implícito de este BEGIN...EXCEPTION revierte AMBOS inserts —
  --      nunca queda un customer sin su identifier. ────────────────────
  BEGIN
    INSERT INTO customers (store_id, phone_primary, full_name, email, first_seen_at, last_seen_at)
    VALUES (p_store_id, p_value_normalized, p_full_name, p_email, now(), now())
    RETURNING id INTO v_customer_id;

    INSERT INTO customer_identifiers (
      customer_id, store_id, identifier_type, value_normalized,
      is_primary, active, confidence, source, detected_at
    ) VALUES (
      v_customer_id, p_store_id, 'phone', p_value_normalized,
      true, true, 1.000, p_source, now()
    );

    v_created := true;
    RETURN QUERY SELECT v_customer_id, v_created, 'created'::TEXT, NULL::TEXT;
    RETURN;

  EXCEPTION
    WHEN unique_violation THEN
      -- Otra transacción ganó la carrera pese al advisory lock (o escribió
      -- sin pasar por esta función). El rollback al savepoint ya deshizo
      -- el INSERT de customers de este bloque — releer y devolver la fila
      -- real, nunca un customer huérfano.
      SELECT ci.customer_id INTO v_customer_id
      FROM customer_identifiers ci
      WHERE ci.store_id = p_store_id
        AND ci.identifier_type = 'phone'
        AND ci.value_normalized = p_value_normalized
        AND ci.active = true;

      RETURN QUERY SELECT v_customer_id, false, 'conflict_recovered'::TEXT,
        'unique_violation recuperado — se devolvió el customer_id ya existente.'::TEXT;
      RETURN;

    WHEN OTHERS THEN
      -- Nunca propagar una excepción SQL cruda al cliente HTTP. El
      -- savepoint implícito ya revirtió cualquier insert parcial de este
      -- bloque.
      RETURN QUERY SELECT NULL::UUID, false, 'db_error'::TEXT, SQLERRM::TEXT;
      RETURN;
  END;
END;
$$;

-- ============================================================
-- GRANTS
-- ============================================================

-- Función creada por el owner de la migración (postgres, con BYPASSRLS en
-- Supabase) — como SECURITY DEFINER, sus INSERT/SELECT internos sobre
-- customers/customer_identifiers corren con esos privilegios, no con los
-- del rol que invoca. Por eso NO hace falta (ni se agrega) una política
-- RLS de INSERT para `authenticated` en 053 — esta función es la única
-- puerta de escritura.
REVOKE ALL ON FUNCTION resolve_customer_identity(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_customer_identity(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
-- Nunca a anon. No se otorga a service_role explícitamente — ver nota de
-- compatibilidad futura abajo.

-- ============================================================
-- COMPATIBILIDAD FUTURA — webhooks / service_role (NO implementado aquí)
-- ============================================================
-- Los webhooks de Shopify/WhatsApp corren hoy con createServiceClient()
-- (service_role), sin sesión de usuario — auth.uid() es NULL para esas
-- llamadas, así que esta función los RECHAZA (outcome='forbidden') por
-- diseño, no por descuido. Esto es intencional en V1: no se debilita el
-- modelo de "solo sesión autenticada" solo para destrabar un caso de uso
-- que todavía no está conectado (esta fase prohíbe explícitamente tocar
-- los webhooks).
--
-- Cuando se autorice conectar webhooks (fase futura, fuera de esta
-- migración), la opción recomendada NO es debilitar esta función
-- aceptando auth.uid() NULL — es crear una función hermana separada,
-- ej. resolve_customer_identity_service(p_store_id, p_value_normalized,
-- p_source, ...), sin el check de auth.uid()/rol, con
-- GRANT EXECUTE ... TO service_role (nunca a authenticated ni anon), que
-- reutilice el mismo core transaccional (advisory lock + savepoint) vía
-- una función interna compartida. Mantiene el perímetro de seguridad de
-- esta función intacto para el caso de sesión de usuario, y le da al
-- caso de servicio su propio contrato explícito en vez de un backdoor
-- oculto dentro de esta.
--
-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente para confirmar)
-- ============================================================
-- SELECT proname, prosecdef FROM pg_proc WHERE proname = 'resolve_customer_identity';
-- Resultado esperado: 1 fila, prosecdef = true (SECURITY DEFINER)
--
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
-- WHERE routine_name = 'resolve_customer_identity';
-- Resultado esperado: EXECUTE solo para 'authenticated' (y el owner)
