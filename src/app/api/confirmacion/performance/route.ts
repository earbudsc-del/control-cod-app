import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayIso      = todayStart.toISOString()
    const yesterdayIso  = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const cutoff48h     = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

    const [
      { count: confirmadosHoy },
      { count: contactadosHoy },
      { count: noRespondieronHoy },
      { count: canceladosHoy },
      { count: numerosIncorrectosHoy },
      { count: confirmadosAyer },
      { count: contactadosAyer },
      { count: atrasadosPendientes },
    ] = await Promise.all([

      // Hoy — confirmados
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('confirmation_status', 'confirmed')
        .gte('customer_confirmed_at', todayIso),

      // Hoy — cualquier intento de contacto
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .gte('last_confirmation_attempt', todayIso),

      // Hoy — contactados que siguen sin confirmar (1–2 intentos)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('confirmation_status', 'pending')
        .gte('confirmation_attempts', 1)
        .lte('confirmation_attempts', 2)
        .gte('last_confirmation_attempt', todayIso),

      // Hoy — cancelados (last_confirmation_attempt más preciso que updated_at)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('confirmation_status', 'cancelled')
        .gte('last_confirmation_attempt', todayIso),

      // Hoy — inalcanzables marcados hoy (wrong_number + 3x no_answer)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('confirmation_status', 'unreachable')
        .gte('last_confirmation_attempt', todayIso),

      // Ayer — confirmados (ventana exacta de ayer)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('confirmation_status', 'confirmed')
        .gte('customer_confirmed_at', yesterdayIso)
        .lt('customer_confirmed_at', todayIso),

      // Ayer — contactados (para calcular tasaAyer)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .gte('last_confirmation_attempt', yesterdayIso)
        .lt('last_confirmation_attempt', todayIso),

      // Atrasados pendientes activos (para el score y feedback)
      supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('confirmation_status', 'pending')
        .neq('normalized_status', 'delivered')
        .neq('normalized_status', 'returned')
        .lt('created_at', cutoff48h),
    ])

    const c  = confirmadosHoy  ?? 0
    const t  = contactadosHoy  ?? 0
    const cy = confirmadosAyer ?? 0
    const ty = contactadosAyer ?? 0

    return NextResponse.json({
      // Hoy
      confirmadosHoy:        c,
      contactadosHoy:        t,
      noRespondieronHoy:     noRespondieronHoy     ?? 0,
      canceladosHoy:         canceladosHoy         ?? 0,
      numerosIncorrectosHoy: numerosIncorrectosHoy ?? 0,
      tasaConfirmacionHoy:   t  > 0 ? Math.round((c  / t)  * 100) : null,
      // Ayer
      confirmadosAyer:       cy,
      contactadosAyer:       ty,
      tasaAyer:              ty > 0 ? Math.round((cy / ty) * 100) : null,
      // Cola
      atrasadosPendientes:   atrasadosPendientes ?? 0,
    })
  } catch (err) {
    console.error('[GET /api/confirmacion/performance]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
