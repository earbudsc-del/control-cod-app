# Control COD — Fuente de verdad del sistema

**Stack:** Next.js 15 (App Router) · Supabase (DB + Auth + RLS) · EFI tracking (scraping HTML) · Node.js cron local

---

## 1. ESTADO ACTUAL DEL SISTEMA

### Módulos activos

| Módulo | Ruta / archivo | Estado |
|---|---|---|
| Webhook Shopify `orders/create` | `/api/webhooks/shopify` | Activo — requiere ngrok en dev |
| Cron de tracking EFI | `vercel.json` → `GET /api/tracking/auto` (Vercel Cron) | Cada 5 min en producción, sin dependencia de PC local |
| Dashboard admin | `/dashboard` | KPIs + cola de trabajo + alertas SLA + tarjetas confirmados hoy/ayer |
| Confirmación | `/confirmacion` | Solo pedidos `pending + tracking IS NULL`. Stats, tabs, orden inteligente (`source='shopify_webhook'`) |
| Confirmados | `/confirmados` | Pedidos `confirmed + tracking IS NULL`. Filtros fecha, botón "Listo para despacho" |
| Despachados | `/despachados` | Pedidos `tracking IS NOT NULL + no finalizados`. Vista monitoreo, refresh 5 min, mini KPI por estado |
| Novedades | `/novedad` | Tabla acciones, métricas agente, filtros por intentos, mini KPI pipeline, tab Recuperadas |
| Reparto | `/reparto` | Tabla criticidad por tiempo, acciones, métricas, mini KPI pipeline, tab Entregados DB-backed |
| Tránsito | `/transito` | Pedidos `in_transit` sin movimiento, criticidad por horas, refresh 5 min |
| My-tasks | `/my-tasks` | Filtrado por rol automáticamente |
| Panel admin | `/settings` | Ver usuarios (con email, último login, última acción), asignar roles con confirm dialog |
| Auth + sesión | `middleware.ts` | Funcional — tokens se refrescan correctamente |
| Sidebar dinámico | `components/layout/sidebar.tsx` | Nav por rol desde `NAV_BY_ROLE` |
| Duplicados | webhook + `/orders/[id]` | Detecta por customer_phone en ventana 7 días |
| Parser EFI | `src/lib/tracking/efi-parser.ts` | Basado en divs `tracking-item/content`, fallback a tablas |
| Pipeline mini KPI | `components/shared/flujo-kpis.tsx` | Generadas → Tránsito → En reparto (en /novedad y /reparto) |
| Alertas críticas | `src/lib/alert-helpers.ts` + `components/shared/alert-badges.tsx` | Duplicado + Fuera de cobertura en /confirmacion y /confirmados |

### APIs internas relevantes

| Endpoint | Qué hace |
|---|---|
| `GET /api/debug/shopify-webhook-ingestion` | **Debug** — requiere sesión. Muestra: total webhook hoy, últimos 30 pedidos, distribución por `confirmation_status` y `customer_confirmed`, conteo de cuántos de los últimos 30 serían visibles en `/confirmacion`. Fuente de verdad para diagnosticar si pedidos entran a DB. |
| `POST /api/admin/recover-shopify-orders` | **Solo admin.** Recupera pedidos faltantes por rango de fecha RD. Body: `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD", order_numbers?: ["#8522", ...] }`. Compara por `shopify_order_id`, inserta faltantes con `source='shopify_webhook'` + task de confirmación. Requiere `SHOPIFY_SHOP_DOMAIN` + `SHOPIFY_ADMIN_ACCESS_TOKEN`. |
| `POST /api/admin/recover-orders` | **Solo admin.** Versión directa para recuperación operativa. Body opcional: `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD" }` (default: 2026-05-03 completo). Llama a Shopify API 2026-04, inserta faltantes idempotentemente, crea tasks de confirmación. Devuelve `{ shopify_found, already_in_db, inserted, errors_count, errors }`. |
| `GET /api/confirmados` | Pedidos `confirmation_status='confirmed'`, filtros: `?filter=hoy\|ayer`, `?from=&to=` |
| `GET /api/flujo-stats` | Conteos pipeline: `generadas` (raw_status ilike 'generada'), `in_transit`, `en_reparto` |
| `GET /api/dashboard` | Stats generales + `confirmed_hoy` + `confirmed_ayer` |
| `GET /api/novedad/performance` | Métricas agente novedad: trabajados, reprogramados, tasaRecuperación, **recuperadasHoy/Ayer** |
| `GET /api/reparto/performance` | Métricas agente reparto: entregados, contactados, críticos activos, **entregadosAyer** |
| `POST /api/reparto/orders/[id]/mark-delivered` | Registra entrega por agente. Solo admin/delivery_agent. No modifica normalized_status. Retorna `{ action_id, reported_at, courier_confirmed, pending_validation }` |
| `GET /api/reparto/entregados` | Pedidos entregados hoy+ayer. **Fuente 1 (principal):** `normalized_status='delivered'` con `last_tracking_update >= ayer`. **Fuente 2 (secundaria):** `agent_actions type='delivered'` sin confirmación EFI. Merge deduplicado, EFI toma precedencia. |
| `GET /api/novedad/recuperadas` | Pedidos recuperados hoy+ayer: via acción 'recovered' o via `follow_up_result IN (recovered,delivered)` con `normalized_status='delivered'` |

### Módulos activos — actualizaciones recientes

| Cambio | Fecha | Archivos |
|---|---|---|
| **Vercel Cron Job: tracking en producción cada 5 min sin dependencia de PC local** | 2026-05-06 | `vercel.json` (nuevo), `api/tracking/auto/route.ts` |
| **Gestión de usuarios mejorada: email, último login, última acción, confirm dialog en rol** | 2026-05-06 | `api/profiles/route.ts`, `src/types/index.ts`, `settings/page.tsx` |
| **Pipeline nav: barra horizontal Confirmación → Sin guía → Despachados en los 3 módulos** | 2026-05-06 | `api/confirmacion/stats/route.ts`, `confirmacion/page.tsx`, `confirmados/page.tsx`, `despachados/page.tsx` |
| **P0 Paso 3: /confirmacion limpia (solo pending+sin tracking), /confirmados ajustado, /despachados creado** | 2026-05-06 | `api/confirmacion/route.ts`, `api/confirmacion/stats/route.ts`, `confirmacion/page.tsx`, `api/confirmados/route.ts`, `confirmados/page.tsx`, `api/despachados/route.ts`, `despachados/page.tsx`, `sidebar.tsx` |
| **recover-shopify-orders: sincroniza tracking_number desde Shopify fulfillments** | 2026-05-06 | `src/app/api/admin/recover-shopify-orders/route.ts` |
| **Fix cron: procesa todos los pedidos con tracking_number (no solo ACTIVE_STATUSES)** | 2026-05-05 | `src/app/api/tracking/auto/route.ts` |
| **Fix parser: "Para entrega hoy" / "Salió para entrega" → en_reparto** | 2026-05-05 | `src/lib/tracking/efi-parser.ts` |
| **Buscador en /confirmacion** | 2026-05-05 | `confirmacion/page.tsx` |
| **Acción "Sin cobertura" (`no_coverage`)** | 2026-05-05 | `api/orders/[id]/confirmation/route.ts`, `api/confirmacion/stats/route.ts`, `api/confirmacion/performance/route.ts`, `confirmacion/page.tsx` |
| **Ocultado botón "Nro incorr." en UI** | 2026-05-05 | `confirmacion/page.tsx` (backend `wrong_number` intacto) |
| **Botones reorganizados en 2 filas** | 2026-05-05 | `confirmacion/page.tsx` |
| **Toast + remoción de fila en /confirmacion** | 2026-05-05 | `confirmacion/page.tsx` |

