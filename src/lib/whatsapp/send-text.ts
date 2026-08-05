// Envío de un mensaje de texto plano vía Meta WhatsApp Cloud API.
// Extraído como helper independiente para uso del responder de Génesis
// (FASE 7B.2) sin tocar la ruta de envío manual del agente
// (POST /api/whatsapp/conversations/[id]/messages), que mantiene su propia
// copia de esta misma llamada.
//
// FASE 1B (integración de genesis_message_runs): el resultado de fallo
// ahora incluye `kind`, para que el llamador pueda distinguir un rechazo
// inequívoco de Meta (`http_error` — mapea a failed_retryable) de una
// falla de red ambigua (`network_error` — mapea a send_unknown, nunca se
// reintenta el envío automáticamente, ver docs/GENESIS_COMMERCIAL_BRAIN_V1.md
// R1.8.3) de credenciales ausentes (`credentials_missing` — error de
// configuración, mapea a failed_terminal). Antes, los tres casos eran
// indistinguibles (`{ ok: false, error: string }`), lo que hacía imposible
// implementar send_unknown correctamente.
//
// Timeout explícito (R1.5.2, antes inexistente) vía AbortController: un
// timeout de Meta es, por definición, ambiguo — no se sabe si la solicitud
// llegó a procesarse antes de cortar la conexión — así que cae en el mismo
// `catch` que cualquier otra excepción de red y se clasifica igual como
// `network_error`, nunca como `http_error`.

export type SendWhatsAppTextResult =
  | { ok: true; wamid: string }
  | { ok: false; kind: 'credentials_missing' | 'http_error' | 'network_error'; error: string }

const META_TIMEOUT_MS = 10_000

export async function sendWhatsAppText(to: string, body: string): Promise<SendWhatsAppTextResult> {
  const WA_API_VERSION     = process.env.WA_API_VERSION
  const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID
  const WA_ACCESS_TOKEN    = process.env.WA_ACCESS_TOKEN

  if (!WA_API_VERSION || !WA_PHONE_NUMBER_ID || !WA_ACCESS_TOKEN) {
    return {
      ok: false,
      kind: 'credentials_missing',
      error: 'Credenciales de WhatsApp no configuradas (WA_API_VERSION/WA_PHONE_NUMBER_ID/WA_ACCESS_TOKEN)',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS)

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
        signal: controller.signal,
      },
    )
    clearTimeout(timer)

    if (!res.ok) {
      // Respuesta HTTP recibida e inequívoca — Meta evaluó la solicitud y
      // la rechazó. Distinto de una excepción de red (catch de abajo).
      const errText = await res.text()
      return { ok: false, kind: 'http_error', error: `Meta API error ${res.status}: ${errText}` }
    }

    const data = await res.json() as { messages?: { id: string }[] }
    const wamid = data.messages?.[0]?.id
    if (!wamid) {
      // Meta respondió 200 pero sin wamid — respuesta recibida e
      // interpretable, mismo tratamiento que un error HTTP inequívoco (no
      // es la ambigüedad de red que justifica send_unknown).
      return { ok: false, kind: 'http_error', error: 'Meta respondió OK pero no devolvió wamid' }
    }

    return { ok: true, wamid }
  } catch (err) {
    clearTimeout(timer)
    // Excepción de fetch (timeout por AbortController, conexión reiniciada,
    // etc.) — no se sabe si Meta procesó la solicitud antes de que la
    // conexión se perdiera. Nunca tratar como http_error: la ambigüedad es
    // la señal relevante.
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, kind: 'network_error', error: `Timeout tras ${META_TIMEOUT_MS}ms esperando respuesta de Meta` }
    }
    return { ok: false, kind: 'network_error', error: err instanceof Error ? err.message : String(err) }
  }
}
