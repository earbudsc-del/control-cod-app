// @page es una regla global de CSS Paged Media: no se puede scopear por clase
// ni por selector de ancestro (limitación del spec, no de la implementación).
// Sticker individual, Sticker batch y Exportar pedidos pueden tener su hoja de
// estilos de impresión cargada a la vez en la misma página (ver
// print-isolation.css) — si cada uno declara su propio `@page` de forma
// estática, el tamaño de página de UN sistema se filtra a los otros según
// cuál cargue último en el bundle (el mismo problema que .print-isolation-root
// resuelve para display:none, pero @page no admite ese truco).
//
// Fix: cada sistema instala su propio `@page` como un <style> temporal justo
// antes de window.print() y lo remueve al terminar — así el tamaño de página
// nunca compite fuera de su propio job de impresión.
export function installPrintPageStyle(pageRuleCss: string): () => void {
  // Por si quedó un <style> huérfano de un job anterior (no debería pasar,
  // pero remove() es idempotente y evita acumular <style> en <head>).
  document.querySelectorAll('[data-print-page-style]').forEach(el => el.remove())

  const style = document.createElement('style')
  style.setAttribute('data-print-page-style', 'true')
  style.textContent = pageRuleCss
  document.head.appendChild(style)

  let removed = false
  return () => {
    if (removed) return
    removed = true
    style.remove()
  }
}

// Mismo tamaño físico para Sticker individual y Sticker batch — un solo lugar
// para no duplicar el valor entre los dos componentes.
export const STICKER_LABEL_PAGE_CSS = '@page { size: 4in 6in; margin: 0; }'
