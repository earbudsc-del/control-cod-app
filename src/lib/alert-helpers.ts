// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface ZoneEntry {
  name:     string     // nombre canónico (para mostrar al agente)
  province: string
  terms?:   string[]   // términos de búsqueda alternativos (override al derivado del nombre)
}

export interface CoverageCheck {
  isOutOfCoverage:      boolean
  isSpecialDestination: boolean
  isUnknownZone:        boolean    // ciudad no reconocida en ninguna lista de la matriz
  matchedZones:         string[]   // nombres de zonas detectadas
}

// ── Normalización ─────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// "La Vega (Concepción de la Vega)" → ["la vega"]
// "Arroyo Toro - Masipedro"        → ["arroyo toro", "masipedro"]
function termsFromName(name: string): string[] {
  const primary = name.split(' (')[0].trim()
  return primary
    .split(' - ')
    .map(p => normalize(p.trim()))
    .filter(t => t.length >= 4)
}

// ── Zonas SIN cobertura (COBERTURA DESTINO = NO) ──────────────────────────────

export const OUT_OF_COVERAGE_ZONES: ZoneEntry[] = [
  // Azua
  { name: 'Las Charcas',              province: 'Azua' },
  { name: 'Las Yayas de Viajama',     province: 'Azua' },
  { name: 'Padre Las Casas',          province: 'Azua' },
  { name: 'Peralta',                  province: 'Azua' },
  { name: 'Pueblo Viejo',             province: 'Azua' },
  { name: 'Tábara Arriba',            province: 'Azua' },
  // Bahoruco
  { name: 'Los Ríos',                 province: 'Bahoruco' },
  { name: 'Tamayo',                   province: 'Bahoruco' },
  // Barahona
  { name: 'Enriquillo',               province: 'Barahona' },
  { name: 'La Ciénaga',               province: 'Barahona' },
  { name: 'Las Salinas',              province: 'Barahona' },
  { name: 'Paraíso',                  province: 'Barahona' },
  { name: 'Polo',                     province: 'Barahona' },
  { name: 'Vicente Noble',            province: 'Barahona' },
  // Dajabón
  { name: 'El Pino',                  province: 'Dajabón' },
  { name: 'Partido',                  province: 'Dajabón' },
  { name: 'Restauración',             province: 'Dajabón' },
  // Duarte
  { name: 'Arenoso',                  province: 'Duarte' },
  { name: 'Castillo',                 province: 'Duarte' },
  { name: 'Las Guáranas',             province: 'Duarte' },
  { name: 'Pimentel',                 province: 'Duarte' },
  { name: 'Villa Riva',               province: 'Duarte' },
  // El Seibo
  { name: 'Miches',                   province: 'El Seibo' },
  // Elías Piña
  { name: 'Bánica',                   province: 'Elías Piña' },
  { name: 'El Llano',                 province: 'Elías Piña' },
  { name: 'Hondo Valle',              province: 'Elías Piña' },
  { name: 'Juan Santiago',            province: 'Elías Piña' },
  { name: 'Pedro Santana',            province: 'Elías Piña' },
  // Espaillat
  { name: 'Gaspar Hernández',         province: 'Espaillat' },
  { name: 'Jamao Al Norte',           province: 'Espaillat' },
  // Hato Mayor
  { name: 'El Valle',                 province: 'Hato Mayor' },
  { name: 'Sabana de la Mar',         province: 'Hato Mayor' },
  // Hermanas Mirabal
  { name: 'Villa Tapia',              province: 'Hermanas Mirabal' },
  // Independencia
  // "Cristóbal" usa terms explícito: evita match con "San Cristóbal" (ciudad en cobertura)
  { name: 'Cristóbal',               province: 'Independencia', terms: ['cristobal independencia'] },
  { name: 'Duvergé',                  province: 'Independencia' },
  { name: 'La Descubierta',           province: 'Independencia' },
  // "Mella" usa terms explícito: evita match con "Villa Mella" (sector de Sto. Domingo Norte)
  { name: 'Mella',                    province: 'Independencia', terms: ['mella independencia'] },
  { name: 'Postrer Río',              province: 'Independencia' },
  // La Altagracia
  { name: 'Bayahíbe',                 province: 'La Altagracia' },
  { name: 'Boca de Yuma',             province: 'La Altagracia' },
  { name: 'Las Lagunas de Nisibón',   province: 'La Altagracia' },
  { name: 'San Rafael del Yuma',      province: 'La Altagracia' },
  // La Romana
  { name: 'Guaymate',                 province: 'La Romana' },
  // La Vega
  { name: 'Constanza',                province: 'La Vega' },
  { name: 'Jima Abajo',               province: 'La Vega' },
  // María Trinidad Sánchez
  { name: 'Cabrera',                  province: 'María Trinidad Sánchez' },
  { name: 'Río San Juan',             province: 'María Trinidad Sánchez' },
  // Monseñor Nouel
  { name: 'Maimón',                   province: 'Monseñor Nouel' },
  // Monte Cristi
  { name: 'Castañuelas',              province: 'Monte Cristi' },
  { name: 'Guayubín',                 province: 'Monte Cristi' },
  { name: 'Las Matas de Santa Cruz',  province: 'Monte Cristi' },
  { name: 'Pepillo Salcedo',          province: 'Monte Cristi' },
  // Monte Plata
  { name: 'Bayaguana',                province: 'Monte Plata' },
  { name: 'Peralvillo',               province: 'Monte Plata' },
  { name: 'Yamasá',                   province: 'Monte Plata' },
  // Pedernales
  { name: 'Oviedo',                   province: 'Pedernales' },
  // Peravia
  { name: 'Nizao',                    province: 'Peravia' },
  // Puerto Plata
  { name: 'Altamira',                 province: 'Puerto Plata' },
  { name: 'Guananico',                province: 'Puerto Plata' },
  { name: 'Imbert',                   province: 'Puerto Plata' },
  { name: 'Los Hidalgos',             province: 'Puerto Plata' },
  { name: 'Luperón',                  province: 'Puerto Plata' },
  { name: 'Villa Isabela',            province: 'Puerto Plata' },
  // San Cristóbal
  { name: 'Cambita Garabitos',        province: 'San Cristóbal' },
  { name: 'Los Cacaos',               province: 'San Cristóbal' },
  { name: 'Sabana Grande de Palenque',province: 'San Cristóbal' },
  { name: 'Yaguate',                  province: 'San Cristóbal' },
  // San José de Ocoa
  { name: 'Rancho Arriba',            province: 'San José de Ocoa' },
  // San Juan
  { name: 'Bohechío',                 province: 'San Juan' },
  { name: 'El Cercado',               province: 'San Juan' },
  { name: 'Las Matas de Farfán',      province: 'San Juan' },
  { name: 'Vallejuelo',               province: 'San Juan' },
  // San Pedro de Macorís
  { name: 'Guayacanes',               province: 'San Pedro de Macorís' },
  { name: 'Los Llanos',               province: 'San Pedro de Macorís' },
  { name: 'Quisqueya',                province: 'San Pedro de Macorís' },
  { name: 'Ramón Santana',            province: 'San Pedro de Macorís' },
  // Sánchez Ramírez
  { name: 'Cevicos',                  province: 'Sánchez Ramírez' },
  { name: 'Fantino',                  province: 'Sánchez Ramírez' },
  // Santiago
  { name: 'Baitoa',                   province: 'Santiago' },
  { name: 'Jánico',                   province: 'Santiago' },
  { name: 'Sabana Iglesia',           province: 'Santiago' },
  { name: 'San José de las Matas',    province: 'Santiago' },
  { name: 'Villa Bisonó',             province: 'Santiago' },
  { name: 'Navarrete',                province: 'Santiago' },
  // Santiago Rodríguez
  { name: 'Monción',                  province: 'Santiago Rodríguez' },
  // Santo Domingo
  { name: 'San Antonio de Guerra',    province: 'Santo Domingo' },
  // Valverde
  { name: 'Laguna Salada',            province: 'Valverde' },
]

