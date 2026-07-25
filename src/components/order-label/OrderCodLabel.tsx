import { forwardRef } from 'react'
import type { OrderCodLabelModel } from '@/lib/order-label/types'
import {
  buildCityProvinceCountryLine,
  buildDisplayItems,
  formatOrderLabelDate,
  truncateAddress,
} from '@/lib/order-label/format-order-label'
import { COD_LABEL_LOGO_PATH, SENDER } from '@/lib/order-label/constants'
import styles from './OrderCodLabel.module.css'

// Logo original: CDN de Shopify (LÜMA Teeth), copiado a /public/brand/ como
// asset same-origin para evitar fallos de CORS al exportar a PNG. Ver
// src/lib/order-label/constants.ts para la ruta y la nota de versión.

interface OrderCodLabelProps {
  model: OrderCodLabelModel
}

// El bloque bajo "Número de orden" reproduce visualmente un código de barras
// (fuente monoespaciada, letter-spacing) pero es texto estilizado, NO un
// barcode real ni escaneable. Ver reporte de Fase 6/17.
export const OrderCodLabel = forwardRef<HTMLDivElement, OrderCodLabelProps>(function OrderCodLabel(
  { model },
  ref,
) {
  const cityProvinceCountry = buildCityProvinceCountryLine(model)
  const displayItems = buildDisplayItems(model.items)

  return (
    <div ref={ref} className={styles.label} data-cod-label-root>
      <div className={styles.top}>
        <div>
          <div className={styles.title}>Remitente:</div>
          <strong>{SENDER.name}</strong>
          <br />
          {SENDER.addressLines.join(', ')}
          <br />
          Tel: {SENDER.phone}
        </div>

        <div className={styles.brandLogo}>
          <img src={COD_LABEL_LOGO_PATH} alt={SENDER.name} />
          <small>ENVÍO LOCAL COD</small>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <div className={styles.title}>Destinatario:</div>
          <div>
            {model.customerName}
            <br />
            {model.addressLines.length > 0 && truncateAddress(model.addressLines.join(' '))}
            <br />
            {cityProvinceCountry}
            {model.phone && (
              <>
                <br />
                Tel: {model.phone}
              </>
            )}
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <div className={styles.title}>Contenido:</div>
          <div className={styles.items}>
            {displayItems.lines.length > 0 ? (
              <>
                {displayItems.lines.map((line, i) => (
                  <span key={`${line}-${i}`}>
                    {line}
                    <br />
                  </span>
                ))}
                {displayItems.truncated && (
                  <span className={styles.itemsMore}>
                    + {displayItems.hiddenCount} producto{displayItems.hiddenCount > 1 ? 's' : ''} adicional
                    {displayItems.hiddenCount > 1 ? 'es' : ''} · {displayItems.hiddenQuantity} uds.
                  </span>
                )}
              </>
            ) : model.rawProductSummary ? (
              model.rawProductSummary
            ) : (
              'Producto no especificado'
            )}
          </div>
        </div>
      </div>

      <div className={`${styles.section} ${styles.center}`}>
        <div className={styles.title}>Recaudo:</div>
        <div className={styles.codAmount}>{model.formattedAmount}</div>
      </div>

      <div className={`${styles.section} ${styles.center}`}>
        <div className={styles.title}>Número de orden</div>
        <div className={styles.orderNumber}>{model.orderNumber}</div>
        <div className={styles.barcode}>{model.orderNumber}</div>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <div className={styles.title}>Fecha:</div>
          <div>{formatOrderLabelDate(model.createdAt)}</div>
        </div>

        <div className={styles.row}>
          <div className={styles.title}>Entrega:</div>
          <div>{model.deliveryLabel}</div>
        </div>

        <div className={styles.row}>
          <div className={styles.title}>Forma pago:</div>
          <div>{model.paymentLabel}</div>
        </div>
      </div>

      <div className={styles.footer}>
        <strong>INSTRUCCIÓN DE ENTREGA:</strong> Llamar o escribir antes de entregar. Confirmar disponibilidad y dirección.
        <br />
        <strong>NOTA:</strong> Producto de cuidado personal. No permitir apertura antes del pago.
      </div>

      {model.isCod && <div className={styles.warning}>*** NO ENTREGAR SIN COBRAR ***</div>}
    </div>
  )
})
