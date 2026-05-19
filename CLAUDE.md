# Control COD — Fuente de verdad del sistema

**Stack:** Next.js 15 (App Router) · Supabase (DB + Auth + RLS) · EFI tracking (scraping HTML) · Node.js cron local

---

## FIX: Datos faltantes (teléfono/dirección) en órdenes importadas (2026-05-18)

### Problema

Muchas órdenes importadas desde EFI aparecen en Novedad sin teléfono, dirección o ciudad.
Causa: el webhook de Shopify puede crear la orden sin esos datos; `reconcile-efi-import` solo guardaba tracking + estado, nunca rellenaba contact data.

### Qué se hizo

| Archivo | Cambio |
|---|---|
| `src/app/api/debug/incomplete-imported-orders/route.ts` | **NUEVO.** `GET /api/debug/incomplete-imported-orders`. Solo admin. Diagnóstico de órdenes con tracking pero sin phone/address/city. |
| `src/app/api/admin/backfill-imported-order-data/route.ts` | **NUEVO.** `POST /api/admin/backfill-imported-order-data`. Solo admin. Acepta CSV/items con tracking + datos de contacto. Rellena campos vacíos sin sobrescribir. |
| `src/app/api/admin/reconcile-efi-import/route.ts` | **MODIFICADO.** `ImportItem` agrega campo `address`. En `processItem`: cuando asigna tracking (confirmed / pending_forced), también rellena `customer_address`, `city`, `customer_name` si están vacíos en DB. En `already_assigned`: rellena campos vacíos incluyendo `customer_phone`. `ImportResult` agrega `contact_fields_filled[]`. |
| `src/app/(app)/efi-import/page.tsx` | **MODIFICADO.** Agrega `ADDRESS_KEYS` y nuevos nombres de columna para phone/city. Modo **"Actualizar datos faltantes"** (modo backfill): botón toggle en la UI, validación solo requiere tracking, llama a `/api/admin/backfill-imported-order-data`. Resultados muestran campos rellenados. |

### Endpoint `GET /api/debug/incomplete-imported-orders`

**Auth:** 401 sin sesión · 403 para no-admin · solo lectura

**Response:**
```json
{
  "generatedAt": "...",
  "totals": { "without_phone": 45, "without_address": 120, "without_city": 98 },
  "by_source": { "shopify_webhook": 110, "csv_import": 10 },
  "sample_count": 30,
  "sample": [
    {
      "id": "...", "tracking_number": "9000555918", "order_number": "#1234",
      "customer_name": "Juan Pérez", "customer_phone": null,
      "customer_address": null, "customer_city": null,
      "normalized_status": "novedad", "raw_status": "Novedad",
      "source": "shopify_webhook", "created_at": "..."
    }
  ]
}
```

### Endpoint `POST /api/admin/backfill-imported-order-data`

**Auth:** 401 sin sesión · 403 para no-admin

**Body:**
```json
{
  "items": [
    {
      "tracking_number": "9000555918",
      "customer_phone":   "8098344999",
      "customer_address": "Calle 1 #2-3",
      "customer_city":    "Santo Domingo",
      "customer_name":    "Juan Pérez"
    }
  ]
}
```

**Lógica por item:**
1. Buscar orden por `tracking_number`
2. Si no existe → `not_found`
3. Si existe, para cada campo provisto: si está vacío en DB → llenar (normalizePhone para teléfono)
4. Si ningún campo estaba vacío → `skipped`
5. Si se llenó al menos uno → `updated`

**Reglas:** NO sobrescribe campos no vacíos · phone normalizado a solo dígitos · trim de todos los strings · idempotente

**Response:**
```json
{
  "summary": { "scanned": 100, "updated": 78, "skipped": 15, "not_found": 5, "errors": 2 },
  "sample_updated": [{ "tracking_number": "...", "outcome": "updated", "order_number": "#1234", "fields_filled": ["customer_phone", "customer_address"] }],
  "sample_missing": [{ "tracking_number": "...", "outcome": "not_found" }]
}
```

### Mejora reconcile-efi-import

Nuevas columnas CSV reconocidas:
- **Teléfono:** `customer_phone`, `Teléfonos destinatario` (nuevos; antes no detectados)
- **Dirección:** `Dirección destinatario`, `customer_address`, `address`, `direccion` (nuevos)
- **Ciudad:** `customer_city`, `ciudad/provincia`, `provincia` (nuevos)

Cuando asigna tracking a una orden confirmada/pendiente, también escribe `customer_address`, `city`, `customer_name` si estaban vacíos. El campo `contact_fields_filled` en la respuesta muestra qué se rellenó.

Para órdenes `already_assigned`: también rellena `customer_phone`, `customer_address`, `city`, `customer_name` si están vacíos.

### UI `/efi-import` — modo backfill

Toggle en la pantalla de input:
- **"Importar guías nuevas"** (modo original, requiere tracking + teléfono)
- **"Actualizar datos faltantes"** (modo backfill, solo tracking obligatorio)

En modo backfill: llama a `/api/admin/backfill-imported-order-data`, muestra resultados con campos rellenados por guía.

### Flujo de uso recomendado

1. `GET /api/debug/incomplete-imported-orders` → ver cuántas órdenes tienen datos faltantes y por qué source
2. Si `totals.without_phone > 0`: ir a `/efi-import` → modo "Actualizar datos faltantes" → subir CSV de EFI con columnas de contacto
3. Revisar resultados: `updated` = campos rellenados, `skipped` = ya tenían datos, `not_found` = guías no están en DB
4. Re-ejecutar debug para confirmar que los totales bajaron

### Seguridad / qué NO hace

- No sobrescribe campos de contacto existentes (solo NULL → valor)
- No modifica estados logísticos (`normalized_status`, `raw_status`)
- No toca financiero ni Shopify sync
- No llama a EFI
- Solo admin puede ejecutar ambos endpoints
- Idempotente: ejecutar dos veces no duplica ni sobreescribe

---

## DIAGNÓSTICO RAÍZ: Por qué guías activas en EFI no existen en DB (2026-05-16)

### Causa raíz confirmada: el paso de asignación de tracking está roto/ausente

Tras revisión exhaustiva de todos los archivos relevantes, la causa raíz es una **laguna estructural en el flujo de despacho**:

**Flujo actual (roto):**
```
Shopify webhook → orders (tracking_number=NULL, status='pending')
    ↓
Agente confirma → confirmation_status='confirmed', tracking_number=NULL
    ↓
Equipo logístico crea guía en EFI manualmente (fuera del sistema)
    ↓ ← EL PASO FALTANTE: nadie guarda el número de guía en la app
Orden queda en DB: confirmed + tracking_number=NULL (para siempre en /confirmados)
Guía EFI: existe en EFI sin relación a ningún registro de DB
```

### Evidencia encontrada (todos los paths de escritura de tracking_number)

| Path | Escribe tracking_number | Aplica al caso |
|---|---|---|
| `POST /api/webhooks/shopify/orders` | Siempre NULL | No aplica |
| `PATCH /api/orders/[id]` | **EXCLUIDO explícitamente** | Bloqueado por diseño |
| `POST /api/orders/[id]/tracking` | **Requiere que ya exista** — error si NULL | No aplica |
| `POST /api/admin/recover-shopify-orders` | Solo desde `fulfillments[].tracking_number` de Shopify | EFI ≠ fulfillment Shopify |
| `POST /api/imports` | Crea registros nuevos desde CSV (no vinculados a Shopify) | No aplica para órdenes Shopify |
| `/confirmados` page | **Sin formulario de asignación** — botón "Listo para despacho" es solo UI local | Ausente |

### Conclusión

Las guías con `exists_in_db: false` en el endpoint `compare-efi-guides` corresponden a:
1. **Caso principal**: Guías creadas en EFI para órdenes confirmadas, pero sin mecanismo para guardar el número de guía en DB. La orden en DB queda con `tracking_number=NULL` en `/confirmados` indefinidamente.
2. **Posible caso secundario**: Guías creadas directamente en EFI sin ninguna orden correspondiente en DB (raro).

### Por qué PATCH excluye tracking_number

```typescript
// src/app/api/orders/[id]/route.ts — solo estos campos son permitidos:
const ALLOWED_FIELDS = ['classification', 'is_at_risk', 'follow_up_result', 'normalized_status', 'customer_confirmed']
// tracking_number NO está en esta lista — fue excluido intencionalmente
```

### Por qué recover-shopify-orders no ayuda

`recover-shopify-orders` extrae `tracking_number` de `order.fulfillments[].tracking_number`. Pero EFI es un carrier externo — el equipo logístico **no crea fulfillments en Shopify**. Solo crean la guía directamente en EFI. Shopify no sabe que existe esa guía, por lo tanto `fulfillments` está vacío para estos pedidos.

### Fix requerido (tres pasos)

**Paso 1 — Endpoint de asignación (CRÍTICO):**
Crear `PATCH /api/orders/[id]/assign-tracking` (o añadir `tracking_number` al PATCH existente):
- Solo admin/ia_supervisor
- Body: `{ tracking_number: string }`
- Valida que la orden tenga `confirmation_status='confirmed'` y `tracking_number IS NULL`
- Actualiza `tracking_number` + `normalized_status='in_transit'` en DB
- El cron lo sincroniza con EFI en el siguiente ciclo

**Paso 2 — UI en /confirmados (CRÍTICO):**
Añadir a cada fila de `/confirmados` un input de texto + botón "Asignar guía" que llame al endpoint del paso 1. Cuando se asigna, la fila desaparece de `/confirmados` y aparece en `/despachados` en el próximo refresh.

**Paso 3 — Reconciliación retroactiva (IMPORTANTE):**
Para las guías ya activas en EFI sin match en DB, se puede crear un endpoint de reconciliación que:
- Acepta `{ guide: string, order_id?: string }` o `{ guide: string, customer_phone?: string }`
- Si se provee `order_id`: asigna directamente
- Si se provee `customer_phone`: busca en DB orders con ese teléfono en `confirmed + tracking_number=NULL`
- Si hay match: asigna el tracking_number y el cron sincroniza
- Si no hay match: crea un registro mínimo en DB (source='efi_manual') para que el cron lo procese

### Estado

- [x] Paso 1: endpoint assign-tracking — **IMPLEMENTADO** (2026-05-16)
- [x] Paso 2: UI en /confirmados — **IMPLEMENTADO** (2026-05-16)
- [x] Paso 3: reconciliación retroactiva — **IMPLEMENTADO** (2026-05-17)
- [x] Paso 4: importación masiva EFI (CSV) — **IMPLEMENTADO** (2026-05-17)
- [x] Paso 5: límite de importación aumentado a 500 guías — **IMPLEMENTADO** (2026-05-17)
- [x] Paso 6: revalidación en tiempo real contra EFI de guías activas — **IMPLEMENTADO** (2026-05-17)
- [x] Paso 7: debug y corrección de discrepancias novedad DB vs EFI — **IMPLEMENTADO** (2026-05-18)
- [x] Paso 8: `indemnizacion` como normalized_status independiente — **IMPLEMENTADO** (2026-05-17)
- [x] Paso 9: migración DB de registros previos al Paso 8 + fix `failed_attempt` — **IMPLEMENTADO** (2026-05-18)

---

## FIX: Migración de registros previos al Paso 8 — indemnizacion en DB (2026-05-18)

### Problema

El parser (Paso 8) mapea correctamente `raw_status ILIKE '%indemniz%'` → `normalized_status='indemnizacion'` para las guías sincronizadas por el cron a partir del 2026-05-17. Sin embargo, los registros ya existentes en DB (importados por CSV antes del Paso 8) siguen con `normalized_status='novedad'` y `raw_status='Indemnización'`. Esto causa:

- Tab `⚖ Indemniz.` muestra 0 órdenes
- Conteo de novedades inflado (~10 extra)
- Ejemplo: guía `9000532922` aparece en Novedad aunque raw_status = "Indemnización"

### Qué se hizo

| Archivo | Cambio |
|---|---|
| `src/app/api/admin/fix-indemnizacion-status/route.ts` | **NUEVO.** `POST /api/admin/fix-indemnizacion-status`. Solo admin. DB-only (sin llamadas EFI). Encuentra `normalized_status='novedad' AND raw_status ILIKE '%indemniz%'` y actualiza a `normalized_status='indemnizacion'`. Devuelve `{ scanned, updated, sample }`. |
| `src/app/api/debug/indemnizacion-status/route.ts` | **NUEVO.** `GET /api/debug/indemnizacion-status`. Solo admin. Solo lectura. Devuelve `{ total_indemnizacion, total_mismatched, sample, note }`. |
| `src/app/api/orders/route.ts` | **MODIFICADO.** Filtro `failed_attempt`: añadido `.neq('normalized_status', 'indemnizacion')`. Previene que órdenes de indemnización con `delivery_attempts >= 1` aparezcan en la vista de intentos fallidos. |

### Endpoints

#### `GET /api/debug/indemnizacion-status`

**Auth:** 401 sin sesión · 403 para no-admin · solo lectura

**Response:**
```json
{
  "generatedAt": "...",
  "total_indemnizacion": 12,
  "total_mismatched": 8,
  "sample": [
    { "tracking_number": "9000532922", "order_number": "#8750", "customer_name": "...", "raw_status": "Indemnización", "last_tracking_update": "...", "created_at": "..." }
  ],
  "note": "total_mismatched > 0 significa que hay órdenes en novedad con raw_status de indemnización — ejecutar POST /api/admin/fix-indemnizacion-status para corregirlas."
}
```

#### `POST /api/admin/fix-indemnizacion-status`

**Auth:** 401 sin sesión · 403 para no-admin

**Lógica:**
1. Query: `normalized_status='novedad' AND raw_status ILIKE '%indemniz%'`
2. UPDATE en lote: `normalized_status='indemnizacion'`
3. Devuelve `{ scanned, updated, sample }` (muestra máx. 20 filas)

**Response:**
```json
{ "scanned": 8, "updated": 8, "sample": [...] }
```

Si ya no hay desincronizadas: `{ "scanned": 0, "updated": 0, "sample": [] }`

### Fix secundario: `failed_attempt` excluye `indemnizacion`

`/api/orders?status=failed_attempt` filtraba `delivery_attempts >= 1 AND normalized_status != 'delivered'`. Las órdenes de indemnización (que tienen delivery_attempts >= 1 por haberlo sido novedades) aparecían incorrectamente en esa vista.

**Fix:** `.neq('normalized_status', 'indemnizacion')` añadido al branch `failed_attempt` en `src/app/api/orders/route.ts`.

### Flujo de uso

1. `GET /api/debug/indemnizacion-status` → verificar `total_mismatched`
2. Si `total_mismatched > 0`: `POST /api/admin/fix-indemnizacion-status`
3. Verificar: tab `⚖ Indemniz.` en `/novedad` muestra las órdenes; conteo de novedades baja en igual cantidad

### Seguridad / qué NO hace

- No llama a EFI (solo DB)
- No crea ni elimina registros
- No modifica guías que ya tengan `normalized_status='indemnizacion'`
- Solo admin puede ejecutarlo
- Idempotente: correr dos veces no duplica actualizaciones

---

## FIX: `indemnizacion` como normalized_status independiente — Paso 8 (2026-05-17)

### Problema

Después del debug (Paso 7), se confirmó que las 10 novedades de más eran órdenes cuyo `raw_status` en EFI era "Indemnización". El parser antiguo mapeaba "Indemnización" → `novedad`, contaminando el KPI operativo de novedades reales con casos que ya están en proceso de reclamo al courier.

### Solución

Nuevo `normalized_status = 'indemnizacion'` que segrega estos casos del flujo de novedad activa.

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/types/index.ts` | `NormalizedStatus` agrega `'indemnizacion'`. `STATUS_LABELS` agrega `indemnizacion: 'Indemnización'`. `STATUS_COLORS` agrega `indemnizacion: 'bg-violet-100 text-violet-700'`. |
| `src/lib/tracking/efi-parser.ts` | `mapNormalizedStatus()` agrega `if (s.includes('indemnizaci')) return 'indemnizacion'` ANTES del bloque `novedad`. Orden crítico: "Indemnización" no contiene "novedad", pero si EFI combinara términos, verificar antes. |
| `src/app/api/admin/reconcile-efi-import/route.ts` | `mapEstadoToNormalized()` agrega `if (s.includes('indemnizaci')) return 'indemnizacion'` antes de `en_reparto`. |
| `src/app/api/admin/sync-imported-active-guides/route.ts` | `ACTIVE_STATUSES` actualizado: `['in_transit', 'en_reparto', 'novedad', 'indemnizacion']`. Las guías en indemnizacion ahora se re-validan en tiempo real contra EFI. |
| `src/app/api/dashboard/route.ts` | Agrega `staleIndemnizacionRes` al Promise.all (guías indemnizacion +1 día sin movimiento). Stats agrega `indemnizacion: count`. Response agrega `stale_indemnizacion`. |
| `src/app/(app)/dashboard/page.tsx` | Importa `Scale` de lucide-react. `DashboardData.stats` agrega `indemnizacion: number`. KPI card violet condicional (solo visible cuando `stats.indemnizacion > 0`). |
| `src/app/(app)/novedad/page.tsx` | Tab `⚖ Indemniz.` añadido. Fetch paralelo a `/api/orders?status=indemnizacion`. Estado `indemnizacionOrders`. Vista separada: mobile cards + desktop table violet, sin botones de acción, solo "Ver detalle". `tabCounts` incluye `indemnizacion`. `displayedOrders` retorna `[]` para tab indemnizacion. `totalPages`/`activeCount` manejan tab indemnizacion. |
| `src/app/api/debug/tracking-health/route.ts` | Agrega `stuckIndemnizacionSampleRes` (guías indemnizacion +24h sin actualización) al Promise.all. Respuesta incluye `stuckSamples.indemnizacion_stuck24h`. |

### Comportamiento del parser (regla permanente)

```
mapNormalizedStatus():
  1. 'indemnizaci' → 'indemnizacion'   ← PRIMERO (antes del bloque novedad)
  2. 'novedad' / 'ausente' / ... → 'novedad'
  ...
```

**Umbral de stale:** indemnizacion usa +1 día (igual que novedad) — son casos activos con courier.

### Tab `/novedad` — ⚖ Indemniz.

- **Visible para:** admin y novelty_agent (mismos roles que el resto de /novedad)
- **Aparece solo cuando hay órdenes** (`tabCounts.indemnizacion > 0`)
- **Sin botones de acción:** solo violet badge + "Ver detalle"
- **Fetch independiente:** `/api/orders?status=indemnizacion&limit=200&page=1`

### Normalización de estados — actualización

| Estado EFI (raw_status) | normalized_status | Notas |
|---|---|---|
| contiene 'indemnizaci' | `indemnizacion` | **NUEVO** — evaluado ANTES de novedad |
| contiene 'novedad' / 'ausente' / ... | `novedad` | Sin cambio |

---

## FIX: Debug y corrección de discrepancias novedad DB vs EFI — Paso 7 (2026-05-18)

### Problema

Después de la importación masiva y la sincronización general (Pasos 4–6), tránsito y reparto quedaron alineados, pero aún había 10 novedades de más en la app (App: 106, EFI: 96). Las discrepancias venían del CSV importado, cuyos estados tenían horas de antigüedad al momento de la importación.

### Qué se hizo

Dos endpoints nuevos que trabajan en pareja: uno diagnóstico (sin escrituras) y uno correctivo.

| Archivo | Cambio |
|---|---|
| `src/app/api/debug/novedad-vs-efi/route.ts` | **NUEVO.** `GET /api/debug/novedad-vs-efi`. Solo admin. Solo lectura. Consulta EFI real-time para cada novedad en DB y compara. `maxDuration=300`. Limit configurable via `?limit=N` (default 120, máx 200). |
| `src/app/api/admin/fix-novedad-mismatches/route.ts` | **NUEVO.** `POST /api/admin/fix-novedad-mismatches`. Solo admin. Consulta EFI y aplica `updateOrderTracking()` para todas las novedades. `maxDuration=300`. Limit configurable en body. |

### Endpoint debug: `GET /api/debug/novedad-vs-efi`

**Auth:** 401 sin sesión · 403 para no-admin · solo lectura

**Query params:**
- `limit` — cuántas novedades revisar (default 120, máx 200). Default diseñado para cubrir el universo típico de ~106 novedades.

**Flujo:**
1. Query DB: `normalized_status='novedad'` + `tracking_number IS NOT NULL`, ordenado por `last_tracking_update ASC`
2. Para cada guía: fetch EFI HTML directo + `parseEFITracking()` — SIN escribir DB
3. Categoriza: `still_novedad` / `changed_from_novedad` / `unknown_or_failed`
4. `changed_from_novedad` ordenadas por urgencia: delivered > returned > en_reparto > in_transit

**Response:**
```json
{
  "generated_at": "...",
  "query": { "limit": 120, "checked": 106, "note": "Se revisaron todas las novedades." },
  "summary": {
    "total_db_novedad": 106,
    "still_novedad_in_efi": 96,
    "changed_from_novedad": 7,
    "unknown_or_failed": 3,
    "by_efi_status": { "novedad": 96, "delivered": 3, "in_transit": 2, "en_reparto": 2, "not_found": 2, "unknown": 1 }
  },
  "changed_from_novedad": [
    {
      "tracking_number": "9001234",
      "order_number": "1234",
      "customer_name": "Juan Pérez",
      "last_tracking_update": "2026-05-17T10:00:00Z",
      "db_raw_status": "Novedad",
      "efi_raw_status": "Entregada",
      "efi_normalized_status": "delivered"
    }
  ],
  "still_novedad": [...],
  "unknown_or_failed": [...]
}
```

### Endpoint fix: `POST /api/admin/fix-novedad-mismatches`

**Auth:** 401 sin sesión · 403 para no-admin

**Body (opcional):**
```json
{ "limit": 120 }
```

**Flujo:** igual que `sync-imported-active-guides` pero filtrado solo a `normalized_status='novedad'`. Usa `updateOrderTracking()` que aplica el guardia anti-unknown-overwrite (si EFI devuelve `unknown`, preserva `novedad` en DB).

**Response:**
```json
{
  "summary": {
    "total_queried": 106,
    "checked": 103,
    "updated": 101,
    "changed_status": 10,
    "skipped": 2,
    "failed": 3
  },
  "by_old_status": { "novedad": 106 },
  "by_new_status": { "novedad": 96, "delivered": 4, "in_transit": 3, "en_reparto": 2, "returned": 1 },
  "changed": [
    { "order_number": "1234", "tracking_number": "9001234", "customer_name": "Juan Pérez", "old_status": "novedad", "new_status": "delivered" }
  ],
  "failed": [...]
}
```

### Rendimiento

- 120 guías × (500ms delay + ~1.5s fetch promedio) ≈ 240s → dentro del `maxDuration=300`
- EFI delay: 500ms (vs 600ms del batch — sin escritura DB en el debug, más liviano)

### Flujo recomendado de uso

1. Ejecutar debug primero: `GET /api/debug/novedad-vs-efi`
2. Revisar `changed_from_novedad` — ver cuáles guías ya no son novedad en EFI
3. Si el resultado tiene sentido, ejecutar fix: `POST /api/admin/fix-novedad-mismatches`
4. Verificar `by_new_status` del fix para confirmar que los conteos se alinean con EFI

### Seguridad / qué NO hace

- Debug: no escribe nada en DB
- Fix: no crea registros nuevos, no toca financiero, no modifica guías `delivered`/`returned` (no están en el universo novedad), usa mismo parser que el cron

---

## FIX: Revalidación en tiempo real de guías activas contra EFI — Paso 6 (2026-05-17)

### Problema

Después de la importación masiva (Paso 4), los estados en DB reflejaban el CSV exportado de EFI, no el estado actual real. El CSV puede tener horas o días de antigüedad. Ejemplo de discrepancia observada:

| Estado | App (post-import) | EFI real |
|--------|-------------------|----------|
| Novedad | 97 | 87 |
| Tránsito | 21 | 19 |
| Reparto | 17 | 19 |
| Generadas | 22 | — |

### Qué se hizo

Nuevo endpoint `POST /api/admin/sync-imported-active-guides` que consulta EFI en tiempo real para todas las guías activas en DB y corrige los estados del CSV con el estado real actual.

### Archivos creados

| Archivo | Cambio |
|---|---|
| `src/app/api/admin/sync-imported-active-guides/route.ts` | **NUEVO.** `POST /api/admin/sync-imported-active-guides`. Solo admin. Consulta EFI real-time. `maxDuration=300`. Default 150 guías, configurable hasta 300. |

### Endpoint `POST /api/admin/sync-imported-active-guides`

**Auth:** 401 sin sesión · 403 para no-admin

**Body (todos opcionales):**
```json
{ "limit": 150 }
```
`limit`: cuántas guías procesar (default 150, máx 300). Se procesan las más antiguas primero (`last_tracking_update ASC NULLS FIRST`).

**Universo activo consultado:** `normalized_status IN ('in_transit', 'en_reparto', 'novedad')` + `tracking_number IS NOT NULL`

**Flujo interno:**
1. Consulta DB → guías activas ordenadas por `last_tracking_update ASC NULLS FIRST`
2. Para cada guía: llama `updateOrderTracking()` (lib ya existente) con 600ms de pausa entre calls
3. `updateOrderTracking` hace: fetch EFI → parse → DB update completo (raw_status, normalized_status, delivery_attempts, historial, fechas)
4. Registra cambios de estado para el summary

**Rendimiento:** 150 guías × (600ms delay + ~3s fetch) ≈ 90–135s. Bien dentro de `maxDuration=300`.

**Response:**
```json
{
  "summary": {
    "total_queried": 135,
    "checked": 130,
    "updated": 128,
    "changed_status": 23,
    "skipped": 2,
    "failed": 5
  },
  "by_old_status": { "in_transit": 21, "en_reparto": 17, "novedad": 97 },
  "by_new_status": { "in_transit": 19, "en_reparto": 19, "novedad": 87, "delivered": 3, "returned": 2 },
  "changed": [
    { "order_number": "1234", "tracking_number": "9001234", "old_status": "novedad", "new_status": "delivered" }
  ],
  "failed": [
    { "order_number": "5678", "tracking_number": "9005678", "error": "Guía no encontrada en EFI" }
  ]
}
```

**Campos del summary:**
| Campo | Descripción |
|---|---|
| `total_queried` | Filas que devolvió la query DB |
| `checked` | EFI respondió exitosamente |
| `updated` | DB actualizado (status o datos) |
| `changed_status` | `normalized_status` cambió respecto a DB anterior |
| `skipped` | EFI devolvió `unknown` y se evitó sobreescribir un estado válido |
| `failed` | EFI no respondió o error de DB |

**Seguridad / qué NO hace:**
- No crea registros nuevos
- No toca campos financieros
- No modifica guías `delivered` ni `returned` (no están en el universo activo)
- No fuerza estados — usa el mismo parser que el cron normal (`updateOrderTracking`)
- Solo admin puede acceder

### Cómo usar en producción

```bash
# Con límite default (150):
curl -X POST https://tu-app.vercel.app/api/admin/sync-imported-active-guides \
  -H "Content-Type: application/json" \
  -H "Cookie: [sesión admin]" \
  -d '{}'

# Con límite custom:
curl -X POST https://tu-app.vercel.app/api/admin/sync-imported-active-guides \
  -H "Content-Type: application/json" \
  -H "Cookie: [sesión admin]" \
  -d '{ "limit": 200 }'
```

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como admin
3. `curl -X POST http://localhost:3000/api/admin/sync-imported-active-guides -H "Content-Type: application/json" -H "Cookie: [sesión]" -d '{}'`
4. Verificar response: `summary.changed_status > 0` si había discrepancias
5. `by_old_status` vs `by_new_status` muestra exactamente cuánto cambió cada categoría
6. En Supabase: confirmar que `normalized_status` y `raw_status` de las guías cambiadas reflejan ahora el estado real de EFI

---

## FIX: Límite de importación aumentado a 500 guías (2026-05-17)

### Problema

El límite anterior de 200 guías bloqueaba la importación del archivo real de producción con 285 filas.

### Qué se hizo