// ── Destinos especiales (COBERTURA DESTINO = SI, DESTINO ESPECIAL = SI) ───────
// Llegamos pero requieren coordinación/precaución adicional.

export const SPECIAL_DESTINATION_ZONES: ZoneEntry[] = [
  // Azua
  { name: 'Estebanía',                     province: 'Azua' },
  { name: 'Las Barías',                    province: 'Azua' },
  { name: 'La Estancia',                   province: 'Azua' },
  { name: 'Sabana Yegua',                  province: 'Azua' },
  // Bahoruco
  { name: 'El Palmar',                     province: 'Bahoruco' },
  { name: 'Galván',                        province: 'Bahoruco' },
  { name: 'Villa Jaragua',                 province: 'Bahoruco' },
  // Barahona
  { name: 'Cabral',                        province: 'Barahona' },
  { name: 'El Cachón',                     province: 'Barahona' },
  { name: 'El Peñón',                      province: 'Barahona' },
  { name: 'Fundación',                     province: 'Barahona' },
  { name: 'Jaquimeyes',                    province: 'Barahona' },
  { name: 'La Guázara',                    province: 'Barahona' },
  { name: 'Pescadería',                    province: 'Barahona' },
  // Dajabón
  { name: 'Loma de Cabrera',               province: 'Dajabón' },
  { name: 'Santiago De La Cruz',           province: 'Dajabón' },
  // Duarte
  { name: 'Jaya',                          province: 'Duarte' },
  { name: 'La Peña',                       province: 'Duarte' },
  // Espaillat
  { name: 'Canca La Reina',               province: 'Espaillat' },
  { name: 'Cayetano Germosén',             province: 'Espaillat' },
  { name: 'El Higüerito',                  province: 'Espaillat' },
  { name: 'Juan López',                    province: 'Espaillat' },
  { name: 'La Ortega',                     province: 'Espaillat' },
  { name: 'San Víctor',                    province: 'Espaillat' },
  // Hato Mayor
  { name: 'Guayabo Dulce',                 province: 'Hato Mayor' },
  { name: 'Mata Palacio',                  province: 'Hato Mayor' },
  { name: 'Yerba Buena',                   province: 'Hato Mayor' },
  // Hermanas Mirabal
  { name: 'Tenares',                       province: 'Hermanas Mirabal' },
  // Independencia
  { name: 'Boca De Chacón',               province: 'Independencia' },
  { name: 'El Limón',                      province: 'Independencia' },
  // La Altagracia
  { name: 'Bávaro',                        province: 'La Altagracia' },
  { name: 'La otra Banda',                 province: 'La Altagracia' },
  { name: 'Verón',                         province: 'La Altagracia' },
  // La Vega
  { name: 'Buena Vista',                   province: 'La Vega' },
  { name: 'Jarabacoa',                     province: 'La Vega' },
  { name: 'Río Verde Arriba',              province: 'La Vega' },
  // María Trinidad Sánchez
  { name: 'Arroyo Al Medio',               province: 'María Trinidad Sánchez' },
  { name: 'El Factor',                     province: 'María Trinidad Sánchez' },
  // Monseñor Nouel
  { name: 'Jayaco',                        province: 'Monseñor Nouel' },
  { name: 'Juma Bejucal',                  province: 'Monseñor Nouel' },
  { name: 'La Salvia',                     province: 'Monseñor Nouel' },
  { name: 'Los Quemados',                  province: 'Monseñor Nouel' },
  { name: 'Piedra Blanca',                 province: 'Monseñor Nouel' },
  { name: 'Sabana Del Puerto',             province: 'Monseñor Nouel' },
  { name: 'Villa Sonador',                 province: 'Monseñor Nouel' },
  // Monte Cristi
  { name: 'Villa Vásquez',                 province: 'Monte Cristi' },
  // Pedernales
  { name: 'José Francisco Peña Gómez',    province: 'Pedernales' },
  // Peravia
  { name: 'Catalina',                      province: 'Peravia' },
  { name: 'Matanzas',                      province: 'Peravia' },
  // Puerto Plata
  { name: 'Villa Montellano',              province: 'Puerto Plata' },
  // San Cristóbal
  { name: 'El Carril',                     province: 'San Cristóbal' },
  { name: 'Haina',                         province: 'San Cristóbal' },
  { name: 'Hato Damas',                    province: 'San Cristóbal' },
  { name: 'Nigua',                         province: 'San Cristóbal' },
  { name: 'Villa Altagracia',              province: 'San Cristóbal' },
  // San Juan
  { name: 'El Rosario',                    province: 'San Juan' },
  { name: 'Hato Del Padre',               province: 'San Juan' },
  { name: 'Juan de Herrera',               province: 'San Juan' },
  // San Pedro de Macorís
  { name: 'Consuelo',                      province: 'San Pedro de Macorís' },
  // Sánchez Ramírez
  { name: 'La Bija',                       province: 'Sánchez Ramírez' },
  // Santiago
  { name: 'Canabacoa',                     province: 'Santiago' },
  { name: 'Canca La Piedra',              province: 'Santiago' },
  { name: 'Guayabal',                      province: 'Santiago' },
  { name: 'Las Palomas',                   province: 'Santiago' },
  { name: 'Licey al Medio',               province: 'Santiago' },
  { name: 'Puñal',                         province: 'Santiago' },
  { name: 'Tamboril',                      province: 'Santiago' },
  { name: 'Villa González',               province: 'Santiago' },
  // Santiago Rodríguez
  { name: 'Villa Los Almácigos',           province: 'Santiago Rodríguez' },
  // Santo Domingo
  { name: 'Boca Chica',                    province: 'Santo Domingo' },
  { name: 'La Caleta',                     province: 'Santo Domingo' },
  { name: 'La Guáyiga',                    province: 'Santo Domingo' },
  { name: 'Pedro Brand',                   province: 'Santo Domingo' },
  // Valverde
  { name: 'Ámina',                         province: 'Valverde' },
  { name: 'Esperanza',                     province: 'Valverde' },
  { name: 'Jaibón',                        province: 'Valverde' },
]

