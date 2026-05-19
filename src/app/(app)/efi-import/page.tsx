'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Upload, CheckCircle2, AlertTriangle, X,
  ChevronDown, ChevronUp, Link2, FileText, RefreshCw,
} from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import type { ImportResponse, ImportResult, ImportSummary } from '@/app/api/admin/reconcile-efi-import/route'
import type { BackfillResponse, BackfillResult, BackfillSummary } from '@/app/api/admin/backfill-imported-order-data/route'

// ── CSV parsing ────────────────────────────────────────────────────────────────

const TRACKING_KEYS = [
  'tracking number', 'tracking', 'guide number', 'guide',
  'numero de guia', 'no. guia', 'no guia', '# guia', 'guia', 'numero guia',
]
const PHONE_KEYS = [
  'phone', 'phone number',
  'telefono', 'celular', 'movil', 'tel', 'cel', 'contacto',
  'customer phone',          // de customer_phone (snake → espacio)
  'telefonos destinatario',  // columna EFI "Teléfonos destinatario"
]
const ESTADO_KEYS = [
  'status',
  'raw status',              // raw_status — columna del export EFI histórico
  'estado', 'estatus', 'novedad', 'ultima novedad',
]
const NOMBRE_KEYS = [
  'customer name', 'customer', 'name',
  'nombre del cliente', 'nombre', 'cliente', 'destinatario', 'receptor',
]
const CIUDAD_KEYS = [
  'city',
  'ciudad', 'municipio',
  'customer city',     // de customer_city
  'ciudad/provincia',  // columna EFI exacta (norm no convierte /)
  'provincia',
]
const ADDRESS_KEYS = [
  'customer address',         // de customer_address
  'address',
  'direccion destinatario',   // "Dirección destinatario"
  'direccion',
  'direccion del destinatario',
]

const WHITESPACE_DELIM = 'WHITESPACE'

interface ParsedRow {
  tracking_number: string
  phone:           string
  estado?:         string
  nombre?:         string
  ciudad?:         string
  address?:        string
  _rowIndex:       number
  _parseError?:    string
}

interface ColumnDetection {
  trackingCol: string | null
  phoneCol:    string | null
  estadoCol:   string | null
  nombreCol:   string | null
  ciudadCol:   string | null
  addressCol:  string | null
  delimiter:   string
  allHeaders:  string[]
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanCell(s: string): string {
  return s.replace(/^["'\s]+|["'\s]+$/g, '')
}

function splitLine(line: string, delimiter: string): string[] {
  if (delimiter === WHITESPACE_DELIM) {
    return line.trim().split(/\s+/)
  }
  const result: string[] = []
  let current = ''
  let inQuote = false
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote }
    else if (ch === delimiter && !inQuote) { result.push(cleanCell(current)); current = '' }
    else { current += ch }
  }
  result.push(cleanCell(current))
  return result
}

function headersMatchImport(tokens: string[]): boolean {
  const normed = tokens.map(norm)
  return normed.some(h => TRACKING_KEYS.includes(h)) && normed.some(h => PHONE_KEYS.includes(h))
}

function headersMatchBackfill(tokens: string[]): boolean {
  const normed = tokens.map(norm)
  return normed.some(h => TRACKING_KEYS.includes(h))
}

function detectBestDelimiter(headerLine: string, mode: Mode): string {
  const matcher = mode === 'backfill' ? headersMatchBackfill : headersMatchImport
  for (const delim of ['\t', ';', ',']) {
    if (headerLine.includes(delim) && matcher(headerLine.split(delim))) return delim
  }
  if (matcher(headerLine.trim().split(/\s+/))) return WHITESPACE_DELIM
  return ','
}

function detectColumns(headers: string[], delimiter: string): ColumnDetection {
  const find = (keys: string[]) => headers.find(h => keys.includes(norm(h))) ?? null
  return {
    trackingCol: find(TRACKING_KEYS),
    phoneCol:    find(PHONE_KEYS),
    estadoCol:   find(ESTADO_KEYS),
    nombreCol:   find(NOMBRE_KEYS),
    ciudadCol:   find(CIUDAD_KEYS),
    addressCol:  find(ADDRESS_KEYS),
    delimiter,
    allHeaders:  headers,
  }
}

function parseCSVText(
  text: string,
  mode: Mode,
): { rows: ParsedRow[]; detection: ColumnDetection; error?: string } {
  const empty: ColumnDetection = {
    trackingCol: null, phoneCol: null, estadoCol: null,
    nombreCol: null, ciudadCol: null, addressCol: null,
    delimiter: ',', allHeaders: [],
  }

  const lines = text.trim().split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) {
    return { rows: [], detection: empty, error: 'El CSV debe tener al menos una fila de encabezados y una fila de datos.' }
  }

