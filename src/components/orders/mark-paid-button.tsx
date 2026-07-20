'use client'

import { useState } from 'react'
import { DollarSign } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'

// Botón "Pagado" único, reutilizado por /confirmacion (tab Santo Domingo) y
// /confirmados (tab "SD · Por cobrar"). Centraliza el fetch a
// POST /api/orders/[id]/mark-paid + el diálogo de confirmación para que
// ambos módulos tengan exactamente el mismo comportamiento (loading,
// doble-click, error inline) sin duplicar lógica.

interface MarkPaidButtonProps {
  orderId: string
  onSuccess: () => void
  className?: string
  label?: string
}

export function MarkPaidButton({ orderId, onSuccess, className, label = 'Pagado' }: MarkPaidButtonProps) {
  const [open, setOpen]   = useState(false)
  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res  = await fetch(`/api/orders/${orderId}/mark-paid`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body?.error ?? 'Error al marcar el pago')
        setBusy(false)
        return
      }
      setBusy(false)
      setOpen(false)
      onSuccess()
    } catch {
      setError('Error de red al marcar el pago')
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setError(null); setOpen(true) }}
        disabled={busy}
        className={className ?? (
          'flex items-center justify-center gap-1.5 min-h-[36px] px-3 whitespace-nowrap ' +
          'bg-green-600 hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed ' +
          'text-white text-xs font-semibold rounded-lg shadow-sm transition-colors'
        )}
      >
        {busy ? <Spinner className="w-3.5 h-3.5" /> : <DollarSign className="w-3.5 h-3.5 shrink-0" />}
        {label}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-gray-900 mb-1">Confirmar pago</p>
            <p className="text-sm text-gray-600 mb-4">
              ¿Confirmas que este pedido fue entregado y el pago fue recibido?
            </p>
            {error && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mb-3">
                {error}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleConfirm}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-white
                           bg-green-600 hover:bg-green-700 rounded-lg disabled:opacity-60"
              >
                {busy && <Spinner className="w-3.5 h-3.5" />}
                Confirmar pago
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