// ── Zonas CON cobertura normal (DESTINO = SI, ESPECIAL = NO) ─────────────────
// Solo para referencia/validación futura — no se usa en la detección de alertas.

export const COVERAGE_ZONES: ZoneEntry[] = [
  { name: 'Azua',                          province: 'Azua' },
  { name: 'Clavellina',                    province: 'Azua' },
  { name: 'Los Jovillos',                  province: 'Azua' },
  { name: 'Neiba',                         province: 'Bahoruco' },
  { name: 'Barahona',                      province: 'Barahona' },
  { name: 'Villa Central',                 province: 'Barahona' },
  { name: 'Cañongo',                       province: 'Dajabón' },
  { name: 'Dajabón',                       province: 'Dajabón' },
  { name: 'Santo Domingo',                 province: 'Distrito Nacional',   terms: ['santo domingo', 'sto domingo', 'sd', 'santo dgo'] },
  { name: 'San Francisco de Macorís',      province: 'Duarte' },
  { name: 'El Seibo',                      province: 'El Seibo' },
  { name: 'Santa Lucía',                   province: 'El Seibo' },
  { name: 'Comendador',                    province: 'Elías Piña' },
  { name: 'Moca',                          province: 'Espaillat' },
  { name: 'Monte De La Jagua',             province: 'Espaillat' },
  { name: 'Hato Mayor',                    province: 'Hato Mayor' },
  { name: 'Salcedo',                       province: 'Hermanas Mirabal' },
  { name: 'Jimaní',                        province: 'Independencia' },
  { name: 'Higüey',                        province: 'La Altagracia' },
  { name: 'Punta Cana',                    province: 'La Altagracia' },
  { name: 'La Romana',                     province: 'La Romana',           terms: ['la romana', 'romana'] },
  { name: 'Caleta',                        province: 'La Romana' },
  { name: 'Villa Hermosa',                 province: 'La Romana' },
  { name: 'La Vega',                       province: 'La Vega' },
  { name: 'Nagua',                         province: 'María Trinidad Sánchez' },
  { name: 'Arroyo Toro',                   province: 'Monseñor Nouel' },
  { name: 'Bonao',                         province: 'Monseñor Nouel' },
  { name: 'Monte Cristi',                  province: 'Monte Cristi' },
  { name: 'Monte Plata',                   province: 'Monte Plata' },
  { name: 'Sabana Grande de Boyá',         province: 'Monte Plata' },
  { name: 'Pedernales',                    province: 'Pedernales' },
  { name: 'Baní',                          province: 'Peravia' },
  { name: 'Paya',                          province: 'Peravia' },
  { name: 'Villa Sombrero',                province: 'Peravia' },
  { name: 'Puerto Plata',                  province: 'Puerto Plata' },
  { name: 'Sosúa',                         province: 'Puerto Plata' },
  { name: 'Las Terrenas',                  province: 'Samaná' },
  { name: 'Samaná',                        province: 'Samaná' },
  { name: 'Sánchez',                       province: 'Samaná' },
  { name: 'San Cristóbal',                 province: 'San Cristóbal' },
  { name: 'El Naranjal',                   province: 'San José de Ocoa' },
  { name: 'Sabana Larga',                  province: 'San José de Ocoa' },
  { name: 'San José de Ocoa',              province: 'San José de Ocoa' },
  { name: 'San Juan',                      province: 'San Juan' },
  { name: 'San Pedro de Macorís',          province: 'San Pedro de Macorís', terms: ['san pedro de macoris', 'san pedro', 'spm'] },
  { name: 'Cotuí',                         province: 'Sánchez Ramírez' },
  { name: 'La Mata',                       province: 'Sánchez Ramírez' },
  { name: 'Quitasueño',                    province: 'Sánchez Ramírez' },
  { name: 'Santiago de los Caballeros',    province: 'Santiago',            terms: ['santiago de los caballeros', 'santiago'] },
  { name: 'Sabaneta',                      province: 'Santiago Rodríguez' },
  { name: 'Santo Domingo Este',            province: 'Santo Domingo' },
  { name: 'Santo Domingo Norte',           province: 'Santo Domingo' },
  { name: 'Santo Domingo Oeste',           province: 'Santo Domingo' },
  { name: 'La Victoria',                   province: 'Santo Domingo' },
  { name: 'Los Alcarrizos',                province: 'Santo Domingo' },
  { name: 'Pantoja',                       province: 'Santo Domingo' },
  { name: 'San Luis',                      province: 'Santo Domingo' },
  { name: 'Boca De Mao',                   province: 'Valverde' },
  { name: 'Mao',                           province: 'Valverde' },
]

