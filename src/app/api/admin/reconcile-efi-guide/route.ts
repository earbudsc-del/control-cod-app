import { createClient }       from '@/lib/supabase/server'
import { NextResponse }        from 'next/server'
import { reconcileEFIGuide }   from '@/lib/admin/reconcile-guide'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Solo admins pueden reconciliar guías' }, { status: 403 })
    }

    const body = await request.json()
    const tracking_number: string = (body.tracking_number ?? '').toString().trim()
    const phone: string           = (body.phone           ?? '').toString().trim()

    if (!tracking_number) return NextResponse.json({ error: 'tracking_number es requerido' }, { status: 400 })
    if (!phone)           return NextResponse.json({ error: 'phone es requerido' }, { status: 400 })

    const result = await reconcileEFIGuide({ tracking_number, phone, supabase })

    const httpStatus = result.outcome === 'assigned'
      ? 200
      : result.outcome === 'efi_error'
        ? 502
        : result.outcome === 'already_assigned'
          ? 422
          : 200 // no_match, multiple_candidates, efi_not_found devuelven 200 con outcome explicativo

    return NextResponse.json(result, { status: httpStatus })
  } catch (err) {
    console.error('[POST /api/admin/reconcile-efi-guide]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