**P0 Paso 3 — Separación en 3 módulos distintos (2026-05-06):**

**Problema resuelto:** El tab "Nuevos" de /confirmacion mostraba pedidos con `tracking_number` ya asignado. En lugar de agregar tabs dentro de /confirmacion, se crearon módulos separados para mantener cada pantalla enfocada.

**3 módulos distintos:**

| Módulo | URL | Filtro DB | Acciones |
|---|---|---|---|
| **Confirmación** | `/confirmacion` | `source='shopify_webhook' AND confirmation_status='pending' AND tracking_number IS NULL AND normalized_status NOT IN (delivered, returned)` | Confirmó / No contesta / Sin cobertura / Canceló |
| **Confirmados** | `/confirmados` | `source='shopify_webhook' AND confirmation_status='confirmed' AND tracking_number IS NULL AND normalized_status NOT IN (delivered, returned)` | "Listo para despacho" (UI local) |
| **Despachados** | `/despachados` | `source='shopify_webhook' AND tracking_number IS NOT NULL AND normalized_status NOT IN (delivered, returned, cancelled)` | WA / Llamar / Ver detalle (monitoreo) |

**`/api/confirmacion/route.ts`:**
- Ahora incluye `.is('tracking_number', null)` — pedidos con guía ya asignada NO aparecen en la cola de confirmación

**`/api/confirmacion/stats/route.ts`:**
- `pendingBase()` incluye `.is('tracking_number', null)` — todos los contadores (Nuevos/Reintentar/Atrasados) excluyen pedidos despachados
- `fetchData` tiene `try/finally` con `setLoading(false)` (fix de CLAUDE.md rule)

**`/api/confirmados/route.ts`:**
- Añadido `.is('tracking_number', null)` al query principal y a los stats `confirmados_hoy/ayer`
- Stats ahora cuentan "confirmados sin guía hoy/ayer" (no "total confirmados")

**`/confirmados/page.tsx`:**
- Textos actualizados: "Confirmados sin guía · Pendientes de asignar tracking"
- Cards: "Sin guía hoy" / "Sin guía ayer"

**`/api/despachados/route.ts` (NUEVO):**
- Query: `tracking IS NOT NULL AND normalized_status NOT IN (delivered, returned, cancelled)`
- Respuesta: `{ data, total, byStatus }` — `byStatus` es un Record<string, number> con conteo por normalized_status

**`/despachados/page.tsx` (NUEVO):**
- Banner azul con total "EN RUTA"
- Mini KPI por estado (in_transit, en_reparto, novedad, unknown, pending) — solo muestra los presentes
- Buscador por nombre, teléfono, #pedido, guía, ciudad
- Tabla: Cliente, Guía, Ciudad/Producto, Monto, Estado logístico (con raw_status debajo), Último movimiento (relativo), WA/Llamar, Ver detalle
- Auto-refresh cada 5 min (mismo ciclo que el cron de tracking)
- Paginación PAGE_SIZE=50

**`/sidebar.tsx`:**
- `/despachados` añadido al nav de `admin` entre `/confirmados` y `/orders`
- Icono: `Truck`, alert: `null`

**Pipeline nav (2026-05-06) — barra horizontal en /confirmacion, /confirmados, /despachados:**
- Componente inline (no shared) en cada página: 3 segmentos horizontales separados por `ChevronRight`
- Segmento activo = fondo sólido (indigo en /confirmacion, green en /confirmados, blue en /despachados), texto blanco, muestra count del propio módulo
- Segmentos inactivos = fondo blanco con hover coloreado, `Link` a la ruta correspondiente, muestra count numérico
- Posición: después del bloque "Mi día" (agent perf) en /confirmacion; después del banner en /confirmados y /despachados
- `/api/confirmacion/stats` ahora devuelve también `pendingTotal`, `confirmadosSinGuia`, `despachados` (3 queries HEAD adicionales en el Promise.all)
- /confirmados y /despachados hacen un fetch adicional a `/api/confirmacion/stats` para obtener los counts de los otros segmentos; se hace en paralelo con el fetch principal (`Promise.all`)
- Counts: /confirmacion usa `total` + `stats.confirmadosSinGuia` + `stats.despachados`; /confirmados usa `pipelineCounts.pendingTotal` + `orders.length` + `pipelineCounts.despachados`; /despachados usa `pipelineCounts.pendingTotal` + `pipelineCounts.confirmadosSinGuia` + `total`

**Comportamiento automático:** Si `recover-shopify-orders` o un futuro webhook de fulfillment asigna `tracking_number`, en el próximo refresh el pedido desaparece de `/confirmacion` y `/confirmados` y aparece en `/despachados`.

**Buscador /confirmacion:** `searchQuery` state filtra `activeSource` sobre `customer_name`, `customer_phone`, `order_number`. Resultado en `filteredOrders`. Paginación y contador de resultados usan `filteredOrders`. Reset al cambiar tab o búsqueda.

**`no_coverage` — confirmation_status:** valor de texto puro, no requiere migración de DB. API endpoint acepta la acción, inserta nota "Pedido marcado como Sin cobertura" en tabla `notes`. Stats API añade conteo `sinCobertura`. Performance API añade `sinCoberturaHoy`. Page muestra badge naranja, conteo en "Mi día" y en grid de métricas. Botón usa icono `MapPinOff` naranja.

**Toast + remoción de fila:** `showToast(msg, type)` usa `toastTimerRef` para auto-dismiss en 3s. Toast fijo top-right, fondo `gray-900` (éxito) o `red-600` (error). Mensajes por acción: `confirmed` → "✓ Pedido confirmado", `no_coverage` → "Pedido marcado como Sin cobertura", `cancelled` → "Pedido cancelado", `no_answer` → "Intento N/3 registrado" / "Pedido marcado como inalcanzable". Si `res.ok === false` → toast de error visible. Acciones de rechazo (`no_coverage`, `cancelled`, etc.) remueven la fila de `orders` después de 1.5s; `confirmed` permanece visible en sesión para conteo.

**`wrong_number`:** eliminado de los botones visibles. El `TERMINAL` map lo mantiene para mostrar badge en pedidos ya marcados. El backend y la acción API siguen operativos.

---

### Problemas ya resueltos