  const delimiter = detectBestDelimiter(lines[0]!, mode)
  const headers   = splitLine(lines[0]!, delimiter)
  const detection = detectColumns(headers, delimiter)

  if (!detection.trackingCol) {
    return {
      rows: [], detection,
      error: `No se detectó columna de guía. Columnas reconocidas: tracking_number, Guía, No. Guia, Tracking. Encabezados encontrados: "${headers.join('", "')}"`,
    }
  }

  if (mode === 'import' && !detection.phoneCol) {
    return {
      rows: [], detection,
      error: `No se detectó columna de teléfono. Columnas reconocidas: phone, Teléfono, Celular, Tel. Encabezados encontrados: "${headers.join('", "')}"`,
    }
  }

  const trackingIdx = headers.indexOf(detection.trackingCol)
  const phoneIdx    = detection.phoneCol  ? headers.indexOf(detection.phoneCol)  : -1
  const estadoIdx   = detection.estadoCol ? headers.indexOf(detection.estadoCol) : -1
  const nombreIdx   = detection.nombreCol ? headers.indexOf(detection.nombreCol) : -1
  const ciudadIdx   = detection.ciudadCol ? headers.indexOf(detection.ciudadCol) : -1
  const addressIdx  = detection.addressCol ? headers.indexOf(detection.addressCol) : -1

  const rows: ParsedRow[] = []

  for (let i = 1; i < lines.length; i++) {
    const cols     = splitLine(lines[i]!, delimiter)
    const tracking = cleanCell(cols[trackingIdx] ?? '')
    const phone    = phoneIdx >= 0 ? cleanCell(cols[phoneIdx] ?? '') : ''

    if (!tracking && !phone) continue

    const missingTracking = !tracking
    const missingPhone    = mode === 'import' && !phone

    rows.push({
      tracking_number: tracking,
      phone,
      estado:  estadoIdx  >= 0 ? cleanCell(cols[estadoIdx]  ?? '') || undefined : undefined,
      nombre:  nombreIdx  >= 0 ? cleanCell(cols[nombreIdx]  ?? '') || undefined : undefined,
      ciudad:  ciudadIdx  >= 0 ? cleanCell(cols[ciudadIdx]  ?? '') || undefined : undefined,
      address: addressIdx >= 0 ? cleanCell(cols[addressIdx] ?? '') || undefined : undefined,
      _rowIndex:   i,
      _parseError: (missingTracking || missingPhone)
        ? `guía="${tracking}"${missingPhone ? ` o teléfono="${phone}" vacío` : ' vacía'}`
        : undefined,
    })
  }

  return { rows, detection }
}

function delimLabel(d: string): string {
  if (d === '\t')             return 'TAB'
  if (d === ';')              return 'punto y coma (;)'
  if (d === ',')              return 'coma (,)'
  if (d === WHITESPACE_DELIM) return 'espacios'
  return d
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  in_transit: 'Tránsito',
  en_reparto: 'En reparto',
  novedad:    'Novedad',
  delivered:  'Entregada',
  returned:   'Devuelta',
  pending:    'Pendiente',
  unknown:    'Desconocido',
}

type SummaryColor = 'gray' | 'green' | 'emerald' | 'blue' | 'amber' | 'red'

function SummaryCard({ label, value, color }: { label: string; value: number; color: SummaryColor }) {
  const cls: Record<SummaryColor, string> = {
    gray:    'bg-gray-50 border-gray-200 text-gray-700',
    green:   'bg-green-50 border-green-200 text-green-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    blue:    'bg-blue-50 border-blue-200 text-blue-700',
    amber:   'bg-amber-50 border-amber-200 text-amber-700',
    red:     'bg-red-50 border-red-200 text-red-700',
  }
  return (
    <div className={`rounded-xl border p-3 ${cls[color]}`}>
      <p className="text-2xl font-black tabular-nums">{value.toLocaleString()}</p>
      <p className="text-xs font-semibold mt-1 opacity-80">{label}</p>
    </div>
  )
}

interface ResultSectionProps {
  title:     string
  items:     ImportResult[]
  color:     'green' | 'amber' | 'blue' | 'red'
  expanded:  boolean
  onToggle:  () => void
  columns:   string[]
  renderRow: (r: ImportResult) => (string | null | undefined)[]
}

