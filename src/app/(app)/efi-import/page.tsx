'use client'

import { useState, useRef, useCallback } from 'react'
import {
  Upload, CheckCircle2, AlertTriangle, X,
  ChevronDown, ChevronUp, Link2, FileText,
} from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import type { ImportResponse, ImportResult, ImportSummary } from '@/app/api/admin/reconcile-efi-import/route'

// ── CSV parsing ────────────────────────────────────────────────────────────────

// Nombres de columna reconocidos después de normalización.
// norm() convierte: mayúsculas→minúsculas, acentos→sin acento, _→espacio, -→espacio.
// Así "tracking_number", "Tracking-Number", "TRACKING NUMBER" → "tracking number" → match.

const TRACKING_KEYS = [
  // estándar programático (snake_case / kebab-case → normalizado a espacio)
  'tracking number', 'tracking', 'guide number', 'guide',
  // nombres EFI históricos
  'numero de guia', 'no. guia', 'no guia', '# guia', 'guia', 'numero guia',
]
const PHONE_KEYS = [
  // estándar programático
  'phone', 'phone number',
  // nombres históricos EFI / español
  'telefono', 'celular', 'movil', 'tel', 'cel', 'contacto',
]
const ESTADO_KEYS = [
  // estándar programático
  'status',
  // nombres históricos EFI / español
  'estado', 'estatus', 'novedad', 'ultima novedad',
]
const NOMBRE_KEYS = [
  // estándar programático
  'customer name', 'customer', 'name',
  // nombres históricos EFI / español
  'nombre del cliente', 'nombre', 'cliente', 'destinatario', 'receptor',
]
const CIUDAD_KEYS = [
  // estándar programático
  'city',
  // nombres históricos EFI / español
  'ciudad', 'municipio',
]

const WHITESPACE_DELIM = 'WHITESPACE'

interface ParsedRow {
  tracking_number: string
  phone:           string
  estado?:         string
  nombre?:         string
  ciudad?:         string
  _rowIndex:       number
  _parseError?:    string
}

interface ColumnDetection {
  trackingCol: string | null
  phoneCol:    string | null
  estadoCol:   string | null
  nombreCol:   string | null
  ciudadCol:   string | null
  delimiter:   string
  allHeaders:  string[]
}

// Normaliza un header: minúsculas, sin acentos, _ y - → espacio, espacios colapsados.
function norm(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita diacríticos
    .replace(/[_-]/g, ' ')                       // guión_bajo y guión → espacio
    .replace(/\s+/g, ' ')                        // colapsa espacios múltiples
    .trim()
}

// Limpia comillas y espacios de un valor de celda CSV.
function cleanCell(s: string): string {
  return s.replace(/^["'\s]+|["'\s]+$/g, '')
}

// Divide una línea CSV respetando comillas. Soporta delimitador WHITESPACE (split por \s+).
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

// Devuelve true si los tokens de la primera línea contienen columnas de guía Y teléfono.
function headersMatch(tokens: string[]): boolean {
  const normed = tokens.map(norm)
  return normed.some(h => TRACKING_KEYS.includes(h)) && normed.some(h => PHONE_KEYS.includes(h))
}

// Detecta el delimitador correcto probando tab → ; → , → whitespace.
// Elige el primero que produzca al menos las columnas requeridas (tracking + phone).
function detectBestDelimiter(headerLine: string): string {
  for (const delim of ['\t', ';', ',']) {
    if (headerLine.includes(delim) && headersMatch(headerLine.split(delim))) return delim
  }
  // Último recurso: whitespace (múltiples espacios / pegado desde tabla)
  if (headersMatch(headerLine.trim().split(/\s+/))) return WHITESPACE_DELIM
  // Sin match — devuelve coma para que el error sea descriptivo
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
    delimiter,
    allHeaders:  headers,
  }
}

function parseCSVText(text: string): { rows: ParsedRow[]; detection: ColumnDetection; error?: string } {
  const empty: ColumnDetection = { trackingCol: null, phoneCol: null, estadoCol: null, nombreCol: null, ciudadCol: null, delimiter: ',', allHeaders: [] }

  const lines = text.trim().split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) {
    return { rows: [], detection: empty, error: 'El CSV debe tener al menos una fila de encabezados y una fila de datos.' }
  }

  const delimiter = detectBestDelimiter(lines[0]!)
  const headers   = splitLine(lines[0]!, delimiter)
  const detection = detectColumns(headers, delimiter)

  if (!detection.trackingCol || !detection.phoneCol) {
    const missing: string[] = []
    if (!detection.trackingCol) missing.push('guía (tracking_number, Guía, No. Guia, Tracking)')
    if (!detection.phoneCol)    missing.push('teléfono (phone, Teléfono, Celular, Tel)')
    return {
      rows: [],
      detection,
      error: `No se detectaron columnas de ${missing.join(' y ')}. Encabezados encontrados: "${headers.join('", "')}"`,
    }
  }

  const trackingIdx = headers.indexOf(detection.trackingCol)
  const phoneIdx    = headers.indexOf(detection.phoneCol)
  const estadoIdx   = detection.estadoCol ? headers.indexOf(detection.estadoCol) : -1
  const nombreIdx   = detection.nombreCol ? headers.indexOf(detection.nombreCol) : -1
  const ciudadIdx   = detection.ciudadCol ? headers.indexOf(detection.ciudadCol) : -1

  const rows: ParsedRow[] = []

  for (let i = 1; i < lines.length; i++) {
    const cols     = splitLine(lines[i]!, delimiter)
    const tracking = cleanCell(cols[trackingIdx] ?? '')
    const phone    = cleanCell(cols[phoneIdx]    ?? '')

    if (!tracking && !phone) continue // fila vacía

    rows.push({
      tracking_number: tracking,
      phone,
      estado: estadoIdx >= 0 ? cleanCell(cols[estadoIdx] ?? '') || undefined : undefined,
      nombre: nombreIdx >= 0 ? cleanCell(cols[nombreIdx] ?? '') || undefined : undefined,
      ciudad: ciudadIdx >= 0 ? cleanCell(cols[ciudadIdx] ?? '') || undefined : undefined,
      _rowIndex:    i,
      _parseError:  (!tracking || !phone) ? `guía="${tracking}" o teléfono="${phone}" vacío` : undefined,
    })
  }

  return { rows, detection }
}

