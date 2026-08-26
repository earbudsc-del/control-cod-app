-- ============================================================
-- 063_edit_local_sd_order_rpc.sql
--
-- RPC transaccional para POST /api/orders/[id]/edit-local — edición
-- operativa de dirección/producto/monto COD de pedidos del flujo LOCAL
-- Santo Domingo (cuando el cliente cambia dirección/oferta/monto después
-- de confirmar). Reemplaza el patrón anterior (UPDATE orders seguido de
-- dos INSERT independientes vía Promise.allSettled) por una única
-- invocación de función = una única transacción real de Postgres: o se
-- guardan orders + notes + agent_actions juntos, o no se guarda nada.
--
-- Mismo patrón ya probado en 052_reopen_confirmed_order_rpc.sql y
-- 060_cancel_confirmed_order_rpc.sql — SECURITY INVOKER, identidad
-- exclusivamente desde auth.uid(), SELECT ... FOR UPDATE, guardas de
-- negocio revalidadas dentro de la función bajo lock.
--
-- ── Por qué esta función NO reproduce isSantoDomingoOrder() en SQL ──────
-- La elegibilidad "es un pedido del flujo local SD" depende de
-- isSantoDomingoOrder() (src/lib/alert-helpers.ts) — normalización de
-- texto + listas de sectores/zonas (src/lib/sd-zones.ts) que existen
-- únicamente en TypeScript. Duplicar esa lógica en plpgsql crearía dos
-- fuentes de verdad que divergirían con el tiempo (el propio código de
-- sd-zones.ts ya tiene un comentario explícito prohibiendo una segunda
-- copia de esos términos). En su lugar:
--
--   1. El endpoint (TypeScript) sigue siendo la ÚNICA fuente de verdad
--      para "¿es SD local?" — recién leído el pedido, evalúa
--      isSdEligible()/isSantoDomingoOrder() sobre esos valores.
--   2. Esta función NO vuelve a evaluar esa regla. En su lugar, recibe
--      los tres valores geográficos que TypeScript usó para decidir
--      (p_expected_customer_address/city/province) y, bajo el lock de
--      esta misma transacción, comprueba que la fila NO cambió desde
--      esa lectura (IS DISTINCT FROM). Si cambió → 'conflict'.
--
-- Esto cierra la ventana TOCTOU (otro request pudo mover la dirección
-- entre el precheck de TypeScript y esta llamada) sin duplicar ni un
-- carácter de la lógica de zonas: la función nunca necesita saber QUÉ
-- hace SD-elegible a un pedido, solo si la fila que TypeScript validó
-- sigue siendo la misma fila ahora, bajo lock.
--
-- ── Campos editables — únicamente estos cinco ────────────────────────────
-- customer_address, city, province, product_summary, cod_amount.
-- Ningún otro campo es tocado por esta función — ni tracking_number, ni
-- normalized_status, ni confirmation_status, ni payment_status, ni
-- customer_confirmed, ni ningún timestamp operativo ajeno.
--
-- ── Seguridad ─────────────────────────────────────────────────────────
-- SECURITY INVOKER — corre con los privilegios (y RLS) del usuario real
-- que llama, nunca con service_role. Identidad exclusivamente desde
-- auth.uid() — p_order_id y los valores de campos son los únicos datos
-- que vienen del cliente; ninguno representa "quién" ejecuta la acción.
-- Rol revalidado DENTRO de la función (admin/dispatch_agent/
-- confirmation_agent — exactamente los mismos tres roles que ya
-- verificaba el endpoint) — con GRANT EXECUTE TO authenticated,
-- cualquier usuario autenticado podría invocar la RPC directo desde el
-- SDK de Supabase saltándose el route de Next.js; el rechazo real vive
-- aquí, no solo en TypeScript. Aislamiento por tienda: comparación
-- explícita de store_id además de RLS (mismo patrón que 052/060).
--
-- ── Atomicidad y rollback ────────────────────────────────────────────────
-- El UPDATE de orders y los INSERT de notes/agent_actions ocurren dentro
-- de esta única invocación. Si cualquier INSERT falla (constraint, FK,
-- lo que sea), PL/pgSQL propaga la excepción sin capturarla — Postgres
-- revierte automáticamente TODA la transacción de la función, incluido
-- el UPDATE. No hay try/catch que trague el error: no hay forma de que
-- quede orders modificado con auditoría incompleta.
-- ============================================================

