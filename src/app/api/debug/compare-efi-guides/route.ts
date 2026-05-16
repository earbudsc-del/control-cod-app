import { NextResponse }        from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { parseEFITracking }    from '@/lib/tracking/efi-parser'

// POST /api/debug/compare-efi-guides
// Solo admin. Solo lectura — no modifica ningún dato.
//
// Compara una lista de guías reales (copiadas del dashboard EFI) contra nuestra DB.
// Por cada guía responde:
//   - Si existe en DB y en qué estado
//   - Si el cron la procesa (Q1/Q2/Q3/Q4) o por qué la excluye
//   - El estado ACTUAL en EFI (consulta en tiempo real)
//   - La divergencia DB vs EFI: si EFI dice activo pero DB dice final → bug detectado
//
// Body: { "guides": ["9000...", ...], "fetch_efi": true }
//   guides:    array de tracking numbers (máx 50 para DB; máx 20 consultan EFI)
//   fetch_efi: boolean — si false, solo hace lookup en DB (más rápido). Default: true

export const maxDuration = 120

const ALLOWED_ROLES    = ['admin']
const EFI_BASE         = 'https://effi.com.co/tracking/index'
const REVALIDATION_DAYS = 21        // debe coincidir con la constante del cron
const MAX_GUIDES_TOTAL = 50         // máximo para lookup DB
const MAX_GUIDES_EFI   = 20         // máximo que consultamos en EFI (runtime budget)

const FINAL_STATUSES = new Set(['delivered', 'returned', 'cancelled'])

// ── Tipos internos ────────────────────────────────────────────────────────────

interface DbOrder {
  id:                   string
  order_number:         string | null
  tracking_number:      string | null
  normalized_status:    string
  raw_status:           string | null
  last_tracking_update: string | null
  status_since:         string | null
  source:               string | null
  created_at:           string
}

interface CronStatus {
  enters_Q1:       boolean
  enters_Q2:       boolean
  enters_Q3:       boolean
  enters_Q4:       boolean
  excluded:        boolean
  exclusion_reason: string | null
}

interface Divergence {
  status_mismatch: boolean
  db_status:       string | null
  efi_status:      string
  severity:        'none' | 'minor' | 'major'
  description:     string
}

interface EfiResult {
  fetch_success:         boolean
  error?:                string
  encontrado?:           boolean
  raw_status_efi?:       string | null
  normalized_status_efi?: string
  estado_global?:        string | null
  attempts?:             number
  last_attempt_reason?:  string | null
  divergencia?:          Divergence
}

// ── Análisis de cobertura del cron para una orden ─────────────────────────────

function analyzeCron(order: DbOrder): CronStatus {
  const status = order.normalized_status
  const d21ago = new Date(Date.now() - REVALIDATION_DAYS * 24 * 60 * 60 * 1000).toISOString()

  if (!order.tracking_number) {
    return {
      enters_Q1: false, enters_Q2: false, enters_Q3: false, enters_Q4: false,
      excluded: true,
      exclusion_reason: 'tracking_number IS NULL — el cron filtra .not(tracking_number, is, null)',
    }
  }

  if (status === 'in_transit') {
    return {
      enters_Q1: true, enters_Q2: false, enters_Q3: false, enters_Q4: false,
      excluded: false, exclusion_reason: null,
    }
  }

  if (status === 'en_reparto') {
    return {
      enters_Q1: false, enters_Q2: true, enters_Q3: false, enters_Q4: false,
      excluded: false, exclusion_reason: null,
    }
  }

  if (!FINAL_STATUSES.has(status)) {
    // novedad, pending, unknown, etc. → Q3
    return {
      enters_Q1: false, enters_Q2: false, enters_Q3: true, enters_Q4: false,
      excluded: false, exclusion_reason: null,
    }
  }

  // Estado final: delivered, returned, cancelled
  if (status === 'cancelled') {
    return {
      enters_Q1: false, enters_Q2: false, enters_Q3: false, enters_Q4: false,
      excluded: true,
      exclusion_reason: 'cancelled — finalizaciones intencionales nunca son revalidadas',
    }
  }

  // returned o delivered — solo Q4 si está dentro de la ventana de 21 días
  const lastUpdate = order.last_tracking_update
  const inWindow   = !!lastUpdate && lastUpdate >= d21ago

  if (inWindow) {
    return {
      enters_Q1: false, enters_Q2: false, enters_Q3: false, enters_Q4: true,
      excluded: false, exclusion_reason: null,
    }
  }

  return {
    enters_Q1: false, enters_Q2: false, enters_Q3: false, enters_Q4: false,
    excluded: true,
    exclusion_reason:
      `${status} con last_tracking_update anterior a ${REVALIDATION_DAYS} días ` +
      `(${lastUpdate ?? 'null'}) — fuera de la ventana Q4. ` +
      `Esta orden NUNCA vuelve a ser procesada por el cron con la lógica actual.`,
  }
}

