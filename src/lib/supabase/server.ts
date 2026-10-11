import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Server component — cookies read-only, ignorar
          }
        },
      },
    },
  )
}

export async function createServiceClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll() {},
      },
    },
  )
}

/**
 * Cliente service role REAL: sin cookies ni sesión, así que PostgREST recibe la
 * service key en Authorization y omite RLS.
 *
 * createServiceClient() (arriba) lee la sesión de las cookies: si hay un usuario
 * conectado, supabase-js envía SU JWT (access_token ?? key) y las consultas corren
 * con el RLS de ese usuario.
 *
 * Usar SOLO en rutas que ya validaron permisos con el cliente de sesión y que
 * filtran siempre por el store_id del perfil. Falla si falta la clave (nunca cae a anon).
 */
export function createPrivilegedServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service role no configurado')
  return createSupabaseJsClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}