| Archivo | Cambio |
|---|---|
| `src/app/api/admin/reconcile-efi-import/route.ts` | `IMPORT_MAX` 200 → 500. `maxDuration` 60 → 300. Sin cambios en lógica. |
| `src/app/(app)/efi-import/page.tsx` | Texto "Máximo 200 guías" → "Máximo 500 guías". Paso processing: agrega timer de segundos transcurridos + barra pulsante. Importa `useEffect` para el timer. |

### Rendimiento

El procesamiento es secuencial DB-only. 500 items × ~3 queries × ~5ms/query ≈ 7–30 segundos. El `maxDuration=300` da margen de sobra. No se necesitan chunks ni streaming.

### UX

El timer muestra segundos transcurridos y una estimación (`~Ns`) si el lote supera las 100 guías, evitando la sensación de congelado durante lotes grandes.

### Cómo probar

1. Preparar CSV con 285+ filas (el archivo real de producción)
2. `/efi-import` → arrastrar o pegar
3. Verificar que la previsualización muestra 285+ filas válidas (sin error de límite)
4. Click "Procesar N guías" → el timer sube cada segundo
5. Verificar el summary al finalizar

---

## FIX: Importación masiva de guías EFI — Paso 4 (2026-05-17)

### Problema

Con 70+ novedades y 30+ pedidos en reparto activos en EFI que no están vinculados en la app, la reconciliación manual guía por guía (endpoint individual) no escala. Se necesita un flujo automático que procese el export CSV de EFI en bulk.

### Qué se hizo

Se implementaron dos piezas:

1. **Endpoint `POST /api/admin/reconcile-efi-import`** — Reconciliación masiva DB-only (sin llamadas EFI). Acepta hasta 500 items, procesa secuencialmente, devuelve summary completo.
2. **UI en `/efi-import`** — Página admin con flujo de 4 pasos: subir/pegar CSV → previsualización → procesamiento → resultados detallados.

### Archivos creados/modificados

| Archivo | Cambio |
|---|---|
| `src/app/api/admin/reconcile-efi-import/route.ts` | **NUEVO.** `POST /api/admin/reconcile-efi-import`. Solo admin. DB-only (sin EFI calls). Hasta 500 items. Auto force_pending_match cuando hay exactamente 1 candidato pending con teléfono exacto. |
| `src/app/(app)/efi-import/page.tsx` | **NUEVO.** UI admin de 4 pasos: drag-drop o textarea CSV → auto-detect columnas → preview → procesar → resultados con tablas colapsables. |
| `src/components/layout/sidebar.tsx` | **MODIFICADO.** Añade `{ href: '/efi-import', label: 'Importar guías EFI', icon: Link2 }` en nav admin. |

### Endpoint `POST /api/admin/reconcile-efi-import`

**Auth:** 401 sin sesión · 403 para no-admin

**Body:**
```json
{
  "items": [
    { "tracking_number": "9000555918", "phone": "8098344999", "estado": "Novedad" },
    { "tracking_number": "9000555920", "phone": "8091234567", "estado": "En reparto" }
  ]
}
```

**Campos por item:**
- `tracking_number` — obligatorio
- `phone` — obligatorio
- `estado` — opcional (texto EFI: "Novedad", "En reparto", "En tránsito", etc.)
- `nombre` — opcional (para contexto, no se guarda en DB)
- `ciudad` — opcional (para contexto, no se guarda en DB)

**Límites:** máx 500 items por request · `maxDuration = 300`

**Lógica por item:**
1. Check si tracking ya está en otra orden → `already_assigned`
2. Normalizar teléfono (mismo algoritmo que reconcile-guide)
3. Buscar `confirmed + tracking=NULL + teléfono exacto`:
   - 1 match → asignar → `assigned`
   - 2+ matches → `multiple_candidates`
4. Si 0 confirmed: buscar `pending + tracking=NULL + teléfono exacto`:
   - 1 match → asignar + `confirmation_status='confirmed'` → `assigned_pending_forced`
   - 2+ matches → `multiple_candidates`
5. Si 0 en todo → `no_match`

**Qué actualiza en DB cuando asigna:**
- `tracking_number`
- `normalized_status` (mapeado del campo `estado`)
- `raw_status` = texto del estado (si se proveyó)
- `last_tracking_update` = now
- `last_novedad_at` = now (si estado es novedad)
- `confirmation_status = 'confirmed'` (solo en `assigned_pending_forced`)

**Mapeo estado EFI → normalized_status:**
| Texto EFI | normalized_status |
|---|---|
| En reparto | en_reparto |
| Novedad | novedad |
| En tránsito / Tránsito | in_transit |
| Generada | in_transit |
| Entregada | delivered |
| Devolución / Devuelta | returned |
| (cualquier otro) | in_transit |

**Response:**
```json
{
  "summary": {
    "total": 10,
    "assigned": 6,
    "assigned_pending_forced": 2,
    "already_assigned": 1,
    "multiple_candidates": 0,
    "no_match": 1,
    "errors": 0
  },
  "auto_assigned": [...],
  "needs_review": [...],
  "already_assigned": [...],
  "errors": [...]
}
```

### CSV auto-detección de columnas (actualizado 2026-05-17)

El parser normaliza cada header antes de comparar: minúsculas + sin acentos + `_` y `-` → espacio + espacios colapsados.
Resultado: `tracking_number`, `Tracking-Number`, `TRACKING NUMBER` → `"tracking number"` → match.

| Campo | Nombres reconocidos (normalizados) |
|---|---|
| Guía (tracking) | `tracking number` (de `tracking_number`), `tracking`, `guide number`, `guide`, `numero de guia`, `no. guia`, `# guia`, `guia`, `numero guia` |
| Teléfono | `phone`, `phone number`, `telefono`, `celular`, `movil`, `tel`, `cel`, `contacto` |
| Estado | `status`, `estado`, `estatus`, `novedad`, `ultima novedad` |
| Nombre | `customer name` (de `customer_name`), `customer`, `name`, `nombre del cliente`, `nombre`, `cliente`, `destinatario`, `receptor` |
| Ciudad | `city`, `ciudad`, `municipio` |

Columnas ignoradas sin error: `created_at`, `id`, `order`, `date`, `fecha`, etc.

**Detección de delimitador** — prueba en orden, usa el primero que produzca columnas reconocidas:
1. `TAB` — datos copiados desde Excel/tabla
2. `;` — CSV europeo / EFI histórico
3. `,` — CSV estándar
4. `espacios múltiples` — datos pegados desde terminal o vista web EFI

**Formatos aceptados (todos equivalentes):**
```
tracking_number,phone,status,customer_name,created_at      ← snake_case / coma
Guía;Teléfono;Estado;Destinatario;Ciudad                   ← EFI histórico / punto y coma
tracking_number[TAB]phone[TAB]status                       ← TAB (Excel)
tracking_number  phone  status  customer_name              ← espacios múltiples
```

### Seguridad / qué NO hace

- No llama a EFI (datos vienen del export)
- No crea registros nuevos en orders
- No modifica campos financieros
- No toca órdenes que ya tienen tracking
- Solo admin puede acceder
- Duplicado protegido: verifica `tracking_number` libre antes de asignar

### Cómo usar en producción

1. En EFI dashboard → exportar guías activas (Novedad + En reparto + Tránsito)
2. Copiar el CSV (con encabezados)
3. Ir a `/efi-import` en la app
4. Arrastrar el archivo CSV o pegar el contenido en el textarea
5. Revisar la previsualización (columnas detectadas, filas válidas)
6. Click "Procesar N guías"
7. Revisar resultados:
   - **Asignados** → ya están en DB con tracking y el cron los procesa en el próximo ciclo
   - **Requieren revisión** → múltiples candidatos o sin match → usar `/api/admin/reconcile-efi-guide` individual para los casos complejos
   - **Ya asignados** → ya estaban vinculados, ignorar
8. Opcional: re-importar el mismo CSV tras corregir teléfonos en los `no_match`

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como admin → sidebar → "Importar guías EFI"
3. Pegar un CSV de prueba con 2-3 guías
4. Verificar previsualización: columnas detectadas correctamente
5. Click "Procesar" → verificar summary
6. En Supabase: confirmar que las órdenes asignadas tienen `tracking_number` y `normalized_status` correctos
7. Esperar próximo ciclo del cron → órdenes deben aparecer en `/despachados`, `/novedad`, `/reparto` según estado

**Prueba con curl:**
```bash
curl -X POST http://localhost:3000/api/admin/reconcile-efi-import \
  -H "Content-Type: application/json" \
  -H "Cookie: [sesión admin]" \
  -d '{
    "items": [
      { "tracking_number": "9000555918", "phone": "8098344999", "estado": "Novedad" },
      { "tracking_number": "9000555920", "phone": "8091234567", "estado": "En reparto" }
    ]
  }'
```

---

## FIX: Asignación de guía EFI — Paso 1 y Paso 2 (2026-05-16)

### Qué se hizo

Cerrar la laguna estructural del despacho: antes no existía ningún mecanismo para guardar el número de guía EFI en DB una vez que el equipo la creaba fuera del sistema. Se implementaron dos piezas:

1. **Endpoint `PATCH /api/orders/[id]/assign-tracking`** — Guarda el tracking_number en DB y establece el estado inicial correcto para que el cron empiece a sincronizar.
2. **UI en `/confirmados`** — Reemplaza el botón cosmético "Listo para despacho" por un input de número de guía + botón "Asignar" real que llama al endpoint.

### Archivos creados/modificados

| Archivo | Cambio |
|---|---|
| `src/app/api/orders/[id]/assign-tracking/route.ts` | **NUEVO.** `PATCH /api/orders/[id]/assign-tracking`. Solo admin. Body: `{ tracking_number }`. Valida orden, estado confirmado, tracking_number NULL, guía sin duplicado. Actualiza tracking_number + normalized_status='in_transit'. |
| `src/app/(app)/confirmados/page.tsx` | **MODIFICADO.** Reemplaza estado `readyMap`/`markReady` por `trackingInputs`, `assigning`, `assignErrors` + función `assignTracking`. Columna Acción ahora tiene input de guía + botón Asignar con feedback de error inline y auto-remove de la fila al asignar. |

### Endpoint `PATCH /api/orders/[id]/assign-tracking`

**Auth:** 401 sin sesión · 403 para roles que no sean `admin`

**Body:**
```json
{ "tracking_number": "9001234" }
```

**Validaciones (en orden):**
1. User autenticado → 401
2. Rol admin → 403
3. `tracking_number` no vacío → 400
4. Orden existe → 404
5. `confirmation_status = 'confirmed'` → 422
6. `tracking_number IS NULL` en DB → 422
7. Guía no duplicada en otra orden → 422

**Update:**
- `tracking_number` = valor del body
- `normalized_status` = `'in_transit'` (entra a Q1 del cron en el próximo ciclo)

**Response exitosa:**
```json
{ "success": true, "order": { "id", "tracking_number", "normalized_status" } }
```

**Log:**
```
[assign-tracking] orderId=UUID tracking=9001234 assignedBy=UUID
```

### UI en `/confirmados`

- **Input:** campo de texto con placeholder "# Guía EFI". Ancho fijo `w-24`. Acepta Enter para disparar la asignación.
- **Botón "Asignar":** deshabilitado si el input está vacío o mientras está asignando. Muestra `Spinner` + "Asignando…" durante la llamada.
- **Error inline:** mensaje en rojo bajo el input si el endpoint devuelve error (ej: guía duplicada, pedido ya tiene guía).
- **On success:** la fila desaparece del listado (`setOrders(prev => prev.filter(o => o.id !== orderId))`). La orden ya tiene tracking_number y no pertenece a "sin guía".

### Flujo completo post-fix

```
Shopify webhook → orders (tracking_number=NULL, confirmed)
    ↓
Aparece en /confirmados
    ↓
Admin ingresa # guía EFI → PATCH /api/orders/[id]/assign-tracking
    ↓
DB: tracking_number='9001234', normalized_status='in_transit'
    ↓
Fila desaparece de /confirmados
    ↓
Cron Q1 la procesa en el próximo ciclo → sincroniza con EFI
```

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como **admin** → `/confirmados`
3. Elegir un pedido confirmado sin guía
4. Escribir el número de guía EFI en el input de la columna "Acción"
5. Presionar Enter o click "Asignar"
6. Verificar: la fila desaparece del listado
7. Verificar en Supabase: `orders` → `tracking_number` guardado, `normalized_status = 'in_transit'`
8. Esperar el próximo ciclo del cron → la guía debe aparecer en `/despachados` con estado actualizado de EFI

**Prueba de validaciones:**
- Input vacío → botón deshabilitado, no llama al endpoint
- Guía ya asignada a otro pedido → error inline: "La guía X ya está asignada al pedido #YYYY"
- Usuario no-admin → 403 (error inline visible)

---

## FIX: Reconciliación retroactiva de guías EFI — Paso 3 (2026-05-17)

### Qué se hizo

Guías activas en EFI que fueron creadas antes del fix de asignación no tienen ningún registro en DB. Para vincularlas con las órdenes confirmadas existentes sin crear registros duplicados ni modificar datos financieros, se implementaron dos endpoints:

1. **`POST /api/admin/reconcile-efi-guide`** — vincula una guía EFI individual a la orden correcta buscando por teléfono del cliente.
2. **`POST /api/admin/reconcile-efi-guides-batch`** — procesa hasta 20 guías a la vez, auto-asigna los matches únicos y devuelve candidatos/errores para revisión manual.

### Archivos creados

| Archivo | Cambio |
|---|---|
| `src/lib/admin/reconcile-guide.ts` | **NUEVO (actualizado 2026-05-17).** Lógica compartida: `normalizePhone()`, `reconcileEFIGuide()`. Consulta EFI en tiempo real, busca orden por teléfono normalizado, asigna tracking + estado EFI con todos los campos. Cuando `no_match`: devuelve `near_candidates` con diagnóstico extendido (2 queries paralelas). |
| `src/app/api/admin/reconcile-efi-guide/route.ts` | **NUEVO.** `POST /api/admin/reconcile-efi-guide`. Solo admin. Wraps `reconcileEFIGuide()` para un solo item. |
| `src/app/api/admin/reconcile-efi-guides-batch/route.ts` | **NUEVO.** `POST /api/admin/reconcile-efi-guides-batch`. Solo admin. Procesa hasta 20 items con 700ms de pausa entre EFI calls. `maxDuration=300`. |

### Endpoint single: `POST /api/admin/reconcile-efi-guide`

**Auth:** 401 sin sesión · 403 para no-admin

**Body:**
```json
{
  "tracking_number": "9000555913",
  "phone": "809-555-1234"
}
```

**Flujo interno:**
1. Verificar que `tracking_number` no esté ya en otra orden → `already_assigned` (422)
2. Consultar EFI en tiempo real → `efi_not_found` o `efi_error` si falla
3. Normalizar teléfono (strips non-digits, elimina prefijo +1/1 de 11 dígitos)
4. Query DB: `confirmation_status='confirmed'` + `tracking_number IS NULL` + `ilike customer_phone '%7digits%'`
5. Match exacto por teléfono normalizado en JS

**Outcomes posibles:**

| `outcome` | HTTP | Descripción |
|---|---|---|
| `assigned` | 200 | Match único → tracking asignado, estado EFI aplicado |
| `multiple_candidates` | 200 | 2+ órdenes confirmadas sin tracking con ese teléfono → requiere revisión manual |
| `no_match` | 200 | 0 matches exactos — incluye `near_candidates` para diagnóstico |
| `efi_not_found` | 200 | EFI no conoce la guía |
| `efi_error` | 502 | Fallo de red o HTTP al consultar EFI |
| `already_assigned` | 422 | La guía ya está en otra orden |

**`near_candidates` (solo cuando `no_match`):**

Dos queries paralelas de diagnóstico para entender por qué no hubo match exacto:

| `match_reason` | Qué significa |
|---|---|
| `phone_exact_any_status` | Teléfono exacto coincide, pero la orden no está `confirmed` o ya tiene tracking |
| `phone_partial_7dig` | Los últimos 7 dígitos coinciden (posible formato diferente en DB) |
| `confirmed_recent_30d` | Orden `confirmed + tracking NULL` de los últimos 30 días (cualquier teléfono) |

Todos incluyen: `order_number`, `customer_name`, `customer_phone`, `confirmation_status`, `normalized_status`, `tracking_number`, `created_at`, `match_reason`.

**Cuando `outcome='assigned'`, actualiza en DB:**
- `tracking_number`
- `normalized_status` (del EFI real; fallback `'in_transit'` si EFI devuelve `unknown`)
- `raw_status` (estado_actual de EFI)
- `delivery_attempts`
- `last_attempt_reason`
- `last_tracking_update` = now
- `tracking_history`, `tracking_novedades`, `shipment_created_at`, `last_novedad_at`, `status_since` (si EFI los provee)

**Response ejemplo:**
```json
{
  "outcome": "assigned",
  "tracking_number": "9000555913",
  "efi": {
    "found": true,
    "estado_actual": "En reparto",
    "normalized_status": "en_reparto",
    "attempts": 1
  },
  "assigned_order": {
    "id": "uuid",
    "order_number": "#8712",
    "customer_name": "Juan Pérez",
    "normalized_status": "en_reparto"
  }
}
```

**Response cuando `multiple_candidates`:**
```json
{
  "outcome": "multiple_candidates",
  "tracking_number": "9000555913",
  "efi": { ... },
  "candidates": [
    { "id": "uuid1", "order_number": "#8700", "customer_name": "...", "customer_phone": "...", "city": "...", "created_at": "..." },
    { "id": "uuid2", "order_number": "#8712", ... }
  ]
}
```

### Endpoint batch: `POST /api/admin/reconcile-efi-guides-batch`

**Auth:** 401 sin sesión · 403 para no-admin · `maxDuration = 300`

**Body:**
```json
{
  "items": [
    { "tracking_number": "9000555913", "phone": "8095551234" },
    { "tracking_number": "9000555914", "phone": "8295551234" }
  ]
}
```

**Límites:**
- Máx 20 items por request
- 700ms de pausa entre EFI calls (anti rate-limit)
- Procesamiento secuencial (no paralelo)

**Response:**
```json
{
  "summary": {
    "total": 5,
    "assigned": 3,
    "multiple_candidates": 1,
    "no_match": 0,
    "efi_not_found": 1,
    "efi_error": 0,
    "already_assigned": 0
  },
  "auto_assigned": [...],
  "needs_review": [...],
  "efi_issues": [...],
  "already_assigned": [...],
  "all_results": [...]
}
```

- `auto_assigned`: se asignaron automáticamente (outcome=assigned)
- `needs_review`: múltiples candidatos o no-match → requieren acción manual
- `efi_issues`: EFI no encontró la guía o falló la consulta
- `already_assigned`: la guía ya estaba vinculada a otra orden

### Normalización de teléfono

```
"809-555-1234"  → "8095551234"
"+1 809 555 1234" → "8095551234"
"18095551234"   → "8095551234"
"8095551234"    → "8095551234"
```

Comparación: últimos 7 dígitos en `ilike` DB + exacto en JS post-normalization. Tolerante a cualquier formato de almacenamiento en DB.

### Cómo usar en producción

**Flujo recomendado para reconciliar guías antiguas:**

1. Abrir EFI dashboard → copiar guías activas (En Reparto / Novedad / En Tránsito)
2. Para cada guía, buscar el cliente y su teléfono en EFI (campo Destinatario)
3. Ejecutar `POST /api/admin/reconcile-efi-guide` por guía

```bash
curl -X POST https://tu-app.vercel.app/api/admin/reconcile-efi-guide \
  -H "Content-Type: application/json" \
  -H "Cookie: [sesión admin]" \
  -d '{ "tracking_number": "9000555913", "phone": "8095551234" }'
```

4. Si `outcome=assigned` → listo, el cron la procesa en el próximo ciclo
5. Si `outcome=multiple_candidates` → revisar `candidates` y usar `/api/orders/[id]/assign-tracking` con el ID correcto
6. Si `outcome=no_match` → la orden puede estar bajo otro teléfono, cancelada, o fuera del sistema

**Batch para varios a la vez:**

```bash
curl -X POST https://tu-app.vercel.app/api/admin/reconcile-efi-guides-batch \
  -H "Content-Type: application/json" \
  -H "Cookie: [sesión admin]" \
  -d '{
    "items": [
      { "tracking_number": "9000555913", "phone": "8095551234" },
      { "tracking_number": "9000555914", "phone": "8295551234" }
    ]
  }'
```

### Seguridad / qué NO toca

- No crea registros nuevos en orders — solo vincula existentes
- No modifica campos financieros (`cod_amount`, estados de pago)
- No toca órdenes no-confirmadas ni órdenes ya con tracking
- Solo admin puede ejecutarlo
- Duplicado protegido: verifica `tracking_number` libre antes de asignar

---

## FIX: force_pending_match en reconcile-efi-guide (2026-05-17)

### Problema diagnosticado

Al reconciliar `tracking: 9000555918` + `phone: 8098344999`, el reconciliador devolvió `no_match`.

Los `near_candidates` mostraron la orden `#8838`:
- Teléfono exacto: `8098344999`
- `tracking_number = NULL`
- `confirmation_status = pending` ← razón del no_match: el filtro principal solo busca `confirmed`

La orden fue despachada en EFI por el equipo logístico sin haber sido confirmada en la app primero. En DB quedó en `pending` indefinidamente.

### Qué se hizo

Se añadió un mecanismo de asignación forzada seguro al endpoint `POST /api/admin/reconcile-efi-guide`.

Cuando la reconciliación normal produce `no_match` y el body incluye `"force_pending_match": true`, el sistema busca en los `near_candidates` si existe exactamente 1 candidato que cumpla **todas** estas condiciones:
- `match_reason = 'phone_exact_any_status'` (teléfono exacto, no solo 7 dígitos)
- `confirmation_status = 'pending'`
- `tracking_number = null`

Si se cumple, procede con la asignación y devuelve `outcome: 'assigned_pending_forced'`.

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/lib/admin/reconcile-guide.ts` | **MODIFICADO.** Nuevo outcome `assigned_pending_forced` en `ReconcileOutcome`. Nuevo param opcional `force_pending_match?: boolean`. Bloque de asignación forzada dentro del path `matched.length === 0`, después de construir `nearCandidates`. |
| `src/app/api/admin/reconcile-efi-guide/route.ts` | **MODIFICADO.** Lee `force_pending_match` del body (solo acepta `true` booleano estricto). Lo pasa a `reconcileEFIGuide()`. |
| `src/app/api/admin/reconcile-efi-guides-batch/route.ts` | **MODIFICADO.** `summary` ahora incluye `assigned_pending_forced: 0`. `autoAssigned` incluye ambos outcomes (`assigned` y `assigned_pending_forced`). Log actualizado. |

### Qué actualiza en DB cuando se dispara el fix

- `tracking_number` = guía EFI
- `normalized_status` = estado EFI real (fallback `in_transit` si EFI devuelve `unknown`)
- `raw_status` = `estado_actual` de EFI
- `confirmation_status` = `'confirmed'` ← cambia de `pending`
- `delivery_attempts`, `last_tracking_update`
- Campos opcionales si EFI los provee: `last_attempt_reason`, `tracking_history`, `tracking_novedades`, `shipment_created_at`, `last_novedad_at`, `status_since`

### Protecciones — qué NO hace

- No permite si hay 0 candidatos pending elegibles → cae al `no_match` normal
- No permite si hay 2+ candidatos pending elegibles → cae al `no_match` normal (ambigüedad)
- No permite si la guía ya está asignada a otra orden → `already_assigned` antes de llegar aquí
- No permite si la orden ya tiene tracking → filtrado por `tracking_number = null`
- No crea registros nuevos
- No toca EFI
- No toca campos financieros

### Cómo usar

```bash
# Intento normal (sin force):
curl -X POST https://tu-app.vercel.app/api/admin/reconcile-efi-guide \
  -H "Content-Type: application/json" \
  -H "Cookie: [sesión admin]" \
  -d '{ "tracking_number": "9000555918", "phone": "8098344999" }'
# → outcome: "no_match" + near_candidates muestra la orden #8838 con match_reason: "phone_exact_any_status"

# Con force (solo si near_candidates muestra exactamente 1 candidato pending):
curl -X POST https://tu-app.vercel.app/api/admin/reconcile-efi-guide \
  -H "Content-Type: application/json" \
  -H "Cookie: [sesión admin]" \
  -d '{ "tracking_number": "9000555918", "phone": "8098344999", "force_pending_match": true }'
# → outcome: "assigned_pending_forced"
```

**Flujo seguro recomendado:**
1. Llamar sin `force_pending_match` primero → verificar que `near_candidates` muestra exactamente 1 candidato con `match_reason: "phone_exact_any_status"`, `confirmation_status: "pending"`, `tracking_number: null`
2. Confirmar visualmente que la orden es la correcta (nombre del cliente, monto)
3. Repetir la llamada con `"force_pending_match": true`
4. Verificar `outcome: "assigned_pending_forced"` en la respuesta
5. El cron la procesa en el próximo ciclo

### Cómo probar

1. En Supabase: encontrar una orden con `confirmation_status='pending'` y `tracking_number=NULL`
2. Anotar su `customer_phone`
3. `POST /api/admin/reconcile-efi-guide` sin force → debe devolver `no_match` con `near_candidates` incluyendo esa orden
4. `POST /api/admin/reconcile-efi-guide` con `force_pending_match: true` → debe devolver `assigned_pending_forced`
5. Verificar en Supabase: la orden ahora tiene `tracking_number`, `confirmation_status='confirmed'`, `normalized_status` actualizado

---

## DIAGNÓSTICO GUÍA POR GUÍA: compare-efi-guides (2026-05-16)

### Problema actual

EFI dashboard muestra 33 en reparto + 76 en novedad + 10 tránsito + 24 generadas (~143 activas). La app muestra mucho menos. Necesitamos comparar guías reales de EFI contra nuestra DB para entender qué pasa con cada una.

### Endpoint: `POST /api/debug/compare-efi-guides`

Solo admin. Solo lectura — no modifica ningún dato.

**Archivo:** `src/app/api/debug/compare-efi-guides/route.ts`

**Body:**
```json
{
  "guides": ["9000123", "9000456", "..."],
  "fetch_efi": true
}
```

- `guides`: array de tracking numbers copiados del dashboard EFI (máx 50 para lookup DB; máx 20 primeras consultan EFI)
- `fetch_efi`: si `false`, solo hace lookup en DB sin consultar EFI (más rápido). Default: `true`

**Por cada guía responde:**
```typescript
{
  guide: string,
  exists_in_db: boolean,
  db: {
    id, order_number, tracking_number,
    normalized_status,   // ej. "returned", "delivered", "novedad"
    raw_status,          // texto congelado del último sync con EFI
    last_tracking_update,
    status_since,
    source, created_at
  } | null,
  cron: {
    enters_Q1: boolean,   // in_transit → cap 60
    enters_Q2: boolean,   // en_reparto → cap 50
    enters_Q3: boolean,   // novedad/pending/unknown → cap 50
    enters_Q4: boolean,   // returned/delivered < 21 días → cap 15
    excluded: boolean,
    exclusion_reason: string | null  // razón exacta si NO entra al cron
  },
  efi: {                 // solo si fetch_efi=true y dentro del cap de 20
    fetch_success: boolean,
    encontrado: boolean,
    raw_status_efi: string | null,       // lo que EFI muestra ahora mismo
    normalized_status_efi: string,       // normalizado por nuestro parser
    estado_global: string | null,
    attempts: number,
    last_attempt_reason: string | null,
    divergencia: {
      status_mismatch: boolean,
      db_status: string | null,
      efi_status: string,
      severity: 'none' | 'minor' | 'major',
      description: string   // descripción legible del problema
    }
  }
}
```

**Respuesta summary + critical_cases:**
```typescript
{
  generatedAt: string,
  guides_requested: number,
  efi_fetched: boolean,
  summary: {
    in_db: number,
    not_in_db: number,                          // CRÍTICO: EFI las tiene, DB no
    processed_by_cron: number,
    excluded_from_cron: number,
    major_divergences_efi_vs_db: number,        // DB=final, EFI=activo (el bug principal)
    minor_divergences_efi_vs_db: number,
    not_found_in_efi: number,
  },
  critical_cases: [                             // lista compacta de bugs detectados
    { guide, db_status, efi_status, enters_Q4, description }
  ],
  results: [...]
}
```

**Severidades de divergencia:**
| Severity | Condición | Significado |
|---|---|---|
| `none` | DB y EFI coinciden | Todo correcto |
| `minor` | Ambos activos, status diferente | El cron debería sincronizar pronto |
| `major` | DB=final, EFI=activo | **Bug: orden atrapada permanentemente** |
| `major` | DB=activo, EFI=final | El cron la actualizará en el próximo run |
| `major` | No existe en DB | EFI la tiene, nosotros no |

**Análisis Q1/Q2/Q3/Q4 exacto:**
| Q | Filter | Cron lo procesa |
|---|---|---|
| Q1 | `normalized_status = 'in_transit'` | ✅ cap 60 |
| Q2 | `normalized_status = 'en_reparto'` | ✅ cap 50 |
| Q3 | NOT IN (in_transit, en_reparto, delivered, returned, cancelled) | ✅ cap 50 — novedad, pending, unknown |
| Q4 | IN (returned, delivered) + last_tracking_update ≥ 21 días atrás | ✅ cap 15 |
| EXCLUIDA | cancelled siempre | ❌ nunca procesada |
| EXCLUIDA | returned/delivered con last_tracking_update < 21 días | ❌ fuera de ventana Q4 |
| EXCLUIDA | tracking_number IS NULL | ❌ cron no puede consultarla |
| NO EN DB | la guía no está en nuestra base de datos | ❌ cron no sabe que existe |

### Cómo usar

```bash
# Con curl (reemplazar con sesión válida de admin)
curl -X POST https://tu-app.vercel.app/api/debug/compare-efi-guides \
  -H "Content-Type: application/json" \
  -H "Cookie: [sesión admin]" \
  -d '{
    "guides": ["9001234", "9005678", "9009012"],
    "fetch_efi": true
  }'

