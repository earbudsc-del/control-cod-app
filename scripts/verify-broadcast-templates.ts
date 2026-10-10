// Sprint C.1 — verificación READ-ONLY de los templates de Broadcast en Meta.
//
// NO envía mensajes. Hace un único GET a la Graph API:
//   GET /{WA_WABA_ID}/message_templates?name=<template>
// e imprime nombre, estado, idioma, categoría y componentes (header, body
// con cantidad de variables, botones). Con esa salida se fijan:
//   WA_BROADCAST_CONFIRMATION_LANGUAGE / _IMAGE_URL / _BODY_PARAMS
//   WA_BROADCAST_REPURCHASE_LANGUAGE   / _IMAGE_URL / _BODY_PARAMS
//
// Requiere autorización explícita para correrlo (lee configuración real de
// producción). Uso: npx tsx scripts/verify-broadcast-templates.ts

import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
}

const { WA_API_VERSION, WA_WABA_ID, WA_ACCESS_TOKEN } = process.env
if (!WA_API_VERSION || !WA_WABA_ID || !WA_ACCESS_TOKEN) {
  console.error('Faltan WA_API_VERSION / WA_WABA_ID / WA_ACCESS_TOKEN')
  process.exit(1)
}

// Nombre EN META → contrato esperado (templates.ts META_TEMPLATE_CONTRACTS, C.1.2).
const EXPECTED: Record<string, { buttons: string[]; language: string; vars: number }> = {
  sd_broadcast_confirmation: { buttons: ['Sí, confirmar', 'Ya no lo deseo'], language: 'en', vars: 5 },
  sd_broadcast_coordination: { buttons: ['Sí, quiero aprovechar', 'Ahora no'], language: 'es_DO', vars: 1 },  // recompra
}
const EXPECTED_BUTTONS: Record<string, string[]> = Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v.buttons]))

async function main() {
  for (const name of Object.keys(EXPECTED_BUTTONS)) {
    const url = `https://graph.facebook.com/${WA_API_VERSION}/${WA_WABA_ID}/message_templates?name=${name}&fields=name,status,language,category,components`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` } })
    const body = await res.json() as { data?: Array<Record<string, unknown>>; error?: { message?: string } }
    if (!res.ok) { console.error(`✖ ${name}: HTTP ${res.status} ${body.error?.message ?? ''}`); continue }
    const rows = (body.data ?? []).filter(t => t.name === name)
    if (rows.length === 0) { console.error(`✖ ${name}: no existe en la WABA`); continue }
    for (const t of rows) {
      console.log(`\n=== ${name} · ${t.language} · ${t.status} · ${t.category}`)
      console.log(`  ${t.language === EXPECTED[name].language ? '✅' : '❌'} idioma esperado ${EXPECTED[name].language}`)
      for (const c of (t.components ?? []) as Array<Record<string, unknown>>) {
        if (c.type === 'HEADER') console.log(`  HEADER: ${c.format}`)
        if (c.type === 'BODY') {
          const text = String(c.text ?? '')
          const vars = [...new Set(text.match(/\{\{\d+\}\}/g) ?? [])]
          console.log(`  BODY: ${vars.length} variable(s) ${vars.join(' ')}\n    ${text.replace(/\n/g, '\n    ')}`)
          console.log(`  ${vars.length === EXPECTED[name].vars ? '✅' : '❌'} ${EXPECTED[name].vars} variable(s) esperadas`)
        }
        if (c.type === 'BUTTONS') {
          const buttons = ((c.buttons ?? []) as Array<{ type: string; text: string }>)
          console.log(`  BUTTONS: ${buttons.map(b => `${b.type}:"${b.text}"`).join(' | ')}`)
          const texts = buttons.map(b => b.text)
          const ok = JSON.stringify(texts) === JSON.stringify(EXPECTED_BUTTONS[name])
          console.log(`  ${ok ? '✅' : '❌'} botones ${ok ? 'coinciden' : 'NO coinciden'} con campaign.ts (${EXPECTED_BUTTONS[name].join(' | ')})`)
        }
      }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