// ── Cálculo de divergencia DB vs EFI ────────────────────────────────────────

function calcDivergence(dbStatus: string | null, efiStatus: string): Divergence {
  const dbFinal  = dbStatus ? FINAL_STATUSES.has(dbStatus) : false
  const efiFinal = FINAL_STATUSES.has(efiStatus)

  if (!dbStatus) {
    return {
      status_mismatch: true,
      db_status: null,
      efi_status: efiStatus,
      severity: 'major',
      description: 'Guía activa en EFI pero NO existe en DB — el cron no sabe de su existencia.',
    }
  }

  if (dbStatus === efiStatus) {
    return {
      status_mismatch: false,
      db_status: dbStatus,
      efi_status: efiStatus,
      severity: 'none',
      description: 'DB y EFI coinciden exactamente.',
    }
  }

  if (dbFinal && !efiFinal) {
    return {
      status_mismatch: true,
      db_status: dbStatus,
      efi_status: efiStatus,
      severity: 'major',
      description:
        `CRÍTICO: DB="${dbStatus}" (final, excluida del cron) pero EFI="${efiStatus}" (activo). ` +
        `La orden está atrapada — el cron nunca la re-sincronizará a menos que entre en Q4.`,
    }
  }

  if (!dbFinal && efiFinal) {
    return {
      status_mismatch: true,
      db_status: dbStatus,
      efi_status: efiStatus,
      severity: 'major',
      description:
        `DB="${dbStatus}" (activo) pero EFI="${efiStatus}" (final). ` +
        `El próximo run del cron debería actualizarla.`,
    }
  }

  // Ambos activos pero estados distintos
  return {
    status_mismatch: true,
    db_status: dbStatus,
    efi_status: efiStatus,
    severity: 'minor',
    description:
      `Ambos activos pero estados distintos: DB="${dbStatus}" vs EFI="${efiStatus}". ` +
      `El cron debería sincronizarla en el próximo run.`,
  }
}

