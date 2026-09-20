// Verificación estática de aislamiento del Laboratorio de Génesis (Sprint 1).
//
// El endpoint /api/admin/genesis-simulator/message debe ser un sandbox
// puramente conversacional: nunca debe poder enviar WhatsApp, encolar
// templates, ejecutar confirmation actions, editar pedidos, crear
// agent_actions, marcar pagado, despachar, ni tocar Ruta COD.
//
// No hay un mock de red disponible para todos esos side-effects de forma
// práctica en un solo test de integración, así que esta verificación es
// estática y determinística: falla si el archivo fuente del endpoint
// contiene cualquier referencia a las piezas prohibidas (import, string
// literal de tabla/RPC, o llamada de función). Un cambio futuro que agregue
// alguna de estas piezas al endpoint hará fallar este test inmediatamente.
//
// Corre con: npx tsx scripts/test-genesis-simulator-isolation.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTE_PATH = join(__dirname, '..', 'src/app/api/admin/genesis-simulator/message/route.ts')
const rawSource = readFileSync(ROUTE_PATH, 'utf8')

// Los comentarios del propio archivo DOCUMENTAN qué NO se importa (mencionan
// los nombres prohibidos en prosa, a propósito). Se despojan antes de
// escanear para que el test verifique CÓDIGO real, no la explicación.
const source = rawSource
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, '')

let failures = 0
function check(label: string, pass: boolean) {
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label}`)
}

// Cada patrón representa una capacidad que el sandbox NUNCA debe tener.
const FORBIDDEN_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'sendWhatsAppText (envío real de WhatsApp)',        pattern: /sendWhatsAppText/ },
  { label: "tabla 'wa_template_queue'",                        pattern: /wa_template_queue/ },
  { label: 'applyConfirmationAction (confirmar/cancelar pedido)', pattern: /applyConfirmationAction/ },
  { label: "tabla 'agent_actions' (crear acción de agente)",   pattern: /agent_actions/ },
  { label: "RPC 'escalate_genesis_conversation' (mutación real de escalamiento)", pattern: /supabase\s*\n?\s*\.rpc\(\s*['"]escalate_genesis_conversation['"]/ },
  { label: "RPC 'claim_genesis_run' (pipeline real de runs)",  pattern: /claim_genesis_run/ },
  { label: "RPC 'finish_genesis_run'",                         pattern: /finish_genesis_run/ },
  { label: 'dispatch-local (despacho de pedido)',              pattern: /dispatch-local|dispatchLocal/ },
  { label: "actualización de tabla 'orders' (mark_paid/update)", pattern: /from\(\s*['"]orders['"]\s*\)/ },
  { label: "tabla 'wa_messages' (Inbox real)",                 pattern: /wa_messages/ },
  { label: "tabla 'wa_conversations' (Inbox real)",            pattern: /wa_conversations/ },
]

console.log('=== Aislamiento del Laboratorio de Génesis — verificación estática ===\n')

for (const { label, pattern } of FORBIDDEN_PATTERNS) {
  check(`NO contiene: ${label}`, !pattern.test(source))
}

// Positivo — confirma que SÍ reutiliza el motor real de producción (no un
// segundo Génesis paralelo), como exige el spec.
check('SÍ reutiliza buildSystemPrompt() real', /buildSystemPrompt/.test(source))
check('SÍ reutiliza callOpenAI() real', /callOpenAI/.test(source))
check('SÍ reutiliza validateResponse() real (response-validator)', /validateResponse/.test(source))
check('SÍ reutiliza detectHardEscalationSignal() (solo para REPORTAR, no ejecutar)', /detectHardEscalationSignal/.test(source))

// Auth — debe exigir admin explícitamente.
check('Exige role === admin', /role\s*!==\s*['"]admin['"]/.test(source))

console.log(`\n${failures === 0 ? '✅ Todas las verificaciones pasaron' : `❌ ${failures} verificación(es) fallaron`}`)
process.exit(failures === 0 ? 0 : 1)
