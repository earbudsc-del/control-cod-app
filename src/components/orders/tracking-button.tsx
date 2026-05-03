'use client'

import { useState } from 'react'
import { RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import type { NormalizedStatus } from '@/types'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface TrackingUpdateResult {
  normalized_status:   NormalizedStatus
  delivery_attempts:   number
  last_attempt_reason: string | null
}

interface Props {
  orderId:        string
  trackingNumber: string | null | undefined
  onUpdated?:     (result: TrackingUpdateResult) => void
}

type ButtonState = 'idle' | 'loading' | 'success' | 'error'

// ─── Componente ───────────────────────────────────────────────────────────────

export function TrackingButton({ orderId, trackingNumber, onUpdated }: Props) {
  const [state, setState]     = useState<ButtonState>('idle')
  const [message, setMessage] = useState<string | null>(null)

  if (!trackingNumber) return null

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (state === 'loading') return

    setState('loading')
    setMessage(null)

    try {
      const res  = await fetch(`/api/orders/${orderId}/tracking`, { method: 'POST' })
      const data = await res.json() as {
        error?:              string
        normalized_status?:  string
        delivery_attempts?:  number
        last_attempt_reason?: string | null
      }

      if (!res.ok) {
        setMessage(data.error ?? 'Error consultando tracking')
        setState('error')
      } else {
        setState('success')
        onUpdated?.({
          normalized_status:   (data.normalized_status ?? 'unknown') as NormalizedStatus,
          delivery_attempts:   data.delivery_attempts ?? 0,
          last_attempt_reason: data.last_attempt_reason ?? null,
        })
      }
    } catch {
      setMessage('Error de conexión')
      setState('error')
    }

    setTimeout(() => { setState('idle'); setMessage(null) }, 3_500)
  }

  if (state === 'loading') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-blue-500 px-2 py-1">
        <Spinner className="w-3 h-3" />
        <span>EFI…</span>
      </span>
    )
  }

  if (state === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium
                        text-green-600 bg-green-50 px-2 py-1 rounded-md">
        <CheckCircle2 className="w-3 h-3 shrink-0" />
        Actualizado
      </span>
    )
  }

  if (state === 'error') {
    return (
      <button
        onClick={handleClick}
        title={message ?? 'Error — clic para reintentar'}
        className="inline-flex items-center gap-1 text-xs font-medium
                   text-red-600 bg-red-50 hover:bg-red-100
                   px-2 py-1 rounded-md transition-colors cursor-pointer"
      >
        <AlertCircle className="w-3 h-3 shrink-0" />
        {message && message.length <= 22 ? message : 'Error EFI'}
      </button>
    )
  }

  // idle
  return (
    <button
      onClick={handleClick}
      title="Actualizar tracking desde EFI"
      className="inline-flex items-center gap-1 text-xs font-medium
                 text-gray-400 hover:text-blue-600
                 bg-gray-100 hover:bg-blue-50
                 px-2 py-1 rounded-md transition-colors"
    >
      <RefreshCw className="w-3 h-3" />
      EFI
    </button>
  )
}
