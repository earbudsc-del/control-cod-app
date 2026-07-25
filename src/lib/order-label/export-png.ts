import { toPng } from 'html-to-image'

// 4in x 6in a 96 CSS px/in (definición estándar de la unidad "in" en CSS) =
// 384x576 EXACTOS — ancho y alto son fijos, no un mínimo. El template
// (OrderCodLabel.module.css v2) está compactado para que todo el contenido
// esencial quepa dentro de esta caja fija; los dos únicos bloques de
// longitud variable (dirección, lista de productos) se acotan de forma
// explícita en el propio componente (line-clamp visible / resumen "+N
// productos"), nunca aquí.
const CSS_WIDTH_PX = 384
const CSS_HEIGHT_PX = 576

// pixelRatio 3.125 sobre 384x576 → exactamente 1200x1800 px de salida.
const PIXEL_RATIO = 3.125
const EXPECTED_WIDTH_PX = Math.round(CSS_WIDTH_PX * PIXEL_RATIO)
const EXPECTED_HEIGHT_PX = Math.round(CSS_HEIGHT_PX * PIXEL_RATIO)

export class LabelExportDimensionError extends Error {}

// Exporta el nodo del Sticker COD a un PNG (data URL) de EXACTAMENTE
// 1200x1800px. Usa dimensiones explícitas (no getBoundingClientRect ni
// scrollHeight) para que el resultado sea correcto incluso si el preview en
// pantalla está escalado visualmente vía CSS transform. Tras capturar,
// valida programáticamente el tamaño real del PNG — si no coincide con lo
// esperado, lanza en vez de devolver un archivo incorrecto (el llamador no
// debe descargar/compartir ese resultado).
export async function exportOrderCodLabelPng(node: HTMLElement): Promise<string> {
  if (typeof document !== 'undefined' && 'fonts' in document) {
    await document.fonts.ready
  }

  const images = Array.from(node.querySelectorAll('img'))
  await Promise.all(
    images.map(
      img =>
        img.complete
          ? Promise.resolve()
          : new Promise<void>(resolve => {
              img.onload = () => resolve()
              img.onerror = () => resolve()
            }),
    ),
  )

  const dataUrl = await toPng(node, {
    width: CSS_WIDTH_PX,
    height: CSS_HEIGHT_PX,
    pixelRatio: PIXEL_RATIO,
    backgroundColor: '#ffffff',
    cacheBust: true,
    style: {
      transform: 'none',
      margin: '0',
    },
  })

  const { width, height } = await readPngDimensions(dataUrl)
  if (width !== EXPECTED_WIDTH_PX || height !== EXPECTED_HEIGHT_PX) {
    throw new LabelExportDimensionError(
      `El PNG generado mide ${width}x${height}px — se esperaba ${EXPECTED_WIDTH_PX}x${EXPECTED_HEIGHT_PX}px exactos.`,
    )
  }

  return dataUrl
}

async function readPngDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const blob = await (await fetch(dataUrl)).blob()
    const bitmap = await createImageBitmap(blob)
    const dims = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return dims
  }
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('No se pudo leer el PNG generado para validar sus dimensiones.'))
    img.src = dataUrl
  })
}
