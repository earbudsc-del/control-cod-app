const INTERVAL_MS = 5 * 60 * 1000
const ENDPOINT    = 'http://localhost:3000/api/tracking/auto'
const SECRET      = process.env.CRON_SECRET

if (!SECRET) {
  console.error('[cron-tracking] ERROR: CRON_SECRET no está definido en .env.local')
  process.exit(1)
}

function timestamp() {
  return new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

async function run() {
  try {
    const res  = await fetch(ENDPOINT, {
      method:  'POST',
      headers: { 'x-cron-secret': SECRET },
    })
    const data = await res.json()

    if (!res.ok) {
      console.error(`[cron-tracking] ${timestamp()} → HTTP ${res.status} — ${data.error ?? 'error desconocido'}`)
      return
    }

    const { processed = 0, updated = 0, failed = 0 } = data
    const failTag = failed > 0 ? `  ⚠ failed=${failed}` : ''
    console.log(`[cron-tracking] ${timestamp()} → processed=${processed}  updated=${updated}  failed=${failed}${failTag}`)

    if (data.errors?.length) {
      data.errors.forEach(e => console.log(`  └ ${e.orderId}: ${e.error}`))
    }
  } catch (err) {
    console.error(`[cron-tracking] ${timestamp()} → Error de red: ${err.message}`)
    console.error('  ¿Está corriendo npm run dev?')
  }
}

console.log(`[cron-tracking] Iniciando — intervalo: ${INTERVAL_MS / 60000} min — endpoint: ${ENDPOINT}`)
run()
setInterval(run, INTERVAL_MS)
