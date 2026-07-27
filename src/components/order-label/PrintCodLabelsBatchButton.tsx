'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Printer, X, AlertTriangle, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'
import type { OrderCodLabelModel } from '@/lib/order-label/types'
import { OrderCodLabel } from './OrderCodLabel'
import { useFittedLabelTier } from '@/lib/order-label/use-fitted-label-tier'
import { useSelection } from '@/components/selection/SelectionProvider'
import { formatCurrency } from '@/lib/utils'
import './OrderCodLabelBatch.print.css'

const MAX_BATCH_SIZE = 50

type LabelWithCompleteness = OrderCodLabelModel & { complete: boolean; missingFields: string[] }

type Stage = 'idle' | 'limit' | 'loading' | 'error' | 'review' | 'printing'

// Primera acción construida sobre la infraestructura global de selección
// múltiple (ver src/components/selection/). Se monta directamente dentro de
// <SelectionBulkActionBar> en cada módulo — lee la selección actual del
// contexto (nunca recibe los IDs por props, ya que la página que lo monta no
// puede llamar useSelection() por sí misma) y reutiliza normalizeOrderLabel()
// + <OrderCodLabel> (Sticker COD V3) sin modificarlos.
export function PrintCodLabelsBatchButton() {
  const { selectedIds, clearAll, toggle } = useSelection()
  const orderIds = [...selectedIds]
  const [stage, setStage] = useState<Stage>('idle')
  const [labels, setLabels] = useState<LabelWithCompleteness[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    if (stage !== 'printing') return
    function handleAfterPrint() {
      setStage('idle')
      setLabels([])
      clearAll()
    }
    window.addEventListener('afterprint', handleAfterPrint)
    // Deja que el portal se monte en el DOM antes de invocar la impresión.
    const t = setTimeout(() => window.print(), 50)
    return () => {
      window.removeEventListener('afterprint', handleAfterPrint)
      clearTimeout(t)
    }
  }, [stage, clearAll])

  async function handleClick() {
    if (orderIds.length === 0) return
    if (orderIds.length > MAX_BATCH_SIZE) {
      setStage('limit')
      return
    }
    setStage('loading')
    setErrorMsg(null)
    try {
      const res = await fetch('/api/orders/cod-labels/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds }),
      })
      const data = await res.json() as { labels?: LabelWithCompleteness[]; error?: string }
      if (!res.ok || !data.labels) {
        setErrorMsg(data.error ?? 'No se pudo preparar la impresión.')
        setStage('error')
        return
      }
      // El endpoint no garantiza el orden de retorno de `IN (...)` — se
      // reordena para que la lista de revisión coincida con el orden en que
      // el agente fue marcando la selección.
      const orderIndex = new Map(orderIds.map((id, i) => [id, i]))
      const sorted = [...data.labels].sort(
        (a, b) => (orderIndex.get(a.orderId) ?? 0) - (orderIndex.get(b.orderId) ?? 0),
      )
      setLabels(sorted)
      setStage('review')
    } catch {
      setErrorMsg('Error de red al preparar la impresión.')
      setStage('error')
    }
  }

  function handleClose() {
    setStage('idle')
    setLabels([])
    setErrorMsg(null)
  }

  // Quitar un pedido desde el modal de revisión — no dispara ninguna consulta
  // nueva (los modelos batch ya están cargados en memoria). Se refleja tanto
  // en la lista local del modal como en la selección global del módulo, para
  // que el contador de la barra inferior y el checkbox maestro queden en
  // sincronía sin cerrar el modal.
  function handleRemoveFromReview(orderId: string) {
    setLabels(prev => prev.filter(l => l.orderId !== orderId))
    toggle(orderId)
  }

  function handleClearAllFromReview() {
    clearAll()
    handleClose()
  }

  const ready = labels.filter(l => l.complete)
  const incomplete = labels.filter(l => !l.complete)

  return (
    <>
      <button
        onClick={handleClick}
        disabled={stage === 'loading' || orderIds.length === 0}
        className="flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-semibold
                   text-gray-900 hover:bg-gray-100 disabled:opacity-50 whitespace-nowrap"
      >
        <Printer className="h-4 w-4" />
        {stage === 'loading' ? 'Preparando…' : 'Imprimir Stickers COD'}
      </button>

      {stage === 'limit' && (
        <BatchDialog onClose={handleClose} title="Límite de lote excedido">
          <div className="flex items-start gap-2 text-sm text-red-700">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <p>
              Seleccionaste {orderIds.length} pedidos. El máximo por lote es {MAX_BATCH_SIZE}.
              Reduce la selección e intenta de nuevo.
            </p>
          </div>
        </BatchDialog>
      )}

      {stage === 'error' && (
        <BatchDialog onClose={handleClose} title="No se pudo preparar la impresión">
          <div className="flex items-start gap-2 text-sm text-red-700">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <p>{errorMsg}</p>
          </div>
        </BatchDialog>
      )}

      {stage === 'review' && (
        <ReviewDialog
          labels={labels}
          onClose={handleClose}
          onRemove={handleRemoveFromReview}
          onClearAll={handleClearAllFromReview}
          onConfirmPrint={() => setStage('printing')}
        />
      )}

      {stage === 'printing' &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="cod-label-batch-print-portal">
            {ready.map(model => (
              <BatchLabelItem key={model.orderId} model={model} />
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}

// Cada etiqueta calcula su propio tier de compactación de forma independiente
// (useFittedLabelTier ya existente, sin modificar) — igual que hoy hace el
// modal de impresión individual.
function BatchLabelItem({ model }: { model: OrderCodLabelModel }) {
  const { tier, probeRef, probeTier } = useFittedLabelTier(model)
  return (
    <div className="cod-label-batch-item">
      <OrderCodLabel model={model} tier={tier} />
      <div style={{ position: 'fixed', top: 0, left: -9999, visibility: 'hidden' }} aria-hidden="true">
        <OrderCodLabel ref={probeRef} model={model} tier={probeTier} />
      </div>
    </div>
  )
}

// "Nombre del cliente, Teléfono y Dirección" en vez de "Nombre del cliente y
// Teléfono y Dirección" — legibilidad para 3+ campos faltantes a la vez.
function joinMissingFields(fields: string[]): string {
  const lower = fields.map(f => f.toLowerCase())
  if (lower.length <= 1) return lower[0] ?? ''
  return `${lower.slice(0, -1).join(', ')} y ${lower[lower.length - 1]}`
}

// Modal de revisión previa a imprimir — muestra cada pedido seleccionado
// individualmente (no solo el conteo) para que el agente pueda validar el
// lote antes de imprimir. Header/resumen y footer quedan fijos; solo la
// lista central hace scroll cuando hay muchos pedidos.
function ReviewDialog({
  labels, onClose, onRemove, onClearAll, onConfirmPrint,
}: {
  labels: LabelWithCompleteness[]
  onClose: () => void
  onRemove: (orderId: string) => void
  onClearAll: () => void
  onConfirmPrint: () => void
}) {
  const ready = labels.filter(l => l.complete)
  const incomplete = labels.filter(l => !l.complete)
  const totalCod = labels.reduce((sum, l) => sum + (l.amount || 0), 0)

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Revisar antes de imprimir"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header — fijo */}
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
          <h2 className="font-semibold text-gray-900">Revisar antes de imprimir</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Resumen — fijo */}
        <div className="shrink-0 space-y-1 border-b bg-gray-50 px-4 py-3">
          <p className="text-sm font-semibold text-gray-900">
            {labels.length} pedido{labels.length !== 1 ? 's' : ''} seleccionado{labels.length !== 1 ? 's' : ''}
          </p>
          <p className="text-xs font-medium text-green-700">
            {ready.length} listo{ready.length !== 1 ? 's' : ''} para imprimir
          </p>
          {incomplete.length > 0 && (
            <p className="text-xs font-medium text-amber-700">
              {incomplete.length} requiere{incomplete.length !== 1 ? 'n' : ''} revisión
            </p>
          )}
          <p className="text-xs text-gray-600">
            Recaudo total: <span className="font-semibold text-gray-900">{formatCurrency(totalCod)}</span>
          </p>
        </div>

        {/* Lista de pedidos — scrollable */}
        <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
          {labels.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-gray-400">
              No queda ningún pedido seleccionado.
            </p>
          ) : (
            labels.map(l => (
              <div key={l.orderId} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">
                    #{l.orderNumber} — {l.customerName}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {l.city ?? 'Ciudad no especificada'} · {l.formattedAmount}
                  </p>
                  {l.complete ? (
                    <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-green-700">
                      <CheckCircle2 className="h-3 w-3 shrink-0" />Listo
                    </span>
                  ) : (
                    <span className="mt-1 flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                        Falta {joinMissingFields(l.missingFields)}
                      </span>
                      <Link
                        href={`/orders/${l.orderId}`}
                        className="text-[11px] font-medium text-indigo-600 underline hover:text-indigo-800"
                      >
                        Ver pedido
                      </Link>
                    </span>
                  )}
                </div>
                <button
                  onClick={() => onRemove(l.orderId)}
                  className="shrink-0 text-xs font-medium text-red-600 hover:text-red-800 hover:underline whitespace-nowrap"
                >
                  Quitar
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer — fijo */}
        <div className="shrink-0 space-y-2 border-t px-4 py-3">
          {incomplete.length > 0 && (
            <p className="text-[11px] text-amber-700">
              Los {incomplete.length} pedido{incomplete.length !== 1 ? 's' : ''} incompleto{incomplete.length !== 1 ? 's' : ''} no se imprimirá{incomplete.length !== 1 ? 'n' : ''} en este lote.
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium
                         text-gray-700 hover:bg-gray-50"
            >
              Cancelar
            </button>
            <button
              onClick={onConfirmPrint}
              disabled={ready.length === 0}
              className="flex-1 rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white
                         hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Imprimir los {ready.length} listos
            </button>
          </div>
          {labels.length > 0 && (
            <button
              onClick={onClearAll}
              className="w-full text-center text-xs text-gray-400 hover:text-gray-600 hover:underline"
            >
              Limpiar selección
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function BatchDialog({
  title, onClose, children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}