| Problema | Causa raíz | Fix aplicado |
|---|---|---|
| `/api/dashboard` devolvía 401 tras reinicio | `middleware.ts` hacía early return `/api` antes de `getUser()` → tokens nunca se refrescaban | Mover `getUser()` antes del `if (path.startsWith('/api')) return response` |
| Logout → loading infinito | `router.push('/login') + router.refresh()` competían entre sí | `window.location.href = '/login'` |
| Login → nada al hacer clic / no redirige | Mismo race condition post-signIn | `window.location.href = '/dashboard'` |
| Todos los módulos en loading infinito | `fetchData` en novedad y reparto usaba `Promise.all` sin `try/finally` — si cualquier fetch lanzaba, `setLoading(false)` nunca se ejecutaba | Envolver todo el `Promise.all` en `try { } finally { setLoading(false) }` |
| Dashboard crasheaba si API devolvía error | `if (!data) return null` no capturaba `{ error: '...' }` — `stats.on_delivery` lanzaba TypeError | Cambiado a `if (!data?.stats) return null` |
| Webhook caído | ngrok session expirada en dev | Reiniciar ngrok y actualizar URL en Shopify Partners |
| Caché corrupto de Next.js | `.next/` con artefactos de build anteriores | `rm -rf .next` → `npm run dev` |
| "generada" → unknown | Sin mapeo en parser ni detector | Añadido a `efi-parser.ts` y `attempt-detector.ts` |
| "cancelada por transportadora" → unknown | Sin mapeo | Añadido a ambos archivos, evaluado antes de estados ambiguos |
| **CRÍTICO: Pedidos Shopify invisibles en /confirmacion y /confirmados** | `/api/confirmacion/route.ts` (y stats + performance) filtraban `.eq('customer_confirmed', false)` — el webhook crea órdenes con `customer_confirmed = NULL` → en PostgreSQL `NULL ≠ false` → pedidos excluidos → agentes no podían confirmar → /confirmados vacío. **Fix (2026-05-03):** Eliminado el filtro de los 3 endpoints API; webhook ahora inserta `customer_confirmed: false` explícito. | 4 archivos: `api/confirmacion/route.ts`, `api/confirmacion/stats/route.ts`, `api/confirmacion/performance/route.ts`, `api/webhooks/shopify/orders/route.ts` |
| **Webhook intermitente confirmado (2026-05-03)** | Diagnóstico directo a Supabase confirmó que el problema está en el webhook, no en la UI. Los pedidos que sí llegan aparecen correctamente en `/confirmacion`. El webhook ngrok estuvo caído durante partes del día: pedidos #8518–#8521 y #8534–#8536 llegaron con exactamente 4h de demora (retry de Shopify). Pedidos #8522–#8533, #8537, #8539 nunca llegaron. A las 18:12 UTC el webhook volvió a funcionar en tiempo real (9 segundos de demora en #8542). Solución permanente: deploy en Vercel con URL fija. Recuperación de pedidos faltantes: `POST /api/admin/recover-shopify-orders`. | `api/webhooks/shopify/orders/route.ts`, `api/debug/shopify-webhook-ingestion/route.ts`, `api/admin/recover-shopify-orders/route.ts` |
| **recover-orders devuelve "tienda no encontrada" en Vercel (2026-05-04)** | `SUPABASE_SERVICE_ROLE_KEY` no estaba configurado en Vercel env vars. Sin él, `createServiceClient()` actúa como cliente anon y la RLS de `stores` bloquea el SELECT (`store_select` policy requiere `auth.uid()`). Fix: agregar `SUPABASE_SERVICE_ROLE_KEY` en Vercel Dashboard → Settings → Environment Variables y redeploy. Además actualizar `stores.shopify_domain = 'xtz4pf-nj.myshopify.com'` en Supabase. Los endpoints ahora exponen `supabase_error` en la respuesta 404 para facilitar diagnóstico futuro. | `api/admin/recover-shopify-orders/route.ts`, `api/admin/recover-orders/route.ts` |
| **recover-shopify-orders: lookup de tienda con trim+toLowerCase (2026-05-04)** | El endpoint fallaba con "No se encontró tienda activa" aunque el webhook sí la encontraba. Causa probable: espacio o mayúscula en `SHOPIFY_SHOP_DOMAIN` vs valor en DB. Fix (paso 7): normaliza el domain con `.trim().toLowerCase()` antes del lookup, usa `.single()` en vez de `.maybeSingle()`, loguea `[recover-diag] domain used / store found / store error`. Eliminado el fallback a primera tienda activa. Usa `service` (createServiceClient — bypass RLS). | `src/app/api/admin/recover-shopify-orders/route.ts` |
| **recover-shopify-orders: mapeo robusto de cliente (2026-05-04)** | Pedidos recuperados llegaban con NULL en nombre/teléfono/dirección porque el mapeo anterior usaba solo `customer?.phone` y `addr?.address1`. Fix: mapeo reemplazado por versión robusta que prueba múltiples fuentes: `customer_name` = shipping.name > "first last" > billing.name; `customer_phone` = shipping.phone > billing.phone > customer.phone > order.phone; `customer_address` = address1+address2 de shipping, fallback billing; `city`/`province` = shipping > billing. Interfaces actualizadas: `ShopifyAddress` agrega `address2`, `ShopifyOrder` agrega `phone`. Log por pedido: `[recover-diag] mapped customer`. Se aplica a INSERT y UPDATE. | `src/app/api/admin/recover-shopify-orders/route.ts` |
| **recover-shopify-orders: diagnóstico pedido #8582 + fields Shopify ampliado (2026-05-04, TEMPORAL)** | Pedidos sin datos de cliente a pesar del mapeo robusto. Causa encontrada: `fields=` en `fetchShopifyOrders` no incluía `phone,email,contact_email,note_attributes,order_number` — Shopify no los devolvía. Fix diagnóstico: `fields` ampliado para incluir todos esos campos. Interfaces `ShopifyOrder` actualizadas con los nuevos campos. Log `[recover-diag] RAW SHOPIFY ORDER #8582` añadido al inicio del loop. **Eliminar log de #8582 tras analizar output.** | `src/app/api/admin/recover-shopify-orders/route.ts` |
| **Fix cron: pedidos en `pending` con tracking_number nunca se sincronizaban con Effi (2026-05-05)** | El cron filtraba `.in('normalized_status', ACTIVE_STATUSES)` — `pending` no estaba incluido. Pedidos confirmados y despachados manualmente, o importados por CSV con `pending`, tenían guía en Effi pero el cron los ignoraba indefinidamente. Fix: reemplazado por `.not('normalized_status', 'in', '(delivered,returned,cancelled)')` — ahora cualquier pedido con tracking_number que no esté en estado final es procesado. El bloque de confirmation tasks para `pending` se conserva: el import de Excel no llama a `createTaskIfNotExists`, así que el cron es el único mecanismo que crea esas tasks para pedidos importados. | `src/app/api/tracking/auto/route.ts` |
| **Fix /reparto: estados Effi "Para entrega hoy" / "Salió para entrega" mapeaban a unknown (2026-05-05)** | `efi-parser.ts/mapNormalizedStatus()` no tenía el patrón `'para entrega'`. Los estados "Para entrega hoy" y "Salió para entrega" (normalizados: "para entrega hoy" / "salio para entrega") no contienen las substrings ya mapeadas ('en entrega', 'reparto', 'mensajero', etc.) y caían en `unknown`. El cron los sacaba de /reparto. Fix: añadido `s.includes('para entrega')` al bloque `en_reparto`. Un solo patrón cubre ambos estados. `attempt-detector.ts` ya los tenía correctamente. | `src/lib/tracking/efi-parser.ts` |
| **note_attributes como fuente primaria de datos de cliente (2026-05-05)** | Confirmado que los datos del cliente vienen en `note_attributes` con claves "Nombre completo", "WhatsApp", "Dirección", "Provincia", "Ciudad" — NO en `shipping_address` ni `customer`. Fix aplicado en ambos endpoints: helper `getNote(key)` busca por clave parcial case-insensitive. Prioridad: note_attributes > shipping > billing/customer. Aplica a INSERT y UPDATE. Interfaces actualizadas: `ShopifyAddress` agrega `address2`, `ShopifyOrderPayload` agrega `phone` y `note_attributes`, `ShopifyOrder` (recover) ya los tenía. | `src/app/api/webhooks/shopify/orders/route.ts`, `src/app/api/admin/recover-shopify-orders/route.ts` |
| **recover-shopify-orders: logs de diagnóstico de env vars (2026-05-04, TEMPORAL)** | Se añadieron 2 `console.log` al inicio del handler para verificar disponibilidad de env vars en Vercel runtime: `SERVICE_ROLE_KEY EXISTS: true/false` y `SHOPIFY_SHOP_DOMAIN: <valor>`. **Eliminar tras confirmar en logs de Vercel.** | `src/app/api/admin/recover-shopify-orders/route.ts` |
| **webhook shopify/orders: logging diagnóstico completo (2026-05-04, TEMPORAL)** | Pedidos dejaron de entrar desde ayer 4:01 p.m. Se añadieron logs `[webhook-diag]` en todos los puntos críticos sin tocar lógica: entrada (timestamp, shop, topic, hmac presente, SERVICE_ROLE_KEY exists, WEBHOOK_SECRET exists, body_bytes), resultado HMAC (válido/inválido), shopify_order_id, resolución de tienda (por domain y fallback con errores Supabase), idempotencia, error de insert (code + message + details), status final. **Eliminar logs `[webhook-diag]` tras identificar la causa raíz.** | `src/app/api/webhooks/shopify/orders/route.ts` |

