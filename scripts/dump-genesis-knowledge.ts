// READ-ONLY dump de ai_agent_config + ai_agent_knowledge_sections — para
// inspeccionar el contenido real en DB antes de editar reglas_cod / QR.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const envRaw = readFileSync('.env.local', 'utf8')
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] = m[2]
}
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  const { data: configs } = await svc.from('ai_agent_config').select('*')
  console.log('=== ai_agent_config ===')
  console.log(JSON.stringify(configs, null, 2))

  const { data: sections } = await svc
    .from('ai_agent_knowledge_sections')
    .select('id, store_id, section_key, label, priority, is_active, content')
    .order('priority', { ascending: false })
  console.log('\n=== ai_agent_knowledge_sections ===')
  for (const s of sections ?? []) {
    console.log(`\n--- [${s.section_key}] "${s.label}" priority=${s.priority} active=${s.is_active} ---`)
    console.log(s.content)
  }
}
main()
