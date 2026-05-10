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
| Confirmación | `/confirmacion` | Base canónica: `confirmation_status='pending' AND normalized_status='pending' AND tracking_number IS NULL`. Todos los tabs heredan esta base. **Mobile-first cards + tabla desktop** |
| Confirmados | `/confirmados` | Pedidos `confirmed + tracking IS NULL`. Filtros fecha, botón "Listo para despacho" |
| Despachados | `/despachados` | Pedidos `tracking IS NOT NULL + no finalizados`. Vista monitoreo, refresh 5 min, mini KPI por estado |
| Novedades | `/novedad` | Tabla acciones, métricas agente, filtros por intentos, mini KPI pipeline, tab Recuperadas. **Mobile-first cards + tabla desktop** |
| Reparto | `/reparto` | Tabla criticidad por tiempo, acciones, métricas, mini KPI pipeline, tab Entregados DB-backed. **Mobile-first cards + tabla desktop** |
| Tránsito | `/transito` | **3 tabs por etapa: Generadas / En tránsito / Anuladas.** Criticidad por horas por etapa. Refresh 5 min. Botones "Actualizar" y "Anular" por fila. |
| My-tasks | `/my-tasks` | Filtrado por rol automáticamente |
| Panel admin | `/settings` | Ver usuarios (con email, último login, última acción), asignar roles con confirm dialog |
| Auth + sesión | `middleware.ts` | Funcional — tokens se refrescan correctamente |
| Sidebar dinámico | `components/layout/sidebar.tsx` | Nav por rol desde `NAV_BY_ROLE`. Drawer en móvil, fija en desktop |
| Nav Shell | `components/layout/nav-shell.tsx` | Client Component: topbar hamburger (móvil) + overlay + estado open/close |
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
| **Refactor /transito — nueva arquitectura 3 etapas: tabs Generadas / En tránsito / Anuladas. Separación client-side por raw_status. Alertas y mensajes de escalamiento diferenciados por etapa. Botón "Anular" manual (admin/novelty_agent). Endpoint mark-anulada. API excluye anuladas/canceladas del query in_transit.** | 2026-05-09 | `transito/page.tsx` (rewrite), `api/orders/[id]/mark-anulada/route.ts` (nuevo), `api/orders/route.ts` |
| **Fix definitivo /transito anuladas (2ª ronda): parser fallback body-text para "Estado global", cron con 2 queries separadas (in_transit+otros), botón "Actualizar tracking" por fila en /transito, silent refetch, doble-guarda client-side, endpoint diagnóstico.** | 2026-05-09 | `efi-parser.ts`, `api/tracking/auto/route.ts`, `transito/page.tsx`, `api/debug/transit-orders/route.ts` (nuevo) |
| **Fix /transito anuladas (1ª ronda): parser detecta "Estado global: Anulada" y mapea a `returned`. Tarjetas Crítico/Riesgo/Normal/Anuladas son clickeables (filtran tabla). Anuladas excluidas del conteo activo. Fetch paralelo in_transit + rawStatus=anulada. Badge "Anulada" en tabla.** | 2026-05-09 | `efi-parser.ts`, `api/orders/route.ts`, `transito/page.tsx` |
| **Fix crítico /transito stuckSince: `transitSinceMs` corregido para NO usar `last_tracking_update` (lo actualiza el cron cada 5 min). Nueva prioridad: status_since → shipment_created_at → shopify_created_at → created_at. Buscador funcional en /transito. Fallback ciudad "Ubicación no registrada". Logs debug server-side.** | 2026-05-09 | `transit-helpers.ts`, `transito/page.tsx` |
| **novelty_agent: acceso a /reparto añadido (sidebar). raw_status visible en tabla desktop + mobile card de /reparto y /transito. Copy operativo de escalamiento con Effi/transportadora en info header y notas de ambas páginas. Alertas +24h y +48h en /transito.** | 2026-05-09 | `sidebar.tsx`, `reparto/page.tsx`, `transito/page.tsx` |
| **Simplificación UX /confirmacion: tab "Nuevos" removido, tarjeta "Nuevos hoy" como KPI visual puro (sin navegación), `getLogisticsBadge` con `in_transit` explícito, 4 tabs operativos: Pedidos/Reintentar/Confirmados/Despachados** | 2026-05-09 | `confirmacion/page.tsx` |
| **Refactor /confirmacion: nueva arquitectura UX estilo Shopify. Vista "Pedidos" server-paginated (todos los pedidos Shopify), 5 vistas (Pedidos/Nuevos/Reintentar/Confirmados sin guía/Despachados), badges de Estado confirmación + Estado logística, delay badge +24h/+48h, filtro fecha 30 días, API nueva /api/confirmacion/pedidos. `source` field añadido a Order type.** | 2026-05-09 | `confirmacion/page.tsx`, `api/confirmacion/pedidos/route.ts` (nuevo), `types/index.ts` |
| **Mejoras /confirmacion: redefinición tabs Nuevos/Atrasados, filtro de fecha Hoy/Ayer/7días/Rango, dropdown mobile para tabs, UX compacto desktop. Mejoras /reparto: guías viejas visibles (limit 500, sortBy=status_since_asc), fallback last_tracking_update, banner críticos. API: sortBy=status_since_asc en orders/route.ts** | 2026-05-09 | `api/confirmacion/stats/route.ts`, `api/orders/route.ts`, `confirmacion/page.tsx`, `reparto/page.tsx` |
| **Fix conteos /confirmacion: base canónica normalized_status='pending', card SD usa count local para coincidir con tab** | 2026-05-09 | `api/confirmacion/route.ts`, `api/confirmacion/stats/route.ts`, `confirmacion/page.tsx` |
| **Santo Domingo / Transporte local: helper isSantoDomingoOrder, badge purple, tab en /confirmacion, filtro en /confirmados, contadores en stats API** | 2026-05-09 | `alert-helpers.ts`, `alert-badges.tsx`, `api/confirmacion/stats/route.ts`, `confirmacion/page.tsx`, `confirmados/page.tsx` |
| **Responsive/mobile-first en /reparto: RepartoCard component, md:hidden cards + hidden md:table desktop** | 2026-05-06 | `reparto/page.tsx` |
| **Responsive/mobile-first en /confirmacion: ConfirmacionCard component, md:hidden cards + hidden md:block desktop table** | 2026-05-06 | `confirmacion/page.tsx` |
| **Fix acceso /orders/[id] para confirmation_agent y novelty_agent: perfiles básicos para no-admins, setAgents resiliente** | 2026-05-06 | `api/profiles/route.ts`, `orders/[id]/page.tsx` |
| **Fix crash /orders/[id] en móvil: try/catch en load(), guard de estructura API, null-safety en arrays** | 2026-05-06 | `orders/[id]/page.tsx` |
| **Layout global responsive: sidebar drawer en móvil, topbar hamburger, contenido full-width** | 2026-05-06 | `layout.tsx`, `sidebar.tsx`, `nav-shell.tsx` (nuevo) |
| **Responsive/mobile-first en /novedad: cards para móvil, tabla se mantiene en desktop** | 2026-05-06 | `novedad/page.tsx` |
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
| **Client-side exception en `/orders/[id]` para confirmation_agent y novelty_agent** | `GET /api/profiles` era admin-only (devolvía `403 { error: 'Solo admins' }`). `load()` hacía `setAgents(agentsRes ?? [])` → agentsRes era truthy (objeto `{error}`), no pasaba el `??` → `setAgents({ error: '...' })` → `agents.filter(...)` en render → **TypeError: agents.filter is not a function**. Fix dual: (1) `GET /api/profiles` retorna lista básica `(id, full_name, role)` para no-admins sin exponer email/auth data; (2) `setAgents(Array.isArray(agentsRes) ? agentsRes : [])` como defensa adicional. | `api/profiles/route.ts`, `orders/[id]/page.tsx` |
| **Client-side exception en `/orders/[id]` desde móvil** | `load()` sin `try/catch` → si la API devuelve `{ error: '...' }` (401/404/500), `setDetail({ error })` hace que `!detail` sea `false` → `const { order } = detail` → `order = undefined` → `order.sla_deadline` → TypeError en render. En móvil se dispara más por sesiones expiradas o red intermitente. Fix: `try/catch/finally` con `setLoading(false)` en finally, estado `loadError`, guard `if (!detailRes?.order)` antes de setDetail, fallback `?? []` en todos los arrays, pantalla de error con botón Reintentar. | `orders/[id]/page.tsx` |
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

### Confirmación — base canónica (regla permanente)

**Todos los tabs y contadores de `/confirmacion` heredan la misma base:**

```sql
source              = 'shopify_webhook'
confirmation_status = 'pending'
normalized_status   = 'pending'     -- excluye cualquier estado no-pending aunque tracking sea NULL
tracking_number     IS NULL         -- si ya tiene guía → /despachados
```

- **`normalized_status = 'pending'` es intencional**: Si un pedido tiene `tracking_number IS NULL` pero su `normalized_status` cambió a `in_transit` / `en_reparto` / etc., es una anomalía de datos. Debe excluirse de la cola de confirmación.
- **Un pedido sale de /confirmacion automáticamente** cuando recibe `tracking_number` (vía webhook de fulfillment, recover o asignación manual). El siguiente refresh lo excluye.
- **Todos los tabs** (Todos, Nuevos, Reintentar, Atrasados, Duplicados, Cobertura, Zona desc., Santo Domingo) filtran sobre el mismo array local `orders` que ya cumple esta base. Ningún tab necesita sus propios filtros de base.
- **Los contadores de las cards de acción** (Nuevos, Reintentar, Atrasados) usan `stats.*` del API (conteo DB completo). La card **Santo Domingo** usa `alertCounts.santoDomingo` (conteo local del array) porque debe coincidir con el tab que filtra ese mismo array.

