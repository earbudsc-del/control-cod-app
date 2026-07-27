'use client'

import { useSelection } from './SelectionProvider'

interface SelectionCheckboxProps {
  id: string
  label?: string
}

// Checkbox de fila/card. Detiene la propagación del click para no disparar
// navegación u otros handlers de la fila que lo contenga.
export function SelectionCheckbox({ id, label }: SelectionCheckboxProps) {
  const { isSelected, toggle } = useSelection()
  const checked = isSelected(id)

  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={() => toggle(id)}
      onClick={e => e.stopPropagation()}
      aria-label={label ?? 'Seleccionar pedido'}
      className="h-4 w-4 shrink-0 cursor-pointer rounded border-gray-300 text-indigo-600
                 focus:ring-2 focus:ring-indigo-400 focus:ring-offset-0"
    />
  )
}
