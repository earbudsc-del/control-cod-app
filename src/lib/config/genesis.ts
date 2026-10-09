// Kill switch global de Génesis (Sprint G2.0 — control de activación).
//
// FAIL-CLOSED: solo el string exacto 'true' habilita. Ausente, vacío,
// 'false', 'TRUE', '1', etc. → false.
//
// Completamente INDEPENDIENTE de WA_AUTOMATIONS_ENABLED
// (src/lib/config/wa-automations.ts) y de WA_BROADCAST_ENABLED
// (src/lib/config/wa-broadcast.ts): ninguno implica ni habilita a otro.
//
// Es condición NECESARIA, no suficiente: con el flag en 'true', Génesis
// todavía requiere ai_agent_config.is_active=true (y mode='auto') de la
// tienda — verificado atómicamente por claim_genesis_run() y de nuevo
// justo antes del envío por Meta (ver respond.ts, maybeGenesisRespond).
//
// Solo gobierna la respuesta automática del webhook de WhatsApp. El
// simulador aislado (/api/admin/genesis-simulator) no lo consulta.
export function isGenesisEnabled(): boolean {
  return process.env.GENESIS_ENABLED === 'true'
}
