'use client'

import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

// Modal reutilizable para acciones administrativas peligrosas que exigen un
// motivo obligatorio (reabrir, y a futuro cancelar pedido/guía — ver
// auditoría 2026-07-31). Reemplaza window.confirm: muestra pedido, cliente,
// estado actual y la consecuencia de la acción antes de pedir el motivo.

export interface ConfirmActionModalOrderInfo {
  orderNumber:  string | null
  customerName: string | null
  statusLabel:  string
}

export interface ConfirmActionModalProps {
  open:        boolean
  title:       string
  warning:     string
  order:       ConfirmActionModalOrderInfo
  reasonLabel?: string
  confirmLabel: string
  busy:         boolean
  error:        string | null
  onConfirm:   (reason: string) => void
  onClose:     () => void
}

export function ConfirmActionModal({
  open, title, warning, order, reasonLabel = 'Motivo', confirmLabel, busy, error, onConfirm, onClose,
}: ConfirmActionModalProps) {
  const [reason, setReason] = useState('')

  if (!open) return null

  const trimmed = reason.trim()

  function handleConfirm() {
    if (!trimmed || busy) return
    onConfirm(trimmed)
  }

  function handleClose() {
    if (busy) return
    setReason('')
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-bold text-gray-900">{title}</h2>
          <button
            onClick={handleClose}
            disabled={busy}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5 space-y-1">
            <p className="text-xs text-gray-500">Pedido</p>
            <p className="text-sm font-semibold text-gray-900">{order.orderNumber ?? '—'}</p>
            <p className="text-xs text-gray-500 mt-1.5">Cliente</p>
            <p className="text-sm font-medium text-gray-800">{order.customerName ?? '—'}</p>
            <p className="text-xs text-gray-500 mt-1.5">Estado actual</p>
            <p className="text-sm font-medium text-gray-800">{order.statusLabel}</p>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 leading-snug">{warning}</p>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-700">
              {reasonLabel} <span className="text-red-500">*</span>
            </label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              disabled={busy}
              rows={3}
              placeholder="Explica por qué se realiza esta acción..."
              className="mt-1 w-full text-sm border border-gray-200 rounded-lg px-3 py-2
                         focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400
                         disabled:bg-gray-50 disabled:opacity-60"
            />
          </div>

          {error && (
            <p className="text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-100">
          <button
            onClick={handleClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-semibold text-gray-600 rounded-lg
                       border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={!trimmed || busy}
            className="px-3 py-1.5 text-xs font-semibold text-white rounded-lg
                       bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Procesando…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
