// Pruebas ejecutables de cobertura del Gran Santo Domingo.
//
// Corre con: npx tsx scripts/test-sd-coverage.ts
// (o: npm run test:sd-coverage)
//
// Verifica que isSantoDomingoOrder() — el filtro que decide si un pedido
// entra al universo SD interno (SD Delivery / Ruta COD) — reconoce las
// localidades aprobadas y NO amplía cobertura a provincias no aprobadas.
// isSantoDomingoOrder() y detectSdZone() comparten una sola fuente de
// términos (SD_COVERAGE_TERMS en src/lib/sd-zones.ts) — este test también
// sirve como guardia contra que alguien vuelva a divergir esa lista.

import { isSantoDomingoOrder } from '../src/lib/alert-helpers'
import { detectSdZone } from '../src/lib/sd-zones'

interface Case {
  label: string
  city?: string | null
  province?: string | null
  address?: string | null
  expected: boolean
}

const CASES: Case[] = [
  { label: 'Pedro Brand',          city: 'Pedro Brand',          expected: true },
  { label: 'Boca Chica',           city: 'Boca Chica',           expected: true },
  { label: 'La Caleta',            city: 'La Caleta',            expected: true },
  { label: 'Los Alcarrizos',       city: 'Los Alcarrizos',       expected: true },
  { label: 'Santo Domingo Este',   city: 'Santo Domingo Este',   expected: true },
  { label: 'Santo Domingo Norte',  city: 'Santo Domingo Norte',  expected: true },
  { label: 'Santo Domingo Oeste',  city: 'Santo Domingo Oeste',  expected: true },
  { label: 'Distrito Nacional',    city: 'Distrito Nacional',    expected: true },
  // Genérico, sin dirección de zona — debe seguir cubierto (regresión Sprint 2).
  { label: 'Santo Domingo (genérico)', city: 'Santo Domingo',    expected: true },
  { label: 'DN (abreviatura, límite de palabra)', city: 'DN',    expected: true },
  // No ampliar cobertura a provincias no aprobadas.
  { label: 'Santiago',             city: 'Santiago',             expected: false },
  { label: 'San Cristóbal',        city: 'San Cristóbal',        expected: false },
]

let failures = 0

function runGroup(title: string, cases: Case[]): void {
  console.log(`\n— ${title} —`)
  for (const c of cases) {
    const result = isSantoDomingoOrder(c.city ?? null, c.province ?? null, c.address ?? null)
    const pass = result === c.expected
    if (!pass) failures++
    console.log(
      `${pass ? '✅' : '❌'} isSantoDomingoOrder(city=${JSON.stringify(c.city)}, province=${JSON.stringify(c.province)}, address=${JSON.stringify(c.address)}) = ${result} (esperado ${c.expected}) — ${c.label}`,
    )
  }
}

runGroup('Casos base (regresión general)', CASES)

// ── Pantoja — caso que motivó la auditoría 2026-08-08 ────────────────────────
// `province` es texto libre del checkout: debe seguir clasificando como SD
// aunque venga vacío, correcto, o con un valor no reconocido/incorrecto.
const PANTOJA_CASES: Case[] = [
  { label: 'Pantoja, province vacío',                          city: 'Pantoja', province: '',                     expected: true },
  { label: 'Pantoja, province="Santo Domingo"',                 city: 'Pantoja', province: 'Santo Domingo',        expected: true },
  { label: 'Pantoja, province="Republica Dominicana"',          city: 'Pantoja', province: 'Republica Dominicana', expected: true },
  { label: 'Pantoja, province="RD"',                            city: 'Pantoja', province: 'RD',                   expected: true },
  { label: 'Pantoja, province="SD"',                            city: 'Pantoja', province: 'SD',                   expected: true },
  { label: 'Pantoja, province="San Cristobal"',                 city: 'Pantoja', province: 'San Cristobal',        expected: true },
  { label: 'Pantoja en address, province="Republica Dominicana"', city: null,    province: 'Republica Dominicana', address: 'Pantoja', expected: true },
]
runGroup('Pantoja', PANTOJA_CASES)

