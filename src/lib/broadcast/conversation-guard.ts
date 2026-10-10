// Sprint C.1.2 — conversaciones originadas por Broadcast quedan bajo atención humana.
//
// Una conversación es "de Broadcast" si contiene un template saliente de una
// campaña (wa_messages.metadata.broadcast_id). Para ellas:
//   - el processor fija ai_enabled=false al enviar el template;
//   - liberar la conversación (release) NO vuelve a poner ai_enabled=true.
// Conversaciones normales: comportamiento existente sin cambios (release →
// ai_enabled=true). Génesis además sigue bloqueado por GENESIS_ENABLED.
//
// Fail-safe: si la consulta falla, se trata como de Broadcast (no se
// reactiva la IA por un error de lectura).

interface SupabaseLike {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function isBroadcastConversation(db: SupabaseLike, conversationId: string): Promise<boolean> {
  const { data, error } = await db.from('wa_messages').select('id')
    .eq('conversation_id', conversationId).eq('direction', 'outbound').eq('message_type', 'template')
    .not('metadata->>broadcast_id', 'is', null).limit(1)
  if (error) return true
  return Array.isArray(data) && data.length > 0
}

/** ai_enabled resultante al liberar una conversación. */
export async function aiEnabledAfterRelease(db: SupabaseLike, conversationId: string): Promise<boolean> {
  return !(await isBroadcastConversation(db, conversationId))
}

/**
 * ai_enabled resultante de una asignación explícita (endpoint assign).
 * Conversación de Broadcast → siempre false, aunque se pida true.
 * Conversación normal → exactamente lo solicitado (comportamiento previo).
 * Si se pide false no hace falta consultar nada.
 */
export async function aiEnabledForAssignment(db: SupabaseLike, conversationId: string, requested: boolean): Promise<boolean> {
  if (!requested) return false
  return !(await isBroadcastConversation(db, conversationId))
}
