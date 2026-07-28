// Zonas de entrega para santo_domingo_delivery_agent
// Cada zona tiene una tarifa base, términos de detección y colores UI.
//
// Política de cobertura:
//   DN Centro      → RD$250  (Distrito Nacional)
//   Norte/Este/Oeste → RD$300  (Gran Santo Domingo estándar)
//   Especial       → RD$350  (periféricas/alejadas: Boca Chica, Caleta, San Isidro…)
//   NO se entrega a San Cristóbal ni provincias externas.

export type ZoneId = 'norte' | 'este' | 'oeste' | 'centro' | 'especial' | 'otro'

export interface SdZone {
  id:         ZoneId
  label:      string    // "SD Norte"
  routeLabel: string    // "Ruta Norte"
  color:      string    // tailwind color prefix
  tarifa:     number    // RD$ por entrega
  terms:      string[]  // términos normalizados para detección
}

export const SD_ZONES: SdZone[] = [
  {
    id:         'centro',
    label:      'DN Centro',
    routeLabel: 'Ruta Centro',
    color:      'emerald',
    tarifa:     250,
    terms: [
      'distrito nacional', 'naco', 'piantini', 'serralles', 'gazcue',
      'zona colonial', 'bella vista', 'mirador norte', 'mirador sur',
      'paraiso', 'paraíso', 'miramar', 'evaristo morales', 'quisqueya',
      'ciudad universitaria', 'la feria', 'los prados', 'arroyo hondo',
      'cacicazgos', 'los cacicazgos', 'ensanche ozama',
    ],
  },
  {
    id:         'norte',
    label:      'SD Norte',
    routeLabel: 'Ruta Norte',
    color:      'blue',
    tarifa:     300,
    terms: [
      'villa mella', 'santo domingo norte', 'sdn', 'los guaricanos',
      'villas agricolas', 'sabana perdida', 'boca de soco', 'guerra',
      'sabana iglesia', 'el pedregal', 'palmarejo',
    ],
  },
  {
    id:         'oeste',
    label:      'SD Oeste',
    routeLabel: 'Ruta Oeste',
    color:      'violet',
    tarifa:     300,
    terms: [
      'santo domingo oeste', 'sdo', 'herrera', 'los alcarrizos', 'km 12',
      'manoguayabo', 'pantoja', 'mendoza sdo', 'hato nuevo',
      'monte san juan',
    ],
  },
  {
    // Zonas estándar del Este — SIN las áreas periféricas alejadas
    id:         'este',
    label:      'SD Este',
    routeLabel: 'Ruta Este',
    color:      'teal',
    tarifa:     300,
    terms: [
      'santo domingo este', 'sde', 'los mina', 'san luis', 'alma rosa',
      'ensanche isabelita', 'sabana larga', 'jardines del este',
      'ozama', 'villa hermosa', 'las americas',
    ],
  },
  {
    // Zonas especiales: periféricas o de acceso más complejo → tarifa mayor
    id:         'especial',
    label:      'Zona Especial',
    routeLabel: 'Ruta Especial',
    color:      'orange',
    tarifa:     350,
    terms: [
      'boca chica', 'caleta', 'san isidro', 'los tres brazos',
      'sabana abajo', 'villa faro', 'manoguayabo km 18',
      'hato viejo', 'palmar de ocoa', 'mata los indios',
    ],
  },
]

const ZONA_OTRO: SdZone = {
  id:         'otro',
  label:      'Otra SD',
  routeLabel: 'Ruta General',
  color:      'gray',
  tarifa:     300,
  terms:      [],
}

// Términos "genéricos" — el pedido dice la ciudad/provincia en general (ej.
// city="Santo Domingo" sin Este/Norte/Oeste), sin apuntar a un sector
// puntual de las zonas de arriba.
// Exportado: alert-helpers.ts lo reutiliza como señal fuerte de SD/DN cuando
// `province` no confirma la zona (ver isSantoDomingoOrder) — evita mantener
// una segunda copia de estos dos términos en otro archivo.
export const SD_GENERIC_TERMS = ['santo domingo', 'distrito nacional']