### Confirmación — flujo original
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
- **Nueva arquitectura por etapas (2026-05-09):** 3 tabs separados. Cada tab tiene sus propias tarjetas y alertas:

| Tab | Qué incluye | Clasificación raw_status |
|---|---|---|
| **Generadas** | Guías creadas en Effi pero sin movimiento real | `raw_status ilike '%generada%'` |
| **En tránsito** | Guías en movimiento real hacia destino | `normalized_status='in_transit'` AND raw_status ≠ Generada/Anulada/Cancelada |
| **Anuladas** | Guías canceladas/anuladas en Effi | `raw_status ilike '%anulada%'` OR `'%cancelada%'` |

- Criticidad por horas (independiente por tab):
  - `>= 48h` → crítico (badge rojo)
  - `24h–48h` → riesgo (badge naranja)
  - `< 24h` → normal
- **Mensajes de escalamiento diferenciados:**
  - Generadas +24h → "Confirmar recogida con Effi / transportadora"
  - Generadas +48h → "Escalar despacho — posible bloqueo o candidata a anulación"
  - En tránsito +24h → "Seguimiento con transportadora sobre ruta / movimiento"
  - En tránsito +48h → "Escalar ruta/bloqueo — posible novedad sin registrar"
- Lógica centralizada en `src/lib/transit-helpers.ts` — reutilizada en `/transito` y `/reparto`
- Refresh cada 5 min
- **Buscador:** Filtra en el tab activo por tracking_number, order_number, customer_name, customer_phone, city, province, raw_status.
- **stuckSince:** `transitSinceMs` usa `status_since ?? shipment_created_at ?? shopify_created_at ?? created_at` — NO usa `last_tracking_update`
- **Botón "Anular" manual (admin/novelty_agent):** Marca la guía como Anulada → `POST /api/orders/[id]/mark-anulada`. Crea nota interna + agent_action='cancelled'. La guía pasa al tab Anuladas en el próximo refetch.
- **Botón "Actualizar":** Consulta EFI y actualiza estado → `POST /api/orders/[id]/tracking`. Silent refetch + toast.
- **Query API in_transit:** Excluye `raw_status ilike '%anulada%'` y `'%cancelada%'` a nivel de DB.

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

### Layout global — Responsive mobile (2026-05-06)

**Problema resuelto:** En móvil, `main` tenía `ml-56` fijo y la sidebar era `fixed` siempre visible → el contenido principal quedaba comprimido a ~166px en pantallas de 390px.

**Arquitectura del nuevo layout:**

```
AppLayout (Server Component — layout.tsx)
  ├── NavShell (Client Component — nav-shell.tsx)  [gestiona estado open/close]
  │     ├── <header> topbar móvil (hamburger ☰ + brand) — solo visible < md
  │     ├── overlay oscuro (backdrop) — solo cuando sidebar está abierta en móvil
  │     └── <Sidebar> (con isOpen + onClose props)
  └── <main> md:ml-56 — sin margin en móvil, margen en desktop
        └── div pt-14 md:pt-0 — espacio para topbar fija en móvil
```

**`src/components/layout/nav-shell.tsx` (NUEVO — Client Component):**
- `useState(false)` → controla si el drawer está abierto
- Renderiza el topbar móvil (`md:hidden`): botón ☰ + brand "Control COD"
- Renderiza overlay (`z-40`) cuando `open=true` — `onClick` cierra el drawer
- Renderiza `<Sidebar isOpen={open} onClose={() => setOpen(false)} />`

**`src/components/layout/sidebar.tsx` (MODIFICADO):**
- Props nuevas: `isOpen?: boolean`, `onClose?: () => void`
- Clase dinámica: `isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'`
  - Móvil cerrado: `-translate-x-full` (sidebar fuera de pantalla, a la izquierda)
  - Móvil abierto: `translate-x-0` (sidebar visible como drawer)
  - Desktop siempre: `md:translate-x-0` (sidebar fija, sin importar isOpen)
- `transition-transform duration-300 ease-in-out` → animación suave
- Botón ✕ en el header del sidebar — `md:hidden` (solo en móvil)
- `useEffect([pathname])` con ref `didMount` → auto-cierra el drawer al navegar
- Tap targets de nav links: `py-2.5` (antes `py-2`) para mejor usabilidad táctil
- `useRouter` eliminado (no se usaba)

**`src/app/(app)/layout.tsx` (MODIFICADO):**
- `import { NavShell }` en lugar de `{ Sidebar }`
- `main className="md:ml-56 min-h-screen"` — sin `flex-1` ni `ml-56` base
- `div className="pt-14 md:pt-0 px-4 py-4 md:p-6 max-w-screen-xl mx-auto"`
  - `pt-14`: espacio bajo el topbar fijo en móvil (el topbar mide h-14)
  - `md:pt-0`: en desktop no hay topbar, padding normal
  - `px-4 py-4 md:p-6`: padding menor en móvil, el habitual en desktop
- No se pasa `role` a `Sidebar` directamente — va a través de `NavShell`

**Z-index layers:**
- `z-30` — topbar móvil
- `z-40` — overlay (cubre contenido + topbar cuando sidebar está abierta)
- `z-50` — sidebar/drawer (siempre encima del overlay)

**Roles, auth y nav:** Sin cambios. `NAV_BY_ROLE` intacto. `isAgentOrAbove()` intacto. El Server Component sigue pasando el `role` al `NavShell`.

**Cómo probarlo:**
1. `npm run dev`
2. Chrome DevTools → Toggle Device Toolbar → iPhone 14 Pro (390px)
3. Verificar: header gris con ☰ y "Control COD" en top; contenido en full-width
4. Tocar ☰ → sidebar desliza de izquierda con animación suave + overlay oscuro
5. Tocar fuera (overlay) → sidebar se cierra
6. Tocar ✕ en el sidebar → sidebar se cierra
7. Navegar a otro módulo desde el sidebar → sidebar se cierra automáticamente
8. Quitar Device Toolbar → sidebar fija desktop, sin topbar, layout idéntico al anterior

**Archivos modificados (2026-05-06):** `src/app/(app)/layout.tsx`, `src/components/layout/sidebar.tsx`, `src/components/layout/nav-shell.tsx` (nuevo)

### /transito — Nueva arquitectura por etapas (2026-05-09) ← ÚLTIMO CAMBIO

**Problema resuelto:** `/transito` mezclaba guías "Generada" con guías realmente "En tránsito", reportando 36 críticos cuando solo ~22 son reales. Las guías anuladas tampoco se separaban correctamente porque el parser EFI no detectaba "Estado global: Anulada" en todos los casos.

**Nueva arquitectura — 3 etapas:**

La página separa el array `in_transit` en tres grupos según `raw_status`:

```
fetchData():
  Query 1: ?status=in_transit&limit=200   → activeRaw
  Query 2: ?rawStatus=anulada&limit=200   → anuladas (ya reclasificadas por cron)
  Query 3: ?rawStatus=cancelada&limit=200 → canceladas ("Cancelada por transportadora")

  Separación client-side de activeRaw:
    isAnuladaRaw(o): raw_status contiene 'anulad' o 'cancelad' → cancelledOrders (doble-guarda)
    isGenerada(o):   raw_status contiene 'generada'            → generatedOrders
    resto:           normalized_status='in_transit' sin lo anterior → transitOrders

  cancelledOrders = merge deduplicado de anuladas + canceladas + extraCancelled
```

**Tab "Generadas":**
- `raw_status` contiene "generada" (case-insensitive)
- Guías creadas en Effi que no han sido recogidas aún
- Criticidad: Normal < 24h · Riesgo 1-2 días · Crítico +48h
- Escalar: "Confirmar recogida / despacho con Effi"

**Tab "En tránsito":**
- `normalized_status='in_transit'` AND raw_status NO contiene 'generada', 'anulada', 'cancelada'
- Guías realmente moviéndose (~22 reales en Effi)
- Criticidad: Normal < 24h · Riesgo 1-2 días · Crítico +48h
- Escalar: "Seguimiento con transportadora sobre ruta/bloqueo"

**Tab "Anuladas":**
- Guías de los 3 fetches con raw_status anulada/cancelada
- Sin tarjetas de criticidad (no escalar)
- Botón "Anular" en tabs activos para moverlas aquí manualmente

**Query API mejorada (api/orders/route.ts):**
```typescript
// Cuando status='in_transit':
query.eq('normalized_status', 'in_transit')
     .not('raw_status', 'ilike', '%anulada%')
     .not('raw_status', 'ilike', '%cancelada%')
```
Esto garantiza que guías ya detectadas como anuladas no aparecen en el primer fetch aunque `normalized_status` aún sea 'in_transit'.

