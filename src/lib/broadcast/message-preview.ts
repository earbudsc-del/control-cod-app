// Sprint Broadcast B — COPY DE PREVIEW del broadcast estándar SD.
//
// NO es el template aprobado por Meta: es el texto propuesto para revisión
// interna. El template real (nombre/idioma/variables aprobadas) se define en
// Sprint C. Internamente el broadcast usa template_name =
// 'sd_broadcast_confirmation'. Puro / client-safe.

export const SD_BROADCAST_PREVIEW_COPY =
  'Hola {{1}} 😊\n\n' +
  'Tenemos pendiente confirmar tu pedido de {{2}}. 📦\n\n' +
  '💵 Total: RD${{3}}\n' +
  '🚚 Envío gratis\n' +
  '💳 Pagas al recibir\n\n' +
  '¿Confirmamos tu pedido para coordinar la entrega?'

export interface PreviewVariables {
  customer_name:   string | null
  product_summary: string | null
  cod_amount:      number | string | null
}

export function formatCodAmount(v: number | string | null): string {
  const n = typeof v === 'string' ? Number(v) : v
  if (n == null || !Number.isFinite(n)) return '0'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n)
}

/** Variables del copy: {{1}} customer_name, {{2}} product_summary, {{3}} cod_amount. */
export function previewVariables(v: PreviewVariables): [string, string, string] {
  return [
    v.customer_name?.trim()   || 'Cliente',
    v.product_summary?.trim() || 'tu pedido',
    formatCodAmount(v.cod_amount),
  ]
}

export function renderBroadcastPreview(v: PreviewVariables): string {
  const [p1, p2, p3] = previewVariables(v)
  return SD_BROADCAST_PREVIEW_COPY
    // Replacer como función: el texto del cliente nunca se interpreta como
    // patrón de reemplazo ($&, $1…).
    .replace('{{1}}', () => p1)
    .replace('{{2}}', () => p2)
    .replace('{{3}}', () => p3)
}
