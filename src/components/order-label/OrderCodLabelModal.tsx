'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Printer, Download } from 'lucide-react'
import type { OrderCodLabelModel } from '@/lib/order-label/types'
import { sanitizeFileName } from '@/lib/order-label/format-order-label'
import { exportOrderCodLabelPng, LabelExportDimensionError } from '@/lib/order-label/export-png'
import { useFittedLabelTier } from '@/lib/order-label/use-fitted-label-tier'
import { installPrintPageStyle, STICKER_LABEL_PAGE_CSS } from '@/lib/print/page-style'
import { OrderCodLabel } from './OrderCodLabel'
import './print-isolation.css'

interface OrderCodLabelModalProps {
  model: OrderCodLabelModel
  onClose: () => void
}

// Escala solo visual del preview en pantalla — el nodo real sigue midiendo
// 4in x 6in (384x576 CSS px). La impresión (PrintIsolation) y la exportación
// PNG (exportOrderCodLabelPng) ignoran este transform.
const PREVIEW_SCALE = 0.82

export function OrderCodLabelModal({ model, onClose }: OrderCodLabelModalProps) {
  const labelRef = useRef<HTMLDivElement>(null)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { tier, probeRef, probeTier } = useFittedLabelTier(model)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function handleDownload() {
    if (!labelRef.current) return
    setDownloading(true)
    setError(null)
    try {
      const dataUrl = await exportOrderCodLabelPng(labelRef.current)
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = `sticker-${sanitizeFileName(model.orderNumber)}.png`
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch (err) {
      console.error('[OrderCodLabelModal] Falló la exportación PNG', err)
      setError(
        err instanceof LabelExportDimensionError
          ? err.message
          : 'No se pudo generar el PNG. Intenta de nuevo.',
      )
    } finally {
      setDownloading(false)
    }
  }

  function handlePrint() {
    const uninstall = installPrintPageStyle(STICKER_LABEL_PAGE_CSS)
    function cleanup() {
      uninstall()
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
    window.print()
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Sticker COD pedido ${model.orderNumber}`}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-semibold text-gray-900">Sticker COD — {model.orderNumber}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-1 justify-center overflow-y-auto bg-gray-100 p-4">
          <div
            style={{
              width: 384 * PREVIEW_SCALE,
              height: 576 * PREVIEW_SCALE,
            }}
          >
            <div style={{ transform: `scale(${PREVIEW_SCALE})`, transformOrigin: 'top left' }}>
              <OrderCodLabel ref={labelRef} model={model} tier={tier} />
            </div>
          </div>
        </div>

        {/* Sonda oculta fuera de pantalla — mide el tier de compactación más
            espacioso que cabe para ESTE pedido concreto (ver
            useFittedLabelTier). Nunca se pinta al usuario. */}
        <div style={{ position: 'fixed', top: 0, left: -9999, visibility: 'hidden' }} aria-hidden="true">
          <OrderCodLabel ref={probeRef} model={model} tier={probeTier} />
        </div>

        {error && <p className="px-4 pt-2 text-sm text-red-600">{error}</p>}

        {/* Portal de impresión: misma instancia de <OrderCodLabel>, montada
            como hijo directo de <body> para que la paginación de impresión
            solo vea 4x6in de contenido real (ver print-isolation.css). */}
        {typeof document !== 'undefined' &&
          createPortal(
            <div className="cod-label-print-portal print-isolation-root">
              <OrderCodLabel model={model} tier={tier} />
            </div>,
            document.body,
          )}

        <div className="flex gap-2 border-t p-4">
          <button
            onClick={handlePrint}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            <Printer className="h-4 w-4" />
            Imprimir
          </button>
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="flex flex-1 items-center justify-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {downloading ? 'Generando…' : 'Descargar PNG'}
          </button>
        </div>
      </div>
    </div>
  )
}
