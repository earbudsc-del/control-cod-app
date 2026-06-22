// Responder automático de Génesis — FASE 7B.2 (prueba controlada, número
// todavía no abierto a clientes reales).
//
// Se invoca desde el webhook de WhatsApp después de guardar un mensaje
// inbound. Nunca debe lanzar — todo error se loguea y se ignora para no
// romper el webhook (Meta espera 200 en <5s).
//
// Condiciones para responder (todas deben cumplirse):
//   - ai_agent_config.is_active = true
//   - ai_agent_config.mode = 'auto'
//   - wa_conversations.ai_enabled = true
//   - wa_conversations.assigned_to IS NULL
//   - provider = 'openai' (gemini queda como TODO controlado)
//   - api_key_ref configurado y la env var correspondiente existe
//
// Guardrails de esta fase:
//   - No cambia normalized_status/confirmation_status de ningún pedido.
//   - No confirma ni cancela pedidos — esa lógica sigue siendo exclusiva
//     de los botones de template (applyConfirmationAction), sin tocar.
//   - No reintenta ni encola — si OpenAI o Meta fallan, se loguea y se sale.

import { createServiceClient } from '@/lib/supabase/server'
import { sendWhatsAppText } from '@/lib/whatsapp/send-text'

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>

const HISTORY_LIMIT = 20
const MAX_TOKENS     = 300

interface KnowledgeSectionRow {
  label:   string
  content: string | null
}

interface HistoryRow {
  direction:    'inbound' | 'outbound'
  body:         string | null
  message_type: string
  sent_at:      string | null
}

function buildSystemPrompt(
  agentName:     string,
  systemPrompt:  string | null,
  sections:      KnowledgeSectionRow[],
): string {
  const parts: string[] = []

  parts.push(
    systemPrompt?.trim() ||
    `Eres ${agentName || 'Génesis'}, un asistente de atención al cliente por WhatsApp para una ` +
    'tienda de e-commerce con pago contra entrega (COD) en República Dominicana. Responde de ' +
    'forma breve, natural, cordial y útil. No inventes información que no esté en la base de ' +
    'conocimiento provista.',
  )

  const active = sections.filter(s => s.content?.trim())
  if (active.length > 0) {
    parts.push('--- Base de conocimiento ---')
    for (const s of active) parts.push(`## ${s.label}\n${s.content}`)
  }

  parts.push(
    '--- Instrucciones de respuesta ---\n' +
    'Responde siempre en español, de forma breve (máximo 2-3 frases), natural y directa, sin ' +
    'markdown ni listas. No confirmes ni canceles pedidos por tu cuenta — esa acción la gestiona ' +
    'el sistema automáticamente cuando el cliente pulsa los botones del mensaje de confirmación. ' +
    'Si no sabes la respuesta o el cliente pide algo que requiere intervención humana, dilo con ' +
    'naturalidad y ofrece que un agente lo va a atender.',
  )

  return parts.join('\n\n')
}

async function callOpenAI(
  apiKey:   string,
  model:    string,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
): Promise<string | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens:  MAX_TOKENS,
        temperature: 0.6,
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('[genesis] OpenAI error', res.status, errText)
      return null
    }

    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const text = data.choices?.[0]?.message?.content?.trim()
    return text || null
  } catch (err) {
    console.error('[genesis] OpenAI fetch threw', err)
    return null
  }
}

