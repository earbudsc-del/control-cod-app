import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

// Endpoint temporal de diagnóstico — NO requiere auth
export async function GET() {
  const cookieStore = await cookies()
  const allCookies = cookieStore.getAll()

  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()

  const { data: { session }, error: sessionError } = await supabase.auth.getSession()

  return NextResponse.json({
    cookies_received: allCookies.map(c => ({
      name: c.name,
      length: c.value.length,
      preview: c.value.slice(0, 30),
    })),
    getUser: {
      found: !!user,
      user_id: user?.id ?? null,
      error: error?.message ?? null,
      error_status: error?.status ?? null,
    },
    getSession: {
      found: !!session,
      expires_at: session?.expires_at ?? null,
      error: sessionError?.message ?? null,
    },
  })
}
