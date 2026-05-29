-- Migration 029: Add 'indemnizacion' to orders.normalized_status CHECK constraint
-- Fixes DB_UPDATE_ERROR when EFI parser returns normalized_status='indemnizacion'

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_normalized_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_normalized_status_check
  CHECK (normalized_status IN (
    'pending',
    'in_transit',
    'out_for_delivery',
    'en_reparto',
    'novedad',
    'indemnizacion',
    'delivered',
    'failed_attempt',
    'returned',
    'unknown'
  ));