// ── Índices pre-calculados al cargar el módulo ────────────────────────────────

const _oocIndex  = OUT_OF_COVERAGE_ZONES.map(e      => ({ entry: e, terms: e.terms ?? termsFromName(e.name) }))
const _specIndex = SPECIAL_DESTINATION_ZONES.map(e  => ({ entry: e, terms: e.terms ?? termsFromName(e.name) }))
// Usado únicamente para determinar si la zona es "conocida" (no genera alertas propias)
const _covIndex  = COVERAGE_ZONES.map(e             => ({ entry: e, terms: e.terms ?? termsFromName(e.name) }))

// ── Función principal de detección ────────────────────────────────────────────

export function checkCoverage(
  address: string | null | undefined,
  city:    string | null | undefined,
): CoverageCheck {
  const haystack = normalize(`${address ?? ''} ${city ?? ''}`)

  if (!haystack.trim()) {
    return { isOutOfCoverage: false, isSpecialDestination: false, isUnknownZone: false, matchedZones: [] }
  }

  const matchedOoc  = _oocIndex.filter(e  => e.terms.some(t => haystack.includes(t)))
  const matchedSpec = _specIndex.filter(e => e.terms.some(t => haystack.includes(t)))
  const matchedCov  = _covIndex.filter(e  => e.terms.some(t => haystack.includes(t)))

  const knownZone = matchedOoc.length > 0 || matchedSpec.length > 0 || matchedCov.length > 0

  return {
    isOutOfCoverage:      matchedOoc.length > 0,
    isSpecialDestination: matchedSpec.length > 0,
    isUnknownZone:        !knownZone,
    matchedZones:         [
      ...matchedOoc.map(e  => e.entry.name),
      ...matchedSpec.map(e => e.entry.name),
    ],
  }
}
