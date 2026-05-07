import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { NavShell } from '@/components/layout/nav-shell'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  const role = profile?.role ?? 'agent'

  return (
    <div className="min-h-screen bg-gray-50">
      {/* NavShell: topbar móvil + overlay + sidebar (drawer en móvil, fija en desktop) */}
      <NavShell role={role} />
      <main className="md:ml-56 min-h-screen">
        {/* pt-14 en móvil para compensar el topbar fijo (h-14); md:pt-0 en desktop */}
        <div className="pt-14 md:pt-0 px-4 py-4 md:p-6 max-w-screen-xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  )
}
