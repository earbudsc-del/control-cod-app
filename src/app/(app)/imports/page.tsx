'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseFile, type ParseResult } from '@/lib/parsers/csv-parser'
import { DEFAULT_PATTERNS, type StatusPattern } from '@/lib/parsers/attempt-detector'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { StatusBadge } from '@/components/orders/status-badge'
import { formatDate, formatCurrency } from '@/lib/utils'
import { Upload, FileText, CheckCircle, AlertCircle, X } from 'lucide-react'
import type { Import, NormalizedStatus } from '@/types'

type Step = 'idle' | 'parsing' | 'preview' | 'importing' | 'done'

export default function ImportsPage() {
  const [step, setStep]               = useState<Step>('idle')
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)
  const [filename, setFilename]       = useState('')
  const [result, setResult]           = useState<{ upserted: number; errors: string[] } | null>(null)
  const [history, setHistory]         = useState<Import[]>([])
  const [dragging, setDragging]       = useState(false)
  const fileInputRef                  = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/imports').then(r => r.json()).then(setHistory).catch(() => {})
  }, [step])

  const handleFile = useCallback(async (file: File) => {
    setFilename(file.name)
    setStep('parsing')
    try {
      // Cargar patrones desde la BD; si falla, usar los patrones por defecto del código
      let patterns: StatusPattern[] = DEFAULT_PATTERNS
      try {
        const pRes = await fetch('/api/settings/patterns')
        if (pRes.ok) {
          const dbPatterns: StatusPattern[] = await pRes.json()
          if (Array.isArray(dbPatterns) && dbPatterns.length > 0) patterns = dbPatterns
        }
      } catch {
        // silencioso — usa DEFAULT_PATTERNS
      }
      const result = await parseFile(file, patterns)
      setParseResult(result)
      setStep('preview')
    } catch (err) {
      alert(`Error al leer el archivo: ${err instanceof Error ? err.message : 'desconocido'}`)
      setStep('idle')
    }
  }, [])

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  async function handleConfirmImport() {
    if (!parseResult) return
    setStep('importing')

    const res = await fetch('/api/imports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, orders: parseResult.orders }),
    })
    const data = await res.json()
    setResult({ upserted: data.upserted ?? 0, errors: data.errors ?? [] })
    setStep('done')
  }

  function reset() {
    setStep('idle')
    setParseResult(null)
    setResult(null)
    setFilename('')
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Importar pedidos</h1>
        <p className="text-sm text-gray-500 mt-0.5">Sube el archivo Excel o CSV exportado de EFI Commerce</p>
      </div>

      {/* Paso 1 — Selección de archivo */}
      {(step === 'idle' || step === 'parsing') && (
        <div
          onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors
            ${dragging ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-400 hover:bg-gray-50'}`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
          />
          {step === 'parsing' ? (
            <div className="flex flex-col items-center gap-2">
              <Spinner className="w-8 h-8 text-blue-600" />
              <p className="text-sm text-gray-600">Procesando archivo…</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="p-4 bg-blue-50 rounded-full">
                <Upload className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700">Arrastra o haz clic para seleccionar</p>
                <p className="text-xs text-gray-400 mt-1">CSV, XLSX, XLS · Exportación de EFI Commerce</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Paso 2 — Vista previa */}
      {step === 'preview' && parseResult && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <FileText className="w-5 h-5 text-gray-400" />
                <div>
                  <p className="text-sm font-medium text-gray-900">{filename}</p>
                  <p className="text-xs text-gray-500">
                    {parseResult.valid_rows} pedidos válidos · {parseResult.total_rows} filas total
                    {parseResult.parse_errors.length > 0 && (
                      <span className="text-amber-600"> · {parseResult.parse_errors.length} errores</span>
                    )}
                  </p>
                </div>
              </div>
              <button onClick={reset} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            {parseResult.parse_errors.length > 0 && (
              <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-xs font-medium text-amber-700 mb-1">Advertencias de parseo:</p>
                {parseResult.parse_errors.slice(0, 5).map((e, i) => (
                  <p key={i} className="text-xs text-amber-600">Fila {e.row}: {e.message}</p>
                ))}
                {parseResult.parse_errors.length > 5 && (
                  <p className="text-xs text-amber-500">…y {parseResult.parse_errors.length - 5} más</p>
                )}
              </div>
            )}

            {/* Tabla preview (primeras 10 filas) */}
            <div className="overflow-x-auto rounded-lg border border-gray-100">
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    {['Guía','Pedido','Cliente','Teléfono','Monto','Estado','Intentos'].map(h => (
                      <th key={h} className="px-3 py-2 text-left font-medium text-gray-500 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {parseResult.orders.slice(0, 10).map((o, i) => (
                    <tr key={i} className={o.errors.length > 0 ? 'bg-red-50' : ''}>
                      <td className="px-3 py-2 font-mono text-gray-900">{o.tracking_number}</td>
                      <td className="px-3 py-2 text-gray-600">{o.order_number ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-600 max-w-[120px] truncate">{o.customer_name ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{o.customer_phone ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{formatCurrency(o.cod_amount ?? null)}</td>
                      <td className="px-3 py-2">
                        <StatusBadge status={o.normalized_status as NormalizedStatus} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        {o.delivery_attempts > 0 ? (
                          <span className={`font-semibold ${o.delivery_attempts >= 2 ? 'text-red-600' : 'text-amber-600'}`}>
                            {o.delivery_attempts}
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {parseResult.orders.length > 10 && (
              <p className="text-xs text-gray-400 mt-2 text-center">
                Mostrando 10 de {parseResult.orders.length} pedidos
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <Button variant="secondary" onClick={reset}>Cancelar</Button>
            <Button onClick={handleConfirmImport} disabled={parseResult.valid_rows === 0}>
              Confirmar importación · {parseResult.valid_rows} pedidos
            </Button>
          </div>
        </div>
      )}

      {/* Paso 3 — Importando */}
      {step === 'importing' && (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center">
          <Spinner className="w-8 h-8 text-blue-600 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-700">Importando pedidos…</p>
          <p className="text-xs text-gray-400 mt-1">Esto puede tomar unos segundos</p>
        </div>
      )}

      {/* Paso 4 — Resultado */}
      {step === 'done' && result && (
        <div className="space-y-4">
          <div className={`rounded-xl border p-6 ${result.errors.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'}`}>
            <div className="flex items-center gap-3 mb-3">
              {result.errors.length > 0
                ? <AlertCircle className="w-6 h-6 text-amber-600" />
                : <CheckCircle className="w-6 h-6 text-green-600" />}
              <p className="font-semibold text-gray-900">
                {result.errors.length > 0 ? 'Importación parcial' : 'Importación exitosa'}
              </p>
            </div>
            <p className="text-sm text-gray-700">
              <strong>{result.upserted}</strong> pedidos procesados (creados o actualizados)
            </p>
            {result.errors.length > 0 && (
              <div className="mt-3 space-y-1">
                {result.errors.map((e, i) => (
                  <p key={i} className="text-xs text-amber-700">{e}</p>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={reset}>Nueva importación</Button>
            <Button onClick={() => window.location.href = '/orders'}>Ver pedidos</Button>
          </div>
        </div>
      )}

      {/* Historial de importaciones */}
      {history.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100">
          <div className="px-5 py-4 border-b border-gray-50">
            <h2 className="font-semibold text-gray-900 text-sm">Historial de importaciones</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {history.map((imp) => (
              <div key={imp.id} className="flex items-center gap-4 px-5 py-3">
                <FileText className="w-4 h-4 text-gray-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{imp.filename}</p>
                  <p className="text-xs text-gray-500">
                    {imp.record_count} pedidos · {(imp as any).profile?.full_name ?? '—'}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium
                    ${imp.status === 'completed' ? 'bg-green-100 text-green-700' :
                      imp.status === 'failed'    ? 'bg-red-100 text-red-700' :
                                                   'bg-gray-100 text-gray-600'}`}>
                    {imp.status === 'completed' ? 'Completado' :
                     imp.status === 'failed'    ? 'Error' : 'Procesando'}
                  </span>
                  <p className="text-xs text-gray-400 mt-0.5">{formatDate(imp.created_at, true)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