---

## 2. REGLAS DE NEGOCIO (CRÍTICO)

### Confirmación
- **Solo aplica a pedidos con `source = 'shopify_webhook'`**
- Pedido nuevo → task de tipo `confirmation` con `status = 'open'` creada automáticamente via `createTaskIfNotExists`
- Orden inteligente en `/confirmacion → Todos`:
  1. Atrasados (`created_at` > 48h) — más viejos primero
  2. Reintentar (attempts 1-2, < 48h) — menos contacto reciente primero
  3. Nuevos (attempts 0, < 48h) — FIFO
- Al confirmar → `confirmation_status = 'confirmed'`, `last_confirmation_attempt` = timestamp

### Confirmados (vista de despacho)
- Muestra pedidos con `confirmation_status = 'confirmed'`
- Visible **solo para `admin`** en el sidebar
- Filtros: hoy, ayer, rango de fechas (usa `last_confirmation_attempt` como fecha de referencia)
- Botón "Listo para despacho" por fila: **solo UI, no modifica DB todavía**
- Dashboard admin muestra tarjetas "Confirmados hoy" y "Confirmados ayer" que redirigen a `/confirmados?filter=hoy|ayer`
- Los límites de día se calculan en zona horaria `America/Santo_Domingo` (UTC-4, sin DST)

### Tránsito
- Muestra pedidos con `normalized_status = 'in_transit'`
- Accesible para: admin, ia_supervisor, novelty_agent, delivery_agent
- Criticidad por horas sin movimiento (usa `last_tracking_update` o `created_at` como fallback):
  - `>= 48h` → crítico (badge rojo)
  - `24h–48h` → riesgo (badge naranja)
  - `< 24h` → normal
- Lógica centralizada en `src/lib/transit-helpers.ts` — reutilizada en `/transito` y `/reparto`
- Refresh cada 5 min (más lento que reparto/novedad — tránsito cambia menos)

### Novedad
- `delivery_attempts >= 2` → prioridad de contacto (tab "2+ intentos")
- `delivery_attempts >= 3` → riesgo de devolución (tab "Alerta alta", badge rojo)
- Pedido sin movimiento > 1 día → aparece en "Novedad no trabajada" del dashboard admin

### Reparto
- `status_since` (migration 014) guarda momento exacto de entrada a `en_reparto`
- Fallback a `updated_at` para pedidos anteriores a la migración
- `>= 48h` sin cambio → crítico (badge rojo, alerta en dashboard)
- `24h–48h` → riesgo (badge naranja)
- `< 24h` → normal
- **Tab Entregados — EFI-driven (2026-05-02, fix 2026-05-03):** Los pedidos entregados por EFI aparecen automáticamente en el tab, sin acción manual. Al detectar `normalized_status='delivered'`, el cron fija `last_tracking_update=now()` y deja de procesar el pedido (solo procesa ACTIVE_STATUSES). El endpoint `GET /api/reparto/entregados` usa `last_tracking_update >= ayer` como filtro de fecha. **Los KPIs `entregadosHoy`/`entregadosAyer` en `/api/reparto/performance` cuentan pedidos con `normalized_status='delivered'` filtrados por `last_tracking_update`, NO por `agent_actions`.** El botón "Entregó" existe solo como reporte manual preventivo; badge: "Confirmado courier" (verde) si EFI ya confirmó, "Reportado · validando courier" (ámbar) si no.
- **Regla clave:** `last_tracking_update` para pedidos `delivered` es inmutable post-transición (cron no los re-procesa). Es el campo canónico para filtrar entregas por fecha.
- **Timezone RD:** Todos los límites de día en APIs de reparto/novedad usan `Intl.DateTimeFormat({ timeZone: 'America/Santo_Domingo' })` → `Date.UTC(y, m-1, d, 4, 0, 0, 0)` (medianoche RD = 04:00 UTC). Patrón fijo en todos los endpoints para evitar corte de pedidos cerca de medianoche.

### Novedad — tab "Entregadas" (novedades entregadas)
- **Tab "✓ Entregadas" (2026-05-02, renombrado 2026-05-03):** muestra pedidos que EFI confirmó como entregados y que tuvieron al menos un intento fallido (heurística de novedad).
- **Heurística "pasó por novedad":** `delivery_attempts > 0 OR last_attempt_reason IS NOT NULL`. `delivery_attempts` se incrementa desde `historial_novedades` en EFI — cualquier valor > 0 implica al menos un intento fallido registrado.
- **Limitación documentada:** no garantiza que el pedido haya tenido `normalized_status='novedad'` en este sistema. Podría incluir pedidos que fallaron en `en_reparto` y fueron entregados sin pasar por la pantalla de novedad. Una mejora futura sería una tabla de historial de `normalized_status`.
- **`GET /api/novedad/recuperadas`:** query `orders WHERE normalized_status='delivered' AND (delivery_attempts > 0 OR last_attempt_reason IS NOT NULL) AND last_tracking_update >= ayer RD`.
- **KPIs "Entregadas hoy/ayer" (labels actualizados 2026-05-03):** labels cambiados de "Nov. entregadas hoy/ayer" → "Entregadas hoy/ayer". Tarjetas son clickeables: activan el tab "✓ Entregadas" + aplican filtro de fecha (hoy/ayer). Segundo click en la misma tarjeta quita el filtro. Filtro activo se muestra como chip verde en el tab.
- **Columnas del tab "✓ Entregadas" (2026-05-03):** Guía, Cliente, Teléfono, Ubicación, Entregado (fecha relativa + absoluta en zona RD), Intentos previos (badge color por cantidad + last_attempt_reason), botón Ver detalle.
- **Paginación en /novedad (2026-05-03):** `PAGE_SIZE = 50`. Botones Anterior/Siguiente con conteo. Se aplica a todos los tabs (novedades activas y entregadas). Filtros activos se conservan al cambiar página. La paginación se resetea al cambiar tab, búsqueda o filtro de fecha.
- **`rdMidnightUTC(offsetDays)`:** helper client-side para calcular límites de día en zona RD (UTC-4). Reutiliza el mismo patrón que las APIs del servidor. Usado en `displayedRecuperadas` para filtrar hoy/ayer.
- **`markRecuperada(orderId)`:** acción manual que patchea `follow_up_result='recovered'` y saca el pedido de `activeOrders`. El tab "Entregadas" NO se actualiza inmediatamente al marcar — espera el próximo fetchData para mostrar datos EFI actualizados.

