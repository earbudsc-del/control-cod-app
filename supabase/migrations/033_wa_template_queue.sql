-- 033_wa_template_queue.sql
-- Cola de envío diferido de templates WhatsApp.
-- FASE 6A: confirmación automática de pedidos Shopify.
--
-- Flujo: orders/create webhook → INSERT job (pending, scheduled_at = +5 min)
-- Cron /api/cron/wa-template-queue → procesa jobs vencidos:
--   si el cliente ya escribió → skipped (skip_reason='client_already_wrote')
--   si no escribió → envía template via Meta API → sent

CREATE TABLE wa_template_queue (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id       UUID        NOT NULL REFERENCES stores(id),
  order_id       UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  template_name  TEXT        NOT NULL,
  -- Sin DEFAULT: cada job debe indicar el template explícitamente.
  -- Preparado para múltiples templates futuros.
  phone_normalized TEXT      NOT NULL,
  -- Teléfono del cliente ya normalizado (solo dígitos). Se almacena junto al
  -- job para evitar JOIN adicional contra orders durante el procesamiento del cron.
  scheduled_at   TIMESTAMPTZ NOT NULL,
  processed_at   TIMESTAMPTZ,
  status         TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN (
                                 'pending',
                                 'processing',
                                 'sent',
                                 'skipped',
                                 'failed'
                               )),
  skip_reason    TEXT,
  -- Razones conocidas: 'client_already_wrote' | 'no_phone'
  wa_message_id  TEXT,
  -- wamid.XXX devuelto por Meta al enviar exitosamente
  error_message  TEXT,
  attempt_count  INTEGER     NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, template_name)
  -- Un job por (pedido, template). Absorbe reintentos del webhook:
  -- INSERT ... ON CONFLICT (order_id, template_name) DO NOTHING.
);

-- Índice parcial sobre pending + scheduled_at.
-- El cron consulta: WHERE status='pending' AND scheduled_at <= now()
-- Las filas en otros estados no participan en el índice.
CREATE INDEX idx_wa_template_queue_pending
  ON wa_template_queue (scheduled_at)
  WHERE status = 'pending';