**Endpoint mark-anulada (api/orders/[id]/mark-anulada/route.ts — NUEVO):**
- `POST /api/orders/[id]/mark-anulada`
- Roles: admin, novelty_agent (403 para otros)
- Actualiza: `raw_status='Anulada'`, `normalized_status='returned'`, `last_tracking_update=now()`
- Crea: nota interna en tabla `notes` + `agent_action` tipo 'cancelled'
- Log en Vercel: `[mark-anulada] order=X tracking=Y prev="Generada"/in_transit → Anulada/returned by=admin`

**Validación esperada post-deploy:**
- Tab "Generadas": las ~14 guías viejas con raw_status='Generada' (incluyendo las que hay que anular manualmente)
- Tab "En tránsito": las ~22 guías reales moviéndose
- Tab "Anuladas": 0 al inicio; se pobla al usar botón "Anular" o cuando cron detecta "Estado global: Anulada"
- Total del banner: ~36 (Generadas + En tránsito); anuladas separadas
- NO aparecen 36 como "En tránsito activo" — se distingue claramente

**Flujo para limpiar guías viejas anuladas:**
1. Ir a tab "Generadas" → buscar guías con 11+ días
2. Click "Actualizar" → si EFI dice "Estado global: Anulada" → se mueve a Anuladas automáticamente
3. Si EFI no la detecta → click "Anular" → se mueve a Anuladas + nota interna creada
4. Repetir para las ~14 guías candidatas

**Cómo probar:**
1. `npm run dev` → login → `/transito`
2. Verificar banner: "X pedidos en ruta · A generadas · B en tránsito · C anuladas"
3. Click tab "Generadas": guías con raw_status='Generada', tarjetas Crítico/Riesgo/Normal propias
4. Click tab "En tránsito": guías sin 'Generada' en raw_status, ~22 reales
5. Click tab "Anuladas": vacío inicialmente; usar botón "Anular" en tab Generadas para mover una guía
6. Verificar que la guía anulada: desaparece de Generadas → aparece en Anuladas
7. Buscar una guía en cualquier tab → el buscador filtra dentro del tab activo
8. Tarjetas Crítico/Riesgo/Normal: clickeables, filtran solo dentro del tab activo
9. Botón "Actualizar" en una guía activa → EFI consulta → toast con resultado
10. Botón "Anular" desde novelty_agent → 200 OK, guía desaparece; desde delivery_agent → toast "Sin permisos"

**Archivos modificados:**

| Archivo | Cambio |
|---|---|
| `src/app/(app)/transito/page.tsx` | **Rewrite completo.** 3 tabs (Generadas/En tránsito/Anuladas). 3 arrays separados. Alertas diferenciadas por etapa. Botón "Anular". Banner con totales por etapa. |
| `src/app/api/orders/[id]/mark-anulada/route.ts` | **NUEVO.** POST que actualiza raw_status+normalized_status + nota + agent_action. Solo admin/novelty_agent. |
| `src/app/api/orders/route.ts` | Query in_transit excluye raw_status anulada/cancelada a nivel DB. |

---

### /transito — Fix definitivo anuladas (2026-05-09)

**Síntoma en producción:** Total activo 36 · Críticos +48h 36 · Anuladas 0. En Effi, ~14 de esas 36 tienen "Estado global: Anulada" y solo ~22 son activas reales.

**Causa raíz (triple):**

1. **Parser no detecta "Estado global" en todas las estructuras HTML de EFI.**
   `findLabelInHTML` falla cuando la etiqueta y el valor están en text-nodes sueltos o anidados de forma imprevista. Si el parser no encontraba "Estado global: Anulada", guardaba `raw_status='Generada'` + `normalized_status='in_transit'` → la guía seguía como crítica activa indefinidamente.

2. **El cron perdía guías in_transit cuando hay >200 pedidos no finalizados en total.**
   La query original era `.not(normalized_status IN final) ORDER BY last_tracking_update ASC LIMIT 200`. Si en DB había 200+ pedidos en otros estados (en_reparto, novedad, pending), los in_transit quedaban fuera del lote de 200 y no se procesaban en ese ciclo.

3. **El fetch secundario en /transito solo capturaba guías ya con `raw_status='Anulada'`.**
   Guías que aún tenían `raw_status='Generada'` pero `normalized_status='in_transit'` (estado inconsistente transitorio) no aparecían en ningún fetch como anuladas.

**Fixes aplicados:**

**Fix A — `efi-parser.ts` (paso 7b):** Fallback de texto plano del body.
Después de `findLabelInHTML`, si `estado_global` sigue null, se ejecuta un regex directo sobre `lowerBody`:
```typescript
const egMatch = /estado\s+(?:global|de\s+la\s+gu[íi]a)\s*:?\s*/i.exec(lowerBody)
if (egMatch) {
  const after  = bodyText.slice(egMatch.index + egMatch[0].length).trimStart()
  const rawVal = after.split(/\s+/).slice(0, 2).join(' ').trim().slice(0, 40)
  // si rawVal contiene 'anulad' → override estado_actual + normalized_status='returned'
}
```
Esto captura el valor aunque EFI cambie su estructura HTML.

**Fix B — `api/tracking/auto/route.ts`:** Dos queries separadas en el cron.
```
Query 1: normalized_status='in_transit' → LIMIT 80 (siempre se procesan todos)
Query 2: otros estados no finales       → LIMIT 80
Total máximo: 160 guías por ciclo
```
Con 36 in_transit, todas se procesan en cada ciclo independientemente de cuántos pedidos haya en otros estados.

**Fix C — `transito/page.tsx`:** Botón "Actualizar tracking" + doble-guarda client-side.
- Botón "Actualizar" por fila (solo activas, no anuladas) → llama `POST /api/orders/[id]/tracking`
- Silent refetch tras éxito (no parpadeo de tabla)
- Toast flotante: éxito verde / error rojo (auto-dismiss 4.5s)
- Doble-guarda client-side: si `activeRes.data` contiene guías con `raw_status~anulada`, las mueve al array anuladas aunque `normalized_status` sea todavía `in_transit`
- Fetch secundario ampliado a `limit=200`

**Endpoint diagnóstico:** `GET /api/debug/transit-orders`
- Sin params: devuelve todos los in_transit + returned-anuladas recientes
- `?tracking_numbers=9000539795,9000540492`: inspecciona guías específicas
- Devuelve: `tracking_number`, `raw_status`, `normalized_status`, `status_since`, `last_tracking_update`, `horas_en_transito`, `tracking_events`, `diagnostico`

**Cómo funciona el flujo completo después del fix:**

```
EFI HTML (scraping por cron o botón manual)
  ↓
parseEFITracking()
  ↓ paso 7: findLabelInHTML('Estado global')
  ↓ paso 7b: fallback regex en lowerBody [NUEVO]
  ↓ si 'anulad' en estadoGlobal:
      estado_actual = 'Anulada'
      normalized_status = 'returned'
  ↓
update-order.ts → DB:
  raw_status = 'Anulada'
  normalized_status = 'returned'
  last_tracking_update = now()
  ↓
/transito fetchData():
  fetch1: status=in_transit → guía YA NO aparece (es returned)
  fetch2: rawStatus=anulada → guía SÍ aparece (raw_status='Anulada')
  ↓
UI: guía sale de Crítico → entra en tarjeta Anuladas
```

**Cómo revalidar una guía manualmente:**

1. Ir a `/transito`
2. Buscar la guía por número (ej. `9000539795`)
3. Hacer clic en "Actualizar" en la fila correspondiente
4. Observar spinner en el botón y esperar (1–5s según EFI)
5. Si EFI detecta "Estado global: Anulada" → toast verde "Guía reclasificada"
6. La tabla se refresca silenciosamente: la guía desaparece de activos y suma 1 en Anuladas

**Cómo trata el cron guías viejas in_transit:**
- El cron prioriza hasta 80 guías `in_transit` en cada ciclo (query separada)
- Las guías más antiguas (`last_tracking_update ASC NULLS FIRST`) van primero
- Con 36 guías en_transit (< 80), todas se procesan en cada ciclo de 5 min
- Al detectar `normalized_status='returned'` → FINAL_STATUSES incluye 'returned' → el cron deja de re-sincronizar esa guía (correcto)
- El parser loguea en Vercel: `[efi-parser] guia=X estado_global="Anulada" normalized="returned"` para verificar

**Cómo probar con 9000539795:**
1. `npm run dev` en `control-cod-app/`
2. Login → ir a `/transito`
3. Buscar `9000539795` → aparece como "Crítico +48h" (estado actual en DB)
4. Click "Actualizar" en la fila → esperar respuesta EFI
5. Si EFI muestra "Estado global: Anulada": toast verde, la guía desaparece de activos
6. Click en tarjeta "Anuladas" → 9000539795 aparece con badge "Anulada"
7. Total activo debe bajar; Crítico -1 o más

**Cómo probar con 9000546686 (guía activa real):**
1. Buscar `9000546686` → debe seguir apareciendo como Crítico +48h
2. Click "Actualizar" → EFI debe devolver estado activo (no anulada)
3. La guía permanece en activos con su criticidad correcta

**Diagnóstico DB con endpoint:**
```
GET /api/debug/transit-orders?tracking_numbers=9000539795,9000540492,9000541283,9000543695,9000543696
```
Interpretar campo `diagnostico`:
- `OK — ya reclasificada como Anulada` → el fix ya actuó
- `PENDIENTE — cron no detectó Estado global aún` → usar botón "Actualizar" manualmente
- `NUNCA SINCRONIZADA — sin last_tracking_update` → el cron nunca alcanzó esta guía
- `INCONSISTENTE — raw_status anulada pero normalized=in_transit` → estado a punto de corregirse

