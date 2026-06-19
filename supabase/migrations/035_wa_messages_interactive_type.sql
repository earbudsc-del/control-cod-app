-- Fase 6B: soporte para respuestas de botón inbound (template quick-reply / interactive button_reply).
-- Amplía el CHECK de message_type para incluir los dos tipos que Meta puede usar
-- cuando el cliente presiona un botón: 'interactive' (button_reply nativo) y
-- 'button_reply' (quick-reply de un mensaje template).

ALTER TABLE wa_messages DROP CONSTRAINT IF EXISTS wa_messages_message_type_check;

ALTER TABLE wa_messages ADD CONSTRAINT wa_messages_message_type_check
  CHECK (message_type IN (
    'text','image','audio','video',
    'document','sticker','template','unknown',
    'interactive','button_reply'
  ));
