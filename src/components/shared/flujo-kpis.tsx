'use client'

import { useEffect, useState } from 'react'
import { ArrowRight, Package, Truck, Bike, Ban } from 'lucide-react'

interface FlujoStats {
  generadas:  number
  in_transit: number
  en_reparto: number
  anuladas:   number
}

export function FlujoKpis() {
  const [stats, setStats] = useState<FlujoStats | null>(null)

  useEffect(() => {
    function load() {
      fetch('/api/flujo-stats')
        .then(r => r.json())
        .then((data: FlujoStats) => setStats(data))
        .catch(() => {/* silencioso si falla */})
    }
    load()
    const interval = setInterval(load, 3 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  if (!stats) return null

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3">
      <div className="flex items-center justify-between gap-1.5 mb-2.5">
        <div className="flex items-center gap-1.5">
          <Truck className="w-3.5 h-3.5 text-gray-400" />
          <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
            Pipeline logístico
          </span>
        </div>
        {stats.anuladas > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
            <Ban className="w-3 h-3" />
            {stats.anuladas} anuladas
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">

        {/* Generadas */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100 min-w-[100px]">
          <Package className="w-4 h-4 text-blue-500 shrink-0" />
          <div>
            <p className="text-lg font-black tabular-nums text-blue-700 leading-none">
              {stats.generadas.toLocaleString()}
            </p>
            <p className="text-[10px] font-semibold text-blue-500 mt-0.5 leading-tight">
              Generadas
            </p>
          </div>
        </div>

        <ArrowRight className="w-3.5 h-3.5 text-gray-300 shrink-0" />

        {/* En tránsito */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-50 border border-indigo-100 min-w-[100px]">
          <Truck className="w-4 h-4 text-indigo-500 shrink-0" />
          <div>
            <p className="text-lg font-black tabular-nums text-indigo-700 leading-none">
              {stats.in_transit.toLocaleString()}
            </p>
            <p className="text-[10px] font-semibold text-indigo-500 mt-0.5 leading-tight">
              En tránsito
            </p>
          </div>
        </div>

        <ArrowRight className="w-3.5 h-3.5 text-gray-300 shrink-0" />

        {/* En reparto */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-100 min-w-[100px]">
          <Bike className="w-4 h-4 text-amber-500 shrink-0" />
          <div>
            <p className="text-lg font-black tabular-nums text-amber-700 leading-none">
              {stats.en_reparto.toLocaleString()}
            </p>
            <p className="text-[10px] font-semibold text-amber-500 mt-0.5 leading-tight">
              En reparto
            </p>
          </div>
        </div>

      </div>
    </div>
  )
}