# Solo DB (sin consultar EFI, más rápido)
curl -X POST .../api/debug/compare-efi-guides \
  -d '{ "guides": ["9001234", ...50 más...], "fetch_efi": false }'
```

**Flujo de diagnóstico:**
1. Abrir EFI dashboard → copiar 15-20 tracking numbers de "En reparto" y "Novedad"
2. `POST /api/debug/compare-efi-guides` con `fetch_efi: true`
3. Revisar `summary.major_divergences_efi_vs_db` → cuántos casos críticos hay
4. Revisar `critical_cases` → lista compacta con razón exacta por guía
5. Para cada guía en critical_cases: revisar `cron.exclusion_reason` para entender exactamente por qué no es procesada
6. Revisar `summary.not_in_db` → si > 0, hay guías que EFI tiene pero nuestra DB no

### Límites y runtime

| Parámetro | Valor |
|---|---|
| `maxDuration` | 120 s |
| Guías para lookup DB | máx 50 |
| Guías que consultan EFI | máx 20 (primeras del array) |
| Tiempo estimado (20 guías EFI) | ~30-60 s |
| EFI timeout por guía | 10 s |

---

## FIX: Revalidación de finalizados recientes — Ronda 3 (2026-05-16)

### Problema confirmado (Escenario A)

`shopify30dReconcile.gap = 1` → webhook NO es el problema. El gap 59 vs 133 se debe a órdenes que EFI reactivó después de que el cron las marcó como `returned`/`delivered`. El cron nunca volvía a procesarlas. `reactivate-tracking` encontraba 0 sospechosas porque compara `raw_status` en DB (congelado al momento del último sync) contra patrones activos — pero si EFI dijo "Devuelto" al momento del sync, `raw_status` dice "Devuelto" y no hay nada que detectar.

### Fix implementado: Q4 Revalidación en el cron

Archivo modificado: `src/app/api/tracking/auto/route.ts`

Nuevo batch **Q4** agregado al final de `runTracking()`, después de Q1/Q2/Q3:

| Parámetro | Valor | Razón |
|---|---|---|
| Ventana temporal | 21 días | Captura reagendamientos sin tocar históricos reales |
| Límite por run | 15 órdenes | Runtime budget: 59 activas × 1.5 s + 15 finals × 1.5 s ≈ 110 s (< 300 s) |
| Statuses candidatos | `returned`, `delivered` | Solo estos (no `cancelled` — son finalizaciones intencionales) |
| Ordenamiento | `last_tracking_update ASC` | Más antiguas sin re-check primero |
| Mecanismo | Re-consulta EFI directamente | NO depende de `raw_status` congelado en DB |

**Flujo de Q4 por orden:**
1. Consulta EFI → `updateOrderTracking(id, tracking_number, supabase, currentNormalizedStatus)`
2. Si EFI devuelve `unknown` → guard anti-unknown-overwrite conserva el estado final (sin cambio)
3. Si EFI confirma final (`returned`/`delivered`) → update idempotente (`last_tracking_update` actualizado, estado sin cambio)
4. Si EFI devuelve estado activo (`en_reparto`, `novedad`, `in_transit`, etc.) → **reactivación**: `normalized_status` actualizado + auto-task generado si corresponde + log `REACTIVATED`

### Constantes del cron (post-fix)

```typescript
const FINAL_STATUSES     = ['delivered', 'returned', 'cancelled']
const BATCH_SIZE         = 5
const BATCH_DELAY_MS     = 1_000
const REVALIDATION_DAYS  = 21   // ventana de revalidación
const REVALIDATION_LIMIT = 15   // máx por run para Q4
```

### Respuesta del cron (post-fix)

```typescript
{
  processed:  N,       // Q1/Q2/Q3 activas procesadas
  updated:    N,
  skipped:    N,
  failed:     N,
  revalidation: {
    checked:      N,   // cuántas finalizadas recientes se re-consultaron en EFI
    reactivated:  N,   // cuántas pasaron de returned/delivered → activo
    stayed_final: N,   // cuántas EFI confirmó como finales (idempotente)
    errors:       N,   // fallos de fetch EFI en revalidación
  }
}
```

### Logs de revalidación en Vercel

```
[vercel-cron][revalidation] queued=15 window=21d
[vercel-cron][revalidation] REACTIVATED guia=XYZ old=returned new=novedad
[vercel-cron][revalidation] checked=15 reactivated=3 stayed_final=12 errors=0
```

### Cómo probar el fix

1. Deploy a Vercel (o correr `POST /api/tracking/auto` con `x-cron-secret`)
2. En Vercel Logs buscar `[revalidation]`:
   - `queued=N` → cuántas finalizadas recientes encontró
   - `REACTIVATED` → reactivaciones detectadas
   - `checked=N reactivated=N stayed_final=N` → resumen
3. Verificar respuesta JSON del endpoint: campo `revalidation` presente
4. Después de 1-2 runs: `GET /api/debug/tracking-health` → `totalActiveOrders` debería aumentar si había guías reactivables
5. Comparar `GET /api/debug/active-universe` antes y después: `universeBreakdown.active_included_in_cron` debería acercarse a 133

### Protecciones anti-regresión

- `cancelled` nunca incluido en Q4 (finalizaciones intencionales)
- Órdenes > 21 días nunca tocadas (`.gte('last_tracking_update', d21ago)`)
- Guard anti-unknown-overwrite sigue activo → EFI returning `unknown` NO sobreescribe `returned`/`delivered`
- Si EFI confirma estado final → update idempotente, sin impacto operativo
- Límite 15/run → no hay riesgo de timeout

### Archivos creados/modificados — ronda 3

| Archivo | Cambio |
|---|---|
| `src/app/api/tracking/auto/route.ts` | **MODIFICADO.** Q4 revalidación agregada. Constantes `REVALIDATION_DAYS=21`, `REVALIDATION_LIMIT=15`. Respuesta JSON incluye `revalidation: { checked, reactivated, stayed_final, errors }`. |
| `src/app/api/debug/active-universe/route.ts` | **NUEVO.** Diagnóstico del universo activo. Ver sección anterior. |

---

## DIAGNÓSTICO: Universo activo del cron — Ronda 3 (2026-05-16)

### Problema

EFI muestra ~133 guías activas (24 tránsito + 28 reparto + 81 novedad). La app solo detecta 59 activas. `tracking-reconcile` mostró `withTracking.total=614, active=59, returned=282, delivered=273`. `reactivate-tracking` devolvió `processed=0, reactivated=0`. `missing_from_db=0` (solo para hoy).

### Conclusión principal: el bottleneck NO está en la query del cron

La query `runTracking()` en `/api/tracking/auto/route.ts` es estructuralmente correcta:

| Query | Filtro | Cap/run |
|---|---|---|
| Q1 | `normalized_status = 'in_transit'` + `tracking_number IS NOT NULL` | 60 |
| Q2 | `normalized_status = 'en_reparto'` + `tracking_number IS NOT NULL` | 50 |
| Q3 | `normalized_status NOT IN (in_transit, en_reparto, delivered, returned, cancelled)` + `tracking_number IS NOT NULL` | 50 |

Con solo 59 activas (< 160 cap total), el cron procesa **todas las 59 en cada run**. No hay exclusión accidental por límites, fecha, source, ni OR/AND incorrecto.

### Causa raíz del gap (59 vs 133)

El gap proviene de órdenes que **ya no son "activas" en la DB** pero EFI sí las considera activas. Tres escenarios en orden de probabilidad:

#### Escenario A (más probable): Finalizaciones que EFI reactivó — DB congelada

- 282 órdenes están en `returned` y 273 en `delivered` — excluidas permanentemente del cron.
- Si el courier reagendó una entrega o EFI corrigió un error, esas órdenes vuelven a "En reparto" en EFI.
- El cron NUNCA vuelve a sincronizar estados finales.
- **Bug crítico del `reactivate-tracking`:** busca raw_status en DB con patrones activos. Pero `raw_status` está CONGELADO al momento del último sync. Si EFI dijo "Devuelto" cuando el cron las procesó, raw_status es "Devuelto" — nunca será detectado como sospechoso aunque EFI ahora diga "En reparto".

#### Escenario B: Órdenes históricas faltantes en DB

- El reconcile original solo compara HOY vs Shopify. No cubre los 30 días anteriores.
- Si el webhook falló durante semanas antes del fix, esas órdenes están en EFI pero nunca llegaron a DB.

#### Escenario C: Ventana de reactivate-tracking demasiado estrecha

- `reactivate-tracking` usa `.gte('last_tracking_update', 7_days_ago)`. Órdenes finalizadas hace 8-30+ días no se revisan.

### Nuevo endpoint de diagnóstico

`GET /api/debug/active-universe` — creado 2026-05-16. Solo admin. Solo lectura.

Responde:
1. Simulación exacta de Q1/Q2/Q3 del cron con totales reales y muestra
2. Breakdown completo por normalized_status (cuántas incluidas/excluidas del cron por cada condición)
3. Distribución temporal de returned/delivered: cuántas se finalizaron en últimos 2/7/14/30/60 días
4. Muestra de returned/delivered últimos 30 días con raw_status visible (para inspección manual)
5. Reconcile Shopify extendido a 30 días (no solo hoy)
6. Diagnóstico resumido con causas priorizadas y pasos siguientes

```bash
GET /api/debug/active-universe
# Auth: sesión admin requerida
```

### Flujo de diagnóstico recomendado (Ronda 3)

1. **Correr `GET /api/debug/active-universe`** → ver `cronSimulation` (confirma que el cron procesa todo lo activo) y `finalStatusTimeline` (distribución temporal de finalizados)
2. **Si `shopify30dReconcile.gap > 0`** → Escenario B confirmado → correr `POST /api/admin/recover-shopify-orders` con `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }` para el rango afectado
3. **Tomar 10-20 tracking_numbers de `recentFinalSample.returned_last_30d`** → consultar manualmente en `effi.com.co/tracking/index/{guia}` → si EFI muestra estado activo, Escenario A confirmado
4. **Si Escenario A confirmado** → safe fix: ampliar ventana de `reactivate-tracking` a 21-30 días (no 7) + cambiar la lógica para re-consultar EFI en lugar de depender de `raw_status` en DB
5. **Si `finalStatusTimeline.returned.last_14d >> last_7d`** → Escenario C confirmado → ampliar ventana en reactivate-tracking

### Bug crítico identificado (pendiente de fix)

**`raw_status` en DB está congelado.** `reactivate-tracking` busca patrones activos en `raw_status` de DB, pero ese campo no cambia si el cron nunca re-sincroniza la orden (porque está en final status). La única forma de detectar si EFI reactivó una orden es **re-consultarla en EFI**, no confiar en raw_status de DB.

El fix propuesto (pendiente de confirmación con diagnóstico):
- En `reactivate-tracking` modo automático: en vez de filtrar por `raw_status`, tomar una muestra de returned/delivered recientes y re-consultarlos en EFI directamente
- Ampliar ventana de 7 a 21 días

### Archivos creados — ronda 3

| Archivo | Cambio |
|---|---|
| `src/app/api/debug/active-universe/route.ts` | **NUEVO.** `GET /api/debug/active-universe`. Solo admin. Diagnóstico completo del universo activo del cron: simula Q1/Q2/Q3, breakdown por status, distribución temporal de finalizados, muestras de raw_status, reconcile Shopify 30d. |

---

## DIAGNÓSTICO Y FIXES: Pipeline EFI → App — Ronda 2 (2026-05-15)

### Problema reportado (ronda 2)

Cron healthy (updatedLastHour=59), pero DB solo tiene 59 órdenes activas vs 133 en EFI (24 tránsito + 28 reparto + 81 novedad). El universo activo está incompleto. Shopify muestra 29 pedidos hoy pero app tiene 14.

### Causas identificadas — ronda 2

#### Causa A: Órdenes con tracking_number = null (excluidas del cron)

El cron tiene `.not('tracking_number', 'is', null)` en todas sus queries. Órdenes que llegaron por webhook de Shopify pero nunca recibieron su guía quedan en `normalized_status='pending'` y **nunca son procesadas por el cron aunque existan en DB**. El cron no puede actualizarlas porque no sabe la guía.

**Fix:** `GET /api/debug/tracking-reconcile` muestra `withoutTracking` — cuántas hay y de qué source. Solución manual: correr `POST /api/admin/recover-shopify-orders` para el rango de fechas.

#### Causa B: Órdenes en final status (returned/delivered) que deberían estar activas

Una vez que el cron marca una orden como `returned` o `delivered`, **no vuelve nunca a re-sincronizarla**. Si el parser EFI malclasificó el estado (e.g., "Cancelada temporaria" → `returned`), la orden queda atrapada para siempre.

**Fix:** `GET /api/debug/tracking-reconcile` muestra `suspectFinalizations` — returned/delivered recientes con raw_status activo. `POST /api/admin/reactivate-tracking` re-sincroniza estas órdenes forzando consulta a EFI sin el guard de status.

#### Causa C: Órdenes completamente faltantes en DB (webhook fallando)

Shopify tiene 29 órdenes hoy, app tiene 14. ~15 órdenes/día no están llegando a DB. Estas órdenes tienen tracking en EFI pero la app nunca las vio.

**Fix:** `GET /api/debug/tracking-reconcile` incluye `today.shopify` — llama a Shopify Admin API y compara con DB. Lista exacta de `missing_order_names`. Solución: correr `POST /api/admin/recover-shopify-orders` con `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`.

### Archivos creados/modificados — ronda 2

| Archivo | Cambio |
|---|---|
| `src/app/api/debug/tracking-reconcile/route.ts` | **NUEVO.** `GET /api/debug/tracking-reconcile`. Solo admin. Muestra universo completo: órdenes con tracking por status, sin tracking por source, final status sospechosos, comparativa vs Shopify Admin API hoy. |
| `src/app/api/admin/reactivate-tracking/route.ts` | **NUEVO.** `POST /api/admin/reactivate-tracking`. Solo admin. Re-sincroniza órdenes en final status con EFI. Sin body → auto-detecta returned recientes con raw_status activo. Con `{ order_ids: [...] }` → IDs específicos. |
| `src/app/api/orders/[id]/tracking/route.ts` | **MODIFICADO.** Pasa `normalized_status` actual a `updateOrderTracking` para activar el guard anti-unknown-overwrite. |

### Endpoint de reconciliación: `GET /api/debug/tracking-reconcile`

```typescript
{
  withTracking: {
    total: number,
    active: number,           // no delivered/returned/cancelled
    inFinalStatus: number,
    byStatus: [{ status, count }]
  },
  withoutTracking: {
    total: number,            // en DB pero cron no puede procesar
    pendingOnly: number,
    bySource: { shopify_webhook: N, csv_import: N },
    sample: [...]
  },
  finalStatus: {
    returned: N, delivered: N, cancelled: N
  },
  suspectFinalizations: {
    returned_with_active_raw: N,
    delivered_with_active_raw: N,
    returned_sample: [...],     // órdenes returned con raw activo → posible error del parser
    delivered_sample: [...]
  },
  unknownWithTracking: { count: N, sample: [...] },
  today: {
    db_webhook: N,
    db_csv: N,
    shopify: {
      shopify_orders_today: N,
      missing_from_db: N,
      missing_order_names: ['#8634', ...]
    }
  }
}
```

### Endpoint de reactivación: `POST /api/admin/reactivate-tracking`

```bash
# Auto-detectar returned sospechosos (últimos 7 días con raw_status activo)
POST /api/admin/reactivate-tracking
{}

# IDs específicos
POST /api/admin/reactivate-tracking
{ "order_ids": ["uuid-1", "uuid-2"] }
```

Respuesta:
```typescript
{
  processed: N,
  reactivated: N,   // normalized_status cambió
  failed: N,
  results: [{ id, tracking_number, old_status, new_status, success }]
}
```

### Flujo de diagnóstico recomendado

1. `GET /api/debug/tracking-reconcile` → ver breakdown completo
2. Si `withoutTracking.total > 0` → `POST /api/admin/recover-shopify-orders` con el rango de fechas
3. Si `suspectFinalizations.returned_with_active_raw > 0` → `POST /api/admin/reactivate-tracking`
4. Si `today.shopify.missing_from_db > 0` → correr recover-shopify-orders para hoy: `{ "from": "2026-05-15", "to": "2026-05-15" }`
5. Si `unknownWithTracking.count > 0` → revisar logs Vercel con `[efi-parser] guia=X UNKNOWN_STATUS`
6. Esperar 2-3 ciclos del cron y re-verificar con `GET /api/debug/tracking-health`

---

## DIAGNÓSTICO Y FIXES: Pipeline EFI → App — Ronda 1 (2026-05-15)

### Problema reportado

EFI mostraba 24 en tránsito / 28 en reparto / 81 novedad pero la app mostraba números incorrectos. Algunas guías nunca actualizaban. El pipeline se desincronizaba.

### Causas raíz identificadas

#### 1. CRÍTICO — Timeout del cron (causa principal)

`maxDuration = 60` era insuficiente. Con 160 órdenes (80+80), BATCH_SIZE=5, BATCH_DELAY=1500ms, cada ejecución solo procesaba ~40-65 órdenes antes de que Vercel matara la función. Las órdenes al final del lote nunca se sincronizaban. Órdenes recién-actualizadas (ordenadas al final por `last_tracking_update ASC`) quedaban perpetuamente sin procesar.

**Fix:** `maxDuration` subido a `300` (Vercel Pro soporta hasta 300s). BATCH_DELAY reducido a 1000ms.

#### 2. CRÍTICO — `en_reparto` sin prioridad propia

El cron tenía 2 queries: Q1 (in_transit, máx 80) y Q2 (todos los demás, máx 80). Con 80+ órdenes en `novedad`, las órdenes `en_reparto` eran desplazadas por novedades en Q2 y nunca procesadas.

**Fix:** Tres queries separadas: Q1 in_transit (60), Q2 en_reparto (50), Q3 otros (50). `en_reparto` tiene prioridad garantizada.

#### 3. CRÍTICO — `unknown` sobreescribía estado válido

Si EFI cambiaba HTML y el parser no extraía el estado, `normalized_status` se sobreescribía a `'unknown'`, destruyendo el estado anterior (una orden `en_reparto` quedaba como `unknown` y desaparecía de la pantalla de reparto).

**Fix:** Guard en `update-order.ts` — si nuevo status sería `unknown` pero el estado actual en DB es un estado real (`in_transit`, `en_reparto`, `novedad`, `delivered`, `returned`), se salta el update de status pero actualiza `last_tracking_update`.

#### 4. DIAGNÓSTICO — Logging cero

No había log de qué guía se procesó, qué devolvió EFI, qué se guardó en DB. Imposible depurar.

**Fix:** Logs detallados en `update-order.ts`:
- `[tracking] guia=X raw="..." normalized="..." attempts=N selector=...` (por guía actualizada)
- `[tracking] guia=X SKIP_UNKNOWN_OVERWRITE current_db="..." body_sample="..."` (guard activado)
- `[tracking] guia=X FETCH_ERROR="..."` / `EFI_HTTP_ERROR=N` (errores de red)
- `[tracking] guia=X DB_UPDATE_ERROR="..."` (errores de DB)
- `[efi-parser] guia=X UNKNOWN_STATUS ...` (parser no clasificó)
- `[efi-parser] guia=X estado_global="..." ...` (override de anulación)
- `[vercel-cron] queued: in_transit=N en_reparto=N others=N total=N`
- `[vercel-cron] processed=N updated=N skipped=N failed=N`

#### 5. Parser EFI — labels no cubiertos

`mapNormalizedStatus` no incluía labels que EFI puede usar actualmente:
- `en_reparto` faltantes: "Salió a entregar", "Asignado al mensajero", "Listo para entrega", "En distribución", "Con courier"
- `novedad` faltantes: "No se pudo entregar", "Intento fallido", "Intento de entrega", "Cliente ausente", "Sin receptor", "Fallida"
- `returned` faltantes: "cancelado"
- `delivered` faltantes: "Exitosa"
- `in_transit` faltantes: "En proceso", "Clasificado", "Procesado"

**Fix:** Labels adicionales añadidos a `mapNormalizedStatus` en `efi-parser.ts`.

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/lib/tracking/update-order.ts` | Guard anti-unknown-overwrite. Logging por guía (raw, normalized, attempts). Acepta `currentNormalizedStatus` como parámetro opcional. |
| `src/app/api/tracking/auto/route.ts` | `maxDuration` 60→300. BATCH_DELAY 1500→1000ms. Q2 separada en `en_reparto` (50) + others (50). Deduplicación de resultados. Log del resumen por run. Pasa `normalized_status` actual a `updateOrderTracking`. |
| `src/lib/tracking/efi-parser.ts` | 15+ labels adicionales en `mapNormalizedStatus`. Log `UNKNOWN_STATUS` cuando parser no puede clasificar. |
| `src/app/api/debug/tracking-health/route.ts` | **NUEVO.** Endpoint de salud del cron. Solo admin. |

### Endpoint de diagnóstico: `GET /api/debug/tracking-health`

Solo accesible para `admin`. Muestra:

```typescript
{
  cron: {
    health: 'healthy' | 'slow' | 'stalled',  // healthy=actualiz. última hora, slow=6h, stalled=>6h
    updatedLastHour: number,
    updatedLast6h: number,
    totalActiveOrders: number,
    maxPerCronRun: 160,
    cappedCapacity: boolean,         // true si totalActive > 160
    estimatedFullCycleMinutes: number
  },
  stale: {
    stale24h: number,   // activas sin sync en +24h
    stale48h: number,   // activas sin sync en +48h
    stale72h: number    // activas sin sync en +72h
  },
  parser: {
    nullRawStatus: number,    // EFI nunca respondió
    unknownStatus: number,    // parser falló en clasificar
    unknownSample: [...]      // guías con unknown (con tracking_number y body_sample)
  },
  byStatus: [{ status, count }],     // conteo por normalized_status
  stuckSamples: {
    in_transit_stuck48h: [...],
    en_reparto_stuck48h: [...],
    novedad_stuck48h: [...]
  }
}
```

### Nueva capacidad del cron (post-fix)

| Recurso | Antes | Después |
|---|---|---|
| `maxDuration` | 60s | 300s |
| BATCH_DELAY | 1500ms | 1000ms |
| Órdenes por run | ~50-65 (timeout) | ~160-200 (completo) |
| `en_reparto` en cada run | No garantizado | Garantizado (hasta 50) |
| Tiempo estimado para 160 órdenes | Timeout (60s) | ~130-200s (dentro de 300s) |

### Estrategia de diagnóstico para futuros problemas

1. Revisar `GET /api/debug/tracking-health` — muestra salud del cron, stale counts, unknown counts
2. Si `cron.health='stalled'` → verificar que Vercel Cron esté activo y CRON_SECRET esté en env vars
3. Si `parser.unknownStatus > 0` → revisar `parser.unknownSample` para ver body_sample y comparar con EFI real
4. Si `stale48h > 0` → revisar `stuckSamples` para ver qué guías están atascadas
5. Revisar logs Vercel para `[tracking] guia=X SKIP_UNKNOWN_OVERWRITE` — indica que el parser no está reconociendo el HTML de EFI
6. Si `cappedCapacity=true` → considerar reducir límites de batch o aumentar frecuencia del cron

### EFI URL

`https://effi.com.co/tracking/index/{tracking_number}` (con doble 'f' en effi). Verificar si EFI cambia dominio.

---

## FASE 5 — Módulo Devoluciones + Supervisor IA Operativo (2026-05-10)

### Qué se hizo

Módulo operativo `/devoluciones` completo para análisis, seguimiento, indemnizaciones y acciones en pedidos devueltos. Integrado con el Supervisor IA (nueva sección de métricas de devoluciones) y ciclo completo de alertas. Sin romper ningún módulo anterior.

### Archivos creados/modificados

| Archivo | Cambio |
|---|---|
| `supabase/migrations/024_return_review_status.sql` | **NUEVO.** Columna `return_review_status` en tabla `orders`. Valores: `pendiente_revision`, `revisado`, `escalado`, `reclamo_preparado`, `reclamado`, `descartado`. Índice parcial en `normalized_status='returned'`. |
| `src/middleware.ts` | **MODIFICADO.** Nueva constante `DEVOLUCIONES_PATHS = ['/devoluciones']`. Nueva variable `canSeeDevoluciones` (admin/ia_supervisor/novelty_agent). Bloquea `/devoluciones` para confirmation_agent, delivery_agent y roles menores — redirige a `/my-tasks`. |
| `src/components/layout/sidebar.tsx` | **MODIFICADO.** Icono `RotateCcw` importado. `/devoluciones` añadido a: `admin` (después de Novedades), `ia_supervisor` (después de Dashboard), `novelty_agent` (al final). Alert color `red` en los tres roles. |
| `src/app/api/devoluciones/route.ts` | **NUEVO.** `GET /api/devoluciones`. Roles: admin/ia_supervisor/novelty_agent. 7 queries paralelas de KPIs + query paginada de pedidos devueltos. Motor de scoring de indemnización determinístico (`calcCompensationScore`). Responde `{ data, kpis, montoReclamable, page, limit, generatedAt }`. `cod_amount` y `montoReclamable` solo visibles para admin/ia_supervisor. |
| `src/app/api/devoluciones/[id]/status/route.ts` | **NUEVO.** `PATCH /api/devoluciones/[id]/status`. Roles: admin/ia_supervisor/novelty_agent. Actualiza `return_review_status` + crea nota interna en tabla `notes`. |
| `src/app/api/devoluciones/[id]/note/route.ts` | **NUEVO.** `POST /api/devoluciones/[id]/note`. Roles: admin/ia_supervisor/novelty_agent. Inserta nota con timestamp RD + nombre del agente en tabla `notes`. |
| `src/app/(app)/devoluciones/page.tsx` | **NUEVO.** Módulo completo `/devoluciones`. Client Component. 10 tabs, 10 KPI cards, filtros avanzados, tabla desktop + cards mobile, modal de notas, selector de estado de revisión inline. |
| `src/app/(app)/supervisor-ia/page.tsx` | **MODIFICADO.** Importa `RotateCcw`. Nueva sección "Devoluciones" antes de Pagos Admin, con 4 cards de métricas + alerta de alta probabilidad de indemnización. |

### Módulo `/devoluciones`

**Ruta:** `/devoluciones`

**Visibilidad por rol:**

| Rol | Acceso |
|---|---|
| `admin` | ✅ Ve todo, incluyendo montos COD y monto reclamable |
| `ia_supervisor` | ✅ Ve todo, incluyendo montos COD y monto reclamable |
| `novelty_agent` | ✅ Ve devoluciones pero SIN montos COD ni monto reclamable |
| `confirmation_agent` | ❌ Redirigido a /my-tasks |
| `delivery_agent` | ❌ Redirigido a /my-tasks |

