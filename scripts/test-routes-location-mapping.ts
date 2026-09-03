// Pruebas de regresión — mapeo de coordenadas en rutas derivadas
// (src/lib/deliveries/routes.ts, buildDerivedRoutes).
//
// Corre con: npx tsx scripts/test-routes-location-mapping.ts
// (o: npm run test:routes-location)
//
// Bug que cubre (auditoría Mis Rutas / Ruta Norte, 2026-09-03): los 4
// endpoints GET/POST /api/v1/deliveries/routes* nunca seleccionaban
// sd_location_lat/sd_location_lng en su query a `orders`. RouteOrderRow tenía
// campos `latitude?`/`longitude?` que ningún SELECT poblaba nunca — quedaban
// `undefined` siempre, así que `hasLocation` daba `false` para el 100% de las
// paradas de toda ruta, sin importar el dato real en DB. Fix: RouteOrderRow
// ahora usa los nombres de columna reales (`sd_location_lat`/`sd_location_lng`,
// mismos que ORDER_FIELDS de GET /api/v1/deliveries/orders) y
// buildDerivedRoutes() los mapea explícitamente a `latitude`/`longitude` en el
// DTO de salida (DerivedStop) — el contrato hacia Ruta COD no cambia.
//
// Pruebas puras — sin conexión a Supabase, sin datos reales. buildDerivedRoutes
// es una función determinista (mismo patrón que sd-status.ts/routes.ts: sin
// I/O), así que se prueba directo con snapshots sintéticos.

import { buildDerivedRoutes, type RouteOrderRow } from '../src/lib/deliveries/routes'
import type { LatestAction } from '../src/lib/deliveries/sd-status'

let failures = 0

function assertEqual(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`${pass ? '✅' : '❌'} ${label} — esperado=${JSON.stringify(expected)} obtenido=${JSON.stringify(actual)}`)
}

function baseOrder(overrides: Partial<RouteOrderRow>): RouteOrderRow {
  return {
    id: 'order-1',
    city: 'Santo Domingo Norte', // matchea isSantoDomingoOrder Y zone.id='norte' (sd-zones.ts)
    province: 'Santo Domingo',
    customer_address: 'Calle Test #1',
    tracking_number: null,
    normalized_status: 'en_reparto',
    confirmation_status: 'confirmed',
    assigned_to: 'courier-1',
    order_number: '#1001',
    customer_name: 'Cliente Test',
    customer_phone: '8090000000',
    cod_amount: 2100,
    sd_location_lat: null,
    sd_location_lng: null,
    created_at: '2026-09-01T10:00:00Z',
    status_since: '2026-09-01T10:00:00Z',
    last_tracking_update: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    ...overrides,
  }
}

function firstStop(orders: RouteOrderRow[], latestByOrder: Map<string, LatestAction> = new Map()) {
  const { stopsByRoute } = buildDerivedRoutes({ orders, latestByOrder, courierId: 'courier-1', role: 'santo_domingo_delivery_agent' })
  const allStops = [...stopsByRoute.values()].flat()
  return allStops[0]
}

// ── CASO A: sd_location_lat/lng presentes → hasLocation=true ───────────────
{
  const orders = [baseOrder({ id: 'a', sd_location_lat: 18.5203, sd_location_lng: -69.9012 })]
  const stop = firstStop(orders)
  assertEqual('A: hasLocation=true con ambas coordenadas presentes', stop.hasLocation, true)
}

// ── CASO B: ambas null → hasLocation=false ──────────────────────────────────
{
  const orders = [baseOrder({ id: 'b', sd_location_lat: null, sd_location_lng: null })]
  const stop = firstStop(orders)
  assertEqual('B: hasLocation=false con ambas coordenadas null', stop.hasLocation, false)
}

