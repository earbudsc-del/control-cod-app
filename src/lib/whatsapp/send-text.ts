// Envío de un mensaje de texto plano vía Meta WhatsApp Cloud API.
// Extraído como helper independiente para uso del responder de Génesis
// (FASE 7B.2) sin tocar la ruta de envío manual del agente
// (POST /api/whatsapp/conversations/[id]/messages), que mantiene su propia
// copia de esta misma llamada.

export type SendWhatsAppTextResult =
  | { ok: true; wamid: string }
  | { ok: false; error: string }

export async function sendWhatsAppText(to: string, body: string): Promise<SendWhatsAppTextResult> {
  const WA_API_VERSION     = process.env.WA_API_VERSION
  const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID
  const WA_ACCESS_TOKEN    = process.env.WA_ACCESS_TOKEN

  if (!WA_API_VERSION || !WA_PHONE_NUMBER_ID || !WA_ACCESS_TOKEN) {
    return { ok: false, error: 'Credenciales de WhatsApp no configuradas (WA_API_VERSION/WA_PHONE_NUMBER_ID/WA_ACCESS_TOKEN)' }
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body },
        }),
      },
    )

    if (!res.ok) {
      const errText = await res.text()
      return { ok: false, error: `Meta API error ${res.status}: ${errText}` }
    }

    const data = await res.json() as { messages?: { id: string }[] }
    const wamid = data.messages?.[0]?.id
    if (!wamid) return { ok: false, error: 'Meta respondió OK pero no devolvió wamid' }

    return { ok: true, wamid }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
