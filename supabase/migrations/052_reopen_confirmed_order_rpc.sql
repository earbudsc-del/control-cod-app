-- ============================================================
-- 052_reopen_confirmed_order_rpc.sql
--
-- RPC transaccional para "Reabrir pedido". Revisión de seguridad y de
-- distinción auto/manual (2026-07-31), sobre la primera versión de esta
-- migración.
--
-- ── DEPENDENCIA DE MIGRACIÓN — ORDEN OBLIGATORIO ─────────────────────────
-- Esta función hace INSERT INTO agent_actions (..., action_type='reopened',
-- ...). Ese valor solo es válido después de aplicar
-- 051_agent_actions_reopened_type.sql (amplía el CHECK constraint). Si 052
-- se aplica o se ejecuta antes que 051, la función se CREA sin error (Postgres
-- no valida el cuerpo de una función contra constraints en tiempo de
-- creación), pero la PRIMERA llamada real fallará en el INSERT con un error
-- 23514 (violación de CHECK) — la transacción completa se revierte (sin
-- estado parcial, por diseño), pero el usuario ve un error 500 confuso en
-- una feature que debería funcionar. 051 DEBE aplicarse antes que 052 en
-- cualquier entorno (local, staging, producción). El orden numérico
-- (051 < 052) ya garantiza esto bajo el runner estándar de migraciones de
-- Supabase (aplica archivos en orden numérico/lexicográfico) — no se
-- requiere ninguna guarda adicional en el SQL, solo disciplina de
-- despliegue: NO HACER PUSH hasta que ambas estén aplicadas en producción.
--
-- ── Qué corrige esta revisión respecto a la versión anterior ────────────
-- 1. ATOMICIDAD (ya resuelta en la revisión previa): UPDATE orders + INSERT
--    agent_actions ahora ocurren dentro de esta única invocación de función
--    = una única transacción real. Sigue igual en esta revisión.
-- 2. DISTINCIÓN AUTO vs MANUAL de 'local_dispatched' (nuevo en esta
--    revisión — ver sección más abajo). La versión anterior trataba
--    CUALQUIER fila con action_type='local_dispatched' como segura,
--    sin distinguir el auto-despacho de la confirmación del despacho local
--    MANUAL (botón "Despachar local", POST /api/orders/[id]/dispatch-local)
--    — un despacho manual real habría quedado sin bloquear la reapertura.
-- 3. SEGURIDAD DE LA IDENTIDAD (nuevo en esta revisión — ver sección más
--    abajo). La versión anterior recibía p_agent_id como parámetro confiado
--    ciegamente del cliente — cualquier usuario autenticado podía atribuir
--    la reapertura a otro agente, y cualquier rol con is_agent_or_above()
--    (no solo admin/confirmation_agent) podía invocar la RPC directo desde
--    el SDK de Supabase, saltándose el RBAC que solo vivía en el route de
--    Next.js.
-- ============================================================

