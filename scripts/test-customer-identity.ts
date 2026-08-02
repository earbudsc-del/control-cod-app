// Pruebas ejecutables de normalizePhone() — Customer Intelligence Engine, Fase 1.
//
// Corre con: npx tsx scripts/test-customer-identity.ts
// (o: npm run test:customer-identity)
//
// Solo prueba la función pura src/lib/customers/normalize-phone.ts — no
// toca la base de datos. El resolver de identidad (resolveOrCreateCustomer)
// requiere Postgres real y se verifica manualmente, no vía este script (ver
// docs/CUSTOMER_INTELLIGENCE_ARCHITECTURE_V1.md sección de plan de pruebas
// de la Fase 1 — no se comete un script automatizado que escriba en la base
// de datos de producción).

import { normalizePhone } from '../src/lib/customers/normalize-phone'

interface Case {
  label:            string
  input:            string | null | undefined
  expectedValid:    boolean
  expectedE164?:    string | null
  expectedCountry?: string | null
  expectedReason?:  string | null
}

const CASES: Case[] = [
  // ── Formatos dominicanos/NANP válidos ──────────────────────────────────
  { label: '10 dígitos RD',                 input: '8095551234',        expectedValid: true,  expectedE164: '+18095551234', expectedCountry: '1' },
  { label: '11 dígitos con 1',              input: '18095551234',       expectedValid: true,  expectedE164: '+18095551234', expectedCountry: '1' },
  { label: 'con +1',                        input: '+1 809 555 1234',   expectedValid: true,  expectedE164: '+18095551234', expectedCountry: '1' },
  { label: 'con guiones',                   input: '809-555-1234',      expectedValid: true,  expectedE164: '+18095551234', expectedCountry: '1' },
  { label: 'con paréntesis y espacios',     input: '(809) 555 1234',    expectedValid: true,  expectedE164: '+18095551234', expectedCountry: '1' },
  { label: 'código de área 829',            input: '8295551234',        expectedValid: true,  expectedE164: '+18295551234', expectedCountry: '1' },
  { label: 'código de área 849',            input: '8495551234',        expectedValid: true,  expectedE164: '+18495551234', expectedCountry: '1' },
  { label: 'con extensión',                 input: '809-555-1234 ext. 22', expectedValid: true, expectedE164: '+18095551234', expectedCountry: '1' },
  { label: 'con extensión formato x123',    input: '8095551234 x22',    expectedValid: true,  expectedE164: '+18095551234', expectedCountry: '1' },

  // ── Internacional explícito (no NANP) — reconocido, no forzado a RD ────
  { label: 'España +34 (no se fuerza RD)',  input: '+34 912 345 678',   expectedValid: true,  expectedE164: '+34912345678', expectedCountry: null },

  // ── Inválidos ───────────────────────────────────────────────────────────
  { label: 'vacío',                         input: '',                  expectedValid: false, expectedReason: 'empty' },
  { label: 'solo espacios',                 input: '   ',               expectedValid: false, expectedReason: 'empty' },
  { label: 'null',                          input: null,                expectedValid: false, expectedReason: 'empty' },
  { label: 'undefined',                     input: undefined,           expectedValid: false, expectedReason: 'empty' },
  { label: 'muy corto (5 dígitos)',         input: '12345',             expectedValid: false, expectedReason: 'too_short' },
  { label: 'muy largo (16 dígitos)',        input: '1234567890123456',  expectedValid: false, expectedReason: 'too_long' },
  { label: '11 dígitos sin 1 ni +',         input: '28095551234',       expectedValid: false, expectedReason: 'ambiguous_country_code' },
  { label: 'basura no numérica',            input: 'abc-def-ghij',      expectedValid: false, expectedReason: 'empty' },
]

let failures = 0

for (const c of CASES) {
  const result = normalizePhone(c.input)
  let pass = result.valid === c.expectedValid

  if (pass && c.expectedE164 !== undefined)    pass = result.normalized_e164 === c.expectedE164
  if (pass && c.expectedCountry !== undefined) pass = result.country_code === c.expectedCountry
  if (pass && c.expectedReason !== undefined)  pass = result.reason === c.expectedReason

  if (!pass) failures++
  console.log(
    `${pass ? '✅' : '❌'} normalizePhone(${JSON.stringify(c.input)}) → ` +
    `valid=${result.valid} e164=${result.normalized_e164} country=${result.country_code} reason=${result.reason} — ${c.label}`,
  )
}

// Guardia explícita del contrato: nunca se fuerza el prefijo '1' a un
// número internacional con '+' que claramente no es NANP.
const es = normalizePhone('+34912345678')
if (es.normalized_e164?.startsWith('+1')) {
  failures++
  console.log('❌ Guardia anti-falso-RD: un número +34 no debe normalizarse con prefijo +1')
} else {
  console.log('✅ Guardia anti-falso-RD: +34... no se fuerza a +1...')
}

if (failures > 0) {
  console.error(`\n${failures} prueba(s) fallaron.`)
  process.exit(1)
}
console.log(`\nTodas las pruebas de normalizePhone() pasaron (${CASES.length + 1}).`)
