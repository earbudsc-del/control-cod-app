-- ============================================================
-- 061_cancel_confirmed_order_ruta_cod.sql
--
-- Sincroniza la acción 'customer_cancelled' de Ruta COD
-- (POST /api/v1/deliveries/orders/[id]/actions) con el eje comercial —
-- Y corrige un ensanchamiento demasiado amplio de un primer intento de
-- esta misma migración (nunca aplicado) que habría insertado
-- agent_actions(customer_declined) en TODA cancelación exitosa desde
-- CUALQUIER caller, incluyendo /confirmacion sobre pedidos provinciales
-- (fuera de Santo Domingo) sin ninguna relación con Ruta COD.
--
-- ── Causa del bug original ─────────────────────────────────────────────
-- Antes de esta migración, 'customer_cancelled' insertaba únicamente
-- agent_actions(action_type='customer_declined') — nunca tocaba
-- orders.confirmation_status ni orders.customer_confirmed. Resultado: el
-- pedido quedaba operativamente cancelado (Ruta COD, sd-status.ts, ya lo
-- mostraba como 'cancelado' vía computeStatus()) pero comercialmente
-- seguía 'confirmed'.
--
-- ── Por qué NO basta con reusar cancel_confirmed_order() (060) tal cual ──
-- 060 solo inserta customer_declined cuando normalized_status='en_reparto'
-- — el único caso que /confirmacion necesitaba. Ruta COD también permite
-- 'customer_cancelled' desde el pool 'nuevo' (pedido SD confirmado pero
-- AÚN sin despachar — normalized_status distinto de 'en_reparto', ver
-- computeAllowedActions() en src/lib/deliveries/sd-status.ts, estado
-- 'no_responde' con pool='nuevo'). Sin la fila customer_declined en ese
-- caso, computeStatus() no puede reflejar 'cancelado' — cae de vuelta a
-- un valor stale (el `latest` action anterior, o 'nuevo' por defecto) —
-- exactamente la misma clase de desincronización que esta migración
-- busca cerrar, solo que en el otro eje.
--
-- ── Por qué NO basta con "insertar siempre, para cualquier caller" ──────
-- Auditoría de TODOS los callers de applyConfirmationAction(action=
-- 'cancelled') (2026-08-08, ronda 2):
--   1. POST /api/orders/[id]/confirmation — agente humano en /confirmacion.
--      Cubre pedidos provinciales (EFI) Y pedidos SD, en cualquier estado
--      no-terminal sin guía. 'customer_declined' NUNCA debe insertarse
--      para un pedido provincial (no tiene ninguna relación con Ruta COD
--      ni con sd-status.ts) — sería contaminar el eje operativo con una
--      fila que ningún lector legítimo (sd-status.ts, sd-delivery legacy,
--      wa-template-queue — las tres únicas lecturas reales de este
--      action_type) necesita ni espera para ese pedido.
--   2. Webhook de WhatsApp (guardAutomated=true) — NUNCA llega a
--      applyCancel()/esta RPC (ver guard confirmation_status='pending' +
--      terminal_status en confirmation.ts). No aplica.
--   3. Ruta COD v1 (POST /api/v1/deliveries/orders/[id]/actions,
--      action='customer_cancelled') — el mensajero SD reportando rechazo.
--      SIEMPRE sobre un pedido ya validado como SD-eligible (isSdEligible()
--      ya lo exige en el endpoint) — aquí SÍ corresponde insertar
--      customer_declined incondicionalmente, sea pool 'nuevo' o
--      'confirmado' (en_reparto).
--
-- La distinción correcta no es geográfica (SD vs provincial) — es de
-- ORIGEN de la cancelación. Reimplementar isSantoDomingoOrder() en SQL
-- sería redundante (el endpoint ya lo valida en TypeScript antes de
-- llamar) y frágil (dos copias del mismo regex a mantener sincronizadas).
-- La señal correcta y ya inequívoca es el caller mismo: se agrega un
-- parámetro explícito p_from_ruta_cod, con default false que preserva el
-- comportamiento EXACTO de 060 para todo caller existente
-- (/confirmacion). Solo Ruta COD lo pasa en true.
--
-- ── Cambio de firma — DROP explícito, no solo CREATE OR REPLACE ────────
-- CREATE OR REPLACE FUNCTION no reemplaza una función cuya firma (lista de
-- parámetros) cambió — crea una SOBRECARGA adicional, dejando dos
-- funciones `cancel_confirmed_order` coexistiendo (una de 4 parámetros,
-- otra de 5). Aunque el nuevo parámetro tenga DEFAULT, Postgres seguiría
-- pudiendo resolver una llamada con los 4 parámetros originales contra
-- CUALQUIERA de las dos sobrecargas — PostgREST fallaría con "function
-- cancel_confirmed_order(uuid, integer, text, text) is not unique". Por
-- eso esta migración hace DROP FUNCTION explícito de la firma de 4
-- parámetros antes de crear la de 5. No queda ninguna sobrecarga
-- ambigua: una sola función `cancel_confirmed_order` existe después de
-- aplicar esta migración.
--
-- ── Qué NO cambia ──────────────────────────────────────────────────────
-- Identidad (auth.uid()), RBAC (is_agent_or_above()), aislamiento por
-- tienda, los 3 guards de negocio (terminal_status/already_paid/
-- has_tracking), SECURITY INVOKER, GRANT/REVOKE (mismos roles) — todo
-- idéntico a 060. Comportamiento de /confirmacion (p_from_ruta_cod=false,
-- el default) — idéntico byte a byte a 060, incluida la nota de
-- agent_actions.
--
-- ── Reparación retroactiva de datos ya inconsistentes ──────────────────
-- Antes de 060, CUALQUIER cancelación (incluida la propia
-- 'customer_cancelled' de Ruta COD, y /sd-delivery legacy vía
-- POST /api/orders/[id]/actions action_type='customer_declined', que
-- SIGUE sin pasar por este motor — deuda documentada, fuera de alcance de
-- esta migración) pudo dejar agent_actions.customer_declined insertado
-- sin que confirmation_status se sincronizara jamás. Backfill al final de
-- esta migración: repara esas filas existentes con las MISMAS 3 guardas
-- de negocio que la RPC (nunca toca un pedido delivered/returned/paid/con
-- guía) — no depende de que alguien vuelva a invocar la acción sobre
-- cada pedido para que se corrija.
-- ============================================================

