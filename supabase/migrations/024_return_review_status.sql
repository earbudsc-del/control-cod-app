-- Migración 024: Campo return_review_status en orders para módulo Devoluciones
-- Permite rastrear el estado de revisión operativa de pedidos devueltos

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS return_review_status text DEFAULT NULL;

-- Valores esperados: pendiente_revision | revisado | escalado |
--                   reclamo_preparado | reclamado | descartado

COMMENT ON COLUMN orders.return_review_status IS
  'Estado de revisión operativa para devoluciones: pendiente_revision, revisado, escalado, reclamo_preparado, reclamado, descartado';

CREATE INDEX IF NOT EXISTS idx_orders_return_review_status
  ON orders(return_review_status)
  WHERE normalized_status = 'returned';
