import { load, type CheerioAPI } from 'cheerio'

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface TrackingEvent {
  fecha:  string
  estado: string
}

export interface TrackingNovedad {
  fecha:   string
  mensaje: string
}

export interface TrackingResult {
  guia:                       string
  encontrado:                 boolean
  estado_actual:              string | null
  estado_global:              string | null  // Estado global EFI (ej. "Anulada") — puede diferir del estado de movimiento
  normalized_status:          string
  valor_recaudo:              string | null
  transportadora:             string | null
  fecha_creacion:             string | null
  fecha_ultima_actualizacion: string | null
  destino:                    string | null
  destinatario:               string | null
  historial_estados:          TrackingEvent[]
  historial_novedades:        TrackingNovedad[]
  attempts:                   number
  cantidad_rastreos:          number | null
  last_attempt_reason:        string | null
  _debug: {
    status_selector_used:     string
    tables_found:             number
    estados_rows:             number
    novedades_rows:           number
    raw_text_sample:          string
    near_estado_actual:       string
    near_historico_estados:   string
    near_historico_novedades: string
  }
}

// ─── Mapeo a normalized_status ────────────────────────────────────────────────

export function mapNormalizedStatus(estado: string): string {
  const s = estado.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

  // returned ANTES de delivered: "entregada a origen" / "dev. entregada a origen"
  // contienen 'entregad*' que de otro modo caerían en delivered.
  if (
    s.includes('devoluci') ||   // devolución, devolucion, devolucion entregada
    s.includes('devuelto')  ||
    s.includes('devuelta')  ||
    s.includes('retornado') ||
    s.includes('retorno')   ||
    s.includes('regresado') ||
    s.includes('a origen')  ||  // "entregada a origen", "dev. entregada a origen"
    s.includes('cancelada') ||  // "cancelada por transportadora"
    s.includes('anulad')        // "anulada" — guía anulada globalmente en EFI
  ) return 'returned'

  if (
    s.includes('entregado')          ||
    s.includes('entregada')          ||
    s.includes('entrega exitosa')    ||
    s.includes('entrega completada')
  ) return 'delivered'

  if (
    s.includes('novedad')           ||
    s.includes('ausente')           ||
    s.includes('rechazado')         ||
    s.includes('rehusado')          ||
    s.includes('zona peligrosa')    ||
    s.includes('no encontrad')      ||   // no encontrado / no encontrada
    s.includes('direccion incorrect')    // dirección/direccion incorrecta (sin tilde post-normalize)
  ) return 'novedad'

  if (
    s.includes('reparto')      ||
    s.includes('en ruta')      ||
    s.includes('mensajero')    ||
    s.includes('despacho')     ||
    s.includes('en camino')    ||
    s.includes('en entrega')   ||
    s.includes('para entrega')    // "Para entrega hoy", "Salió para entrega"
  ) return 'en_reparto'

  if (
    s.includes('transito')    ||
    s.includes('transporte')  ||
    s.includes('bodega')      ||
    s.includes('recibido')    ||
    s.includes('generada')        // "generada" — guía creada/generada por el courier
  ) return 'in_transit'

  if (
    s.includes('pendiente')   ||
    s.includes('procesando')  ||
    s.includes('creado')      ||
    s.includes('registrado')
  ) return 'pending'

  return 'unknown'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// ─── Extracción de etiquetas ──────────────────────────────────────────────────
// EFI usa: <div><span><strong>Label:</strong></span> ValorComoTextNode</div>
// Maneja tres casos:
//   1. "Label: Valor" en el mismo elemento
//   2. Valor como text-node del padre o abuelo (sin elemento contenedor propio)
//   3. Valor en el siguiente elemento hermano (layouts alternativos)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findLabelInHTML($: CheerioAPI, ...labels: string[]): string | null {
  let result: string | null = null

  $('strong,b,td,th,dt,span,p,li,label,div').each((_: number, el: any) => {
    const $el  = $(el)
    const tag: string = el.tagName?.toLowerCase() ?? ''

    // Para divs, buscar solo en texto propio (evita falsos positivos de contenedores)
    const searchTxt = tag === 'div'
      ? clean($el.clone().children().remove().end().text())
      : clean($el.text())

    const normSearch = stripAccents(searchTxt.toLowerCase())

    for (const label of labels) {
      const normLabel = stripAccents(label.toLowerCase())
      if (!normSearch.includes(normLabel)) continue

      const fullTxt  = clean($el.text())
      const colonIdx = fullTxt.indexOf(':')

      // Caso 1: "Label: Valor" en mismo elemento
      if (colonIdx !== -1) {
        const val = fullTxt.slice(colonIdx + 1).trim()
        if (val.length >= 2 && val.length < 200) {
          result = val
          return false
        }
      }

      // Caso 2: el valor es text-node del padre o abuelo
      // EFI: <div><span><strong>Label:</strong></span> Valor</div>
      const ancestors = [$el.parent(), $el.parent().parent()]
      for (const $anc of ancestors) {
        if (!$anc.length) continue
        const ownTxt = clean($anc.clone().children().remove().end().text())
        if (ownTxt.length >= 2 && ownTxt.length < 200) {
          const normOwn = stripAccents(ownTxt.toLowerCase())
          if (!normOwn.includes(normLabel.slice(0, 5))) {
            result = ownTxt
            return false
          }
        }
      }

      // Caso 3: valor en elemento hermano siguiente (layouts alternativos)
      const afterColon = colonIdx !== -1 ? fullTxt.slice(colonIdx + 1).trim() : ''
      if (afterColon.length === 0 && fullTxt.length < 60) {
        const $next   = $el.next()
        const nextTxt = $next.length ? clean($next.text()) : ''
        if (nextTxt.length >= 2 && nextTxt.length < 200 &&
            !stripAccents(nextTxt.toLowerCase()).includes(normLabel.slice(0, 5))) {
          result = nextTxt
          return false
        }
      }
    }
  })

  return result
}