CREATE OR REPLACE FUNCTION edit_local_sd_order(
  p_order_id                  uuid,
  p_expected_customer_address text,
  p_expected_city             text,
  p_expected_province         text,
  p_set_customer_address      boolean,
  p_customer_address          text,
  p_set_city                  boolean,
  p_city                      text,
  p_set_province              boolean,
  p_province                  text,
  p_set_product_summary       boolean,
  p_product_summary           text,
  p_set_cod_amount            boolean,
  p_cod_amount                numeric
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id         uuid := auth.uid();
  v_caller_role       text;
  v_caller_store_id   uuid;
  v_caller_full_name  text;

  v_order_store_id       uuid;
  v_customer_address     text;
  v_city                 text;
  v_province             text;
  v_product_summary      text;
  v_cod_amount            numeric;
  v_tracking_number      text;
  v_normalized_status    text;
  v_payment_status       text;

  v_diff_lines  text[] := '{}';
  v_actor_label text;
  v_note_content text;
  v_action_notes text;
BEGIN
  -- ── Identidad y RBAC — nunca desde parámetros del cliente ──────────────
  IF v_caller_id IS NULL THEN
    RETURN 'forbidden';
  END IF;

  SELECT role, store_id, full_name INTO v_caller_role, v_caller_store_id, v_caller_full_name
  FROM profiles
  WHERE id = v_caller_id;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'dispatch_agent', 'confirmation_agent') THEN
    RETURN 'forbidden';
  END IF;

  -- ── Estado del pedido bajo lock ──────────────────────────────────────────
  SELECT store_id, customer_address, city, province, product_summary, cod_amount,
         tracking_number, normalized_status, payment_status::text
    INTO v_order_store_id, v_customer_address, v_city, v_province, v_product_summary, v_cod_amount,
         v_tracking_number, v_normalized_status, v_payment_status
  FROM orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  -- Aislamiento por tienda — doble guarda además de RLS. 'not_found' (no
  -- un código distinto) para no revelar la existencia de pedidos de otra
  -- tienda al actor — mismo criterio que 052/060.
  IF v_order_store_id IS DISTINCT FROM v_caller_store_id THEN
    RETURN 'not_found';
  END IF;

  -- ── Guardas de negocio — mismas que ya validaba el endpoint, revalidadas
  -- aquí bajo lock contra el estado MÁS RECIENTE de la fila ──────────────
  IF v_tracking_number IS NOT NULL THEN
    RETURN 'has_tracking';
  END IF;

  IF COALESCE(v_payment_status, 'pending') = 'paid' THEN
    RETURN 'already_paid';
  END IF;

  IF v_normalized_status IN ('delivered', 'returned') THEN
    RETURN 'terminal_status';
  END IF;

  -- ── Conflicto (TOCTOU) — la fila que TypeScript validó como SD-elegible
  -- (isSantoDomingoOrder sobre estos tres campos) debe seguir siendo la
  -- misma AHORA, bajo lock. Si cualquiera de los tres cambió desde el
  -- precheck, la clasificación SD de TypeScript quedó obsoleta — no se
  -- reevalúa aquí (ver comentario de cabecera), se rechaza explícitamente.
  IF v_customer_address IS DISTINCT FROM p_expected_customer_address
     OR v_city           IS DISTINCT FROM p_expected_city
     OR v_province        IS DISTINCT FROM p_expected_province THEN
    RETURN 'conflict';
  END IF;

  -- ── Diff — solo campos que TypeScript pidió cambiar Y que realmente
  -- difieren del valor actual bajo lock (nunca se listan campos sin
  -- cambio real, aunque el cliente los haya enviado). ────────────────────
  IF p_set_customer_address AND v_customer_address IS DISTINCT FROM p_customer_address THEN
    v_diff_lines := array_append(v_diff_lines,
      format('Dirección: "%s" → "%s"', COALESCE(v_customer_address, '—'), COALESCE(p_customer_address, '—')));
  END IF;

  IF p_set_city AND v_city IS DISTINCT FROM p_city THEN
    v_diff_lines := array_append(v_diff_lines,
      format('Ciudad/sector: "%s" → "%s"', COALESCE(v_city, '—'), COALESCE(p_city, '—')));
  END IF;

  IF p_set_province AND v_province IS DISTINCT FROM p_province THEN
    v_diff_lines := array_append(v_diff_lines,
      format('Provincia: "%s" → "%s"', COALESCE(v_province, '—'), COALESCE(p_province, '—')));
  END IF;

  IF p_set_product_summary AND v_product_summary IS DISTINCT FROM p_product_summary THEN
    v_diff_lines := array_append(v_diff_lines,
      format('Producto/oferta: "%s" → "%s"', COALESCE(v_product_summary, '—'), COALESCE(p_product_summary, '—')));
  END IF;

  IF p_set_cod_amount AND v_cod_amount IS DISTINCT FROM p_cod_amount THEN
    v_diff_lines := array_append(v_diff_lines,
      format('Monto COD: RD$%s → RD$%s', COALESCE(v_cod_amount::text, '0'), COALESCE(p_cod_amount::text, '0')));
  END IF;

  -- Sin cambios reales bajo lock (el cliente pidió valores idénticos a los
  -- actuales, o la fila ya tenía esos valores por otra vía) — no-op
  -- idempotente: no UPDATE, no auditoría, 'ok'. No se inventa un estado
  -- nuevo para este caso (ver sección 6 del pedido de implementación).
  IF COALESCE(array_length(v_diff_lines, 1), 0) = 0 THEN
    RETURN 'ok';
  END IF;

  -- ── Escritura — todo o nada ──────────────────────────────────────────────
  UPDATE orders SET
    customer_address = CASE WHEN p_set_customer_address THEN p_customer_address ELSE customer_address END,
    city              = CASE WHEN p_set_city              THEN p_city              ELSE city END,
    province          = CASE WHEN p_set_province          THEN p_province          ELSE province END,
    product_summary   = CASE WHEN p_set_product_summary   THEN p_product_summary   ELSE product_summary END,
    cod_amount        = CASE WHEN p_set_cod_amount         THEN p_cod_amount        ELSE cod_amount END
  WHERE id = p_order_id;

  v_actor_label  := COALESCE(v_caller_full_name, v_caller_role);
  v_note_content := format('Pedido editado (flujo local SD) por %s:' || E'\n' || '%s',
                            v_actor_label, array_to_string(v_diff_lines, E'\n'));
  v_action_notes := 'Pedido editado (SD local): ' || array_to_string(v_diff_lines, ' · ');

  -- Si cualquiera de estos dos INSERT falla, la excepción no se captura —
  -- Postgres revierte automáticamente el UPDATE de arriba también. No hay
  -- audit_warning ni estado parcial posible.
  INSERT INTO notes (order_id, created_by, content)
  VALUES (p_order_id, v_caller_id, v_note_content);

  INSERT INTO agent_actions (order_id, agent_id, action_type, notes)
  VALUES (p_order_id, v_caller_id, 'note_added', v_action_notes);

  RETURN 'ok';