### KPIs (10 cards)

| Card | Dato |
|---|---|
| Devueltas hoy | `returned` actualizadas en el día RD |
| Devueltas ayer | `returned` actualizadas ayer en RD |
| Posible indem. | confidenceScore ≥ 30% |
| Alta prob. indem. | confidenceScore ≥ 65% |
| 3+ intentos | delivery_attempts ≥ 3 |
| SLA vencido +72h | status_since < now - 72h |
| Courier sospechoso | courierFlag = sospechoso \| posiblemente_falló |
| Reclamadas | return_review_status = reclamado |
| Pend. revisar | return_review_status IS NULL |
| Monto reclamable | SUM cod_amount de alta prob. (solo admin/ia_supervisor) |

Cada KPI card es clickeable y activa el tab correspondiente.

### Tabs (10 filtros)

| Tab key | Filtro |
|---|---|
| `todas` | Sin filtro adicional |
| `2-intentos` | delivery_attempts = 2 |
| `3mas-intentos` | delivery_attempts ≥ 3 |
| `posible-indemnizacion` | confidenceScore 30–64% (post-scoring) |
| `alta-indemnizacion` | confidenceScore ≥ 65% (post-scoring) |
| `devueltas-hoy` | updated_at en rango de hoy RD |
| `devueltas-ayer` | updated_at en rango de ayer RD |
| `courier-sospechoso` | courierFlag = sospechoso \| posiblemente_falló |
| `sla-vencido` | status_since < now - 72h |
| `reclamadas` | return_review_status = reclamado |

### Filtros adicionales

- Búsqueda: tracking_number, order_number, customer_name, customer_phone (ilike)
- Ciudad, Provincia (ilike)
- Fecha desde/hasta (created_at range)
- Intentos: 2 ó 3+

### Motor de scoring conservador (`calcCompensationScore`) — v2

Calcula `confidenceScore` (0–95%) para cada devolución. Determinístico, sin IA externa.

**Principio clave:** Alta probabilidad requiere ≥ 2 señales fuertes. 3+ intentos por sí solos NO son alta probabilidad. 4+ intentos indican buena gestión del courier y bajan el score.

#### Exclusiones (score=0, possibleCompensation=false, indemnCat='excluido')

| Condición detectada | Categoría |
|---|---|
| last_attempt_reason contiene cancel+cliente | `cliente_cancelo` |
| last_attempt_reason contiene rechaz/no quiso/no quería/no desea | `cliente_rechazo` |
| last_attempt_reason contiene tel/número + incorr/equivoc/erron | `tel_incorrecto` |
| last_attempt_reason contiene direcci/domicil + incorr/equivoc/erron/no exist | `dir_incorrecta` |
| last_attempt_reason contiene pide/solicit/pidió + devoluci/retorno | `cliente_solicito` |
| keyword de cobertura en reason/raw_status **Y** confirmation_status=no_coverage | `fuera_cobertura` |
| confirmation_status=no_coverage **Y** reason vacía | `fuera_cobertura` |

#### Señales a favor (positivas)

| Condición | Puntos | Tipo |
|---|---|---|
| delivery_attempts = 0 | +30 | **Fuerte** |
| hoursInStatus > 72h (SLA roto) | +25 | **Fuerte** |
| Devolución < 24h desde reparto (con intentos) | +20 | **Fuerte** |
| Cobertura dudosa (keyword presente, confirmation_status ≠ no_coverage) | +20 | **Fuerte** |
| Días desde creación > 10 | +15 | Media |
| Días desde creación > 7 | +10 | Media |
| Sin razón + 2+ intentos | +10 | Media |
| Dirección alegada (no confirmada incorrecta) | +10 | Débil |
| delivery_attempts = 2 | +8 | Débil |
| delivery_attempts = 3 | +5 | Débil |

#### Señales en contra (negativas — restan del score)

| Condición | Puntos | Señal |
|---|---|---|
| delivery_attempts ≥ 6 | -35 | Gestión muy extendida del courier |
| delivery_attempts ≥ 4 (y < 6) | -20 | Courier superó obligación estándar (3 intentos) |

#### Lógica de alta probabilidad

- Si `strongSignals < 2` → confidence se capa en 64% (nunca "alta probabilidad" automática)
- Alta probabilidad (`indemnCat='probable'`) requiere `confidence ≥ 65%` con ≥ 2 señales fuertes

#### `indemnCat` (categoría de indemnización)

| Valor | Condición |
|---|---|
| `excluido` | Exclusión detectada |
| `probable` | confidence ≥ 65% (requiere ≥ 2 señales fuertes) |
| `posible` | confidence 45–64% |
| `revisar_manual` | confidence 30–44% |
| `probablemente_no` | confidence < 30% ó 4+ intentos sin señales fuertes |

#### `compensationPriority`

- `critical`: confidence ≥ 80%
- `high`: 65–79%
- `medium`: 45–64%
- `low`: < 45%

#### `courierFlag`

- `sospechoso`: delivery_attempts=0 ó cobertura dudosa
- `posiblemente_falló`: strongSignals ≥ 1 con 2–3 intentos
- `sla_roto`: SLA roto +72h
- `sin_señales`: sin señales detectadas

#### `supervisorAnalysis` (análisis por caso)

Objeto generado determinísticamente por `generateSupervisorAnalysis()`:

```typescript
{
  resumen: string           // guía + cliente + intentos + ubicación + motivo
  senalesAFavor: string[]   // señales positivas detectadas
  senalesEnContra: string[] // señales negativas / exclusiones
  razonamiento: string      // explicación humanizada del veredicto
  recomendacion: string     // recomendación operativa final (con emoji)
  checklistEvidencia: string[] // 5 items de evidencia a revisar
}
```

### Botón "Preguntar al Supervisor IA"

Aparece como acción por fila (desktop y mobile). Abre `<SupervisorModal>` con:
- Resumen de la guía
- Confianza IA + categoría (badge)
- "Por qué podría indemnizar" (señales a favor con ✓)
- "Por qué podría NO indemnizar" (señales en contra con ✗)
- Razonamiento (en azul)
- Recomendación final (en ámbar)
- Checklist de evidencia pendiente

No consume IA externa — análisis 100% determinístico basado en los datos disponibles.

### Estados de revisión (`return_review_status`)

| Valor | Label UI | Quién puede asignar |
|---|---|---|
| `pendiente_revision` | Pendiente | Todos |
| `revisado` | Revisado | Todos |
| `escalado` | Escalado | Todos |
| `reclamo_preparado` | Reclamo listo | Todos |
| `reclamado` | Reclamado | Todos |
| `descartado` | Descartado | Todos |
| `no_indemnizable` | No indemnizable | Admin/ia_supervisor |
| `posible_reclamo` | Posible reclamo | Admin/ia_supervisor |
| `rechazado_courier` | Rechazado courier | Admin/ia_supervisor |
| `aprobado_courier` | Aprobado courier | Admin/ia_supervisor |

Seleccionables inline con `<select>` en cada fila (tabla desktop y card mobile).

### Monto potencial (no garantizado)

- KPI card: "Monto potencial" con sub "Alta prob. · referencia estimada"
- En fila: label "(ref.)" junto al monto
- Disclaimer visible debajo de los KPIs cuando monto > 0:
  `"* El monto potencial es referencia operativa — no garantiza aprobación del reclamo por parte del courier."`
- Solo visible para admin/ia_supervisor (novelty_agent nunca ve montos)

### Acciones operativas por devolución

| Acción | Cómo |
|---|---|
| Ver pedido | Link a `/orders/[id]` |
| Contactar por WA | Link `wa.me/` con mensaje pre-llenado |
| Agregar nota interna | Modal → `POST /api/devoluciones/[id]/note` |
| Cambiar estado de revisión | Select inline → `PATCH /api/devoluciones/[id]/status` |

### APIs

#### `GET /api/devoluciones`

**Auth:** 401 sin sesión · 403 para roles no permitidos

**Params:** `?page=N&filter=key&search=texto&city=&province=&from=ISO&to=ISO&intentos=2|3`

**Response:**
```typescript
{
  data: DevolucionItem[]           // máx. 50 por página
  kpis: {
    totalDevueltas, devueltasHoy, devueltasAyer,
    posiblesIndemnizaciones, altaProbabilidad,
    tresMasIntentos, slaVencido72h, courierSospechoso,
    reclamadas, pendientesRevisar
  }
  montoReclamable: number | null   // solo admin/ia_supervisor
  page: number
  limit: number
  generatedAt: string
}
```

Cada `DevolucionItem` incluye:
- Todos los campos de `orders` relevantes
- `score`, `signals`, `signalsFor`, `signalsAgainst`, `possibleCompensation`, `compensationReason`, `compensationPriority`
- `confidenceScore`, `lifecycleRisk`, `courierFlag`, `indemnCat`, `supervisorAnalysis`
- `cod_amount` solo si admin/ia_supervisor (undefined para novelty_agent)

#### `PATCH /api/devoluciones/[id]/status`

Body: `{ status: 'pendiente_revision' | 'revisado' | 'escalado' | 'reclamo_preparado' | 'reclamado' | 'descartado' | 'no_indemnizable' | 'posible_reclamo' | 'rechazado_courier' | 'aprobado_courier' }`

Crea nota interna automáticamente con el cambio de estado.

#### `POST /api/devoluciones/[id]/note`

Body: `{ note: string }`

Inserta en tabla `notes` con timestamp RD y nombre del agente.

### Sección Devoluciones en `/supervisor-ia`

Nueva sección antes de Pagos Admin, visible si `auditoriaData` existe (requiere ser admin o ia_supervisor para ver montos):

- 4 cards: Total devueltas · Alta prob. indem. (con monto si admin) · Posible indem. · 3+ intentos
- Alerta prominente cuando `altaProb > 0`: "N devoluciones con alta probabilidad de indemnización. Revisar antes de cerrar el caso." con link a `/devoluciones?filter=alta-indemnizacion`
- Todas las cards son `<Link>` que navegan a `/devoluciones` con el filtro correspondiente

### Seguridad

- `cod_amount` y `montoReclamable` NO se envían a novelty_agent (undefined en response)
- Middleware bloquea `/devoluciones` para confirmation_agent, delivery_agent, viewer, agent
- API endpoints verifican rol antes de procesar
- novelty_agent puede trabajar devoluciones (revisar, escalar, preparar reclamo, agregar notas) pero NO ve montos

### Performance

- Paginación: máximo 50 registros por página
- KPIs calculados con 7 queries paralelas `Promise.all`
- Query principal con filtros DB-side para reducir transferencia
- Scoring calculado en runtime (no persiste en DB — permite retroalimentación inmediata)

### Migración requerida

```sql
-- Ejecutar en Supabase SQL Editor:
ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_review_status text DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_return_review_status ON orders(return_review_status) WHERE normalized_status = 'returned';
```

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como **admin** → `/devoluciones` → ver sidebar con "Devoluciones" (icono RotateCcw rojo)
3. Verificar KPIs cargados: Devueltas hoy, Alta prob. indem., 3+ intentos, etc.
4. Verificar que cards son clickeables y activan el tab correspondiente
5. Click tab "3+ intentos" → ver devoluciones con 3+ intentos — **ninguna con fuera-cobertura confirmado debe aparecer como Alta**
6. Click tab "Alta prob. indem." → **solo deben aparecer casos con ≥ 2 señales fuertes reales**
7. Validar caso con 9+ intentos → badge debe ser "Prob. no indemnizable" o "Revisar manualmente", NO "Alta probabilidad"
8. Validar caso con fuera-de-cobertura confirmado (reason+confirmation_status=no_coverage) → badge "Excluida", confidence=0%
9. En cada fila: verificar señales a favor/contra, priority badge, confidence %, monto "(ref.)" si admin
10. Click "Supervisor IA" → modal abre con análisis completo: señales, razonamiento, recomendación, checklist
11. Cambiar estado de revisión con el select → incluye "No indemnizable", "Rechazado courier", "Aprobado courier"
12. Click "Nota" → modal → escribir nota → guardar → nota guardada
13. Click "WA" → abre WhatsApp con mensaje pre-llenado
14. Click "Ver" → navega a `/orders/[id]`
15. Verificar KPI "Monto potencial" (antes "Monto reclamable") + disclaimer visible debajo
16. Login como **ia_supervisor** → `/devoluciones` → ver módulo (con montos + disclaimer)
17. Login como **novelty_agent** → `/devoluciones` → ver módulo SIN montos (cod_amount: undefined, sin KPI monto)
18. Login como **confirmation_agent** → sidebar NO muestra Devoluciones → redirige a `/my-tasks`
19. Login como **delivery_agent** → mismo resultado que confirmation_agent
20. Login como **admin** → `/supervisor-ia` → scroll → sección "Devoluciones" visible
21. `npx tsc --noEmit` → sin errores

---

## FASE 4 — Vista admin: Rendimiento y pagos sugeridos en `/supervisor-ia` (2026-05-10)

### Qué se hizo

Nueva sección "Rendimiento y pagos sugeridos" en `/supervisor-ia`, visible **solo para admin** (invisible para agentes e ia_supervisor). Consume el endpoint `GET /api/admin/agent-payments` y muestra análisis completo de pagos, scoring y recomendaciones por agente.

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/app/(app)/supervisor-ia/page.tsx` | **MODIFICADO.** Nuevos tipos: `PaymentBreakdownItem`, `AgentPaymentData`, `AgentPaymentsResponse`. Nuevos icons: `Users`, `Award`, `X`, `TrendingDown`, `Banknote`. Nuevos helpers: `RECOM_META`, `PAY_LEVEL_STYLE`, `ROL_LABEL`, `agentMetrics()`, `generatePaymentInsights()`. Nuevo estado: `paymentsData`, `paymentsLoading`, `isAdmin`, `selectedAgent`, `payFiltroRol`, `payFiltroNivel`. Nuevo callback `fetchPayments`. Nueva sección JSX con cards, filtros, tabla, drawer de detalle e insights. |

### Sección "Rendimiento y pagos sugeridos"

**Visibilidad:** Se detecta automáticamente — si `GET /api/admin/agent-payments` devuelve 200, se muestra; si devuelve 403, no se muestra. No requiere pasar el rol como prop.

**Cards resumen (8):**
| Card | Dato |
|---|---|
| Pago total sugerido | `totalPago` del endpoint |
| Agentes activos | `agents.length` |
| Mejor score | `max(agents.score)` |
| Agentes en riesgo | count de nivel Riesgo + Deficiente |
| Entregas atribuidas | sum de breakdown con resultado entregado |
| Recuperaciones | sum de breakdown con resultado recuperado |
| Devoluciones atribuidas | sum de breakdown con resultado devuelto |
| Costo/entrega | totalPago ÷ totalEntregas |

**Filtros:**
- Por rol: Todos / confirmation_agent / novelty_agent / delivery_agent
- Por nivel: Todos / Excelente / Bueno / Riesgo / Deficiente

**Tabla principal (desktop) / Cards (mobile) — columnas:**
Agente · Rol · Score · Nivel · Entregados · Recuperados · Devueltos · F.Cob/Crít. · Pago sugerido · Recomendación IA · "Ver detalle →"

**Recomendaciones IA (badges coloreados):**
| Código | Label UI | Color |
|---|---|---|
| `pagar_completo` | Pagar completo | Verde |
| `pagar_con_bono` | Pagar con bono | Esmeralda |
| `revisar` | Revisar antes de pagar | Ámbar |
| `posible_sobrepago` | Posible sobrepago | Rojo |

**Drawer de detalle por agente:**
- Score + nivel + pago sugerido
- Métricas: entregados, recuperados, devueltos, F.Cob/Crít.
- Explicación humanizada del pago
- Coaching IA (reglas determinísticas según nivel + métricas)
- Breakdown monetario privado con link a cada pedido (`/orders/[id]`)

**Insights del Supervisor IA — Pagos (`generatePaymentInsights`):**
Función determinística que genera hasta 5 insights basados en:
- Agente con mejor score
- Agentes con alta recuperación → sugerencia de bono
- Agentes en Riesgo/Deficiente → coaching recomendado
- Tasa de devoluciones > 15% → alerta rentabilidad
- Agentes en posible_sobrepago → alerta de revisión
- Agentes sin actividad pagable

### Privacidad y seguridad

| Rol | `/api/admin/agent-payments` | Sección UI |
|---|---|---|
| `admin` | ✅ 200 — ve todo | ✅ Visible |
| `ia_supervisor` | ❌ 403 | ❌ No visible |
| `confirmation_agent` | ❌ 403 | ❌ No visible |
| `novelty_agent` | ❌ 403 | ❌ No visible |
| `delivery_agent` | ❌ 403 | ❌ No visible |

Los agentes **NO** ven montos, scores de pago ni breakdown monetario. La sección nunca aparece en `/mi-rendimiento`.

### Cómo probar permisos

1. `npm run dev` en `control-cod-app/`
2. Login como **admin** → `/supervisor-ia` → scroll al final → aparece sección "Rendimiento y pagos sugeridos"
3. Login como **ia_supervisor** → `/supervisor-ia` → sección **NO aparece**
4. Login como **confirmation_agent** / **novelty_agent** / **delivery_agent**:
   - Redirige a `/my-tasks` (middleware) → sección nunca se ve
   - Llamar `GET /api/admin/agent-payments` directamente → 403
5. Login como **admin** → sección muestra agentes, cards resumen y tabla
6. Filtrar por rol (Confirmación/Novedad/Reparto) → tabla se actualiza
7. Filtrar por nivel (Excelente/Bueno/Riesgo/Deficiente) → tabla se actualiza
8. Click "Ver detalle →" → drawer desde la derecha con breakdown monetario
9. Click en `ExternalLink` en el drawer → navega a `/orders/[id]`
10. Verificar que `/mi-rendimiento` no muestra ningún monto ni pago
11. `npx tsc --noEmit` → sin errores

---

## FASE 3 — Separación rendimiento vs. pagos: agentes no ven dinero (2026-05-10)

### Decisión estratégica

Los agentes **NO deben ver** montos en RD$, fórmula de pago, pago estimado, ni breakdown monetario.
El objetivo es mantenerlos enfocados en rendimiento, score, calidad y progreso — sin ansiedad ni desmotivación por montos diarios.

El admin **SÍ tiene acceso privado** a pagos estimados, breakdown monetario, fórmula, rentabilidad y recomendación de pago.

### Qué se hizo

1. Eliminados de `/mi-rendimiento` (los 3 componentes de agentes): tarjeta "Pago estimado", columna "Pago", textos RD$, reglas de pago visibles, "Sistema experimental".
2. El endpoint público `/api/my-performance/score` ya **no expone** `paymentEstimate` ni `pago` en los items de breakdown. El cálculo interno se conserva pero no se envía al cliente.
3. Agregada sección motivacional a los 3 componentes: barra de progreso al siguiente nivel, logros semanales, metas operativas.
4. Creado endpoint admin `GET /api/admin/agent-payments` — solo accesible para `admin` (403 para agentes e ia_supervisor).
5. Las reglas monetarias quedan privadas en la lógica interna del servidor.
6. `npx tsc --noEmit` → sin errores.

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/app/api/my-performance/score/route.ts` | `BreakdownItem` ya no tiene `pago`. `ScoreData` ya no tiene `paymentEstimate`. Se exporta `BreakdownItemInternal` (con `pago`) para uso del admin endpoint. Coaching sin menciones de RD$. |
| `src/components/rendimiento/RendimientoConfirmacion.tsx` | Eliminadas: tarjeta "Pago estimado", columna Pago, DollarSign, totalPago. Agregado: `LevelProgressCard` con barra de progreso, logros y metas. BreakdownTable → "Historial operativo" sin columna de pago. |
| `src/components/rendimiento/RendimientoNovedad.tsx` | Igual que Confirmacion, adaptado a métricas de novedad. |
| `src/components/rendimiento/RendimientoReparto.tsx` | Igual que Confirmacion, adaptado a métricas de reparto. |
| `src/app/api/admin/agent-payments/route.ts` | **NUEVO.** `GET /api/admin/agent-payments`. Solo admin (403 para otros). Calcula paymentEstimate + breakdown con pago + score + recomendación por agente. |

### Endpoint `/api/my-performance/score` — response agente (sin dinero)

```typescript
{
  role:      'confirmation_agent' | 'novelty_agent' | 'delivery_agent'
  score:     number          // 0–100
  level:     'Excelente' | 'Bueno' | 'Riesgo' | 'Deficiente'
  metrics:   Record<string, number | null>
  breakdown: Array<{
    orderId: string, orderNumber: string | null, customerName: string | null,
    resultado: string, reason: string    // SIN pago
  }>
  coaching:  string[]
  trends:    { ... }
}
```

### Endpoint `/api/admin/agent-payments` — solo admin

**Auth:** 401 sin sesión · 403 para roles que no sean `admin`

```typescript
{
  generatedAt: string
  totalPago:   number           // RD$ total estimado de todos los agentes
  nota:        string           // disclaimer experimental
  agents: Array<{
    agentId: string, agentName: string | null, role: string
    score: number, level: string
    paymentEstimate: number     // RD$ total estimado para este agente
    breakdown: Array<{
      orderId, orderNumber, customerName, resultado,
      pago: number,             // RD$ por pedido
      reason: string
    }>
    recomendacion: 'pagar_completo' | 'pagar_con_bono' | 'revisar' | 'posible_sobrepago'
    explicacion: string         // "Pago de RD$X sugerido por: N entregas, N recuperaciones..."
  }>
}
```

**Lógica de recomendación:**
| Level | paymentEstimate | Recomendación |
|---|---|---|
| Excelente | > RD$500 | pagar_con_bono |
| Excelente | ≤ RD$500 | pagar_completo |
| Bueno | cualquiera | pagar_completo |
| Riesgo | cualquiera | revisar |
| Deficiente | cualquiera | posible_sobrepago |

**Limitación conocida:** Las órdenes de `confirmation_agent` no tienen `agent_id` en la tabla `orders`, por lo que el pago de confirmación se computa como pool global. Si hay múltiples confirmation_agents, todos muestran el mismo total.

### Reglas monetarias privadas (solo servidor)

#### confirmation_agent
| Resultado | Pago |
|---|---|
| Entregado | +RD$25 |
| Recuperado + entregado | +RD$35 |
| Confirmado pero devuelto | +RD$5 |
| Sin respuesta al courier | +RD$10 |
| Fuera cobertura / Cancelado | RD$0 |

#### novelty_agent
| Resultado | Pago |
|---|---|
| Entregado | +RD$25 |
| Recuperado + entregado | +RD$35 |
| 2+ intentos trabajados | +RD$10 |
| Devuelto trabajado | +RD$5 |

#### delivery_agent
| Resultado | Pago |
|---|---|
| Entregado | +RD$25 |
| Recuperado + entregado | +RD$35 |
| Seguimiento activo (contactado) | +RD$10 |
| Devuelto | +RD$5 |

### Sección motivacional en `/mi-rendimiento`

Reemplaza la tarjeta "Pago estimado". Muestra:
- **Barra de progreso** al siguiente nivel (Deficiente→Riesgo→Bueno→Excelente con thresholds 60/75/90)
- **"X pts para nivel Y"** — cuánto falta para subir
- **Logros semanales** — badges dinámicos según métricas (Alta entrega, Sin devoluciones, Alta recuperación, Mejorando, etc.)
- **Metas operativas** — objetivos adaptados al nivel actual y métricas débiles

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como `confirmation_agent` → `/mi-rendimiento`
   - **NO aparece** tarjeta "Pago estimado"
   - **NO aparece** columna "Pago" en historial
   - **NO aparece** ningún texto "RD$"
   - **SÍ aparece** barra de progreso al siguiente nivel
   - **SÍ aparece** logros semanales (si los hay)
   - **SÍ aparece** metas operativas (si aplican)
3. Repetir con `novelty_agent` y `delivery_agent` → misma validación
4. Login como `admin` → llamar `GET /api/admin/agent-payments`
   - Respuesta 200 con `agents[]`, `paymentEstimate`, `breakdown` con pago, `recomendacion`
5. Login como `confirmation_agent` → llamar `GET /api/admin/agent-payments`
   - Respuesta 403 "Solo admins pueden ver pagos de agentes"
6. Repetir 403 con `novelty_agent` y `delivery_agent`
7. `npx tsc --noEmit` → sin errores

---

## SUPERVISOR IA — Comunicación directa con agentes: SupervisorFloatingAssistant (2026-05-10)

### Qué se hizo

Primera versión de comunicación directa del Supervisor IA con los agentes operativos. El Supervisor aparece como un botón flotante en la esquina inferior derecha de la pantalla, visible solo para agentes (`confirmation_agent`, `novelty_agent`, `delivery_agent`). Al hacer click abre un panel lateral con alertas, prioridades y coaching personalizados por rol, basados en métricas reales de la DB. Cada alerta es clickeable y lleva al módulo exacto.

### Archivos creados/modificados

| Archivo | Cambio |
|---|---|
| `src/app/api/supervisor-ia/agent-feed/route.ts` | **NUEVO.** Endpoint `GET /api/supervisor-ia/agent-feed`. Solo para agentes (401/403 para admin/ia_supervisor). Tres funciones de construcción: `buildConfirmationFeed`, `buildNoveltyFeed`, `buildDeliveryFeed`. Queries paralelas en Supabase. Devuelve `{ role, generatedAt, alerts, priorities, coaching }`. |
| `src/components/supervisor/SupervisorFloatingAssistant.tsx` | **NUEVO.** Componente client-side con botón flotante, overlay y panel lateral deslizable. Auto-fetch al montar + refresh cada 5 min. Badge con contador de alertas. Cierre con Escape o click en overlay. |
| `src/app/(app)/layout.tsx` | **MODIFICADO.** Importa y renderiza `<SupervisorFloatingAssistant role={role} />` después de `<main>`. Solo se activa internamente si el rol es agente. |
| `src/lib/supervisor/confirmation-feedback.ts` | **MODIFICADO.** `SupervisorFeedback` interface añade `href?: string`. Todos los items del generador incluyen `href: '/confirmacion'`. |
| `src/lib/supervisor/novelty-feedback.ts` | **MODIFICADO.** Igual — `href?: string` + `href: '/novedad'` en cada item. |
| `src/lib/supervisor/reparto-feedback.ts` | **MODIFICADO.** Igual — `href?: string`. Items con `href` específico: críticos → `/reparto?filter=critical`, resto → `/reparto`. |
| `src/components/rendimiento/RendimientoConfirmacion.tsx` | **MODIFICADO.** `SupervisorSection` ahora muestra botón "Ver casos →" (indigo) cuando `item.href` existe. |
| `src/components/rendimiento/RendimientoNovedad.tsx` | **MODIFICADO.** Igual — botón "Ver casos →" (rojo). |
| `src/components/rendimiento/RendimientoReparto.tsx` | **MODIFICADO.** Igual — botón "Ver casos →" (ámbar). |

### API: `GET /api/supervisor-ia/agent-feed`

**Auth:** Supabase session + check de rol. 401 sin sesión. 403 para admin/ia_supervisor.

**Respuesta:**
```typescript
{
  role:        'confirmation_agent' | 'novelty_agent' | 'delivery_agent',
  generatedAt: string,   // ISO timestamp
  alerts:      AgentAlert[],    // críticas y warnings urgentes
  priorities:  AgentAlert[],    // prioridades del día
  coaching:    AgentAlert[]     // contexto y sugerencias operativas
}

interface AgentAlert {
  id:       string
  severity: 'info' | 'warning' | 'critical'
  title:    string
  message:  string
  count?:   number
  href?:    string
}
```

### Reglas por rol

#### confirmation_agent
| Alerta | Severidad | Href |
|---|---|---|
| Pedidos +24h sin confirmar | critical | `/confirmacion` |
| Reintentos pendientes | warning/info | `/confirmacion` |
| Pedidos nuevos | info | `/confirmacion` |
| Carritos abandonados pendientes | warning/info | `/carritos-abandonados?status=pending` |
| Sin cobertura | info | `/confirmacion` |

