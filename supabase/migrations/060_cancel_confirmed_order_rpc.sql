-- ============================================================
-- 060_cancel_confirmed_order_rpc.sql
--
-- RPC transaccional para la rama action='cancelled' (manual, "Ya no
-- desea") de applyConfirmationAction() (src/lib/orders/confirmation.ts).
-- Corrige el mismo problema de atomicidad ya resuelto para "Reabrir
-- pedido" en 052_reopen_confirmed_order_rpc.sql: antes de esta migración,
-- cancelar un pedido SD confirmado y auto-despachado (en_reparto, sin
-- guía EFI) hacía dos llamadas PostgREST independientes — UPDATE orders y
-- luego INSERT agent_actions(action_type='customer_declined') — sin
-- ninguna garantía de que ambas ocurrieran juntas. Si el UPDATE tenía
-- éxito y el INSERT fallaba después, el pedido quedaba correctamente
-- 'cancelled' en el eje comercial mientras Ruta COD / /sd-delivery lo
-- seguían mostrando activo (src/lib/deliveries/sd-status.ts nunca se
-- entera del rechazo sin esa fila).
--
-- Con esta RPC, el SELECT ... FOR UPDATE + las guardas + el UPDATE de
-- orders + el INSERT condicional de agent_actions ocurren dentro de una
-- única invocación de función = una única transacción real de Postgres.
-- Si el INSERT falla, Postgres revierte también el UPDATE de la misma
-- invocación — no hay estado intermedio posible.
--
-- No es un motor paralelo: applyConfirmationAction() sigue siendo la
-- única entrada de aplicación autorizada a mover confirmation_status
-- (Principio 4, docs/ARCHITECTURE_RUTA_COD_V1.md). Esta función es
-- exclusivamente el mecanismo de persistencia de esa rama — las guardas
-- de negocio que ya vivían en TypeScript (delivered/returned/paid/
-- has_tracking) se revalidan aquí, bajo lock, en vez de confiar en que el
-- caller ya las evaluó.
--
-- ── Qué NO cambia ─────────────────────────────────────────────────────
-- El camino automatizado (guardAutomated=true — webhook de WhatsApp, botón
-- "No, gracias") NO pasa por esta RPC. Corre con createServiceClient()
-- (sin sesión de usuario real → auth.uid() sería NULL) y guardAutomated ya
-- exige confirmation_status='pending' antes de llegar a la rama cancelled
-- — estructuralmente incompatible con normalized_status='en_reparto' (que
-- solo ocurre después de confirmar), así que esa rama JAMÁS necesita el
-- INSERT de customer_declined que esta RPC atomiza. Se preserva sin
-- tocar, tal como estaba antes de esta migración (ver confirmation.ts).
--
-- ── Seguridad de identidad y RBAC ─────────────────────────────────────
-- Mismo criterio que reopen_confirmed_order (052): la identidad se deriva
-- EXCLUSIVAMENTE de auth.uid() dentro de la función — nunca de un
-- parámetro del cliente. p_order_id/p_attempts/p_method/p_confidence son
-- los únicos parámetros — ninguno representa "quién" ejecuta la acción.
--
-- Roles permitidos: exactamente is_agent_or_above() — la MISMA función
-- que ya gobierna orders_update/actions_insert vía RLS hoy (013_roles.sql,
-- última definición en 029_dispatch_agent_role.sql: admin,
-- ia_supervisor, confirmation_agent, novelty_agent, delivery_agent,
-- santo_domingo_delivery_agent, dispatch_agent, agent). No se amplía ni se
-- restringe RBAC respecto al comportamiento actual — hoy CUALQUIER rol
-- que pasa RLS puede ejecutar 'cancelled' vía
-- POST /api/orders/[id]/confirmation (ese endpoint no tiene un gate de rol
-- propio para esta acción, a diferencia de 'reopened'). Se revalida aquí,
-- dentro de la función, por el mismo motivo que 052: con
-- GRANT EXECUTE TO authenticated, cualquier usuario autenticado podría
-- invocar la RPC directo desde el SDK de Supabase, saltándose el route de
-- Next.js — sin este chequeo interno, un rol que falla RLS simplemente
-- vería su UPDATE afectar 0 filas en vez de un 'forbidden' explícito.
--
-- Aislamiento por tienda: doble guarda (RLS + comparación explícita de
-- store_id), mismo patrón que 052.
--
-- SECURITY INVOKER: applyConfirmationAction() siempre recibe el cliente de
-- sesión real para el camino manual (nunca el service role) — mismo
-- criterio que 052/050.
--
-- ── Idempotencia (doble clic / reintento) ─────────────────────────────
-- El UPDATE de orders es naturalmente idempotente (fijar los mismos
-- valores dos veces no cambia nada). El INSERT de agent_actions NO lo es
-- por diseño de la tabla (sin índice único) — se protege explícitamente
-- con un EXISTS antes de insertar, para que una segunda invocación sobre
-- el mismo pedido ya cancelado devuelva 'ok' de nuevo (reentrante, seguro)
-- sin duplicar la fila customer_declined. El SELECT ... FOR UPDATE
-- serializa invocaciones concurrentes sobre el mismo pedido — la segunda
-- espera a que la primera termine su transacción antes de leer el estado
-- ya actualizado.
-- ============================================================

CREATE OR REPLACE FUNCTION cancel_confirmed_order(
  p_order_id   uuid,
  p_attempts   integer,
  p_method     text,
  p_confidence text
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id           uuid := auth.uid();
  v_caller_store_id     uuid;
  v_order_store_id      uuid;
  v_normalized_status   text;
  v_tracking_number     text;
  v_payment_status      text;
  v_already_declined    boolean;
BEGIN
  -- ── Identidad y RBAC — nunca desde parámetros del cliente ──────────────
  IF v_caller_id IS NULL THEN
    RETURN 'forbidden';
  END IF;

  IF NOT is_agent_or_above() THEN
    RETURN 'forbidden';
  END IF;

  SELECT store_id INTO v_caller_store_id
  FROM profiles
  WHERE id = v_caller_id;

  IF v_caller_store_id IS NULL THEN
    RETURN 'forbidden';
  END IF;

  -- ── Estado del pedido bajo lock ──────────────────────────────────────────
  SELECT normalized_status, tracking_number, payment_status::text, store_id
    INTO v_normalized_status, v_tracking_number, v_payment_status, v_order_store_id
  FROM orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  -- Aislamiento por tienda — doble guarda además de RLS (orders_select ya
  -- filtra por store_id = get_user_store_id(), así que en la práctica esta
  -- fila nunca debería llegar aquí para otra tienda; se revalida de forma
  -- explícita de todos modos, mismo criterio que 052). 'not_found' en vez
  -- de un código distinto, para no revelar la existencia de pedidos de
  -- otra tienda al actor.
  IF v_order_store_id IS DISTINCT FROM v_caller_store_id THEN
    RETURN 'not_found';
  END IF;

  -- ── Guardas de negocio — mismo orden y semántica que la versión
  -- TypeScript que esta función reemplaza (src/lib/orders/confirmation.ts,
  -- case 'cancelled') — "Ya no desea" puede aplicarse desde cualquier
  -- estado comercial anterior (ver docs/ARCHITECTURE_RUTA_COD_V1.md, tabla
  -- "Quién mueve cada transición": Cualquier estado → Cancelado, actor
  -- autorizado: Agente), pero no puede revertir silenciosamente una
  -- operación logística ya cerrada o cobrada.
  IF v_normalized_status IN ('delivered', 'returned') THEN
    RETURN 'terminal_status';
  END IF;

  IF COALESCE(v_payment_status, 'pending') = 'paid' THEN
    RETURN 'already_paid';
  END IF;

  IF v_tracking_number IS NOT NULL THEN
    RETURN 'has_tracking';
  END IF;

  -- ── Escritura — todo o nada ──────────────────────────────────────────────
  UPDATE orders SET
    confirmation_status        = 'cancelled',
    -- customer_confirmed en false para que no quede el badge "Cliente
    -- confirmó" (/orders/[id], /reparto) visible sobre un pedido que el
    -- cliente acaba de rechazar. customer_confirmed_at NO se toca — queda
    -- como historial de que sí confirmó, en su momento.
    customer_confirmed         = false,
    confirmation_attempts      = p_attempts,
    last_confirmation_attempt  = now(),
    confirmation_method        = p_method,
    confirmation_confidence    = p_confidence
  WHERE id = p_order_id;

  -- 'cancelled' sobre un pedido SD ya auto-despachado (en_reparto, sin
  -- guía EFI) además marca el eje operativo — sin esto, Ruta COD /
  -- /sd-delivery (src/lib/deliveries/sd-status.ts) nunca se entera del
  -- rechazo y el mensajero seguiría viendo el pedido como activo.
  -- 'customer_declined' es el mismo action_type que ya usa /sd-delivery
  -- para este caso (ver saveCustomerDeclined en
  -- src/app/(app)/sd-delivery/page.tsx) — no es un motor nuevo, es el
  -- mecanismo existente que ambos ejes ya saben leer
  -- (computeStatus/computeDisplayStatus en sd-status.ts lo revisan antes
  -- que cualquier otra cosa).
  IF v_normalized_status = 'en_reparto' AND v_tracking_number IS NULL THEN
    SELECT EXISTS(
      SELECT 1 FROM agent_actions
      WHERE order_id = p_order_id AND action_type = 'customer_declined'
    ) INTO v_already_declined;

    IF NOT v_already_declined THEN
      INSERT INTO agent_actions (order_id, agent_id, action_type, notes)
      VALUES (p_order_id, v_caller_id, 'customer_declined', 'Cliente ya no desea — cancelado desde Confirmación');
    END IF;
  END IF;

  RETURN 'ok';
END;
$$;

COMMENT ON FUNCTION cancel_confirmed_order IS
  'Único mecanismo atómico de la rama cancelled ("Ya no desea") de applyConfirmationAction() (src/lib/orders/confirmation.ts) para el camino manual (agente humano, no el webhook automatizado). Revalida identidad (auth.uid()), rol (is_agent_or_above()), tienda, y todas las guardas de negocio dentro de una única transacción con SELECT ... FOR UPDATE. Inserta agent_actions(customer_declined) atómicamente cuando el pedido es SD activo (en_reparto, sin guía), de forma idempotente ante doble clic.';

-- Cualquier usuario autenticado puede INVOCAR el RPC (GRANT a nivel de
-- Postgres), pero la función misma rechaza con 'forbidden' a cualquier rol
-- que no sea is_agent_or_above(), sin importar si RLS también lo
-- permitiría — el rechazo real vive aquí, no solo en el route de Next.js.
--
-- REVOKE ALL ... FROM PUBLIC por sí solo NO basta: el template de Supabase
-- corre `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS
-- TO anon, authenticated, service_role` al crear el proyecto — un GRANT
-- DIRECTO a cada rol (no vía PUBLIC), que una función nueva hereda al
-- crearse. Revocar de PUBLIC no lo toca. Verificado empíricamente en la
-- validación post-aplicación (2026-08-08): `anon` SÍ podía invocar la
-- función (entraba al cuerpo, auth.uid() era NULL, y devolvía 'forbidden'
-- por la guarda interna — nunca llegó a mutar nada, pero la única barrera
-- real era la lógica de negocio, no el permiso de Postgres). Se revoca
-- aquí explícitamente por rol para cerrar esa brecha de defensa en
-- profundidad.
REVOKE ALL ON FUNCTION cancel_confirmed_order(uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_confirmed_order(uuid, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION cancel_confirmed_order(uuid, integer, text, text) FROM service_role;
GRANT EXECUTE ON FUNCTION cancel_confirmed_order(uuid, integer, text, text) TO authenticated;
-- Nunca a anon, nunca a service_role (el camino automatizado no usa esta RPC — ver comentario arriba).

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente después de aplicar, no automatizada)
-- ============================================================
-- BEGIN;
--   -- Como cualquier rol is_agent_or_above() autenticado, sobre un pedido
--   -- confirmado real, sin guía, sin pagar, no entregado/devuelto:
--   SELECT cancel_confirmed_order('<id de un pedido confirmado real>', 1, 'call', 'risky');
--   -- debe devolver 'ok'; confirmar en la misma transacción:
--   SELECT confirmation_status, customer_confirmed, customer_confirmed_at,
--          normalized_status, confirmation_attempts, confirmation_method, confirmation_confidence
--   FROM orders WHERE id = '<mismo id>';
--   SELECT agent_id, action_type, notes FROM agent_actions
--   WHERE order_id = '<mismo id>' AND action_type = 'customer_declined';
--   -- Si el pedido estaba en_reparto sin tracking: debe existir EXACTAMENTE
--   -- una fila customer_declined, con agent_id = el auth.uid() de la sesión
--   -- que llamó. Si no estaba en_reparto: no debe existir ninguna.
--
--   -- Doble clic — reinvocar sobre el mismo pedido ya cancelado:
--   SELECT cancel_confirmed_order('<mismo id>', 2, 'call', 'risky');
--   -- debe devolver 'ok' de nuevo (idempotente), SIN duplicar la fila
--   -- customer_declined — volver a contar filas customer_declined para ese
--   -- order_id y confirmar que sigue siendo como máximo 1.
-- ROLLBACK; -- para no dejar datos de prueba
--
-- -- Casos a probar manualmente antes de dar por cerrada la fase:
-- --   A. Pedido confirmado, sin guía, no pagado, normalized_status='pending'
-- --      (confirmado esperando despacho, no SD auto-despachado) → 'ok',
-- --      sin fila customer_declined.
-- --   B. Pedido confirmado con payment_status='paid' → 'already_paid'.
-- --   C. Pedido confirmado con tracking_number asignado → 'has_tracking'.
-- --   D. Pedido normalized_status='delivered' → 'terminal_status'.
-- --   E. Pedido normalized_status='returned' → 'terminal_status'.
-- --   F. Pedido SD confirmado y auto-despachado (en_reparto, sin guía)
-- --      → 'ok' + exactamente 1 fila customer_declined.