function ResultSection({ title, items, color, expanded, onToggle, columns, renderRow }: ResultSectionProps) {
  if (items.length === 0) return null
  const border: Record<string, string> = { green: 'border-green-200', amber: 'border-amber-200', blue: 'border-blue-200', red: 'border-red-200' }
  const header: Record<string, string> = {
    green: 'bg-green-50 border-green-100 text-green-800 hover:bg-green-100',
    amber: 'bg-amber-50 border-amber-100 text-amber-800 hover:bg-amber-100',
    blue:  'bg-blue-50 border-blue-100 text-blue-800 hover:bg-blue-100',
    red:   'bg-red-50 border-red-100 text-red-800 hover:bg-red-100',
  }
  return (
    <div className={`bg-white rounded-xl border-2 overflow-hidden ${border[color]}`}>
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between px-4 py-3 border-b text-sm font-semibold transition-colors ${header[color]}`}
      >
        <span>{title}</span>
        {expanded ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
      </button>
      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>{columns.map(c => <th key={c} className="px-3 py-2 text-left text-xs font-semibold text-gray-600">{c}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {items.map((r, i) => (
                <tr key={i} className="hover:bg-gray-50/60">
                  {renderRow(r).map((cell, j) => <td key={j} className="px-3 py-2 text-gray-700 font-mono text-xs">{cell ?? '—'}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Backfill result sections ───────────────────────────────────────────────────

interface BackfillSectionProps {
  title:    string
  items:    BackfillResult[]
  color:    'green' | 'amber' | 'blue' | 'red'
  expanded: boolean
  onToggle: () => void
}

function BackfillSection({ title, items, color, expanded, onToggle }: BackfillSectionProps) {
  if (items.length === 0) return null
  const border: Record<string, string> = { green: 'border-green-200', amber: 'border-amber-200', blue: 'border-blue-200', red: 'border-red-200' }
  const header: Record<string, string> = {
    green: 'bg-green-50 border-green-100 text-green-800 hover:bg-green-100',
    amber: 'bg-amber-50 border-amber-100 text-amber-800 hover:bg-amber-100',
    blue:  'bg-blue-50 border-blue-100 text-blue-800 hover:bg-blue-100',
    red:   'bg-red-50 border-red-100 text-red-800 hover:bg-red-100',
  }
  return (
    <div className={`bg-white rounded-xl border-2 overflow-hidden ${border[color]}`}>
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between px-4 py-3 border-b text-sm font-semibold transition-colors ${header[color]}`}
      >
        <span>{title}</span>
        {expanded ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
      </button>
      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Guía</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Pedido</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Campos rellenados</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {items.map((r, i) => (
                <tr key={i} className="hover:bg-gray-50/60">
                  <td className="px-3 py-2 text-gray-700 font-mono text-xs">{r.tracking_number}</td>
                  <td className="px-3 py-2 text-gray-700 font-mono text-xs">{r.order_number ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-700 text-xs">{r.fields_filled?.join(', ') ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

type Step = 'input' | 'preview' | 'processing' | 'results'
type Mode = 'import' | 'backfill'

export default function EfiImportPage() {
  const [step, setStep]             = useState<Step>('input')
  const [mode, setMode]             = useState<Mode>('import')
  const [csvText, setCsvText]       = useState('')
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([])
  const [detection, setDetection]   = useState<ColumnDetection | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [response, setResponse]     = useState<ImportResponse | null>(null)
  const [backfillResponse, setBackfillResponse] = useState<BackfillResponse | null>(null)
  const [dragging, setDragging]     = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [expandSection, setExpandSection] = useState({
    auto_assigned:    true,
    needs_review:     true,
    already_assigned: false,
    errors:           true,
    bf_updated:       true,
    bf_missing:       false,
  })
  const [processingElapsed, setProcessingElapsed] = useState(0)
  const processingStartRef = useRef<number | null>(null)

  useEffect(() => {
    if (step !== 'processing') {
      processingStartRef.current = null
      setProcessingElapsed(0)
      return
    }
    processingStartRef.current = Date.now()
    const interval = setInterval(() => {
      setProcessingElapsed(Math.floor((Date.now() - (processingStartRef.current ?? Date.now())) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [step])

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleParse = useCallback((text: string, currentMode: Mode) => {
    setParseError(null)
    const { rows, detection: det, error } = parseCSVText(text, currentMode)
    setDetection(det)

    if (error) { setParseError(error); return }
    if (rows.length === 0) { setParseError('No se encontraron filas de datos en el CSV.'); return }

    setParsedRows(rows)
    setStep('preview')
  }, [])

  const handleFile = useCallback(async (file: File) => {
    const text = await file.text()
    setCsvText(text)
    handleParse(text, mode)
  }, [handleParse, mode])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  function switchMode(newMode: Mode) {
    setMode(newMode)
    setParseError(null)
    if (step === 'preview') {
      // Re-parse con nuevo modo
      handleParse(csvText, newMode)
    }
  }

  async function handleProcess() {
    setSubmitError(null)
    setStep('processing')

    if (mode === 'import') {
      const validItems = validRows
        .filter(r => r.tracking_number && r.phone && !r._parseError)
        .map(r => ({
          tracking_number: r.tracking_number,
          phone:           r.phone,
          estado:          r.estado,
          nombre:          r.nombre,
          ciudad:          r.ciudad,
          address:         r.address,
        }))

      try {
        const res  = await fetch('/api/admin/reconcile-efi-import', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ items: validItems }),
        })
        const data = await res.json()
        if (!res.ok) { setSubmitError(data.error ?? 'Error al procesar'); setStep('preview'); return }
        setResponse(data as ImportResponse)
        setStep('results')
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Error de red')
        setStep('preview')
      }
    } else {
      // Backfill mode
      const validItems = validRows
        .filter(r => r.tracking_number && !r._parseError)
        .map(r => ({
          tracking_number:  r.tracking_number,
          customer_phone:   r.phone   || undefined,
          customer_address: r.address || undefined,
          customer_city:    r.ciudad  || undefined,
          customer_name:    r.nombre  || undefined,
        }))

      try {
        const res  = await fetch('/api/admin/backfill-imported-order-data', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ items: validItems }),
        })
        const data = await res.json()
        if (!res.ok) { setSubmitError(data.error ?? 'Error al procesar'); setStep('preview'); return }
        setBackfillResponse(data as BackfillResponse)
        setStep('results')
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Error de red')
        setStep('preview')
      }
    }
  }

  function reset() {
    setStep('input')
    setCsvText('')
    setParsedRows([])
    setDetection(null)
    setParseError(null)
    setResponse(null)
    setBackfillResponse(null)
    setSubmitError(null)
  }

  const validRows   = mode === 'import'
    ? parsedRows.filter(r => r.tracking_number && r.phone && !r._parseError)
    : parsedRows.filter(r => r.tracking_number && !r._parseError)
  const invalidRows = parsedRows.filter(r => r._parseError || !r.tracking_number || (mode === 'import' && !r.phone))

  const stepKeys: Step[] = ['input', 'preview', 'processing', 'results']
  const stepLabels = ['Subir CSV', 'Vista previa', 'Procesar', 'Resultados']
  const currentStepIdx = stepKeys.indexOf(step)

  const isBackfill = mode === 'backfill'

  return (
    <div className="space-y-4">

      {/* ── BANNER ── */}
      <div className={`relative overflow-hidden rounded-2xl border-2 shadow-lg ${isBackfill ? 'bg-gradient-to-r from-teal-500 to-cyan-600 border-teal-400 shadow-teal-200/50' : 'bg-gradient-to-r from-orange-500 to-amber-600 border-orange-400 shadow-orange-200/50'}`}>
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white" />
          <div className="absolute -left-4 -bottom-4 w-24 h-24 rounded-full bg-white" />
        </div>
        <div className="relative px-6 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-12 h-12 bg-white/20 rounded-xl shrink-0">
              {isBackfill ? <RefreshCw className="w-6 h-6 text-white" /> : <Link2 className="w-6 h-6 text-white" />}
            </div>
            <div>
              <h1 className="text-xl font-black text-white">
                {isBackfill ? 'Actualizar datos faltantes' : 'Importar guías EFI'}
              </h1>
              <p className="text-white/80 text-sm font-medium">
                {isBackfill
                  ? 'Rellena teléfono/dirección/ciudad de guías ya importadas — sin tocar estados logísticos'
                  : 'Reconciliación masiva desde exportación EFI — sin llamadas EFI, solo DB'}
              </p>
            </div>
          </div>
          {step !== 'input' && (
            <button
              onClick={reset}
              className="flex items-center gap-2 bg-white/20 hover:bg-white/30 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
              Nueva
            </button>
          )}
        </div>
      </div>

      {/* ── STEP INDICATOR ── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex items-stretch divide-x divide-gray-100">
          {stepLabels.map((label, i) => {
            const isActive = i === currentStepIdx
            const isDone   = i < currentStepIdx
            return (
              <div key={label}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-3 text-xs font-semibold
                  ${isActive ? (isBackfill ? 'bg-teal-50 text-teal-700' : 'bg-orange-50 text-orange-700') : isDone ? 'text-green-600' : 'text-gray-400'}`}>
                {isDone
                  ? <CheckCircle2 className="w-4 h-4 shrink-0" />
                  : <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs font-bold shrink-0
                      ${isActive ? (isBackfill ? 'border-teal-500 text-teal-600' : 'border-orange-500 text-orange-600') : 'border-gray-300 text-gray-400'}`}>{i + 1}</span>
                }
                <span className="hidden sm:inline truncate">{label}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── STEP: INPUT ── */}
      {step === 'input' && (
        <div className="space-y-4">

          {/* Mode toggle */}
          <div className="bg-white rounded-xl border border-gray-200 p-1 flex gap-1">
            <button
              onClick={() => switchMode('import')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-colors
                ${mode === 'import' ? 'bg-orange-500 text-white shadow-sm' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              <Link2 className="w-4 h-4" />
              Importar guías nuevas
            </button>
            <button
              onClick={() => switchMode('backfill')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-colors
                ${mode === 'backfill' ? 'bg-teal-500 text-white shadow-sm' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              <RefreshCw className="w-4 h-4" />
              Actualizar datos faltantes
            </button>
          </div>

          {/* Description */}
          {isBackfill && (
            <div className="bg-teal-50 border border-teal-100 rounded-xl p-4 text-sm text-teal-800">
              <p className="font-semibold mb-1">Modo: Actualizar datos faltantes de guías ya importadas</p>
              <p className="text-teal-700 text-xs">Sube el CSV de EFI con teléfono, dirección y/o ciudad. El sistema busca cada guía en DB y rellena los campos vacíos — sin sobrescribir datos existentes, sin tocar estados logísticos.</p>
            </div>
          )}

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`bg-white rounded-xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors
              ${dragging
                ? (isBackfill ? 'border-teal-400 bg-teal-50' : 'border-orange-400 bg-orange-50')
                : (isBackfill ? 'border-gray-300 hover:border-teal-300 hover:bg-teal-50/30' : 'border-gray-300 hover:border-orange-300 hover:bg-orange-50/30')}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
            />
            <Upload className={`w-10 h-10 mx-auto mb-3 ${isBackfill ? 'text-teal-400' : 'text-orange-400'}`} />
            <p className="text-gray-700 font-semibold mb-1">Arrastra el archivo CSV de EFI aquí</p>
            <p className="text-gray-500 text-sm">o haz click para seleccionarlo</p>
          </div>

          {/* Paste area */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <FileText className="w-4 h-4 text-gray-400" />
              O pega el contenido del CSV directamente:
            </div>
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder={isBackfill
                ? `tracking_number,Teléfonos destinatario,Dirección destinatario,Ciudad,Destinatario\n9000555918,8098344999,Calle 1 #2-3,Santo Domingo,Juan Pérez`
                : `tracking_number,phone,status,customer_name,created_at\n9000555918,8098344999,Novedad,Juan Pérez,2026-05-10\n9000555920,8091234567,En reparto,María García,2026-05-11`}
              className="w-full h-36 text-xs font-mono border border-gray-200 rounded-lg p-3 resize-y focus:outline-none focus:ring-2 focus:ring-orange-300 placeholder:text-gray-300"
            />
            <button
              onClick={() => handleParse(csvText, mode)}
              disabled={!csvText.trim()}
              className={`px-5 py-2 disabled:bg-gray-200 disabled:text-gray-400 text-white text-sm font-semibold rounded-lg transition-colors
                ${isBackfill ? 'bg-teal-500 hover:bg-teal-600' : 'bg-orange-500 hover:bg-orange-600'}`}
            >
              Analizar CSV
            </button>
          </div>

          {/* Error */}
          {parseError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-800 mb-1">Error al parsear el CSV</p>
                <p className="text-sm text-red-700">{parseError}</p>
              </div>
            </div>
          )}

          {/* Format guide */}
          <div className={`border rounded-xl p-4 text-sm ${isBackfill ? 'bg-teal-50 border-teal-100 text-teal-800' : 'bg-orange-50 border-orange-100 text-orange-800'}`}>
            <p className="font-semibold mb-2">
              {isBackfill ? 'Columnas reconocidas para actualización:' : 'Formatos de CSV aceptados:'}
            </p>
            {isBackfill ? (
              <div className="space-y-1 text-xs text-teal-700">
                <p>• <strong>Obligatoria:</strong> guía (<code>tracking_number</code>, <code>Guía</code>, <code>No. Guia</code>)</p>
                <p>• <strong>Opcionales:</strong> teléfono, dirección, ciudad, nombre del destinatario</p>
                <p>• Teléfono: <code>phone</code>, <code>Teléfonos destinatario</code>, <code>customer_phone</code></p>
                <p>• Dirección: <code>Dirección destinatario</code>, <code>customer_address</code>, <code>address</code></p>
                <p>• Ciudad: <code>ciudad</code>, <code>city</code>, <code>customer_city</code>, <code>ciudad/provincia</code></p>
                <p>• Nombre: <code>destinatario</code>, <code>nombre</code>, <code>customer_name</code></p>
                <p>• Delimitador auto-detectado: TAB, punto y coma, coma, o espacios múltiples</p>
                <p>• Solo rellena campos vacíos — <strong>nunca sobrescribe datos existentes</strong></p>
              </div>
            ) : (
              <div className="space-y-2">
                <div>
                  <p className="text-xs text-orange-600 font-semibold mb-1">Estándar programático (snake_case):</p>
                  <pre className="text-xs font-mono bg-orange-100/60 rounded p-2 overflow-x-auto">{`tracking_number,phone,status,customer_name,customer_address,created_at\n9000555918,8098344999,Novedad,Juan Pérez,Calle 1 #2-3,2026-05-10`}</pre>
                </div>
                <div>
                  <p className="text-xs text-orange-600 font-semibold mb-1">Formato EFI histórico (punto y coma):</p>
                  <pre className="text-xs font-mono bg-orange-100/60 rounded p-2 overflow-x-auto">{`Guía;Teléfono;Estado;Destinatario;Dirección destinatario;Ciudad\n9000555918;8098344999;Novedad;Juan Pérez;Calle 1 #2-3;Santo Domingo`}</pre>
                </div>
                <div className="mt-2 text-xs text-orange-700 space-y-1">
                  <p>• <strong>Obligatorias:</strong> guía y teléfono</p>
                  <p>• <strong>Opcionales:</strong> estado, nombre, dirección (<code>Dirección destinatario</code>), ciudad</p>
                  <p>• Delimitador auto-detectado: TAB, punto y coma, coma, o espacios múltiples</p>
                  <p>• Máximo 500 guías por importación</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── STEP: PREVIEW ── */}
      {step === 'preview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-2xl font-black tabular-nums text-gray-900">{parsedRows.length}</p>
              <p className="text-sm text-gray-500 font-medium mt-1">Total filas</p>
            </div>
            <div className="bg-green-50 rounded-xl border border-green-200 p-4">
              <p className="text-2xl font-black tabular-nums text-green-700">{validRows.length}</p>
              <p className="text-sm text-green-600 font-medium mt-1">Válidas</p>
            </div>
            {invalidRows.length > 0 && (
              <div className="bg-red-50 rounded-xl border border-red-200 p-4">
                <p className="text-2xl font-black tabular-nums text-red-700">{invalidRows.length}</p>
                <p className="text-sm text-red-600 font-medium mt-1">Con error (se omiten)</p>
              </div>
            )}
            {detection && (
              <div className={`rounded-xl border p-4 ${isBackfill ? 'bg-teal-50 border-teal-200' : 'bg-orange-50 border-orange-200'}`}>
                <p className={`text-xs font-semibold mb-1 ${isBackfill ? 'text-teal-800' : 'text-orange-800'}`}>Detectado</p>
                <p className={`text-xs ${isBackfill ? 'text-teal-700' : 'text-orange-700'}`}>Guía: <strong>{detection.trackingCol ?? '—'}</strong></p>
                {detection.phoneCol   && <p className={`text-xs ${isBackfill ? 'text-teal-700' : 'text-orange-700'}`}>Tel: <strong>{detection.phoneCol}</strong></p>}
                {detection.addressCol && <p className={`text-xs ${isBackfill ? 'text-teal-700' : 'text-orange-700'}`}>Dir: <strong>{detection.addressCol}</strong></p>}
                {detection.ciudadCol  && <p className={`text-xs ${isBackfill ? 'text-teal-700' : 'text-orange-700'}`}>Ciudad: <strong>{detection.ciudadCol}</strong></p>}
                {detection.estadoCol  && <p className={`text-xs ${isBackfill ? 'text-teal-700' : 'text-orange-700'}`}>Estado: <strong>{detection.estadoCol}</strong></p>}
                {!detection.estadoCol && !isBackfill && (
                  <p className="text-xs text-amber-700 font-semibold mt-1">
                    ⚠ Sin columna de estado detectada — se usará &quot;tránsito&quot; por defecto en todas las guías
                  </p>
                )}
                <p className={`text-xs mt-1 ${isBackfill ? 'text-teal-500' : 'text-orange-500'}`}>Delim: {delimLabel(detection.delimiter)}</p>
              </div>
            )}
          </div>

          {submitError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              {submitError}
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
              <p className="text-sm font-semibold text-gray-700">
                Previsualización — primeras {Math.min(validRows.length, 15)} de {validRows.length} filas válidas
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-gray-500">#</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Guía</th>
                    {!isBackfill && <th className="px-3 py-2 text-left font-semibold text-gray-600">Teléfono</th>}
                    {isBackfill  && <th className="px-3 py-2 text-left font-semibold text-gray-600">Tel (opcional)</th>}
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Dirección</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Ciudad</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Nombre</th>
                    {!isBackfill && <th className="px-3 py-2 text-left font-semibold text-gray-600">Estado</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {validRows.slice(0, 15).map((row) => (
                    <tr key={row._rowIndex} className="hover:bg-gray-50/60">
                      <td className="px-3 py-2 text-gray-400">{row._rowIndex}</td>
                      <td className="px-3 py-2 font-mono text-gray-900">{row.tracking_number}</td>
                      <td className="px-3 py-2 text-gray-700">{row.phone || <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 text-gray-600">{row.address ?? <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 text-gray-600">{row.ciudad  ?? <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 text-gray-600">{row.nombre  ?? <span className="text-gray-300">—</span>}</td>
                      {!isBackfill && <td className="px-3 py-2 text-gray-600">{row.estado ?? <span className="text-gray-300">—</span>}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {validRows.length > 15 && (
              <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-500">
                ... y {validRows.length - 15} filas más
              </div>
            )}
          </div>

          {invalidRows.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-red-800 mb-2">{invalidRows.length} filas inválidas que se omitirán:</p>
              {invalidRows.slice(0, 5).map((r, i) => (
                <p key={i} className="text-xs text-red-700 font-mono truncate">
                  Fila {r._rowIndex}: {r._parseError ?? `guía="${r.tracking_number}" tel="${r.phone}"`}
                </p>
              ))}
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={reset} className="px-5 py-2.5 border border-gray-300 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-50 transition-colors">
              Volver
            </button>
            <button
              onClick={handleProcess}
              disabled={validRows.length === 0}
              className={`flex-1 flex items-center justify-center gap-2 px-5 py-2.5 disabled:bg-gray-300 text-white text-sm font-semibold rounded-lg transition-colors
                ${isBackfill ? 'bg-teal-500 hover:bg-teal-600' : 'bg-orange-500 hover:bg-orange-600'}`}
            >
              {isBackfill ? <RefreshCw className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
              {isBackfill ? `Actualizar ${validRows.length.toLocaleString()} guías` : `Procesar ${validRows.length.toLocaleString()} guías`}
            </button>
          </div>
        </div>
      )}

      {/* ── STEP: PROCESSING ── */}
      {step === 'processing' && (
        <div className="bg-white rounded-xl border border-gray-200 p-16 text-center">
          <Spinner className={`w-12 h-12 mx-auto mb-4 ${isBackfill ? 'text-teal-500' : 'text-orange-500'}`} />
          <p className="text-gray-700 font-semibold text-lg mb-1">
            {isBackfill ? `Actualizando ${validRows.length} guías…` : `Reconciliando ${validRows.length} guías…`}
          </p>
          <p className="text-gray-500 text-sm mb-3">
            {isBackfill ? 'Buscando guías en DB y rellenando campos vacíos' : 'Buscando coincidencias en DB — sin llamadas a EFI'}
          </p>
          <p className={`text-xs font-mono tabular-nums ${isBackfill ? 'text-teal-400' : 'text-orange-400'}`}>
            {processingElapsed}s transcurridos
            {validRows.length > 100 ? ` · estimado ~${Math.ceil(validRows.length / 50)}s` : ''}
          </p>
          <div className="mt-4 mx-auto w-48 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className={`h-full rounded-full animate-pulse w-full ${isBackfill ? 'bg-teal-400' : 'bg-orange-400'}`} />
          </div>
        </div>
      )}

      {/* ── STEP: RESULTS — import mode ── */}
      {step === 'results' && response && mode === 'import' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            <SummaryCard label="Total"        value={response.summary.total}                   color="gray"    />
            <SummaryCard label="Asignados"    value={response.summary.assigned}                color="green"   />
            <SummaryCard label="Pendiente→OK" value={response.summary.assigned_pending_forced} color="emerald" />
            <SummaryCard label="Ya asignados" value={response.summary.already_assigned}        color="blue"    />
            <SummaryCard label="Sin match"    value={response.summary.no_match + response.summary.multiple_candidates} color="amber" />
            <SummaryCard label="Errores"      value={response.summary.errors}                  color="red"     />
          </div>

          <ResultSection
            title={`✓ Asignados automáticamente — ${response.auto_assigned.length}`}
            items={response.auto_assigned}
            color="green"
            expanded={expandSection.auto_assigned}
            onToggle={() => setExpandSection(s => ({ ...s, auto_assigned: !s.auto_assigned }))}
            columns={['Guía', 'Pedido', 'Cliente', 'Estado asignado', 'Tipo', 'Datos rellenados']}
            renderRow={(r) => [
              r.tracking_number,
              r.order_number,
              r.customer_name,
              STATUS_LABELS[r.normalized_status ?? ''] ?? r.normalized_status,
              r.outcome === 'assigned_pending_forced' ? 'Pendiente→Confirmado' : 'Normal',
              r.contact_fields_filled?.join(', ') ?? '—',
            ]}
          />

          <ResultSection
            title={`⚠ Requieren revisión manual — ${response.needs_review.length}`}
            items={response.needs_review}
            color="amber"
            expanded={expandSection.needs_review}
            onToggle={() => setExpandSection(s => ({ ...s, needs_review: !s.needs_review }))}
            columns={['Guía', 'Teléfono', 'Estado', 'Razón', 'Candidatos']}
            renderRow={(r) => [
              r.tracking_number, r.phone, r.estado,
              r.outcome === 'multiple_candidates' ? 'Múltiples candidatos' : 'Sin coincidencia',
              r.candidates ? r.candidates.map(c => c.order_number).join(', ') : '—',
            ]}
          />

          <ResultSection
            title={`ℹ Ya asignados previamente — ${response.already_assigned.length}`}
            items={response.already_assigned}
            color="blue"
            expanded={expandSection.already_assigned}
            onToggle={() => setExpandSection(s => ({ ...s, already_assigned: !s.already_assigned }))}
            columns={['Guía', 'Pedido existente', 'Datos rellenados']}
            renderRow={(r) => [r.tracking_number, r.existing_order?.order_number, r.contact_fields_filled?.join(', ') ?? '—']}
          />

          <ResultSection
            title={`✗ Errores — ${response.errors.length}`}
            items={response.errors}
            color="red"
            expanded={expandSection.errors}
            onToggle={() => setExpandSection(s => ({ ...s, errors: !s.errors }))}
            columns={['Guía', 'Teléfono', 'Error']}
            renderRow={(r) => [r.tracking_number, r.phone, r.error]}
          />

          <div className="flex gap-3">
            <button onClick={reset} className="px-6 py-2.5 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold rounded-lg transition-colors">
              Nueva importación
            </button>
          </div>
        </div>
      )}

      {/* ── STEP: RESULTS — backfill mode ── */}
      {step === 'results' && backfillResponse && mode === 'backfill' && (
        <div className="space-y-4">
          {/* Summary */}
          {(() => {
            const s: BackfillSummary = backfillResponse.summary
            return (
              <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
                <SummaryCard label="Escaneados"   value={s.scanned}   color="gray"    />
                <SummaryCard label="Actualizados" value={s.updated}   color="green"   />
                <SummaryCard label="Ya completos" value={s.skipped}   color="blue"    />
                <SummaryCard label="No hallados"  value={s.not_found} color="amber"   />
                <SummaryCard label="Errores"      value={s.errors}    color="red"     />
              </div>
            )
          })()}

          <BackfillSection
            title={`✓ Actualizados (muestra ${backfillResponse.sample_updated.length}) — total ${backfillResponse.summary.updated}`}
            items={backfillResponse.sample_updated}
            color="green"
            expanded={expandSection.bf_updated}
            onToggle={() => setExpandSection(s => ({ ...s, bf_updated: !s.bf_updated }))}
          />

          <BackfillSection
            title={`⚠ Guías no encontradas en DB — ${backfillResponse.sample_missing.length}`}
            items={backfillResponse.sample_missing}
            color="amber"
            expanded={expandSection.bf_missing}
            onToggle={() => setExpandSection(s => ({ ...s, bf_missing: !s.bf_missing }))}
          />

          <div className="flex gap-3">
            <button onClick={reset} className="px-6 py-2.5 bg-teal-500 hover:bg-teal-600 text-white text-sm font-semibold rounded-lg transition-colors">
              Nueva actualización
            </button>
          </div>
        </div>
      )}

    </div>
  )
}
