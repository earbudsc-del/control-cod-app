'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { X, ExternalLink } from 'lucide-react'
import { OrderOperativeContent } from '@/components/orders/OrderOperativeContent'

interface OrderOperativeDrawerProps {
  orderId:     string | null
  onClose:     () => void
  onMutated?:  () => void
}

// Panel lateral con el detalle operativo completo de un pedido, para abrir
// desde Reparto/Tránsito sin perder el contexto (filtros, scroll, página)
// de la lista. Reutiliza el mismo contenido que /orders/[id] — una sola
// fuente de verdad, dos formas de mostrarla (página completa vs. drawer).
export function OrderOperativeDrawer({ orderId, onClose, onMutated }: OrderOperativeDrawerProps) {
  const isOpen = orderId !== null

  useEffect(() => {
    if (!isOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  return (
    <>
      {/* Overlay */}
      <div
        className={`fixed inset-0 bg-black/30 z-40 transition-opacity duration-300
          ${isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
      />

      {/* Panel */}
      <div className={`fixed right-0 top-0 h-full w-full sm:w-[480px] lg:w-[560px] bg-white z-50
        shadow-2xl flex flex-col transition-transform duration-300 ease-in-out
        ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <p className="text-sm font-semibold text-gray-700">Detalle operativo</p>
          <div className="flex items-center gap-1">
            {orderId && (
              <Link
                href={`/orders/${orderId}`}
                target="_blank" rel="noopener noreferrer"
                title="Ver en página completa"
                className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
              </Link>
            )}
            <button
              onClick={onClose}
              title="Cerrar"
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {orderId && (
            <OrderOperativeContent orderId={orderId} onBack={onClose} onMutated={onMutated} />
          )}
        </div>
      </div>
    </>
  )
}
