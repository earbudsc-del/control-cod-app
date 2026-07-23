// CORS helper para endpoints consumidos por apps externas (ej. Ruta COD).
// No usar Access-Control-Allow-Origin: * en endpoints con datos privados —
// solo se refleja el origen si coincide exactamente con la allowlist.
const ALLOWED_ORIGINS = (process.env.RUTA_COD_ALLOWED_ORIGIN ?? '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

export function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    // GET (lecturas) + POST (acciones/mensajes/rutas) + OPTIONS (preflight) —
    // son los únicos métodos que implementa la API v1 (verificado en los 10
    // endpoints). Sin POST aquí, cualquier llamada real desde el navegador de
    // Ruta COD (Vite, origen en la allowlist) fallaba en el preflight aunque
    // el servidor la hubiera aceptado.
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  }
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin
  }
  return headers
}