// ─── Extracción de secciones de tracking (layout de clases EFI) ───────────────
// EFI usa: <p class="tracking-status">TÍTULO</p>
//          <div class="tracking-list">
//            <div class="tracking-item">
//              <div class="tracking-date">FECHA <span>HORA</span></div>
//              <div class="tracking-content">DESCRIPCIÓN</div>
//            </div>
//          </p>
// Las dos secciones (estados, novedades) están en orden, por lo que coinciden por índice
// con los dos div.tracking-list de la página.
function extractAllTrackingSections($: CheerioAPI): {
  estadoItems:    Array<{ fecha: string; texto: string }>
  novedadItems:   Array<{ fecha: string; texto: string }>
  debugEstados:   string
  debugNovedades: string
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function itemsFrom(listEl: any): Array<{ fecha: string; texto: string }> {
    const items: Array<{ fecha: string; texto: string }> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $(listEl).find('[class*="tracking-item"]').each((_: number, item: any) => {
      const $item       = $(item)
      const dateText    = clean($item.find('[class*="tracking-date"]').text())
      const contentText = clean($item.find('[class*="tracking-content"]').text())
      if (dateText && contentText) items.push({ fecha: dateText, texto: contentText })
    })
    return items
  }

  let estadoItems:  Array<{ fecha: string; texto: string }> = []
  let novedadItems: Array<{ fecha: string; texto: string }> = []

  // EFI duplica los headings en un layout responsive; solo el heading cuyo PADRE
  // tiene un tracking-list como hermano siguiente es el "real".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $('[class*="tracking-status"]').each((_: number, heading: any) => {
    const title = stripAccents(clean($(heading).text()).toLowerCase())
    const $list = $(heading).parent().nextAll('[class*="tracking-list"]').first()
    if (!$list.length) return // heading sin lista adyacente → es el duplicado

    if (title.includes('novedad')) {
      novedadItems = itemsFrom($list.get(0))
    } else {
      estadoItems = itemsFrom($list.get(0))
    }
  })

  const debugEstados   = estadoItems.map(e => `${e.fecha} — ${e.texto}`).join('\n')
  const debugNovedades = novedadItems.map(e => `${e.fecha} — ${e.texto}`).join('\n')

  return { estadoItems, novedadItems, debugEstados, debugNovedades }
}

// ─── Helpers de tablas (fallback) ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTableRows($: CheerioAPI, table: any): Array<{ col1: string; col2: string }> {
  const rows: Array<{ col1: string; col2: string }> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $(table).find('tr').each((_: number, tr: any) => {
    const cells = $(tr).find('td, th')
    if (cells.length >= 2) {
      rows.push({
        col1: clean($(cells.get(0)).text()),
        col2: clean($(cells.get(1)).text()),
      })
    }
  })
  return rows.filter(r => r.col1 && r.col2)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findSectionTable($: CheerioAPI, keyword: string): any | null {
  const kw = stripAccents(keyword.toLowerCase())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let found: any = null

  $('h1,h2,h3,h4,h5,h6,th,td,div,p,span,b,strong').each((_: number, el: any) => {
    const txt = stripAccents(clean($(el).text()).toLowerCase())
    if (txt.includes(kw)) { found = el; return false }
  })
  if (!found) return null

  const parentTable = $(found).closest('table')
  if (parentTable.length) return parentTable
  const nextTable = $(found).nextAll('table').first()
  if (nextTable.length) return nextTable
  const parentNextTable = $(found).parent().nextAll('table').first()
  if (parentNextTable.length) return parentNextTable
  const insideTable = $(found).closest('div,section,article').find('table').first()
  if (insideTable.length) return insideTable
  return null
}

