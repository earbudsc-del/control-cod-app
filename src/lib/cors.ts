// CORS helper para endpoints consumidos por apps externas (ej. Ruta COD).
// No usar Access-Control-Allow-Origin: * en endpoints con datos privados —
// solo se refleja el origen si coincide exactamente con la allowlist.
const ALLOWED_ORIGINS = (process.env.RUTA_COD_ALLOWED_ORIGIN ?? '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

export function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  }
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin
  }
  return headers
}
