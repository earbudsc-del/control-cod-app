// Inbox WhatsApp — quién puede consultar conversaciones y de qué tienda.
//
// Mismo conjunto de roles que is_wa_inbox_role() (migraciones 030 + 039). La
// RLS ya lo exige; esta verificación hace explícitos el 403 y el store_id con
// que se filtra cada consulta (nunca viene del navegador).

interface SupabaseAuthLike {
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> }
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const INBOX_ROLES = [
  'admin', 'ia_supervisor', 'confirmation_agent', 'dispatch_agent', 'novelty_agent', 'agent', 'delivery_agent',
] as const

export type InboxAccess =
  | { ok: true; ctx: { userId: string; storeId: string } }
  | { ok: false; status: 401 | 403; error: string }

export async function getInboxAccess(supabase: SupabaseAuthLike): Promise<InboxAccess> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'No autorizado' }
  const { data: profile } = await supabase.from('profiles').select('role, store_id, is_active').eq('id', user.id).maybeSingle()
  const p = profile as { role: string; store_id: string | null; is_active: boolean | null } | null
  if (!p || p.is_active === false || !(INBOX_ROLES as readonly string[]).includes(p.role)) {
    return { ok: false, status: 403, error: 'Sin acceso al Inbox' }
  }
  if (!p.store_id) return { ok: false, status: 403, error: 'Perfil sin tienda asignada' }
  return { ok: true, ctx: { userId: user.id, storeId: p.store_id } }
}
