'use client'

// Infraestructura global de selección múltiple para los listados de pedidos de
// Control COD (estilo Shopify). Un <SelectionProvider> por página — cada módulo
// (Confirmados, Despachados, SD Delivery, Reparto, y futuros) es un dominio de
// selección independiente. El estado vive fuera de la tabla/cards para que
// futuras acciones masivas (exportar, cambiar estado, asignar agente/mensajero,
// broadcast) puedan reutilizar exactamente este mismo hook sin tocar esta pieza.
//
// La selección persiste entre páginas de paginación dentro del mismo listado
// filtrado (igual que Shopify). Cada página debe llamar pruneToKnownIds() en un
// useEffect atado al array completo ya filtrado que usa para paginar — así se
// eliminan IDs huérfanos cuando cambia el filtro/tab, se recarga la data, o un
// pedido sale del listado, sin lógica adicional de "detectar eliminados".

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

interface SelectionContextValue {
  selectedIds: Set<string>
  count: number
  isSelected: (id: string) => boolean
  toggle: (id: string) => void
  selectVisible: (ids: string[]) => void
  clearVisible: (ids: string[]) => void
  clearAll: () => void
  pruneToKnownIds: (knownIds: string[]) => void
}

const SelectionContext = createContext<SelectionContextValue | null>(null)

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds])

  const toggle = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectVisible = useCallback((ids: string[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
  }, [])

  const clearVisible = useCallback((ids: string[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })
  }, [])

  const clearAll = useCallback(() => setSelectedIds(new Set()), [])

  const pruneToKnownIds = useCallback((knownIds: string[]) => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev
      const known = new Set(knownIds)
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (known.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [])

  const value = useMemo<SelectionContextValue>(() => ({
    selectedIds,
    count: selectedIds.size,
    isSelected,
    toggle,
    selectVisible,
    clearVisible,
    clearAll,
    pruneToKnownIds,
  }), [selectedIds, isSelected, toggle, selectVisible, clearVisible, clearAll, pruneToKnownIds])

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext)
  if (!ctx) throw new Error('useSelection debe usarse dentro de <SelectionProvider>')
  return ctx
}

// Componente sin render — cada página lo monta una vez dentro de su
// <SelectionProvider> pasándole el array COMPLETO ya filtrado (no solo la
// página actual) que usa para paginar. Poda IDs huérfanos automáticamente
// cada vez que ese array cambia: cambio de filtro/tab, refetch, o pedidos que
// salen del listado (Fase 5) — sin lógica adicional de "detectar eliminados".
export function SelectionSync({ knownIds }: { knownIds: string[] }) {
  const { pruneToKnownIds } = useSelection()
  useEffect(() => {
    pruneToKnownIds(knownIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownIds.join(','), pruneToKnownIds])
  return null
}