**Archivos modificados (2026-05-03):** `src/app/(app)/novedad/page.tsx`

### Pipeline logístico (raw_status = 'Generada')
- `raw_status = 'Generada'` (case-insensitive) indica que EFI creó la guía pero el paquete aún no ha sido recogido
- Normaliza a `in_transit` — es la etapa más temprana dentro de tránsito
- Aparece en el mini KPI "Generadas" del componente `FlujoKpis`
- El flujo operativo completo es: **Generada → In transit → En reparto → Entregado / Novedad**
- **No confundir**: "Generada" es un `raw_status` de EFI, no un `normalized_status`

### Normalización de estados (reglas permanentes)

| Estado EFI (raw_status) | normalized_status | Notas |
|---|---|---|
| contiene "devoluci\*" / "devuelto" / "a origen" / "retorn\*" / "regresado" | `returned` | Evaluado ANTES de delivered |
| contiene "cancelada" | `returned` | Cubre "cancelada por transportadora" |
| contiene "entregado" / "entregada" / "entrega exitosa" | `delivered` | |
| contiene "novedad" / "ausente" / "rechazado" / "zona peligrosa" | `novedad` | |
| contiene "reparto" / "mensajero" / "en ruta" / "despacho" / "en camino" / "en entrega" / "para entrega" | `en_reparto` | "para entrega" cubre "Para entrega hoy" y "Salió para entrega" |
| contiene "transito" / "transporte" / "bodega" / "recibido" / "generada" | `in_transit` | "generada" = guía creada, paquete aún no recogido |
| contiene "pendiente" / "procesando" / "creado" / "registrado" | `pending` | |
| ninguno anterior | `unknown` | |

---

## 3. ARQUITECTURA REAL

### Dónde ocurre la normalización

```
efi-parser.ts       → mapNormalizedStatus()          → tracking automático (cron + manual)
attempt-detector.ts → DEFAULT_PATTERNS / detectStatus() → importaciones CSV
```

**La tabla `status_patterns` de Supabase NO se usa en la lógica actual.** Los patrones viven en `DEFAULT_PATTERNS` del archivo TS.

### Sources de pedidos

| source | Origen |
|---|---|
| `shopify_webhook` | Webhook automático de Shopify en cada venta |
| `csv_import` | Importación manual desde `/imports` |
| `manual` | Creación directa en la app |

Solo `shopify_webhook` genera task de `confirmation` automáticamente.

### Campos clave en tabla `orders`

```
tracking_number, normalized_status, delivery_attempts, last_attempt_reason,
last_tracking_update, created_at, assigned_to, sla_breached, follow_up_result,
source, status_since, duplicate_alert, duplicate_of_order_id, duplicate_reason,
confirmation_status, confirmation_method, last_confirmation_attempt,
confirmation_attempts, confirmation_confidence, raw_status
```

### Tabla `tasks`

```
task_type: confirmation | novedad | follow_up | recovery
status:    open | in_progress | completed
assigned_to: UUID del agente
order_id: FK a orders
```

### Roles y visibilidad en el sidebar

| Rol | Módulos visibles en sidebar |
|---|---|
| `admin` | Dashboard, En Reparto, Novedades, Tránsito, Confirmación, **Confirmados**, Pedidos, Importar, Rendimiento, Configuración |
| `ia_supervisor` | Dashboard, Mis tareas, Tránsito, Pedidos |
| `confirmation_agent` | Mi rendimiento, Confirmaciones |
| `novelty_agent` | Mi rendimiento, Novedades, Tránsito |
| `delivery_agent` | Mi rendimiento, En Reparto, Tránsito |
| `agent` | Mis tareas, Pedidos |
| `viewer` | Pedidos (solo lectura) |

**Regla de visibilidad de /confirmados y /despachados:** Solo `admin`. No visibles para confirmation_agent, delivery_agent, ni ningún otro rol. Las rutas existen y son accesibles vía URL directa, pero no aparecen en el nav de otros roles.

### Roles y visibilidad de tareas (`/my-tasks`)

| Rol | Ve en /my-tasks | task_type visible |
|---|---|---|
| `ia_supervisor` | Todas las tareas del store | todos |
| `confirmation_agent` | Solo asignadas | confirmation |
| `novelty_agent` | Solo asignadas | novedad, recovery |
| `delivery_agent` | Solo asignadas | follow_up, recovery |
| `agent` | Solo asignadas | todos |

### Permisos

- RLS: función `is_agent_or_above()` — permite admin, ia_supervisor, confirmation_agent, novelty_agent, delivery_agent, agent
- API TS: `isAgentOrAbove()` — usada en imports, orders/actions, orders/assign, delivery attempts

### Auto-tracking (cron)

**Producción — Vercel Cron Job (principal):**
- Configurado en `vercel.json`: `GET /api/tracking/auto` cada `*/5 * * * *`
- Vercel llama el endpoint con header `Authorization: Bearer <CRON_SECRET>`
- `CRON_SECRET` es generado automáticamente por Vercel al detectar el `vercel.json` con crons
- Requiere **Vercel Pro** (plan Hobby solo permite crons diarios)
- `maxDuration = 60` segundos por ejecución (configurable en `route.ts`)
- Logs en Vercel Dashboard → Functions → `/api/tracking/auto`: `[vercel-cron] processed=N updated=N failed=N`

**Desarrollo local — script (secundario):**
- Script: `npm run cron:tracking` → `scripts/cron-tracking.mjs`
- Llama `POST http://localhost:3000/api/tracking/auto` con header `x-cron-secret: <CRON_SECRET>`
- Solo funciona con el dev server corriendo (`npm run dev`)

**Autenticación dual del endpoint:**
| Origen | Método | Header | Cliente Supabase |
|---|---|---|---|
| Vercel Cron | `GET` | `Authorization: Bearer <CRON_SECRET>` | service role (bypass RLS) |
| Script local | `POST` | `x-cron-secret: <CRON_SECRET>` | service role (bypass RLS) |
| Manual (admin logado) | `POST` | ninguno | session del usuario |

**Lógica del cron:**
- Procesa todos los pedidos con `tracking_number IS NOT NULL` excepto estados finales (`delivered`, `returned`, `cancelled`)
- Incluye `pending`, `in_transit`, `en_reparto`, `novedad`, `unknown`
- Batch de 5 pedidos en paralelo + delay de 1.5s entre batches (rate limiting EFI)
- Después del tracking: crea confirmation tasks para pedidos `pending` sin task (pedidos de Excel)
- Máximo 200 pedidos por ejecución

**Cómo verificar que funciona en producción:**
1. Vercel Dashboard → tu proyecto → Settings → Cron Jobs: debe aparecer `/api/tracking/auto` con schedule `*/5 * * * *`
2. Vercel Dashboard → Functions → ver logs de `/api/tracking/auto` con `[vercel-cron]` prefix
3. `GET https://tu-app.vercel.app/api/tracking/auto` con header `Authorization: Bearer <tu-CRON_SECRET>` → responde `{ processed, updated, failed }`