**Archivos modificados:**

| Archivo | Cambio |
|---|---|
| `src/lib/tracking/efi-parser.ts` | Paso 7b: fallback regex sobre texto plano del body. Log diagnóstico en Vercel cuando se detecta estado_global. |
| `src/app/api/tracking/auto/route.ts` | Dos queries separadas: 80 in_transit + 80 otros estados. Garantiza que todos los in_transit se procesan aunque haya >200 no finalizados en total. |
| `src/app/(app)/transito/page.tsx` | Botón "Actualizar" por fila + `handleRefreshTracking`. Toast flotante. Silent refetch (`fetchData(true)`). Doble-guarda client-side (in_transit con raw_status~anulada → array anuladas). Fetch secundario ampliado a 200. |
| `src/app/api/debug/transit-orders/route.ts` | NUEVO — endpoint de diagnóstico con campos completos y campo `diagnostico` para cada guía. |

---

### /transito — Anuladas + Tarjetas clickeables (2026-05-09)

**Problema:** Después de corregir `stuckSince`, aparecían 36 "Críticos +48h". Pero muchas guías en EFI tenían "Estado global: Anulada" aunque su movimiento interno dijera "Generada". Esas guías fueron duplicadas o mal subidas y ya están canceladas en EFI. Mezcladas con las activas, confundían al agente de novedades.

**Causa del "Estado global: Anulada" vs "Estado actual: Generada":**

EFI tiene dos conceptos distintos en su HTML:
- **Estado actual** (`findLabelInHTML($, 'Estado actual')`) → estado de movimiento del paquete (p. ej. "Generada", "En tránsito")
- **Estado global** (`findLabelInHTML($, 'Estado global')`) → estado general de la guía (p. ej. "Anulada", "Activa")

El parser solo extraía "Estado actual". El "Estado global: Anulada" era ignorado → la guía quedaba como `in_transit`, aparecía como Crítico +48h en /transito.

**Fix 1 — `efi-parser.ts`:**
1. Nuevo campo `estado_global: string | null` en `TrackingResult`
2. `mapNormalizedStatus`: añadido `s.includes('anulad')` → `'returned'` (junto a "cancelada")
3. Al final de `parseEFITracking`, busca "Estado global" / "Estado Global":
   - Si contiene "anulad" o "inactiv" → override: `estado_actual = estadoGlobal`, `normalized_status = 'returned'`
   - `raw_status` se guardará como "Anulada" en el próximo ciclo del cron
   - El cron detecta 'returned' como FINAL_STATUS → deja de re-sincronizar esa guía

**Fix 2 — `api/orders/route.ts`:**
- Nuevo param `?rawStatus=valor` → filtra `raw_status ilike %valor%`
- Usado por /transito para fetch secundario: `/api/orders?rawStatus=anulada&limit=100`

**Fix 3 — `transito/page.tsx`:**

_Fetch paralelo:_
- `orders` (activos): `/api/orders?status=in_transit&limit=200`
- `anuladas`: `/api/orders?rawStatus=anulada&limit=100`
- Las anuladas se detectan por `raw_status ilike '%anulada%'` independientemente de normalized_status
  (captura anuladas ya procesadas por el cron con `normalized_status='returned'` Y las pendientes de re-sync que aún tienen `in_transit` + raw_status anterior)

_Tarjetas clickeables (FilterCategory):_
- `'all'` (default) · `'critico'` · `'riesgo'` · `'normal'` · `'anulada'`
- Clic en una tarjeta activa el filtro y filtra la tabla. Segundo clic desactiva → vuelve a 'all'.
- Visual: tarjeta activa tiene `ring-2 ring-offset-1 shadow-md` en su color. Subtexto "← Filtro activo".
- Chip de filtro activo encima del buscador con botón X.
- Las 4 tarjetas muestran counts del conjunto COMPLETO (no filtrado por búsqueda).

_Conteos:_
- **Crítico/Riesgo/Normal**: calculados solo sobre `orders` (in_transit activos, excluyendo anuladas)
- **Anuladas**: `anuladas.length`
- Banner principal muestra `orders.length` como "tránsito activo" + chip secundario "N anuladas"

_Tabla anuladas:_
- Filas con `opacity-75` y fondo gris suave
- Badge gris "Anulada" (ícono Ban) en columna Estado EFI
- Tiempo "sin movimiento" tachado (irrelevante para anuladas)
- Texto "No escalar" debajo del badge

**Normalización de estados — actualización:**

| Estado EFI | normalized_status | Notas |
|---|---|---|
| `Estado global: Anulada` | `returned` | Override; raw_status guardado como "Anulada" |
| `anulada` en estado_actual | `returned` | Vía `mapNormalizedStatus` (s.includes('anulad')) |
| `cancelada` | `returned` | Sin cambios (ya existía) |

**Cómo probar:**
1. `npm run dev` → `/transito`
2. Verificar 4 tarjetas: Crítico / Riesgo / Normal / Anuladas — todas con conteos correctos
3. Click en "Anuladas" → tabla muestra solo anuladas con badge gris "Anulada"
4. Buscar "9000539795" con filtro "Anuladas" activo → aparece la guía con badge "Anulada"
5. Verificar que 9000539795 NO cuenta en Crítico/Riesgo/Normal
6. Click en "Crítico" → tabla muestra solo +48h activos, sin anuladas
7. Segundo click en "Crítico" → filtro desactiva, vuelve a "Todos"
8. Buscar guía activa real → aparece con su categoría correcta
9. Verificar que el total del banner refleja solo activos (excluye anuladas)
10. Guía 9000546686 (si no está anulada): debe aparecer como Crítico +48h en filtro "Crítico"

**Nota importante sobre propagación:**
Las anuladas existentes en DB que aún tienen `normalized_status='in_transit'` + `raw_status='Generada'` (antes del cron re-sync) NO aparecerán en el fetch secundario de anuladas (porque `raw_status` no contiene "anulada" todavía). Después del próximo ciclo del cron, el parser detecta "Estado global: Anulada" → actualiza `raw_status='Anulada'` + `normalized_status='returned'` → desaparecen del fetch `in_transit` y aparecen en el fetch `rawStatus=anulada`. En producción, la propagación ocurre en el próximo ciclo de 5 min.

**Archivos modificados:**

| Archivo | Cambio |
|---|---|
| `src/lib/tracking/efi-parser.ts` | Nuevo campo `estado_global`. "anulad" → 'returned' en `mapNormalizedStatus`. Extracción "Estado global" + override al final del parser. |
| `src/app/api/orders/route.ts` | Nuevo param `?rawStatus=valor` → ilike filter. |
| `src/app/(app)/transito/page.tsx` | Fetch paralelo (in_transit + anuladas). Tarjetas clickeables. Banner separado anuladas. Buscador por categoría. |

---

### Fix crítico /transito stuckSince — "Hace menos de 1h" incorrecto (2026-05-09)

**Problema confirmado:**
- Guía 9000546686, cliente Manuel Manuel, generada el 30/04 02:51 p.m.
- `raw_status = 'Generada'` → `normalized_status = 'in_transit'`
- La app mostraba **"Hace menos de 1h"** — debía ser **Crítico +48h**

**Causa raíz:**

`transitSinceMs` en `transit-helpers.ts` usaba `last_tracking_update` como **primera** prioridad:

```typescript
// ANTES (incorrecto):
order.last_tracking_update ?? order.status_since ?? order.updated_at
```

El cron `update-order.ts` escribe `last_tracking_update = new Date().toISOString()` en **cada** ejecución (cada 5 minutos), independientemente de si el estado cambió. Eso hace que cualquier guía estancada parezca "recién actualizada" en el cálculo de tiempo.

**Fix aplicado:**

```typescript
// AHORA (correcto) en transit-helpers.ts:
order.status_since        ??  // fecha real del estado EFI (historial_estados.at(0).fecha)
order.shipment_created_at ??  // fecha de creación del envío en EFI
order.shopify_created_at  ??  // fecha de creación del pedido en Shopify
order.created_at              // fallback DB
```

`last_tracking_update` se mantiene en el UPDATE del cron (necesario para ordenar qué pedidos sincronizar primero), pero ya **no se usa** para calcular tiempo estancado.

**Por qué `status_since` es la fuente correcta:**

En `update-order.ts`, el cron setea:
```typescript
const firstEstado = tracking.historial_estados.at(0)  // más reciente (desc)
const statusSince = parseEFIDate(firstEstado?.fecha)
if (statusSince) updates.status_since = statusSince
```
`historial_estados` viene de EFI en orden descendente → `at(0)` = fecha real en que EFI registró el estado actual. Para "Generada" del 30/04, `status_since` = 30/04 02:51 PM → ~216h → Crítico +48h ✓

**Fallback para pedidos sin `status_since`:**
- `shipment_created_at` = `fecha_creacion` de EFI (también set por el cron, refleja creación del envío)
- `shopify_created_at` = fecha Shopify del pedido
- `created_at` = fecha de inserción en DB

Cualquiera de estos es estable y no se actualiza en cada sync.

**Archivos modificados:**

| Archivo | Cambio |
|---|---|
| `src/lib/transit-helpers.ts` | `transitSinceMs` — nueva prioridad sin `last_tracking_update`. Comentario explicativo añadido. |
| `src/app/(app)/transito/page.tsx` | `stuckSinceTs` en tabla usa la misma fuente que `transitSinceMs`. Buscador funcional. Fallback ciudad. Logs debug. |

