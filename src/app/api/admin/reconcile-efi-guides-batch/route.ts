import { createClient }     from '@/lib/supabase/server'
import { NextResponse }      from 'next/server'
import { reconcileEFIGuide, type ReconcileResult } from '@/lib/admin/reconcile-guide'

export const maxDuration = 300

const BATCH_MAX    = 20   // límite por request
const EFI_DELAY_MS = 700  // pausa entre consultas EFI para no saturar

interface BatchItem {
  tracking_number: string
  phone:           string
}

interface BatchResultItem extends ReconcileResult {
  input_tracking: string
  input_phone:    string
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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
    const rawItems: unknown[] = Array.isArray(body.items) ? body.items : []

    if (rawItems.length === 0) {
      return NextResponse.json({ error: 'items no puede estar vacío' }, { status: 400 })
    }
    if (rawItems.length > BATCH_MAX) {
      return NextResponse.json({ error: `Máximo ${BATCH_MAX} guías por request` }, { status: 400 })
    }

    const items: BatchItem[] = rawItems.map((item: unknown) => {
      const i = item as Record<string, unknown>
      return {
        tracking_number: String(i.tracking_number ?? '').trim(),
        phone:           String(i.phone           ?? '').trim(),
      }
    })

    // Validar que todos tienen campos mínimos
    const invalid = items.filter(i => !i.tracking_number || !i.phone)
    if (invalid.length > 0) {
      return NextResponse.json({
        error: `${invalid.length} items sin tracking_number o phone`,
        invalid,
      }, { status: 400 })
    }

    const results: BatchResultItem[] = []
    const summary = {
      total:              items.length,
      assigned:           0,
      multiple_candidates: 0,
      no_match:           0,
      efi_not_found:      0,
      efi_error:          0,
      already_assigned:   0,
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      if (i > 0) await delay(EFI_DELAY_MS)

      const result = await reconcileEFIGuide({
        tracking_number: item.tracking_number,
        phone:           item.phone,
        supabase,
      })

      results.push({ ...result, input_tracking: item.tracking_number, input_phone: item.phone })
      summary[result.outcome] = (summary[result.outcome] ?? 0) + 1
    }

    // Separar para que el admin sepa qué revisar manualmente
    const autoAssigned      = results.filter(r => r.outcome === 'assigned')
    const needsReview       = results.filter(r => r.outcome === 'multiple_candidates' || r.outcome === 'no_match')
    const efiIssues         = results.filter(r => r.outcome === 'efi_not_found' || r.outcome === 'efi_error')
    const alreadyAssigned   = results.filter(r => r.outcome === 'already_assigned')

    console.log(
      `[reconcile-efi-batch] total=${items.length} ` +
      `assigned=${summary.assigned} no_match=${summary.no_match} ` +
      `multiple=${summary.multiple_candidates} efi_issues=${summary.efi_not_found + summary.efi_error}`,
    )

    return NextResponse.json({
      summary,
      auto_assigned:    autoAssigned,
      needs_review:     needsReview,
      efi_issues:       efiIssues,
      already_assigned: alreadyAssigned,
      all_results:      results,
    })
  } catch (err) {
    console.error('[POST /api/admin/reconcile-efi-guides-batch]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