// Punto de entrada. Recibe el cliente de servicio ya creado por el webhook
// (evita crear una segunda conexión) y el id de la conversación recién
// actualizada con el mensaje inbound.
export async function maybeGenesisRespond(
  supabase:       ServiceClient,
  storeId:        string,
  conversationId: string,
): Promise<void> {
  try {
    console.log('[genesis] inicio — conversationId:', conversationId, '| storeId:', storeId)

    const { data: conv } = await supabase
      .from('wa_conversations')
      .select('id, assigned_to, ai_enabled, contact:wa_contacts(wa_id, phone_normalized)')
      .eq('id', conversationId)
      .maybeSingle()

    if (!conv) {
      console.log('[genesis] abortado — conversación no encontrada:', conversationId)
      return
    }
    if (conv.assigned_to) {
      console.log('[genesis] abortado — assigned_to presente:', conv.assigned_to, '| conv:', conversationId)
      return
    }
    if (!conv.ai_enabled) {
      console.log('[genesis] abortado — ai_enabled=false | conv:', conversationId)
      return
    }

    const { data: config } = await supabase
      .from('ai_agent_config')
      .select('agent_name, provider, model, api_key_ref, system_prompt, mode, is_active')
      .eq('store_id', storeId)
      .maybeSingle()

    if (!config) {
      console.log('[genesis] abortado — ai_agent_config no encontrada para store:', storeId)
      return
    }
    if (!config.is_active) {
      console.log('[genesis] abortado — is_active=false | store:', storeId)
      return
    }
    if (config.mode !== 'auto') {
      console.log('[genesis] abortado — mode!=auto (mode actual:', config.mode, ') | store:', storeId)
      return
    }

    if (config.provider !== 'openai') {
      if (config.provider === 'gemini') {
        console.warn('[genesis] provider=gemini configurado pero no implementado todavía — sin respuesta')
      } else {
        console.log('[genesis] abortado — provider no soportado:', config.provider)
      }
      return
    }

    if (!config.api_key_ref) {
      console.error('[genesis] abortado — api_key_ref no configurado | store:', storeId)
      return
    }
    const apiKey = process.env[config.api_key_ref]
    if (!apiKey) {
      console.error('[genesis] abortado — env var', config.api_key_ref, 'no definida en este entorno | store:', storeId)
      return
    }

    type ContactRel = { wa_id: string | null; phone_normalized: string | null }
    const contactRaw = conv.contact as ContactRel | ContactRel[] | null
    const contact = Array.isArray(contactRaw) ? contactRaw[0] : contactRaw
    const waId = contact?.wa_id ?? contact?.phone_normalized
    if (!waId) {
      console.error('[genesis] conversación sin wa_id ni teléfono — sin respuesta', conversationId)
      return
    }

    const { data: sections } = await supabase
      .from('ai_agent_knowledge_sections')
      .select('label, content')
      .eq('store_id', storeId)
      .eq('is_active', true)
      .order('priority', { ascending: false })

    const { data: historyRows } = await supabase
      .from('wa_messages')
      .select('direction, body, message_type, sent_at')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: false })
      .limit(HISTORY_LIMIT)

    const history = ((historyRows ?? []) as HistoryRow[])
      .slice()
      .reverse()
      .filter(m => m.body?.trim())

    const systemPrompt = buildSystemPrompt(
      config.agent_name,
      config.system_prompt,
      (sections ?? []) as KnowledgeSectionRow[],
    )

    const chatMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({
        role:    (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.body as string,
      })),
    ]

    const model = config.model?.trim() || 'gpt-4o-mini'
    console.log('[genesis] llamando a OpenAI — model:', model, '| historial:', history.length, 'mensajes | conv:', conversationId)
    const replyText = await callOpenAI(apiKey, model, chatMessages)
    if (!replyText) {
      console.log('[genesis] abortado — OpenAI no devolvió texto utilizable | conv:', conversationId)
      return
    }

    console.log('[genesis] enviando respuesta vía Meta — conv:', conversationId, '| waId:', waId)
    const sendResult = await sendWhatsAppText(waId, replyText)
    if (!sendResult.ok) {
      console.error('[genesis] error enviando respuesta vía Meta:', sendResult.error, '| conv:', conversationId)
      return
    }

    const sentAt = new Date().toISOString()
    const preview = replyText.length > 150 ? replyText.slice(0, 150) + '…' : replyText

    await supabase.from('wa_messages').insert({
      store_id:        storeId,
      conversation_id: conversationId,
      wa_msg_id:       sendResult.wamid,
      direction:       'outbound',
      message_type:    'text',
      body:            replyText,
      status:          'sent',
      sent_at:         sentAt,
      metadata: {
        generated_by: 'genesis',
        provider:     config.provider,
        model,
      },
    })

    await supabase
      .from('wa_conversations')
      .update({ last_message_at: sentAt, last_message_preview: preview })
      .eq('id', conversationId)

    console.log('[genesis] ✓ respuesta automática enviada — conv:', conversationId)
  } catch (err) {
    console.error('[genesis] error inesperado en maybeGenesisRespond:', err)
  }
}
