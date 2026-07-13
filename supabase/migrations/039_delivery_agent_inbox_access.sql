-- ============================================================
-- 039_delivery_agent_inbox_access.sql
-- Amplía is_wa_inbox_role() (migración 030) para incluir a
-- delivery_agent — ahora puede abrir conversaciones de WhatsApp
-- del Inbox directamente desde el detalle operativo de un pedido
-- en /reparto y /transito.
--
-- santo_domingo_delivery_agent queda excluido a propósito: opera
-- pedidos SD locales sin guía EFI, con su propio flujo en
-- /sd-delivery, y no participa del Inbox central.
-- ============================================================

CREATE OR REPLACE FUNCTION is_wa_inbox_role()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT get_user_role() IN (
    'admin',
    'ia_supervisor',
    'confirmation_agent',
    'dispatch_agent',
    'novelty_agent',
    'agent',
    'delivery_agent'
  )
$$;

-- ============================================================
-- VERIFICACIÓN (ejecutar manualmente para confirmar)
-- ============================================================
-- SELECT get_user_role() -- como delivery_agent, luego:
-- SELECT is_wa_inbox_role(); -- debe devolver true