END;
$$;

COMMENT ON FUNCTION edit_local_sd_order IS
  'Único mecanismo atómico de edición operativa (dirección/ciudad/provincia/producto/monto COD) para pedidos del flujo local SD — invocado exclusivamente desde POST /api/orders/[id]/edit-local. Revalida identidad (auth.uid()), rol (admin/dispatch_agent/confirmation_agent), tienda, y las guardas de negocio (has_tracking/already_paid/terminal_status) dentro de una única transacción con SELECT ... FOR UPDATE. Detecta conflicto TOCTOU comparando los valores geográficos esperados por TypeScript (que ya evaluó isSantoDomingoOrder) contra el estado actual bajo lock — nunca reproduce esa lógica de zonas en SQL. UPDATE orders + INSERT notes + INSERT agent_actions ocurren en la misma transacción: todo o nada.';

-- Cualquier usuario autenticado puede INVOCAR el RPC (GRANT a nivel de
-- Postgres), pero la función misma rechaza con 'forbidden' a cualquier rol
-- que no sea admin/dispatch_agent/confirmation_agent, sin importar si RLS
-- también lo permitiría — el rechazo real vive aquí, no solo en el route
-- de Next.js. Mismo criterio defensivo que 060_cancel_confirmed_order_rpc.sql:
-- el template de Supabase corre `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
-- FUNCTIONS TO anon, authenticated, service_role` al crear el proyecto, así
-- que una función nueva hereda GRANT directo a esos tres roles al crearse
-- — REVOKE FROM PUBLIC por sí solo no lo revierte. Se revoca explícitamente
-- por rol.
REVOKE ALL ON FUNCTION edit_local_sd_order(
  uuid, text, text, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, numeric
) FROM PUBLIC;
REVOKE ALL ON FUNCTION edit_local_sd_order(
  uuid, text, text, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, numeric
) FROM anon;
REVOKE ALL ON FUNCTION edit_local_sd_order(
  uuid, text, text, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, numeric
) FROM service_role;
GRANT EXECUTE ON FUNCTION edit_local_sd_order(
  uuid, text, text, text, boolean, text, boolean, text, boolean, text, boolean, text, boolean, numeric
) TO authenticated;
-- Nunca a service_role — SECURITY INVOKER depende de auth.uid() del
-- caller; llamar esta función con el cliente de service role no tiene
-- sesión de usuario real (auth.uid() sería NULL), así que siempre
-- devolvería 'forbidden'. El endpoint SIEMPRE debe invocarla con el
-- cliente de sesión autenticada (createClient()), nunca con
-- createServiceClient().

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente después de aplicar, no automatizada)
-- ============================================================
-- BEGIN;
--   -- Como admin/dispatch_agent/confirmation_agent autenticado, sobre un
--   -- pedido SD local real (sin guía, no pagado, no entregado/devuelto),
--   -- leyendo primero los valores actuales para pasarlos como "expected":
--   SELECT customer_address, city, province FROM orders WHERE id = '<id de un pedido SD real>';
--
--   SELECT edit_local_sd_order(
--     '<mismo id>',
--     '<customer_address actual>', '<city actual>', '<province actual>',  -- expected_*
--     true, 'Nueva dirección de prueba',   -- set_customer_address, customer_address
--     false, NULL,                          -- set_city, city (sin cambio)
--     false, NULL,                          -- set_province, province (sin cambio)
--     true, 'Oferta 2x1 de prueba',        -- set_product_summary, product_summary
--     true, 2100.00                         -- set_cod_amount, cod_amount
--   );
--   -- debe devolver 'ok'; confirmar en la misma transacción:
--   SELECT customer_address, city, province, product_summary, cod_amount FROM orders WHERE id = '<mismo id>';
--   SELECT content FROM notes WHERE order_id = '<mismo id>' ORDER BY created_at DESC LIMIT 1;
--   SELECT agent_id, action_type, notes FROM agent_actions
--   WHERE order_id = '<mismo id>' AND action_type = 'note_added' ORDER BY created_at DESC LIMIT 1;
--
--   -- Conflicto — pasar un expected_customer_address distinto al real:
--   SELECT edit_local_sd_order('<mismo id>', 'dirección que ya no es la actual', '<city>', '<province>',
--     true, 'x', false, NULL, false, NULL, false, NULL, false, NULL);
--   -- debe devolver 'conflict'
-- ROLLBACK; -- para no dejar datos de prueba
--
-- -- Casos a probar manualmente antes de dar por cerrada la fase:
-- --   A. Pedido SD local elegible, rol autorizado → 'ok', UPDATE + notes + agent_actions.
-- --   B. tracking_number IS NOT NULL → 'has_tracking', cero cambios.
-- --   C. normalized_status IN (delivered,returned) → 'terminal_status', cero cambios.
-- --   D. payment_status='paid' → 'already_paid', cero cambios.
-- --   E. expected_* no coincide con el valor actual → 'conflict', cero cambios.
-- --   F. rol no autorizado (viewer, agent, etc.) → 'forbidden', cero cambios.
-- --   G. pedido de otra tienda → 'not_found'.
-- --   H. todos los set_* en false, o valores idénticos a los actuales → 'ok', cero filas nuevas en notes/agent_actions.
