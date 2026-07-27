'use client'

import { useEffect, useRef } from 'react'
import { useSelection } from './SelectionProvider'

interface SelectionHeaderCheckboxProps {
  visibleIds: string[]
}

// Checkbox maestro — selecciona/deselecciona ÚNICAMENTE los ids visibles en la
// página actual (nunca el resultado completo del filtro, por más de 2,500
// pedidos que tenga). "Seleccionar todos los resultados" queda para una fase
// futura, fuera de este alcance.
export function SelectionHeaderCheckbox({ visibleIds }: SelectionHeaderCheckboxProps) {
  const { selectedIds, selectVisible, clearVisible } = useSelection()
  const ref = useRef<HTMLInputElement>(null)

  const selectedVisibleCount = visibleIds.filter(id => selectedIds.has(id)).length
  const allSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length
  const someSelected = selectedVisibleCount > 0 && !allSelected

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someSelected
  }, [someSelected])

  function handleChange() {
    if (allSelected) clearVisible(visibleIds)
    else selectVisible(visibleIds)
  }

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={allSelected}
      onChange={handleChange}
      disabled={visibleIds.length === 0}
      aria-label="Seleccionar todos los pedidos visibles"
      className="h-4 w-4 shrink-0 cursor-pointer rounded border-gray-300 text-indigo-600
                 focus:ring-2 focus:ring-indigo-400 focus:ring-offset-0
                 disabled:cursor-not-allowed disabled:opacity-40"
    />
  )
}
