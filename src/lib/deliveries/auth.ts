import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'

// Autenticación compartida por bearer token para /api/v1/deliveries/** — el
// mismo patrón usado en orders/route.ts y orders/[id]/actions/route.ts,
// factorizado para los nuevos endpoints de conversaciones (Sprint 3A).
// Ruta COD nunca recibe service_role ni tokens de Meta/Shopify — solo habla
// con estos endpoints, que hacen el trabajo pesado del lado del servidor.

export const ALLOWED_DELIVERY_ROLES = ['admin', 'santo_domingo_delivery_agent']

export function getBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : null
}

export interface AuthedDeliveryUser {
  userId: string
  profile: { id: string; role: string; store_id: string }
}

// Devuelve null si el token es inválido, el usuario no existe, o el rol no
// está en ALLOWED_DELIVERY_ROLES — el llamador decide qué status HTTP usar
// (401 vs 403) según cuál de esos casos aplique.
export async function authenticateDeliveryRequest(
  token: string,
): Promise<{ kind: 'unauthorized' } | { kind: 'forbidden' } | { kind: 'ok'; user: AuthedDeliveryUser }> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  const userClient = createSupabaseJsClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: { user }, error: userError } = await userClient.auth.getUser(token)
  if (userError || !user) return { kind: 'unauthorized' }

  const { data: profile, error: profileError } = await userClient
    .from('profiles')
    .select('id, role, store_id')
    .eq('id', user.id)
    .single()

  if (profileError || !profile || !ALLOWED_DELIVERY_ROLES.includes(profile.role)) {
    return { kind: 'forbidden' }
  }

  return { kind: 'ok', user: { userId: user.id, profile } }
}