**Buscador /transito:**
- Input con ícono Search + botón X para limpiar
- Filtra client-side el array de 200 órdenes por: `tracking_number`, `order_number`, `customer_name`, `customer_phone`, `city`, `province`, `raw_status`
- Muestra contador de resultados cuando hay búsqueda activa
- Paginación se resetea al cambiar búsqueda
- Las tarjetas de clasificación (Crítico/Riesgo/Normal) también filtran sobre `filteredOrders`

**Fallback ciudad:**
- `cityDisplay(order)`: city → province → último segmento de `customer_address` (separado por coma) → "Ubicación no registrada" (en itálica gris)

**Logs debug (temporales):**
- En `fetchData` del componente, tras cargar los datos, se imprime por consola del navegador:
  `[transito-debug] { tracking_number, raw_status, normalized_status, status_since, shipment_created_at, last_tracking_update, shopify_created_at, created_at, stuckSince_used, horas_calculadas, categoria }`
- Activo en todos los entornos (incluye producción temporalmente para validar)
- Eliminar el bloque de debug cuando se confirme que 9000546686 muestra Crítico +48h

**Cómo probar con guía 9000546686:**
1. `npm run dev` en `control-cod-app/`
2. Login como admin o novelty_agent → ir a `/transito`
3. Buscar "9000546686" en el buscador → debe aparecer la guía
4. Verificar que muestra: badge "Crítico +48h" (rojo) y tiempo > 48h
5. Verificar que NO dice "Hace menos de 1h"
6. Verificar en consola del navegador: `[transito-debug]` con `horas_calculadas > 200` y `categoria: 'critico'`
7. La fecha base (`stuckSince_used`) debe ser ~30/04, NO una fecha de hoy
8. Confirmar que guías recién generadas (hoy) aparecen como "Normal (0–1 día)"
9. Confirmar que guías de ayer/antier aparecen en "Riesgo" o "Crítico" según corresponda

### novelty_agent — Acceso a /reparto + visibilidad operativa (2026-05-09)

**Qué se hizo:** Ampliación del perfil `novelty_agent` como supervisor operativo de logística. Ahora puede acceder a `/reparto` (además de `/novedad` y `/transito` que ya tenía). Se añadió `raw_status` visible en ambas páginas y copy operativo explícito de escalamiento con Effi / transportadora.

**Archivos modificados:**

| Archivo | Cambio |
|---|---|
| `src/components/layout/sidebar.tsx` | `/reparto` añadido a `novelty_agent` entre Novedades y Tránsito (icono `Bike`, alert `amber`) |
| `src/app/(app)/reparto/page.tsx` | Info header actualizado con copy +24h/+48h y Effi. `raw_status` visible en tabla desktop (sub-línea bajo badge criticidad). `raw_status` visible en mobile card (`RepartoCard`, "EFI: ..."). |
| `src/app/(app)/transito/page.tsx` | Columna "Estado EFI" con `raw_status`. Banners separados para +24h (riesgo) y +48h (crítico) con instrucción de escalar con Effi. Nota pie con guía operativa (+24h/+48h/+72h). |

**Lógica de permisos:**

- El middleware (`middleware.ts`) **no se modificó** — solo bloquea `/dashboard` y `/performance` para no-admins. `/reparto` y `/transito` son accesibles para cualquier usuario autenticado.
- No hay guards en las páginas de `/reparto` ni `/transito` (nunca los hubo). El control de acceso es exclusivamente via sidebar y middleware.
- `novelty_agent` puede ver `/reparto` pero **no** tiene acceso a las rutas admin-only (`/dashboard`, `/performance`, `/confirmados`, `/confirmacion`, `/settings`).

**Lógica de alertas +24h/+48h:**

En `/reparto`:
- El cálculo de criticidad usa `repartoSinceMs(order)` → `status_since ?? last_tracking_update ?? updated_at`
- Normal: < 24h · Riesgo: 24–48h · Crítico: +48h
- Info header: "Guías en reparto con más de 24h → escalar con Effi / transportadora. +48h Crítico → escalar con prioridad alta."

En `/transito`:
- El cálculo usa `transitSinceMs(order)` de `transit-helpers.ts` → `last_tracking_update ?? created_at`
- Normal: < 24h · Riesgo: 24–48h · Crítico: +48h
- Banner +24h (amarillo) aparece si `riesgo.length > 0` con mensaje de seguimiento con Effi
- Banner +48h (rojo) aparece si `criticos.length > 0` con mensaje de escalamiento urgente
- "Generada" normaliza a `in_transit` → aparece en /transito; `raw_status` muestra "Generada" como texto

**Visibilidad de `raw_status`:**
- En `/reparto` (desktop): sub-línea gris bajo el badge de criticidad (`max-w-[120px]` truncado con `title` para hover)
- En `/reparto` (mobile, `RepartoCard`): línea "EFI: [estado]" entre ubicación/tiempo y botones de acción
- En `/transito` (desktop): sub-línea gris bajo el badge de criticidad + label contextual ("↑ Escalar con Effi" en críticos, "Seguimiento Effi" en riesgo)

**Cómo probar:**

1. `npm run dev` en `control-cod-app/`
2. Login como `novelty_agent`
3. Verificar sidebar: Novedades · En Reparto · Tránsito (Mi rendimiento en primero)
4. Ir a `/reparto` → debe cargar sin error
5. Verificar info header: texto sobre +24h/+48h y Effi visible
6. En tabla desktop: columna Estado muestra badge + `raw_status` EFI debajo
7. En móvil (DevTools → iPhone 14): card muestra "EFI: [estado]"
8. Ir a `/transito` → verificar banners separados para riesgo (+24h) y crítico (+48h)
9. Tabla transito: columna "Estado EFI" con badge + raw_status + label de escalamiento
10. Verificar que `admin` sigue viendo todo sin cambios
11. Verificar que `confirmation_agent` NO ve `/reparto` en su sidebar
12. Verificar que `delivery_agent` sigue viendo `/reparto` y `/transito` sin cambios

---

### /confirmacion — UX simplificada: 4 tabs + KPI "Nuevos hoy" (2026-05-09)

**Qué se hizo:** Simplificación UX post-refactor. Se eliminó el tab "Nuevos" (redundante con la vista "Pedidos" ya existente). La tarjeta "Nuevos" se convirtió en un KPI visual puro "Nuevos hoy" sin navegación. Se mejoró `getLogisticsBadge` para mostrar `in_transit` explícitamente.

**Archivo modificado:** `confirmacion/page.tsx`

#### Cambios específicos

1. **Tab "Nuevos" removido** — `ViewMode` pasa de 5 vistas a 4: `'pedidos' | 'reintentar' | 'confirmados_sin_guia' | 'despachados'`
2. **Tarjeta "Nuevos hoy"** — La 1ra card del grid es ahora un `<div>` (sin onClick), muestra `stats.nuevos` (pedidos de hoy, pending, sin guía, 0 intentos). Texto: "Nuevos hoy / Pending · sin guía · 0 intentos"
3. **`getLogisticsBadge`** — Añadido `normalized_status='in_transit'` explícito antes del catch-all. El fallback final cubre estados desconocidos.
4. **Limpieza completa** de referencias a `'nuevos'` en: `refreshAll`, `isLoading`, `currentData`, `displayedOrders`, `filteredOrders`, efectos de viewMode, empty state, render sections, paginación
5. **`VIEW_META`** — Ahora tiene 4 entradas (removida la de 'nuevos'); select móvil y tabs desktop muestran: Pedidos / Reintentar / Confirmados / Despachados

#### Nueva arquitectura: 4 vistas (ViewMode)

| Vista | Datos | Fuente API | Paginación | Acciones |
|---|---|---|---|---|
| **Pedidos** (default) | TODOS los `source='shopify_webhook'` ordenados por fecha DESC | `GET /api/confirmacion/pedidos` (NUEVO) | Server-side, 50/pág | Solo para `pending + tracking IS NULL` |
| **Reintentar** | `confirmation_attempts 1–2` + `pending` + `tracking IS NULL` | `/api/confirmacion` (existente) | Client-side 50/pág | ✅ Todas |
| **Confirmados sin guía** | `confirmation_status='confirmed' + tracking IS NULL` | `/api/confirmados` (existente) | Sin paginación (≤200) | Read-only — visible para confirmation_agent |
| **Despachados** | `tracking IS NOT NULL` activos | `/api/despachados` (existente) | Sin paginación (≤200) | Read-only |

#### Nuevos badges de columna

**Estado confirmación** (`getConfirmBadge(order, terminalOverride?)`):
- `confirmed` → "Confirmado" verde
- `pending` + `attempts=0` → "Pendiente" gris
- `pending` + `attempts≥1` → "Reintentar" ámbar
- `cancelled` → "Cancelado" gris
- `no_coverage` → "Sin cobertura" naranja
- `unreachable` / `wrong_number` → "Inalcanzable" rojo

**Estado logística** (`getLogisticsBadge(order)`):
- `tracking IS NULL` → "Sin guía" gris
- `delivered` → "Entregada" verde
- `returned` → "Devuelta" gris oscuro
- `novedad` → "Novedad" rojo
- `en_reparto` → "En reparto" naranja
- `in_transit` → "En tránsito" azul (explícito, no fallback)
- `raw_status ilike 'generada'` o `pending + tracking` → "Generada" azul claro
- Resto → "En tránsito" azul (fallback)

