// Verificación READ-ONLY post smoke-test: confirma que el motor del
// Laboratorio (buildSystemPrompt + callOpenAI + validateResponse +
// detectHardEscalationSignal) no dejó ningún rastro en las tablas del canal
// real de WhatsApp/Génesis. Solo cuenta filas recientes — no vuelca
// contenido privado.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const envRaw = readFileSync('.env.local', 'utf8')
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] = m[2]
}
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } })

const SINCE_ISO = process.argv[2] // ISO timestamp — filas creadas desde este instante

async function main() {
  console.log('=== Verificación de aislamiento — post smoke test (READ-ONLY) ===')
  console.log(`Ventana: created_at >= ${SINCE_ISO}\n`)

  const tables: { name: string; col: string }[] = [
    { name: 'wa_messages',           col: 'created_at' },
    { name: 'wa_conversations',      col: 'created_at' },
    { name: 'wa_template_queue',     col: 'created_at' },
    { name: 'genesis_message_runs',  col: 'created_at' },
    { name: 'orders',                col: 'created_at' },
    { name: 'agent_actions',         col: 'created_at' },
  ]

  for (const t of tables) {
    const { count, error } = await svc
      .from(t.name)
      .select('id', { count: 'exact', head: true })
      .gte(t.col, SINCE_ISO)
    if (error) {
      console.log(`❌ ${t.name}: error consultando — ${error.message}`)
      continue
    }
    console.log(`${count === 0 ? '✅' : '⚠️ '} ${t.name}: ${count} fila(s) con ${t.col} >= ventana`)
  }

  // orders: además de "creadas", confirmar que ninguna fue MODIFICADA en la ventana
  const { count: ordersUpdated, error: ordersErr } = await svc
    .from('orders').select('id', { count: 'exact', head: true }).gte('updated_at', SINCE_ISO)
  if (!ordersErr) {
    console.log(`${ordersUpdated === 0 ? '✅' : '⚠️ '} orders: ${ordersUpdated} fila(s) con updated_at >= ventana (modificadas, no solo creadas)`)
  }

  console.log('\n=== Fin verificación — 0 filas modificadas por este script ===')
}

main()
