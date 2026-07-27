'use client'

import type { ReactNode } from 'react'
import { useSelection } from './SelectionProvider'

interface BulkActionBarProps {
  count: number
  onClear: () => void
  children?: ReactNode
}

// Barra flotante estilo Shopify: invisible cuando count === 0. No sabe nada de
// Sticker COD ni de ningún otro dominio — recibe las acciones disponibles como
// children, así queda lista para futuras acciones masivas (exportar, cambiar
// estado, asignar agente/mensajero, broadcast) sin modificar este componente.
export function BulkActionBar({ count, onClear, children }: BulkActionBarProps) {
  if (count === 0) return null

  return (
    <div
      className="sticky bottom-0 z-20 flex flex-wrap items-center gap-3 border-t border-gray-200
                 bg-gray-900 px-4 py-3 text-white shadow-[0_-4px_12px_rgba(0,0,0,0.15)]"
      role="toolbar"
      aria-label="Acciones masivas"
    >
      <span className="text-sm font-semibold whitespace-nowrap">
        {count} pedido{count !== 1 ? 's' : ''} seleccionado{count !== 1 ? 's' : ''}
      </span>
      <button
        onClick={onClear}
        className="text-sm font-medium text-gray-300 hover:text-white hover:underline whitespace-nowrap"
      >
        Limpiar
      </button>
      <div className="ml-auto flex items-center gap-2 flex-wrap">
        {children}
      </div>
    </div>
  )
}

// Envoltorio conectado al contexto — cada página lo monta directamente dentro
// de su <SelectionProvider> sin tener que leer useSelection() ella misma (el
// hook solo puede llamarse desde un descendiente del Provider). BulkActionBar
// en sí sigue siendo un componente puro/presentacional, reutilizable fuera de
// este contexto si algún día hiciera falta.
export function SelectionBulkActionBar({ children }: { children?: ReactNode }) {
  const { count, clearAll } = useSelection()
  return (
    <BulkActionBar count={count} onClear={clearAll}>
      {children}
    </BulkActionBar>
  )
}
