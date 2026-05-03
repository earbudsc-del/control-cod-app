import type { NormalizedStatus } from '@/types'
import { detectStatus, DEFAULT_PATTERNS, type StatusPattern } from './attempt-detector'

// Mapeo de nombres de columna EFI → campo interno
const COLUMN_MAP: Record<string, string> = {
  'numero de guia':     'tracking_number',
  'no. guia':           'tracking_number',
  'no guia':            'tracking_number',
  '# guia':             'tracking_number',
  'guia':               'tracking_number',
  'tracking':           'tracking_number',
  'numero de pedido':   'order_number',
  'no. pedido':         'order_number',
  'pedido':             'order_number',
  'orden':              'order_number',
  'order':              'order_number',
  'nombre del cliente': 'customer_name',
  'nombre':             'customer_name',
  'cliente':            'customer_name',
  'telefono':           'customer_phone',
  'teléfono':           'customer_phone',
  'celular':            'customer_phone',
  'movil':              'customer_phone',
  'móvil':              'customer_phone',
  'tel':                'customer_phone',
  'direccion':          'customer_address',
  'dirección':          'customer_address',
  'address':            'customer_address',
  'ciudad':             'city',
  'provincia':          'province',
  'producto':           'product_summary',
  'descripcion':        'product_summary',
  'descripción':        'product_summary',
  'articulo':           'product_summary',
  'artículo':           'product_summary',
  'monto':              'cod_amount',
  'monto cod':          'cod_amount',
  'valor':              'cod_amount',
  'cobrar':             'cod_amount',
  'precio':             'cod_amount',
  'mensajero':          'carrier',
  'courier':            'carrier',
  'empresa':            'carrier',
  'estado':             'raw_status',
  'estatus':            'raw_status',
  'status':             'raw_status',
  'novedad':            'raw_status',
  'ultima novedad':     'raw_status',
  'última novedad':     'raw_status',
}

export interface ParsedOrder {
  tracking_number: string
  order_number?: string
  customer_name?: string
  customer_phone?: string
  customer_address?: string
  city?: string
  province?: string
  product_summary?: string
  cod_amount?: number
  carrier?: string
  raw_status?: string
  normalized_status: NormalizedStatus
  delivery_attempts: number
  is_at_risk: boolean
  row_index: number
  errors: string[]
}

export interface ParseResult {
  orders: ParsedOrder[]
  parse_errors: Array<{ row: number; message: string }>
  total_rows: number
  valid_rows: number
  column_map_used: Record<string, string>
}

function normalizeKey(header: string): string {
  return header.toLowerCase().trim().replace(/\s+/g, ' ')
}

function buildHeaderMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const h of headers) {
    const norm = normalizeKey(h)
    map[h] = COLUMN_MAP[norm] ?? norm.replace(/\s/g, '_')
  }
  return map
}

function cleanAmount(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const s = raw.trim().replace(/[^0-9.,]/g, '')
  if (!s) return undefined

  const hasComma = s.includes(',')
  const hasDot   = s.includes('.')

  if (hasComma && hasDot) {
    // "2.100,50" → 2100.50 (formato latinoamericano: punto=miles, coma=decimal)
    const n = parseFloat(s.replace(/\./g, '').replace(',', '.'))
    return isNaN(n) ? undefined : n
  }
  if (hasComma) {
    const [intPart, decPart] = s.split(',')
    if (decPart?.length === 3) {
      // "2,100" → 2100 (coma=separador de miles)
      const n = parseInt((intPart ?? '') + decPart, 10)
      return isNaN(n) ? undefined : n
    }
    // "2100,50" → 2100.5 (coma=decimal)
    const n = parseFloat(s.replace(',', '.'))
    return isNaN(n) ? undefined : n
  }
  if (hasDot) {
    const afterDot = s.split('.').pop() ?? ''
    if (afterDot.length === 3) {
      // "2.100" → 2100 (punto=separador de miles — formato latinoamericano)
      const n = parseFloat(s.replace(/\./g, ''))
      return isNaN(n) ? undefined : n
    }
    // "2.10" → 2.10 (punto=decimal)
    const n = parseFloat(s)
    return isNaN(n) ? undefined : n
  }

  const n = parseFloat(s)
  return isNaN(n) ? undefined : n
}

