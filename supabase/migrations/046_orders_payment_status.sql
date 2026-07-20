-- ============================================================
-- 046_orders_payment_status.sql
-- Estado financiero independiente del estado logístico. orders.normalized_status
-- sigue siendo la única fuente de verdad del estado de ENTREGA (sin cambios).
-- payment_status es la nueva fuente de verdad del estado de PAGO.
--
-- ENUM (no TEXT+CHECK) por pedido explícito: debe poder crecer a futuro
-- (ej. 'refunded', 'partially_paid') con ALTER TYPE ... ADD VALUE, sin tener
-- que reescribir un CHECK constraint cada vez.
--
-- delivered_at / delivered_by NO se crean aquí — se reutiliza agent_actions
-- (action_type='delivered', agent_id + created_at de la fila más reciente),
-- que ya captura "quién y cuándo entregó" para pedidos SD (mark-delivered.ts
-- inserta esa fila en todos los flujos existentes). Ver análisis en sesión.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE payment_status_type AS ENUM ('pending', 'paid');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_status payment_status_type NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_by        UUID REFERENCES profiles(id);

CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders (payment_status);

-- Backfill: pedidos que ya fueron marcados pagados en Shopify por el flujo
-- histórico (auto-pago de /sd-delivery al entregar, o la acción 'paid' de
-- Ruta COD) tienen una fila success/skipped en shopify_sync_log aunque orders
-- nunca haya tenido un campo local para reflejarlo. Se refleja ahora aquí
-- para no perder ese historial ni volver a llamar a Shopify por pedidos ya
-- pagados.
UPDATE orders o
SET payment_status = 'paid',
    paid_at         = ssl.created_at,
    paid_by          = ssl.triggered_by
FROM (
  SELECT DISTINCT ON (order_id) order_id, created_at, triggered_by
  FROM shopify_sync_log
  WHERE event_type = 'mark_paid' AND result IN ('success', 'skipped')
  ORDER BY order_id, created_at ASC
) ssl
WHERE o.id = ssl.order_id
  AND o.payment_status = 'pending';

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente para confirmar)
-- ============================================================
-- SELECT payment_status, paid_at, paid_by FROM orders LIMIT 1;
-- SELECT count(*) FROM orders WHERE payment_status = 'paid';