-- ── Distinción auto-despacho vs despacho local manual ────────────────────
--
-- Auditoría real de los tres orígenes de agent_actions.action_type=
-- 'local_dispatched' en el código (no hay columna estructurada — agent_actions
-- no tiene metadata/triggered_by; notes es TEXT libre, así que la única señal
-- disponible hoy es el texto exacto de notes):
--
--   1. src/lib/orders/confirmation.ts (applyConfirmationAction, rama
--      isSdAutoDispatch, disparada EN EL MISMO INSTANTE de confirmar):
--        notes = 'Auto-despachado al confirmar — pedido SD sin guía EFI'
--   2. src/app/api/sd-delivery/orders/[id]/confirm-client/route.ts
--      (mensajero SD confirma directamente, duplica la lógica de auto-
--      despacho — ver Principio 4 y la sección "Excepciones" de
--      docs/ARCHITECTURE_RUTA_COD_V1.md, violación ya documentada):
--        notes = 'Despachado automáticamente al confirmar — transporte local SD sin guía EFI'
--   3. src/lib/deliveries/dispatch-local.ts (dispatchOrderLocally, invocada
--      por POST /api/orders/[id]/dispatch-local — acción MANUAL, deliberada,
--      posterior a la confirmación, ejecutada por un humano distinto del
--      evento de confirmar):
--        notes = 'Despachado por admin — transporte SD sin guía EFI'                    (actorRole='admin')
--        notes = 'Despachado por agente de despacho — transporte SD sin guía EFI'        (actorRole='dispatch_agent')
--        notes = 'Despachado por mensajero SD — transporte local sin guía EFI'           (actorRole='santo_domingo_delivery_agent')
--
-- Los tres textos de (3) son inequívocamente distintos de los dos textos de
-- (1)/(2) — ninguno los reutiliza ni los aproxima. La regla usada abajo es
-- una comparación EXACTA (=), nunca ILIKE/fuzzy: una fila 'local_dispatched'
-- solo se considera "subproducto seguro de la confirmación" si su notes
-- coincide carácter por carácter con uno de los dos textos de auto-despacho
-- conocidos. Cualquier otro valor de notes para 'local_dispatched' —
-- incluidos los 3 de despacho manual, NULL, o cualquier texto futuro que no
-- se haya anticipado aquí — se trata como NO seguro y bloquea. Esto es
-- deliberado: el default es bloquear, no permitir; un texto nuevo que
-- alguien agregue mañana sin actualizar esta función queda bloqueado por
-- defecto en vez de colarse como "seguro reabrir".
--
-- Mismo criterio aplicado a 'confirmed': la única fuente que inserta ese
-- action_type es confirm-client (notas exactas arriba) — applyConfirmationAction()
-- NUNCA inserta agent_actions para su propio case 'confirmed' (solo
-- modifica columnas de orders). Se exige notes exacto también ahí, con el
-- mismo default-bloquea si no coincide.
--
-- Nota honesta sobre esta fragilidad: comparar texto libre es la única
-- señal disponible hoy (no hay columna estructurada) y por pedido explícito
-- no se agrega una columna nueva en esta fase. El riesgo residual es
-- asimétrico y del lado seguro: si alguien cambia estos literales en el
-- futuro sin actualizar esta función, el efecto es que el auto-despacho
-- legítimo empieza a bloquearse (falso negativo de "es seguro reabrir"),
-- nunca que un despacho manual real se deje pasar (nunca hay un falso
-- positivo de "es seguro" para texto no reconocido).
--
-- ── Seguridad de identidad y RBAC ─────────────────────────────────────────
--
-- p_agent_id COMO PARÁMETRO FUE ELIMINADO. La versión anterior lo recibía
-- del cliente y lo insertaba tal cual en agent_actions.agent_id — cualquier
-- usuario autenticado podía atribuir la reapertura a un agente arbitrario
-- con solo cambiar el valor del parámetro en una llamada directa por el SDK
-- de Supabase (GRANT EXECUTE TO authenticated ya permitía a cualquier
-- usuario autenticado invocar la función, sin pasar por
-- POST /api/orders/[id]/confirmation).
--
-- Ahora la identidad se deriva EXCLUSIVAMENTE de auth.uid() dentro de la
-- función — el mismo mecanismo que ya usan get_user_role()/get_user_store_id()
-- (002_rls.sql) para las políticas RLS de todo este proyecto. No hay forma
-- de que un parámetro del cliente sustituya esto.
--
-- RBAC (admin/confirmation_agent) se revalida DENTRO de la función,
-- consultando profiles.role del propio auth.uid() — no se confía
-- únicamente en el chequeo de POST /api/orders/[id]/confirmation. Con
-- GRANT EXECUTE TO authenticated, cualquier rol con is_agent_or_above()
-- (dispatch_agent, delivery_agent, novelty_agent, ia_supervisor,
-- santo_domingo_delivery_agent, agent) satisface igual las políticas RLS de
-- orders_update/actions_insert — sin este chequeo interno, cualquiera de
-- esos roles podría invocar la RPC directo desde el SDK y saltarse
-- por completo la restricción de "solo admin/confirmation_agent" que antes
-- vivía nada más en el route de Next.js.
--
-- Aislamiento por tienda: además de que RLS ya impide ver/bloquear filas de
-- otro store (orders_select/orders_update exigen store_id=get_user_store_id()),
-- se compara explícitamente orders.store_id contra el store_id del perfil
-- del actor — doble guarda, mismo patrón defensivo ya usado en
-- dispatch-local/route.ts y mark-paid/route.ts (que también revalidan
-- store_id en código de aplicación en vez de confiar solo en RLS).
--
-- Motivo: se revalida no-vacío (tras trim) y con longitud máxima dentro de
-- la función — la validación de TypeScript (src/lib/orders/confirmation.ts)
-- es solo un atajo de UX para no gastar un round-trip; la única validación
-- que realmente importa para la integridad de los datos es esta.
--
-- SECURITY INVOKER (sin cambio respecto a la revisión anterior): mismo
-- criterio que 050_get_sd_cobros_summary_rpc.sql — applyConfirmationAction()
-- siempre recibe el cliente de sesión, nunca el service role.
-- ============================================================

