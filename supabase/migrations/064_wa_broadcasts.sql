-- ============================================================
-- 064_wa_broadcasts.sql
-- Sprint Broadcast A — base segura. NO envía nada, NO crea filas en
-- wa_template_queue, NO toca filas existentes.
--
-- Modelo aprobado:
--   wa_broadcasts                     — un registro por broadcast (cabecera auditable)
--   wa_template_queue.broadcast_id    — nullable; agrupa los recipients de ESE broadcast
-- Sin tabla wa_broadcast_recipients: cada fila de wa_template_queue sigue
-- siendo el envío asociado a un order_id.
--
-- Qué NO se guarda (deliberado):
--   - confirmation_status / estado comercial de orders: la fuente es orders.
--   - sent/failed/skipped por broadcast: se derivan de wa_template_queue
--     (WHERE broadcast_id = X GROUP BY status) — no hay estado paralelo.
--   Solo se guardan los conteos de SELECCIÓN (candidatos/elegibles/excluidos),
--   porque no son reconstruibles después: los pedidos cambian de estado.
--
-- ORDEN DE ROLLOUT (Sprint A.1):
--   1. Aplicar esta migración (el processor actual no lee broadcast_id: no
--      se rompe nada; no existen filas de broadcast).
--   2. Desplegar el processor aislado (broadcast_id IS NULL + allowlist,
--      src/lib/wa-queue/automation-queue.ts) — requiere esta columna.
--   3. Verificar el deploy. Recién entonces Sprint B puede insertar filas.
--
-- PRE-CHECK (antes de aplicar, solo lectura):
--   SELECT template_name, count(*) FROM wa_template_queue GROUP BY 1;
--   Esperado: solo order_confirmation_cod / sd_location_request. Si apareciera
--   sd_broadcast_confirmation, el CHECK de abajo fallaría al aplicarse
--   (transacción completa revertida, sin efecto parcial).
-- ============================================================

CREATE TABLE wa_broadcasts (
  id                       UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id                 UUID        NOT NULL REFERENCES stores(id),
  template_name            TEXT        NOT NULL
                                         CHECK (template_name IN ('sd_broadcast_confirmation')),
  status                   TEXT        NOT NULL DEFAULT 'draft'
                                         CHECK (status IN ('draft', 'queued', 'processing', 'completed', 'cancelled')),
  created_by               UUID        NOT NULL REFERENCES profiles(id),

  -- Origen de la selección, auditable: filtros recibidos (fecha, etc.) tal
  -- como los aplicó el servidor. La regla en sí se identifica por versión.
  selection_filter         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  eligibility_rule_version TEXT        NOT NULL,

  -- Conteos de selección (snapshot al crear — no reconstruibles después).
  candidate_count          INTEGER     NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  eligible_count           INTEGER     NOT NULL DEFAULT 0 CHECK (eligible_count  >= 0),
  excluded_count           INTEGER     NOT NULL DEFAULT 0 CHECK (excluded_count  >= 0),
  excluded_by_reason       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CHECK (eligible_count + excluded_count = candidate_count),

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  CHECK (completed_at IS NULL OR status = 'completed'),
  CHECK (cancelled_at IS NULL OR status = 'cancelled')
);

CREATE INDEX idx_wa_broadcasts_store_created
  ON wa_broadcasts (store_id, created_at DESC);

-- A lo sumo UN broadcast en curso por tienda (evita doble lanzamiento).
CREATE UNIQUE INDEX idx_wa_broadcasts_one_running
  ON wa_broadcasts (store_id)
  WHERE status IN ('queued', 'processing');

-- ── wa_template_queue.broadcast_id ──────────────────────────────────────────
-- Nullable: las filas históricas (sent/failed/skipped, las 2,820 skipped y
-- las 3 pending pre-deploy) quedan con NULL y NO se tocan.
ALTER TABLE wa_template_queue
  ADD COLUMN broadcast_id UUID REFERENCES wa_broadcasts(id) ON DELETE RESTRICT;

-- Aislamiento por constraint: broadcast_id NOT NULL ⇔ template de broadcast.
--   - Una fila histórica (order_confirmation_cod / sd_location_request) NO
--     puede recibir broadcast_id: violaría este CHECK.
--   - Una fila sd_broadcast_confirmation NO puede existir sin broadcast_id.
-- Se valida contra las filas existentes al aplicar: todas tienen
-- broadcast_id NULL y ningún template de broadcast → pasa.
-- Flujos existentes intactos: webhook Shopify y wa-test-send solo insertan
-- order_confirmation_cod / sd_location_request sin broadcast_id → (false = false).
-- Un template de broadcast adicional en el futuro requiere ampliar este
-- CHECK explícitamente (deliberado).
ALTER TABLE wa_template_queue
  ADD CONSTRAINT wa_template_queue_broadcast_template_check
  CHECK ((broadcast_id IS NOT NULL) = (template_name = 'sd_broadcast_confirmation'));

-- broadcast_id es inmutable tras el INSERT: nunca se asigna retroactivamente
-- ni se mueve una fila de un broadcast a otro.
CREATE OR REPLACE FUNCTION wa_template_queue_broadcast_id_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.broadcast_id IS DISTINCT FROM OLD.broadcast_id THEN
    RAISE EXCEPTION 'wa_template_queue.broadcast_id es inmutable (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_wa_template_queue_broadcast_id_immutable
  BEFORE UPDATE OF broadcast_id ON wa_template_queue
  FOR EACH ROW EXECUTE FUNCTION wa_template_queue_broadcast_id_immutable();

-- Selección del futuro processor + conteos por broadcast. Parcial: las filas
-- históricas (broadcast_id NULL) no entran al índice.
CREATE INDEX idx_wa_template_queue_broadcast
  ON wa_template_queue (broadcast_id, status, scheduled_at)
  WHERE broadcast_id IS NOT NULL;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE wa_broadcasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wa_broadcasts_select" ON wa_broadcasts
  FOR SELECT USING (store_id = get_user_store_id());

-- INSERT/UPDATE/DELETE: sin política — solo service role (endpoint server-side
-- de Sprint B, que aplica la regla de elegibilidad de
-- src/lib/broadcast/sd-broadcast-eligibility.ts).

-- ============================================================
-- VERIFICACIÓN (manual, después de aplicar)
-- ============================================================
-- SELECT count(*) FROM wa_template_queue WHERE broadcast_id IS NOT NULL;
--   Esperado: 0.
-- UPDATE wa_template_queue SET broadcast_id = '<uuid broadcast>' WHERE id = '<fila histórica>';
--   Esperado: falla (check_violation) — CHECK de template y trigger de inmutabilidad.
