import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Rutas que solo admin puede ver — agentes son redirigidos a /my-tasks
const ADMIN_ONLY_PATHS = ['/dashboard', '/performance']

// Rutas que requieren admin o ia_supervisor
const SUPERVISOR_PATHS = ['/supervisor-ia']

// Rutas visibles para admin, ia_supervisor y novelty_agent — NO para confirmation_agent ni delivery_agent
const DEVOLUCIONES_PATHS = ['/devoluciones']

async function getUserRole(supabase: ReturnType<typeof createServerClient>, userId: string) {
  const { data } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single()
  return (data?.role ?? 'agent') as string
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options as Parameters<typeof response.cookies.set>[2]),
          )
        },
      },
    },
  )

  const path = request.nextUrl.pathname

  const { data: { user } } = await supabase.auth.getUser()

  if (path.startsWith('/api')) return response

  // Redirigir a login si no está autenticado
  if (!user) {
    if (!path.startsWith('/login') && !path.startsWith('/auth')) {
      return NextResponse.redirect(new URL('/login', request.url))
    }
    return response
  }

  // Usuario autenticado — solo consultar rol cuando la ruta lo requiere
  const needsRoleCheck =
    path === '/' ||
    path.startsWith('/login') ||
    ADMIN_ONLY_PATHS.some(p => path.startsWith(p)) ||
    SUPERVISOR_PATHS.some(p => path.startsWith(p)) ||
    DEVOLUCIONES_PATHS.some(p => path.startsWith(p))

  if (!needsRoleCheck) return response

  const role = await getUserRole(supabase, user.id)
  const isAdmin           = role === 'admin'
  const isSupervisor      = role === 'admin' || role === 'ia_supervisor'
  const canSeeDevoluciones = role === 'admin' || role === 'ia_supervisor' || role === 'novelty_agent'
  const home = isAdmin ? '/dashboard' : '/my-tasks'

  // Si ya está logueado, redirigir desde login a su home según rol
  if (path.startsWith('/login')) {
    return NextResponse.redirect(new URL(home, request.url))
  }

  // Redirigir raíz según rol
  if (path === '/') {
    return NextResponse.redirect(new URL(home, request.url))
  }

  // Bloquear rutas admin para agentes
  if (!isAdmin && ADMIN_ONLY_PATHS.some(p => path.startsWith(p))) {
    return NextResponse.redirect(new URL('/my-tasks', request.url))
  }

  // Bloquear rutas de supervisor para roles sin permisos
  if (!isSupervisor && SUPERVISOR_PATHS.some(p => path.startsWith(p))) {
    return NextResponse.redirect(new URL('/my-tasks', request.url))
  }

  // Bloquear /devoluciones para confirmation_agent, delivery_agent y roles menores
  if (!canSeeDevoluciones && DEVOLUCIONES_PATHS.some(p => path.startsWith(p))) {
    return NextResponse.redirect(new URL('/my-tasks', request.url))
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp)$).*)'],
}