function parseRow(
  raw: Record<string, string>,
  headerMap: Record<string, string>,
  rowIndex: number,
  patterns: StatusPattern[],
): ParsedOrder {
  const mapped: Record<string, string> = {}
  for (const [header, value] of Object.entries(raw)) {
    const field = headerMap[header]
    if (field && value?.trim()) mapped[field] = value.trim()
  }

  const errors: string[] = []
  if (!mapped.tracking_number) errors.push('Número de guía faltante')

  const rawStatus = mapped.raw_status ?? ''
  const detection = detectStatus(rawStatus, patterns)

  let delivery_attempts: number
  if (detection.explicit_attempt_count !== null) {
    delivery_attempts = detection.explicit_attempt_count
  } else {
    delivery_attempts = detection.attempt_increment
  }

  return {
    tracking_number:  mapped.tracking_number ?? '',
    order_number:     mapped.order_number,
    customer_name:    mapped.customer_name,
    customer_phone:   mapped.customer_phone,
    customer_address: mapped.customer_address,
    city:             mapped.city,
    province:         mapped.province,
    product_summary:  mapped.product_summary,
    cod_amount:       cleanAmount(mapped.cod_amount),
    carrier:          mapped.carrier,
    raw_status:       rawStatus || undefined,
    normalized_status: detection.normalized_status,
    delivery_attempts,
    is_at_risk:       detection.is_at_risk,
    row_index:        rowIndex,
    errors,
  }
}

function processRows(
  rows: Record<string, string>[],
  patterns: StatusPattern[] = DEFAULT_PATTERNS,
): ParseResult {
  if (rows.length === 0) {
    return { orders: [], parse_errors: [], total_rows: 0, valid_rows: 0, column_map_used: {} }
  }

  const headerMap = buildHeaderMap(Object.keys(rows[0]))
  const orders: ParsedOrder[] = []
  const parse_errors: Array<{ row: number; message: string }> = []

  for (let i = 0; i < rows.length; i++) {
    const parsed = parseRow(rows[i], headerMap, i + 2, patterns)
    if (parsed.errors.length > 0) {
      parsed.errors.forEach(msg => parse_errors.push({ row: i + 2, message: msg }))
    }
    if (parsed.tracking_number) orders.push(parsed)
  }

  return {
    orders,
    parse_errors,
    total_rows: rows.length,
    valid_rows: orders.length,
    column_map_used: headerMap,
  }
}

// Parsear CSV usando PapaParse (browser-safe)
export async function parseCSV(
  text: string,
  patterns: StatusPattern[] = DEFAULT_PATTERNS,
): Promise<ParseResult> {
  const { parse } = await import('papaparse')
  return new Promise((resolve) => {
    parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => resolve(processRows(result.data, patterns)),
    })
  })
}

// Parsear Excel usando xlsx (browser-safe con ArrayBuffer)
export async function parseExcel(
  buffer: ArrayBuffer,
  patterns: StatusPattern[] = DEFAULT_PATTERNS,
): Promise<ParseResult> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(buffer, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
    raw: false,
    defval: '',
  })
  return processRows(rows, patterns)
}

export async function parseFile(
  file: File,
  patterns?: StatusPattern[],
): Promise<ParseResult> {
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (ext === 'csv') {
    const text = await file.text()
    return parseCSV(text, patterns)
  }
  if (ext === 'xlsx' || ext === 'xls') {
    const buffer = await file.arrayBuffer()
    return parseExcel(buffer, patterns)
  }
  throw new Error(`Formato no soportado: .${ext ?? 'desconocido'}`)
}
