'use client'

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { OrderCodLabelModel } from './types'
import { MAX_LABEL_TIER, type LabelTier } from './label-tiers'

// .label mide 6in = 576px fijos (box-sizing: border-box) con overflow:hidden
// — scrollHeight de ese nodo refleja el alto REAL que el contenido necesita
// incluso estando clippeado visualmente, así que sirve para medir "¿cabe?"
// sin depender de asumir de antemano cuánto ocupa una dirección o una lista
// de productos. Un pequeño margen (2px) evita falsos "cabe" por redondeo
// sub-píxel entre navegadores.
const AVAILABLE_HEIGHT_PX = 574

export interface UseFittedLabelTierResult {
  tier: LabelTier
  probeRef: RefObject<HTMLDivElement | null>
  probeTier: LabelTier
}

// Determina, para UN pedido concreto, el tier de compactación más espacioso
// que aún cabe en la etiqueta — midiendo el contenido REAL en una copia
// oculta (probe) del mismo componente <OrderCodLabel>, nunca asumiéndolo de
// antemano. Arranca en tier 0 (espacioso) y solo escala si el contenido
// medido desborda, en el orden de negocio (interlineado → paddings → logo →
// instrucciones → productos → dirección — ver label-tiers.ts).
export function useFittedLabelTier(model: OrderCodLabelModel): UseFittedLabelTierResult {
  const probeRef = useRef<HTMLDivElement>(null)
  const [probeTier, setProbeTier] = useState<LabelTier>(0)
  const [finalTier, setFinalTier] = useState<LabelTier | null>(null)

  useEffect(() => {
    setFinalTier(null)
    setProbeTier(0)
  }, [model])

  useLayoutEffect(() => {
    if (finalTier !== null) return
    const node = probeRef.current
    if (!node) return

    let cancelled = false

    // El logo carga de forma asíncrona (<img>) — medir scrollHeight antes de
    // que termine de cargar subestima el alto real y aprueba un tier
    // demasiado espacioso por error (bug real detectado en pruebas v3: el
    // pedido #8751 quedaba en tier 0 con scrollHeight=589 > 574 porque la
    // primera medición ocurrió con el logo todavía sin pintar). Se espera a
    // `img.complete` (o su evento load/error) antes de decidir.
    function measure() {
      if (cancelled || !node) return
      const fits = node.scrollHeight <= AVAILABLE_HEIGHT_PX
      if (fits || probeTier >= MAX_LABEL_TIER) {
        setFinalTier(probeTier)
        return
      }
      setProbeTier(t => Math.min(t + 1, MAX_LABEL_TIER) as LabelTier)
    }

    const img = node.querySelector('img')
    if (img && !img.complete) {
      img.addEventListener('load', measure, { once: true })
      img.addEventListener('error', measure, { once: true })
      return () => {
        cancelled = true
        img.removeEventListener('load', measure)
        img.removeEventListener('error', measure)
      }
    }

    measure()
    return () => {
      cancelled = true
    }
  }, [probeTier, finalTier, model])

  return { tier: finalTier ?? 0, probeRef, probeTier }
}
