import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/layout/sidebar'

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
    <div className="min-h-screen flex">
      <Sidebar role={role} />
      <main className="flex-1 ml-56 min-h-screen">
        <div className="p-6 max-w-screen-xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  )
}
