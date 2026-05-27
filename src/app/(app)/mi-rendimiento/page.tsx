import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { RendimientoConfirmacion }     from '@/components/rendimiento/RendimientoConfirmacion'
import { RendimientoNovedad }          from '@/components/rendimiento/RendimientoNovedad'
import { RendimientoReparto }          from '@/components/rendimiento/RendimientoReparto'
import { RendimientoSD }               from '@/components/rendimiento/RendimientoSD'
import { RendimientoDespacho }         from '@/components/rendimiento/RendimientoDespacho'

export default async function MiRendimientoPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role === 'confirmation_agent')           return <RendimientoConfirmacion />
  if (profile?.role === 'novelty_agent')                return <RendimientoNovedad />
  if (profile?.role === 'delivery_agent')               return <RendimientoReparto />
  if (profile?.role === 'santo_domingo_delivery_agent') return <RendimientoSD />
  if (profile?.role === 'dispatch_agent')               return <RendimientoDespacho />

  redirect('/my-tasks')
}