**Cómo desactivarlo temporalmente:**
- En Vercel Dashboard → Settings → Cron Jobs → deshabilitar el job
- O eliminar el bloque `crons` de `vercel.json` y redeploy

**Variables de entorno requeridas en Vercel:**
| Variable | Fuente | Uso |
|---|---|---|
| `CRON_SECRET` | Auto-generado por Vercel al agregar crons | Valida llamadas del cron y del script local |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Settings → API | Bypass RLS en el cron |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Settings → API | Conexión a DB |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Dashboard → Settings → API | Conexión a DB |

### Componentes compartidos

| Componente | Archivo | Usado en |
|---|---|---|
| `FlujoKpis` | `src/components/shared/flujo-kpis.tsx` | `/reparto`, `/novedad` |
| `AlertBadges` | `src/components/shared/alert-badges.tsx` | `/confirmacion`, `/confirmados` |
| `Spinner` | `src/components/ui/spinner.tsx` | Todos los módulos |
| `ClassificationBadge` | `src/components/orders/classification-badge.tsx` | Dashboard, órdenes |
| `SlaBadge` | `src/components/orders/sla-badge.tsx` | Dashboard, órdenes |

### Helpers de alertas críticas

`src/lib/alert-helpers.ts`:
- `OUT_OF_COVERAGE_ZONES: ZoneEntry[]` — ~90 ciudades sin cobertura (COBERTURA DESTINO = NO). Fuente: Matriz Gintracom RD 19/08/2025.
- `SPECIAL_DESTINATION_ZONES: ZoneEntry[]` — ~80 ciudades con cobertura pero que requieren coordinación especial (DESTINO ESPECIAL = SI).
- `COVERAGE_ZONES: ZoneEntry[]` — ciudades con cobertura normal. Usado solo para detección negativa de `isUnknownZone` (no genera alertas propias).
- `checkCoverage(address, city)` — devuelve `{ isOutOfCoverage, isSpecialDestination, isUnknownZone, matchedZones }`. Búsqueda normalizada (sin tildes, minúsculas) en `customer_address` + `customer_city`.
- Para agregar/quitar una zona: editar el array correspondiente en `alert-helpers.ts`.

**Función `checkCoverage` — comportamiento:**
- Extrae el nombre primario de cada zona (antes del paréntesis), mínimo 4 caracteres.
- Compara contra haystack combinado `customer_address + customer_city`.
- Prioridad de alertas: OOC > Special > Unknown (un pedido no puede tener más de una alerta activa).
- `isUnknownZone = true` cuando la ciudad no coincide con ninguna zona de las tres listas (OOC, Special, COVERAGE_ZONES).
- Ejemplo clave: `city = "La Vega"` + `address = "Constanza"` → `isOutOfCoverage = true`.
- Jarabacoa = DESTINO ESPECIAL. Constanza = FUERA DE COBERTURA. Barrio ficticio = ZONA DESCONOCIDA.
- **`ZoneEntry.terms?`** permite sobreescribir el término de búsqueda para evitar falsos positivos. Usado en: `Mella` (requiere "mella independencia" para no matchear Villa Mella) y `Cristóbal` (requiere "cristobal independencia" para no matchear San Cristóbal ciudad).
- **Terms adicionales en COVERAGE_ZONES** para nombres abreviados frecuentes (2026-05-02):
  - `"Santiago de los Caballeros"` → terms incluyen `'santiago'`
  - `"Santo Domingo"` → terms incluyen `'sto domingo'`, `'sd'`, `'santo dgo'`
  - `"La Romana"` → terms incluyen `'romana'`
  - `"San Pedro de Macorís"` → terms incluyen `'san pedro'`, `'spm'`
  - Todos los terms son pre-normalizados (minúsculas, sin tildes). Agregar más según necesidad operativa.

**Lógica de duplicados (webhook):**
- El campo `duplicate_alert: boolean` lo setea el webhook de Shopify al crear el pedido.
- Detecta mismo `customer_phone` con pedido activo en los últimos 7 días.
- Los estados activos son: `pending`, `in_transit`, `out_for_delivery`, `en_reparto`, `novedad`.
- Los campos `duplicate_of_order_id` y `duplicate_reason` almacenan el pedido relacionado y el motivo.

**Dónde se muestran las alertas:**
- `/confirmacion` → badge en columna Cliente + fondo ámbar en fila + tabs "⚠️ Duplicados", "🚫 Cobertura", "🟡 Zona desc."
- `/confirmados` → badge en columna Cliente + panel de filtros de alerta (visible solo si hay alertas); filtros: Duplicados, Fuera de cobertura, Zona desconocida
- `/orders/[id]` → banners informativos completos: ámbar=duplicado, rojo=OOC, azul=especial, amarillo=zona desconocida
- Las alertas son **solo informativas** — no bloquean acciones

**Tres estados de cobertura (fase 2 — 2026-05-02):**

| Estado | Badge | Color | Condición |
|---|---|---|---|
| Fuera de cobertura (🚫) | `Fuera de cobertura` | Rojo | `isOutOfCoverage = true` |
| Destino especial (🔵) | `Destino especial` | Azul | `isSpecialDestination = true` (y no OOC) |
| Zona desconocida (🟡) | `Zona desconocida` | Amarillo | `isUnknownZone = true` (ninguna lista matchea) |

**Qué se hizo en fase 2 (2026-05-02):**
- Archivos modificados: `alert-helpers.ts`, `alert-badges.tsx`, `confirmacion/page.tsx`, `confirmados/page.tsx`, `orders/[id]/page.tsx`
- `CoverageCheck` ahora incluye `isUnknownZone: boolean`
- `checkCoverage()` usa `_covIndex` (índice de COVERAGE_ZONES) para detección negativa — ciudad sin match en ninguna lista → `isUnknownZone=true`
- `AlertBadges` agrega badge amarillo "Zona desconocida" con icono `HelpCircle`
- `/orders/[id]` agrega banner amarillo "🟡 Zona no verificada — Confirmar ubicación exacta antes de despachar"
- `/confirmacion` agrega tab "🟡 Zona desc." con conteo; fila se resalta si `isOutOfCoverage || isUnknownZone`
- `/confirmados` agrega filtro "🟡 Zona desconocida" en panel de alertas; fila se resalta igual

### Helpers de tránsito

`src/lib/transit-helpers.ts` — lógica compartida para criticidad de pedidos en tránsito:
- `transitSinceMs(order)` — timestamp base (last_tracking_update ?? created_at)
- `horasEnTransito(order)` — horas transcurridas
- `transitCriticality(order)` — `'critico' | 'riesgo' | 'normal'`
- `sinMovimientoLabel(order)` — label legible ("Hace 2d 3h")
- `TRANSIT_STYLES` — colores por criticidad

---

## 4. FLUJO DEL SISTEMA