// ── CASO C: solo una coordenada presente → hasLocation=false ───────────────
{
  const orders1 = [baseOrder({ id: 'c1', sd_location_lat: 18.5203, sd_location_lng: null })]
  assertEqual('C1: hasLocation=false con solo latitud presente', firstStop(orders1).hasLocation, false)

  const orders2 = [baseOrder({ id: 'c2', sd_location_lat: null, sd_location_lng: -69.9012 })]
  assertEqual('C2: hasLocation=false con solo longitud presente', firstStop(orders2).hasLocation, false)
}

// ── CASO D: coordenadas válidas se transportan correctamente al DTO ────────
{
  const orders = [baseOrder({ id: 'd', sd_location_lat: 18.5203, sd_location_lng: -69.9012 })]
  const stop = firstStop(orders)
  assertEqual('D: latitude en el DTO coincide con sd_location_lat de origen', stop.latitude, 18.5203)
  assertEqual('D: longitude en el DTO coincide con sd_location_lng de origen', stop.longitude, -69.9012)
}

// ── CASO E: zone/sequence/status permanecen iguales con o sin coordenadas ──
{
  const withoutCoords = [baseOrder({ id: 'e', sd_location_lat: null, sd_location_lng: null })]
  const withCoords = [baseOrder({ id: 'e', sd_location_lat: 18.5203, sd_location_lng: -69.9012 })]
  const latestByOrder = new Map<string, LatestAction>([['e', 'route_confirmed']]) // fuerza status='en_ruta'

  const resultWithout = buildDerivedRoutes({ orders: withoutCoords, latestByOrder, courierId: 'courier-1', role: 'santo_domingo_delivery_agent' })
  const resultWith = buildDerivedRoutes({ orders: withCoords, latestByOrder, courierId: 'courier-1', role: 'santo_domingo_delivery_agent' })

  const stopWithout = [...resultWithout.stopsByRoute.values()].flat()[0]
  const stopWith = [...resultWith.stopsByRoute.values()].flat()[0]
  const routeWithout = resultWithout.routes[0]
  const routeWith = resultWith.routes[0]

  assertEqual('E: zoneKey no cambia por tener/no tener coordenadas', routeWith.zoneKey, routeWithout.zoneKey)
  assertEqual('E: route.id (zoneKey_fecha) no cambia', routeWith.id, routeWithout.id)
  assertEqual('E: stop.sequence no cambia', stopWith.sequence, stopWithout.sequence)
  assertEqual('E: stop.status no cambia', stopWith.status, stopWithout.status)
  assertEqual("E: status='en_ruta' preservado (route_confirmed)", stopWith.status, 'en_ruta')
  assertEqual("E: route.status='activa' preservado", routeWith.status, 'activa')
}

// ── Extra: mezcla realista — 3 paradas, solo una con ubicación ─────────────
{
  const orders = [
    baseOrder({ id: 'mix-1', order_number: '#1', sd_location_lat: 18.52, sd_location_lng: -69.90 }),
    baseOrder({ id: 'mix-2', order_number: '#2', sd_location_lat: null, sd_location_lng: null }),
    baseOrder({ id: 'mix-3', order_number: '#3', sd_location_lat: null, sd_location_lng: null }),
  ]
  const { routes, stopsByRoute } = buildDerivedRoutes({ orders, latestByOrder: new Map(), courierId: 'courier-1', role: 'santo_domingo_delivery_agent' })
  const stops = [...stopsByRoute.values()].flat()
  assertEqual('extra: 3 paradas en la misma ruta (misma zona)', stops.length, 3)
  assertEqual('extra: stopsWithLocation=1 en el resumen de ruta', routes[0].stopsWithLocation, 1)
  assertEqual('extra: stopsPendingLocation=2 en el resumen de ruta', routes[0].stopsPendingLocation, 2)
  const withLoc = stops.filter(s => s.hasLocation)
  assertEqual('extra: exactamente 1 stop con hasLocation=true', withLoc.length, 1)
  assertEqual('extra: es específicamente mix-1', withLoc[0]?.orderId, 'mix-1')
}

if (failures > 0) {
  console.error(`\n${failures} prueba(s) fallaron.`)
  process.exit(1)
}
console.log('\nTodas las pruebas de mapeo de ubicación en rutas pasaron.')