-- Elimina explícitamente la firma de 4 parámetros de 060 antes de crear
-- la de 5 — ver "Cambio de firma" arriba. IF EXISTS: no falla si esta
-- migración se re-ejecuta después de haber corrido una vez.
DROP FUNCTION IF EXISTS cancel_confirmed_order(uuid, integer, text, text);

CREATE OR REPLACE FUNCTION cancel_confirmed_order(
  p_order_id      uuid,
  p_attempts      integer,
  p_method        text,
  p_confidence    text,
  p_from_ruta_cod boolean DEFAULT false
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

  -- Aislamiento por tienda — doble guarda además de RLS. 'not_found' en vez
  -- de un código distinto, para no revelar la existencia de pedidos de
  -- otra tienda al actor.
  IF v_order_store_id IS DISTINCT FROM v_caller_store_id THEN
    RETURN 'not_found';
  END IF;

  -- ── Guardas de negocio — sin cambios respecto a 060 ─────────────────────
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
    -- confirmó" visible sobre un pedido que el cliente acaba de rechazar.
    -- customer_confirmed_at NO se toca — queda como historial de que sí
    -- confirmó, en su momento.
    customer_confirmed         = false,
    confirmation_attempts      = p_attempts,
    last_confirmation_attempt  = now(),
    confirmation_method        = p_method,
    confirmation_confidence    = p_confidence
  WHERE id = p_order_id;

  -- Inserta agent_actions(customer_declined) — idempotente vía EXISTS —
  -- cuando: (a) p_from_ruta_cod=true (Ruta COD SIEMPRE necesita esta fila,
  -- sea cual sea normalized_status, porque su propia máquina de estados
  -- depende de ella para representar 'cancelado'), O (b) el pedido está
  -- 'en_reparto' (comportamiento ORIGINAL de 060, sin cambios, para
  -- /confirmacion). v_tracking_number IS NULL ya está garantizado por el
  -- guard has_tracking de arriba.
  --
  -- Deliberadamente NO se inserta para /confirmacion (p_from_ruta_cod=
  -- false) sobre un pedido que todavía no está 'en_reparto' — ese pedido
  -- nunca tuvo una trayectoria operativa que cerrar (ver auditoría de
  -- callers en la cabecera de esta migración, caso "SD pending no
  -- operativo"): preserva el comportamiento histórico exacto.
  IF p_from_ruta_cod OR v_normalized_status = 'en_reparto' THEN
    SELECT EXISTS(
      SELECT 1 FROM agent_actions
      WHERE order_id = p_order_id AND action_type = 'customer_declined'
    ) INTO v_already_declined;

    IF NOT v_already_declined THEN
      INSERT INTO agent_actions (order_id, agent_id, action_type, notes)
      VALUES (
        p_order_id, v_caller_id, 'customer_declined',
        CASE WHEN p_from_ruta_cod
          THEN 'Cliente ya no desea — reportado por mensajero (Ruta COD)'
          ELSE 'Cliente ya no desea — cancelado desde Confirmación'
        END
      );
    END IF;
  END IF;

  RETURN 'ok';
END;
$$;

COMMENT ON FUNCTION cancel_confirmed_order(uuid, integer, text, text, boolean) IS
  'Único mecanismo atómico de la rama cancelled ("Ya no desea" en /confirmacion, "customer_cancelled" en Ruta COD) de applyConfirmationAction() (src/lib/orders/confirmation.ts) para caminos con sesión real — nunca el webhook automatizado. Revalida identidad (auth.uid()), rol (is_agent_or_above()), tienda, y todas las guardas de negocio dentro de una única transacción con SELECT ... FOR UPDATE. p_from_ruta_cod (default false) distingue si debe insertar agent_actions(customer_declined) incondicionalmente (Ruta COD, que lo necesita para cualquier estado operativo) o solo cuando normalized_status=en_reparto (comportamiento original de la migración 060, preservado para /confirmacion). Idempotente ante doble clic o llamadas concurrentes.';

-- Mismo GRANT/REVOKE que 060, sobre la nueva firma de 5 parámetros.
REVOKE ALL ON FUNCTION cancel_confirmed_order(uuid, integer, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_confirmed_order(uuid, integer, text, text, boolean) FROM anon;
REVOKE ALL ON FUNCTION cancel_confirmed_order(uuid, integer, text, text, boolean) FROM service_role;
GRANT EXECUTE ON FUNCTION cancel_confirmed_order(uuid, integer, text, text, boolean) TO authenticated;

-- ============================================================
-- BACKFILL — repara filas ya inconsistentes existentes hoy en producción
-- (customer_declined insertado por código previo a 060/061 sin sincronizar
-- confirmation_status). Idempotente: una segunda ejecución no encuentra
-- filas que actualizar porque el WHERE ya excluye confirmation_status=
-- 'cancelled'. Mismas 3 guardas de negocio que la RPC — nunca toca un
-- pedido delivered/returned, pagado, o con guía asignada (si alguno de
-- esos pasó por una vía distinta después de la fila customer_declined
-- original, ese hecho posterior tiene prioridad y no se revierte aquí).
-- ============================================================
UPDATE orders o SET
  confirmation_status = 'cancelled',
  customer_confirmed  = false
WHERE o.confirmation_status IS DISTINCT FROM 'cancelled'
  AND o.normalized_status NOT IN ('delivered', 'returned')
  AND COALESCE(o.payment_status::text, 'pending') != 'paid'
  AND o.tracking_number IS NULL
  AND EXISTS (
    SELECT 1 FROM agent_actions aa
    WHERE aa.order_id = o.id AND aa.action_type = 'customer_declined'
  );

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente después de aplicar, no automatizada)
-- ============================================================
-- BEGIN;
--   -- 0. Confirmar que solo existe UNA función con este nombre (sin
--   --    sobrecarga ambigua de la firma vieja de 4 parámetros):
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
--   FROM pg_proc p WHERE p.proname = 'cancel_confirmed_order';
--   -- debe devolver EXACTAMENTE 1 fila, args = "p_order_id uuid, p_attempts
--   -- integer, p_method text, p_confidence text, p_from_ruta_cod boolean".
--
--   -- 1. /confirmacion (p_from_ruta_cod=false, o param omitido) sobre un
--   --    pedido SD pending (aún no en_reparto) — comportamiento histórico:
--   --    NO debe insertar customer_declined.
--   SELECT cancel_confirmed_order('<id pedido SD, confirmation_status=confirmed o pending, normalized_status != en_reparto, sin tracking>', 1, 'call', 'risky');
--   -- 'ok'; confirmar:
--   SELECT confirmation_status, customer_confirmed FROM orders WHERE id = '<mismo id>';
--   -- confirmation_status='cancelled', customer_confirmed=false.
--   SELECT count(*) FROM agent_actions WHERE order_id = '<mismo id>' AND action_type = 'customer_declined';
--   -- debe ser 0.
--
--   -- 2. Ruta COD (p_from_ruta_cod=true) sobre el mismo tipo de pedido
--   --    (SD, aún no en_reparto) — SÍ debe insertar customer_declined.
--   SELECT cancel_confirmed_order('<id pedido SD, confirmation_status=confirmed o pending, normalized_status != en_reparto, sin tracking>', 1, 'call', 'risky', true);
--   -- 'ok'; confirmar:
--   SELECT count(*) FROM agent_actions WHERE order_id = '<mismo id>' AND action_type = 'customer_declined';
--   -- debe ser 1.
--
--   -- 3. Provincial pending cancelado desde /confirmacion — nunca debe
--   --    dejar customer_declined, con o sin 061:
--   SELECT cancel_confirmed_order('<id pedido NO Santo Domingo, pending, sin tracking>', 1, 'call', 'risky');
--   SELECT count(*) FROM agent_actions WHERE order_id = '<mismo id>' AND action_type = 'customer_declined';
--   -- debe ser 0.
--
--   -- 4. Caso original de 060 sigue intacto: SD confirmado y en_reparto
--   --    (sin tracking) cancelado desde /confirmacion → 'ok' + exactamente
--   --    1 fila customer_declined.
--
--   -- 5. Doble clic — reinvocar sobre un pedido ya cancelado (cualquier
--   --    combinación de p_from_ruta_cod): 'ok' de nuevo, sin duplicar
--   --    customer_declined.
-- ROLLBACK; -- para no dejar datos de prueba
--
--   -- 6. Backfill — antes de aplicar en producción, correr en modo
--   --    solo-lectura para ver el alcance real:
--   SELECT o.id, o.order_number, o.confirmation_status, o.customer_confirmed,
--          o.normalized_status, o.tracking_number, o.payment_status
--   FROM orders o
--   WHERE o.confirmation_status IS DISTINCT FROM 'cancelled'
--     AND o.normalized_status NOT IN ('delivered', 'returned')
--     AND COALESCE(o.payment_status::text, 'pending') != 'paid'
--     AND o.tracking_number IS NULL
--     AND EXISTS (
--       SELECT 1 FROM agent_actions aa
--       WHERE aa.order_id = o.id AND aa.action_type = 'customer_declined'
--     );
-- ============================================================
