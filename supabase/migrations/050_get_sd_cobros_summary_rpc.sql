-- ============================================================
-- 050_get_sd_cobros_summary_rpc.sql
--
-- RPC de agregación real (COUNT + SUM en Postgres) para el resumen de
-- "Confirmados → SD · Cobros": pendientes por cobrar / pagados hoy /
-- pagados este mes. Reemplaza el enfoque anterior de sumar en Node sobre
-- filas descargadas con un límite artificial (5000) — este RPC no impone
-- ningún límite de filas para el COUNT/SUM.
--
-- ── Por qué recibe arrays de IDs en vez de reclasificar por SQL ──────────
-- La detección de "¿este pedido es de Santo Domingo?" vive exclusivamente
-- en isSantoDomingoOrder() (src/lib/alert-helpers.ts), que además de una
-- lista de ~50 términos de zona (src/lib/sd-zones.ts, SD_COVERAGE_TERMS)
-- tiene una rama de desambiguación por provincia agregada el 2026-07-28
-- después de un bug real en producción: términos de sector como "Villa
-- Hermosa" (barrio real de SD Este) coinciden por nombre con localidades de
-- OTRAS provincias (Villa Hermosa, La Romana) — pedidos #10798/#10800
-- quedaron mal clasificados como SD por esa ambigüedad antes del fix.
--
-- Portar esa lógica a SQL exigiría, para no debilitarla:
--   (a) duplicar la lista de ~50 términos de sd-zones.ts en esta migración
--       — violando el comentario explícito de ese archivo ("Fuente ÚNICA de
--       cobertura... no debe existir una segunda lista en ningún otro
--       archivo"), con riesgo real de que ambas copias diverjan (la lista SÍ
--       cambia — ver historial de sd-zones.ts); o
--   (b) re-implementar en SQL la rama condicional de desambiguación por
--       provincia — una segunda implementación de una regla de negocio que
--       ya demostró ser delicada (el bug de Villa Hermosa/La Romana), con
--       el mismo riesgo de que TS y SQL diverjan silenciosamente en el
--       siguiente ajuste de esa función.
-- Ninguna de las dos es segura sin aprobación explícita para asumir ese
-- riesgo, y no existe hoy una columna persistida que clasifique "es SD"
-- (ver nota en CLAUDE.md: "workflow_owner/delivery_type" quedó documentado
-- como dirección futura, NO implementada). Por eso este RPC NO reclasifica
-- nada — solo agrega (COUNT/SUM) sobre un conjunto de IDs que la aplicación
-- ya clasificó en TypeScript con la función única de verdad, usando
-- paginación completa sin límite artificial (ver handleSdCobrosSummary en
-- src/app/api/confirmados/route.ts). El WHERE de abajo repite el filtro
-- base (tracking_number/normalized_status/archived_at/is_test) como
-- doble-guarda defensiva — mismo patrón ya usado en handleSdCobros — pero
-- la pertenencia geográfica SD nunca se recalcula aquí.
--
-- ── Zona horaria ──────────────────────────────────────────────────────────
-- p_today_start / p_month_start se calculan en el caller (rdDayBounds() /
-- rdMonthStartISO() en confirmados/route.ts, America/Santo_Domingo) y se
-- pasan ya resueltos a UTC — el RPC no vuelve a calcular límites de fecha,
-- evitando una tercera implementación de la lógica de zona horaria RD.
-- ============================================================

-- SECURITY INVOKER (explícito, no por omisión) — a propósito: el resto de
-- este endpoint (handleSdCobros, fetchSdCandidateIds) usa el cliente
-- Supabase de sesión (createClient(), no createServiceClient()), es decir
-- corre bajo RLS del usuario autenticado. Un SECURITY DEFINER aquí
-- rompería esa consistencia — el RPC vería filas que el usuario no debería
-- poder ver vía RLS. search_path fijado explícitamente (defensa en
-- profundidad estándar de Postgres para funciones con nombres de tabla sin
-- calificar, aunque el riesgo real de search_path hijacking es bajo en
-- SECURITY INVOKER — no hay escalación de privilegios posible aquí).
--
-- COUNT(*) se castea a integer (no bigint): los conteos de este resumen
-- jamás se acercan al rango de bigint, e integer serializa siempre como
-- número JSON sin ambigüedad en PostgREST — evita cualquier duda sobre el
-- contrato { count: number } que espera el frontend.
CREATE OR REPLACE FUNCTION get_sd_cobros_summary(
  p_pending_ids uuid[],
  p_paid_ids    uuid[],
  p_today_start timestamptz,
  p_month_start timestamptz
)
RETURNS TABLE (
  pending_count     integer,
  pending_amount    numeric,
  paid_today_count  integer,
  paid_today_amount numeric,
  paid_month_count  integer,
  paid_month_amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    COUNT(*) FILTER (WHERE payment_status = 'pending')::integer
      AS pending_count,
    COALESCE(SUM(cod_amount) FILTER (WHERE payment_status = 'pending'), 0)
      AS pending_amount,
    COUNT(*) FILTER (WHERE payment_status = 'paid' AND paid_at >= p_today_start)::integer
      AS paid_today_count,
    COALESCE(SUM(cod_amount) FILTER (WHERE payment_status = 'paid' AND paid_at >= p_today_start), 0)
      AS paid_today_amount,
    COUNT(*) FILTER (WHERE payment_status = 'paid' AND paid_at >= p_month_start)::integer
      AS paid_month_count,
    COALESCE(SUM(cod_amount) FILTER (WHERE payment_status = 'paid' AND paid_at >= p_month_start), 0)
      AS paid_month_amount
  FROM orders
  WHERE (id = ANY(p_pending_ids) OR id = ANY(p_paid_ids))
    AND tracking_number IS NULL
    AND normalized_status IN ('en_reparto', 'delivered')
    AND archived_at IS NULL
    AND is_test = false
    -- get_user_role() ya existe (002_rls.sql, SECURITY DEFINER STABLE,
    -- reutilizado tal cual — mismo helper que usan las policies de orders).
    -- Necesario porque GRANT EXECUTE ... TO authenticated + RLS de orders
    -- (orders_select: store_id = get_user_store_id(), SIN filtro de rol)
    -- por sí solos permitirían que cualquier rol autenticado del mismo
    -- store llame este RPC directo por el SDK de Supabase, sin pasar por
    -- el gate admin/dispatch_agent de GET /api/confirmados. Un rol no
    -- autorizado obtiene 0 en todos los campos (agregado sobre cero filas),
    -- no un error — no hay fuga de datos, solo un resultado vacío.
    AND get_user_role() IN ('admin', 'dispatch_agent');
$$;

COMMENT ON FUNCTION get_sd_cobros_summary IS
  'Agregación COUNT/SUM real para las tarjetas de resumen de SD · Cobros. Recibe IDs ya clasificados como Santo Domingo por isSantoDomingoOrder() en TypeScript — no reclasifica geografía en SQL (ver comentario de la migración 050).';

-- Cualquier usuario autenticado puede ejecutar el RPC (la propia query ya
-- respeta el WHERE explícito arriba); la autorización de "quién puede ver
-- SD · Cobros" se mantiene en el endpoint Next.js (GET /api/confirmados),
-- igual que el resto de las consultas de esa ruta.
GRANT EXECUTE ON FUNCTION get_sd_cobros_summary TO authenticated;

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente después de aplicar)
-- ============================================================
-- SELECT * FROM get_sd_cobros_summary(
--   ARRAY[]::uuid[], ARRAY[]::uuid[], now(), now()
-- );
-- -- Debe devolver una fila con todos los campos en 0, sin error.
