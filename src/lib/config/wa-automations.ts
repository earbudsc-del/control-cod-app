// Feature flag global para automatizaciones salientes de WhatsApp (Sprint 0 —
// protección de template queue mientras el Inbox WhatsApp permanece pausado).
//
// FAIL-CLOSED por diseño: si la variable de entorno no existe, no es exactamente
// 'true', o hay cualquier ambigüedad, esto devuelve false. Un deploy que olvide
// setear la variable NUNCA reactiva automatizaciones por accidente.
//
// Aplica a los dos puntos de encolado (order_confirmation_cod, sd_location_request
// en src/app/api/webhooks/shopify/orders/route.ts) y al processor
// (src/app/api/cron/wa-template-queue/route.ts) — defensa en profundidad.
export function isWaAutomationsEnabled(): boolean {
  return process.env.WA_AUTOMATIONS_ENABLED === 'true'
}