#### novelty_agent
| Alerta | Severidad | Href |
|---|---|---|
| Novedades con 2+ intentos | critical/warning | `/novedad?filter=2-intentos` |
| Novedades +14 días | critical | `/novedad` |
| Generadas críticas +48h | critical | `/transito?tab=generadas` |
| Novedades +7 días | warning | `/novedad` |
| Tránsito crítico +48h | warning | `/transito?tab=transito` |
| Novedades activas total | info | `/novedad` |
| Posibles indemnizaciones | warning | `/supervisor-ia#indemnizaciones` |

#### delivery_agent
| Alerta | Severidad | Href |
|---|---|---|
| Reparto crítico +48h | critical | `/reparto?filter=critical` |
| Reparto en riesgo 24–48h | warning | `/reparto?filter=risk` |
| Total en reparto | info | `/reparto` |
| Entregados hoy | info | `/reparto` |

### SupervisorFloatingAssistant — comportamiento

- **Posición:** `fixed bottom-6 right-6 z-40` — esquina inferior derecha
- **Botón:** Bot icon + "Supervisor IA" (label oculto en mobile) + badge contador
- **Badge rojo:** cuando hay alertas críticas → botón se vuelve rojo
- **Panel:** `fixed right-0 top-0 h-full w-80` — desliza desde la derecha
- **Overlay:** `bg-black/30` detrás del panel — click cierra
- **Cierre:** botón ✕ en header, tecla Escape, o click en overlay
- **Auto-refresh:** cada 5 min via `setInterval`. Timestamp visible en sub-header del panel.
- **Secciones del panel:** Alertas / Prioridades del día / Coaching (cada una se oculta si está vacía)
- **Estado vacío:** Icono CheckCircle2 verde + "Todo en orden"

### Integración Mi rendimiento — sugerencias accionables

Los 3 componentes de rendimiento ahora muestran un botón "Ver casos →" junto a cada recomendación del Supervisor IA cuando tiene `href`. El botón es del color del módulo (indigo/rojo/ámbar según el componente).

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como `confirmation_agent` → ver botón flotante "Supervisor IA" esquina inferior derecha
3. Click en el botón → panel lateral desliza desde la derecha
4. Verificar: alertas correctas con conteos reales (pedidos +24h, reintentos, carritos)
5. Click en "Ver casos" → navega al módulo correcto con filtro aplicado
6. Esperar 5 min o click "Actualizar" → datos se refrescan
7. Login como `novelty_agent` → alertas diferentes (novedades 2 intentos, generadas críticas, etc.)
8. Login como `delivery_agent` → alertas de reparto crítico y en riesgo
9. Login como `admin` → NO aparece el botón flotante
10. Login como `ia_supervisor` → NO aparece el botón flotante
11. Ir a `/mi-rendimiento` como cualquier agente → sugerencias del Supervisor IA tienen botón "Ver casos →" clickeable
12. `npx tsc --noEmit` → sin errores

---

## SUPERVISOR IA — Devoluciones indemnizables auditables (2026-05-10)

### Qué se hizo

Card "Devoluciones indemnizables" completamente auditable y clickeable. La card abre una sección expandida con lista detallada, lógica de falsos positivos, razón principal IA, confidence score, señales, filtros y acciones.

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/app/api/supervisor-ia/auditoria/route.ts` | **MODIFICADO.** 4 nuevas funciones: `detectFalsePositive`, `getIAReason`, `calcConfidenceScore`, `getIndemnCat`. Query 28 (returned + 2+ intentos, limit 120) para detalle auditeable. `casosIndemnizablesDetalle` en response con scoring + FP + iaReason + confidence. `dineroRiesgo` ampliado con `devolucionesAltamenteProbables`, `devolucionesPosibles`, `devolucionesExcluidasCount`. |
| `src/app/(app)/supervisor-ia/page.tsx` | **MODIFICADO.** Tipos `CasoIndemnizable`, `DineroRiesgo` (3 campos nuevos), `AuditoriaData` (nuevo campo). 5 estados nuevos: `showIndemnDetalle`, `indemnFiltroNivel`, `indemnFiltroSignal`, `indemnRevisados`, `indemnEscalados`. Card "Devoluciones indemnizables" → button clickeable con chevron. Sección expandible con stats bar, filtros nivel+señal, tabla auditeable (11 columnas desktop, cards mobile), acciones por fila. Sección "Posibles indemnizaciones" reemplazada por anchor div para compatibilidad de links. |

### Lógica de falsos positivos (NO indemnizable si)

| Condición | Lógica |
|---|---|
| Cliente canceló explícitamente | `last_attempt_reason` contiene `cancel` + `cliente` / `client` |
| Cliente rechazó o no quiso recibir | `razón` contiene `rechaz` / `no quiso` / `no quería` |
| Teléfono / número incorrecto | `razón` contiene `tel`/`número` + `incorr`/`equivoc`/`erron` |
| Cliente solicitó devolución | `razón` contiene `pide`/`solicit`/`pidió` + `devoluci`/`retorno` |
| Fuera cobertura confirmado en origen | `confirmation_status = 'no_coverage'` + razón vacía + sin `cobertura`/`zona` |

Los casos excluidos como FP **no aparecen** en la lista. Se muestra un contador de excluidos.

### Confidence score (probabilidad indemnización)

```
confidence = min(95, round(score * 0.95 + 5))
```

| Rango confidence | Categoría | Descripción |
|---|---|---|
| 65–95% | altamente_probable | Alta probabilidad de reclamo válido |
| 30–64% | posible | Riesgo moderado, requiere verificación |
| 0–29% | excluido | No recomendado como caso indemnizable |

El score 0 → 5%, score 50 → 52%, score 76 → 77%, score 90 → 91%, score 95 → 95%.

### Razones principales IA (iaReason)

| Condición | Texto mostrado |
|---|---|
| 3+ intentos + Posible intento falso | "3 intentos con documentación insuficiente" |
| 3+ intentos (sin señal FP) | "3 intentos fallidos sin entrega documentada" |
| Señal Fuera cobertura dudoso | "Cobertura posiblemente válida según zona" |
| Razón contiene dirección/domicilio | "Reprogramación por dirección — verificar si era correcta" |
| Señal Reprogramación sospechosa | "Reprogramación sospechosa sin justificación" |
| Retraso excesivo + Courier falló | "Novedad prolongada antes de devolución" |
| Señal Courier falló | "Courier posiblemente inconsistente" |
| 2+ intentos (sin lo anterior) | "Múltiples intentos sin entrega exitosa" |
| 0 intentos | "Devuelto sin ningún intento registrado" |
| Default | "Posible devolución injustificada" |

### Señales de auditoría (badges en la UI)

| Señal | Color | Filtro disponible |
|---|---|---|
| Posible intento falso | rojo | "3+ intentos" |
| Riesgo alto devolución injusta | rojo | — |
| Caso potencialmente indemnizable | naranja | — |
| Courier posiblemente falló | naranja | — |
| Cliente probablemente sí quería recibir | azul | — |
| Fuera cobertura dudoso | púrpura | "cobertura dudosa" |
| Retraso excesivo | ámbar | "+72h" |
| Reprogramación sospechosa | ámbar | — |

### Filtros en la sección de detalle

**Nivel:** Todos / Crítico / Alto / Medio / Bajo  
**Señal:** Todas / 3+ intentos / 2 intentos / +72h / cobertura dudosa

### Acciones por caso

- **Ver pedido** → `/orders/[id]`
- **Marcar revisado** → estado local UI (badge verde, fila opacada). Toggle.
- **Escalar** → estado local UI (badge naranja). Toggle. Arquitectura preparada para Fase 3.

### Separación altamente probables vs posibles

La stats bar muestra:
- Monto total (excluidos FP)
- Promedio por caso
- Altamente probables: `devolucionesAltamenteProbables` (conf ≥65%)
- Posibles: `devolucionesPosibles` (conf 30–64%)
- Excluidos: count de falsos positivos detectados

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como `admin` → `/supervisor-ia`
3. **Card clickeable:** En "Dinero en riesgo", click en "Devoluciones indemnizables" → sección se expande con tabla completa
4. **Filtros:** Click en Crítico/Alto/Medio/Bajo y señales filtra la tabla en tiempo real
5. **Razón IA:** Cada caso muestra texto descriptivo (no solo números)
6. **Señales:** Badges de colores según tipo de señal detectada
7. **Confidence %:** Badge con % de probabilidad de indemnización por caso
8. **Marcar revisado:** Click → fila se opaca + badge verde "Revisado"
9. **Escalar:** Click → badge naranja "Escalado"
10. **Ver pedido:** Link directo a `/orders/[id]`
11. **Falsos positivos:** Los casos excluidos NO aparecen; contador visible en header
12. **Stats bar:** Total, promedio, altamente probables vs posibles en tiempo real
13. `npx tsc --noEmit` → sin errores

### Query 28 (nueva)

```typescript
// returned + 2+ intentos, limit 120, todos los campos para auditoría
supabase.from('orders')
  .select('id, tracking_number, order_number, customer_name, customer_phone, ...')
  .eq('normalized_status', 'returned')
  .gte('delivery_attempts', 2)
  .order('delivery_attempts', { ascending: false })
  .limit(120)
```

Resultado en `casosIndemnizablesDetalle[]` ordenado por `confidenceScore DESC`.

---

## SUPERVISOR IA — Fase 2: Auditoría operativa, scoring, courier y agentes (2026-05-10)

### Qué se hizo

Implementación completa de la Fase 2 del Supervisor IA: motor de scoring de riesgo operacional, auditoría de casos sospechosos, score de gestión courier, score de agentes, y cards de dinero en riesgo. Sin IA externa — todo basado en reglas, señales y análisis interno de datos.

### Archivos creados/modificados

| Archivo | Cambio |
|---|---|
| `src/app/api/supervisor-ia/auditoria/route.ts` | **NUEVO.** Endpoint GET con 27 queries paralelas en Supabase. Devuelve `{ casosAuditoria, courier, agentes, dineroRiesgo }`. Motor de scoring server-side con función `calcRiskScore()`. Solo admin/ia_supervisor (403 para otros). |
| `src/app/(app)/supervisor-ia/page.tsx` | **MODIFICADO.** Nuevos tipos `CasoAuditoria`, `CourierMetrics`, `AgentesMetrics`, `DineroRiesgo`, `AuditoriaData`. Nuevo estado `auditoriaData`, `auditoriaLoading`, `showAuditoria`, `auditFiltroNivel`. Fetch paralelo a `/api/supervisor-ia/auditoria`. Recomendaciones mejoradas con señales de auditoría (`generarRecomendacionesV2`). 4 nuevas secciones de Fase 2. |

### API: `GET /api/supervisor-ia/auditoria`

**Auth:** Supabase session + check de rol (admin/ia_supervisor). 403 para otros roles.

**Estructura de respuesta:**

```typescript
{
  generatedAt: string

  casosAuditoria: Array<{      // ordered by score desc, max 80
    id, tracking_number, order_number, customer_name, city, province,
    delivery_attempts, last_attempt_reason, raw_status, normalized_status,
    status_since, cod_amount,
    score: number,             // 0–100
    level: string,             // 'Bajo' | 'Medio' | 'Alto' | 'Crítico'
    signals: string[],         // categorías de señales detectadas
  }>

  courier: {
    totalProcesados, entregados, devueltos, novedades, retrasos72h,
    intentosSospechosos, coberturaDudosa, anuladasSospechosas,
    tasaEntrega, tasaDevolucion, tasaRetraso72h, tasaNovedades  // en %
  }

  agentes: {
    confirmation: { confirmadosHoy, inalcanzablesTotal, canceladosTotal, pendientesEnCola, fueraCobertura }
    novedad:      { novedadesActivas, recuperadasHoy, dosIntentosActivos, masViejas14dias, indemnizacionesDetectadas }
    delivery:     { enRepartoTotal, entregadosHoy, repartoCritico48h, claimsRegistrados }
  }

  dineroRiesgo: {
    devolucionesIndemnizables: number   // SUM cod_amount WHERE returned + delivery_attempts >= 2
    pedidosEnRiesgoNovedad: number      // SUM cod_amount WHERE novedad + delivery_attempts >= 2
    repartoRetraso72h: number           // SUM cod_amount WHERE en_reparto + status_since < cutoff72h
    totalEnRiesgo: number               // suma de los tres anteriores
  }
}
```

### Motor de scoring (calcRiskScore — server-side)

Calcula score 0–100 para cada pedido sospechoso:

| Condición | Puntos | Señales generadas |
|---|---|---|
| `delivery_attempts >= 3` | +30 | Posible intento falso · Riesgo alto devolución injusta · Cliente probablemente sí quería recibir |
| `delivery_attempts >= 2` | +20 | Cliente probablemente sí quería recibir |
| `returned + delivery_attempts >= 2` | +20 | Caso potencialmente indemnizable · Riesgo alto devolución injusta |
| `returned + delivery_attempts == 0` | +25 | Riesgo alto devolución injusta · Courier posiblemente falló |
| `returned + delivery_attempts == 1` | +10 | Riesgo alto devolución injusta |
| `hoursStuck > 72h` | +20 | Retraso excesivo · Courier posiblemente falló (si en_reparto/in_transit/novedad) |
| `hoursStuck 48–72h` | +10 | Retraso excesivo |
| `last_attempt_reason` contiene `cobertura/zona` | +15 | Fuera cobertura dudoso · Courier posiblemente falló |
| `last_attempt_reason` contiene `direcci/domicil` | +10 | Reprogramación sospechosa |
| `novedad + 2+ intentos + sin razón` | +10 | Reprogramación sospechosa |
| `novedad + > 7 días` | +10 | Reprogramación sospechosa · Retraso excesivo |
| `confirmation_status = no_coverage` | +10 | Fuera cobertura dudoso |

**Niveles:**
- Bajo: 0–25 · Medio: 26–50 · Alto: 51–75 · Crítico: 76–100

**`hoursStuck`:** usa `status_since ?? shipment_created_at ?? shopify_created_at` (misma lógica que transit-helpers.ts, sin `last_tracking_update`)

### Categorías de señales

| Señal | Color | Cuándo aparece |
|---|---|---|
| Cliente probablemente sí quería recibir | azul | delivery_attempts >= 2 |
| Courier posiblemente falló | naranja | cobertura + retraso > 72h + returned sin intentos |
| Fuera cobertura dudoso | púrpura | razón contiene cobertura/zona OR no_coverage |
| Retraso excesivo | ámbar | status_since > 48h |
| Posible intento falso | rojo | delivery_attempts >= 3 |
| Reprogramación sospechosa | ámbar | sin razón + 2+ intentos OR > 7 días en novedad |
| Riesgo alto devolución injusta | rojo | returned + cualquier condición sospechosa |
| Caso potencialmente indemnizable | naranja | returned + delivery_attempts >= 2 |

### Score de gestión courier

Métricas globales de toda la operación. Sin segmentación por mensajero (Fase 3).

| Métrica | Verde | Amarillo | Rojo |
|---|---|---|---|
| % Entregas exitosas | ≥ 70% | 50–69% | < 50% |
| % Devoluciones | ≤ 5% | 6–15% | > 15% |
| % Novedades activas | ≤ 5% | 6–15% | > 15% |
| % Retrasos +72h | 0% | 1–5% | > 5% |

### Score de agentes (primera versión)

Sección `agentes` del dashboard con métricas operativas por rol. No incluye cálculo de pagos ni bonos.

| Agente | Métricas clave |
|---|---|
| `confirmation_agent` | confirmados hoy · en cola · inalcanzables · cancelados · fuera cobertura |
| `novelty_agent` | novedades activas · recuperadas hoy · casos críticos · +14 días · indemnizaciones |
| `delivery_agent` | en reparto · entregados hoy · crítico +48h · claims |

### Cards de dinero en riesgo

Cálculo server-side sumando `cod_amount` de los pedidos relevantes:
- **Devoluciones indemnizables:** returned + delivery_attempts >= 2
- **Novedades en riesgo:** novedad + delivery_attempts >= 2
- **Reparto retrasado +72h:** en_reparto + status_since < cutoff72h
- **Total en riesgo:** suma de los tres anteriores

### Nuevas secciones en `/supervisor-ia` (Fase 2)

| Sección | Qué muestra |
|---|---|
| **Dinero en riesgo** | 4 cards: devoluciones indemnizables · novedades en riesgo · reparto +72h · total en riesgo (en DOP) |
| **Auditoría Operativa IA** | Tabla de casos con score, nivel, señales, estado, intentos. Filtros por nivel (Todos/Crítico/Alto/Medio/Bajo). Cards colapsadas con conteos por nivel cuando está oculta. Máximo 50 desktop / 30 mobile. |
| **Score de gestión courier** | Tabla de métricas: % entrega · % devolución · % novedades · % retrasos. Codificación de color verde/amarillo/rojo. Fila adicional con señales absolutas (intentos sospechosos · cobertura dudosa · devoluciones sospechosas). |
| **Score operativo de agentes** | 3 columnas (confirmation/novelty/delivery). Cada columna con 4–5 métricas y codificación de color. Nota Fase 3 sobre coaching IA futuro. |

### Recomendaciones mejoradas (`generarRecomendacionesV2`)

Motor V2 que remplaza `generarRecomendaciones`. Añade detección de patrones de auditoría:
- Si hay casos Críticos → recomendación crítica "Evaluar reclamo de indemnización"
- Si `tasaDevolucion > 15%` → recomendación crítica "Revisar gestión courier"
- Si `retrasos72h > 0` → recomendación alta "Retrasos elevando riesgo devolución"
- Si `coberturaDudosa > 0` → recomendación alta "Verificar zonas fuera cobertura"
- Mensajes enriquecidos con contexto logístico COD

### Arquitectura coaching IA (preparada para Fase 3)

En la sección Score de Agentes se incluye un banner informativo que explica qué vendrá en Fase 3:
- Feedback individual a agentes
- Recomendaciones personalizadas
- Generación automática de tareas
- Seguimiento de patrones por agente

La estructura de datos ya está preparada (`agentes.confirmation`, `agentes.novedad`, `agentes.delivery`) y puede extenderse sin romper la API.

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como `admin` → ir a `/supervisor-ia`
3. **Cards Dinero en riesgo:** visible si hay devoluciones/novedades/reparto retrasado (valores en DOP)
4. **Auditoría Operativa IA:**
   - Cards colapsadas muestran conteo por nivel (Crítico/Alto/Medio/Bajo)
   - Click en "Crítico" → abre tabla filtrada solo por casos Críticos
   - Click "Ver N casos" → expande tabla completa
   - Filtros de nivel (Todos/Crítico/Alto/Medio/Bajo) filtran la tabla
   - Cada fila: score/nivel · guía · cliente · ciudad · estado · intentos · señales · link
5. **Score courier:** % entrega, % devolución, % novedades, % retrasos en colores semáforo
6. **Score agentes:** 3 columnas con métricas de cada tipo de agente
7. **Recomendaciones:** si hay casos Críticos en auditoría → aparece recomendación crítica "Evaluar reclamo"
8. Login como `confirmation_agent` → NO puede ver `/supervisor-ia` (redirige a /my-tasks)
9. `npx tsc --noEmit` → sin errores

### Pendientes Fase 3

- Guardar reportes diarios en tabla `supervisor_reports`
- Timeline detallado por guía (eventos con timestamps desde `order_history` o tracking_events)
- Separación de métricas courier por mensajero (requiere campo `carrier` consistente en orders)
- Score personal de agentes con historial y tendencias
- Coaching IA: feedback automático a agentes desde dashboard
- Envío de tareas automáticas a agentes
- IA externa (Claude API) para análisis de patrones complejos
- Alertas por WhatsApp al admin para casos Críticos
- Scoring salarial / bonos de agentes

---

## SUPERVISOR IA — Fase 2: Acciones clickeables y query params (2026-05-10)

### Qué se hizo

Mejora de `/supervisor-ia` para que todas las métricas, alertas y recomendaciones sean accionables: cada card, alerta y recomendación navega directamente al módulo correspondiente con filtro aplicado.

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/app/(app)/supervisor-ia/page.tsx` | **REESCRITO.** Cards KPI clickeables con `Link`. Alertas con botón de acción. Recomendaciones con botón estilizado por prioridad. Reporte del día con prioridades numeradas. Indemnizaciones con badge de prioridad, botón "Ver pedido" mejorado. `KpiCard` → `ClickableKpiCard`. `AlertaRow` añade botón por prioridad. `generarRecomendaciones` actualizado con links con query params. `generarReporte` ahora devuelve `{ resumen, prioridades[] }`. |
| `src/app/(app)/transito/page.tsx` | **MODIFICADO.** Importa `useSearchParams`. `activeTab` se inicializa desde `?tab=generadas\|transito\|anuladas`. Default: `'generadas'`. |
| `src/app/(app)/reparto/page.tsx` | **MODIFICADO.** `useSearchParams` ya existía. `activeTab` se inicializa desde `?filter=critical` → `'critico'` / `?filter=risk` → `'riesgo'`. Default: `'all'`. |
| `src/app/(app)/novedad/page.tsx` | **MODIFICADO.** `useSearchParams` ya existía. `activeTab` se inicializa desde `?filter=2-intentos` → `'dos'`. Default: `'all'`. |
| `src/app/(app)/carritos-abandonados/page.tsx` | **MODIFICADO.** Importa `useSearchParams`. `statusFilter` se inicializa desde `?status=pending\|recovered\|contacted\|no_answer\|discarded`. Default: `'all'`. |

### Cards clickeables — mapping

| Card | Href |
|---|---|
| Nuevos hoy | `/confirmacion` |
| Confirmados hoy | `/confirmados` |
| Entregados hoy | `/reparto` |
| Carritos recuperados | `/carritos-abandonados?status=recovered` |
| Novedades activas | `/novedad` |
| Reparto crítico +48h | `/reparto?filter=critical` |
| Tránsito crítico +48h | `/transito?tab=transito` |
| Generadas críticas +48h | `/transito?tab=generadas` |
| Fuera de cobertura | `/confirmacion` |

### Alertas clickeables — mapping

| Alerta | Link | Botón |
|---|---|---|
| Sin confirmar +24h | `/confirmacion` | "Ver casos" |
| Reparto +48h | `/reparto?filter=critical` | "Ver casos" |
| Tránsito +48h | `/transito?tab=transito` | "Ver casos" |
| Generadas +48h | `/transito?tab=generadas` | "Ver casos" |
| Novedad 2 intentos | `/novedad?filter=2-intentos` | "Resolver" |
| Novedad +14 días | `/novedad` | "Ver casos" |
| Novedad +7 días | `/novedad` | "Ver casos" |
| Guías anuladas | `/transito?tab=anuladas` | "Ver anuladas" |
| Posibles indemnizaciones | `#indemnizaciones` | "Ver casos" |
| Fuera de cobertura | `/confirmacion` | "Ir al módulo" |
| Carritos pendientes | `/carritos-abandonados?status=pending` | "Recuperar" |

### Query params soportados

| Módulo | Param | Valor → efecto |
|---|---|---|
| `/transito` | `?tab=` | `generadas` → tab Generadas / `transito` → tab En tránsito / `anuladas` → tab Anuladas |
| `/reparto` | `?filter=` | `critical` → tab Críticos +48h / `risk` → tab 1-2 días |
| `/novedad` | `?filter=` | `2-intentos` → tab 2 intentos |
| `/carritos-abandonados` | `?status=` | `pending\|recovered\|contacted\|no_answer\|discarded` → filtro de estado |

Query params inválidos o ausentes caen al estado default sin error.

### Reporte del día — nuevo formato

Ahora devuelve `{ resumen, prioridades[] }`. Las prioridades son una lista numerada ordenada por urgencia:
1. Guías +48h reparto/generadas (crítico)
2. Tránsito +48h (crítico)
3. Novedades 2 intentos (acción)
4. Sin confirmar +24h (acción)
5. Carritos pendientes (recovery)

### Indemnizaciones — mejoras

- Badge de **prioridad** (`Alta` / `Media`) calculado por intentos + razón
- Botón **"Ver pedido"** con icono, borde y hover (antes era solo texto)
- Mobile: badges agrupados (prioridad + intentos) en la misma fila

### Recomendaciones — mejoras

- Botón de acción estilizado por prioridad (rojo/naranja/ámbar/gris)
- Links usan query params: `?filter=critical`, `?tab=generadas`, `?filter=2-intentos`, `?status=pending`

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como `admin` → ir a `/supervisor-ia`
3. **Cards clickeables:** Click en "Reparto crítico +48h" → navega a `/reparto` con tab `+48h Crítico` activo
4. **Alertas:** Click en "Ver casos" de "Generadas +48h" → navega a `/transito` con tab `Generadas` activo
5. **Recomendaciones:** Click en botón rojo "Ver generadas críticas →" → `/transito?tab=generadas`
6. **Carritos pendientes:** Click en "Recuperar" → `/carritos-abandonados` con filtro `Pendiente` activo
7. **Novedad 2 intentos:** Click en "Resolver" → `/novedad` con tab `2 intentos` activo
8. **Indemnizaciones:** Click "Ver N casos" → tabla expandida con badge Prioridad y botón "Ver pedido"
9. **Reporte del día:** Si hay alertas críticas, ver lista numerada de prioridades
10. Query params inválidos (`/transito?tab=xyz`) → carga con tab default sin error
11. `npx tsc --noEmit` → sin errores

---

## SUPERVISOR IA — Fase 1 (2026-05-10)

### Arquitectura general

Módulo de supervisión operativa con dashboard ejecutivo para admin e ia_supervisor. Motor de reglas client-side que genera recomendaciones automáticas y alertas sin IA externa.

### Ruta

`/supervisor-ia`

### Permisos

| Rol                | Acceso     |
|--------------------|------------|
| `admin`            | ✅ Sí      |
| `ia_supervisor`    | ✅ Sí      |
| `confirmation_agent` | ❌ No — redirige a /my-tasks |
| `novelty_agent`    | ❌ No — redirige a /my-tasks |
| `delivery_agent`   | ❌ No — redirige a /my-tasks |
| `agent`            | ❌ No — redirige a /my-tasks |
| `viewer`           | ❌ No — redirige a /my-tasks |

### Archivos creados/modificados

| Archivo | Cambio |
|---|---|
| `src/app/api/supervisor-ia/metrics/route.ts` | **NUEVO.** 24 queries paralelas en Supabase. Devuelve `{ operacion, alertas, modulos, indemnizables, novedad2IntentosLista }`. Solo admin/ia_supervisor (403 para otros). |
| `src/app/(app)/supervisor-ia/page.tsx` | **NUEVO.** Dashboard ejecutivo Client Component. Auto-refresh cada 5 min. 7 secciones. Motor de recomendaciones client-side. |
| `src/components/layout/sidebar.tsx` | `/supervisor-ia` añadido a `admin` (posición 2, después de Dashboard) y como primera entrada de `ia_supervisor`. Icono `Brain`. |
| `src/middleware.ts` | Nueva constante `SUPERVISOR_PATHS = ['/supervisor-ia']`. Roles sin acceso redirigen a /my-tasks. `isSupervisor = role === 'admin' \|\| role === 'ia_supervisor'`. |

### API: `GET /api/supervisor-ia/metrics`

**Auth:** Supabase session + check de rol (admin/ia_supervisor). Devuelve 403 para otros roles.

**Estructura de respuesta:**

