// Sprint C.1 — envío de un template vía Meta WhatsApp Cloud API (Broadcast).
//
// Mismo contrato de clasificación que send-text.ts, ampliado para la cola:
//   accepted       → Meta devolvió wamid. ACEPTADO, no entregado: la entrega
//                    y la lectura llegan después por webhook de status.
//   rate_limited   → HTTP 429 o códigos de throttling de Meta. Meta NO aceptó
//                    el mensaje: se puede reintentar más tarde.
//   server_error   → HTTP 5xx. Meta no aceptó el mensaje (respuesta recibida):
//                    reintentable con límite.
//   rejected       → otro 4xx (parámetro inválido, template, número no apto…).
//                    Permanente: no se reintenta.
//   ambiguous      → timeout / conexión cortada / 2xx sin wamid. No se sabe
//                    si Meta lo aceptó: NUNCA se reintenta automáticamente
//                    (queda send_unknown para conciliación humana).
//   not_configured → faltan credenciales. No se llamó a Meta.
//
// Nunca registra el token. El detalle de error se recorta.

export type SendTemplateResult =
  | { kind: 'accepted'; wamid: string }
  | { kind: 'rate_limited' | 'server_error' | 'rejected'; httpStatus: number; metaCode: string | null; error: string }
  | { kind: 'ambiguous'; error: string }
  | { kind: 'not_configured'; error: string }

export interface SendTemplateRequest {
  to:         string
  name:       string
  language:   string
  components: unknown[]
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>

const META_TIMEOUT_MS = 10_000
// Códigos de Meta de throttling (además de HTTP 429): 4 / 80007 (app/WABA),
// 130429 (throughput), 131056 (pair rate limit).
const RATE_LIMIT_CODES = new Set(['4', '80007', '130429', '131056'])

function trimError(s: string): string {
  return s.length > 500 ? s.slice(0, 500) + '…' : s
}

function metaCodeOf(body: string): string | null {
  try {
    const j = JSON.parse(body) as { error?: { code?: number | string } }
    return j.error?.code != null ? String(j.error.code) : null
  } catch {
    return null
  }
}

export async function sendWhatsAppTemplate(
  req: SendTemplateRequest,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<SendTemplateResult> {
  const version = env.WA_API_VERSION, phoneId = env.WA_PHONE_NUMBER_ID, token = env.WA_ACCESS_TOKEN
  if (!version || !phoneId || !token) {
    return { kind: 'not_configured', error: 'Credenciales de WhatsApp no configuradas' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: req.to,
        type: 'template',
        template: { name: req.name, language: { code: req.language }, components: req.components },
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    const text = await res.text()
    if (res.ok) {
      let wamid: string | undefined
      try { wamid = (JSON.parse(text) as { messages?: { id?: string }[] }).messages?.[0]?.id } catch { /* noop */ }
      // 2xx sin wamid: Meta respondió pero no sabemos si encoló el mensaje.
      return wamid ? { kind: 'accepted', wamid } : { kind: 'ambiguous', error: 'Meta respondió 2xx sin wamid' }
    }

    const metaCode = metaCodeOf(text)
    const error = trimError(`Meta API error ${res.status}: ${text}`)
    if (res.status === 429 || (metaCode && RATE_LIMIT_CODES.has(metaCode))) {
      return { kind: 'rate_limited', httpStatus: res.status, metaCode, error }
    }
    if (res.status >= 500) return { kind: 'server_error', httpStatus: res.status, metaCode, error }
    return { kind: 'rejected', httpStatus: res.status, metaCode, error }
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error && err.name === 'AbortError'
      ? `Timeout tras ${META_TIMEOUT_MS}ms esperando a Meta`
      : (err instanceof Error ? err.message : String(err))
    return { kind: 'ambiguous', error: trimError(msg) }
  }
}