// Fuente ÚNICA de cobertura del Gran Santo Domingo — usada tanto para
// detectar zona/tarifa (detectSdZone, abajo) como para decidir si un pedido
// es SD interno en absoluto (isSantoDomingoOrder, en alert-helpers.ts).
// No debe existir una segunda lista de zonas cubiertas en ningún otro
// archivo — si falta un municipio/sector, se agrega aquí, en la zona que
// corresponda, y ambas funciones lo heredan automáticamente.
export const SD_COVERAGE_TERMS: string[] = [
  ...SD_GENERIC_TERMS,
  ...SD_ZONES.flatMap(z => z.terms),
]

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export function detectSdZone(
  city?:     string | null,
  province?: string | null,
  address?:  string | null,
): SdZone {
  const hay = norm(`${city ?? ''} ${province ?? ''} ${address ?? ''}`)
  for (const zone of SD_ZONES) {
    if (zone.terms.some(t => hay.includes(t))) return zone
  }
  return ZONA_OTRO
}

export function getZoneById(id: ZoneId | string): SdZone {
  return SD_ZONES.find(z => z.id === id) ?? ZONA_OTRO
}

export interface ZoneGroup<T> {
  zone:   SdZone
  orders: T[]
  // computed
  codTotal:         number
  gananciaEstimada: number
}

export function groupOrdersByZone<T extends {
  city?:             string | null
  province?:         string | null
  customer_address?: string | null
  cod_amount?:       number | null
}>(orders: T[]): ZoneGroup<T>[] {
  const map = new Map<ZoneId, T[]>()
  for (const o of orders) {
    const zone = detectSdZone(o.city, o.province, o.customer_address)
    const arr  = map.get(zone.id) ?? []
    arr.push(o)
    map.set(zone.id, arr)
  }

  const groups: ZoneGroup<T>[] = []
  const orderedIds: ZoneId[] = [...SD_ZONES.map(z => z.id), 'otro']
  for (const id of orderedIds) {
    const list = map.get(id)
    if (!list || list.length === 0) continue
    const zone = getZoneById(id)
    groups.push({
      zone,
      orders:           list,
      codTotal:         list.reduce((s, o) => s + (o.cod_amount ?? 0), 0),
      gananciaEstimada: list.length * zone.tarifa,
    })
  }
  return groups
}

// ── Metas ──────────────────────────────────────────────────────────────────────
export const SD_META_DIARIA  = 8
export const SD_META_SEMANAL = 40

// Promedio ponderado (mayoría de entregas en zonas RD$300)
export const SD_TARIFA_PROMEDIO = 290

// ── Bonificaciones e incentivos ────────────────────────────────────────────────
// Infraestructura para motivar al mensajero. Los montos son ajustables.

export interface SdBonus {
  id:        string
  label:     string
  emoji:     string
  amount:    number   // RD$ del bono
  condition: string   // texto visible para el mensajero
  earned:    boolean
}

export interface SdBonusConfig {
  metaDiaria:       number   // RD$ por cumplir meta del día (≥8 entregas)
  metaSemanal:      number   // RD$ por cumplir meta semanal (≥40 entregas)
  eficiencia90:     number   // RD$ por eficiencia ≥90% semanal
  sinReprogramacion:number   // RD$ por semana sin reprogramaciones
  streak3:          number   // RD$ por 3 días consecutivos
  streak5:          number   // RD$ por 5 días consecutivos
}

export const SD_BONUS_CONFIG: SdBonusConfig = {
  metaDiaria:        100,   // RD$100 al cumplir 8 entregas en el día
  metaSemanal:       500,   // RD$500 al cumplir 40 entregas en la semana
  eficiencia90:      200,   // RD$200 si eficiencia ≥90% semanal
  sinReprogramacion: 300,   // RD$300 si semana sin reprogramaciones
  streak3:           150,   // RD$150 por 3 días consecutivos
  streak5:           300,   // RD$300 por 5 días consecutivos
}

