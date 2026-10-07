// Feature flag de Broadcast WhatsApp (Sprint Broadcast A).
//
// FAIL-CLOSED: solo el string exacto 'true' habilita. Ausente, vacío,
// 'TRUE', '1', etc. → false.
//
// Completamente INDEPENDIENTE de WA_AUTOMATIONS_ENABLED
// (src/lib/config/wa-automations.ts): ninguno de los dos flags implica ni
// habilita al otro. Encender Broadcast no reactiva las automatizaciones del
// webhook de Shopify, y viceversa.
//
// Hoy ningún código llama a esta función para enviar nada — no existe aún
// processor de Broadcast (Sprint C). La existencia del flag no provoca envíos.
export function isWaBroadcastEnabled(): boolean {
  return process.env.WA_BROADCAST_ENABLED === 'true'
}