**Delay badge** (`getDelayBadge(order)`):
- `≥48h` → "+48h" rojo pulsante (`animate-pulse`)
- `≥24h` → "+24h" ámbar
- Aplica en todas las vistas con pedidos pendientes

#### Filtros de fecha (nueva opción)
- Hoy · Ayer · 7 días · **30 días** (nuevo) · Rango personalizado
- En vista "Pedidos": filtrado **server-side** vía params `?from=ISO&to=ISO` en la API
- En vista "Reintentar": filtrado **client-side** sobre el array de la cola

#### API nueva: `GET /api/confirmacion/pedidos`

- **Archivo:** `src/app/api/confirmacion/pedidos/route.ts`
- **Query:** `orders WHERE source='shopify_webhook' ORDER BY shopify_created_at DESC, created_at DESC`
- **Params:** `?page=N&limit=50&search=X&from=ISO&to=ISO`
- **Respuesta:** `{ data: Order[], total, page, pages }`
- **Search:** ilike en `customer_name`, `customer_phone`, `order_number`, `tracking_number`
- **Paginación:** server-side real (RANGE Supabase), estable con miles de órdenes

#### Estrategia de fetch

- **Mount:** pre-carga stats + perf + pedidos (pág 1) + cola (queue). Los tabs "Confirmados sin guía" y "Despachados" se cargan **lazy** al primer click.
- **Auto-refresh 3 min:** re-fetcha stats + datos del view activo
- **Cambio de vista:** re-fetcha datos si ya cargados; lazy-load si es primera vez
- **Cambio de búsqueda/fecha en "Pedidos":** re-fetcha inmediatamente, resetea a pág 1
- **Cambio de página en "Pedidos":** re-fetcha la página seleccionada

#### Type update

- `src/types/index.ts`: añadido `source?: string | null` al interface `Order`

#### Lo que NO cambió

- `/api/confirmacion/route.ts` — fuente de cola operativa, intacta
- `/api/confirmacion/stats/route.ts` — todos los contadores, intactos
- `/api/confirmacion/performance/route.ts` — perf del agente, intacto
- `/api/orders/[id]/confirmation/route.ts` — acciones, intactas
- `/api/tracking/auto/route.ts` — cron EFI, intacto
- `/api/admin/recover-shopify-orders/route.ts` — recovery, intacto
- `lib/alert-helpers.ts` + `alert-badges.tsx` — SD badge púrpura, intactos
- `/confirmados/page.tsx` + `/despachados/page.tsx` — rutas independientes, intactas
- `reparto/page.tsx`, `novedad/page.tsx`, `transito/page.tsx` — sin cambios

#### Comportamiento de roles

- `confirmation_agent`: ve las 4 vistas. "Confirmados sin guía" y "Despachados" en modo read-only (sin acciones de despacho).
- `admin`: igual, con acceso completo a todas las rutas.
- Las acciones (Confirmó/No contesta/Sin cobertura/Canceló) solo aparecen cuando `confirmation_status='pending' AND tracking_number IS NULL`.

#### Cómo probarlo

1. `npm run dev` en `control-cod-app/`
2. Login como admin → ir a `/confirmacion`
3. Default: vista "Pedidos" — tabla Shopify con TODOS los pedidos, ordenados más recientes arriba
4. Verificar columnas: Fecha/Orden, Cliente, Ciudad/Producto, Monto, Estado confirm., Estado log., Acción, Ver
5. Verificar tarjeta "Nuevos hoy" (indigo, sin click navigation) — muestra count de pedidos hoy con 0 intentos
6. Usar buscador → filtra server-side
7. Usar filtros fecha → Hoy/Ayer/7días/30días/Rango — filtra server-side, paginación se resetea
8. Navegar páginas con Anterior/Siguiente — carga 50 pedidos del servidor
9. Click en card "Reintentar" → muestra pedidos con 1–2 intentos; badge "+24h"/"+48h" en los atrasados
10. Click en card "Confirmados sin guía" → read-only, sin botones de acción
11. Click en card "Despachados" → read-only con guía + último movimiento
12. En móvil (DevTools → iPhone 14 Pro): select dropdown muestra las 4 vistas, cards responsivas
13. Ejecutar acción "Confirmó" en vista Reintentar → toast verde, row actualiza
14. Ejecutar "Canceló" → row desaparece después de 1.5s
15. Verificar que badges SD (purple), duplicados (ámbar), cobertura siguen apareciendo
16. Verificar que las rutas `/confirmados` y `/despachados` siguen funcionando independientemente
17. Verificar estado logística: pedidos con `in_transit` muestran "En tránsito" (badge azul explícito)

---

### /confirmacion — Tabs redefinidos + Filtro de fecha + UX móvil (2026-05-09)

**Cambios al módulo /confirmacion:**

#### Definiciones canónicas de tabs (actualizadas)

| Tab | Definición |
|---|---|
| **Todos** | Todos los pedidos base (pending + sin tracking + normalized_status=pending). Orden inteligente: atrasados → reintentar → nuevos. |
| **Nuevos** | Solo pedidos de HOY en `America/Santo_Domingo`, `confirmation_attempts = 0` (sin contacto previo). |
| **Reintentar** | `confirmation_attempts` entre 1 y 2, sin importar fecha. |
| **Atrasados +48h** | Pending sin tracking, `shopify_created_at < ahora - 48h`. |
| **Santo Domingo** | Detectados por `isSantoDomingoOrder` (client-side). |
| **Duplicados / Cobertura / Zona desc.** | Filtros de alerta, sin cambio. |

**Cambio clave en "Nuevos":** Antes = `confirmation_attempts = 0` (cualquier fecha). Ahora = `confirmation_attempts = 0` **AND** `shopify_created_at` dentro del día actual en RD. Los pedidos sin contactar de ayer o de días anteriores ya NO aparecen en "Nuevos" — aparecen en "Todos" y potencialmente en "Atrasados".

**Cambio en "Atrasados":** La query del stats API usa `shopify_created_at < cutoff48h` (antes usaba `created_at`). Esto es más preciso para pedidos Shopify.

#### Filtro de fecha

- Botones: **Hoy · Ayer · 7 días · Rango** (aparecen encima de los tabs, en el bloque de la tabla)
- El filtro aplica sobre `shopify_created_at ?? created_at`
- El tab **"Nuevos"** ignora el filtro de fecha (tiene su propio constraint = hoy)
- **Rango personalizado:** inputs `date` desde/hasta, botón "Aplicar" activa el filtro
- **Limpiar:** borra filtro y fechas; resetea a página 1
- Todos los filtros de fecha recalculan usando `rdMidnightUTC(offsetDays)` — medianoche RD = 04:00 UTC

#### UX de tabs

- **Móvil:** `<select>` dropdown reemplaza la barra horizontal de tabs (evita scroll horizontal con 8 opciones)
- **Desktop:** tabs horizontales compactos (`min-h-[40px] px-3 py-2`) vs antes (`min-h-[44px] px-4 py-2.5`)
- Los contadores en el select muestran el count junto al nombre: "Nuevos (3)"

#### Nuevas funciones en `confirmacion/page.tsx`

- `rdMidnightUTC(offsetDays)` — calcula ms UTC de medianoche RD. offsetDays=0=hoy, -1=ayer, 1=mañana
- `effectiveDateRange` memo — convierte `dateFilter` en `{ from: number, to: number }` en ms UTC
- `dateFilter` state — `'hoy' | 'ayer' | '7dias' | 'personalizado' | null`
- `dateFrom`, `dateTo`, `dateApplied` states — para el rango personalizado
- `filteredOrders` actualizado — aplica `effectiveDateRange` antes del filtro de búsqueda (excepto en tab 'nuevos')

#### `api/confirmacion/stats/route.ts` — cambios

- Nueva función `rdTodayStartISO()` — calcula ISO string de medianoche RD hoy
- `nuevos` query: agregado `.gte('shopify_created_at', todayStartRD)` — solo cuenta pedidos de hoy
- `atrasados` query: cambiado de `.lt('created_at', cutoff48h)` a `.lt('shopify_created_at', cutoff48h)` — usa shopify_created_at

**Cómo probarlo:**
1. `npm run dev` → ir a `/confirmacion`
2. Verificar que "Nuevos" solo muestra pedidos de hoy con 0 intentos (no pedidos de ayer)
3. Activar filtro "Ayer" → en tab "Todos" aparecen pedidos de ayer; en tab "Nuevos" no cambia
4. Activar filtro "Rango" → ingresar fechas → click "Aplicar" → se filtran pedidos por esa fecha
5. En móvil (DevTools → iPhone 14): la barra de tabs se reemplaza por un `<select>` dropdown
6. Cambiar tab desde el select → la vista cambia correctamente

---

### /reparto — Guías estancadas visibles + fallback status_since (2026-05-09)

**Problema resuelto:** Guías del mes pasado con `normalized_status='en_reparto'` no siempre aparecían en `/reparto` porque el query ordenaba por `updated_at DESC` y limitaba a 200 registros, dejando afuera los más viejos.

**Cambios en `reparto/page.tsx`:**