export function calcBonuses(params: {
  entregadosHoy:      number
  entregadosSemana:   number
  eficiencia:         number
  reprogramadosSemana:number
  streak:             number
}): { bonusHoy: number; bonusSemana: number; bonuses: SdBonus[] } {
  const cfg = SD_BONUS_CONFIG
  const { entregadosHoy, entregadosSemana, eficiencia, reprogramadosSemana, streak } = params

  const earnMetaDiaria       = entregadosHoy    >= SD_META_DIARIA
  const earnMetaSemanal      = entregadosSemana >= SD_META_SEMANAL
  const earnEficiencia       = eficiencia       >= 90
  const earnSinReprogramacion = reprogramadosSemana === 0 && entregadosSemana >= 5
  const earnStreak3          = streak >= 3
  const earnStreak5          = streak >= 5

  const bonuses: SdBonus[] = [
    {
      id:        'meta_diaria_bonus',
      label:     `Bono meta diaria`,
      emoji:     '🎯',
      amount:    cfg.metaDiaria,
      condition: `RD$${cfg.metaDiaria} al completar ${SD_META_DIARIA} entregas hoy`,
      earned:    earnMetaDiaria,
    },
    {
      id:        'meta_semanal_bonus',
      label:     'Bono meta semanal',
      emoji:     '🏆',
      amount:    cfg.metaSemanal,
      condition: `RD$${cfg.metaSemanal} al completar ${SD_META_SEMANAL} entregas esta semana`,
      earned:    earnMetaSemanal,
    },
    {
      id:        'eficiencia_bonus',
      label:     'Bono eficiencia',
      emoji:     '⚡',
      amount:    cfg.eficiencia90,
      condition: `RD$${cfg.eficiencia90} por eficiencia ≥90% en la semana`,
      earned:    earnEficiencia,
    },
    {
      id:        'sin_reprogramacion_bonus',
      label:     'Bono cero devoluciones',
      emoji:     '✅',
      amount:    cfg.sinReprogramacion,
      condition: `RD$${cfg.sinReprogramacion} si no reprogramas ninguna entrega esta semana`,
      earned:    earnSinReprogramacion,
    },
    {
      id:        'streak3_bonus',
      label:     'Bono racha 3 días',
      emoji:     '🔥',
      amount:    cfg.streak3,
      condition: `RD$${cfg.streak3} por 3 días seguidos cumpliendo tu meta`,
      earned:    earnStreak3 && !earnStreak5,
    },
    {
      id:        'streak5_bonus',
      label:     'Bono racha 5 días',
      emoji:     '💪',
      amount:    cfg.streak5,
      condition: `RD$${cfg.streak5} por 5 días seguidos cumpliendo tu meta`,
      earned:    earnStreak5,
    },
  ]

  const bonusHoy    = earnMetaDiaria ? cfg.metaDiaria : 0
  const bonusSemana = bonuses
    .filter(b => b.earned && b.id !== 'meta_diaria_bonus')
    .reduce((s, b) => s + b.amount, 0)

  return { bonusHoy, bonusSemana, bonuses }
}

// ── Colores Tailwind por zona ───────────────────────────────────────────────────
export const ZONE_COLORS: Record<ZoneId | 'otro', {
  bg: string; text: string; border: string; badge: string; bar: string
}> = {
  centro:   { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', badge: 'bg-emerald-100 text-emerald-700', bar: 'bg-emerald-500' },
  norte:    { bg: 'bg-blue-50',    text: 'text-blue-700',    border: 'border-blue-200',    badge: 'bg-blue-100 text-blue-700',    bar: 'bg-blue-500'    },
  oeste:    { bg: 'bg-violet-50',  text: 'text-violet-700',  border: 'border-violet-200',  badge: 'bg-violet-100 text-violet-700',  bar: 'bg-violet-500'  },
  este:     { bg: 'bg-teal-50',    text: 'text-teal-700',    border: 'border-teal-200',    badge: 'bg-teal-100 text-teal-700',    bar: 'bg-teal-500'    },
  especial: { bg: 'bg-orange-50',  text: 'text-orange-700',  border: 'border-orange-200',  badge: 'bg-orange-100 text-orange-700',  bar: 'bg-orange-500'  },
  otro:     { bg: 'bg-gray-50',    text: 'text-gray-600',    border: 'border-gray-200',    badge: 'bg-gray-100 text-gray-600',    bar: 'bg-gray-400'    },
}
