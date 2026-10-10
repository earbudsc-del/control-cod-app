// Contexto de agente del Inbox para endpoints server-side (C.1 / C.1.3).
// Roles con acceso: mismo criterio que is_wa_inbox_role() (migración 030).
// store_id SIEMPRE del perfil de la sesión, nunca del browser.

import { createClient } from '@/lib/supabase/server'

export const INBOX_ROLES = new Set(['admin', 'ia_supervisor', 'confirmation_agent', 'dispatch_agent', 'novelty_agent', 'agent'])

export type InboxAuth =
  | { ok: true; userId: string; storeId: string; role: string }
  | { ok: false; status: 401 | 403; error: string }

export async function getInboxAgentContext(): Promise<InboxAuth> {
  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'No autorizado' }
  const { data: profile } = await session.from('profiles').select('role, store_id, is_active').eq('id', user.id).maybeSingle()
  if (!profile?.store_id || profile.is_active === false || !INBOX_ROLES.has(profile.role)) {
    return { ok: false, status: 403, error: 'Sin acceso al inbox' }
  }
  return { ok: true, userId: user.id, storeId: profile.store_id as string, role: profile.role as string }
}