CREATE OR REPLACE FUNCTION reopen_confirmed_order(
  p_order_id uuid,
  p_reason   text
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Estas cadenas son identificadores legacy de origen. No modificar sin
  -- migrar a una señal estructurada. Copiadas carácter por carácter desde:
  --   c_auto_confirm_note    ← src/app/api/sd-delivery/orders/[id]/confirm-client/route.ts
  --   c_auto_dispatch_note_1 ← src/lib/orders/confirmation.ts (rama isSdAutoDispatch)
  --   c_auto_dispatch_note_2 ← src/app/api/sd-delivery/orders/[id]/confirm-client/route.ts
  -- Verificado byte-a-byte contra el código fuente real en la validación de
  -- esta fase (2026-08-01) — no son transcripciones aproximadas.
  c_auto_confirm_note    CONSTANT text    := 'Confirmado por mensajero SD (cliente confirmó recepción)';
  c_auto_dispatch_note_1 CONSTANT text    := 'Auto-despachado al confirmar — pedido SD sin guía EFI';
  c_auto_dispatch_note_2 CONSTANT text    := 'Despachado automáticamente al confirmar — transporte local SD sin guía EFI';
  c_max_reason_length    CONSTANT integer := 500;

  v_caller_id           uuid := auth.uid();
  v_caller_role         text;
  v_caller_store_id     uuid;
  v_order_store_id      uuid;
  v_confirmation_status text;
  v_normalized_status   text;
  v_tracking_number     text;
  v_payment_status      text;
  v_assigned_to         uuid;
  v_unsafe_count        integer;
  v_revert_operational  boolean := false;
  v_reason              text := trim(coalesce(p_reason, ''));
BEGIN
  -- ── Identidad y RBAC — nunca desde parámetros del cliente ──────────────
  IF v_caller_id IS NULL THEN
    RETURN 'forbidden';
  END IF;

  SELECT role, store_id INTO v_caller_role, v_caller_store_id
  FROM profiles
  WHERE id = v_caller_id;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'confirmation_agent') THEN
    RETURN 'forbidden';
  END IF;

  -- ── Motivo — validado aquí, no solo en TypeScript ───────────────────────
  IF v_reason = '' THEN
    RETURN 'reason_required';
  END IF;
  IF length(v_reason) > c_max_reason_length THEN
    RETURN 'reason_too_long';
  END IF;

  -- ── Estado del pedido bajo lock ──────────────────────────────────────────
  SELECT confirmation_status, normalized_status, tracking_number, payment_status::text, assigned_to, store_id
    INTO v_confirmation_status, v_normalized_status, v_tracking_number, v_payment_status, v_assigned_to, v_order_store_id
  FROM orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  -- Aislamiento por tienda — doble guarda además de RLS. Se devuelve
  -- 'not_found' (no un código distinto) para no revelar la existencia de
  -- pedidos de otra tienda al actor.
  IF v_order_store_id IS DISTINCT FROM v_caller_store_id THEN
    RETURN 'not_found';
  END IF;

  IF v_confirmation_status IS DISTINCT FROM 'confirmed' THEN
    RETURN 'not_confirmed';
  END IF;

  IF v_tracking_number IS NOT NULL THEN
    RETURN 'has_tracking';
  END IF;

  IF COALESCE(v_payment_status, 'pending') = 'paid' THEN
    RETURN 'already_paid';
  END IF;

  IF v_normalized_status IN ('delivered', 'returned') THEN
    RETURN 'terminal_status';
  END IF;

  -- tracking_number ya se descartó arriba, así que 'en_reparto' aquí solo
  -- puede venir del auto-despacho SD (nunca de un courier real, que siempre
  -- requiere guía) O de un despacho local MANUAL posterior — ver auditoría
  -- de los tres orígenes de 'local_dispatched' al inicio de este archivo.
  IF v_normalized_status = 'en_reparto' THEN
    -- assigned_to: señal directa e independiente de "un mensajero ya
    -- reclamó este pedido" (acción 'accept' de Ruta COD).
    IF v_assigned_to IS NOT NULL THEN
      RETURN 'dispatched';
    END IF;

    -- Comparación EXACTA (=), nunca ILIKE — ver comentario extenso arriba.
    -- Cuenta filas que NO coinciden con ninguno de los dos subproductos
    -- seguros conocidos de la confirmación; NULL de la comparación
    -- (p.ej. notes NULL) se fuerza a "no seguro" vía COALESCE(..., false).
    SELECT count(*) INTO v_unsafe_count
    FROM agent_actions
    WHERE order_id = p_order_id
      AND NOT COALESCE(
            (action_type = 'confirmed'        AND notes = c_auto_confirm_note) OR
            (action_type = 'local_dispatched' AND notes IN (c_auto_dispatch_note_1, c_auto_dispatch_note_2)),
            false
          );

    IF v_unsafe_count > 0 THEN
      RETURN 'dispatched';
    END IF;

    v_revert_operational := true;
  END IF;

  UPDATE orders SET
    confirmation_status   = 'pending',
    customer_confirmed    = false,
    customer_confirmed_at = NULL,
    normalized_status     = CASE WHEN v_revert_operational THEN 'pending' ELSE normalized_status END,
    status_since          = CASE WHEN v_revert_operational THEN NULL     ELSE status_since     END
  WHERE id = p_order_id;

  INSERT INTO agent_actions (order_id, agent_id, action_type, notes)
  VALUES (p_order_id, v_caller_id, 'reopened', v_reason);

  RETURN 'ok';
