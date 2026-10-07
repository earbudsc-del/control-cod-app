// Sprint Broadcast B — contexto admin para endpoints de Broadcast.
// Mismo patrón que el resto de /api/admin/*: sesión → profiles.role === 'admin'.
// store_id SIEMPRE se deriva del perfil de la sesión, nunca del browser.

import type { BroadcastAdminContext } from './broadcast-service'

interface SessionClientLike {
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> }
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type AdminContextResult =
  | { ok: true;  ctx: BroadcastAdminContext }
  | { ok: false; status: 401 | 403; error: string }

export async function getBroadcastAdminContext(session: SessionClientLike): Promise<AdminContextResult> {
  const { data: { user } } = await session.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'No autorizado' }

  const { data: profile } = await session
    .from('profiles').select('role, store_id, is_active').eq('id', user.id).maybeSingle()

  if (profile?.role !== 'admin' || profile?.is_active === false) {
    return { ok: false, status: 403, error: 'Solo admins pueden preparar broadcasts' }
  }
  if (!profile.store_id) return { ok: false, status: 403, error: 'Perfil sin tienda asignada' }

  return { ok: true, ctx: { userId: user.id, storeId: profile.store_id as string } }
}