```typescript
{
  generatedAt: string,                    // ISO timestamp

  operacion: {
    nuevosHoy: number,                    // pedidos Shopify creados hoy (RD)
    confirmadosHoy: number,               // confirmados hoy (last_confirmation_attempt hoy RD)
    carritosRecuperadosHoy: number,       // abandoned_carts recovered hoy
    entregadosHoy: number,                // normalized_status='delivered' hoy
    novedadesActivas: number,             // normalized_status='novedad' total
    reparto48h: number,                   // en_reparto con criticidad +48h
    transito48h: number,                  // in_transit (no generadas) +48h
    generadas48h: number,                 // in_transit raw_status~generada +48h
    fueraCobertura: number,               // confirmation_status='no_coverage'
  },

  alertas: {
    sinConfirmar24h: number,              // pending + sin tracking + shopify_created_at < 24h atrás
    reparto48h: number,                   // = operacion.reparto48h
    transito48h: number,                  // = operacion.transito48h
    generadas48h: number,                 // = operacion.generadas48h
    novedad2Intentos: number,             // novedad + delivery_attempts >= 2
    novedad7dias: number,                 // novedad + status_since < 7 días (fallback updated_at)
    novedad14dias: number,                // novedad + status_since < 14 días
    guiasAnuladas: number,                // returned + raw_status~anulada/cancelada
    posiblesIndemnizables: number,        // returned + delivery_attempts >= 2 (count de la lista)
    fueraCobertura: number,               // = operacion.fueraCobertura
    carritosPendientes: number,           // abandoned_carts pending
  },

  modulos: {
    confirmacion: { nuevosHoy, confirmadosHoy, inalcanzables, cancelados, sinCobertura, pendientes24h },
    novedad:      { activas, recuperadasHoy, dosIntentos, mas7dias, mas14dias, posiblesIndemnizables },
    reparto:      { enReparto, criticos48h, entregadosHoy },
    transito:     { generadas, enTransito, criticas48h, anuladas },
    carritos:     { pendientes, contactadosHoy, recuperadosHoy, recuperadosTotal },
  },

  indemnizables: Array<{                  // returned + delivery_attempts >= 2, limit 50
    id, tracking_number, order_number, customer_name, customer_phone,
    city, province, delivery_attempts, last_attempt_reason, raw_status, cod_amount
  }>,

  novedad2IntentosLista: Array<{          // novedad + delivery_attempts >= 2, limit 50
    id, tracking_number, customer_name, city, delivery_attempts, last_attempt_reason, customer_phone, cod_amount
  }>,
}
```

**Criticidad temporal (reparto):** `status_since < cutoff48h OR (status_since IS NULL AND last_tracking_update < cutoff48h) OR (status_since IS NULL AND last_tracking_update IS NULL AND updated_at < cutoff48h)`

**Criticidad temporal (tránsito):** `status_since < cutoff48h OR (status_since IS NULL AND shipment_created_at < cutoff48h) OR (status_since IS NULL AND shipment_created_at IS NULL AND created_at < cutoff48h)`

### Secciones del dashboard

| Sección | Qué muestra |
|---|---|
| **Operación del día** | 9 KPIs: nuevos, confirmados, entregados, carritos recuperados, novedades activas, reparto +48h, tránsito +48h, generadas +48h, fuera cobertura |
| **Alertas críticas** | Lista de alertas clickeables con count y prioridad. Solo muestra si count > 0. |
| **Reporte del día** | Texto resumen auto-generado: actividad + alertas + prioridades |
| **Recomendaciones operativas** | Motor de reglas client-side: 8 reglas con prioridad (crítica/alta/media/baja), módulo, cantidad, mensaje, acción y link |
| **Rendimiento por módulo** | 5 cards: Confirmación, Novedad, Reparto, Tránsito, Carritos. Cada card con métricas clave y link al módulo. |
| **Posibles indemnizaciones** | Tabla expandible: guía, cliente, ciudad, intentos, razón, recomendación generada, link al pedido. |
| **Tareas sugeridas por agente** | 3 columnas (confirmation/novelty/delivery). Cada tarea muestra count de afectados con badge de color. |

### Motor de recomendaciones (client-side)

Función `generarRecomendaciones(metrics)` en la página. Genera objetos `{ id, prioridad, modulo, cantidad, mensaje, accion, link }` ordenados por prioridad:

| Condición | Prioridad | Módulo |
|---|---|---|
| `reparto48h > 0` | crítica | Reparto |
| `generadas48h > 0` | crítica | Tránsito · Generadas |
| `transito48h > 0` | crítica | Tránsito |
| `novedad14dias > 0` | alta | Novedad |
| `novedad2Intentos > 0` | alta | Novedad |
| `sinConfirmar24h > 0` | alta | Confirmación |
| `novedad7dias > 0` | media | Novedad |
| `carritosPendientes > 0` | media | Carritos abandonados |
| `fueraCobertura > 0` | baja | Confirmación |

### Reglas posibles indemnizaciones

Marcar como "Posible indemnización" si:
- `normalized_status = 'returned'` AND `delivery_attempts >= 2`

Recomendación generada (`getIndemnRecomendacion`):
- `>= 3 intentos` → "Reclamar por múltiples intentos fallidos sin entrega"
- `last_attempt_reason` contiene "cobertura/zona" → "Reclamar — área en cobertura pero no entregado"
- `last_attempt_reason` contiene "rechaz" → "Verificar — posible rechazo sin contacto previo"
- `last_attempt_reason` contiene "direcci/domicil" → "Verificar dirección y reclamar si fue correcta"
- Default → "Revisar historial y evaluar reclamo de indemnización"

No se toma ninguna acción automática. Solo alerta visual al admin.

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como `admin` → sidebar muestra "Supervisor IA" en segunda posición (icono Brain)
3. Navegar a `/supervisor-ia` → dashboard carga con métricas reales
4. Login como `ia_supervisor` → sidebar muestra "Supervisor IA" como primera entrada
5. Login como `confirmation_agent` → NO ve `/supervisor-ia` en sidebar; navegación directa redirige a `/my-tasks`
6. Login como `novelty_agent` → NO ve `/supervisor-ia` en sidebar
7. Login como `delivery_agent` → NO ve `/supervisor-ia` en sidebar
8. Verificar secciones: operación del día, alertas, reporte, recomendaciones, módulos, indemnizables, tareas sugeridas
9. Si hay guías +48h → aparecen en alertas (fondo rojo) y en recomendaciones (prioridad crítica)
10. Click en "Ver N casos" en indemnizaciones → expande tabla con detalles
11. Refresh manual con botón → datos se actualizan; auto-refresh cada 5 min
12. `npx tsc --noEmit` → sin errores

### Pendientes Fase 2 y Fase 3 (NO implementar ahora)

**Fase 2:**
- Guardar reportes diarios en tabla `supervisor_reports` (propuesta de schema en prompt original)
- Envío de tareas automáticas a agentes desde el dashboard
- Vista de rendimiento histórico por agente
- Productos/SKUs con mayor tasa de devolución

**Fase 3:**
- IA externa (OpenAI/Claude API) para análisis de patrones
- Reportes automáticos por WhatsApp a admin
- Scoring salarial / bonos de agentes
- Cálculo de pagos de comisión

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
| SD Delivery (mensajero local) | `/sd-delivery` | Módulo móvil-first para mensajeros del Gran Santo Domingo. Teal/esmeralda. Filtro de zona automático con `isSantoDomingoOrder`. Entrega inmediata en DB sin EFI. |
| Sidebar dinámico | `components/layout/sidebar.tsx` | Nav por rol desde `NAV_BY_ROLE`. Drawer en móvil, fija en desktop |
| Nav Shell | `components/layout/nav-shell.tsx` | Client Component: topbar hamburger (móvil) + overlay + estado open/close |
| Duplicados | webhook + `/orders/[id]` | Detecta por customer_phone en ventana 7 días |
| Parser EFI | `src/lib/tracking/efi-parser.ts` | Basado en divs `tracking-item/content`, fallback a tablas |
| Pipeline mini KPI | `components/shared/flujo-kpis.tsx` | Generadas activas → Tránsito activo → En reparto + chip Anuladas (en /novedad y /reparto) |
| Helpers de estado | `src/lib/order-status-helpers.ts` | `isCancelledGuide` / `isGeneratedActive` / `isTransitActive` — lógica compartida entre /transito, /novedad, /reparto y flujo-stats |
| Carritos abandonados | `/carritos-abandonados` + `/carritos-abandonados/[id]` | Recuperación de ventas COD. Lista con filtros + vista detalle por carrito. Fuentes: Draft Orders (principal), COD Form, Checkout nativo. Roles: admin + confirmation_agent. Sync manual. Badges cobertura + SD. Mensaje WA inteligente. Timeline operativo. Señales IA preparadas. |
| Alertas críticas | `src/lib/alert-helpers.ts` + `components/shared/alert-badges.tsx` | Duplicado + Fuera de cobertura en /confirmacion y /confirmados |

### APIs internas relevantes

| Endpoint | Qué hace |
|---|---|
| `GET /api/debug/shopify-webhook-ingestion` | **Debug** — requiere sesión. Muestra: total webhook hoy, últimos 30 pedidos, distribución por `confirmation_status` y `customer_confirmed`, conteo de cuántos de los últimos 30 serían visibles en `/confirmacion`. Fuente de verdad para diagnosticar si pedidos entran a DB. |
| `POST /api/admin/recover-shopify-orders` | **Solo admin.** Recupera pedidos faltantes por rango de fecha RD. Body: `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD", order_numbers?: ["#8522", ...] }`. Compara por `shopify_order_id`, inserta faltantes con `source='shopify_webhook'` + task de confirmación. Requiere `SHOPIFY_SHOP_DOMAIN` + `SHOPIFY_ADMIN_ACCESS_TOKEN`. |
| `POST /api/admin/recover-orders` | **Solo admin.** Versión directa para recuperación operativa. Body opcional: `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD" }` (default: 2026-05-03 completo). Llama a Shopify API 2026-04, inserta faltantes idempotentemente, crea tasks de confirmación. Devuelve `{ shopify_found, already_in_db, inserted, errors_count, errors }`. |
| `GET /api/confirmados` | Pedidos `confirmation_status='confirmed'`, filtros: `?filter=hoy\|ayer`, `?from=&to=` |
| `GET /api/flujo-stats` | Conteos pipeline corregidos: `generadas` (activas, sin anuladas), `in_transit` (sin generadas ni anuladas), `en_reparto` (sin anuladas), `anuladas` (count separado) |
| `GET /api/abandoned-carts` | Lista carritos abandonados con filtros (status, fecha, búsqueda). Devuelve `{ data, total, stats }`. Stats: pending/today/contactedToday/recovered. Roles: admin/ia_supervisor/confirmation_agent. |
| `GET /api/abandoned-carts/[id]` | Devuelve `{ cart, recoveredOrder? }`. `recoveredOrder` tiene `{ id, tracking_number, order_number }` si `recovered_order_id` existe. Roles: admin/ia_supervisor/confirmation_agent. |
| `POST /api/abandoned-carts/sync` | Sync paralelo: (1) `draft_orders.json?status=open+invoice_sent` (90 días) → fuente `shopify_draft_order` — **fuente principal en flujo COD**; (2) `checkouts.json?status=open` (30 días) → fuente `shopify_abandoned_checkout`. Upsert idempotente por su ID respectivo. Devuelve `{ drafts:{synced,new,updated,recovered}, checkouts:{synced,new,updated}, errors, draftScopeError? }`. Si falta scope `read_draft_orders` → `draftScopeError` con instrucción. |
| `POST /api/abandoned-carts/cod-form` | **Endpoint público** — llamado desde el tema Shopify cuando el cliente inicia el formulario COD pero no completa. Protegido por `x-cod-form-secret` header. Deduplicación por session_id (a) o phone+24h (b). Fuente: `cod_form_lead`. Requiere `customer_phone` o `customer_email`. |
| `PATCH /api/abandoned-carts/[id]/status` | Actualiza recovery_status + recovery_attempts + last_contacted_at. Body: `{ status, note? }`. Agrega nota de cambio si se provee. |
| `POST /api/abandoned-carts/[id]/note` | Agrega nota con timestamp + agente al campo notes (prepend). Preserva historial de notas. |
| `GET /api/dashboard` | Stats generales + `confirmed_hoy` + `confirmed_ayer` |
| `GET /api/novedad/performance` | Métricas agente novedad: trabajados, reprogramados, tasaRecuperación, **recuperadasHoy/Ayer** |
| `GET /api/reparto/performance` | Métricas agente reparto: entregados, contactados, críticos activos, **entregadosAyer** |
| `POST /api/reparto/orders/[id]/mark-delivered` | Registra entrega por agente. Solo admin/delivery_agent. No modifica normalized_status. Retorna `{ action_id, reported_at, courier_confirmed, pending_validation }` |
| `POST /api/sd-delivery/orders/[id]/mark-delivered` | Entrega local SD. Solo admin/santo_domingo_delivery_agent. Actualiza `normalized_status='delivered'` inmediatamente (sin EFI). Retorna `{ action_id, reported_at, local_confirmed: true, courier_confirmed: false }` |
| `GET /api/sd-delivery/performance` | Stats del mensajero SD autenticado: entregadosHoy/Ayer, contactadosHoy, noRespondenHoy, reprogramadosHoy. Zona RD (UTC-4). |
| `GET /api/reparto/entregados` | Pedidos entregados hoy+ayer. **Fuente 1 (principal):** `normalized_status='delivered'` con `last_tracking_update >= ayer`. **Fuente 2 (secundaria):** `agent_actions type='delivered'` sin confirmación EFI. Merge deduplicado, EFI toma precedencia. |
| `GET /api/novedad/recuperadas` | Pedidos recuperados hoy+ayer: via acción 'recovered' o via `follow_up_result IN (recovered,delivered)` con `normalized_status='delivered'` |

### Módulos activos — actualizaciones recientes

| Cambio | Fecha | Archivos |
|---|---|---|
| **Recuperados en /confirmados: API enriquece pedidos con `recovered_cart_id` + `recovered_cart_source` via JOIN secundario a `abandoned_carts`. Tarjeta "Recuperados de carrito" con count. Filtro `?filter=recuperados` server-side. Badge visual por tipo (Draft/COD Form/carrito). Fondo teal en filas recuperadas. Link "Ver carrito →" navega a `/carritos-abandonados/[id]`. Info banner contextual cuando el filtro está activo. `npx tsc --noEmit` limpio.** | 2026-05-10 | `api/confirmados/route.ts`, `(app)/confirmados/page.tsx` |
| **Carritos abandonados — Vista detalle `/carritos-abandonados/[id]`: nueva ruta + API GET. Datos cliente, producto, UTM, señales IA (placeholders), timeline de eventos, historial de notas. Acciones: cambio de estado, WA, llamar, nota. Mensaje WA inteligente según source y cobertura. Link "Ver orden" si recovered_order_id existe. Botón ojo (👁) en lista. npx tsc --noEmit limpio.** | 2026-05-10 | `api/abandoned-carts/[id]/route.ts` (nuevo), `(app)/carritos-abandonados/[id]/page.tsx` (nuevo), `(app)/carritos-abandonados/page.tsx` |
| **Carritos abandonados — Draft Orders como fuente principal COD: migración 023 agrega campos draft order (shopify_draft_order_id, name, draft_status, completed_at). Sync reescrito para traer draft_orders.json?status=open+invoice_sent en paralelo con checkouts. Auto-recover de drafts completados durante sync. Badge "Shopify Draft" (violeta) + nombre #D2256 en UI. Toast desglosado por fuente. Aviso si falta scope read_draft_orders.** | 2026-05-10 | `023_abandoned_carts_draft_orders.sql` (nuevo), `api/abandoned-carts/sync/route.ts` (rewrite), `types/index.ts`, `(app)/carritos-abandonados/page.tsx` |
| **Carritos abandonados — soporte COD form: migración 022 extiende tabla (shopify_checkout_id nullable, nuevos campos COD). Endpoint público `POST /api/abandoned-carts/cod-form` para leads parciales de formularios COD. Auto-recover por phone match en webhook orders/create. Badge de fuente (COD Form / Shopify / Manual) en UI. Info box en página explicando flujo COD. sync/route.ts ahora usa source='shopify_abandoned_checkout'. 0 checkouts en sync es esperado en flujo COD.** | 2026-05-10 | `022_abandoned_carts_cod_form.sql` (nuevo), `api/abandoned-carts/cod-form/route.ts` (nuevo), `api/webhooks/shopify/orders/route.ts`, `api/abandoned-carts/sync/route.ts`, `(app)/carritos-abandonados/page.tsx`, `types/index.ts` |
| **Módulo Carritos Abandonados: nuevo módulo /carritos-abandonados para recuperación ventas COD. Tabla abandoned_carts (migración 021). Sync desde Shopify `checkouts.json`. Badges cobertura y SD reutilizados. Mensaje WA pre-llenado con variantes por zona. Estados: pending/contacted/no_answer/recovered/discarded. Roles: admin + confirmation_agent. Mobile-first cards + tabla desktop.** | 2026-05-10 | `021_abandoned_carts.sql` (nuevo), `types/index.ts`, `api/abandoned-carts/route.ts` (nuevo), `api/abandoned-carts/sync/route.ts` (nuevo), `api/abandoned-carts/[id]/status/route.ts` (nuevo), `api/abandoned-carts/[id]/note/route.ts` (nuevo), `(app)/carritos-abandonados/page.tsx` (nuevo), `sidebar.tsx` |
| **Fix pipeline logístico /novedad y /reparto: queries corregidas en /api/flujo-stats para excluir anuladas/canceladas de Generadas e In_transit. Helper compartido `order-status-helpers.ts` con `isCancelledGuide`/`isGeneratedActive`/`isTransitActive`. FlujoKpis muestra chip "N anuladas". /transito usa `isCancelledGuide` del helper compartido.** | 2026-05-10 | `api/flujo-stats/route.ts`, `components/shared/flujo-kpis.tsx`, `lib/order-status-helpers.ts` (nuevo), `transito/page.tsx` |
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
| contiene "indemnizaci" | `indemnizacion` | **Evaluado PRIMERO** — antes de novedad |
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
| `santo_domingo_delivery_agent` | Mi rendimiento, Entregas SD |
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

### Pipeline logístico — Fix conteos /novedad y /reparto (2026-05-10)

**Problema:** El pipeline en `/novedad` y `/reparto` mostraba conteos incorrectos:
- Generadas: 19 (incluía guías viejas anuladas)
- En tránsito: 36 (incluía guías "Generada" que no son tránsito real)
- Realidad operativa Effi: ~1 generada activa, ~22 en tránsito real

**Causa raíz — `/api/flujo-stats`:**
```typescript
// ANTES (incorrecto):
.ilike('raw_status', 'generada')          // sin wildcards, sin excluir anuladas
.eq('normalized_status', 'in_transit')    // incluía generadas + anuladas con in_transit
```

**Fix — nuevas queries en `/api/flujo-stats`:**

| Métrica | Lógica nueva |
|---|---|
| **Generadas activas** | `tracking IS NOT NULL` + `raw_status ilike '%generada%'` + NOT anulad/cancelad + normalized_status NOT IN (returned,delivered,novedad,en_reparto) |
| **En tránsito activo** | `tracking IS NOT NULL` + `normalized_status='in_transit'` + NOT generada + NOT anulad + NOT cancelad |
| **En reparto** | `tracking IS NOT NULL` + `normalized_status='en_reparto'` + NOT anulad + NOT cancelad |
| **Anuladas** (nuevo) | `tracking IS NOT NULL` + `raw_status ilike '%anulad%'` + `raw_status ilike '%cancelad%'` (sum de 2 queries) |

**Helper compartido — `src/lib/order-status-helpers.ts` (NUEVO):**
```typescript
isCancelledGuide(o)   // raw_status contiene 'anulad' o 'cancelad'
isGeneratedActive(o)  // tracking + raw_status 'generada' + no cancelada + no terminal
isTransitActive(o)    // tracking + normalized='in_transit' + no generada + no cancelada
```
Usado en: `/transito/page.tsx` (via alias `isAnuladaRaw = isCancelledGuide`), disponible para `/novedad` y `/reparto`.

**FlujoKpis — cambios:**
- `FlujoStats` interface agrega campo `anuladas: number`
- Chip "N anuladas" aparece en el header del pipeline si `stats.anuladas > 0`
- Los 3 contadores principales (Generadas, En tránsito, En reparto) siguen el mismo diseño visual

**Cómo probar:**
1. `npm run dev` → login → `/novedad`
2. Verificar Pipeline logístico: Generadas ≈ 1, En tránsito ≈ 22, no ~19/36
3. Si hay anuladas → chip gris "N anuladas" aparece arriba a la derecha del pipeline
4. Mismos conteos en `/reparto` (mismo componente `<FlujoKpis />`)
5. `/transito` no se ve afectado (tiene su propia lógica de tabs client-side)
6. Comparar En tránsito del pipeline con el tab "En tránsito" de `/transito` → deben ser similares

**Archivos modificados:**

| Archivo | Cambio |
|---|---|
| `src/app/api/flujo-stats/route.ts` | Queries corregidas: 5 queries paralelas (generadas, in_transit, en_reparto, anuladas×2). Excluye anuladas/canceladas de activos. Retorna campo `anuladas`. |
| `src/components/shared/flujo-kpis.tsx` | Interface agrega `anuladas`. Chip informativo "N anuladas" si > 0. Import `Ban` de lucide. |
| `src/lib/order-status-helpers.ts` | **NUEVO.** 3 helpers compartidos: `isCancelledGuide`, `isGeneratedActive`, `isTransitActive`. |
| `src/app/(app)/transito/page.tsx` | Import `isCancelledGuide`. Alias local `isAnuladaRaw = isCancelledGuide` para consistencia. |

---

### Módulo Carritos Abandonados — /carritos-abandonados (2026-05-10, actualizado 2026-05-10)

**Propósito:** Recuperar ventas COD de clientes que iniciaron el formulario COD o el checkout Shopify pero no completaron la compra.

**Roles con acceso:** `admin`, `ia_supervisor`, `confirmation_agent`.
`novelty_agent` y `delivery_agent` no ven el link en el sidebar ni pueden llamar las APIs (403).

---

#### Fuente principal: Shopify Draft Orders (flujo COD/EasySell)

