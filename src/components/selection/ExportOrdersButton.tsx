'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, ChevronDown, FileText, Printer } from 'lucide-react'
import type { Order } from '@/types'
import { useSelection } from './SelectionProvider'
import { buildOrdersTxt, buildExportFilename, downloadTextFile, toExportRow } from '@/lib/order-export/build-export'
import { installPrintPageStyle } from '@/lib/print/page-style'
import './ExportOrdersButton.print.css'

// Tamaño de página estándar para el listado de texto (no es una etiqueta
// física de 4x6in como el Sticker COD) — ver src/lib/print/page-style.ts.
const EXPORT_LIST_PAGE_CSS = '@page { size: auto; margin: 14mm 12mm; }'

interface ExportOrdersButtonProps {
  // Pool de pedidos "conocidos" de la vista activa — mismo array que
  // alimenta <SelectionSync knownIds=.../> en la página, así la selección
  // resuelta acá siempre coincide con lo que el usuario ve seleccionado.
  orders: Order[]
  // Usado en el título del TXT/PDF y en el nombre del archivo descargado.
  scopeLabel: string
}

// Segunda acción construida sobre la infraestructura global de selección
// múltiple (ver src/components/selection/), hermana de
// PrintCodLabelsBatchButton. A diferencia de esa, no llama a ningún endpoint
// — los pedidos seleccionados ya están cargados en memoria en la página, así
// que TXT/PDF se generan 100% client-side.
export function ExportOrdersButton({ orders, scopeLabel }: ExportOrdersButtonProps) {
  const { selectedIds } = useSelection()
  const [menuOpen, setMenuOpen] = useState(false)
  const [printing, setPrinting] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const selected = orders.filter(o => selectedIds.has(o.id))

  useEffect(() => {
    if (!menuOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  useEffect(() => {
    if (!printing) return
    const uninstallPageStyle = installPrintPageStyle(EXPORT_LIST_PAGE_CSS)
    function handleAfterPrint() {
      uninstallPageStyle()
      setPrinting(false)
    }
    window.addEventListener('afterprint', handleAfterPrint)
    const t = setTimeout(() => window.print(), 50)
    return () => {
      window.removeEventListener('afterprint', handleAfterPrint)
      clearTimeout(t)
      uninstallPageStyle()
    }
  }, [printing])

  if (selected.length === 0) return null

  function handleTxt() {
    downloadTextFile(buildExportFilename(scopeLabel, 'txt'), buildOrdersTxt(selected, scopeLabel))
    setMenuOpen(false)
  }

  function handlePdf() {
    setMenuOpen(false)
    setPrinting(true)
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setMenuOpen(o => !o)}
        className="flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-semibold
                   text-gray-900 hover:bg-gray-100 whitespace-nowrap"
      >
        <Download className="h-4 w-4" />
        Exportar
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {menuOpen && (
        <div className="absolute bottom-full right-0 mb-2 w-48 rounded-md border border-gray-200
                         bg-white py-1 shadow-lg z-30">
          <button
            onClick={handleTxt}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            <FileText className="h-4 w-4 shrink-0" /> Descargar TXT
          </button>
          <button
            onClick={handlePdf}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            <Printer className="h-4 w-4 shrink-0" /> Descargar PDF
          </button>
        </div>
      )}

      {printing && typeof document !== 'undefined' &&
        createPortal(<PrintableOrderList orders={selected} scopeLabel={scopeLabel} />, document.body)}
    </div>
  )
}

// Vista imprimible simple — el navegador la renderiza en el diálogo de
// impresión, donde "Guardar como PDF" es una opción nativa (Chrome/Edge/Safari)
// sin necesitar ninguna librería de generación de PDF. Layout de tabla básico,
// sin decoración — pensado para operar (leer/llamar), no para presentar.
function PrintableOrderList({ orders, scopeLabel }: { orders: Order[]; scopeLabel: string }) {
  const rows = orders.map(toExportRow)
  return (
    <div className="export-print-portal print-isolation-root" style={{ fontFamily: 'Arial, Helvetica, sans-serif', color: '#111' }}>
      <h1 style={{ fontSize: '16pt', margin: '0 0 4pt' }}>Pedidos seleccionados</h1>
      <p style={{ fontSize: '9pt', color: '#555', margin: '0 0 12pt' }}>
        {scopeLabel} · {rows.length} pedido{rows.length !== 1 ? 's' : ''}
      </p>
      {rows.map((row, i) => (
        <div key={i} className="export-print-item"
          style={{ borderBottom: '1px solid #ddd', padding: '8pt 0', fontSize: '10pt', lineHeight: 1.5 }}>
          <div style={{ fontWeight: 700 }}>#{i + 1} — {row.customerName}</div>
          {row.phone   && <div>WhatsApp: {row.phone}</div>}
          {row.city    && <div>Ciudad: {row.city}</div>}
          {row.address && <div>Dirección: {row.address}</div>}
          {row.product && <div>Producto: {row.product}</div>}
          {row.amount  && <div>Monto: {row.amount}</div>}
          {row.tracking && <div>Guía: {row.tracking}</div>}
        </div>
      ))}
    </div>
  )
}
