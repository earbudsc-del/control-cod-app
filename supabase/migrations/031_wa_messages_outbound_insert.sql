-- Política RLS para INSERT de mensajes salientes desde la UI del inbox.
-- El webhook usa service role (bypassa RLS) — esta política es exclusiva para agentes.
-- Restricciones:
--   1. Solo roles con acceso al inbox (is_wa_inbox_role)
--   2. store_id debe coincidir con la tienda del usuario
--   3. Solo direction='outbound' — bloquea inserción de inbound desde UI
--   4. conversation_id debe pertenecer a una conversación de la misma tienda

CREATE POLICY "wa_messages_outbound_insert_agents"
  ON wa_messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_wa_inbox_role()
    AND store_id = get_user_store_id()
    AND direction = 'outbound'
    AND EXISTS (
      SELECT 1 FROM wa_conversations
      WHERE wa_conversations.id  = conversation_id
        AND wa_conversations.store_id = get_user_store_id()
    )
  );
