-- ============================================================
-- 037_novelty_type_delivery_resolution.sql
-- Motor de Novedades — Fase 1 (migración aditiva)
--
-- Clasificación comunicacional (novelty_type) y resolución operativa
-- (delivery_resolution) del flujo EFI/Gintracom en /novedad.
--
-- Diagnóstico y decisiones aprobadas por el usuario (2026-07-11):
--   novelty_type representa la condición comunicacional del intento
--   fallido más reciente reportado por la transportadora, NO el motivo
--   logístico ni la gestión interna del agente. Se recalcula por evento
--   (nuevo intento de la transportadora), nunca por acciones internas.
--
-- Esta migración es puramente aditiva:
--   - No modifica follow_up_result, normalized_status ni last_action_at.
--   - No agrega defaults que afecten pedidos fuera del flujo de novedad.
--   - El backfill solo toca pedidos con normalized_status='novedad' y
--     únicamente para fijar delivery_resolution='pending' (estructural,
--     sin clasificación de negocio embebida en SQL — la clasificación
--     automática de novelty_type se hace en Fase 2 con la función real
--     classifyNovelty(), para no duplicar lógica entre SQL y TypeScript).
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS novelty_type        text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS delivery_resolution text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS rescheduled_date     date DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS rescheduled_note     text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_escalation_at   timestamptz DEFAULT NULL;

-- ── Constraints seguros (NULL siempre permitido — no fuerza clasificación) ──

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_novelty_type_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_novelty_type_check
  CHECK (novelty_type IS NULL OR novelty_type IN ('no_contact', 'contacted'));

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_delivery_resolution_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_delivery_resolution_check
  CHECK (delivery_resolution IS NULL OR delivery_resolution IN (
    'pending', 'rescheduled', 'delivered', 'returned'
  ));

-- ── Documentación de columnas ────────────────────────────────────────────────

COMMENT ON COLUMN orders.novelty_type IS
  'Clasificación comunicacional del evento de novedad más reciente reportado '
  'por la transportadora (no del motivo logístico). no_contact = no existió '
  'comunicación efectiva. contacted = sí existió comunicación, la entrega no '
  'se completó. NULL = ambiguo, pendiente de confirmación manual del agente '
  '(ver src/lib/novedad/classify.ts, Fase 2). Se recalcula únicamente cuando '
  'llega un nuevo evento de la transportadora, nunca por gestión interna del '
  'agente.';

COMMENT ON COLUMN orders.delivery_resolution IS
  'Resolución operativa del caso de novedad, eje independiente de '
  'novelty_type: pending | rescheduled | delivered | returned. rescheduled '
  'solo es válido con rescheduled_date presente (acuerdo real de fecha). '
  'delivered/returned se sincronizan automáticamente desde el tracking '
  '(mismo mecanismo que normalized_status) — el agente nunca los escribe '
  'directamente. Un nuevo intento fallido de la transportadora reabre el '
  'caso a pending sin borrar rescheduled_date/rescheduled_note (quedan como '
  'contexto de "último acuerdo incumplido").';

COMMENT ON COLUMN orders.rescheduled_date IS
  'Fecha concreta acordada con el cliente para el próximo intento de '
  'entrega. Obligatoria para que delivery_resolution pueda ser rescheduled. '
  'Se conserva aunque el caso se reabra tras un nuevo intento fallido.';

COMMENT ON COLUMN orders.rescheduled_note IS
  'Detalle operativo libre de la reprogramación (ej. "después de las 5", '
  '"llamar antes de ir", "entregar en el trabajo"). Opcional, sin estructura.';

COMMENT ON COLUMN orders.last_escalation_at IS
  'Fecha del último escalamiento auditado del caso de novedad '
  '(action_type=escalated, Fase 4). NULL = nunca escalado.';

-- ── Índices para las vistas del agente (Fase 3) ──────────────────────────────

CREATE INDEX IF NOT EXISTS idx_orders_novelty_type
  ON orders(novelty_type)
  WHERE normalized_status = 'novedad';

CREATE INDEX IF NOT EXISTS idx_orders_delivery_resolution
  ON orders(delivery_resolution)
  WHERE normalized_status = 'novedad';

-- ── Backfill idempotente ──────────────────────────────────────────────────────
-- Solo pedidos ACTIVOS en normalized_status='novedad' reciben
-- delivery_resolution='pending' como punto de partida estructural.
-- novelty_type queda NULL para todos — la clasificación real se hace en
-- Fase 2 con classifyNovelty() sobre last_attempt_reason, no aquí.
-- El filtro "delivery_resolution IS NULL" hace que correr esta migración
-- dos veces no tenga efecto adicional.

UPDATE orders
SET delivery_resolution = 'pending'
WHERE normalized_status = 'novedad'
  AND delivery_resolution IS NULL;