```
Shopify (venta)
  → webhook orders/create → /api/webhooks/shopify
    → INSERT orders (source='shopify_webhook', normalized_status='pending')
    → createTaskIfNotExists (task_type='confirmation', status='open')
    → detección de duplicados (customer_phone, ventana 7 días)

Agente confirmación (/confirmacion)
  → contacta cliente → registra resultado en agent_actions
  → si confirma → confirmation_status='confirmed', last_confirmation_attempt=now()

Admin despacho (/confirmados)
  → ve pedidos confirmed con filtro hoy/ayer/rango
  → marca "Listo para despacho" (UI local, sin DB)
  → asigna guía EFI manualmente fuera del sistema

EFI crea guía
  → raw_status = 'Generada' → normalized_status = 'in_transit'
  [Etapa visible en FlujoKpis como "Generadas"]

Cron (cada 5 min)
  → GET scraping EFI por tracking_number
  → efi-parser.ts → mapNormalizedStatus()
  → UPDATE orders (normalized_status, delivery_attempts, last_attempt_reason,
                   last_tracking_update, raw_status)

Flujo logístico post-despacho:
  in_transit (/transito)
    → monitoreo pasivo, alerta si +48h sin movimiento
    → cron actualiza automáticamente

  en_reparto (/reparto)
    → agente de reparto contacta cliente
    → acciones: Contactado, Entregado, No responde, Escalar

  novedad (/novedad)
    → agente de novedad coordina reentrega
    → acciones: Contactado, Reprogramar, No responde, No salvable

Admin ve todo en /dashboard
  → cola de trabajo, alertas SLA, stale novedad/reparto/tránsito
  → tarjetas Confirmados hoy/ayer con link a /confirmados
```

### Pipeline visual (FlujoKpis)

El componente `FlujoKpis` muestra en `/reparto` y `/novedad` un resumen horizontal del pipeline completo:

```
[📦 N Generadas] → [🚚 N En tránsito] → [🚴 N En reparto]
```

- "Generadas" = `raw_status ilike 'generada'` (guía creada, paquete no recogido aún)
- "En tránsito" = `normalized_status = 'in_transit'` (incluye Generadas)
- "En reparto" = `normalized_status = 'en_reparto'`
- Auto-refresh cada 3 minutos, independiente del fetch principal de la página

---

## 5. PROBLEMAS IMPORTANTES YA RESUELTOS

### Auth — middleware no refrescaba tokens
- **Archivo:** `src/middleware.ts`
- **Causa:** `if (path.startsWith('/api')) return response` estaba ANTES de `getUser()`. Las API routes nunca activaban el refresh del access token.
- **Fix:** `getUser()` se llama antes del early return de `/api`.

### Loading infinito en novedad y reparto
- **Archivos:** `src/app/(app)/novedad/page.tsx`, `src/app/(app)/reparto/page.tsx`
- **Causa:** `fetchData` usaba `Promise.all` sin `try/finally`. Cualquier fetch fallido dejaba `loading = true` permanentemente.
- **Fix:** Todo el cuerpo de `fetchData` envuelto en `try { } catch { } finally { setLoading(false) }`.

### Race condition en logout y login
- **Archivo:** `src/components/layout/sidebar.tsx`, `src/app/(auth)/login/page.tsx`
- **Causa:** `router.push() + router.refresh()` competían — el refresh re-renderizaba server components que intentaban redirigir de vuelta.
- **Fix:** `window.location.href` en ambos casos.

### Webhook caído en desarrollo
- **Causa:** ngrok cierra sesiones gratuitas. La URL cambia en cada reinicio.
- **Fix:** Reiniciar ngrok, copiar nueva URL, actualizar en Shopify Partners → Webhooks.

### Pedidos Shopify invisibles en /confirmacion — diagnóstico activo (2026-05-03)
- **Síntoma:** Shopify/EFI muestran pedidos nuevos pero no aparecen en la app.
- **Diagnóstico paso a paso:**
  1. Abrir `GET /api/debug/shopify-webhook-ingestion` — ver `total_hoy` y `ultimos_30_visibles_en_confirmacion`
  2. Si `total_hoy = 0` → problema en el ingreso a DB → revisar:
     - Logs del servidor: buscar `[shopify-webhook] HMAC inválido` (sospechoso A)
     - Shopify Partners → Webhooks: verificar que el evento sea `orders/create` y la URL sea correcta (sospechoso B)
     - Shopify Partners → Webhooks → historial de entregas: ver códigos de respuesta (401 = HMAC mal)
  3. Si `total_hoy > 0` pero no aparecen en `/confirmacion` → problema de filtro → revisar `por_confirmation_status_hoy`
- **Sospechoso A (HMAC):** `SHOPIFY_WEBHOOK_SECRET` en `.env.local` debe coincidir exactamente con el secret configurado en Shopify Partners. Si Shopify re-generó el secret, actualizar en `.env.local` y reiniciar la app.
- **Sospechoso B (evento):** COD orders deben usar `orders/create`. Con `orders/paid`, Shopify no dispara webhook para pedidos COD que no se cobran online.
- **Logging añadido (2026-05-03):** El webhook ahora loguea `✓ Recibido` (con shopify_order_id), `HMAC inválido` (con shop domain y body length), `Tienda resuelta` y `Idempotente`. Revisar con `console` en el servidor de la app.

### Caché corrupto de Next.js
- **Síntoma:** Errores extraños de hidratación, módulos no se actualizan, hot-reload roto.
- **Fix:** `rm -rf .next` y reiniciar el servidor de dev.

---

## 6. PENDIENTES PRIORIZADOS

### P0 — Sync fulfillment/tracking_number desde Shopify (CRÍTICO — diagnóstico 2026-05-06)

**Problema raíz:** Cuando el admin despacha una orden en EFI y fulfills en Shopify, el `tracking_number` nunca llega a nuestra DB. El cron no puede procesar la orden (filtra `tracking_number IS NOT NULL`). La orden queda `pending` indefinidamente aunque EFI la tenga en reparto.

**Ciclo roto:**
```
order/create webhook → pending, tracking=NULL
Agente confirma → confirmation_status='confirmed', tracking=NULL  ← atascado aquí
Admin despacha en EFI + fulfills en Shopify → tracking en Shopify
                                            ↑ NADIE escucha este evento
Cron no la procesa → sigue 'pending' para siempre en nuestra app
```

**Webhooks que faltan:**
- `fulfillments/create` — dispara cuando Shopify crea un fulfillment con tracking_number
- No existe ningún handler en `/api/webhooks/shopify/fulfillments/`

**Campos que faltan en endpoints de recovery:**
- `recover-shopify-orders`: `fields` no incluye `fulfillments` ni `fulfillment_status`
- `recover-orders`: ídem, campos aún más reducidos
- La Shopify Admin API sí los expone: `order.fulfillments[0].tracking_number`

**Modelo de estado correcto (sin migración de DB):**
- "Confirmada sin guía" = `confirmation_status='confirmed' AND tracking_number IS NULL`
- "Despachada" = `confirmation_status='confirmed' AND tracking_number IS NOT NULL` → `normalized_status='in_transit'` al recibir el fulfillment