// Describe el delimitador detectado en términos legibles para el UI
function delimLabel(d: string): string {
  if (d === '\t')            return 'TAB'
  if (d === ';')             return 'punto y coma (;)'
  if (d === ',')             return 'coma (,)'
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
              <tr>
                {columns.map(c => (
                  <th key={c} className="px-3 py-2 text-left text-xs font-semibold text-gray-600">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {items.map((r, i) => (
                <tr key={i} className="hover:bg-gray-50/60">
                  {renderRow(r).map((cell, j) => (
                    <td key={j} className="px-3 py-2 text-gray-700 font-mono text-xs">{cell ?? '—'}</td>
                  ))}
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

export default function EfiImportPage() {
  const [step, setStep]             = useState<Step>('input')
  const [csvText, setCsvText]       = useState('')
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([])
  const [detection, setDetection]   = useState<ColumnDetection | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [response, setResponse]     = useState<ImportResponse | null>(null)
  const [dragging, setDragging]     = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [expandSection, setExpandSection] = useState({
    auto_assigned:    true,
    needs_review:     true,
    already_assigned: false,
    errors:           true,
  })

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleParse = useCallback((text: string) => {
    setParseError(null)
    const { rows, detection: det, error } = parseCSVText(text)
    setDetection(det)

    if (error) { setParseError(error); return }
    if (rows.length === 0) { setParseError('No se encontraron filas de datos en el CSV.'); return }

    setParsedRows(rows)
    setStep('preview')
  }, [])

  const handleFile = useCallback(async (file: File) => {
    const text = await file.text()
    setCsvText(text)
    handleParse(text)
  }, [handleParse])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  async function handleProcess() {
    setSubmitError(null)
    setStep('processing')

    const validItems = parsedRows
      .filter(r => r.tracking_number && r.phone && !r._parseError)
      .map(r => ({
        tracking_number: r.tracking_number,
        phone:           r.phone,
        estado:          r.estado,
        nombre:          r.nombre,
        ciudad:          r.ciudad,
      }))

    try {
      const res  = await fetch('/api/admin/reconcile-efi-import', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ items: validItems }),
      })
      const data = await res.json()

      if (!res.ok) {
        setSubmitError(data.error ?? 'Error al procesar')
        setStep('preview')
        return
      }

      setResponse(data as ImportResponse)
      setStep('results')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Error de red')
      setStep('preview')
    }
  }

  function reset() {
    setStep('input')
    setCsvText('')
    setParsedRows([])
    setDetection(null)
    setParseError(null)
    setResponse(null)
    setSubmitError(null)
  }

  const validRows   = parsedRows.filter(r => r.tracking_number && r.phone && !r._parseError)
  const invalidRows = parsedRows.filter(r => r._parseError || !r.tracking_number || !r.phone)

  const stepKeys: Step[] = ['input', 'preview', 'processing', 'results']
  const stepLabels = ['Subir CSV', 'Vista previa', 'Procesar', 'Resultados']
  const currentStepIdx = stepKeys.indexOf(step)

  return (
    <div className="space-y-4">

      {/* ── BANNER ── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-orange-500 to-amber-600 border-2 border-orange-400 shadow-lg shadow-orange-200/50">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-white" />
          <div className="absolute -left-4 -bottom-4 w-24 h-24 rounded-full bg-white" />
        </div>
        <div className="relative px-6 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-12 h-12 bg-white/20 rounded-xl shrink-0">
              <Link2 className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-black text-white">Importar guías EFI</h1>
              <p className="text-orange-100 text-sm font-medium">Reconciliación masiva desde exportación EFI — sin llamadas EFI, solo DB</p>
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
                  ${isActive ? 'bg-orange-50 text-orange-700' : isDone ? 'text-green-600' : 'text-gray-400'}`}>
                {isDone
                  ? <CheckCircle2 className="w-4 h-4 shrink-0" />
                  : <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs font-bold shrink-0
                      ${isActive ? 'border-orange-500 text-orange-600' : 'border-gray-300 text-gray-400'}`}>{i + 1}</span>
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
          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`bg-white rounded-xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors
              ${dragging ? 'border-orange-400 bg-orange-50' : 'border-gray-300 hover:border-orange-300 hover:bg-orange-50/30'}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
            />
            <Upload className="w-10 h-10 text-orange-400 mx-auto mb-3" />
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
              placeholder={`tracking_number,phone,status,customer_name,created_at\n9000555918,8098344999,Novedad,Juan Pérez,2026-05-10\n9000555920,8091234567,En reparto,María García,2026-05-11`}
              className="w-full h-36 text-xs font-mono border border-gray-200 rounded-lg p-3 resize-y focus:outline-none focus:ring-2 focus:ring-orange-300 placeholder:text-gray-300"
            />
            <button
              onClick={() => handleParse(csvText)}
              disabled={!csvText.trim()}
              className="px-5 py-2 bg-orange-500 hover:bg-orange-600 disabled:bg-gray-200 disabled:text-gray-400 text-white text-sm font-semibold rounded-lg transition-colors"
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
                <div className="mt-2 text-xs text-red-600 space-y-0.5">
                  <p>Columna <strong>guía</strong> reconocida como: <code>tracking_number</code>, <code>Guía</code>, <code>No. Guia</code>, <code>Tracking</code></p>
                  <p>Columna <strong>teléfono</strong> reconocida como: <code>phone</code>, <code>Teléfono</code>, <code>Celular</code>, <code>Tel</code></p>
                  <p>Delimitadores auto-detectados: <code>TAB</code>, <code>;</code>, <code>,</code>, espacios múltiples</p>
                </div>
              </div>
            </div>
          )}

          {/* Format guide */}
          <div className="bg-orange-50 border border-orange-100 rounded-xl p-4 text-sm text-orange-800">
            <p className="font-semibold mb-2">Formatos de CSV aceptados:</p>
            <div className="space-y-2">
              <div>
                <p className="text-xs text-orange-600 font-semibold mb-1">Estándar programático (snake_case):</p>
                <pre className="text-xs font-mono bg-orange-100/60 rounded p-2 overflow-x-auto">{`tracking_number,phone,status,customer_name,created_at\n9000555918,8098344999,Novedad,Juan Pérez,2026-05-10\n9000555920,8091234567,En reparto,María García,2026-05-11`}</pre>
              </div>
              <div>
                <p className="text-xs text-orange-600 font-semibold mb-1">Formato EFI histórico (punto y coma):</p>
                <pre className="text-xs font-mono bg-orange-100/60 rounded p-2 overflow-x-auto">{`Guía;Teléfono;Estado;Destinatario\n9000555918;8098344999;Novedad;Juan Pérez\n9000555920;8091234567;En reparto;María García`}</pre>
              </div>
            </div>
            <div className="mt-3 text-xs text-orange-700 space-y-1">
              <p>• <strong>Obligatorias:</strong> guía (<code>tracking_number</code> / <code>Guía</code>) y teléfono (<code>phone</code> / <code>Teléfono</code>)</p>
              <p>• <strong>Opcionales:</strong> estado (<code>status</code>), nombre (<code>customer_name</code>), ciudad (<code>city</code>)</p>
              <p>• Delimitador auto-detectado: TAB, punto y coma, coma, o espacios múltiples</p>
              <p>• Máximo 200 guías por importación</p>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP: PREVIEW ── */}
      {step === 'preview' && (
        <div className="space-y-4">
          {/* Stats */}
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
              <div className="bg-orange-50 rounded-xl border border-orange-200 p-4">
                <p className="text-xs font-semibold text-orange-800 mb-1">Detectado</p>
                <p className="text-xs text-orange-700">Guía: <strong>{detection.trackingCol ?? '—'}</strong></p>
                <p className="text-xs text-orange-700">Tel: <strong>{detection.phoneCol ?? '—'}</strong></p>
                {detection.estadoCol && <p className="text-xs text-orange-700">Estado: <strong>{detection.estadoCol}</strong></p>}
                <p className="text-xs text-orange-500 mt-1">Delim: {delimLabel(detection.delimiter)}</p>
              </div>
            )}
          </div>

          {submitError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              {submitError}
            </div>
          )}

          {/* Preview table */}
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
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Teléfono</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Estado</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Nombre</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Ciudad</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {validRows.slice(0, 15).map((row) => (
                    <tr key={row._rowIndex} className="hover:bg-gray-50/60">
                      <td className="px-3 py-2 text-gray-400">{row._rowIndex}</td>
                      <td className="px-3 py-2 font-mono text-gray-900">{row.tracking_number}</td>
                      <td className="px-3 py-2 text-gray-700">{row.phone}</td>
                      <td className="px-3 py-2 text-gray-600">{row.estado ?? <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 text-gray-600">{row.nombre ?? <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 text-gray-600">{row.ciudad ?? <span className="text-gray-300">—</span>}</td>
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

          {/* Invalid rows */}
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
            <button
              onClick={reset}
              className="px-5 py-2.5 border border-gray-300 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-50 transition-colors"
            >
              Volver
            </button>
            <button
              onClick={handleProcess}
              disabled={validRows.length === 0}
              className="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              <Link2 className="w-4 h-4" />
              Procesar {validRows.length.toLocaleString()} guías
            </button>
          </div>
        </div>
      )}

      {/* ── STEP: PROCESSING ── */}
      {step === 'processing' && (
        <div className="bg-white rounded-xl border border-gray-200 p-16 text-center">
          <Spinner className="w-12 h-12 text-orange-500 mx-auto mb-4" />
          <p className="text-gray-700 font-semibold text-lg mb-1">Reconciliando {validRows.length} guías…</p>
          <p className="text-gray-500 text-sm">Buscando coincidencias en DB — sin llamadas a EFI</p>
        </div>
      )}

      {/* ── STEP: RESULTS ── */}
      {step === 'results' && response && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            <SummaryCard label="Total"           value={response.summary.total}                   color="gray"    />
            <SummaryCard label="Asignados"       value={response.summary.assigned}                color="green"   />
            <SummaryCard label="Pendiente→OK"    value={response.summary.assigned_pending_forced} color="emerald" />
            <SummaryCard label="Ya asignados"    value={response.summary.already_assigned}        color="blue"    />
            <SummaryCard label="Sin match"       value={response.summary.no_match + response.summary.multiple_candidates} color="amber" />
            <SummaryCard label="Errores"         value={response.summary.errors}                  color="red"     />
          </div>

          {/* Auto-assigned */}
          <ResultSection
            title={`✓ Asignados automáticamente — ${response.auto_assigned.length}`}
            items={response.auto_assigned}
            color="green"
            expanded={expandSection.auto_assigned}
            onToggle={() => setExpandSection(s => ({ ...s, auto_assigned: !s.auto_assigned }))}
            columns={['Guía', 'Pedido', 'Cliente', 'Estado asignado', 'Tipo']}
            renderRow={(r) => [
              r.tracking_number,
              r.order_number,
              r.customer_name,
              STATUS_LABELS[r.normalized_status ?? ''] ?? r.normalized_status,
              r.outcome === 'assigned_pending_forced' ? 'Pendiente→Confirmado' : 'Normal',
            ]}
          />

          {/* Needs review */}
          <ResultSection
            title={`⚠ Requieren revisión manual — ${response.needs_review.length}`}
            items={response.needs_review}
            color="amber"
            expanded={expandSection.needs_review}
            onToggle={() => setExpandSection(s => ({ ...s, needs_review: !s.needs_review }))}
            columns={['Guía', 'Teléfono', 'Estado', 'Razón', 'Candidatos']}
            renderRow={(r) => [
              r.tracking_number,
              r.phone,
              r.estado,
              r.outcome === 'multiple_candidates' ? 'Múltiples candidatos' : 'Sin coincidencia',
              r.candidates ? r.candidates.map(c => c.order_number).join(', ') : '—',
            ]}
          />

          {/* Already assigned */}
          <ResultSection
            title={`ℹ Ya asignados previamente — ${response.already_assigned.length}`}
            items={response.already_assigned}
            color="blue"
            expanded={expandSection.already_assigned}
            onToggle={() => setExpandSection(s => ({ ...s, already_assigned: !s.already_assigned }))}
            columns={['Guía', 'Pedido existente']}
            renderRow={(r) => [r.tracking_number, r.existing_order?.order_number]}
          />

          {/* Errors */}
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
            <button
              onClick={reset}
              className="px-6 py-2.5 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              Nueva importación
            </button>
          </div>
        </div>
      )}

    </div>
  )
}