// ─── Parser principal ─────────────────────────────────────────────────────────

export function parseEFITracking(html: string, guia: string): TrackingResult {
  const $ = load(html)
  const bodyText = clean($('body').text())

  const empty: TrackingResult = {
    guia,
    encontrado:                 false,
    estado_actual:              null,
    estado_global:              null,
    normalized_status:          'unknown',
    valor_recaudo:              null,
    transportadora:             null,
    fecha_creacion:             null,
    fecha_ultima_actualizacion: null,
    destino:                    null,
    destinatario:               null,
    historial_estados:          [],
    historial_novedades:        [],
    attempts:                   0,
    cantidad_rastreos:          null,
    last_attempt_reason:        null,
    _debug: {
      status_selector_used:     'none',
      tables_found:             $('table').length,
      estados_rows:             0,
      novedades_rows:           0,
      raw_text_sample:          bodyText.slice(0, 400),
      near_estado_actual:       '',
      near_historico_estados:   '',
      near_historico_novedades: '',
    },
  }

  const lowerBody = bodyText.toLowerCase()
  if (
    lowerBody.includes('no encontrado') ||
    lowerBody.includes('no existe')     ||
    lowerBody.includes('not found')     ||
    bodyText.length < 100
  ) {
    return empty
  }

  const result: TrackingResult = { ...empty, encontrado: true, _debug: { ...empty._debug } }

  // ── 1. Estado actual ──────────────────────────────────────────────────────
  let statusSelectorUsed = 'none'

  const estadoFromHTML = findLabelInHTML($, 'Estado actual', 'Estado Actual')
  if (estadoFromHTML) {
    result.estado_actual = estadoFromHTML
    statusSelectorUsed   = 'html-label'
  }

  // Fallback: selectores de clase
  // Se omiten textos que son títulos de sección (ej. "HISTÓRICO DE ESTADOS")
  if (!result.estado_actual) {
    for (const [i, sel] of ['[class*="estado"]','[class*="status"]','[id*="estado"]','[id*="status"]'].entries()) {
      const txt = clean($(sel).first().text())
      const normTxt = stripAccents(txt.toLowerCase())
      const isHeading = normTxt.includes('histor') || normTxt.includes('novedades')
      if (txt && txt.length > 2 && txt.length < 80 && !isHeading) {
        result.estado_actual = txt
        statusSelectorUsed   = `class-${i}`
        break
      }
    }
  }

  result._debug.status_selector_used = statusSelectorUsed
  if (result.estado_actual) {
    result.normalized_status = mapNormalizedStatus(result.estado_actual)
  }

  // Rechazar títulos de sección como "HISTÓRICO DE ESTADOS" — nunca son un estado válido
  if (result.estado_actual) {
    const normEstado = stripAccents(result.estado_actual.toLowerCase())
    if (normEstado.includes('histor') || normEstado.includes('novedades')) {
      result.estado_actual     = null
      result.normalized_status = 'unknown'
      result._debug.status_selector_used += '-rejected-heading'
    }
  }

  // Debug: texto cercano a "Estado actual" en el body
  const normBody = stripAccents(bodyText.toLowerCase())
  const eaIdx = normBody.indexOf('estado actual')
  if (eaIdx !== -1) {
    result._debug.near_estado_actual = bodyText.slice(Math.max(0, eaIdx - 10), eaIdx + 250)
  }

  // ── 2. Campos etiquetados ────────────────────────────────────────────────
  result.valor_recaudo              = findLabelInHTML($, 'Valor de recaudo', 'Valor recaudo', 'Recaudo')
  result.transportadora             = findLabelInHTML($, 'Transportadora', 'Empresa transportadora')
  result.fecha_creacion             = findLabelInHTML($, 'Fecha de creación', 'Fecha creacion', 'Fecha de Creacion', 'Fecha Creación')
  result.fecha_ultima_actualizacion = findLabelInHTML($, 'Fecha rastreo anterior', 'Ultima actualización', 'Ultima actualizacion', 'Último rastreo')
  result.destino                    = findLabelInHTML($, 'Destino')
  result.destinatario               = findLabelInHTML($, 'Destinatario')

  const cantRaw = findLabelInHTML($, 'Cantidad de rastreos', 'Cantidad rastreos')
  if (cantRaw) {
    const n = parseInt(cantRaw, 10)
    if (!isNaN(n)) result.cantidad_rastreos = n
  }

  // ── 3 & 4. Histórico de estados y novedades ─────────────────────────────
  // Estrategia A: clases tracking-item / tracking-content (layout nativo EFI)
  const { estadoItems, novedadItems, debugEstados, debugNovedades } =
    extractAllTrackingSections($)

  result._debug.near_historico_estados   = debugEstados.slice(0, 400)
  result._debug.near_historico_novedades = debugNovedades.slice(0, 400)

  if (estadoItems.length > 0) {
    result.historial_estados   = estadoItems.map(e => ({ fecha: e.fecha, estado: e.texto }))
    result._debug.estados_rows = estadoItems.length
  } else {
    // Estrategia B: tabla fallback
    const tbl = findSectionTable($, 'historico de estados')
    if (tbl) {
      const rows = extractTableRows($, tbl).filter(r => !r.col1.toLowerCase().includes('fecha'))
      result.historial_estados   = rows.map(r => ({ fecha: r.col1, estado: r.col2 }))
      result._debug.estados_rows = rows.length
    }
  }

  if (novedadItems.length > 0) {
    result.historial_novedades    = novedadItems.map(e => ({ fecha: e.fecha, mensaje: e.texto }))
    result._debug.novedades_rows  = novedadItems.length
  } else {
    // Estrategia B: tabla fallback
    const tbl = findSectionTable($, 'historico de novedades')
    if (tbl) {
      const rows = extractTableRows($, tbl).filter(r => !r.col1.toLowerCase().includes('fecha'))
      result.historial_novedades    = rows.map(r => ({ fecha: r.col1, mensaje: r.col2 }))
      result._debug.novedades_rows  = rows.length
    }
  }

  // ── 5. Fallback estado_actual: primer registro del historial ─────────────
  if (!result.estado_actual && result.historial_estados.length > 0) {
    result.estado_actual     = result.historial_estados[0]!.estado
    result.normalized_status = mapNormalizedStatus(result.estado_actual)
    result._debug.status_selector_used = 'first-estados-item'
  }

  // Si sigue sin estado reconocible pero hay novedades → implica intentos fallidos
  if (result.normalized_status === 'unknown' && result.historial_novedades.length > 0) {
    result.normalized_status = 'novedad'
  }

  // ── 6. Métricas derivadas ────────────────────────────────────────────────
  result.attempts = result.historial_novedades.length
  if (result.historial_novedades.length > 0) {
    result.last_attempt_reason =
      result.historial_novedades[result.historial_novedades.length - 1]!.mensaje
  }

  // ── 7. Estado global (override de cancelación) ───────────────────────────
  // EFI distingue "Estado global" (p.ej. "Anulada") del "Estado actual" de movimiento
  // ("Generada"). Si el estado global indica cancelación, prevalece sobre todo lo anterior.
  const estadoGlobal = findLabelInHTML($, 'Estado global', 'Estado Global', 'Estado de la guia', 'Estado de la Guia')
  if (estadoGlobal) {
    result.estado_global = estadoGlobal
    const normGlobal = stripAccents(estadoGlobal.toLowerCase())
    if (normGlobal.includes('anulad') || normGlobal.includes('inactiv')) {
      // La guía fue anulada en EFI; el estado de movimiento interno ("Generada") es
      // irrelevante para la clasificación operativa.
      result.estado_actual     = estadoGlobal   // raw_status = "Anulada"
      result.normalized_status = 'returned'
    }
  }

  // ── 7b. Fallback: escaneo del texto plano del body ─────────────────────────
  // findLabelInHTML puede fallar cuando EFI cambia la estructura HTML (etiqueta como
  // text-node suelto, nesting imprevisto, etc.). Como segundo intento, buscar el
  // patrón directamente en el texto plano del body completo.
  // IMPORTANTE: lowerBody y bodyText tienen la misma longitud (toLowerCase conserva
  // índices), por lo que podemos usar el índice de lowerBody para slicear bodyText.
  if (!result.estado_global) {
    const egMatch = /estado\s+(?:global|de\s+la\s+gu[íi]a)\s*:?\s*/i.exec(lowerBody)
    if (egMatch) {
      const after  = bodyText.slice(egMatch.index + egMatch[0].length).trimStart()
      // Tomamos hasta 2 palabras (ej. "Anulada", "Activa", "En proceso")
      const rawVal = after.split(/\s+/).slice(0, 2).join(' ').trim().slice(0, 40)
      if (rawVal.length >= 2) {
        result.estado_global = rawVal
        const normVal = stripAccents(rawVal.toLowerCase())
        if (normVal.includes('anulad') || normVal.includes('inactiv')) {
          result.estado_actual     = rawVal
          result.normalized_status = 'returned'
        }
      }
    }
  }

  // Log de diagnóstico — ayuda a verificar qué detectó el parser en producción
  if (result.estado_global) {
    console.log(
      `[efi-parser] guia=${guia} estado_global="${result.estado_global}" ` +
      `estado_actual="${result.estado_actual}" normalized="${result.normalized_status}"`,
    )
  }

  result._debug.tables_found    = $('table').length
  result._debug.raw_text_sample = bodyText.slice(0, 400)

  return result
}
