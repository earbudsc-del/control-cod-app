// Zonas de entrega para santo_domingo_delivery_agent
// Cada zona tiene una tarifa base, términos de detección y colores UI.

export type ZoneId = 'norte' | 'este' | 'oeste' | 'centro' | 'san_cristobal' | 'otro'

export interface SdZone {
  id:         ZoneId
  label:      string   // "SD Norte"
  routeLabel: string   // "Ruta Norte"
  color:      string   // tailwind color prefix (sin bg-/text-)
  tarifa:     number   // RD$ por entrega
  terms:      string[] // términos normalizados para detección
}

export const SD_ZONES: SdZone[] = [
  {
    id:         'norte',
    label:      'SD Norte',
    routeLabel: 'Ruta Norte',
    color:      'blue',
    tarifa:     300,
    terms: [
      'villa mella', 'santo domingo norte', 'sdn', 'los guaricanos',
      'villas agricolas', 'sabana perdida', 'boca de soco', 'guerra',
    ],
  },
  {
    id:         'este',
    label:      'SD Este',
    routeLabel: 'Ruta Este',
    color:      'teal',
    tarifa:     275,
    terms: [
      'santo domingo este', 'sde', 'los mina', 'san luis', 'alma rosa',
      'ensanche isabelita', 'sabana larga sde', 'jardines del este',
    ],
  },
  {
    id:         'oeste',
    label:      'SD Oeste',
    routeLabel: 'Ruta Oeste',
    color:      'violet',
    tarifa:     280,
    terms: [
      'santo domingo oeste', 'sdo', 'herrera', 'los alcarrizos', 'km 12',
      'manoguayabo', 'pantoja', 'mendoza sdo', 'hato nuevo',
    ],
  },
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
    ],
  },
  {
    id:         'san_cristobal',
    label:      'San Cristóbal',
    routeLabel: 'Ruta Sur',
    color:      'orange',
    tarifa:     350,
    terms: ['san cristobal', 'san cristóbal', 'haina', 'nigua', 'villa altagracia'],
  },
]

const ZONA_OTRO: SdZone = {
  id:         'otro',
  label:      'Otra zona',
  routeLabel: 'Ruta General',
  color:      'gray',
  tarifa:     260,
  terms:      [],
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export function detectSdZone(
  city?:    string | null,
  province?: string | null,
  address?: string | null,
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
  // Preserve zone order defined above (+ 'otro' at end)
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

// Constantes de metas para el mensajero SD
export const SD_META_DIARIA  = 8
export const SD_META_SEMANAL = 40

// Colores Tailwind por zona (para uso en UI)
export const ZONE_COLORS: Record<ZoneId | 'otro', {
  bg: string; text: string; border: string; badge: string; bar: string
}> = {
  norte:        { bg: 'bg-blue-50',    text: 'text-blue-700',    border: 'border-blue-200',    badge: 'bg-blue-100 text-blue-700',    bar: 'bg-blue-500'    },
  este:         { bg: 'bg-teal-50',    text: 'text-teal-700',    border: 'border-teal-200',    badge: 'bg-teal-100 text-teal-700',    bar: 'bg-teal-500'    },
  oeste:        { bg: 'bg-violet-50',  text: 'text-violet-700',  border: 'border-violet-200',  badge: 'bg-violet-100 text-violet-700',  bar: 'bg-violet-500'  },
  centro:       { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', badge: 'bg-emerald-100 text-emerald-700', bar: 'bg-emerald-500' },
  san_cristobal:{ bg: 'bg-orange-50',  text: 'text-orange-700',  border: 'border-orange-200',  badge: 'bg-orange-100 text-orange-700',  bar: 'bg-orange-500'  },
  otro:         { bg: 'bg-gray-50',    text: 'text-gray-600',    border: 'border-gray-200',    badge: 'bg-gray-100 text-gray-600',    bar: 'bg-gray-400'    },
}