1. **`repartoSinceMs(order)`** — fallback actualizado:
   - Antes: `status_since ?? updated_at`
   - Ahora: `status_since ?? last_tracking_update ?? updated_at`
   - Razón: `last_tracking_update` es más representativo del último evento real en EFI que `updated_at`

2. **Fetch de órdenes en reparto:**
   - Antes: `GET /api/orders?status=en_reparto&limit=200&page=1`
   - Ahora: `GET /api/orders?status=en_reparto&limit=500&page=1&sortBy=status_since_asc`
   - `sortBy=status_since_asc`: ordena por `status_since ASC NULLS LAST, updated_at ASC` → los más viejos (críticos) aparecen primero
   - `limit=500`: cubre escenarios con muchas guías históricas

3. **Banner en tab "Crítico":** Aparece cuando hay guías críticas activas — indica cómo sincronizar si ya fueron entregadas en EFI.

**Cambio en `api/orders/route.ts`:**
- Nuevo parámetro `?sortBy=status_since_asc`
- Query resultante: `.order('status_since', { ascending: true, nullsFirst: false }).order('updated_at', { ascending: true })`
- Sin `sortBy`: comportamiento anterior (`updated_at DESC`)

**Resultado en /reparto:**
- Guías de hace 30+ días en `en_reparto` → aparecen en tab "Crítico" con badge rojo pulsante "+48h"
- Badge label: "+48h · Crítico" con punto rojo animado
- Clasificación correcta: Normal (0-24h), Riesgo (24-48h), Crítico (+48h)

**Cómo probarlo:**
1. `npm run dev` → ir a `/reparto`
2. Tab "Crítico" debe mostrar guías de hace +48h, incluyendo las del mes pasado
3. Badge rojo con punto pulsante en cada guía crítica
4. "En reparto desde" muestra la fecha real (ej. "Hace 32d 4h")
5. El banner de info aparece en el tab Crítico cuando hay guías

---

### /api/admin/recover-shopify-orders — Nota sobre sync tracking (2026-05-09)

Si pedidos +48h aparecen en "Atrasados" pero ya fueron despachados en Shopify (confirmed + fulfilled), correr desde Postman o desde `/settings`:

```
POST /api/admin/recover-shopify-orders
Body: { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }
```

Este endpoint ya incluye `fulfillments` en los fields de Shopify API y sincroniza `tracking_number` si estaba null en DB. Una vez sincronizado, el pedido desaparece de `/confirmacion` en el próximo refresh y aparece en `/despachados`.

**No se hicieron cambios destructivos.** El proceso es idempotente — solo actualiza `tracking_number` cuando estaba NULL.

---

### Santo Domingo / Transporte local (2026-05-09)

**Contexto:** Pedidos con destino Santo Domingo / Distrito Nacional se despachan por transporte local, NO por EFI. Se necesita identificarlos fácilmente desde que entran para no generarles guía EFI.

**Criterios de detección — `isSantoDomingoOrder(city, province, address)`:**

Regex: `/santo domingo|distrito nacional|\bdn\b/` aplicado sobre `normalize(city + province + address)`.

| Término detectado | Ejemplos que matchean |
|---|---|
| `santo domingo` | "Santo Domingo", "Santo Domingo Este/Norte/Oeste", "Sto. Domingo" |
| `distrito nacional` | "Distrito Nacional", "D.N." no (por el punto), "DN" sí (regex `\bdn\b`) |
| `\bdn\b` | "DN" como ciudad o provincia — `\b` previene falsos positivos en palabras que contengan "dn" |

**`normalize()` reutilizada** de `alert-helpers.ts`: lowercase + strip diacritics (NFD → /[̀-ͯ]/g).

**Archivos modificados:**

| Archivo | Qué hace |
|---|---|
| `src/lib/alert-helpers.ts` | Nueva función exportada `isSantoDomingoOrder(city, province, address): boolean` |
| `src/components/shared/alert-badges.tsx` | Nueva prop opcional `province?: string \| null`. Muestra badge púrpura "SD / Transporte local" con icono `Building2` cuando `isSantoDomingoOrder` retorna true. **No rompe llamadas existentes** (province es opcional). |
| `src/app/api/confirmacion/stats/route.ts` | Dos nuevos contadores vía ILIKE en la DB: `santoDomingoPendientes` (pendingBase + OR filter) y `santoDomingoConfirmadosSinGuia` (confirmados sin guía + OR filter). El OR filter usa `city.ilike.%santo domingo%`, `city.ilike.%distrito nacional%`, `city.ilike.dn`, `province.*`, `customer_address.*`. |
| `src/app/(app)/confirmacion/page.tsx` | Tab `'🏙️ Sto. Domingo'` nuevo. Card de stats fila 1 ahora es `grid-cols-2 md:grid-cols-4` con 4ta tarjeta púrpura "Santo Domingo". AlertBadges en card + tabla reciben `province={order.province}`. Count del tab usa `stats.santoDomingoPendientes ?? alertCounts.santoDomingo`. |
| `src/app/(app)/confirmados/page.tsx` | Filtro `'🏙️ Santo Domingo'` en panel Alertas (aparece solo si hay ≥1 pedido SD). Fila SD tiene fondo `bg-purple-50/40`. AlertBadges ya muestra badge SD automáticamente. |

**UI en /confirmacion:**
- Nueva tarjeta púrpura "Santo Domingo / Usar transporte local" en fila de stats — clickeable, activa el tab `santo_domingo`
- Tab `'🏙️ Sto. Domingo'` en barra de tabs con conteo
- Badge "SD / Transporte local" púrpura en cada pedido (mobile card + desktop table) vía `AlertBadges` con `province`

**UI en /confirmados:**
- Fondo `bg-purple-50/40` en filas SD
- Badge "SD / Transporte local" en columna Cliente vía `AlertBadges`
- Botón filtro `'🏙️ Santo Domingo'` en panel Alertas — solo visible si hay pedidos SD
- Segundo click en el filtro lo desactiva (toggle)

**No requiere migración de DB.** La detección es 100% client-side (frontend) y query-side (API stats con ILIKE). Sin nuevas columnas.

**Pendiente futuro — integración transportadora local:**
- Asignar transportadora local (ej. "Transporte Express DN") en el campo `carrier` o nueva tabla
- Flujo separado: pedidos SD no pasan por asignación de tracking EFI
- Webhook o API de la transportadora local para sincronizar estado
- Tab/módulo propio en `/confirmados` o nuevo módulo `/local` si el volumen lo justifica
- Por ahora: solo alerta/segmentación visual + acceso fácil, cero automatización

**Cómo probar:**
1. `npm run dev` en `control-cod-app/`
2. Login como admin o confirmation_agent → ir a `/confirmacion`
3. Si hay pedidos con city="Santo Domingo" o city="DN": ver badge púrpura "SD / Transporte local" en cada pedido
4. La tarjeta "Santo Domingo" en la fila de stats muestra el conteo; click activa el tab `🏙️ Sto. Domingo`
5. El tab filtra solo pedidos SD y los lista normalmente (mismas acciones disponibles)
6. Ir a `/confirmados` → pedidos SD tienen fondo morado sutil y badge; filtro "🏙️ Santo Domingo" aparece en el panel Alertas si hay pedidos SD

---

### /reparto — Responsive mobile-first (2026-05-06)

**Estrategia de breakpoint:** `md` (768px). Por debajo → cards. Por encima → tabla idéntica a la versión anterior.

**Cambios por sección:**

| Sección | Mobile (< md) | Desktop (≥ md) |
|---|---|---|
| Banner | Compacto `px-4 py-4`, subtítulo oculto `hidden md:block`, botón sin texto | Igual que antes |
| Stats fila 1 (3 cards) | `p-3 gap-2`, subtítulo oculto en cada card | `p-4 gap-3` |
| Stats fila 2 (5 cells) | `grid-cols-3` | `grid-cols-5` |
| Tabs | `min-h-[44px]` touch target | Sin cambios |
| Cards activas | `md:hidden divide-y divide-amber-50` — renderiza `RepartoCard` | No se renderiza |
| Tabla activa | `hidden md:table w-full text-sm` | Intacta |
| Paginación | `min-h-[40px]`, conteo abreviado | Sin cambios |

**Subcomponente nuevo:** `RepartoCard` (antes del export default).
- Props: `order, accion, busy, isEntregado, courierConfirmed, isHighlighted, onContactado, onEntrego, onNoAnswer, onEscalar`
- Muestra: tracking + badge criticidad (header), cliente + teléfono, ciudad + tiempo en reparto, WA + Llamar (botones grandes 44px cuando sin acción), grid 2×2 (Contactado/Entregó/No responde/Escalar), o badge estado si ya tiene acción, Ver detalle link
- `rowRefs` cambió de `HTMLTableRowElement` a `HTMLElement` para compatibilidad con divs de cards

**Cómo probarlo:**
1. `npm run dev` en `control-cod-app/`
2. Chrome DevTools → Toggle Device Toolbar → iPhone 14 Pro (390px)
3. Verificar cards con datos completos, botones WA/Llamar grandes y tocables, acciones 2×2
4. Ejecutar acción → estado actualiza sin recargar
5. Quitar Device Toolbar → tabla desktop idéntica a la original

**Archivos modificados:** `src/app/(app)/reparto/page.tsx`

---

### /confirmacion — Responsive mobile-first (2026-05-06)

**Estrategia de breakpoint:** `md` (768px). Por debajo → cards. Por encima → tabla idéntica a la versión anterior.

