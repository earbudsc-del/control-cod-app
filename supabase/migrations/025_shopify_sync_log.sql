-- ============================================================
-- 025_shopify_sync_log.sql
-- Registro de sincronizaciones con Shopify (fulfillments y pagos).
-- Permite auditoría y diagnóstico sin frenar el flujo operativo.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_sync_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  shopify_order_id TEXT,
  event_type      TEXT NOT NULL
                    CHECK (event_type IN ('fulfillment', 'mark_paid')),
  result          TEXT NOT NULL
                    CHECK (result IN ('success', 'skipped', 'error')),
  error_message   TEXT,
  metadata        JSONB,
  triggered_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopify_sync_log_order    ON shopify_sync_log (order_id);
CREATE INDEX IF NOT EXISTS idx_shopify_sync_log_type     ON shopify_sync_log (event_type);
CREATE INDEX IF NOT EXISTS idx_shopify_sync_log_result   ON shopify_sync_log (result);
CREATE INDEX IF NOT EXISTS idx_shopify_sync_log_created  ON shopify_sync_log (created_at DESC);

COMMENT ON TABLE shopify_sync_log IS
  'Log de sincronizaciones app → Shopify. Usado para auditoría y re-intentos manuales.';
