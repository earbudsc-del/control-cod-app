'use client'

import { useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { STATUS_LABELS, STATUS_COLORS } from '@/types'
import type { NormalizedStatus } from '@/types'
import { Search, CheckCircle, AlertCircle, Clock, MapPin, Truck, User, Calendar, Bug, DollarSign, Hash } from 'lucide-react'

// ─── Tipos alineados con el parser ───────────────────────────────────────────

interface TrackingEvent   { fecha: string; estado:  string }
interface TrackingNovedad { fecha: string; mensaje: string }

interface TrackingResult {
  guia:                       string
  encontrado:                 boolean
  estado_actual:              string | null
  normalized_status:          string
  valor_recaudo:              string | null
  transportadora:             string | null
  fecha_creacion:             string | null
  fecha_ultima_actualizacion: string | null
  destino:                    string | null
  destinatario:               string | null
  historial_estados:          TrackingEvent[]
  historial_novedades:        TrackingNovedad[]
  attempts:                   number
  cantidad_rastreos:          number | null
  last_attempt_reason:        string | null
  _url_consultada:            string
  _debug: {
    status_selector_used:     string
    tables_found:             number
    estados_rows:             number
    novedades_rows:           number
    raw_text_sample:          string
    near_estado_actual:       string
    near_historico_estados:   string
    near_historico_novedades: string
  }
}

// ─── Componentes auxiliares ───────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-gray-50 last:border-0">
      <span className="text-xs font-medium text-gray-400 w-36 shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-gray-800">{value}</span>
    </div>
  )
}