**Cambios por sección:**

| Sección | Mobile (< md) | Desktop (≥ md) |
|---|---|---|
| Banner | Compacto `px-4 py-4`, subtítulo oculto, botón sin texto, "confirmados sesión" oculto | Igual que antes |
| Pipeline nav | `overflow-x-auto` wrapper, padding reducido `px-3`, `min-w-[320px]` inner | Igual que antes |
| Stats fila 1 (3 cards) | `p-3 gap-2`, subtítulo ("+48h") oculto en label "Atrasados" → solo "Atrasados" | `p-4 gap-3` |
| Stats fila 2 (6 cells) | `grid-cols-3` | `grid-cols-6` |
| Tabs | `min-h-[44px]` touch target, `overflow-x-auto` con `min-w-max` inner | Sin cambios |
| Cards activas | `md:hidden divide-y divide-indigo-50` — renderiza `ConfirmacionCard` | No se renderiza |
| Tabla activa | `hidden md:block overflow-x-auto` wrapping `<table>` | Intacta |
| Paginación | `min-h-[40px]`, conteo abreviado `X/Y` | Conteo completo |

**Subcomponente nuevo:** `ConfirmacionCard` (antes del export default).
- Props: `order, terminal, totalAttempts, confidence, busy, isHighlighted, onConfirmed, onNoAnswer, onNoCoverage, onCancelled, onSetMethod`
- Muestra: orden# + hora + AlertBadges, cliente + teléfono, ciudad + producto, monto + intentos badge + estado/confianza badges, WA + Llamar (botones grandes 44px), grid 2×2 (Confirmó/No contesta/Sin cobertura/Canceló), o badge terminal si ya procesado, Ver detalle link
- `rowRefs` cambió de `HTMLTableRowElement` a `HTMLElement`

**Cómo probarlo:**
1. `npm run dev` en `control-cod-app/`
2. Chrome DevTools → Toggle Device Toolbar → iPhone 14 Pro (390px)
3. Verificar cards con datos completos, alertas visibles (duplicados/cobertura), botones grandes
4. Ejecutar "Confirmó" → badge verde aparece en card, pedido permanece visible
5. Ejecutar "Canceló" → pedido desaparece después de 1.5s
6. Quitar Device Toolbar → tabla desktop idéntica a la original

**Archivos modificados:** `src/app/(app)/confirmacion/page.tsx`

---

### /novedad — Responsive mobile-first (2026-05-06)

**Qué se hizo:** Toda la pantalla `/novedad` es ahora mobile-friendly sin romper desktop.

**Estrategia de breakpoint:** `md` (768px) es el punto de corte. Por debajo → cards. Por encima → tabla idéntica a la versión anterior.

**Cambios por sección:**

| Sección | Mobile (< md) | Desktop (≥ md) |
|---|---|---|
| Banner | Compacto, íconos reducidos, subtítulo oculto, refresh sin texto | Igual que antes |
| Stats superiores (3 cards) | 2 columnas (Pendientes ocupa 2 cols para destacar) | 3 columnas |
| Stats inferiores (6 cells) | 3 columnas | 6 columnas |
| Tabs | `min-h-[44px]` touch target, `overflow-x-auto` ya existía | Sin cambios |
| Buscador | Ancho completo, `py-2.5` para touch | Sin cambios |
| Tabla novedades activas | `hidden md:table` — oculta en móvil | Intacta, sin cambios |
| Cards novedades activas | `md:hidden` — visible solo en móvil | No se renderiza |
| Tabla entregadas | `hidden md:table` — oculta en móvil | Intacta |
| Cards entregadas | `md:hidden` — visible solo en móvil | No se renderiza |
| Paginación | `min-h-[40px]` touch targets, conteo abreviado | Sin cambios |

**Subcomponentes nuevos en `novedad/page.tsx`:**
- `NovedadCard` — card completa para pedido activo en novedad. Muestra: número de orden, tracking, cliente, teléfono, monto (`cod_amount`), ubicación (city + province + address), producto (`product_summary`), estado/motivo (`raw_status`), días en novedad, badge de intentos con severidad (1 = amarillo, 2 = naranja + "Último intento", 3+ = rojo animado + "Riesgo alto"), sugerencia de supervisor si aplica. Botones grandes: WhatsApp (verde, 48px), Llamar (azul, 48px), luego grid 2×2 de acciones (Contactado/Reprogramar/No responde/No salv.) + "Recuperado" full-width + "Ver detalle" con borde.
- `EntregadaCard` — card para pedidos en tab "✓ Entregadas". Muestra: tracking, nombre de entrega relativo + absoluto, cliente, teléfono, ubicación, fecha completa, badge de intentos previos + `last_attempt_reason`, botón Ver detalle.

**Acciones intactas:** Todas las funciones `postAction`, `markNoSalvable`, `markRecuperada`, `patchTask` sin cambios. Las cards llaman exactamente a las mismas funciones que la tabla.

**Cómo probarlo:**
1. `npm run dev` en `control-cod-app/`
2. Chrome DevTools → Toggle Device Toolbar → iPhone 14 Pro (390px) o similar
3. Verificar: no hay scroll horizontal, cards se ven completas, botones WA y Llamar son grandes y tocables
4. Tocar "WhatsApp" → debe abrir `wa.me/` con el mensaje precargado
5. Tocar "Llamar" → debe iniciar llamada en móvil real
6. Ejecutar acción (ej. Contactado) → debe actualizar el estado en la card sin recargar
7. Cambiar tab → paginación se resetea, cards se actualizan
8. Quitar Device Toolbar → vista desktop debe mostrar tabla idéntica a la original

**Archivos modificados (2026-05-06):** `src/app/(app)/novedad/page.tsx`

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
| `novelty_agent` | Mi rendimiento, Novedades, En Reparto, Tránsito |
| `delivery_agent` | Mi rendimiento, En Reparto, Tránsito |
| `agent` | Mis tareas, Pedidos |
| `viewer` | Pedidos (solo lectura) |

### Roles con acceso a /orders/[id]

| Rol | Acceso | Notas operativas |
|---|---|---|
| `admin` | Completo — lectura + escritura + asignación | Dropdown agentes con email/auth data |
| `ia_supervisor` | Completo — lectura + escritura + asignación | Dropdown agentes básico (sin email) |
| `confirmation_agent` | Lectura + acciones + notas | Necesita ver detalle desde /confirmacion; dropdown agentes básico |
| `novelty_agent` | Lectura + acciones + notas | Necesita ver detalle desde /novedad; dropdown agentes básico |
| `delivery_agent` | Lectura + acciones + notas | Necesita ver detalle desde /reparto; dropdown agentes básico |
| `agent` | Lectura + acciones + notas | Dropdown agentes básico |
| `viewer` | Solo lectura (RLS permite SELECT vía `is_agent_or_above`) | — |

**`GET /api/profiles` — comportamiento por rol:**
- `admin`: lista completa con `email`, `last_sign_in_at`, `last_activity` (requiere service role key)
- cualquier otro rol autenticado: lista básica `(id, full_name, role)` — solo lo necesario para el dropdown de asignación, sin datos sensibles

**Motivo operativo:** `confirmation_agent` y `novelty_agent` usan el botón "Ver detalle" desde `/confirmacion` y `/novedad` respectivamente. Necesitan ver el timeline de acciones, notas internas, tracking EFI y datos del pedido para gestionar correctamente su cola de trabajo.

**Cómo probar el fix de acceso /orders/[id] (2026-05-06):**
1. `npm run dev` en `control-cod-app/`
2. Login como `confirmation_agent` → ir a `/confirmacion` → tocar "Ver detalle" en cualquier pedido → debe abrir `/orders/[id]` sin crash
3. Login como `novelty_agent` → ir a `/novedad` → tocar "Ver detalle" → debe abrir sin crash
4. Verificar que la sección "Responsable" muestra el dropdown con los agentes disponibles (lista básica: nombre + rol)
5. Verificar que el admin sigue viendo email + último login en `/settings` (datos completos intactos)
6. Verificar que acciones (notas, registrar acción) siguen funcionando para los roles afectados

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

### /transito mostraba "Hace menos de 1h" para guías estancadas semanas (2026-05-09)
- **Archivo:** `src/lib/transit-helpers.ts`
- **Causa:** `transitSinceMs` usaba `last_tracking_update` como primera prioridad. El cron `update-order.ts` siempre setea `last_tracking_update = new Date().toISOString()` en cada ejecución (cada 5 min), aunque el estado no haya cambiado. Entonces una guía "Generada" del 30/04 aparecía con `last_tracking_update = hace 3 minutos` → `sinMovimientoLabel` devolvía "Hace menos de 1h" → no caía en Crítico ni Riesgo.
- **Fix:** Cambio de prioridad en `transitSinceMs`: `status_since ?? shipment_created_at ?? shopify_created_at ?? created_at`. `last_tracking_update` dejó de usarse para stuckSince (sigue siendo útil para ordenar el batch del cron).
- **`status_since`** es confiable: el cron lo setea desde `historial_estados.at(0).fecha` — la fecha real en que EFI registró el estado actual. Para una guía "Generada" del 30/04, `status_since` = 30/04 → ~200h → Crítico ✓
- **Validar con:** buscar guía 9000546686 en `/transito` → debe mostrar Crítico +48h. Console del browser: `[transito-debug] horas_calculadas > 200`.

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