El flujo COD tipo EasySell **NO usa checkout nativo Shopify**. En su lugar, crea **Draft Orders** visibles en:
`Shopify Admin → Orders → Drafts` (ej. #D2256, #D2255, #D2254...)

Por eso `checkouts.json?status=open` devuelve 0 — esto es correcto y esperado.
El sync ahora descarga `draft_orders.json?status=open` + `status=invoice_sent` como fuente principal.

**Scope requerido en la Shopify App:** `read_draft_orders`
Si falta → la UI muestra un aviso amarillo con instrucciones.

---

#### Flujo de cada fuente

| Fuente | source en DB | Cómo llegan | Deduplicación |
|---|---|---|---|
| **Shopify Draft Orders** | `shopify_draft_order` | "Sync" → `draft_orders.json?status=open+invoice_sent` | `shopify_draft_order_id` (único condicional) |
| Shopify Checkout nativo | `shopify_abandoned_checkout` | "Sync" → `checkouts.json?status=open` | `shopify_checkout_id` (único condicional) |
| COD Form (endpoint) | `cod_form_lead` | Tema llama `POST /api/abandoned-carts/cod-form` | session_id (a) → phone+24h (b) |
| Manual | `manual_import` | INSERT directo (futuro) | — |
| Legacy | `shopify` | migración 021 | misma semántica que shopify_abandoned_checkout |

---

#### Sync Shopify — comportamiento

`POST /api/abandoned-carts/sync` ejecuta dos fetches en paralelo:

**Draft Orders (principal):**
- `GET draft_orders.json?status=open&limit=250&updated_at_min={90días}`
- `GET draft_orders.json?status=invoice_sent&limit=250&updated_at_min={90días}`
- Mapeo: `id` → `shopify_draft_order_id`, `name` → `shopify_draft_order_name` (#D2256), `invoice_url` → `checkout_url`
- Datos cliente: prioridad note_attributes → shipping_address → billing_address → customer
- Si draft tiene `completed_at` → marca el carrito existente como `recovered` automáticamente

**Checkouts (secundario):**
- `GET checkouts.json?status=open&limit=250&created_at_min={30días}`
- Igual que antes

**Respuesta:**
```json
{
  "drafts":    { "synced": 12, "new": 5, "updated": 7, "recovered": 0 },
  "checkouts": { "synced": 0,  "new": 0, "updated": 0 },
  "errors": 0,
  "draftScopeError": "Falta el scope read_draft_orders..."  // solo si aplica
}
```

**UI toast:** muestra desglose: "5 drafts nuevos · 7 actualizados · Sin cambios nuevos"
**Aviso amarillo** si `draftScopeError` está presente.

---

#### Fuentes soportadas (resumen tabla)

| source | Descripción | Badge UI |
|---|---|---|
| `shopify_draft_order` | Draft Order de Shopify (flujo COD principal) | "Shopify Draft" violeta |
| `shopify_abandoned_checkout` | Checkout nativo Shopify abandonado | "Shopify" gris |
| `cod_form_lead` | Lead parcial de formulario COD | "COD Form" azul |
| `manual_import` | Carga manual | "Manual" gris |
| `shopify` | Legacy | "Shopify" gris |

---

#### Endpoint COD form: `POST /api/abandoned-carts/cod-form`

**Autenticación:** Header `x-cod-form-secret` debe coincidir con env var `COD_FORM_SECRET`.
Si `COD_FORM_SECRET` no está configurado, acepta todas las requests (solo en dev — advertencia en log).

**Body (todos opcionales excepto phone o email):**
```json
{
  "customer_name":    "Juan Pérez",
  "customer_phone":   "8091234567",
  "customer_email":   "juan@email.com",
  "products_summary": "Producto X - Talla M",
  "total_amount":     1200,
  "customer_address": "Calle 5, Sector Norte",
  "city":             "Santiago",
  "province":         "Santiago",
  "product_id":       "123456789",
  "variant_id":       "987654321",
  "page_url":         "https://tienda.com/products/x",
  "referrer":         "https://facebook.com",
  "utm_source":       "facebook",
  "utm_campaign":     "black-friday",
  "utm_content":      "video-1",
  "session_id":       "cart-abc123",
  "abandoned_at":     "2026-05-10T15:30:00Z"
}
```

**Deduplicación (orden de prioridad):**
1. `session_id` coincide con registro existente (mismo `cod_form_lead`, no recovered/discarded) → UPDATE
2. `customer_phone` normalizado coincide (dígitos) + `cod_form_lead` + últimas 24h → UPDATE
3. Ninguno → INSERT nuevo con `recovery_status='pending'`

**Respuesta:**
- `201 Created` → `{ ok: true, action: 'created', id: '...' }`
- `200 OK` → `{ ok: true, action: 'updated', id: '...' }`

---

#### Cómo conectar el formulario COD del tema Shopify

En el JavaScript del tema (Liquid/JS), cuando el cliente empieza a llenar el formulario y se tiene su teléfono:

```javascript
// Llamar cuando el cliente completa el teléfono (o al abandonar el formulario)
async function trackCodFormLead(data) {
  await fetch('https://tu-app.vercel.app/api/abandoned-carts/cod-form', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cod-form-secret': 'TU_COD_FORM_SECRET',
    },
    body: JSON.stringify({
      customer_phone:   data.phone,
      customer_name:    data.name,
      customer_address: data.address,
      city:             data.city,
      province:         data.province,
      products_summary: data.product,
      total_amount:     data.price,
      product_id:       data.productId,
      variant_id:       data.variantId,
      page_url:         window.location.href,
      referrer:         document.referrer,
      utm_source:       new URLSearchParams(window.location.search).get('utm_source'),
      utm_campaign:     new URLSearchParams(window.location.search).get('utm_campaign'),
      session_id:       localStorage.getItem('cart_token') ?? undefined,
    }),
  })
}
```

Llamar `trackCodFormLead` en dos momentos:
1. Cuando el cliente ingresa el teléfono (primer dato valioso)
2. Al evento `beforeunload` / abandono de la página si no completó

---

#### Auto-recover por phone match (webhook)

Cuando entra un nuevo pedido Shopify vía webhook `orders/create`:
1. Se normaliza el teléfono del pedido (dígitos solamente)
2. Se buscan todos los carritos `not in (recovered, discarded)` de la misma tienda
3. Los que tienen el mismo teléfono normalizado se marcan automáticamente como `recovered`
4. Se guarda `recovered_order_id = shopify_order_id`
5. Log: `[shopify-webhook] auto-recovered N abandoned cart(s) — phone match XXXXXXXX`

Esto funciona para leads COD form Y checkouts Shopify sin ninguna configuración adicional.

---

#### Tabla: `abandoned_carts` (migración 021 + 022)

| Campo | Tipo | Notas |
|---|---|---|
| `shopify_checkout_id` | TEXT NULL | NULL para leads COD form. Unique solo cuando no es NULL. |
| `source` | TEXT | `cod_form_lead` \| `shopify_abandoned_checkout` \| `manual_import` \| `shopify` (legacy) |
| `session_id` | TEXT NULL | cart_token o UUID de sesión del frontend, para deduplicación |
| `product_id` | TEXT NULL | ID del producto Shopify |
| `variant_id` | TEXT NULL | ID de variante Shopify |
| `page_url` | TEXT NULL | URL de la página del producto donde se abandonó |
| `referrer` | TEXT NULL | URL de referencia |
| `utm_source/campaign/content` | TEXT NULL | UTM para atribución |
| `recovery_status` | TEXT | pending / contacted / no_answer / recovered / discarded |
| `recovery_attempts` | INT | Incrementa al marcar contacted/no_answer |
| `recovered_order_id` | TEXT NULL | shopify_order_id del pedido que recuperó este carrito |
| `notes` | TEXT NULL | Historial de notas del agente (prepend con timestamp) |
| `abandoned_at` | TIMESTAMPTZ | Última actividad / momento de abandono |

**RLS:** Solo `get_user_role() IN ('admin', 'ia_supervisor', 'confirmation_agent')` con `store_id = get_user_store_id()`.
El endpoint `cod-form` usa `createServiceClient()` (bypass RLS) — no requiere sesión de usuario.

---

#### Flujo de sync Shopify (checkouts nativos)

1. Agente hace click "Sync Shopify Checkouts" → `POST /api/abandoned-carts/sync`
2. API descarga `checkouts.json?status=open` de los últimos 30 días
3. Upsert idempotente por `shopify_checkout_id`: INSERT si no existe, UPDATE solo datos del carrito
4. **Si devuelve 0 carritos:** log explica que es esperado en flujo COD form

---

#### UI — badges de fuente

| source | Badge | Color |
|---|---|---|
| `shopify_abandoned_checkout` / `shopify` | "Shopify" | slate/gris |
| `cod_form_lead` | "COD Form" | azul |
| `manual_import` | "Manual" | gris |

Componente `SourceBadge` inline en `carritos-abandonados/page.tsx` y `carritos-abandonados/[id]/page.tsx`. Aparece junto al badge de estado en tabla desktop, mobile cards y header del detalle.

---

#### Vista detalle: `/carritos-abandonados/[id]`

**Ruta:** `src/app/(app)/carritos-abandonados/[id]/page.tsx`
**API:** `GET /api/abandoned-carts/[id]` → `src/app/api/abandoned-carts/[id]/route.ts`
**Roles con acceso:** `admin`, `ia_supervisor`, `confirmation_agent` (mismos que la lista)

**Layout:** header + banners de cobertura + grid `lg:grid-cols-3`

**Columna izquierda (col-span-2):**
| Sección | Contenido |
|---|---|
| Datos del cliente | nombre, teléfono (link tel:), email, dirección, ciudad, provincia, timestamps |
| Producto / Pedido | products_summary, total_amount, currency, shopify_draft_order_name, draft_status, product_id, variant_id, checkout_url / invoice_url |
| Tracking marketing | utm_source, utm_campaign, utm_content, referrer, page_url, session_id — solo visible si hay algún dato |
| Señales de intención | Placeholders preparados para IA: score intención / prob. recuperación / riesgo fake lead / cliente frecuente. Badge "IA próxima". Sin datos reales. |
| Historial operativo | Timeline de eventos (created_at, abandoned_at, last_contacted_at, completed_at, recovery status). Historial de notas del agente (split `\n\n`). |

**Columna derecha:**
| Sección | Contenido |
|---|---|
| Estado del carrito | 5 botones: Pendiente / Contactado / No responde / Recuperado / Descartado. Checkmark en estado actual. Link "Ver orden recuperada" si `recovered_order_id` existe. |
| Contactar | Botón WhatsApp (verde, llama PATCH status = 'contacted' automáticamente al hacer click) + Llamar + Agregar nota |
| Mensaje sugerido | Mensaje WA dinámico según fuente + cobertura. Botón "Copiar". |
| Cobertura | Resumen: SD / OOC / Destino especial / Zona desconocida / Dentro de cobertura |

**Banners de cobertura (en header):**
- `isOutOfCoverage` → banner rojo
- `isSpecialDestination` → banner azul
- `isUnknownZone` → banner amarillo
- `isSantoDomingoOrder` → banner púrpura

**Banner de recuperación (si `recovery_status = 'recovered'` y `recoveredOrder` existe):**
- Banner verde con link directo a `/orders/{recoveredOrder.id}`

**Timeline — eventos mostrados:**
| Evento | Fuente | Color dot |
|---|---|---|
| Carrito registrado | `created_at` | gris |
| Sincronizado / Lead recibido | `abandoned_at` (si ≠ created_at) | violeta |
| Contactado | `last_contacted_at` | índigo |
| Completado en Shopify | `completed_at` | verde |
| Marcado recuperado (manual) | `updated_at` si recovery_status=recovered | verde |
| Descartado | `updated_at` si recovery_status=discarded | gris claro |

**Notas del agente:** campo `notes` (TEXT) se muestra como entradas individuales separadas por `\n\n`. Cada entrada tiene formato: `"dd/mm/yyyy, hh:mm:ss — Agente [Estado]: texto"`.

**Mensaje WA inteligente en detalle:**
- Draft Shopify → "Tu pedido de [producto] quedó casi listo en nuestra tienda."
- COD Form → "Vimos que comenzaste un pedido de [producto] en nuestra tienda."
- SD → closing "Como estás en Santo Domingo, podemos coordinar entrega rápida con nuestro transporte local."
- OOC → closing "Antes de procesarlo, queremos validar si tenemos cobertura para tu zona."
- Default → closing "Hacemos entrega con pago contra entrega, sin necesidad de pagar por adelantado."

**Navegación:** botón ← vuelve a `/carritos-abandonados` (no `router.back()` — usa `router.push` para predictibilidad). La lista tiene botón ojo (👁) en tabla desktop y "Ver detalle" en mobile cards.

**Cómo probar con #D2256:**
1. Sync Shopify → carrito #D2256 aparece con badge "Shopify Draft"
2. Click ojo en la fila → `/carritos-abandonados/{id}`
3. Verificar: datos cliente, producto con "Draft #D2256" en violeta, cobertura
4. Click WA → mensaje usa intro de Draft Shopify
5. Cambiar estado a "Contactado" → checkmark se mueve
6. Agregar nota → nota aparece en historial con timestamp
7. Si `recovered_order_id` existe → banner verde + link al pedido

---

#### Variables de entorno requeridas

| Variable | Uso | Obligatoria |
|---|---|---|
| `SHOPIFY_SHOP_DOMAIN` | Sync Shopify + endpoint cod-form (resolver store_id) | Sí |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Sync Shopify checkouts | Solo para sync Shopify |
| `COD_FORM_SECRET` | Autenticar requests del tema al endpoint cod-form | Recomendado en producción |

---

#### Lógica de cobertura (reutiliza helpers existentes)

- `checkCoverage(address, city)` → `isOutOfCoverage`, `isSpecialDestination`, `isUnknownZone`
- `isSantoDomingoOrder(city, province, address)` → badge púrpura "SD / Transporte local"
- Aplica igual a leads COD y checkouts Shopify

#### Mensaje WA pre-llenado

- **Normal:** "Hola [nombre] 😊 vimos que dejaste tu pedido de [producto] casi listo..."
- **Santo Domingo:** + "Como estás en Santo Domingo, podemos coordinar entrega con nuestro transporte local."
- **Fuera de cobertura:** "...vamos a validar si tenemos cobertura para tu zona."
- Link: `https://wa.me/1{10digitos}?text={mensaje_encoded}`

---

#### Cómo probar manualmente

**Probar endpoint COD form:**
```bash
curl -X POST https://tu-app.vercel.app/api/abandoned-carts/cod-form \
  -H "Content-Type: application/json" \
  -H "x-cod-form-secret: TU_COD_FORM_SECRET" \
  -d '{
    "customer_name": "María García",
    "customer_phone": "8091234567",
    "products_summary": "Producto Test",
    "total_amount": 1500,
    "city": "Santiago",
    "province": "Santiago",
    "utm_source": "facebook",
    "session_id": "test-session-001"
  }'
```
Esperado: `{ "ok": true, "action": "created", "id": "..." }` o `"action": "updated"` en 2da llamada.

**Verificar en la página:**
1. `npm run dev` → login como admin → `/carritos-abandonados`
2. El lead debe aparecer con badge azul "COD Form" y ciudad "Santiago"
3. Verificar badges cobertura / Santo Domingo según la ciudad del lead
4. Click WA → mensaje pre-llenado correcto
5. Marcar "Recuperado" → estado verde
6. Agregar nota → modal, textarea, timestamp + agente

**Probar auto-recover:**
1. Insertar un lead COD con phone `8091234567` (pendiente)
2. Crear un pedido Shopify con el mismo teléfono (via webhook o `POST /api/admin/recover-orders`)
3. El carrito debe quedar `recovered` con `recovered_order_id` = el shopify_order_id

**Sync Shopify (si aplica):**
1. Click "Sync Shopify Checkouts"
2. Si hay checkouts nativos → muestra `X nuevos · Y actualizados`
3. Si flujo es COD form → `0 nuevos` (esperado — nota en respuesta JSON)

**Roles:**
- Login como `novelty_agent` → `/carritos-abandonados` NO aparece en sidebar
- Si accede directo por URL → página carga pero API devuelve 403 (sin datos)

---

#### Archivos creados/modificados

| Archivo | Cambio |
|---|---|
| `supabase/migrations/021_abandoned_carts.sql` | Base original: tabla, índices, RLS |
| `supabase/migrations/022_abandoned_carts_cod_form.sql` | shopify_checkout_id nullable, índice único condicional, 8 nuevos campos COD form |
| `supabase/migrations/023_abandoned_carts_draft_orders.sql` | shopify_draft_order_id, shopify_draft_order_name, draft_status, completed_at. Índice único condicional por draft. |
| `src/types/index.ts` | `AbandonedCart` actualizada: shopify_checkout_id nullable, campos COD form, campos draft order |
| `src/app/api/abandoned-carts/route.ts` | Lista con filtros y stats |
| `src/app/api/abandoned-carts/[id]/route.ts` | **NUEVO.** GET por ID. Devuelve `{ cart, recoveredOrder? }`. |
| `src/app/api/abandoned-carts/cod-form/route.ts` | Endpoint público leads COD form. Auth header + deduplicación. |
| `src/app/api/abandoned-carts/sync/route.ts` | Sync paralelo Draft Orders (fuente principal) + Checkouts (secundario). Auto-recover completed drafts. |
| `src/app/api/abandoned-carts/[id]/status/route.ts` | PATCH recovery_status + incremento intentos + nota opcional |
| `src/app/api/abandoned-carts/[id]/note/route.ts` | POST agrega nota con timestamp + agente (prepend) |
| `src/app/api/webhooks/shopify/orders/route.ts` | Paso 11: auto-recover carritos por phone match normalizado tras insertar pedido. |
| `src/app/(app)/carritos-abandonados/page.tsx` | Lista con filtros, sync, badges fuente, botón ojo → detalle. |
| `src/app/(app)/carritos-abandonados/[id]/page.tsx` | **NUEVO.** Vista detalle completa: cliente, producto, UTM, IA signals, timeline, acciones, WA inteligente. |

---

### /confirmados — Pedidos recuperados de carrito (2026-05-10)

**Flujo completo: carrito abandonado → recovered → pedido real → /confirmados**

```
Cliente abandona → abandoned_carts (recovery_status='pending')
  ↓ agente contacta en /carritos-abandonados
  ↓ cliente completa la compra (COD form o Draft Order completa)
  ↓ Shopify crea la orden → webhook orders/create
      → auto-recover: abandoned_carts.recovery_status='recovered'
                      abandoned_carts.recovered_order_id = shopify_order_id
      → INSERT orders (source='shopify_webhook', confirmation_status='pending')
  ↓ agente confirma en /confirmacion
      → confirmation_status='confirmed'
  ↓ aparece en /confirmados con badge "Recuperado de carrito"
  ↓ admin despacha normalmente
```

**Cómo se detecta `recovered_order_id`:**
- El campo `abandoned_carts.recovered_order_id` se setea con el `shopify_order_id` del pedido.
- El webhook `orders/create` hace auto-recover por phone match: normaliza el teléfono del pedido entrante y busca carritos pendientes del mismo teléfono. Los que coinciden quedan `recovered` con `recovered_order_id = shopify_order_id`.
- También el sync de Draft Orders marca como recovered si el draft tiene `completed_at`.

**Relación entre tablas:**
```
orders.shopify_order_id = abandoned_carts.recovered_order_id
```
No hay FK formal — el join se hace en TypeScript en la API.

**`GET /api/confirmados` — enriquecimiento:**
1. Query principal: pedidos `confirmed + tracking IS NULL` (igual que antes)
2. Se agrega `shopify_order_id` al SELECT
3. Query secundaria: `abandoned_carts WHERE recovered_order_id IN (shopify_order_ids) AND recovery_status='recovered'`
4. Se construye un `cartMap: Record<shopify_order_id, { id, source }>` para lookup O(1)
5. Cada pedido recibe `recovered_cart_id` y `recovered_cart_source` (null si no recuperado)
6. Stats agrega campo `recuperados` (count de pedidos con `recovered_cart_id != null`)
7. Nuevo param `?filter=recuperados`: filtra pedidos cuyo `shopify_order_id` está en `abandoned_carts.recovered_order_id`

**Tab/filtro "Recuperados de carrito":**
- Botón en la barra de filtros: `🛒 Recuperados` → llama `/api/confirmados?filter=recuperados`
- Tarjeta teal en el grid de resumen: muestra `stats.recuperados` y es clickeable
- No crea duplicados — solo filtra los ya existentes en `/confirmados`
- Los pedidos recuperados siguen apareciendo en "Todos" (sin filtro)

**Badges visuales (componente `RecoveredBadge`):**
| `recovered_cart_source` | Badge | Color |
|---|---|---|
| `shopify_draft_order` | "Recuperado Draft" | violeta |
| `cod_form_lead` | "Recuperado COD Form" | azul |
| cualquier otro | "Recuperado de carrito" | teal |

- Badge aparece bajo el teléfono del cliente en la columna "Cliente"
- Incluye link "Ver carrito →" que navega a `/carritos-abandonados/{id}`
- Filas recuperadas tienen fondo teal sutil (`bg-teal-50/40`)

**Info banner:** Cuando el filtro `recuperados` está activo, aparece un banner teal explicando que estos pedidos deben tratarse como cualquier confirmado (asignar guía EFI y despachar normalmente).

**Archivos modificados:**

| Archivo | Cambio |
|---|---|
| `src/app/api/confirmados/route.ts` | Agrega `shopify_order_id` al SELECT. Query secundaria a `abandoned_carts`. Enriquece cada orden con `recovered_cart_id`/`recovered_cart_source`. Nuevo `?filter=recuperados`. Stats agrega campo `recuperados`. |
| `src/app/(app)/confirmados/page.tsx` | Tipo `ConfirmadoOrder` agrega `shopify_order_id`, `recovered_cart_id`, `recovered_cart_source`. Tarjeta teal "Recuperados de carrito". Botón filtro "🛒 Recuperados". Componente `RecoveredBadge`. Fondo teal en filas recuperadas. Info banner. |

**Cómo probar con un Draft Order real:**
1. Crear/sincronizar un Draft Order en Shopify Admin → aparece en `/carritos-abandonados`
2. Completar el Draft Order en Shopify (convierte a pedido real)
3. El webhook `orders/create` entra → auto-recover marca el carrito como `recovered`
   - O bien: hacer Sync en `/carritos-abandonados` → el draft con `completed_at` se auto-recupera
4. El agente confirma el pedido en `/confirmacion`
5. El pedido aparece en `/confirmados`:
   - Tarjeta "Recuperados de carrito" muestra count ≥ 1
   - Filtro "🛒 Recuperados" lista el pedido
   - Badge "Recuperado Draft" (violeta) aparece en la fila
   - Link "Ver carrito →" lleva a `/carritos-abandonados/{id}`
   - El pedido también aparece en "Todos" (sin duplicación)
6. El admin puede marcar "Listo para despacho" igual que cualquier pedido confirmado

**Restricciones:**
- No se hacen migraciones de DB — detección 100% via JOIN TypeScript
- El `recovered_order_id` en `abandoned_carts` debe ser un `shopify_order_id` válido (lo garantiza el webhook)
- Si un pedido tiene múltiples carritos recuperados (edge case), se usa el primero encontrado en el cartMap
- `npx tsc --noEmit` limpio confirmado

---

---

## FIX: Flujo operativo correcto del mensajero SD — Confirmar ruta antes de entregar (2026-05-18)

### Problema resuelto

El flujo anterior mostraba el botón "Marcar entregado" directamente desde el inicio, sin requerir que el mensajero confirmara que saldría a ruta. Esto ensuciaba el perfil del mensajero con entregas registradas antes de salir, y rompía el flujo operativo real.

### Flujo correcto implementado

```
Pedido asignado → aparece en tab "Pendientes"
    ↓ mensajero confirma salida
[Confirmar ruta] → registra agent_action(route_confirmed) → tab "En ruta"
    ↓ mensajero entrega
[Marcar entregado] → POST /api/sd-delivery/orders/[id]/mark-delivered
    → normalized_status='delivered' en DB al instante → tab "Entregados"

En cualquier momento:
[No responde] → agent_action(contacted, no_answer) → tab "No responden"
[Reprogramar] → agent_action(rescheduled) → tab "No responden"
[WA] / [Llamar] → siempre visibles, registran agent_action(contacted)
```

### Tabs (4 tabs operativos)

| Tab | Filtro local (actionMap) |
|---|---|
| **Pendientes** | sin acción, o `contacted`, o `note_added` |
| **En ruta** | `route_confirmed` |
| **No responden** | `no_answer` o `rescheduled` |
| **Entregados** | `delivered` o en deliveredDb |

El tab activo se deriva del `actionMap` local (en sesión). Cambios de estado se persisten en `agent_actions` via API.

### Botones por estado

| Estado del pedido | Botones mostrados |
|---|---|
| Pendiente | **Confirmar ruta** (teal, ancho completo) · No responde · Nota |
| En ruta | **Marcar entregado** (verde, ancho completo) · No resp. · Reprogramar · Nota |
| No responde | badge No responde · Nota |
| Entregado | badge Entregado ✓ |
| Siempre | WhatsApp · Llamar (cuando hay teléfono y no está entregado) |

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/types/index.ts` | `ActionType` agrega `'route_confirmed'`. `ACTION_LABELS` agrega `route_confirmed: 'Confirmó salida a ruta'`. |
| `src/app/api/orders/[id]/actions/route.ts` | `VALID_TYPES` agrega `'route_confirmed'`. |
| `src/app/api/sd-delivery/performance/route.ts` | Agrega `enRutaHoy` (count de `route_confirmed` hoy por el agente). Response: `{ entregadosHoy, entregadosAyer, enRutaHoy, contactadosHoy, noRespondenHoy, reprogramadosHoy }`. |
| `src/app/(app)/sd-delivery/page.tsx` | Reescritura completa del flujo. Tab type: `pendientes \| en_ruta \| no_responden \| entregados`. Nuevo `confirmRoute()`. Nuevo `localEstado()` helper. SdCard rediseñada: 3 estados visuales distintos. Strip "Mi día" muestra `enRutaHoy`. |

### Función `confirmRoute()` (page.tsx)

```typescript
async function confirmRoute(orderId: string) {
  // POST /api/orders/{id}/actions con action_type='route_confirmed'
  // → setActionMap(prev => ({ ...prev, [orderId]: 'route_confirmed' }))
  // → orden pasa a tab "En ruta"
  // → solo desde "En ruta" aparece "Marcar entregado"
}
```

### Función `localEstado()` (page.tsx)

```typescript
function localEstado(accion: LocalAccion): 'pendiente' | 'en_ruta' | 'no_responde' | 'entregado' {
  if (!accion || accion === 'contacted' || accion === 'note_added') return 'pendiente'
  if (accion === 'route_confirmed')                                  return 'en_ruta'
  if (accion === 'no_answer' || accion === 'rescheduled')            return 'no_responde'
  if (accion === 'delivered')                                        return 'entregado'
  return 'pendiente'
}
```

### Seguridad / qué NO cambia

- `mark-delivered` endpoint: sin cambios — sigue marcando `normalized_status='delivered'` al instante
- EFI: NO tocado (flujo es 100% local SD, sin EFI)
- Datos financieros: NO expuestos al agente
- El `dateFilter` (Hoy/Ayer/Todos) sigue funcionando: filtra activos por `status_since` y entregados por `reported_at`

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como `santo_domingo_delivery_agent`
3. En `/sd-delivery`: verificar tab "Pendientes" con botón **"Confirmar ruta"** (no "Entregado")
4. Click "Confirmar ruta" en un pedido → toast "Ruta confirmada" → pedido aparece en tab "En ruta"
5. En tab "En ruta": verificar botón **"Marcar entregado"** visible
6. Click "Marcar entregado" → pedido pasa a tab "Entregados"
7. En tab "Pendientes": verificar botones WA + Llamar siempre visibles
8. Verificar "No responde" mueve pedido a tab "No responden"
9. Strip "Mi día": verificar que `enRutaHoy` sube al confirmar ruta
10. `npx tsc --noEmit` → sin errores ✅ (verificado 2026-05-18)

---

## MÓDULO SD DELIVERY — Mensajero local Gran Santo Domingo (2026-05-18)

### Qué se hizo

Nuevo rol `santo_domingo_delivery_agent` y módulo completo `/sd-delivery` para mensajeros locales que cubren el Gran Santo Domingo. Permite gestionar entregas locales que NO pasan por EFI, con confirmación inmediata en DB sin esperar al cron.

### Archivos creados/modificados

| Archivo | Cambio |
|---|---|
| `src/types/index.ts` | `UserRole` agrega `'santo_domingo_delivery_agent'` |
| `src/lib/roles.ts` | `OPERATIVE_ROLES` agrega `'santo_domingo_delivery_agent'` — `isAgentOrAbove()` retorna true para este rol |
| `src/components/layout/sidebar.tsx` | Import `MapPin` de lucide-react. Nav `santo_domingo_delivery_agent`: Mi rendimiento + Entregas SD (MapPin, amber). |
| `src/app/api/sd-delivery/orders/[id]/mark-delivered/route.ts` | **NUEVO.** `POST /api/sd-delivery/orders/[id]/mark-delivered`. Roles: admin + santo_domingo_delivery_agent. Marca `normalized_status='delivered'` inmediatamente (sin esperar EFI). |
| `src/app/api/sd-delivery/performance/route.ts` | **NUEVO** (luego modificado — ver fix arriba). `GET /api/sd-delivery/performance`. |
| `src/app/(app)/sd-delivery/page.tsx` | **NUEVO** (luego reescrito — ver fix arriba). Página móvil-first para mensajero SD. |

### Detección de zona SD (`isSantoDomingoOrder`)

Reutiliza la función existente en `src/lib/alert-helpers.ts`. Regex: `/santo domingo|distrito nacional|\bdn\b/` sobre city+province+address normalizados (sin tildes, minúsculas).

**Cubre automáticamente todas las zonas pedidas:**
- Distrito Nacional, SD Este/Norte/Oeste → `city` o `province` = "Santo Domingo"
- Los Alcarrizos, Pedro Brand, Boca Chica, Guerra → `province` = "Santo Domingo"

No se requirió código nuevo para la detección de zonas.

### Diferencia clave vs reparto normal

| Aspecto | `/reparto` + EFI | `/sd-delivery` local |
|---|---|---|
| Marca entregado | Solo `agent_actions` — EFI confirma después | Actualiza `normalized_status='delivered'` inmediatamente |
| Aparece en admin | Al sincronizar con EFI | Al instante (normalized_status ya es 'delivered') |
| `courier_confirmed` | true cuando EFI lo confirma | Siempre false (no pasa por EFI) |
| Endpoint | `/api/reparto/orders/[id]/mark-delivered` | `/api/sd-delivery/orders/[id]/mark-delivered` |

### Endpoint `POST /api/sd-delivery/orders/[id]/mark-delivered`

**Auth:** 401 sin sesión · 403 roles no permitidos

**Actualiza en `orders`:**
- `normalized_status = 'delivered'`
- `follow_up_result = 'delivered'`
- `last_tracking_update = now()`

**Inserta en `agent_actions`:**
- `action_type = 'delivered'`
- `notes = 'Entregado por mensajero local SD'`

**Response 201:**
```json
{
  "action_id": "uuid",
  "reported_at": "ISO",
  "local_confirmed": true,
  "courier_confirmed": false
}
```

### Endpoint `GET /api/sd-delivery/performance`

Zona RD (UTC-4, `America/Santo_Domingo`). Todas las queries filtradas por `agent_id = user.id`.

**Response:**
```json
{
  "entregadosHoy": 5,
  "entregadosAyer": 3,
  "contactadosHoy": 8,
  "noRespondenHoy": 2,
  "reprogramadosHoy": 1
}
```

### Página `/sd-delivery`

**Componentes clave:**
- `SdCard` — card móvil con 7 acciones: WhatsApp, Llamar, Marcar contactado, No responde, Marcar entregado, Reprogramar, Agregar nota
- `NoteModal` — modal textarea para notas (`action_type: 'note_added'`)
- `ReprogramarModal` — modal para reprogramar (`action_type: 'rescheduled'`)

**Filtros (client-side usando `isSantoDomingoOrder`):**
- Muestra solo órdenes de zona SD del universo `en_reparto`
- Pestañas de fecha: Hoy / Ayer / Todos
- Pestañas de estado: Pendientes | No responden | Entregados hoy | Entregados ayer

**Fuentes de datos:**
1. `GET /api/orders?status=en_reparto&limit=500` → filtrado client-side por zona SD
2. `GET /api/reparto/entregados` → entregados hoy+ayer (EFI + agente)
3. `GET /api/sd-delivery/performance` → stats del agente

**UX:**
- Esquema de colores teal/esmeralda
- Paginación PAGE_SIZE=40
- Auto-refresh cada 3 minutos
- Toast notifications
- Tabla desktop también incluida

### Operación del flujo

```
Admin crea/asigna pedido SD con normalized_status='en_reparto'
  ↓ aparece automáticamente en /sd-delivery del mensajero
Mensajero contacta → marca acciones (contacted/no_answer/rescheduled/note)
  ↓ guarda en agent_actions
Mensajero entrega → click "Marcar entregado"
  ↓ POST /api/sd-delivery/orders/[id]/mark-delivered
  ↓ normalized_status='delivered' en DB al instante
  ↓ aparece en dashboard admin como entregado (no espera EFI)
```

### Permisos del nuevo rol

| Módulo | Acceso |
|---|---|
| `/sd-delivery` | ✅ Solo mensajeros SD y admin |
| `/mi-rendimiento` | ✅ (tab performance del agente) |
| `/reparto`, `/novedad`, `/confirmacion` | ❌ (no en su sidebar) |
| Datos financieros/montos | ❌ (no expuestos en el módulo) |
| GPS/mapas/geolocalización | ❌ (Fase 1 — no implementado) |

### Pendientes Fase 2 (NO implementar ahora)

- GPS/geolocalización y mapa de ruta
- Asignación automática de pedidos SD al mensajero
- Firma digital o foto de confirmación de entrega
- Historial de entregas por jornada
- Integración con transportadora local SD

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. En Supabase: asignar rol `santo_domingo_delivery_agent` a un usuario de prueba
3. Login como ese usuario → sidebar muestra solo "Mi rendimiento" y "Entregas SD"
4. Navegar a `/sd-delivery` → debe mostrar pedidos `en_reparto` con dirección en zona SD
5. Verificar filtros: Hoy/Ayer/Todos, tabs de estado
6. Probar "Marcar entregado" → pedido debe salir de "Pendientes" y aparecer en "Entregados hoy"
7. Verificar en Supabase: `orders.normalized_status='delivered'` actualizado al instante
8. Verificar `agent_actions`: fila con `action_type='delivered'`
9. Login como admin → el pedido debe aparecer como entregado en el dashboard inmediatamente
10. `npx tsc --noEmit` → sin errores ✅ (verificado 2026-05-18)

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

---

## FASE 3 — MI RENDIMIENTO INDIVIDUAL (2026-05-10)

Dashboard de rendimiento personal con score, desglose auditado por orden, estimación de pago (experimental) y coaching. Disponible para los tres roles: agente de confirmación, agente de novedad, agente de reparto.

**Principio:** Todo es determinista y auditado. No hay IA externa. El agente puede verificar cada punto del score revisando el desglose por orden.

---

### Endpoint: `GET /api/my-performance/score`

**Archivo:** `src/app/api/my-performance/score/route.ts`

Requiere sesión autenticada. Detecta el rol del usuario y retorna un objeto `ScoreData`.

#### Parámetros de respuesta

```typescript
interface BreakdownItem {
  orderId: string
  orderNumber: string | null
  customerName: string | null
  resultado: string        // Entregado / Recuperado + entregado / Devuelto / Sin respuesta al courier / Fuera cobertura / Cancelado / Pendiente
  pago: number             // RD$ estimado (experimental)
  reason: string           // Por qué se clasificó así
}

interface ScoreData {
  role: 'confirmation_agent' | 'novelty_agent' | 'delivery_agent'
  score: number            // 0-100
  level: 'Excelente' | 'Bueno' | 'Riesgo' | 'Deficiente'
  paymentEstimate: number  // Total RD$ sumando todos los BreakdownItems
  metrics: Record<string, number | null>   // KPIs por rol
  breakdown: BreakdownItem[]
  coaching: string[]       // Mensajes automáticos basados en métricas
  trends: {
    confirmacionesDelta: number | null
    entregasDelta: number | null
    devolucionesDelta: number | null
    scoreDelta: number | null
    thisPeriod: { confirmaciones: number; entregas: number; devoluciones: number; score: number }
    lastPeriod: { confirmaciones: number; entregas: number; devoluciones: number; score: number }
  }
}
```

#### Manejo de fechas (zona RD)

RD usa `America/Santo_Domingo` = UTC-4 fijo (sin DST). La frontera del día en UTC son las 04:00:00Z.

```typescript
function rdDayISO(offsetDays = 0): string {
  const rdStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date())
  const [y, m, d] = rdStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + offsetDays, 4, 0, 0, 0)).toISOString()
}
// month30 = rdDayISO(-30)  → hace 30 días en RD
// week1   = rdDayISO(-7)   → hace 7 días (divide esta semana / semana anterior)
// week2   = rdDayISO(-14)  → hace 14 días (inicio semana anterior)
```

---

### Niveles de score

| Score | Nivel | Color UI |
|-------|-------|----------|
| 90-100 | Excelente | Verde |
| 75-89  | Bueno     | Azul  |
| 60-74  | Riesgo    | Naranja |
| 0-59   | Deficiente | Rojo |

---

### Fórmula de score — Agente de Confirmación

**Ventana:** últimos 30 días (sistema-wide — no hay agent_id en confirmaciones).

```
base            = 40
deliveryScore   = (deliveryRate / 100) x 36        // máx +36 — deliveryRate = entregas / confirmados
recoveryBonus   = min(recuperados / 5, 1) x 12     // máx +12 — 5+ recuperados = bonus completo
devPenalty      = (devueltos / confirmados) x 20    // máx -20 — proporcional a tasa devolución
coberPenalty    = min((fueraCobertura / confirmados) x 10, 4)  // máx -4
score           = clamp(0, round(base + deliveryScore + recoveryBonus - devPenalty - coberPenalty), 100)
```

**Métricas expuestas:**
- `confirmados`: pedidos con `confirmation_status IN ('confirmed','no_coverage','cancelled','unreachable')` en 30d
- `entregados`: de los confirmados, `normalized_status = 'delivered'`
- `devueltos`: `normalized_status = 'returned'` + `confirmation_status = 'confirmed'`
- `fueraCobertura`: `confirmation_status = 'no_coverage'`
- `recuperados`: pedidos cuyo `shopify_order_id` aparece en `abandoned_carts.recovered_order_id`
- `deliveryRate`: `(entregados / confirmados) x 100` — porcentaje

---

### Fórmula de score — Agente de Novedad

**Ventana:** agent_actions del agente autenticado en últimos 30 días.

```
base            = 40
tasaRecScore    = (tasaRec / 100) x 36             // máx +36 — tasaRec = recuperadas / trabajados
volumenBonus    = min(trabajados / 10, 1) x 12     // máx +12 — 10+ trabajados = bonus completo
intentosBonus   = dosIntentos === 0 ? 8 : max(0, 8 - dosIntentos x 2)  // máx +8
vencidasPenalty = min(vencidas x 2, 20)            // máx -20
score           = clamp(0, round(base + tasaRecScore + volumenBonus + intentosBonus - vencidasPenalty), 100)
```

**Métricas expuestas:**
- `trabajados`: órdenes con acción del agente en agent_actions (action_type IN ('assigned','updated','resolved'))
- `recuperadas`: de los trabajados con `normalized_status IN ('in_transit', 'delivered')`
- `dosIntentos`: órdenes con `delivery_attempts >= 2` en estado novedad
- `tasaRec`: `(recuperadas / trabajados) x 100`
- `vencidas`: órdenes en novedad creadas hace más de 7 días sin resolución

---

### Fórmula de score — Agente de Reparto

**Ventana:** agent_actions del agente autenticado en últimos 30 días.

```
base             = 40
tasaEntregaScore = (tasaEntrega / 100) x 36        // máx +36 — tasaEntrega = entregados / contactados
seguimientoBonus = min(contactados / 10, 1) x 12   // máx +12 — 10+ contactados = bonus completo
criticosBonus    = criticos === 0 ? 8 : 0           // +8 si cero críticos
criticosPenalty  = min(criticos x 3, 20)            // máx -20
score            = clamp(0, round(base + tasaEntregaScore + seguimientoBonus + criticosBonus - criticosPenalty), 100)
```

**Métricas expuestas:**
- `contactados`: órdenes con acción del agente en agent_actions
- `entregados`: de los contactados con `normalized_status = 'delivered'`
- `criticos`: órdenes en en_reparto con `updated_at < hace 48h` (sin actualización reciente)
- `tasaEntrega`: `(entregados / contactados) x 100`

---

### Sistema de pago estimado (experimental)

**IMPORTANTE:** Estos cálculos son experimentales. No representan el pago real. Solo sirven para que el agente estime su rendimiento. Pueden cambiar en cualquier momento.

#### Clasificación por orden — Agente de Confirmación

| Condición | Resultado | Pago RD$ |
|-----------|-----------|----------|
| `recovered = true` AND `normalized_status = 'delivered'` | Recuperado + entregado | 35 |
| `normalized_status = 'delivered'` | Entregado | 25 |
| `normalized_status = 'returned'` AND `confirmation_status = 'confirmed'` | Devuelto | 5 |
| `confirmation_status = 'no_coverage'` | Fuera cobertura | 0 |
| `confirmation_status = 'cancelled'` | Cancelado | 0 |
| `confirmation_status = 'confirmed'` AND `normalized_status IN ('en_reparto','novedad','in_transit')` AND `delivery_attempts >= 1` | Sin respuesta al courier | 10 |
| otro | Pendiente | 0 |

#### Clasificación por orden — Agente de Novedad

| Condición | Resultado | Pago RD$ |
|-----------|-----------|----------|
| `normalized_status IN ('in_transit','delivered')` | Recuperado | 35 |
| `normalized_status = 'returned'` | Devuelto confirmado | 5 |
| `delivery_attempts >= 2` | 2+ intentos (sin entrega) | 10 |
| otro | Sin definir | 0 |

#### Clasificación por orden — Agente de Reparto

| Condición | Resultado | Pago RD$ |
|-----------|-----------|----------|
| `normalized_status = 'delivered'` | Entregado | 25 |
| `normalized_status = 'returned'` | Devuelto | 5 |
| crítico (>48h sin update) | Crítico activo | 0 |
| otro | En proceso | 0 |

---

### Detección de pedidos recuperados de carrito

No hay FK directa. La detección se hace con un reverse JOIN en TypeScript:

```typescript
// 1. Obtener IDs de Shopify de las órdenes del breakdown
const shopifyIds = orders.map(o => o.shopify_order_id).filter(Boolean)

