// Auditoría READ-ONLY de wa_template_queue — Sprint 0 (protección WhatsApp).
//
// Corre con: npx tsx scripts/audit-wa-template-queue.ts
//
// No modifica absolutamente nada. Solo lee y reporta:
//   - conteo total por status
//   - conteo pending por template_name
//   - oldest / newest pending
//   - confirma que ningún job pending tiene processed_at o wa_message_id set
//     (señal de que nada se está procesando activamente)

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const envRaw = readFileSync('.env.local', 'utf8')
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] = m[2]
}
const URL          = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!

const svc = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  console.log('=== Auditoría wa_template_queue (READ-ONLY) ===\n')

  // Conteo EXACTO real (head:true — PostgREST no trunca counts, solo filas devueltas)
  const { count: totalCount, error: countErr } = await svc
    .from('wa_template_queue')
    .select('*', { count: 'exact', head: true })
  if (countErr) {
    console.error('Error contando wa_template_queue:', countErr.message)
    process.exit(1)
  }
  console.log(`Total real de filas (count exacto): ${totalCount}`)

  const { count: pendingCount, error: pendingCountErr } = await svc
    .from('wa_template_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending')
  if (pendingCountErr) {
    console.error('Error contando pending:', pendingCountErr.message)
    process.exit(1)
  }
  console.log(`Total real de PENDING (count exacto): ${pendingCount}\n`)

  // Paginar TODAS las filas (PostgREST clampa a 1000 por request por defecto)
  const PAGE_SIZE = 1000
  const rows: Array<{
    status: string; template_name: string; scheduled_at: string; created_at: string
    processed_at: string | null; wa_message_id: string | null; attempt_count: number
  }> = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error: pageErr } = await svc
      .from('wa_template_queue')
      .select('status, template_name, scheduled_at, created_at, processed_at, wa_message_id, attempt_count')
      .range(from, from + PAGE_SIZE - 1)
    if (pageErr) {
      console.error('Error paginando wa_template_queue:', pageErr.message)
      process.exit(1)
    }
    if (!page || page.length === 0) break
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  console.log(`Filas efectivamente traídas por paginación: ${rows.length}\n`)

  const byStatus: Record<string, number> = {}
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  }
  console.log('-- Por status --')
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`  ${status}: ${count}`)
  }

  const pending = rows.filter(r => r.status === 'pending')
  console.log(`\n-- Pending: ${pending.length} --`)

  const byTemplate: Record<string, number> = {}
  for (const r of pending) {
    byTemplate[r.template_name] = (byTemplate[r.template_name] ?? 0) + 1
  }
  console.log('Pending por template_name:')
  for (const [tpl, count] of Object.entries(byTemplate)) {
    console.log(`  ${tpl}: ${count}`)
  }

  if (pending.length > 0) {
    const sortedByCreated = [...pending].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    const oldest = sortedByCreated[0]
    const newest = sortedByCreated[sortedByCreated.length - 1]
    console.log(`\nOldest pending: created_at=${oldest.created_at} scheduled_at=${oldest.scheduled_at} template=${oldest.template_name}`)
    console.log(`Newest pending: created_at=${newest.created_at} scheduled_at=${newest.scheduled_at} template=${newest.template_name}`)
  }

  // Señales de procesamiento activo — no debería haber ninguna en pending
  const suspicious = pending.filter(r => r.processed_at !== null || r.wa_message_id !== null || r.attempt_count > 0)
  console.log(`\nPending con señales de procesamiento previo (processed_at/wa_message_id/attempt_count>0): ${suspicious.length}`)
  if (suspicious.length > 0) {
    console.log('⚠️  Revisar manualmente estas filas antes de cualquier acción:')
    console.log(JSON.stringify(suspicious.slice(0, 5), null, 2))
  }

  // status='processing' — señal de que algo está corriendo AHORA
  const processing = rows.filter(r => r.status === 'processing')
  console.log(`\nFilas en status='processing' (procesamiento activo ahora mismo): ${processing.length}`)
  if (processing.length > 0) {
    console.log('⚠️  ALERTA: hay jobs en processing. Investigar antes de continuar.')
  }

  console.log('\n=== Fin auditoría — 0 filas modificadas ===')
}

main()
