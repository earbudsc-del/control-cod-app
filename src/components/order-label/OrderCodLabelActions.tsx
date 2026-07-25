'use client'

import { useMemo, useState } from 'react'
import { Tag } from 'lucide-react'
import type { Order } from '@/types'
import { normalizeOrderLabel } from '@/lib/order-label/normalize-order-label'
import { OrderCodLabelModal } from './OrderCodLabelModal'

interface OrderCodLabelActionsProps {
  order: Order
}

// Punto único de integración del Sticker COD dentro de Control COD — se cae
// una sola vez en OrderOperativeContent y queda disponible en todos los
// módulos que ya reutilizan ese componente (drawer de Tránsito/Reparto y la
// página completa /orders/[id]). El order ya viene autorizado y cargado por
// el propio módulo — normalizeOrderLabel es una función pura, sin fetch.
export function OrderCodLabelActions({ order }: OrderCodLabelActionsProps) {
  const [open, setOpen] = useState(false)
  const model = useMemo(() => normalizeOrderLabel(order), [order])

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        <Tag className="h-4 w-4" />
        Sticker COD
      </button>
      {open && <OrderCodLabelModal model={model} onClose={() => setOpen(false)} />}
    </>
  )
}