// 2. Buscar en abandoned_carts cuáles tienen recovered_order_id en esa lista
const { data: recCarts } = await supabase
  .from('abandoned_carts')
  .select('recovered_order_id')
  .in('recovered_order_id', shopifyIds)
  .eq('recovery_status', 'recovered')

// 3. Construir Set para lookup O(1)
const recoveredSet = new Set(recCarts?.map(c => c.recovered_order_id) ?? [])

// 4. En classifyConfirm: isRecovered = recoveredSet.has(order.shopify_order_id)
```

---

### Nota: Sin agent_id en confirmaciones

El endpoint `/api/orders/[id]/confirmation` actualiza directamente la tabla `orders` sin insertar en `agent_actions`. Por esto, no es posible filtrar confirmaciones por agente individual.

**Consecuencia:** El breakdown y las métricas de `confirmation_agent` son sistema-wide (todos los pedidos confirmados en los últimos 30 días), no filtradas por agente. Si en el futuro se agrega tracking en agent_actions para confirmaciones, la lógica de query debe actualizarse.

---

### Tendencias semanales

Se divide el período de 30 días en:
- **Esta semana:** `week1ISO` (-7d) hasta ahora
- **Semana anterior:** `week2ISO` (-14d) hasta `week1ISO`

Para cada período se calcula: confirmaciones, entregas, devoluciones, score.
Los deltas (`confirmacionesDelta`, `entregasDelta`, etc.) son `thisPeriod - lastPeriod`.

---

### Coaching automático

Los mensajes se generan en el servidor (deterministas, sin IA). Ejemplos:

**Confirmación:**
- `deliveryRate < 40` → "Tu tasa de entrega está muy baja. Revisa si hay pedidos en espera de gestión."
- `fueraCobertura > confirmados * 0.2` → "Más del 20% de los pedidos están fuera de cobertura. Considera escalar al supervisor."
- `devueltos > confirmados * 0.3` → "Alta tasa de devolución. Coordina con el equipo de reparto."
- `recuperados >= 3` → "¡Excelente recuperación de carritos! Sigue así."
- `deliveryRate >= 80` → "Tasa de entrega excelente. ¡Mantén el ritmo!"

**Novedad:**
- `vencidas > 3` → "Tienes N casos vencidos +7 días. Requieren atención inmediata."
- `dosIntentos > 2` → "Varios pedidos con 2+ intentos sin entrega. Coordina nuevas ventanas de entrega."
- `tasaRec >= 70` → "¡Tasa de recuperación excelente! Estás gestionando muy bien las novedades."

**Reparto:**
- `criticos > 0` → "Tienes N pedido(s) crítico(s) con más de 48h sin actualización."
- `tasaEntrega < 50` → "Tu tasa de entrega está por debajo del 50%. Revisa los casos pendientes."
- `tasaEntrega >= 80` → "Excelente tasa de entrega. ¡Sigue así!"

---

### Archivos del módulo

| Archivo | Descripción |
|---------|-------------|
| `src/app/api/my-performance/score/route.ts` | **NUEVO.** GET endpoint principal. Detecta rol, calcula score, métricas, breakdown, coaching, trends. |
| `src/components/rendimiento/RendimientoConfirmacion.tsx` | **REESCRITO.** Dashboard premium para confirmation_agent. Usa `/api/my-performance/score`. |
| `src/components/rendimiento/RendimientoNovedad.tsx` | **REESCRITO.** Dashboard premium para novelty_agent. Tema rojo. |
| `src/components/rendimiento/RendimientoReparto.tsx` | **REESCRITO.** Dashboard premium para delivery_agent. Tema ámbar. |
| `src/app/(app)/mi-rendimiento/page.tsx` | Sin cambios — sigue enrutando por rol a los componentes anteriores. |

**Endpoints anteriores no modificados** (siguen activos para supervisor-ia):
- `src/app/api/confirmacion/performance/route.ts`
- `src/app/api/novedad/performance/route.ts`
- `src/app/api/reparto/performance/route.ts`

---

### Cómo probar

1. **Login como agente de confirmación** → ir a `/mi-rendimiento`
   - Debe mostrar score circle, estimación de pago, 6 tarjetas KPI, barra de tasa de entrega, tabla de desglose, tendencias, coaching.
   - Verificar que el score cambia si hay órdenes entregadas vs devueltas.

2. **Login como agente de novedad** → ir a `/mi-rendimiento`
   - Score círculo rojo. 5 KPIs: Trabajados, Recuperadas, 2+ intentos, Tasa recup., Vencidas +7d.
   - Desglose muestra las órdenes en que el agente tuvo acción.

3. **Login como agente de reparto** → ir a `/mi-rendimiento`
   - Score círculo ámbar. Banner de alerta si hay críticos > 0.
   - Desglose muestra las órdenes del agente.

4. **Verificar auditabilidad:** expandir el desglose y comparar cada fila con la orden real en el módulo correspondiente.

5. **Verificar TypeScript:** `npx tsc --noEmit` debe pasar sin errores.

6. **Probar con datos vacíos:** agente sin acciones → score = 40 (base), paymentEstimate = 0, breakdown vacío, coaching básico.

---

### Restricciones

- No se conecta a APIs externas ni a IA
- No ejecuta pagos reales — es solo estimación visual
- La fórmula de pago puede cambiar — siempre se muestra el disclaimer "Sistema experimental"
- No se modificaron migraciones de DB para esta fase
- `npx tsc --noEmit` limpio confirmado (2026-05-10)

---

## SD DELIVERY — Pedidos nuevos/pending + 5 tabs (2026-05-18)

### Qué se hizo

Extendió el módulo `/sd-delivery` para que el mensajero local también vea pedidos **nuevos de Shopify** (`confirmation_status='pending'`) de la zona SD, no solo los ya despachados (`en_reparto`). Esto permite que el mensajero ayude a confirmar pedidos antes de que pasen por el flujo de confirmación central, acelerando la entrega local.

### Tabs (5 tabs operativos)

| Tab | Fuente | Filtro local |
|---|---|---|
| **Nuevos / Por confirmar** | Pool B (`confirmationStatus=pending`) | sin acción, o `note_added` |
| **Confirmados / Listos** | Pool A (`en_reparto`) + Pool B con `client_confirmed` | no `route_confirmed` |
| **En ruta** | Pool A | `route_confirmed` |
| **No responden** | Pool A + Pool B | `no_answer` o `rescheduled` |
| **Entregados** | Pool A + sesión | `delivered` o en `deliveredDb` |

### Botones por displayState

| DisplayState | Botones |
|---|---|
| `nuevo` | WhatsApp · Llamar · **Cliente confirma** (azul) · **No responde** |
| `espera_despacho` | badge "Confirmado · esperando despacho admin" (sin botones de acción) |
| `confirmado_listo` | WhatsApp · Llamar · **Confirmar ruta** (teal) · No responde · Nota |
| `en_ruta` | WhatsApp · Llamar · **Marcar entregado** (verde) · No resp. · Reprogram. · Nota |
| `no_responde` | badge · Nota · si pool=nuevo: **"El cliente llamó y confirma"** |
| `entregado` | badge "Entregado" |

### Flujo completo

```
Shopify → orders(confirmation_status='pending') → aparece en tab "Nuevos / Por confirmar"
    ↓ mensajero llama/WA
[Cliente confirma] → POST /api/sd-delivery/orders/[id]/confirm-client
    → confirmation_status='confirmed', customer_confirmed=true
    → agent_actions(action_type='confirmed')
    → mueve a tab "Confirmados / Listos" (pool local = espera_despacho)
    → Admin ve el pedido confirmado y asigna normalized_status='en_reparto'
    → En próximo refresh: aparece en Pool A como confirmado_listo

[No responde] → agent_actions(contacted, no_answer)
    → mueve a tab "No responden"
    → permanece en sistema (no sale)
    → si llama después: botón "El cliente llamó y confirma" disponible

Flujo existente (Pool A):
Pendiente → Confirmar ruta → En ruta → Marcar entregado
```

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/app/api/orders/route.ts` | Nuevo param `confirmationStatus`. `pending` filtra `confirmation_status='pending'` excluyendo `delivered`/`returned`. `confirmed` filtra confirmados. |
| `src/app/api/orders/[id]/actions/route.ts` | `VALID_TYPES` agrega `'note_added'` (corrección de bug: estaba en el tipo pero no en la validación). |
| `src/app/api/sd-delivery/orders/[id]/confirm-client/route.ts` | **NUEVO.** `POST /api/sd-delivery/orders/[id]/confirm-client`. Roles: admin + santo_domingo_delivery_agent. Actualiza `confirmation_status='confirmed'`, `customer_confirmed=true`, `customer_confirmed_at`, `last_confirmation_attempt`, `confirmation_method='call'`. Inserta `agent_actions(action_type='confirmed')`. 409 si ya estaba confirmado. |
| `src/app/api/sd-delivery/performance/route.ts` | Agrega `confirmedHoy` (count de `confirmed` hoy por el agente). Response incluye `confirmedHoy`. |
| `src/app/(app)/sd-delivery/page.tsx` | **REESCRITO.** Ver detalles abajo. |

### Página `/sd-delivery` — cambios principales

**Nuevos tipos:**
- `Tab = 'nuevos' | 'confirmados' | 'en_ruta' | 'no_responden' | 'entregados'`
- `OrderPool = 'nuevo' | 'confirmado'`
- `DisplayState` — 6 estados visuales distintos
- `PooledOrder = { order: Order; pool: OrderPool }`

**Fetch (4 paralelos):**
1. `GET /api/orders?status=en_reparto&limit=500` → Pool A (confirmados/en_reparto)
2. `GET /api/orders?confirmationStatus=pending&limit=300` → Pool B (nuevos SD)
3. `GET /api/reparto/entregados` → entregados
4. `GET /api/sd-delivery/performance` → stats

**Deduplicación:** Pool B excluye IDs ya presentes en Pool A para evitar duplicados.

**Filtro de zona:** client-side usando `isSantoDomingoOrder` en ambos pools.

**Filtro de fecha:** Pool A usa `status_since`; Pool B usa `created_at`.

**Strip "Mi día":** agrega "Confirmados" (azul) junto a los demás conteos.

**TAB_META colores:** cada tab tiene su color activo (azul=nuevos, teal=confirmados/en_ruta, amber=no_responden, emerald=entregados).

**SdCard:** acepta `pool: OrderPool` + calcula `computeDisplayState()` para decidir qué botones mostrar. Mensaje de WhatsApp diferente para pedidos nuevos (solicita confirmación) vs pedidos en reparto (avisa que el mensajero pasará hoy).

### Nuevo endpoint `POST /api/sd-delivery/orders/[id]/confirm-client`

**Auth:** 401 sin sesión · 403 para no-admin/no-SD-agent · 409 si ya confirmado

**Actualiza en `orders`:**
- `confirmation_status = 'confirmed'`
- `customer_confirmed = true`
- `customer_confirmed_at = now()`
- `last_confirmation_attempt = now()`
- `confirmation_method = 'call'`

**Inserta en `agent_actions`:**
- `action_type = 'confirmed'`
- `notes = 'Confirmado por mensajero SD (cliente confirmó recepción)'`

**Response 201:**
```json
{ "action_id": "uuid", "confirmed_at": "ISO" }
```

### Qué NO hace / no cambia

- EFI: no tocado (el flujo SD es 100% local)
- `mark-delivered` endpoint: sin cambios
- Montos/pagos: no expuestos
- Sincronización con admin: automática — cuando el agente confirma, el admin ve `confirmation_status='confirmed'` en su vista de confirmación sin cambios de código

### Comportamiento "espera_despacho"

Cuando el mensajero marca "Cliente confirma":
- El pedido se mueve localmente al tab "Confirmados / Listos" con estado `espera_despacho`
- No se muestran botones de acción (solo badge informativo)
- En el próximo refresh (3 min): si el admin ya despachó → aparece en Pool A como `confirmado_listo`; si no → desaparece del módulo hasta que el admin despache

### Cómo probar

1. `npm run dev` en `control-cod-app/`
2. Login como `santo_domingo_delivery_agent`
3. Navegar a `/sd-delivery` → debe mostrar tab "Nuevos / Por confirmar" con pedidos SD `confirmation_status='pending'`
4. Verificar que tab "Confirmados / Listos" muestra pedidos `en_reparto` (flujo existente)
5. En tab "Nuevos": click WhatsApp/Llamar → registra `contacted` en `agent_actions`
6. Click "Cliente confirma" → toast "Cliente confirmado" → pedido pasa a tab "Confirmados"
7. Click "No responde" en un nuevo → pedido pasa a tab "No responden"
8. En tab "No responden" (pool=nuevo): verificar botón "El cliente llamó y confirma" visible
9. En tab "Confirmados" (pedido en_reparto): verificar botón "Confirmar ruta"
10. En tab "En ruta": verificar botón "Marcar entregado"
11. Strip "Mi día": verificar que `confirmedHoy` sube al confirmar clientes
12. `npx tsc --noEmit` → sin errores ✅ (verificado 2026-05-18)

---

## INTEGRACIÓN: App → Shopify (fulfillment + mark_paid) — 2026-05-18

### Objetivo

Cuando una orden se gestiona en Control COD, reflejar el cambio en Shopify automáticamente:
- **Mensajero confirma ruta** → crear fulfillment en Shopify (empacado/en camino)
- **Mensajero marca entregado** → marcar la orden como pagada en Shopify (COD cobrado)

### Arquitectura

Sin romper el flujo local ni el flujo EFI. Shopify es una capa de sincronización adicional:
- Si Shopify falla → la app sigue funcionando (operación local no se cancela)
- Si ya está fulfillada/pagada → se omite silenciosamente (idempotente)
- Todos los resultados se guardan en `shopify_sync_log` para auditoría

### Scopes requeridos en el token `SHOPIFY_ADMIN_ACCESS_TOKEN`

| Scope | Para qué |
|---|---|
| `read_orders` | Verificar financial_status antes de marcar paid (ya existente) |
| `write_orders` | `orderMarkAsPaid` GraphQL |
| `read_fulfillments` | Consultar fulfillment_orders y estado actual |
| `write_fulfillments` | Crear fulfillments |

**Acción requerida antes del deploy:** Actualizar el token en Shopify Admin → Apps → Custom apps y añadir los scopes que falten. El token actual solo tiene `read_orders`.

### Archivos creados

| Archivo | Función |
|---|---|
| `src/lib/shopify/client.ts` | **NUEVO.** Helper base: `shopifyRestUrl()`, `shopifyHeaders()`, `shopifyGraphQL()`. Centraliza credenciales y API version. |
| `src/lib/shopify/fulfillments.ts` | **NUEVO.** `createLocalFulfillment(shopifyOrderId, trackingNumber?)`. Verifica idempotencia, obtiene fulfillment_orders abiertos, crea fulfillment via REST. |
| `src/lib/shopify/payments.ts` | **NUEVO.** `markOrderAsPaid(shopifyOrderId)`. Verifica financial_status via GraphQL, ejecuta `orderMarkAsPaid` mutation solo si `!= PAID`. |
| `supabase/migrations/025_shopify_sync_log.sql` | **NUEVO.** Tabla `shopify_sync_log`: audit log de cada sincronización con `event_type` (fulfillment/mark_paid), `result` (success/skipped/error), `error_message`, `metadata`. |

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/app/api/orders/[id]/actions/route.ts` | **MODIFICADO.** Cuando `action_type='route_confirmed'`: llama `createLocalFulfillment()` si la orden tiene `shopify_order_id` y `source='shopify_webhook'`. Log en `shopify_sync_log`. El fallo de Shopify no rompe la respuesta HTTP. |
| `src/app/api/sd-delivery/orders/[id]/mark-delivered/route.ts` | **MODIFICADO.** Después de marcar entregada en DB: llama `markOrderAsPaid()` si la orden tiene `shopify_order_id` y `source='shopify_webhook'`. Log en `shopify_sync_log`. El fallo de Shopify no rompe la respuesta HTTP. |

### Flujo por acción

#### Confirmar ruta (Shopify fulfillment)

```
Mensajero → "Confirmar ruta" → POST /api/orders/[id]/actions { action_type: 'route_confirmed' }
    ↓ [local — siempre ocurre]
Inserta en agent_actions (route_confirmed)
    ↓ [Shopify — best-effort]
¿order.shopify_order_id && source='shopify_webhook'?
    SÍ → createLocalFulfillment(shopify_order_id, tracking_number)
        → fulfillment_status='fulfilled' en Shopify
    NO → skip silencioso
    → shopify_sync_log: event_type='fulfillment', result=success|skipped|error
Responde HTTP 201 (independiente del resultado Shopify)
```

#### Marcar entregado (Shopify mark_paid)

```
Mensajero → "Marcar entregado" → POST /api/sd-delivery/orders/[id]/mark-delivered
    ↓ [local — siempre ocurre]
DB update: normalized_status='delivered', follow_up_result='delivered'
agent_actions: action_type='delivered'
    ↓ [Shopify — best-effort]
¿order.shopify_order_id && source='shopify_webhook'?
    SÍ → markOrderAsPaid(shopify_order_id)
        → financial_status='paid' en Shopify
    NO → skip silencioso
    → shopify_sync_log: event_type='mark_paid', result=success|skipped|error
Responde HTTP 201 (independiente del resultado Shopify)
```

### Protecciones (idempotencia)

| Condición | Comportamiento |
|---|---|
| Shopify `fulfillment_status='fulfilled'` | `createLocalFulfillment` retorna `{ skipped: true }` — sin API write |
| Shopify `financial_status='PAID'` | `markOrderAsPaid` retorna `{ skipped: true }` — sin API write |
| `userErrors` incluye "already paid" | Tratado como `skipped` |
| No hay fulfillment_orders abiertas | `createLocalFulfillment` retorna `{ skipped: true }` |
| orden sin `shopify_order_id` o `source != 'shopify_webhook'` | Skip completo — no se llama a Shopify |
| Shopify API lanza error de red | Retorna `{ error }` — flujo local completado, se loguea warning |

### Monitoreo (shopify_sync_log)

```sql
-- Ver últimos errores de Shopify
SELECT order_id, shopify_order_id, event_type, error_message, created_at
FROM shopify_sync_log
WHERE result = 'error'
ORDER BY created_at DESC
LIMIT 20;

-- Resumen del día
SELECT event_type, result, COUNT(*) 
FROM shopify_sync_log
WHERE created_at >= now() - INTERVAL '24h'
GROUP BY event_type, result
ORDER BY event_type, result;
```

### Logs en Vercel

```
[actions/route_confirmed] Shopify fulfillment creado — order=UUID shopify=1234567890
[actions/route_confirmed] Shopify fulfillment ya existía — order=UUID shopify=1234567890
[actions/route_confirmed] Shopify fulfillment FALLÓ (flujo local OK) — order=UUID ... error=...

[sd-delivery/mark-delivered] Shopify mark_paid OK — order=UUID shopify=1234567890
[sd-delivery/mark-delivered] Shopify mark_paid ya estaba pagada — order=UUID shopify=1234567890
[sd-delivery/mark-delivered] Shopify mark_paid FALLÓ (flujo local OK) — order=UUID ... error=...
```

### Qué NO hace esta integración

- No toca órdenes que no son `source='shopify_webhook'` (CSV imports, manual)
- No toca órdenes sin `shopify_order_id`
- No rompe el flujo EFI ni el cron de tracking
- No crea fulfillments para `confirm-client` (cliente confirma ≠ despachado)
- No marca paid si la orden ya está pagada
- No duplica fulfillments
- No modifica el flujo de novedades, devoluciones, ni ningún otro módulo

### Pendientes antes del deploy

1. **Actualizar scopes del token Shopify:**
   Shopify Admin → Settings → Apps → Custom apps → Control COD → Edit permissions
   Añadir: `write_orders`, `read_fulfillments`, `write_fulfillments`
   Revocar y re-generar el token, actualizar `SHOPIFY_ADMIN_ACCESS_TOKEN` en Vercel env vars

2. **Ejecutar migración en Supabase:**
   ```sql
   -- Pegar contenido de supabase/migrations/025_shopify_sync_log.sql en Supabase SQL Editor
   ```

3. **Verificar en producción con una orden de prueba:**
   - Tomar una orden SD con `shopify_order_id` no nulo
   - Confirmar ruta → verificar en Shopify que `fulfillment_status='fulfilled'`
   - Marcar entregado → verificar en Shopify que `financial_status='paid'`
   - Revisar `shopify_sync_log` en Supabase