END;
$$;

COMMENT ON FUNCTION reopen_confirmed_order IS
  'Único mecanismo atómico de "Reabrir pedido" — invocado exclusivamente desde la rama reopened de applyConfirmationAction() (src/lib/orders/confirmation.ts). Revalida identidad (auth.uid()), rol (admin/confirmation_agent), tienda, motivo, y todas las guardas de negocio dentro de una única transacción con SELECT ... FOR UPDATE. No confía en ningún parámetro del cliente para la identidad del actor.';

-- Cualquier usuario autenticado puede INVOCAR el RPC (GRANT a nivel de
-- Postgres), pero la función misma rechaza con 'forbidden' a cualquier rol
-- que no sea admin/confirmation_agent, sin importar si RLS también lo
-- permitiría — el rechazo real vive aquí, no solo en el route de Next.js.
GRANT EXECUTE ON FUNCTION reopen_confirmed_order TO authenticated;

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente después de aplicar, no automatizada)
-- ============================================================
-- BEGIN;
--   -- Como admin/confirmation_agent autenticado, sobre un pedido confirmado
--   -- real, sin guía, sin pagar, no entregado:
--   SELECT reopen_confirmed_order(
--     '<id de un pedido confirmado real>',
--     'prueba de verificación'
--   );
--   -- debe devolver 'ok'; confirmar en la misma transacción:
--   SELECT confirmation_status, customer_confirmed, customer_confirmed_at,
--          normalized_status, status_since
--   FROM orders WHERE id = '<mismo id>';
--   SELECT agent_id, action_type, notes FROM agent_actions
--   WHERE order_id = '<mismo id>' AND action_type = 'reopened';
--   -- agent_id debe ser el auth.uid() de la sesión que llamó, nunca un
--   -- valor arbitrario.
-- ROLLBACK; -- para no dejar datos de prueba
--
-- -- Casos a probar manualmente antes de dar por cerrada la fase:
-- --   A. Pedido SD recién confirmado y auto-despachado (sin dispatch-local
-- --      posterior) → 'ok'.
-- --   B. Pedido con dispatch-local manual aplicado (sin acciones
-- --      posteriores del mensajero) → 'dispatched', aunque assigned_to siga
-- --      NULL.
-- --   C. Pedido con auto-despacho Y dispatch-local manual (o cualquier
-- --      acción real posterior) → 'dispatched'.
