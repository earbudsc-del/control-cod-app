'use client'

import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { StatusBadge } from '@/components/orders/status-badge'
import { formatDate } from '@/lib/utils'
import type { NormalizedStatus } from '@/types'
import { RefreshCw, AlertTriangle } from 'lucide-react'

interface DebugData {
  raw_status_counts:        Array<{ status: string; count: number }>
  normalized_status_counts: Array<{ status: string; count: number }>
  unknown_orders:           Array<{
    id: string
    tracking_number: string
    raw_status: string | null
    normalized_status: string
    created_at: string
  }>
  total_orders:  number
  total_unknown: number
}

export default function DebugPage() {
  const [data, setData]       = useState<DebugData | null>(null)
  const [loading, setLoading] = useState(true)

  function load() {
    setLoading(true)
    fetch('/api/debug/estados')
      .then(r => r.json())
      .then(setData)
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Debug — Estados de pedidos</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Diagnóstico de raw_status vs normalized_status
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-700
                     text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refrescar
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-20">
          <Spinner className="w-8 h-8 text-blue-600" />
        </div>
      )}

      {!loading && data && (
        <div className="space-y-6">
          {/* Resumen rápido */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <p className="text-2xl font-bold text-gray-900">{data.total_orders.toLocaleString()}</p>
              <p className="text-sm text-gray-500">Total pedidos</p>
            </div>
            <div className={`border rounded-xl p-4 ${data.total_unknown > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-100'}`}>
              <p className={`text-2xl font-bold ${data.total_unknown > 0 ? 'text-amber-700' : 'text-gray-900'}`}>
                {data.total_unknown.toLocaleString()}
              </p>
              <p className={`text-sm ${data.total_unknown > 0 ? 'text-amber-600' : 'text-gray-500'}`}>
                Sin clasificar (unknown)
              </p>
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            {/* Normalized status counts */}
            <div className="bg-white border border-gray-100 rounded-xl">
              <div className="px-5 py-4 border-b border-gray-50">
                <h2 className="font-semibold text-gray-900 text-sm">Conteo por normalized_status</h2>
              </div>
              <div className="divide-y divide-gray-50">
                {data.normalized_status_counts.map(({ status, count }) => (
                  <div key={status} className="flex items-center justify-between px-5 py-3">
                    <StatusBadge status={status as NormalizedStatus} />
                    <span className="font-semibold text-gray-800">{count.toLocaleString()}</span>
                  </div>
                ))}
                {data.normalized_status_counts.length === 0 && (
                  <p className="px-5 py-6 text-sm text-gray-400 text-center">Sin datos</p>
                )}
              </div>
            </div>

            {/* Raw status counts (top 30) */}
            <div className="bg-white border border-gray-100 rounded-xl">
              <div className="px-5 py-4 border-b border-gray-50">
                <h2 className="font-semibold text-gray-900 text-sm">
                  Valores originales de raw_status{' '}
                  <span className="text-gray-400 font-normal">(top {Math.min(30, data.raw_status_counts.length)})</span>
                </h2>
              </div>
              <div className="divide-y divide-gray-50 max-h-[420px] overflow-y-auto">
                {data.raw_status_counts.slice(0, 30).map(({ status, count }) => (
                  <div key={status} className="flex items-center justify-between px-5 py-2.5">
                    <span className="font-mono text-xs text-gray-700 truncate max-w-[260px]">{status}</span>
                    <span className="text-sm font-semibold text-gray-600 shrink-0 ml-2">{count}</span>
                  </div>
                ))}
                {data.raw_status_counts.length === 0 && (
                  <p className="px-5 py-6 text-sm text-gray-400 text-center">Sin datos</p>
                )}
              </div>
            </div>
          </div>

          {/* Unknown orders */}
          {data.unknown_orders.length > 0 && (
            <div className="bg-white border border-amber-200 rounded-xl">
              <div className="px-5 py-4 border-b border-amber-100 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <h2 className="font-semibold text-amber-800 text-sm">
                  Pedidos sin clasificar ({data.total_unknown} total, mostrando {data.unknown_orders.length})
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-amber-50 border-b border-amber-100">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-amber-800">Guía</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-amber-800">raw_status original</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-amber-800">Estado norm.</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-amber-800">Importado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-50">
                    {data.unknown_orders.map(o => (
                      <tr key={o.id}>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-900">{o.tracking_number}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-600 max-w-[220px] truncate">
                          {o.raw_status ?? <span className="text-gray-300 italic">vacío</span>}
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={o.normalized_status as NormalizedStatus} />
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-500">{formatDate(o.created_at, true)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.unknown_orders.length === 0 && (
            <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-5 text-center">
              <p className="text-green-700 font-medium">Sin pedidos sin clasificar</p>
              <p className="text-green-600 text-sm mt-1">Todos los pedidos tienen un estado normalizado conocido.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