**Plan de implementación:**
1. **Paso 1 (retroactivo) ✅ IMPLEMENTADO:** `recover-shopify-orders` ahora incluye `fulfillments` en los `fields` de Shopify API. Extrae `order.fulfillments.find(f => f.tracking_number).tracking_number`. En Rama A (orden existente): actualiza si `tracking_number IS NULL` en DB (nunca sobreescribe). En Rama B (orden nueva): inserta con el tracking_number. Respuesta incluye `updated_tracking` como nuevo contador. Usa `normalized_status='pending'`  — el cron (con Fix #2) actualizará el estado real desde Effi en el siguiente ciclo.
2. **Paso 2 (tiempo real, pendiente):** Crear `/api/webhooks/shopify/fulfillments/route.ts` — recibe `fulfillments/create`, busca orden por `shopify_order_id = payload.order_id`, actualiza `tracking_number` y `normalized_status='in_transit'` si estaba `pending`
3. **Paso 3 (UI) ✅ IMPLEMENTADO (2026-05-06):** `/confirmacion` limpiada (solo `pending + tracking IS NULL`). `/confirmados` ajustado a `confirmed + tracking IS NULL`. `/despachados` creado como módulo independiente. Sidebar admin actualizado. Ver detalle completo en "Módulos activos — actualizaciones recientes".
4. **Paso 4 (dashboard, pendiente):** Agregar métricas `confirmed_sin_guia` y `confirmadas_despachadas` en el dashboard admin principal (`/dashboard`)

**Queries diagnóstico:**
```sql
-- Confirmadas sin guía (el hueco principal)
SELECT count(*) FROM orders WHERE confirmation_status='confirmed' AND tracking_number IS NULL;
-- Con guía pero stuck en pending (Fix #2 las resolverá)
SELECT count(*) FROM orders WHERE tracking_number IS NOT NULL AND normalized_status='pending';
-- Distribución por source
SELECT source, count(*), count(*) FILTER (WHERE tracking_number IS NOT NULL) as con_tracking
FROM orders GROUP BY source;
```

### P1 — Tracking de jornada y actividad por agente (pendiente)

**Estado actual (2026-05-06):** `/settings` muestra email, último login (`last_sign_in_at` de auth.users) y última acción (MAX created_at en agent_actions). No hay tracking de tiempo activo ni sesiones.

**Qué falta para un dashboard de agentes completo:**

| Feature | Qué requiere |
|---|---|
| Registrar login/logout | Tabla `agent_sessions (id, agent_id, login_at, logout_at)` + hook en login/logout |
| Horas conectadas por agente | Derivado de `agent_sessions` (SUM logout_at - login_at) |
| Acciones por agente por día | Ya disponible vía `agent_actions` — solo falta la query de agregación |
| Dashboard de rendimiento por agente | `/api/admin/agent-stats` que devuelve: sesiones, horas, acciones_hoy, confirmaciones, entregas por agente |
| Historial de actividad | Timeline de `agent_actions` filtrado por agent_id — ya existe la tabla, falta la UI |
| Estado online/offline en tiempo real | Supabase Realtime Presence channel con heartbeat periódico desde el cliente |

**Approxi implementación de sesiones sin migración (usando existing columns):**
- No existe columna en `profiles` para guardar sesión activa
- Requiere nueva tabla `agent_sessions` o columna `last_seen_at` en `profiles`
- `last_seen_at` = mínimo viable: se actualiza con un ping periódico desde el cliente (ej. cada 5 min)
- "Conectado" = `last_seen_at > now() - 10 min`

**Migración sugerida cuando se implemente:**
```sql
ALTER TABLE profiles ADD COLUMN last_seen_at timestamptz;
CREATE INDEX idx_profiles_last_seen ON profiles(last_seen_at);
```

### P1 — Botón "Listo para despacho" → persistir en DB
- En `/confirmados`, el botón actualmente solo actualiza el estado local (UI)
- Después de P0: cuando Shopify fulfillment llega, `tracking_number` se guarda automáticamente → ese es el trigger real de "despachado"
- El botón podría quedar como confirmación manual para casos sin Shopify

### P2 — Reprogramación + sync con EFI
- Cuando agente marca "Reprogramado" en novedad → actualizar fecha estimada en EFI (si API disponible) o al menos registrar en `orders.scheduled_date`
- Evitar que el cron sobreescriba el estado `novedad` de un pedido reprogramado que aún no fue intentado

### P3 — Escalamiento entre agentes
- Si un pedido supera X días sin resolución → reasignar automáticamente al ia_supervisor
- Tabla `escalations` o campo `escalated_to` en tasks
- Notificación al receptor del escalamiento

### P4 — Carritos abandonados
- Shopify webhook `checkouts/create` o `checkouts/update`
- Pedidos que llegaron a checkout pero no completaron pago
- Task de tipo `recovery` asignada a confirmation_agent

### P5 — Cobertura geográfica
- Mapa o tabla de ciudades con mayor tasa de devolución
- Basado en `orders.city` + `normalized_status = 'returned'`
- Útil para bloquear zonas de alto riesgo en Shopify

### P6 — Alertas operativas de novedad
- Notificación al ia_supervisor cuando un pedido supera 3 intentos
- Badge pulsante diferenciado ya implementado (2 = amarillo, 3+ = rojo)

---

## PAGINACIÓN (implementada 2026-05-03)

| Módulo | Patrón | Tamaño página | Reset en |
|---|---|---|---|
| `/novedad` | Client-side slice de `displayedOrders`/`displayedRecuperadas` | 50 | tab, búsqueda, filtro fecha |
| `/confirmacion` | Client-side slice de `displayedOrders` | 50 | tab |
| `/confirmados` | Client-side slice de `displayed` | 50 | activeFilter, searchQuery, alertFilter |
| `/reparto` | Client-side slice de `displayedOrders` | 50 | tab, búsqueda |
| `/transito` | Client-side slice de `sorted` | 50 | sorted.length (nuevo fetch) |

- Todos los módulos usan el mismo patrón: `useMemo` que hace `.slice()`, `useState(currentPage)`, `useEffect` que resetea a 1 cuando cambian los filtros
- El UI de paginación (Anterior/Siguiente + "Página X de Y · N resultados") se muestra solo cuando `totalPages > 1`
- Los filtros activos, búsqueda y estado de acciones se conservan al paginar
- `/novedad` tiene paginación separada para el tab "✓ Entregadas" (usa `pagedRecuperadas`)

---

## REGLAS DE DESARROLLO

- No romper código existente
- No modificar el parser EFI (`efi-parser.ts`) sin necesidad — es frágil por scraping HTML
- No modificar normalización sin actualizar AMBOS archivos: `efi-parser.ts` + `attempt-detector.ts`
- No crear migraciones de DB sin confirmar con el usuario primero
- Usar `window.location.href` (no `router.push + router.refresh`) para navegaciones post-auth
- Todo `fetchData` con `Promise.all` debe tener `try/finally` con `setLoading(false)` en el finally
- Funciones de permisos centralizadas: `is_agent_or_above()` (RLS) y `isAgentOrAbove()` (TS)
- Límites de día en zona horaria RD: usar `Intl.DateTimeFormat` con `timeZone: 'America/Santo_Domingo'` — Santo Domingo es UTC-4 sin DST, medianoche RD = 04:00 UTC
- Componentes compartidos van en `src/components/shared/` — no duplicar lógica entre páginas
- `FlujoKpis` es el patrón de referencia para nuevos componentes de stats reutilizables

---

## MÓDULO FUTURO: INVENTARIO / STOCK (pausado)

Diseño acordado, pendiente de implementar después de estabilizar confirmación y tracking.

Necesidades:
- Stock inicial por SKU
- Descuento automático al despachar
- Confirmación al entregar
- Recuperación al recibir devolución física en bodega
- Diferenciar: devuelto por courier / confirmado en sistema / recibido físicamente
- Historial de movimientos: salida, entrega, devolución en tránsito, devolución recibida, ajuste manual
- Comparación inventario interno vs reporte EFI
