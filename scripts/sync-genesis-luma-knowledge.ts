// Sincronización controlada del knowledge comercial de LÜMA Teeth — Fase 2A.1.
//
// Fuente de verdad: src/lib/genesis/knowledge/luma-teeth-v1.ts (versionado en git).
// Este script es el ÚNICO camino soportado para llevar ese contenido a
// ai_agent_knowledge_sections — nunca UPDATE manual pegado en Supabase.
//
// Por defecto corre en dry-run (solo lectura, muestra el diff exacto entre lo
// que hay en producción y lo propuesto). Requiere el flag --apply explícito
// para escribir. No borra ninguna otra sección, no toca Renuva, no toca
// ai_agent_config.system_prompt — solo hace upsert de las 3 filas definidas en
// LUMA_TEETH_KNOWLEDGE_V1 (luma_teeth, limites_medicos, objeciones).
//
// Trazabilidad de versión: se embebe como comentario HTML al final del
// content de cada fila (`<!-- genesis-knowledge-version: X -->`) — no se
// inventa ninguna columna nueva, se reutiliza el campo `content` ya existente.
//
// Uso:
//   npx tsx scripts/sync-genesis-luma-knowledge.ts                    → dry-run
//   npx tsx scripts/sync-genesis-luma-knowledge.ts --apply            → escribe
//   npx tsx scripts/sync-genesis-luma-knowledge.ts --store=<uuid>     → tienda explícita
//   npx tsx scripts/sync-genesis-luma-knowledge.ts --store=<uuid> --apply

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { LUMA_TEETH_KNOWLEDGE_V1 } from '../src/lib/genesis/knowledge/luma-teeth-v1'

const envRaw = readFileSync('.env.local', 'utf8')
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2]
}

const args    = process.argv.slice(2)
const apply   = args.includes('--apply')
const storeArg = args.find(a => a.startsWith('--store='))?.split('=')[1]

interface KnowledgeRow {
  id:         string
  section_key: string
  label:      string
  priority:   number
  content:    string
  is_active:  boolean
  updated_at: string
}

function finalContentFor(section: (typeof LUMA_TEETH_KNOWLEDGE_V1)[number]): string {
  return `${section.content.trim()}\n\n<!-- genesis-knowledge-version: ${section.version} -->`
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    console.error('✖ Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local.')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // ── Resolver store_id explícito — nunca implícito/loop sobre todas las tiendas ──
  let storeId = storeArg
  if (!storeId) {
    const { data: configs, error } = await supabase.from('ai_agent_config').select('store_id')
    if (error) {
      console.error('✖ Error consultando ai_agent_config:', error.message)
      process.exit(1)
    }
    if (!configs || configs.length === 0) {
      console.error('✖ No existe ninguna fila en ai_agent_config. Pasa --store=<uuid> explícitamente.')
      process.exit(1)
    }
    if (configs.length > 1) {
      console.error('✖ Hay múltiples tiendas con ai_agent_config. Especifica --store=<uuid>. Disponibles:')
      for (const c of configs) console.error('  -', c.store_id)
      process.exit(1)
    }
    storeId = configs[0].store_id
  }

  const { data: storeRow, error: storeErr } = await supabase
    .from('stores')
    .select('id, name')
    .eq('id', storeId)
    .maybeSingle()

  if (storeErr) {
    console.error('✖ Error consultando la tienda:', storeErr.message)
    process.exit(1)
  }
  if (!storeRow) {
    console.error(`✖ La tienda ${storeId} no existe. Abortando — no se puede sincronizar contra una tienda inexistente.`)
    process.exit(1)
  }

  console.log(`Tienda: ${storeRow.name ?? '(sin nombre)'} (${storeId})`)
  console.log(`Modo: ${apply ? '--apply (SE ESCRIBIRÁ en Supabase)' : 'dry-run (solo lectura, nada se escribe)'}`)
  console.log(`Secciones a sincronizar: ${LUMA_TEETH_KNOWLEDGE_V1.map(s => s.sectionKey).join(', ')}`)
  console.log('')

  const sectionKeys = LUMA_TEETH_KNOWLEDGE_V1.map(s => s.sectionKey)
  const { data: existingRows, error: exErr } = await supabase
    .from('ai_agent_knowledge_sections')
    .select('id, section_key, label, priority, content, is_active, updated_at')
    .eq('store_id', storeId)
    .in('section_key', sectionKeys)

  if (exErr) {
    console.error('✖ Error consultando ai_agent_knowledge_sections:', exErr.message)
    process.exit(1)
  }

  const existingByKey = new Map<string, KnowledgeRow>((existingRows ?? []).map(r => [r.section_key, r as KnowledgeRow]))

  type PlanAction = 'create' | 'update' | 'no-op'
  const plan: { sectionKey: string; action: PlanAction }[] = []

  for (const section of LUMA_TEETH_KNOWLEDGE_V1) {
    const proposed = finalContentFor(section)
    const existing  = existingByKey.get(section.sectionKey)

    if (!existing) {
      plan.push({ sectionKey: section.sectionKey, action: 'create' })
      console.log(`\n=== ${section.sectionKey} — CREAR (no existe todavía) ===`)
      console.log(`label: "${section.title}" | priority propuesta: ${section.priority}`)
      console.log('--- contenido propuesto ---')
      console.log(proposed)
      continue
    }

    const contentMatches  = existing.content === proposed
    const priorityMatches = existing.priority === section.priority
    const labelMatches    = existing.label === section.title

    if (contentMatches && priorityMatches && labelMatches) {
      plan.push({ sectionKey: section.sectionKey, action: 'no-op' })
      console.log(`\n=== ${section.sectionKey} — sin cambios (ya coincide exactamente) ===`)
      continue
    }

    plan.push({ sectionKey: section.sectionKey, action: 'update' })
    console.log(`\n=== ${section.sectionKey} — ACTUALIZAR ===`)
    if (!priorityMatches) console.log(`⚠ priority actual=${existing.priority} → propuesta=${section.priority}`)
    if (!labelMatches)    console.log(`⚠ label actual="${existing.label}" → propuesta="${section.title}"`)
    if (!contentMatches) {
      console.log('--- contenido actual ---')
      console.log(existing.content)
      console.log('--- contenido propuesto ---')
      console.log(proposed)
    }
  }

  console.log('\n=== RESUMEN DEL PLAN ===')
  for (const p of plan) console.log(`  ${p.sectionKey}: ${p.action}`)

  if (!apply) {
    console.log('\nDRY-RUN — no se escribió nada en Supabase. Ejecuta con --apply para aplicar estos cambios.')
    return
  }

  console.log('\nAplicando cambios...')
  for (const section of LUMA_TEETH_KNOWLEDGE_V1) {
    const existing = existingByKey.get(section.sectionKey)
    const planItem = plan.find(p => p.sectionKey === section.sectionKey)
    if (planItem?.action === 'no-op') {
      console.log(`- ${section.sectionKey}: sin cambios, omitido`)
      continue
    }

    const { error: upsertErr } = await supabase
      .from('ai_agent_knowledge_sections')
      .upsert(
        {
          store_id:    storeId,
          section_key: section.sectionKey,
          label:       section.title,
          content:     finalContentFor(section),
          priority:    section.priority,
          is_active:   true,
        },
        { onConflict: 'store_id,section_key' },
      )

    if (upsertErr) {
      console.error(`✖ Error al escribir ${section.sectionKey}:`, upsertErr.message)
      process.exitCode = 1
      continue
    }
    console.log(`✓ ${section.sectionKey}: ${existing ? 'actualizado' : 'creado'}`)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