// ── Handler principal ─────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    // Auth
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!ALLOWED_ROLES.includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Solo admins' }, { status: 403 })
    }

    // Parse body
    let body: { guides?: unknown; fetch_efi?: unknown } = {}
    try { body = await req.json() } catch { /* body vacío */ }

    if (!Array.isArray(body.guides) || body.guides.length === 0) {
      return NextResponse.json(
        { error: 'Body debe incluir "guides": ["9000...", ...] con al menos una guía' },
        { status: 400 },
      )
    }

    const guides    = (body.guides as unknown[])
      .map(g => String(g).trim())
      .filter(Boolean)
      .slice(0, MAX_GUIDES_TOTAL)

    const fetchEfi  = body.fetch_efi !== false // default true
    const efiSet    = new Set(fetchEfi ? guides.slice(0, MAX_GUIDES_EFI) : [])

    // ── Lookup en DB para todas las guías en un solo query ───────────────────
    const service = await createServiceClient()

    const { data: rawOrders } = await service
      .from('orders')
      .select('id, order_number, tracking_number, normalized_status, raw_status, last_tracking_update, status_since, source, created_at')
      .in('tracking_number', guides)

    const dbByGuide = new Map<string, DbOrder>()
    for (const o of (rawOrders ?? []) as DbOrder[]) {
      if (o.tracking_number) dbByGuide.set(o.tracking_number, o)
    }

    // ── Procesar cada guía ────────────────────────────────────────────────────
    const results: Array<{
      guide:        string
      exists_in_db: boolean
      db:           DbOrder | null
      cron:         CronStatus
      efi?:         EfiResult
    }> = []

    for (const guide of guides) {
      const order = dbByGuide.get(guide) ?? null

      const cron: CronStatus = order
        ? analyzeCron(order)
        : {
            enters_Q1: false, enters_Q2: false, enters_Q3: false, enters_Q4: false,
            excluded: true,
            exclusion_reason: 'La guía NO existe en DB — el cron no sabe de su existencia.',
          }

      // EFI fetch (tiempo real, sin escritura en DB)
      let efi: EfiResult | undefined

      if (efiSet.has(guide)) {
        try {
          const res = await fetch(`${EFI_BASE}/${encodeURIComponent(guide)}`, {
            headers: {
              'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'es-419,es;q=0.9',
              'Cache-Control':   'no-cache',
            },
            cache:  'no-store',
            signal: AbortSignal.timeout(10_000),
          })

          if (!res.ok) {
            efi = { fetch_success: false, error: `EFI HTTP ${res.status}` }
          } else {
            const html     = await res.text()
            const tracking = parseEFITracking(html, guide)

            efi = {
              fetch_success:         true,
              encontrado:            tracking.encontrado,
              raw_status_efi:        tracking.estado_actual,
              normalized_status_efi: tracking.normalized_status,
              estado_global:         tracking.estado_global,
              attempts:              tracking.attempts,
              last_attempt_reason:   tracking.last_attempt_reason,
              divergencia: calcDivergence(
                order?.normalized_status ?? null,
                tracking.normalized_status,
              ),
            }
          }
        } catch (err) {
          efi = {
            fetch_success: false,
            error: err instanceof Error ? err.message : 'Error de red',
          }
        }
      }

      results.push({
        guide,
        exists_in_db: order !== null,
        db:           order,
        cron,
        ...(efiSet.has(guide) && { efi }),
      })
    }

    // ── Resumen ───────────────────────────────────────────────────────────────
    const inDb             = results.filter(r => r.exists_in_db).length
    const notInDb          = results.filter(r => !r.exists_in_db).length
    const processedByCron  = results.filter(r => !r.cron.excluded).length
    const excludedFromCron = results.filter(r => r.cron.excluded).length
    const majorDivergences = fetchEfi
      ? results.filter(r => r.efi?.divergencia?.severity === 'major').length
      : null
    const minorDivergences = fetchEfi
      ? results.filter(r => r.efi?.divergencia?.severity === 'minor').length
      : null
    const notFoundInEfi = fetchEfi
      ? results.filter(r => r.efi?.fetch_success && !r.efi.encontrado).length
      : null

    // Guías críticas: EFI dice activo pero DB dice final (o no existe en DB)
    const critical = fetchEfi
      ? results
          .filter(r => r.efi?.divergencia?.severity === 'major' && r.efi.fetch_success)
          .map(r => ({
            guide:       r.guide,
            db_status:   r.db?.normalized_status ?? '(no en DB)',
            efi_status:  r.efi!.normalized_status_efi,
            enters_Q4:   r.cron.enters_Q4,
            description: r.efi!.divergencia!.description,
          }))
      : null

    return NextResponse.json({
      generatedAt:     new Date().toISOString(),
      guides_requested: guides.length,
      efi_fetched:     fetchEfi,
      efi_fetch_cap:   MAX_GUIDES_EFI,
      revalidation_window_days: REVALIDATION_DAYS,

      summary: {
        in_db:                       inDb,
        not_in_db:                   notInDb,
        processed_by_cron:           processedByCron,
        excluded_from_cron:          excludedFromCron,
        ...(fetchEfi && {
          major_divergences_efi_vs_db: majorDivergences,
          minor_divergences_efi_vs_db: minorDivergences,
          not_found_in_efi:            notFoundInEfi,
        }),
      },

      // Lista compacta de casos críticos — para acción inmediata
      ...(critical && critical.length > 0 && { critical_cases: critical }),

      results,
    })
  } catch (err) {
    console.error('[POST /api/debug/compare-efi-guides]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
