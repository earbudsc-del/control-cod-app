// Fuente única de datos del remitente y del template del Sticker COD.
// Ruta COD (repo separado, no puede importar este archivo) mantiene su propia
// copia en src/lib/order-label/constants.ts — debe mantenerse en sincronía manual.
// Ver reporte de auditoría del Sticker COD (2026-07-24) para el detalle de esta decisión.

export const SENDER = {
  name: 'LÜMA Teeth',
  addressLines: ['Santo Domingo Oeste', 'República Dominicana'],
  // ⚠️ PENDIENTE DE CONFIRMAR: "849790920" tiene 9 dígitos — un número dominicano
  // válido tiene 10 (código de área de 3 dígitos + 7 dígitos). Reportado en la
  // auditoría del Sticker COD (2026-07-24). No corregir por inferencia: esperar
  // confirmación del número real y corregirlo aquí una sola vez.
  phone: '849790920',
} as const

// Asset same-origin (evita CORS al generar el PNG). Fuente original: CDN de
// Shopify (ver URL documentada en OrderCodLabel.tsx). Copiado a public/brand/
// sin alterar el archivo.
export const COD_LABEL_LOGO_PATH = '/brand/luma-teeth-logo.png'

// Incrementar solo si el template visual (OrderCodLabel) cambia de forma que
// afecte cómo Ruta COD debe interpretarlo. Ambos repos deben quedar en el
// mismo número — es una marca de versión del diseño, no del modelo de datos.
// v2 (2026-07-25): compactación para volver a 4x6in EXACTAS (altura fija, no
// min-height) tras detectar que el contenido real puede desbordar — ver
// reporte de corrección de la Fase 17.
export const COD_LABEL_TEMPLATE_VERSION = 2

export const DELIVERY_LABEL_SD = 'Santo Domingo · Transporte local'
export const DELIVERY_LABEL_COURIER = 'Gintracom · Servicio de mensajería'
export const PAYMENT_LABEL_COD = 'Pago contra entrega / COD'