// ── Otros sectores de alta confianza (SD_HIGH_CONFIDENCE_TERMS) ──────────────
const HIGH_CONFIDENCE_CASES: Case[] = [
  { label: 'Los Alcarrizos + Republica Dominicana', city: 'Los Alcarrizos', province: 'Republica Dominicana', expected: true },
  { label: 'Los Alcarrizos + San Cristobal',         city: 'Los Alcarrizos', province: 'San Cristobal',        expected: true },
  { label: 'Pedro Brand + SD',                       city: 'Pedro Brand',    province: 'SD',                   expected: true },
  { label: 'Pedro Brand + Republica Dominicana',      city: 'Pedro Brand',    province: 'Republica Dominicana', expected: true },
  { label: 'La Cuaba + Republica Dominicana',         city: 'La Cuaba',       province: 'Republica Dominicana', expected: true },
]
runGroup('Alta confianza (fuera de Pantoja)', HIGH_CONFIDENCE_CASES)

// ── Protección contra provincia real (regresión del guard 2026-07-28) ───────
// Direcciones claramente de otra provincia NO deben pasar a SD por la
// excepción de alta confianza — solo términos ambiguos/genéricos están en
// juego aquí, ninguno de SD_HIGH_CONFIDENCE_TERMS.
const PROVINCE_PROTECTION_CASES: Case[] = [
  { label: 'Villa Hermosa + province="La Romana" (caso original #10798/#10800)', city: 'Villa Hermosa', province: 'La Romana', expected: false },
  { label: 'La Romana con dirección ambigua',      city: null,           province: 'La Romana', address: 'Villa Hermosa, sector Caleta', expected: false },
  { label: 'Higüey',                                city: 'Higüey',                                                expected: false },
  { label: 'San Pedro de Macorís',                  city: 'San Pedro de Macorís',                                  expected: false },
  { label: 'Santiago',                              city: 'Santiago',                                              expected: false },
  { label: 'Baní',                                  city: 'Baní',                                                  expected: false },
]
runGroup('Protección contra provincia real (no-regresión de La Romana)', PROVINCE_PROTECTION_CASES)

// ── Regresión de zonas SD ya existentes ──────────────────────────────────────
const SD_REGRESSION_CASES: Case[] = [
  { label: 'Villa Mella',           city: 'Villa Mella',           expected: true },
  { label: 'Santo Domingo Norte',   city: 'Santo Domingo Norte',   expected: true },
  { label: 'Santo Domingo Este',    city: 'Santo Domingo Este',    expected: true },
  { label: 'Santo Domingo Oeste',   city: 'Santo Domingo Oeste',   expected: true },
  { label: 'Distrito Nacional',     city: 'Distrito Nacional',     expected: true },
  { label: 'Boca Chica',            city: 'Boca Chica',            expected: true },
  { label: 'Los Alcarrizos',        city: 'Los Alcarrizos',        expected: true },
  { label: 'Pedro Brand',           city: 'Pedro Brand',           expected: true },
]
runGroup('Regresión de zonas SD existentes', SD_REGRESSION_CASES)

// Guardia adicional: confirmar que las 4 localidades del reporte también
// resuelven a una zona real de detectSdZone() (no caen al fallback 'otro'),
// que es lo que garantiza tarifa y agrupación de ruta correctas.
const ZONE_CASES: { city: string; expectNotOtro: boolean }[] = [
  { city: 'Pedro Brand', expectNotOtro: true },
  { city: 'Boca Chica', expectNotOtro: true },
  { city: 'La Caleta', expectNotOtro: true },
  { city: 'Los Alcarrizos', expectNotOtro: true },
]

for (const c of ZONE_CASES) {
  const zone = detectSdZone(c.city, null, null)
  const pass = (zone.id !== 'otro') === c.expectNotOtro
  if (!pass) failures++
  console.log(
    `${pass ? '✅' : '❌'} detectSdZone(${JSON.stringify(c.city)}) = ${zone.id} (no debía caer en 'otro')`,
  )
}

const totalCases =
  CASES.length +
  PANTOJA_CASES.length +
  HIGH_CONFIDENCE_CASES.length +
  PROVINCE_PROTECTION_CASES.length +
  SD_REGRESSION_CASES.length +
  ZONE_CASES.length

if (failures > 0) {
  console.error(`\n${failures} prueba(s) fallaron.`)
  process.exit(1)
}
console.log(`\nTodas las pruebas de cobertura SD pasaron (${totalCases}).`)
