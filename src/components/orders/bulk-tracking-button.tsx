'use client'

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'

interface Props {
  onComplete?: () => void
}

type State = 'idle' | 'fetching' | 'running' | 'done'

const BATCH_SIZE = 5

export function BulkTrackingButton({ onComplete }: Props) {
  const [state, setState]       = useState<State>('idle')
  const [found, setFound]       = useState(0)
  const [processed, setProcessed] = useState(0)
  const [summary, setSummary]   = useState<{ ok: number; failed: number } | null>(null)

  async function handleClick() {
    if (state !== 'idle') return
    setState('fetching')
    setSummary(null)

    let ids: string[]
    try {
      const res  = await fetch('/api/orders/active-tracking-ids')
      const data = await res.json() as { ids?: string[]; error?: string }
      if (!res.ok || !data.ids) {
        console.error('[BulkTracking] Error obteniendo IDs:', data.error)
        setState('idle')
        return
      }
      ids = data.ids
    } catch (err) {
      console.error('[BulkTracking] Error de red al obtener IDs:', err)
      setState('idle')
      return
    }

    console.log(`[BulkTracking] Encontrados ${ids.length} pedidos activos`)

    if (ids.length === 0) {
      setSummary({ ok: 0, failed: 0 })
      setState('done')
      setTimeout(() => { setState('idle'); setSummary(null) }, 4_000)
      return
    }

    setState('running')
    setFound(ids.length)
    setProcessed(0)

    let ok = 0
    let failed = 0

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE)

      await Promise.allSettled(
        batch.map(id =>
          fetch(`/api/orders/${id}/tracking`, { method: 'POST' })
            .then(async r => {
              if (r.ok) {
                ok++
              } else {
                const body = await r.json().catch(() => ({})) as { error?: string }
                console.error(`[BulkTracking] Falló pedido ${id} (HTTP ${r.status}):`, body.error ?? body)
                failed++
              }
            })
            .catch(err => {
              console.error(`[BulkTracking] Error de red pedido ${id}:`, err)
              failed++
            }),
        ),
      )

      setProcessed(Math.min(i + BATCH_SIZE, ids.length))
    }

    console.log(`[BulkTracking] Completado: ${ok} actualizados, ${failed} fallaron`)
    setSummary({ ok, failed })
    setState('done')
    onComplete?.()
    setTimeout(() => { setState('idle'); setSummary(null) }, 5_000)
  }

  if (state === 'fetching') {
    return (
      <div className="inline-flex items-center gap-2 text-sm text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg">
        <Spinner className="w-4 h-4" />
        Buscando pedidos activos…
      </div>
    )
  }

  if (state === 'running') {
    return (
      <div className="inline-flex items-center gap-2 text-sm text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg">
        <Spinner className="w-4 h-4" />
        Actualizando {processed} de {found}
      </div>
    )
  }

  if (state === 'done' && summary) {
    const noneFound = summary.ok === 0 && summary.failed === 0
    return (
      <div className={`inline-flex items-center text-sm px-3 py-1.5 rounded-lg font-medium
        ${noneFound        ? 'text-gray-500 bg-gray-100'
        : summary.failed > 0 ? 'text-amber-700 bg-amber-50'
        :                      'text-green-700 bg-green-50'}`}>
        {noneFound
          ? 'Sin pedidos activos'
          : `${summary.ok} actualizados${summary.failed > 0 ? ` · ${summary.failed} fallaron` : ''}`}
      </div>
    )
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleClick}>
      <RefreshCw className="w-4 h-4" />
      Actualizar tracking
    </Button>
  )
}
