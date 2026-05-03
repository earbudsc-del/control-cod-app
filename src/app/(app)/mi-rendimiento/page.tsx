import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { RendimientoConfirmacion } from '@/components/rendimiento/RendimientoConfirmacion'
import { RendimientoNovedad }      from '@/components/rendimiento/RendimientoNovedad'
import { RendimientoReparto }      from '@/components/rendimiento/RendimientoReparto'

export default async function MiRendimientoPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role === 'confirmation_agent') return <RendimientoConfirmacion />
  if (profile?.role === 'novelty_agent')      return <RendimientoNovedad />
  if (profile?.role === 'delivery_agent')     return <RendimientoReparto />

  redirect('/my-tasks')
}