function AttemptsBadge({ n }: { n: number }) {
  if (n === 0) return null
  const color = n >= 3 ? 'bg-red-100 text-red-700' : n === 2 ? 'bg-orange-100 text-orange-700' : 'bg-yellow-100 text-yellow-700'
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ${color}`}>
      {n} novedad{n > 1 ? 'es' : ''}
    </span>
  )
}

// ─── Página ───────────────────────────────────────────────────────────────────

export default function TrackingTestPage() {
  const [guia, setGuia]         = useState('')
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<TrackingResult | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [showDebug, setShowDebug] = useState(false)

  async function handleConsultar() {
    const g = guia.trim()
    if (!g) return
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      const res  = await fetch(`/api/tracking-test?guia=${encodeURIComponent(g)}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Error al consultar')
      } else {
        setResult(data as TrackingResult)
      }
    } catch {
      setError('No se pudo conectar con el servidor')
    } finally {
      setLoading(false)
    }
  }

  const statusLabel = result
    ? (STATUS_LABELS[result.normalized_status as NormalizedStatus] ?? result.normalized_status)
    : null
  const statusColor = result
    ? (STATUS_COLORS[result.normalized_status as NormalizedStatus] ?? 'bg-gray-100 text-gray-600')
    : null

  return (
    <div className="space-y-6 max-w-3xl">

      {/* Título */}
      <div>
        <h1 className="text-xl font-bold text-gray-900">Tracking EFI — Prueba</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Consulta el tracking público de EFI y valida el parser de HTML
        </p>
      </div>

      {/* Input */}
      <div className="flex gap-3">
        <input
          type="text"
          value={guia}
          onChange={e => setGuia(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleConsultar()}
          placeholder="Número de guía EFI (ej: EFI-123456)"
          className="flex-1 border border-gray-200 rounded-lg px-4 py-2.5 text-sm
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <button
          onClick={handleConsultar}
          disabled={loading || !guia.trim()}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300
                     text-white font-semibold text-sm px-5 py-2.5 rounded-lg transition-colors"
        >
          {loading ? <Spinner className="w-4 h-4" /> : <Search className="w-4 h-4" />}
          Consultar tracking
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-800">Error al consultar</p>
            <p className="text-sm text-red-600 mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* Guía no encontrada */}
      {result && !result.encontrado && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <AlertCircle className="w-5 h-5 text-amber-500" />
          <p className="text-sm font-medium text-amber-800">
            La guía <strong>{result.guia}</strong> no fue encontrada en EFI.
          </p>
        </div>
      )}

      {/* Resultado principal */}
      {result && result.encontrado && (
        <div className="space-y-4">

          {/* Banner de estado */}
          <div className="bg-white border border-gray-100 rounded-xl p-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-green-500" />
                <div>
                  <p className="text-xs text-gray-400">Guía consultada</p>
                  <p className="font-mono font-bold text-gray-900">{result.guia}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <AttemptsBadge n={result.attempts} />
                {statusLabel && (
                  <span className={`text-sm font-semibold px-3 py-1 rounded-full ${statusColor}`}>
                    {statusLabel}
                  </span>
                )}
              </div>
            </div>
            {result.estado_actual && (
              <div className="mt-3 pt-3 border-t border-gray-50">
                <p className="text-xs text-gray-400 mb-0.5">Estado en EFI</p>
                <p className="text-base font-semibold text-gray-800">{result.estado_actual}</p>
              </div>
            )}
            <p className="text-xs text-gray-300 mt-2">
              Fuente: <a href={result._url_consultada} target="_blank" rel="noopener noreferrer"
                className="underline hover:text-gray-500">{result._url_consultada}</a>
            </p>
          </div>

          {/* Datos del envío */}
          <div className="bg-white border border-gray-100 rounded-xl">
            <div className="px-5 py-3 border-b border-gray-50">
              <h2 className="font-semibold text-gray-900 text-sm">Datos del envío</h2>
            </div>
            <div className="px-5 py-1">
              <InfoRow label={<><DollarSign className="w-3.5 h-3.5 inline mr-1" />Valor recaudo</>   as unknown as string} value={result.valor_recaudo} />
              <InfoRow label={<><Truck className="w-3.5 h-3.5 inline mr-1" />Transportadora</>     as unknown as string} value={result.transportadora} />
              <InfoRow label={<><User  className="w-3.5 h-3.5 inline mr-1" />Destinatario</>       as unknown as string} value={result.destinatario} />
              <InfoRow label={<><MapPin className="w-3.5 h-3.5 inline mr-1" />Destino</>           as unknown as string} value={result.destino} />
              <InfoRow label={<><Calendar className="w-3.5 h-3.5 inline mr-1" />Fecha creación</>  as unknown as string} value={result.fecha_creacion} />
              <InfoRow label={<><Clock className="w-3.5 h-3.5 inline mr-1" />Rastreo anterior</>   as unknown as string} value={result.fecha_ultima_actualizacion} />
              {result.cantidad_rastreos !== null && (
                <InfoRow label={<><Hash className="w-3.5 h-3.5 inline mr-1" />Cantidad rastreos</> as unknown as string} value={String(result.cantidad_rastreos)} />
              )}
              <InfoRow label="Normalized status" value={result.normalized_status} />
              {result.last_attempt_reason && (
                <InfoRow label="Última novedad" value={result.last_attempt_reason} />
              )}
              {(!result.transportadora && !result.destinatario && !result.destino) && (
                <p className="text-xs text-gray-400 py-4 text-center italic">
                  No se encontraron datos del envío — revisa el debug abajo
                </p>
              )}
            </div>
          </div>

          {/* Historial de estados */}
          {result.historial_estados.length > 0 && (
            <div className="bg-white border border-gray-100 rounded-xl">
              <div className="px-5 py-3 border-b border-gray-50 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900 text-sm">Historial de estados</h2>
                <span className="text-xs text-gray-400">{result.historial_estados.length} eventos</span>
              </div>
              <div className="divide-y divide-gray-50">
                {result.historial_estados.map((ev, i) => (
                  <div key={i} className="flex items-start gap-4 px-5 py-2.5">
                    <span className="text-xs text-gray-400 w-36 shrink-0 pt-0.5 tabular-nums">
                      {ev.fecha}
                    </span>
                    <span className="text-sm text-gray-700">{ev.estado}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Historial de novedades */}
          {result.historial_novedades.length > 0 && (
            <div className="bg-white border border-orange-200 rounded-xl">
              <div className="px-5 py-3 border-b border-orange-100 flex items-center justify-between">
                <h2 className="font-semibold text-orange-800 text-sm">
                  Historial de novedades
                </h2>
                <span className="text-xs font-semibold bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">
                  {result.historial_novedades.length} novedad{result.historial_novedades.length > 1 ? 'es' : ''}
                </span>
              </div>
              <div className="divide-y divide-orange-50">
                {result.historial_novedades.map((nov, i) => (
                  <div key={i} className="flex items-start gap-4 px-5 py-2.5">
                    <span className="text-xs text-gray-400 w-36 shrink-0 pt-0.5 tabular-nums">
                      {nov.fecha}
                    </span>
                    <span className="text-sm text-orange-700 font-medium">{nov.mensaje}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sin historial */}
          {result.historial_estados.length === 0 && result.historial_novedades.length === 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 text-center">
              <p className="text-sm text-amber-700">
                No se encontraron tablas de historial. Revisa el panel de debug para ver el HTML recibido.
              </p>
            </div>
          )}

          {/* Panel de debug */}
          <div className="bg-gray-50 border border-gray-200 rounded-xl">
            <button
              onClick={() => setShowDebug(v => !v)}
              className="w-full flex items-center justify-between px-5 py-3 text-left"
            >
              <div className="flex items-center gap-2">
                <Bug className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-600">Debug del parser</span>
              </div>
              <span className="text-xs text-gray-400">{showDebug ? 'Ocultar' : 'Mostrar'}</span>
            </button>

            {showDebug && (
              <div className="border-t border-gray-200 px-5 py-4 space-y-2">
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="bg-white border border-gray-100 rounded-lg p-3">
                    <p className="text-gray-400 mb-1">Selector de estado usado</p>
                    <p className="font-mono text-gray-700">{result._debug.status_selector_used}</p>
                  </div>
                  <div className="bg-white border border-gray-100 rounded-lg p-3">
                    <p className="text-gray-400 mb-1">Tablas en HTML</p>
                    <p className="font-mono text-gray-700">{result._debug.tables_found}</p>
                  </div>
                  <div className="bg-white border border-gray-100 rounded-lg p-3">
                    <p className="text-gray-400 mb-1">Entradas historial estados</p>
                    <p className="font-mono text-gray-700">{result._debug.estados_rows}</p>
                  </div>
                  <div className="bg-white border border-gray-100 rounded-lg p-3">
                    <p className="text-gray-400 mb-1">Entradas historial novedades</p>
                    <p className="font-mono text-gray-700">{result._debug.novedades_rows}</p>
                  </div>
                </div>

                {[
                  { label: 'Texto cerca de "Estado actual"',         val: result._debug.near_estado_actual },
                  { label: 'Texto cerca de "HISTÓRICO DE ESTADOS"',  val: result._debug.near_historico_estados },
                  { label: 'Texto cerca de "HISTÓRICO DE NOVEDADES"',val: result._debug.near_historico_novedades },
                  { label: 'Muestra general del texto (400 chars)',   val: result._debug.raw_text_sample },
                ].map(({ label, val }) => val ? (
                  <div key={label} className="bg-white border border-gray-100 rounded-lg p-3">
                    <p className="text-xs text-gray-400 mb-1">{label}</p>
                    <p className="font-mono text-xs text-gray-600 whitespace-pre-wrap break-words">{val}</p>
                  </div>
                ) : null)}
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  )
}
