// Sprint Broadcast A — auditoría de las clasificaciones de Santo Domingo.
//
// Compara, localidad por localidad, las tres implementaciones existentes:
//   1. isSantoDomingoOrder()  — src/lib/alert-helpers.ts (TS, usa SD_COVERAGE_TERMS)
//   2. SD_FILTER              — src/app/api/confirmacion/pedidos/route.ts
//                               (PostgREST .or(...) con ilike; aquí se emula
//                               en TS con la misma semántica: ILIKE '%x%' es
//                               substring case-insensitive, ILIKE 'dn' es
//                               igualdad case-insensitive). NO normaliza
//                               acentos (ILIKE no lo hace).
//   3. detectSdZone()         — src/lib/sd-zones.ts (zona/tarifa operativa)
//
// Solo lectura: no toca DB ni red. NO modifica comportamiento.
//
// Corre con: npx tsx scripts/audit-sd-classification-matrix.ts

import { isSantoDomingoOrder } from '../src/lib/alert-helpers'
import { detectSdZone } from '../src/lib/sd-zones'

// Copia literal de SD_FILTER (confirmacion/pedidos/route.ts) para emularlo.
const SD_FILTER_CLAUSES: Array<{ col: 'city' | 'province' | 'customer_address'; pattern: string }> = [
  { col: 'city',             pattern: '%santo domingo%' },
  { col: 'city',             pattern: '%distrito nacional%' },
  { col: 'city',             pattern: 'dn' },
  { col: 'province',         pattern: '%santo domingo%' },
  { col: 'province',         pattern: '%distrito nacional%' },
  { col: 'province',         pattern: 'dn' },
  { col: 'customer_address', pattern: '%santo domingo%' },
  { col: 'customer_address', pattern: '%distrito nacional%' },
]

function ilike(value: string | null | undefined, pattern: string): boolean {
  if (value == null) return false
  const v = value.toLowerCase()
  const p = pattern.toLowerCase()
  const starts = p.startsWith('%'), ends = p.endsWith('%')
  const core = p.replace(/^%|%$/g, '')
  if (starts && ends) return v.includes(core)
  if (starts) return v.endsWith(core)
  if (ends) return v.startsWith(core)
  return v === core
}

function sdFilterMatches(o: Row): boolean {
  return SD_FILTER_CLAUSES.some(c => ilike(o[c.col], c.pattern))
}

interface Row { label: string; city: string | null; province: string | null; customer_address: string | null }

// Variantes reales de checkout Shopify: localidad en city con province
// Santo Domingo / Distrito Nacional (lo más común), y localidad en city con
// province vacía o de texto libre.
const LOCALITIES = [
  'Distrito Nacional', 'Santo Domingo Oeste', 'Santo Domingo Este', 'Santo Domingo Norte',
  'Boca Chica', 'La Caleta', 'San Isidro', 'La Victoria', 'Pantoja', 'Pedro Brand',
  'La Cuaba', 'El Gallo', 'San Antonio de Guerra',
]

const ROWS: Row[] = []
for (const loc of LOCALITIES) {
  ROWS.push({ label: `${loc} | prov=Santo Domingo`, city: loc, province: 'Santo Domingo', customer_address: 'Calle 1 #5' })
  ROWS.push({ label: `${loc} | prov=(vacía)`,       city: loc, province: null,            customer_address: 'Calle 1 #5' })
}

console.log('=== Matriz SD — isSantoDomingoOrder vs SD_FILTER vs detectSdZone ===\n')
console.log('Localidad'.padEnd(46), 'isSD'.padEnd(6), 'SD_FILTER'.padEnd(10), 'zona')
let divergences = 0
for (const r of ROWS) {
  const a = isSantoDomingoOrder(r.city, r.province, r.customer_address)
  const b = sdFilterMatches(r)
  const z = detectSdZone(r.city, r.province, r.customer_address).id
  const mark = a !== b ? '  ⚠ DIVERGE' : ''
  if (a !== b) divergences++
  console.log(r.label.padEnd(46), String(a).padEnd(6), String(b).padEnd(10), z + mark)
}
console.log(`\nDivergencias isSantoDomingoOrder vs SD_FILTER: ${divergences}/${ROWS.length}`)
