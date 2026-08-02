# Customer Intelligence Engine — Arquitectura v1

Este documento es el contrato de arquitectura para el reemplazo progresivo de Zoko dentro de
Control COD. Es un documento de **diseño**, no de implementación. Ninguna migración, tabla ni
código descrito aquí existe todavía salvo que se marque explícitamente como "ya existe".

Estado: **cerrado para diseño — listo para Fase 1** (ver sección 14, "Decisiones cerradas V1").
No implica autorización para implementar: cada fase del roadmap (sección 13) requiere aprobación
explícita, separada, antes de tocar migraciones o código — mismo criterio que
[`ARCHITECTURE_RUTA_COD_V1.md`](./ARCHITECTURE_RUTA_COD_V1.md).

Fecha de cierre de esta revisión: 2026-08-01. Revisión anterior (FASE 0, borrador inicial):
2026-08-01, mismo día — esta versión reemplaza a la anterior tras auditoría adicional de código y
**datos reales de producción, solo lectura** (ver sección 7).

---

# Resumen ejecutivo

Control COD no tiene hoy ningún concepto de "cliente". Tiene **pedidos** (`orders`), cada uno con
su propia copia de nombre/teléfono/dirección, y — desde la Fase 6/7 del Inbox WhatsApp — tiene
**contactos de WhatsApp** (`wa_contacts`), un objeto operativo del Inbox, no un perfil comercial.
No existe `shopify_customer_id` en ningún lado del esquema. Este documento cierra el diseño de
`customers` como entidad nueva, separada de `wa_contacts` por una razón de fondo (sección 1), con
identidad basada en teléfono normalizado (sección 2-3), un modelo de eventos que complementa —no
reemplaza— los historiales ya existentes (sección 4), reglas de consentimiento y exclusión
concretas y no ambiguas (secciones 5-6), y un RFM v1 **calibrado contra datos reales de
producción**, no aspiracional (sección 7).

**Hallazgo más importante de esta revisión, con impacto directo en el diseño:** se consultó la
base de datos de producción en modo solo lectura (ver metodología en sección 7). Hoy existe **una
sola fila en `stores`** ("Mi Tienda") — LÜMA Teeth/Renuva como tiendas Shopify separadas, tal como
las describe el roadmap de `CLAUDE.md`, **todavía no existen como filas `store_id` distintas en
este esquema.** El diseño store-scoped sigue siendo la decisión correcta (es la misma que ya usa
todo el RLS del sistema), pero el documento anterior asumía multi-tienda como un hecho actual —
era una proyección de roadmap, no el estado real. Se corrige en toda la sección 10.

Segundo hallazgo con impacto directo: **`payment_status`/`paid_at` (migración 046, la fuente
mandatada para RFM) tiene solo 12 días de historial real** (97 pedidos pagados de 3,368 totales,
2.9%). Una ventana RFM de 180 días —la propuesta original— no está validada, no puede estarlo
todavía: no hay 180 días de datos que ver. La sección 7 reemplaza esa cifra por una V1 que usa
"todo el historial disponible" con un punto de recalibración explícito, en vez de fijar un número
inventado y llamarlo "no copiado de Zoko" cuando en realidad tampoco vendría de datos propios.

---

# 1. `customers` vs `wa_contacts`

## 1.1 Auditoría (repetida y confirmada contra el código actual)

- `wa_contacts` (`030_whatsapp_base.sql`): `id, store_id, phone_normalized, display_name, wa_id,
  order_id, last_seen_at`. `UNIQUE(store_id, phone_normalized)`.
- Único FK **hacia** `wa_contacts` en todo el esquema: `wa_conversations.contact_id`
  (`030_whatsapp_base.sql:56`). Nada más referencia `wa_contacts` — ni `orders`, ni
  `abandoned_carts`, ni ninguna otra tabla.
- `wa_contacts.order_id` es un FK **hacia** `orders`, nullable, `ON DELETE SET NULL`. Se resuelve
  una sola vez por `findOrderByPhone()` (`src/app/api/webhooks/whatsapp/route.ts:691-717`): busca
  el pedido activo (no `delivered`/`returned`) más reciente con teléfono coincidente entre las
  últimas 200 filas de la tienda, y **solo si `wa_contacts.order_id` está NULL** — nunca se
  actualiza después de la primera vez que se setea.
- `wa_contacts` también se crea/actualiza **desde el lado saliente**: el cron
  `src/app/api/cron/wa-template-queue/route.ts` (Fase 6A, confirmación automática de pedido) toca
  `wa_contacts` en 6 puntos distintos del archivo — no es exclusivamente un objeto que nace de
  mensajes entrantes. Esto explica el dato real observado (sección 1.3): el 100% de los
  `wa_contacts` existentes hoy tienen `order_id` poblado, porque nacen del flujo de confirmación
  de pedido, no de gente escribiendo espontáneamente.
- `abandoned_carts` no tiene ningún FK hacia `wa_contacts` ni hacia `orders` (solo
  `recovered_order_id TEXT`, sin FK real — es un string que se compara manualmente contra
  `orders.shopify_order_id`).

## 1.2 Qué representa cada tabla

| | `customers` (propuesta) | `wa_contacts` (ya existe) |
|---|---|---|
| **Qué es** | La identidad comercial de una persona, por tienda: quién es, qué ha comprado, cuánto vale, si se le puede contactar con fines de marketing. | Un canal de comunicación: un número de WhatsApp con el que existe (o existió) un hilo de conversación operativo. |
| **Nace cuando** | Hay una transacción real (pedido) o intención seria de compra (carrito abandonado). | Alguien escribe por primera vez, **o** el sistema le envía el template de confirmación de un pedido nuevo. |
| **Dueño del subsistema** | Customer Intelligence Engine (este documento). | Inbox WhatsApp — ya en producción, con su propio ciclo de vida y RLS (`is_wa_inbox_role()`). |
| **Campos característicos** | RFM, LTV, `cod_risk_score`, consentimiento de marketing, insights de Génesis. | `wa_id` (ID interno de Meta), `display_name` (nombre de perfil de WhatsApp — no necesariamente el nombre real del cliente), `unread_count`, estado del hilo (`wa_conversations.status`). |

## 1.3 Por qué no deben ser la misma tabla

1. **Ciclo de vida distinto y desacoplado.** Un `wa_contact` puede existir sin ninguna compra real
   (alguien pregunta y desiste, número equivocado, spam). Un `customer` sin ninguna señal de
   compra ni intención (ni pedido ni carrito) no debería existir — no hay nada que perfilar. Forzar
   una sola tabla obligaría a que cada mensaje cree una fila con columnas de RFM/LTV que no
   aplican, o a inventar un estado "customer sin actividad comercial" que ensucia cada query.
2. **Separación de RLS por diseño ya existente.** `wa_contacts` es visible para
   `is_wa_inbox_role()` (`admin`, `ia_supervisor`, `confirmation_agent`, `dispatch_agent`,
   `novelty_agent`, `agent` — `030_whatsapp_base.sql:170-179`), un conjunto de roles operativos
   amplio. `customers` necesita ocultar campos financieros/IA a varios de esos mismos roles
   (sección 11). Fusionar las tablas fusionaría también sus políticas de acceso — exactamente lo
   que el prompt original pide evitar ("no expongas notas internas o análisis IA innecesariamente
   a todos los roles").
3. **Acoplamiento de subsistemas con velocidades de cambio distintas.** `wa_contacts` es del Inbox,
   que ya tiene 7 migraciones propias (030-035) y sigue evolucionando (Fase 6B ya amplió
   `message_type`). Acoplar el esquema comercial al esquema del Inbox significa que un cambio en
   uno arriesga al otro — contradice el Principio 1 de este documento (`customers` nunca escribe
   sobre las tablas operativas existentes, y viceversa: el Inbox no debería tener que conocer RFM).
4. **La cardinalidad real ya lo confirma.** `wa_contacts.order_id` es deliberadamente débil (un
   solo pedido, vinculado una vez, "el que había cuando escribió") — es correcto para lo que
   `wa_contacts` necesita (mostrar contexto del pedido más relevante en el Inbox), pero es
   **insuficiente** para lo que `customers` necesita (todo el historial). Si fueran la misma
   tabla, ese campo tendría que rediseñarse — es una señal de que representan conceptos distintos.

## 1.4 Relación entre ambas

**1:1 opcional, en ambas direcciones, en v1.**

```
customers.wa_contact_id   UUID NULL REFERENCES wa_contacts(id)
```

- Opcional porque un `customer` puede no tener `wa_contact` (nunca escribió ni se le envió
  template) y un `wa_contact` puede no tener `customer` vinculado (edge case: número que escribió
  pero cuyo teléfono no coincide con ningún pedido — hoy sí ocurriría con `findOrderByPhone()`
  devolviendo `null`).
- Nunca 1:N en v1: un `wa_contact` (un número, una tienda) corresponde a lo sumo a un `customer`
  (mismo número, misma tienda) — ambos ya comparten la misma unicidad
  `(store_id, phone_normalized)`. La única forma de que un cliente tenga *dos* `wa_contacts` sería
  que escribiera desde dos números distintos — se modela con `customer_identifiers` (sección 2),
  no con una relación 1:N en `customers.wa_contact_id`.
- El FK vive en `customers` (no en `wa_contacts`) para no tocar el esquema del Inbox — coherente
  con el Principio de que `customers` es la capa nueva que se adapta a lo existente, no al revés.

## 1.5 Qué ocurre si un cliente nunca escribe por WhatsApp

`customers.wa_contact_id` queda `NULL` indefinidamente. Es el caso normal para un cliente cuyo
único contacto es la compra en Shopify y a quien el cron de confirmación (`wa-template-queue`)
todavía no le haya generado un `wa_contact` (ej. si el job falló, o si el pedido es anterior a que
ese flujo se activara). No es un estado de error — el perfil de `customers` sigue siendo completo
para todo lo comercial (RFM, LTV, comportamiento COD); simplemente no tiene canal WhatsApp
vinculado todavía.

## 1.6 Qué ocurre si un `wa_contact` nunca compra

Queda sin ningún `customers` que apunte a él (`customers.wa_contact_id` de nadie referencia esa
fila). Es un estado válido y esperado — alguien preguntó por WhatsApp y no compró. **No se crea un
`customer` vacío solo porque existe un `wa_contact`** — `customers` nace de señal comercial
(pedido o carrito abandonado), nunca de una conversación sin transacción asociada. Si más adelante
esa persona compra, el flujo de resolución de identidad (sección 2.5) crea el `customer` en ese
momento y lo vincula al `wa_contact` ya existente por coincidencia de `phone_normalized`.

## 1.7 Fuente de verdad por campo

| Campo | Fuente de verdad |
|---|---|
| Nombre | `customers.full_name` — pero **nunca** se sobreescribe con `wa_contacts.display_name` (nombre de perfil de WhatsApp, con frecuencia un apodo o el nombre de otra persona del hogar — no confiable). El nombre de `customers` viene de `orders.customer_name` (Shopify) o de una edición manual de agente. `wa_contacts.display_name` se muestra en el Inbox como lo que es (nombre de perfil de WhatsApp), nunca se copia sobre la identidad comercial. |
| Teléfono | `customers.phone_primary` (y `customer_identifiers` para alternativos) — fuente original al crear el `customer`, nunca `wa_contacts.phone_normalized` en sentido inverso (la relación se resuelve por igualdad de valor, no por copia). |
| Email | `customers.email`, si Shopify lo manda (hoy no se persiste en `orders` — ver riesgo en sección 14). `wa_contacts` no tiene ni tendrá email. |
| Consentimiento | `customers.marketing_opt_in`/`do_not_contact` exclusivamente. `wa_conversations.ai_enabled` es un concepto distinto (si Génesis puede responder automáticamente en ese hilo) — no se debe confundir con consentimiento de marketing. |
| Métricas comerciales (RFM, LTV, comportamiento COD) | `customers` exclusivamente — nunca derivable de `wa_contacts`. |
| Identidad Shopify (`shopify_customer_id`) | `customers` exclusivamente (campo nuevo, hoy no capturado en ningún lado). |
| Preferencias de WhatsApp (ventana de 24h abierta, `ai_enabled`, agente asignado al hilo) | `wa_conversations`/`wa_contacts` exclusivamente — son operativas del Inbox, `customers` las **lee** (para `canReceiveBroadcast()`, sección 5) pero nunca las posee ni las duplica. |

## 1.8 Cómo se evita información contradictoria

- **Ningún campo se duplica entre las dos tablas salvo el teléfono**, y el teléfono es
  precisamente la clave de unión (`phone_normalized`), no un dato duplicado con riesgo de
  divergencia — es la misma cadena, escrita por el mismo normalizador (`normalizePhoneRD`,
  sección 3), en dos lugares por diseño (igual que `wa_messages.store_id` ya está denormalizado
  hoy a propósito, `030_whatsapp_base.sql:82-85`).
- `customers` **lee** de `wa_contacts`/`wa_conversations` (para `engagement_score`,
  `last_message_at`, elegibilidad de broadcast) — nunca escribe sobre ellas.
- El nombre es el único campo con riesgo real de "verse distinto" en dos lugares
  (`customers.full_name` vs `wa_contacts.display_name`) — se resuelve **por diseño de UI, no de
  esquema**: la UI del Inbox siempre muestra el nombre comercial (`customers.full_name`) como
  encabezado si existe, y el `display_name` de WhatsApp como subtítulo secundario ("perfil de
  WhatsApp: ..."), nunca se fusionan en un solo valor.

## 1.9 ¿`customers` agrega valor suficiente sobre `wa_contacts`, o es sobre-ingeniería?

Sí lo agrega, y no es opcional para lo que pide la Fase 0 original (RFM, segmentos, COD risk,
consentimiento de marketing) — ninguno de esos conceptos tiene un lugar razonable dentro de
`wa_contacts` sin romper su propósito actual (objeto operativo del Inbox, con RLS pensado para
agentes de atención, no para roles de marketing). La alternativa más simple evaluada y descartada:
agregar columnas de RFM/consentimiento directamente a `wa_contacts` — se descarta porque
**la mayoría de los clientes (2,849 identidades únicas por teléfono en `orders` hoy, contra solo
193 `wa_contacts`) no tiene ni tendrá un `wa_contacts` en el corto plazo** (ver dato real en
sección 7.1) — un motor de RFM/segmentos apoyado en `wa_contacts` dejaría fuera al 93% de la base
de clientes real. `customers` tiene que existir independientemente de si el cliente usa WhatsApp o
no.

---

# 2. Identidad y deduplicación

## 2.1 Por qué el teléfono normalizado no basta por sí solo

Es necesario pero no suficiente. Casos reales que un solo campo `phone_primary` no puede
representar:

| Caso | Qué pasa si solo hay `phone_primary` | Solución |
|---|---|---|
| Cliente cambia de número | El `customer` viejo queda huérfano; se crea un `customer` nuevo sin historial | `customer_identifiers` con el número viejo marcado `active=false`, `replaced_by` apuntando al nuevo identificador |
| Cliente usa dos números (personal + trabajo) | Dos `customers` distintos, LTV partido en dos, RFM subestimado en ambos | `customer_identifiers` — segundo número como `is_primary=false` bajo el mismo `customer_id`, detectado por nombre+dirección coincidentes (revisión humana, nunca automático — ver 2.5) |
| Familiares comparten un número | Varias personas aparecen como "un cliente" — LTV/RFM sobreestimados, insights de Génesis mezclados entre personas distintas | **No se resuelve en v1.** Es un problema de identidad de persona física que el teléfono no puede resolver por diseño — se documenta como riesgo abierto (sección 14), no se inventa una heurística sin señal real para separarlos |
| Teléfono reciclado (la operadora lo reasigna a otra persona) | El nuevo dueño hereda el historial comercial del anterior | **No detectable automáticamente hoy** (no hay señal de "este número cambió de dueño"). Mitigación parcial: si el nombre en un pedido nuevo no coincide con `customers.full_name` para el mismo teléfono, se genera una alerta de posible duplicado (sección 2.5) en vez de fusionar silenciosamente |
| Pedido con teléfono incorrecto (dígito mal tecleado) | Se crea un `customer` fantasma de una sola compra | No se corrige automáticamente — es indistinguible de un cliente real nuevo sin señal adicional. Se beneficia indirectamente de la validación de formato en `normalizePhone()` (sección 3), que al menos descarta números claramente inválidos |
| WhatsApp con teléfono distinto al del pedido | `wa_contacts.order_id` ya falla en vincularse hoy (`findOrderByPhone()` no encuentra match) | Mismo comportamiento en v1: el `customer` se crea desde el pedido; el `wa_contact` con el teléfono distinto queda como identidad separada hasta que un agente confirme manualmente que es la misma persona (merge manual, 2.5) |
| Mismo número en dos tiendas | Hoy: dos filas `wa_contacts` (`UNIQUE(store_id, phone_normalized)`) sin relación | Mismo patrón en `customers`: dos filas independientes, sin relación automática (Principio de multitienda, sección 10). Relación opcional vía `global_person_id` diferido, no en v1 |
| Mismo cliente de Shopify con varios teléfonos | Shopify sí modela esto internamente, pero `shopify_customer_id` nunca se ha capturado en este sistema hasta ahora | Cuando se capture `shopify_customer_id` (Fase 1), un mismo `shopify_customer_id` con teléfonos distintos entre pedidos es la señal más fuerte de duplicado — mayor prioridad que coincidencia de nombre |
| Pedidos sin teléfono válido | Hoy ocurre (`customer_phone IS NULL` es posible en `orders`) | Esos pedidos **no generan `customer`** en el backfill ni en tiempo real — quedan fuera del motor de identidad hasta que tengan un teléfono válido. Se cuentan y reportan como "pedidos sin identidad resoluble" (sección 12) |
| Teléfonos dominicanos y extranjeros | `normalizePhoneRD()` asume RD (agrega `1` si son 10 dígitos) — un número extranjero de 10 dígitos se normalizaría incorrectamente como si fuera dominicano | Contrato de `normalizePhone()` (sección 3) debe distinguir código de país explícitamente, no asumir RD por defecto en el helper canónico nuevo |

## 2.2 `customer_identifiers` — campos evaluados uno por uno

El prompt lista 12 campos candidatos. No todos se justifican para v1:

| Campo | ¿Se incluye en v1? | Razón |
|---|---|---|
| `identifier_type` | ✅ Sí | Necesario — `'phone' \| 'email' \| 'shopify_customer_id'` (mismo enum ya usado en el diseño original) |
| `normalized_value` | ✅ Sí, renombrado `value_normalized` (consistencia con el resto del esquema, que usa `snake_case` descriptivo — ej. `phone_normalized` en `wa_contacts`) | Es la clave de búsqueda real |
| `source` | ✅ Sí | `'shopify_webhook' \| 'whatsapp_webhook' \| 'manual'` — auditoría de procedencia, mismo patrón que `orders.source` ya usa hoy |
| `active` | ✅ Sí | Necesario para el caso "cliente cambia de número" (2.1) sin borrar el histórico |
| `primary` (renombrado `is_primary`) | ✅ Sí | Distingue el identificador principal (denormalizado también en `customers.phone_primary` por performance) de los secundarios |
| `replaced_by` | ✅ Sí, como `UUID NULL REFERENCES customer_identifiers(id)` | Necesario para "cliente cambia de número" — encadena identificadores sin perder el historial |
| `valid_from` / `valid_to` | ❌ No en v1 — se cubre con `active` + `created_at`/`detected_at` | Un rango de validez explícito (`valid_from`/`valid_to`) implica que un identificador puede tener múltiples períodos de vigencia (ej. reusar un número después de dejarlo) — caso real pero de rareza suficientemente baja para no justificar la complejidad ahora. `active=false` + `replaced_by` cubre el caso dominante (número descontinuado una vez). Se documenta como extensión de v2 si aparece el caso real. |
| `verified_at` | ❌ No en v1 | No hay ningún mecanismo de verificación de teléfono en el sistema hoy (no hay OTP, no hay doble opt-in) — incluir el campo sin ningún proceso que lo escriba sería aspiracional, exactamente lo que este documento debe evitar |
| `confidence` | ✅ Sí | Necesario para distinguir identificadores de alta confianza (viene de un pedido pagado) de baja confianza (coincidencia de nombre sugerida por un agente, pendiente de confirmar) |

**Esquema final de `customer_identifiers` (ver también sección 8 técnica más abajo, definición
completa consolidada):**

```
id                UUID PK
customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE
identifier_type   TEXT NOT NULL CHECK (identifier_type IN ('phone','email','shopify_customer_id'))
value_normalized  TEXT NOT NULL
is_primary        BOOLEAN NOT NULL DEFAULT false
active            BOOLEAN NOT NULL DEFAULT true
confidence        NUMERIC(4,3) NOT NULL DEFAULT 1.000   -- 1.000 = fuente transaccional directa
source            TEXT NOT NULL CHECK (source IN ('shopify_webhook','whatsapp_webhook','manual'))
replaced_by       UUID REFERENCES customer_identifiers(id)
detected_at       TIMESTAMPTZ NOT NULL DEFAULT now()
UNIQUE (identifier_type, value_normalized)   -- un mismo valor no puede pertenecer a 2 customers a la vez
```

El `UNIQUE` global (no por `customer_id`) es intencional: es la restricción que **impide** que dos
`customers` reclamen el mismo teléfono simultáneamente — es la barrera dura contra duplicados
silenciosos, no solo una ayuda de búsqueda.

## 2.3 Estrategia de identidad — los 7 procesos pedidos

**1. Creación inicial de identidad.** `resolveOrCreateCustomer(store_id, phone_raw, source)`:
normaliza el teléfono (sección 3), busca en `customer_identifiers` por
`(identifier_type='phone', value_normalized)` con `active=true`. Si existe, retorna el
`customer_id` encontrado. Si no existe, crea `customers` + `customer_identifiers` (`is_primary=true`,
`confidence=1.000`) en la misma transacción.

**2. Vinculación automática.** Ocurre solo por **coincidencia exacta de identificador ya
existente** — nunca por similitud de nombre/dirección en automático. Ejemplo: un pedido nuevo
llega con un teléfono que ya está en `customer_identifiers` (aunque no sea el primario) → se
vincula al `customer_id` existente automáticamente, sin intervención humana, porque la coincidencia
es exacta y de alta confianza.

**3. Detección de posible duplicado.** Señales que generan una fila en una cola de revisión (no
una tabla nueva pedida en este documento — se apoya en `customer_insights` con
`insight_code='possible_duplicate'`, catálogo controlado, sección 8):
   - Mismo `shopify_customer_id` con teléfonos distintos entre pedidos (señal fuerte).
   - Nombre idéntico o muy similar (comparación exacta normalizada, no fuzzy-matching en v1) +
     misma ciudad, con teléfonos distintos.
   - Un pedido nuevo con un teléfono ya usado por otro `customer`, pero con un nombre
     completamente distinto (señal de posible teléfono reciclado — alerta, no fusión).
   Todas estas señales **solo generan una alerta visible para un agente/admin**. Ninguna fusiona
   automáticamente.

**4. Merge manual.** Un endpoint admin-only (`POST /api/customers/merge`, diseño para Fase 1,
sin implementar aquí) recibe `(customer_id_winner, customer_id_loser)`. Efecto:
   - Todos los `customer_identifiers` del perdedor se reasignan (`customer_id = winner`),
     conservando su `source`/`detected_at` original.
   - Todos los `customer_events` del perdedor se reasignan (`customer_id = winner`) — **nunca se
     borran ni se re-escriben**, solo cambia el FK.
   - `customer_segment_memberships` del perdedor se recalculan en el próximo ciclo (no se copian
     a mano — podrían ya no aplicar con los datos combinados).
   - El perdedor queda con `merged_into_customer_id` (tombstone) — la fila **no se borra**, para
     que cualquier referencia histórica externa (ej. un log viejo) siga siendo resoluble.
   - Las métricas (RFM/LTV/comportamiento) del ganador se recalculan por completo desde
     `customer_events` combinados en el siguiente recompute (nunca se suman a mano — sumar a mano
     arriesga contar dos veces si algún evento ya estaba duplicado entre ambos perfiles).

**5. Split de perfiles fusionados por error.** Reversa del merge: requiere que el merge haya
guardado suficiente metadata para deshacerse — específicamente, el `merged_into_customer_id`
tombstone conserva el `id` original del perdedor, y el reasignado de `customer_identifiers`/
`customer_events` conserva `detected_at`/`occurred_at` originales (nunca se sobreescriben al
mover el FK). Un split manual (mismo endpoint, operación inversa, Fase 1+) puede reconstruir el
perfil perdedor filtrando por esos timestamps originales. **No se garantiza un split perfecto si
ya se generaron eventos *nuevos* después del merge que mezclan actividad de ambos** — se documenta
como limitación conocida, no se pretende que el split sea trivial en todos los casos.

**6. Conservación de historial.** Ya cubierto arriba — ningún merge borra filas, todo es
reasignación de FK + tombstone.

**7. Idempotencia.** `resolveOrCreateCustomer()` es idempotente por diseño: dos llamadas
concurrentes con el mismo teléfono deben converger a un solo `customer` — se resuelve con el mismo
patrón que ya usa `wa_contacts` hoy ante race conditions (`INSERT ... ON CONFLICT`, con re-fetch en
código `23505`, ver `whatsapp/route.ts:412-426`), replicado tal cual para `customer_identifiers`.

## 2.4 Regla explícita: nunca merge automático irreversible basado solo en teléfono

Cerrado en el diseño de arriba: la única vinculación automática es por **coincidencia exacta de un
identificador que ya pertenece a ese cliente** (2.3, punto 2) — nunca por inferencia/similitud. Todo
lo demás (2.3, punto 3) genera una alerta, nunca una fusión.

---

# 3. Normalización de teléfono

## 3.1 Auditoría de los dos normalizadores existentes

| | `src/lib/normalize-phone.ts` (`normalizePhoneRD`) | `src/lib/admin/reconcile-guide.ts:70` (`normalizePhone`) |
|---|---|---|
| **Formato de salida** | 11 dígitos con prefijo `1` (ej. `18091234567`) | 10 dígitos sin prefijo de país (ej. `8091234567`) |
| **Lógica** | `10 dígitos → antepone '1'`; `11 dígitos que empiezan en '1' → tal cual`; `>11 dígitos → '1' + últimos 10` | `11 dígitos que empiezan en '1' → quita el '1'`; `>10 dígitos → últimos 10`; si no, tal cual |
| **Asume país** | Sí, siempre RD (antepone `1` sin verificar código de área) | Sí, siempre descarta el código de país asumiendo que es `1` |
| **Callers actuales** | `src/app/api/admin/wa-test-send/route.ts`, `src/app/api/orders/[id]/whatsapp-conversation/route.ts`, `src/app/api/webhooks/shopify/orders/route.ts`, `src/app/api/webhooks/whatsapp/route.ts`, `src/lib/deliveries/whatsapp-link.ts`, `src/lib/deliveries/conversations.ts` — **6 sitios**, incluidos los dos webhooks principales (Shopify, WhatsApp) | `src/app/api/admin/reconcile-efi-guide/route.ts`, `src/app/api/admin/reconcile-efi-guides-batch/route.ts`, `src/app/api/admin/reconcile-efi-import/route.ts`, `src/app/api/admin/backfill-imported-order-data/route.ts` — **4 sitios**, todos herramientas admin de reconciliación de guías EFI, ninguno en el pipeline de escritura de `orders.customer_phone` en tiempo real |
| **Qué escribe en DB** | `orders.customer_phone` (fuente original, en el INSERT del webhook), `wa_contacts.phone_normalized` | Nada directamente — se usa para comparar (`ilike`) contra `orders.customer_phone` ya almacenado, con matching parcial de 7 dígitos |

## 3.2 Cuál debe quedar como canónico

**`normalizePhoneRD` (formato 11 dígitos con prefijo `1`) es el canónico**, porque:
1. Ya es el formato que **escriben** los dos webhooks de entrada de datos (Shopify y WhatsApp) —
   es decir, ya es el formato real almacenado en `orders.customer_phone` y
   `wa_contacts.phone_normalized` hoy. Cambiarlo significaría re-normalizar datos ya persistidos.
2. Es el formato compatible con E.164 sin el `+` (que es literalmente lo que Meta usa como `wa_id`
   en los payloads de WhatsApp) — más alineado con el estándar internacional que un formato de 10
   dígitos que descarta el código de país.
3. `reconcile-guide.ts:normalizePhone()` es de menor criticidad (4 endpoints admin de
   reconciliación EFI, no en el camino crítico de creación de pedidos) y ya tolera formatos
   heterogéneos vía `ilike` de 7 dígitos — es decir, su propio diseño ya asume que no puede confiar
   en un formato exacto, lo cual confirma que no es el candidato a canónico.

## 3.3 Riesgo de cambiarlo y estrategia de migración

**Riesgo de unificar en Fase 1:** bajo. `reconcile-guide.ts:normalizePhone()` solo se usa para
comparar contra `orders.customer_phone` (que ya está en formato `normalizePhoneRD`) — si se
reemplaza por `normalizePhoneRD` y se ajusta el matching de `ilike` de 7 dígitos para operar sobre
el nuevo formato de 11 dígitos, el comportamiento observable no cambia (el matching de 7 dígitos
finales es agnóstico al prefijo). El blast radius es exactamente 4 archivos, todos herramientas
admin de bajo tráfico (reconciliación manual de guías EFI, no un flujo automático de alto volumen).

**Estrategia de migración (para cuando se implemente, Fase 1 — no en este documento):**
1. `reconcile-guide.ts` importa `normalizePhoneRD` en vez de definir su propia función.
2. Se elimina la función local `normalizePhone()` de ese archivo.
3. Los 4 call sites no cambian su lógica de negocio — solo el formato interno de comparación
   (el `ilike` de 7 dígitos finales sigue funcionando igual, porque los últimos 7 dígitos no
   cambian entre ambos formatos).
4. `npx tsc --noEmit` + prueba manual de un caso de reconciliación real antes de mergear — mismo
   estándar de evidencia que el resto del proyecto.

Esto se agrega a la Fase 1 del roadmap (sección 13) como tarea de limpieza de bajo riesgo, no como
bloqueante — el Customer Intelligence Engine no depende de que se elimine el duplicado, solo debe
evitar crear un tercero.

## 3.4 Contrato único — `normalizePhone()` (diseño, no implementado)

No se implementa el helper en esta fase (instrucción explícita). El contrato que debe cumplir
cuando se construya:

```typescript
interface NormalizedPhone {
  normalized_e164: string | null   // "+18091234567" — con '+', formato E.164 real
  country_code:    string | null   // "1" (RD y el resto de NANP comparten código de país)
  national_number: string | null   // "8091234567" — 10 dígitos, sin código de país
  valid:           boolean
  reason:          string | null   // 'too_short' | 'too_long' | 'invalid_area_code' | null si valid=true
}

function normalizePhone(raw: string, defaultCountry?: 'DO'): NormalizedPhone
```

**Manejo explícito de casos, para cuando se implemente:**

| Input | Comportamiento esperado |
|---|---|
| `+1 809 123 4567` | Se limpia a dígitos, detecta código de país `1` explícito por el `+`, separa `national_number` |
| `1 809 123 4567` (sin `+`) | Ambiguo entre "código de país 1 + número de 10" y "número de 11 dígitos sin código" — para RD, ambas lecturas coinciden (NANP), se resuelve igual que `normalizePhoneRD` hoy |
| `809-123-4567`, `(809) 123 4567` | Se limpian guiones/espacios/paréntesis antes de contar dígitos |
| Código de área `809`/`829`/`849` (RD) | Se reconoce como número dominicano válido — pero el helper **no debe rechazar** otros códigos de área NANP (no todo número de 10 dígitos es dominicano — clientes con número de EEUU/Puerto Rico son posibles) |
| Extensión (`ext. 123`, `x123`) | Se descarta la extensión, se normaliza solo la parte principal — no aplica a WhatsApp (no tiene extensiones) pero sí puede aparecer en datos importados por CSV histórico |
| Número internacional no-NANP (ej. España `+34...`) | Se normaliza con su propio código de país, **no se fuerza el prefijo `1`** — corrige el defecto real de `normalizePhoneRD` (sección 2.1, fila "teléfonos dominicanos y extranjeros") |
| Menos de 7 dígitos totales, o solo ceros/repetidos | `valid=false`, `reason='too_short'` o `'invalid_pattern'` — nunca se usa como identificador |
| Vacío / null | Retorna objeto con todos los campos `null`, `valid=false`, `reason='empty'` |

**Nota de migración:** `normalizePhoneRD` seguirá existiendo como wrapper delgado
(`normalizePhoneRD(raw) = normalizePhone(raw, 'DO').normalized_e164?.replace('+', '') ?? ''`)
mientras el código legado la siga llamando — no se fuerza una migración masiva de los 6 call sites
actuales en la Fase 1, solo del nuevo motor de identidad, que usa el contrato completo desde el
día uno.

---

# 4. `customer_events` vs historiales existentes

## 4.1 Decisión de forma: tabla física, no vista

Se evaluaron las 4 opciones pedidas:

| Opción | Veredicto |
|---|---|
| Tabla física | ✅ **Elegida** |
| Vista `UNION` sobre `orders`/`agent_actions`/`wa_messages` | ❌ Rechazada — un `UNION` en vivo sobre 3+ tablas con volúmenes crecientes (`orders` ya tiene 3,368 filas y crece a diario) sería progresivamente más lento para el timeline de un cliente, y no permite `idempotency_key` ni `metadata` semántico propio por evento (cada tabla origen tiene su propia forma, forzar una vista UNION requeriría normalizar columnas dispares en cada query) |
| Materialized view | ❌ Rechazada — requeriría refresh completo o incremental complejo para mantenerse al día en near-real-time (un evento de WhatsApp debe reflejarse en segundos, no en el próximo refresh nocturno), y Postgres no soporta refresh incremental nativo de materialized views sin extensiones adicionales que este proyecto no usa hoy |
| Tabla de eventos canónicos alimentada por triggers/app | ✅ Es la misma opción elegida — **alimentada por código de aplicación, explícitamente NO por triggers de Postgres** (Principio 1: nunca un trigger de DB sobre `orders` que pueda interferir con el pipeline COD ya congelado) |

## 4.2 Deslinde explícito — qué vive dónde

| Tabla | Qué sigue viviendo ahí, sin cambios | Por qué no se reemplaza |
|---|---|---|
| `agent_actions` | Auditoría operativa **por pedido**: qué hizo un agente, notas de texto, `contact_result` | Alimenta hoy `/mi-rendimiento`, `/reparto`, `/sd-delivery`, pagos sugeridos de agentes — tocar su forma rompería reportes en producción activa |
| `order_history` | Auditoría automática de cambios de campo (`field`, `old_value`, `new_value`) vía trigger de DB ya existente | Es forense a nivel de columna, no semántico — sirve para debugging, no para timeline de cliente |
| `wa_messages` | El texto/payload completo de cada mensaje | `customer_events` nunca copia el `body` completo — solo referencia `source_id` hacia `wa_messages.id` |
| `shopify_sync_log` | Auditoría de escrituras hacia Shopify (fulfillment, mark_paid) | Es log técnico de integración, no evento de negocio orientado a cliente |
| **`customer_events` (nueva)** | Proyección semántica, por cliente, de los eventos que importan para marketing/RFM/segmentos — un evento por hecho de negocio, no por cada escritura técnica | Es la denormalización deliberada para no tener que hacer JOIN de 3-4 tablas en cada consulta de timeline de cliente |

## 4.3 Tabla de eventos — fuente, `source_table`, `source_id`, `idempotency_key`, copia vs referencia

| `event_type` | Se escribe cuando | `source_table` | `source_id` | `idempotency_key` | ¿Copia o referencia? | Quién escribe | Riesgo de duplicación |
|---|---|---|---|---|---|---|---|
| `order_created` | INSERT en `orders` desde webhook Shopify | `orders` | `order.id` | `order_created:{order.id}` | Referencia (no copia `product_summary` completo, solo `order_id` en `metadata`) | Código de aplicación, mismo webhook | Bajo — el webhook ya es idempotente por `shopify_order_id` |
| `order_confirmed` | `applyConfirmationAction()`, rama `confirmed` | `orders` | `order.id` | `order_confirmed:{order.id}` | Referencia | `applyConfirmationAction()` — único punto autorizado, ya documentado como tal en `ARCHITECTURE_RUTA_COD_V1.md` | Bajo — un pedido solo se confirma una vez por diseño del propio contrato COD |
| `order_reopened` | RPC `reopen_confirmed_order` (migración `052`) | `orders` | `order.id` | `order_reopened:{order.id}:{occurred_at}` (puede repetirse) | Referencia | Código de aplicación que invoca el RPC | Medio — un pedido puede reabrirse más de una vez; el `idempotency_key` incluye el timestamp para permitirlo sin duplicar el mismo evento exacto |
| `order_cancelled` | `applyConfirmationAction()`, rama cancelación | `orders` | `order.id` | `order_cancelled:{order.id}` | Referencia | `applyConfirmationAction()` | Bajo |
| `order_dispatched` | `autoAssignSdOrder()` / `dispatch-local` | `orders` | `order.id` | `order_dispatched:{order.id}` | Referencia | Código de aplicación | Bajo |
| `order_delivered` | `markSdOrderDelivered()` **o** cron EFI al detectar `delivered` | `orders` | `order.id` | `order_delivered:{order.id}` | Referencia | Ambos — mismo `idempotency_key` determinístico garantiza que solo el primero en llegar escribe (`ON CONFLICT DO NOTHING`) | Medio, mitigado por el `idempotency_key` fijo (no incluye timestamp — un pedido se entrega una sola vez de verdad) |
| `order_paid` | `payment-status.ts` (case `'paid'`) | `orders` | `order.id` | `order_paid:{order.id}` | Referencia | Código de aplicación | Bajo |
| `order_returned` | Cron EFI al detectar `returned`/`Anulada` | `orders` | `order.id` | `order_returned:{order.id}` | Referencia | Cron | Bajo |
| `whatsapp_message_received` | `processInboundMessage()` | `wa_messages` | `wa_messages.id` | `wa_message:{wa_msg_id}` | Referencia | Webhook WhatsApp | Prácticamente nulo — reusa el mismo `wa_msg_id` de Meta que ya es `UNIQUE` en `wa_messages` |
| `whatsapp_message_sent` | Endpoint outbound del Inbox + cron `wa-template-queue` | `wa_messages` | `wa_messages.id` | `wa_message:{wa_msg_id}` | Referencia | Código de aplicación + cron | Igual que arriba |
| `conversation_classified` | Génesis escribe un `customer_insights` nuevo | `customer_insights` | `customer_insights.id` | `insight:{customer_insights.id}` | Referencia | Génesis, vía función validadora (nunca INSERT directo) | Bajo — 1:1 con la fila de insight que lo origina |
| `tag_added` / `tag_removed` | Endpoint de tags manuales (Fase 4) | `customer_insights` | `customer_insights.id` | `tag:{customer_insights.id}:{added\|removed}` | Referencia | Código de aplicación | Bajo |
| `campaign_sent` / `_delivered` / `_read` / `_replied` / `_converted` | Sistema de Broadcast (no implementado — Fase 6) | tabla de campañas futura | — | — | — | Futuro | — |
| `consent_granted` / `consent_revoked` | Endpoint de opt-out + palabra clave detectada | `customers` | `customer.id` | `consent:{customer.id}:{granted\|revoked}:{occurred_at}` | Referencia | Código de aplicación | Bajo — incluye timestamp porque el consentimiento puede cambiar de estado más de una vez en la vida de un cliente |
| `cart_abandoned` / `cart_recovered` | Sync de `abandoned_carts` / auto-recover del webhook Shopify | `abandoned_carts` | `abandoned_carts.id` | `cart:{abandoned_carts.id}:{abandoned\|recovered}` | Referencia | Código de aplicación | Bajo |

**Regla general de "copia vs referencia":** `customer_events` **nunca copia contenido largo**
(texto de mensaje, notas, `product_summary` completo) — siempre referencia por
`(source_table, source_id)` y guarda en `metadata JSONB` solo lo mínimo necesario para renderizar
el timeline sin un JOIN adicional en el caso común (ej. `{ "order_number": "#8712", "cod_amount":
2100 }` para `order_paid`, no el pedido completo).

---

# 5. Consentimiento y supresión

## 5.1 Campos evaluados (los 12 del prompt, uno por uno)

| Campo pedido | ¿Se incluye? | Dónde vive |
|---|---|---|
| `marketing_opt_in` | ✅ | `customers.marketing_opt_in BOOLEAN` |
| `marketing_opt_out` | ❌ — es el mismo dato que `marketing_opt_in=false`, no un campo aparte | — |
| `do_not_contact` | ✅ | `customers.do_not_contact BOOLEAN` — bloqueo total, más fuerte que solo marketing (ej. pedido explícito de "no me llamen ni escriban por nada") |
| `blocked_by_user` | ❌ — se modela como `do_not_contact=true` + `suppression_reason='user_requested'` | — |
| `invalid_phone` | ✅, pero vive en `customer_identifiers.active=false` con una razón, no en `customers` | Un teléfono inválido es un problema del identificador, no del cliente completo (puede tener otro teléfono válido) |
| `legal_hold` | ✅ | `customers.suppression_reason='legal_hold'` — ver distinción de `do_not_contact` vs supresión temporal más abajo |
| `sensitive_conversation` | ✅, pero como `customer_insights` (`insight_code='legal_threat'`, `'adverse_reaction'`, sección 8), no como campo booleano suelto | Ya es del dominio de insights — duplicarlo como campo de `customers` violaría el principio de catálogo único |
| `temporary_suppression` | ✅ | `customers.suppression_until TIMESTAMPTZ NULL` — si está poblado y en el futuro, cuenta como supresión activa sin necesidad de un booleano aparte |
| `suppression_reason` | ✅ | `customers.suppression_reason TEXT` — catálogo controlado: `'user_requested' \| 'legal_hold' \| 'adverse_reaction' \| 'invalid_phone_all' \| 'complaint'` |
| `suppression_until` | ✅ | Ver arriba — cubre "temporal" sin campo booleano redundante |
| `source` | ✅ | Como evento, no como columna — `consent_granted`/`consent_revoked` en `customer_events` ya llevan `source`/`actor_type` |
| `recorded_at` / `recorded_by` | ✅ | Mismo — `customer_events.occurred_at`/`actor_id` ya cubren esto sin duplicar columnas en `customers` |

**Esquema final agregado a `customers` (sección 8, ya reflejado):**
```
marketing_opt_in     BOOLEAN NOT NULL DEFAULT true
do_not_contact       BOOLEAN NOT NULL DEFAULT false
suppression_reason   TEXT CHECK (suppression_reason IN (
                        'user_requested','legal_hold','adverse_reaction',
                        'invalid_phone_all','complaint'
                      ))
suppression_until    TIMESTAMPTZ
```

## 5.2 Distinciones que el diseño mantiene separadas (pedidas explícitamente)

| Distinción | Cómo se representa |
|---|---|
| Permiso para mensajes **transaccionales** (confirmación de pedido, aviso de entrega) | **No depende de `marketing_opt_in`.** Sigue las reglas actuales de `wa_template_queue`, sin cambios — un cliente puede tener `marketing_opt_in=false` y aun así recibir la confirmación de su propio pedido, porque eso no es marketing, es operación de la compra que él mismo inició. |
| Permiso para **marketing** | `marketing_opt_in` + `do_not_contact=false` + sin `suppression_until` activo. |
| Conversación abierta de 24h (ventana de Meta) | **No es consentimiento** — es una restricción técnica de la plataforma de WhatsApp sobre qué tipo de mensaje se puede enviar (texto libre vs. solo template aprobado). Se calcula desde `wa_conversations.last_message_at`, se lee, nunca se guarda como copia en `customers`. |
| Uso de template aprobado | Restricción técnica de Meta, ortogonal al consentimiento — un template aprobado puede enviarse fuera de la ventana de 24h, pero **eso tampoco implica que el cliente dio consentimiento de marketing** — son ejes independientes que `canReceiveBroadcast()` evalúa por separado. |
| Solicitud explícita de no recibir promociones | `marketing_opt_in=false`, evento `consent_revoked` con `metadata.reason='explicit_request'`. |
| Bloqueo técnico del número (número inválido, desconectado) | `customer_identifiers.active=false` para ese identificador — si es el único teléfono válido, `customers` efectivamente no es contactable pero **no se marca `do_not_contact`** (esa bandera es para decisión del cliente, no para un problema técnico — mezclar ambas cosas ocultaría la causa real en un reporte). |
| Bloqueo por riesgo/reacción adversa | `suppression_reason='adverse_reaction'` — el más fuerte, nunca debería revertirse automáticamente ni por recompute (requiere acción manual explícita de un admin para levantar la supresión). |

## 5.3 `canReceiveBroadcast(customer_id, campaign_context)` — diseño conceptual

No implementado en v1 (Broadcast no se construye todavía). Enumeración completa de causas de
exclusión, en el orden en que se evaluarían (short-circuit — la primera que aplique excluye):

```
canReceiveBroadcast(customer_id, campaign_context):
  1. customer.do_not_contact = true                          → excluido: "do_not_contact"
  2. customer.marketing_opt_in = false                        → excluido: "opt_out"
  3. customer.suppression_until IS NOT NULL AND > now()       → excluido: "temporary_suppression"
  4. customer.suppression_reason IS NOT NULL                  → excluido: suppression_reason literal
  5. no existe customer_identifiers activo de type='phone'    → excluido: "no_valid_phone"
  6. wa_contact vinculado tiene un insight activo
     insight_code IN ('legal_threat','adverse_reaction')      → excluido: "sensitive_case"
  7. wa_conversation activa con status='pending'
     Y assigned_to IS NOT NULL (intervención humana en curso) → excluido: "active_escalation"
  8. existe pedido activo que excluye promoción (sección 6)   → excluido: "active_order"
  9. customer.store_id != campaign_context.store_id           → excluido: "store_mismatch" (no debería
                                                                  ser alcanzable si el query ya filtra
                                                                  por tienda, pero se verifica explícito
                                                                  como defensa en profundidad)
  10. customer_id ya está en campaign_recipients de esta
      misma campaña (snapshot ya congelado)                   → excluido: "already_targeted"

  Si ninguna aplica → elegible, con razón "eligible"
```

Cada exclusión se puede reportar con su motivo — necesario para que un admin entienda por qué un
segmento de 500 clientes solo generó 310 destinatarios reales.

**Nota:** las reglas legales específicas de mercadeo en RD (ej. requisitos de opt-in explícito
según normativa local de protección de datos/telecomunicaciones) **no se asumen resueltas aquí** —
se marca como decisión pendiente de revisión jurídica en la sección 15, no se inventa una política
legal sin respaldo.

---

# 6. Pedidos activos y exclusiones — regla V1 concreta

Cierre explícito, no diferido:

```
Un customer NO es elegible para BROADCAST DE MARKETING (no transaccional) si tiene
al menos un pedido (orders) que cumple:

  confirmation_status IN ('pending', 'confirmed')
  AND normalized_status IN ('pending', 'in_transit', 'en_reparto', 'novedad')
  AND payment_status = 'pending'
  AND created_at >= now() - INTERVAL '10 days'
```

**Justificación de cada condición:**

| Parte de la regla | Por qué |
|---|---|
| `confirmation_status IN ('pending','confirmed')` | Un pedido `cancelled`/`no_coverage`/`unreachable` ya no está "en curso" — no hay riesgo de que una promoción confunda al cliente sobre un pedido activo. |
| `normalized_status IN ('pending','in_transit','en_reparto','novedad')` | Excluye explícitamente `delivered`/`returned` — un pedido ya resuelto (entregado o devuelto) no bloquea marketing, incluso si el pago sigue `pending` por algún desfase administrativo. `novedad` se incluye a propósito: un cliente en medio de una gestión de reentrega no debería recibir una promoción simultánea que compita por su atención en WhatsApp con el mensaje operativo real. |
| `payment_status = 'pending'` | Si ya está `paid`, el ciclo comercial de ese pedido terminó del lado que le importa a Recency/Frequency — no hay razón operativa para seguir bloqueando marketing solo porque la entrega física no se ha cerrado. |
| `created_at >= now() - INTERVAL '10 days'` | Ventana de tiempo para no bloquear marketing indefinidamente si un pedido queda atascado (ej. un caso de novedad sin resolver por semanas) — 10 días es holgado frente al SLA operativo ya documentado del sistema (los propios módulos de Reparto/Tránsito marcan "crítico" a partir de 48h) — un pedido de más de 10 días sin resolver es ya una excepción operativa, no el flujo normal, y no debería seguir vetando marketing indefinidamente. |

**Alcance de la regla:**
- **Por tienda:** sí, implícitamente — la consulta de "pedido activo" siempre está scoped por
  `store_id = customer.store_id` (nunca cruza tiendas, principio 6/sección 10).
- **Por producto:** no en v1 — la regla es a nivel de cliente completo, no de producto específico.
  Diferenciar "tiene un pedido activo de Producto X, pero se le puede promocionar Producto Y" es
  una sofisticación de v2, no justificada todavía sin `order_items` estructurado (riesgo ya
  documentado).
- **Campañas de recompra:** si una campaña se define explícitamente como "solo para clientes con
  0 pedidos activos, apuntando a re-comprar algo ya entregado", esta regla V1 ya la sirve sin
  necesidad de una segunda regla — es exactamente el caso que excluye. Una campaña de "up-sell
  durante el pedido activo" (ej. "aprovecha y agrega X mientras tu pedido va en camino") sería una
  categoría de campaña *distinta*, con su propia bandera `campaign_context.allow_active_order:
  boolean` que, si es `true`, se salta el paso 8 de `canReceiveBroadcast()` (sección 5.3) — el
  diseño ya lo contempla como parámetro de contexto, no requiere una segunda regla dura.
- **Configurable:** el umbral de `10 días` se deja como constante nombrada
  (`ACTIVE_ORDER_SUPPRESSION_DAYS`), no hardcodeada sin nombre — ajustable en Fase 6 sin rediseño,
  pero **no expuesta como configuración editable por tienda en v1** (mismo criterio que los
  thresholds de RFM, sección 7 — evitar que se "ajuste a mano" sin datos que lo respalden).

---

# 7. RFM V1 — con datos reales de producción

## 7.1 Metodología

Se consultó Supabase en modo **solo lectura**, con la service role key ya presente en
`.env.local` (la misma que usan los cron jobs del sistema), desde un script temporal fuera del
repositorio (creado y eliminado en la misma sesión — no se modificó ningún archivo del proyecto).
Sin escrituras, sin `UPDATE`/`INSERT`/`DELETE` en ningún momento — únicamente `SELECT` sobre
`orders`, `wa_contacts`, `abandoned_carts`, `stores`.

## 7.2 Resultado — resumen ejecutivo de los datos

| Métrica | Valor real |
|---|---|
| Filas en `stores` | **1** ("Mi Tienda") — no hay tiendas separadas por marca todavía |
| Total de pedidos (`orders`) | 3,368 |
| Pedidos `payment_status='paid'` | 97 (**2.9%** del total) |
| Pedidos `normalized_status='delivered'` | 1,053 |
| Rango real de `paid_at` | 2026-07-20 → 2026-08-01 (**12 días** de historial) |
| Clientes únicos con al menos 1 pago (`store_id`+teléfono) | 94 |
| Distribución de frecuencia de pago | 91 clientes con 1 pago (96.8%) · 3 con 2 pagos (3.2%) · 0 con 3+ pagos (0%) |
| LTV (suma de `cod_amount` pagado, por cliente) | mediana RD$2,100 · media RD$2,223 · máximo RD$5,880 |
| Ticket promedio (`cod_amount` por pedido pagado) | mediana RD$2,100 · media RD$2,154 |
| Recencia (días desde el último `paid_at`) | rango completo 2.0 – 12.2 días (artefacto directo de que el campo tiene solo 12 días de vida) |
| Días entre compras pagadas consecutivas | solo 3 pares de datos disponibles (0.1, 0.1–1.1, 1.7–2.2 días) — **insuficiente para estimar un ciclo de recompra real** |
| Identidades únicas (`store_id`+teléfono) en **todos** los pedidos (pagados o no) | 2,849 |
| `wa_contacts` totales | 193 — de los cuales **193 (100%)** tienen `order_id` poblado |
| `abandoned_carts` totales | 1,438 |

## 7.3 Qué significa esto para el diseño

1. **Una ventana de 180 días no es una decisión informada — es una cifra sin datos detrás.** Con
   solo 12 días de `paid_at` real, cualquier ventana mayor a 12 días es hoy, en la práctica,
   equivalente a "todo el historial disponible". No tiene sentido fijar 180 como si viniera de un
   análisis de ciclo de recompra que no existe todavía.
2. **El eje de Frequency está prácticamente vacío.** 96.8% de los clientes que han pagado tienen
   exactamente 1 pago. Segmentos como "Champions" o "Loyal" (que requieren F≥3-4) tendrán
   **población real cercana a cero** durante los próximos meses — no es un error de diseño, es el
   estado real del negocio con `payment_status` recién introducido (12 días de vida).
3. **El eje de Recency está artificialmente comprimido** (todo entre 2-12 días) — no porque los
   clientes compren seguido, sino porque el campo mismo es nuevo. Un cliente que pagó hace 11 días
   no es necesariamente "reciente" en términos de negocio — es simplemente el dato más viejo que
   el sistema puede ver hoy.
4. **97 pedidos pagados es una muestra demasiado pequeña para calcular percentiles estables** —
   con esa base, el P90 de LTV (RD$2,200) prácticamente coincide con la mediana (RD$2,100): no hay
   dispersión suficiente para que los scores 1-5 por percentil sean informativos todavía.

## 7.4 Decisión V1 — conservadora, con punto de recalibración explícito

```
Recency  = días desde MAX(paid_at)                          -- sin cambios, ya es correcto
Frequency = COUNT(orders) WHERE payment_status='paid'         -- sin cambios
Monetary  = SUM(cod_amount) WHERE payment_status='paid'       -- sin cambios, restando devoluciones
                                                                -- posteriores a un pago (regla ya
                                                                -- descrita en la versión anterior de
                                                                -- este documento, sin cambios)

Ventana histórica V1 = TODO EL HISTORIAL DISPONIBLE DE payment_status
                        (no se fija un número de días todavía)

Punto de recalibración obligatorio: cuando payment_status acumule
  ≥90 días de historial real  Y  ≥500 clientes con al menos 1 pago
  (lo que ocurra después)
  → en ese momento se recalcula la ventana histórica real de recompra
    (mediana de días entre compras consecutivas, con muestra estadísticamente
    razonable) y SE REEMPLAZA "todo el historial" por una ventana rolling
    basada en ese dato real, no en una suposición.
```

**Scores 1-5 por percentil:** se mantiene el diseño original (percentiles dentro de la tienda, no
umbrales fijos) — pero con una salvedad explícita: **con menos de 500 clientes pagados en una
tienda, los scores 1-5 se calculan igual (no se bloquean), pero se marcan con
`rfm_sample_size_warning=true`** en el resultado, para que cualquier UI o reporte que los consuma
pueda mostrar "muestra pequeña, interpretar con cautela" en vez de presentar un score 1-5 como si
tuviera el mismo peso estadístico que tendría con miles de clientes.

**Segmentos finales:** el catálogo de 10 segmentos del documento anterior (Champions, Loyal,
Previously Loyal, Active, Promising, New, Needs Attention, At Risk, Almost Lost, Dormant) **se
mantiene sin cambios en su definición** — la definición por percentiles es correcta
independientemente del volumen. Lo que cambia es la expectativa: hoy, la gran mayoría de los 94
clientes pagados caerá en `New` o `Promising` (F=1), y el resto de segmentos estará casi vacío
hasta que el negocio acumule más ciclos de recompra reales. Esto **no es un defecto del diseño** —
es el reflejo honesto del estado real del negocio, y es exactamente lo que este documento debe
mostrar en vez de ocultar.

## 7.5 Casos especiales — respuestas cerradas

| Caso | Tratamiento |
|---|---|
| `paid_at` NULL | El pedido no cuenta para ningún eje del RFM (ni Frequency ni Monetary) — solo pedidos con `payment_status='paid'` entran, y esa columna ya garantiza `paid_at` poblado por diseño de la migración `046` (se setea en el mismo `UPDATE` que cambia el status). |
| Refunds/devoluciones posteriores a un pago | Ya cubierto (sección 7.4, heredado de la versión anterior): se resta del `Monetary` cuando `normalized_status='returned'` ocurre después de `order_paid` en el timeline de `customer_events`. |
| Clientes con una sola compra | Caen en `New` (0 pedidos históricos antes de ese) o `Promising` (F=1, R alto) según recencia — **es el caso dominante hoy** (96.8%), el diseño ya lo trata como el caso normal, no como excepción. |
| Nuevos clientes (0 pagos) | `rfm_segment='New'` explícito, scores R/F/M en `NULL` (no en 1) — sin cambios respecto al diseño anterior. |
| Multi-producto | No afecta el cálculo de RFM (que es agnóstico al producto, opera sobre `cod_amount` total del pedido) — el desglose por producto queda fuera de v1 por la misma razón ya documentada (no hay `order_items`). |
| Multi-tienda | Cada tienda calcula su propio RFM de forma completamente independiente — hoy es un ejercicio teórico porque solo existe 1 fila `stores`, pero el diseño ya está preparado para cuando existan más. |

---

# 8. Tags e insights — catálogo cerrado V1

## 8.1 Los 14 códigos del prompt, cerrados uno por uno

| `insight_code` | `value_type` | `category` | Duración | Confidence mínima para auto-asignar | Fuente | ¿Sobrescribible? | ¿Requiere revisión humana? | ¿Usable en Broadcast? |
|---|---|---|---|---|---|---|---|---|
| `interest_sensitivity` | boolean | `product_interest` | Expira 90 días sin refuerzo | 0.700 | genesis | Sí (nueva detección reemplaza, desactivando la anterior) | No | Sí |
| `interest_whitening` | boolean | `product_interest` | Expira 90 días | 0.700 | genesis | Sí | No | Sí |
| `interest_enamel` | boolean | `product_interest` | Expira 90 días | 0.700 | genesis | Sí | No | Sí |
| `interest_caries` | boolean | `product_interest` | Expira 90 días | 0.700 | genesis | Sí | No | Sí |
| `price_objection` | boolean | `objection` | Expira 30 días | 0.600 | genesis o manual | Sí | No | No — un cliente con objeción de precio reciente no debería recibir una promoción de precio lleno |
| `delivery_concern` | boolean | `objection` | Expira 30 días | 0.600 | genesis o manual | Sí | No | No — señal operativa, no de marketing |
| `buy_later` | enum (`value` = fecha estimada ISO) | `behavior` | Expira en la fecha indicada + 7 días de gracia | 0.500 | genesis | Sí | No | Sí — es la señal ideal para una campaña de recompra programada |
| `requested_discount` | boolean | `behavior` | Expira 30 días | 0.700 | genesis o manual | Sí | No | Sí, con cautela — puede ser candidato a oferta dirigida |
| `high_purchase_intent` | boolean | `behavior` | Expira 14 días (señal de corto plazo) | 0.750 | genesis | Sí | No | Sí — prioridad alta para seguimiento |
| `prefers_audio` | boolean | `behavior` | Permanente (preferencia estable de canal) | 0.600 | genesis | Sí | No | Sí — informa el *formato* del mensaje, no si se envía |
| `adverse_reaction` | boolean | `risk` | **No expira** | 0.900 (umbral alto — falso positivo es costoso) | genesis o manual | No — una vez `true`, solo un admin lo desactiva manualmente | **Sí, siempre** | **No, nunca** — dispara `suppression_reason='adverse_reaction'` automáticamente |
| `legal_threat` | boolean | `risk` | **No expira** | 0.850 | genesis o manual | No | **Sí, siempre** | **No, nunca** |
| `fraud_risk` | boolean | `risk` | Expira 60 días (reevaluable) | 0.700 | genesis | Sí | Sí, antes de cualquier acción de cobranza/bloqueo basada en esto | No |
| `possible_duplicate` | boolean | `behavior` | Expira 14 días o hasta resolución manual | 0.500 (umbral bajo a propósito — es solo una alerta, no una afirmación) | genesis o manual (motor de detección, sección 2.3) | Sí | **Sí, siempre** (es una alerta para que un humano decida, nunca se auto-resuelve) | No aplica — no es un insight de marketing |

**Reglas transversales (aplican a los 14, sin excepción):**
- Ninguno se puede crear si su `code` no existe primero en `insight_definitions` — el `FOREIGN
  KEY` lo garantiza a nivel de base de datos, no solo por convención de código.
- `category IN ('risk')` (`adverse_reaction`, `legal_threat`, `fraud_risk`, y por extensión
  `possible_duplicate` aunque es `behavior`) **nunca se auto-resuelven por expiración silenciosa
  sin marca de revisión** — incluso los que sí expiran (`fraud_risk`, `possible_duplicate`)
  requieren que la desactivación quede registrada como evento con `actor_type` explícito, no un
  `UPDATE` mudo del cron nocturno.
- `confidence` por debajo del mínimo de la tabla **no bloquea la escritura** (Génesis puede
  reportar con menor confianza) — pero sí bloquea que ese insight cuente como señal válida para
  segmentos/broadcast automáticos hasta alcanzar el umbral. Es una distinción entre "se registró"
  y "se puede usar para decidir algo".

## 8.2 Versionado del clasificador

`customer_insights.classifier_version` (ya en el esquema de la versión anterior, sin cambios) —
formato libre pero convencionalmente `{provider}:{model}:{prompt_hash_corto}` (ej.
`openai:gpt-4o-mini:a3f9c1`). Permite invalidar en bloque (`UPDATE customer_insights SET
active=false WHERE classifier_version='...'`) si una versión del prompt de Génesis demuestra
generar falsos positivos sistemáticos — operación manual de admin, nunca automática.

## 8.3 Prohibición explícita de tags libres

Reafirmado: la función que Génesis usa para escribir un insight (`recordCustomerInsight()`,
diseño de Fase 4) valida `insight_code` contra `insight_definitions` **antes** de intentar el
INSERT, con un mensaje de error explícito y logueado (`[genesis] insight_code desconocido:
'{code}' — no se escribió, revisar prompt/catálogo`) — nunca falla en silencio ni permite que un
código nuevo se cuele por una carrera de tipos débil en TypeScript.

---

# 9. Segmentos dinámicos — DSL aterrizado

## 9.1 Ejemplo real pedido: "clientes leales interesados en sensibilidad, sin compra reciente, con delivery rate alto, y sin pedido activo"

```json
{
  "op": "AND",
  "conditions": [
    { "field": "rfm_segment", "op": "in", "value": ["loyal", "champion"] },
    { "op": "exists", "target": "insight", "code": "interest_sensitivity", "active": true },
    { "field": "last_paid_at", "op": "days_since", "gte": 30 },
    { "field": "delivery_rate", "op": "gte", "value": 0.80 },
    { "op": "not", "condition":
      { "op": "exists", "target": "active_order" }
    },
    { "field": "do_not_contact", "op": "eq", "value": false }
  ]
}
```

## 9.2 Operadores soportados (whitelist cerrada)

| Operador | Uso | Ejemplo |
|---|---|---|
| `eq` / `neq` | Igualdad exacta | `{ "field": "rfm_segment", "op": "eq", "value": "champion" }` |
| `gt` / `gte` / `lt` / `lte` | Comparación numérica/fecha | `{ "field": "total_orders", "op": "gte", "value": 2 }` |
| `in` / `not_in` | Pertenencia a lista | `{ "field": "city", "op": "in", "value": ["Santo Domingo","Santiago"] }` |
| `contains` | Substring, solo sobre campos de texto explícitamente permitidos (`preferred_city`, `preferred_address`) — **nunca** sobre campos libres sin whitelist | `{ "field": "preferred_city", "op": "contains", "value": "Villa" }` |
| `exists` | Presencia de un insight activo o de un pedido activo (`target: 'insight' \| 'active_order'`) | ver ejemplo 9.1 |
| `between` | Rango numérico/fecha | `{ "field": "lifetime_value", "op": "between", "value": [1000, 5000] }` |
| `days_since` | Fecha relativa — evita fechas absolutas que envejecen mal | `{ "field": "last_order_at", "op": "days_since", "gte": 14 }` |
| `and` / `or` / `not` | Composición lógica, anidable sin límite de profundidad **excepto el límite de complejidad de 9.4** | ver ejemplo 9.1 |

## 9.3 Lista blanca de campos evaluables

Únicamente columnas reales de `customers` (nunca un campo arbitrario, nunca SQL crudo):
`rfm_segment`, `rfm_r_score`, `rfm_f_score`, `rfm_m_score`, `total_orders`, `confirmed_orders`,
`delivered_orders`, `cancelled_orders`, `returned_orders`, `paid_orders`, `lifetime_value`,
`average_order_value`, `delivery_rate`, `cancellation_rate`, `return_rate`, `no_answer_rate`,
`cod_risk_score`, `preferred_city`, `last_order_at`, `last_paid_at`, `last_delivered_at`,
`first_order_at`, `engagement_score`, `marketing_opt_in`, `do_not_contact`, `purchase_intent`,
`purchase_probability`, `last_conversation_outcome`, más los dos targets especiales (`insight`,
`active_order`) evaluados por sub-queries controladas, no por nombre de columna libre.

## 9.4 Validación, compilación segura, límites

- **Validación:** cada nodo del árbol se valida contra un schema (Zod o equivalente) antes de
  compilar — `field` debe estar en la whitelist de 9.3, `op` debe estar en la whitelist de 9.2,
  tipos de `value` deben coincidir con el tipo real de la columna (ej. `value` de `rfm_segment`
  debe ser string del enum de segmentos, no un número).
- **Compilación segura:** el intérprete traduce el árbol a una cadena de llamadas Supabase
  (`.eq()`, `.gte()`, `.in()`, etc.) encadenadas dinámicamente a partir de nombres de columna ya
  validados contra la whitelist — nunca concatenación de strings SQL, nunca `raw()`/`rpc()` con
  input de usuario sin parametrizar.
- **Límites de complejidad (para evitar queries patológicas):** máximo 5 niveles de anidamiento,
  máximo 20 condiciones hoja por segmento, máximo 1 `exists` de tipo `insight` por rama `AND` (para
  no forzar múltiples sub-queries costosas encadenadas). Un segmento que exceda estos límites se
  rechaza en la validación con un mensaje claro, no se trunca silenciosamente.
- **Snapshot para campañas:** ya cubierto en el documento original (sección de
  `customer_segment_memberships`, sin cambios) — la evaluación se congela en la tabla de
  membresía en el momento del envío.
- **Preview count:** el endpoint de creación/edición de un segmento debe soportar un modo
  `?dry_run=true` que solo devuelve `COUNT(*)` sin persistir membership — para que un admin vea
  "este segmento tiene 340 clientes" antes de guardar o de lanzar una campaña.
- **Cache:** el resultado de `dry_run` se cachea 5 minutos por hash del `rule_definition` (evita
  recalcular el mismo preview si el admin solo está ajustando la UI sin cambiar la regla) — cache
  en memoria de aplicación, no una tabla nueva.
- **Auditoría de cambios:** cada `UPDATE` a `customer_segments.rule_definition` genera una fila en
  `order_history`-equivalente para segmentos — en la práctica, se resuelve reutilizando el mismo
  patrón de trigger genérico de auditoría de campo que ya existe para `orders`
  (`fn_update_updated_at()` + un trigger de auditoría análogo a `order_history`, aplicado a
  `customer_segments` — detalle de implementación de Fase 5, no de este documento).

---

# 10. Multitienda — cierre

## 10.1 Regla V1 (confirmada, con la corrección del dato real)

- `customers` siempre pertenece a un `store_id` — sin excepción.
- La identidad **no se comparte entre tiendas** — un mismo teléfono en dos tiendas genera dos
  filas `customers` completamente independientes.
- Eventos, métricas, tags, segmentos y campañas están aislados por `store_id`, sin excepción.

**Corrección respecto a la versión anterior de este documento:** hoy existe **una sola fila**
en `stores` (sección 7.1) — la mención a "LÜMA Teeth, Renuva, futuras marcas" como tiendas Shopify
separadas es una descripción del **roadmap de negocio** documentado en `CLAUDE.md`, no del estado
actual de `store_id` en el esquema. El diseño store-scoped **sigue siendo correcto** —
es la misma decisión que ya rige todo el RLS del sistema — pero se aplica hoy sobre una sola
tienda real. Esto no cambia ninguna decisión de arquitectura, solo corrige la afirmación de hecho.

## 10.2 Evolución futura a persona global (no implementada, camino documentado)

Para no cerrar la puerta si el negocio decide en el futuro que sí necesita reconocer que la misma
persona compra en dos tiendas distintas:

```
customers.global_person_id   UUID NULL   -- opcional, sin FK a una tabla "persons" en v1
```

- Se agregaría como columna nullable, **sin tabla `persons` todavía** — dos filas `customers` (una
  por tienda) podrían compartir el mismo `global_person_id` si un proceso futuro (manual o
  semi-automático, nunca automático sin revisión) determina que son la misma persona.
- **Qué NO se comparte automáticamente aunque exista `global_person_id`:** `marketing_opt_in`,
  `do_not_contact` y `suppression_*` siguen siendo **por tienda** — el consentimiento dado en una
  marca no se hereda a otra sin una decisión de negocio explícita y separada (el mismo principio
  ya aplicado al resto del documento: "no mezclar datos de marketing entre tiendas sin decisión
  explícita").
- **Qué sí podría compartirse (decisión futura, no v1):** posiblemente insights de riesgo
  (`adverse_reaction`, `fraud_risk`) — si alguien tuvo una reacción adversa comprando en LÜMA
  Teeth, es razonable que Renuva lo sepa antes de venderle un producto similar. Esto es
  explícitamente una decisión de negocio a tomar en el futuro, no una implementación de este
  documento.

---

# 11. RLS y roles — matriz concreta

Roles reales del sistema (migración `029_dispatch_agent_role.sql`, la más reciente):
`admin`, `ia_supervisor`, `confirmation_agent`, `dispatch_agent`, `novelty_agent`,
`delivery_agent`, `santo_domingo_delivery_agent`, `agent`, `viewer`. `marketing_agent` y "Génesis
backend" no son roles de `profiles.role` hoy — se tratan por separado abajo.

| Entidad | `admin` | `ia_supervisor` | `confirmation_agent` | `dispatch_agent` | `novelty_agent` | `delivery_agent` / `santo_domingo_delivery_agent` | `marketing_agent` (futuro, no existe hoy) | Génesis (service role) |
|---|---|---|---|---|---|---|---|---|
| `customers` — identidad básica (nombre, teléfono, dirección, ciudad) | SELECT/UPDATE | SELECT/UPDATE | SELECT | SELECT | SELECT | **SELECT únicamente vía vista `customers_operational`**, nunca la tabla completa | SELECT/UPDATE | — (no accede directo, solo vía función validadora) |
| `customers` — RFM/LTV/`cod_risk_score` | SELECT/UPDATE (solo el job de recompute, vía service role) | SELECT | ❌ | ❌ | ❌ | ❌ | SELECT | ❌ |
| `customers` — `purchase_intent`/`purchase_probability`/`last_conversation_outcome` (Génesis) | SELECT | SELECT | ⚠️ Solo si el pedido está asignado a su cola (contexto operativo, no exploratorio) | ❌ | ⚠️ Igual que confirmation_agent | ❌ | SELECT | INSERT/UPDATE (vía función validadora únicamente) |
| `customers` — consentimiento (`marketing_opt_in`, `do_not_contact`) | SELECT/UPDATE | SELECT | ❌ | ❌ | ❌ | ❌ | SELECT | ❌ |
| `customer_identifiers` | SELECT/INSERT/UPDATE | SELECT | ❌ | ❌ | ❌ | ❌ | SELECT | ❌ (lo escribe `resolveOrCreateCustomer`, código de aplicación con service role, no Génesis) |
| `customer_events` | SELECT | SELECT | ❌ (usa `agent_actions`, no esta tabla) | ❌ | ❌ | ❌ | SELECT | INSERT (solo `conversation_classified`, vía función validadora) |
| `insight_definitions` | SELECT/INSERT/UPDATE (catálogo, admin-only para editar) | SELECT | SELECT | ❌ | SELECT | ❌ | SELECT | SELECT (para saber qué códigos puede usar) |
| `customer_insights` — categorías `product_interest`/`behavior` | SELECT/INSERT (manual) | SELECT | SELECT/INSERT (manual, contexto de su pedido) | ❌ | SELECT/INSERT (manual) | ❌ | SELECT | INSERT (vía función validadora) |
| `customer_insights` — categorías `objection`/`sentiment`/`risk` | SELECT | SELECT | ❌ | ❌ | ❌ | ❌ | ❌ — **explícitamente excluido, es información sensible de riesgo/legal, no de marketing** | INSERT (vía función validadora) |
| `customer_segments` / `customer_segment_memberships` | SELECT/INSERT/UPDATE/DELETE | SELECT | ❌ | ❌ | ❌ | ❌ | SELECT/INSERT/UPDATE | ❌ |

**Notas de la matriz:**
- **Génesis nunca escribe `customers.rfm_*`/`total_orders`/etc. directamente** — esos campos son
  propiedad exclusiva del job de recompute (sección de "reglas de actualización" del documento
  original, sin cambios). Génesis solo escribe sus propios campos de IA (`purchase_intent` y
  similares) y filas de `customer_insights`, ambos a través de una función validadora que aplica
  el catálogo controlado (sección 8) — nunca `UPDATE`/`INSERT` directo sin pasar por esa función,
  ni siquiera con service role.
- **`vista customers_operational`** (mencionada en sección 1.9 y aquí): expone
  `id, store_id, full_name, phone_primary, preferred_city, preferred_address, do_not_contact` —
  nada de RFM, LTV, ni insights. Es el mecanismo concreto para roles de campo (`delivery_agent`,
  `santo_domingo_delivery_agent`) que necesitan ver datos de contacto para hacer su trabajo pero no
  deben ver el valor comercial ni el perfil de IA de un cliente.
- **RLS de fila** (todas las entidades): mismo patrón ya en producción —
  `store_id = get_user_store_id()` combinado con el rol permitido, siguiendo exactamente el
  patrón de `is_wa_inbox_role()` (`030_whatsapp_base.sql:164-179`). Se propone una función nueva
  `is_customer_intel_role()` en vez de reutilizar `is_wa_inbox_role()` porque el conjunto de roles
  no es idéntico (`dispatch_agent` tiene acceso limitado en `customers` pero pleno en `wa_contacts`
  hoy, por ejemplo).

---

# 12. Backfill V1 — diseño detallado (sin SQL)

## 12.1 Fuentes y orden de ejecución

```
Paso 0 — Dry-run completo (obligatorio, no opcional)
  Ejecuta todos los pasos de abajo en modo lectura/simulación:
  cuenta cuántos customers se crearían, cuántos identifiers, cuántos posibles
  duplicados se detectarían — sin escribir nada. Reporta el resultado para
  aprobación humana ANTES de correr el backfill real.

Paso 1 — Crear customers desde orders
  SELECT DISTINCT (store_id, normalizePhone(customer_phone))
  FROM orders
  WHERE customer_phone IS NOT NULL
  → un customer por identidad resuelta. full_name = el de la orden con
    created_at más reciente para ese teléfono (asume que el nombre más
    reciente es el más probablemente correcto/actualizado).
  Pedidos con customer_phone NULL o inválido (según el nuevo normalizePhone(),
  sección 3.4) quedan en un reporte aparte "pedidos sin identidad resoluble"
  — NO bloquean el resto del backfill.

Paso 2 — Enriquecer desde wa_contacts
  Para cada customer creado en el paso 1, buscar wa_contacts con el mismo
  (store_id, phone_normalized) y setear customers.wa_contact_id.
  Para wa_contacts que NO tengan customer correspondiente (número que
  escribió pero nunca compró) — no se crea customer, quedan huérfanos por
  diseño (sección 1.6).

Paso 3 — Enriquecer desde abandoned_carts
  Para carritos con recovery_status != 'recovered' (intención sin compra
  aún), evaluar si generan un customer "de intención" — DECISIÓN: NO en v1.
  abandoned_carts sin pedido asociado no genera fila en customers (mismo
  principio que wa_contacts sin compra) — solo alimenta customer_events
  (cart_abandoned) SI y solo si ya existe un customer para ese teléfono
  (evita crear 1,438 perfiles "cliente" de gente que nunca compró nada).
  Si recovery_status='recovered' y ya generó una orden real, ese caso ya
  quedó cubierto por el Paso 1 (la orden real ya crea el customer).

Paso 4 — Normalizar identidad
  Para cada customer, insertar su customer_identifiers primario
  (identifier_type='phone', is_primary=true, confidence=1.000,
  source='shopify_webhook', detected_at=first_seen_at del customer).

Paso 5 — Vincular orders.customer_id (columna nueva, ver riesgo abajo)
  UPDATE orders SET customer_id = ... por lotes, usando la misma resolución
  de identidad del paso 1. Ver 12.3 para la justificación de por qué esto
  SÍ se hace en el backfill (a diferencia de la versión anterior del
  documento, que proponía join en tiempo de lectura sin FK física).

Paso 6 — Calcular métricas
  Recompute completo (sección "reglas de actualización" del documento base,
  sin cambios) — un solo pase por customer, agregando desde orders +
  agent_actions ya vinculados.

Paso 7 — Generar eventos históricos
  Solo los 6 event_types reconstruibles sin ambigüedad desde orders
  (order_created, order_confirmed, order_delivered, order_paid,
  order_returned, order_cancelled) — ya especificado en la versión
  anterior, sin cambios. NO se reconstruyen whatsapp_message_received/sent
  ni conversation_classified retroactivamente.

Paso 8 — Detectar duplicados para revisión
  Corre las 3 señales de la sección 2.3 punto 3 sobre el resultado del
  backfill. Genera un reporte (no customer_insights todavía en el backfill
  mismo — el catálogo de insight_definitions debe existir primero, Fase 4)
  con la lista de posibles duplicados para revisión manual de un admin
  antes de considerar el backfill "cerrado".
```

## 12.2 Propiedades operativas exigidas

| Propiedad | Cómo se cumple |
|---|---|
| **Idempotente** | Cada paso usa `ON CONFLICT DO NOTHING`/`DO UPDATE` sobre las claves únicas ya definidas (`(store_id, phone_primary)` en `customers`, `(identifier_type, value_normalized)` en `customer_identifiers`, `idempotency_key` en `customer_events`) — correr el backfill dos veces no duplica nada. |
| **Por lotes** | Mismo patrón que ya usa el proyecto para operaciones masivas (`reconcile-efi-import`, límite de 500 items por request, `maxDuration` explícito) — el backfill de 2,849 identidades se procesa en lotes de ~500, no en una sola transacción gigante. |
| **Resumible** | Cada lote registra su progreso (última página procesada) — si se interrumpe, se reanuda desde el último lote confirmado, no desde cero. |
| **Auditable** | El propio backfill queda registrado como una fila especial en `customer_events` por cada evento generado, con `source='backfill'` y `actor_type='system'` — distinguible de eventos generados en tiempo real después del backfill. |
| **Sin bloquear producción** | Ninguna escritura del backfill toca `orders`/`agent_actions`/`wa_messages` (excepto el Paso 5, que agrega una columna nueva vía `UPDATE` por lotes, no un `ALTER` bloqueante de tabla completa, y corre fuera de horario pico) — el resto son tablas completamente nuevas sin lectores todavía. |
| **Dry-run** | Paso 0, obligatorio antes de cualquier escritura real (ver arriba). |
| **Conteos antes/después** | El reporte final del backfill compara: pedidos totales vs. customers creados vs. pedidos sin identidad resoluble vs. posibles duplicados detectados — números concretos, no "se ejecutó sin errores". |
| **Rollback/reparación** | Como el backfill no modifica ninguna tabla existente de forma destructiva (Paso 5 es la única excepción, y es una columna nueva aditiva, nunca un `UPDATE` que sobreescriba algo previamente poblado), el "rollback" es literalmente `TRUNCATE customers, customer_identifiers, customer_events CASCADE` + `UPDATE orders SET customer_id = NULL` — reversible sin pérdida de ningún dato original, porque ninguna fuente original (`orders`, `wa_contacts`, `abandoned_carts`) se modifica en el proceso salvo la columna aditiva del Paso 5. |

## 12.3 Sobre `orders.customer_id` — corrección respecto a la versión anterior

El documento anterior proponía relacionar `orders` con `customers` **por valor** (join en tiempo de
lectura), explícitamente para "no retro-migrar 4+ años de pedidos históricos en el arranque". Esta
revisión lo corrige: con solo 3,368 pedidos totales (no "4+ años" de volumen — es una base pequeña,
sección 7.1), un `UPDATE` por lotes de esa magnitud es trivial y de bajo riesgo, y una columna
`orders.customer_id UUID NULL REFERENCES customers(id)` física es muy superior a un join por valor
en cada query (más rápida, indexable, no depende de que `normalizePhone()` produzca exactamente el
mismo resultado en cada lectura). Se agrega como columna **aditiva y nullable** — no reemplaza
`orders.customer_phone` (que sigue siendo la fuente original de ese dato), solo agrega el puente
indexado hacia la identidad resuelta.

---

# 13. Roadmap ejecutable — 7 fases

**Fase 1 — Identidad canónica**
- **Objetivo:** que exista `customers` resuelto por teléfono, sin ningún otro concepto encima.
- **Tablas:** `customers` (solo columnas de identidad: `id, store_id, phone_primary, full_name,
  email, shopify_customer_id, wa_contact_id, first_seen_at, last_seen_at`), `customer_identifiers`.
- **Migraciones:** columna `orders.customer_id` (nullable) + `orders.shopify_customer_id`
  (nullable, capturado desde el webhook por primera vez).
- **Endpoints:** `GET /api/customers/[id]` (uso interno/QA, sin UI todavía).
- **Jobs:** ninguno recurrente todavía — el backfill (sección 12) es una corrida única.
- **UI:** ninguna.
- **Riesgos:** el más real es el `UPDATE` por lotes de `orders.customer_id` (12.3) — mitigado
  corriendo fuera de horario pico y en lotes pequeños con verificación de conteo entre lotes.
- **Criterios de aceptación:** `SELECT COUNT(*) FROM customers` coincide con las identidades
  únicas reales (~2,849, sujeto a crecimiento desde la fecha de este documento); 0 pedidos con
  `customer_phone` válido y `customer_id` NULL después del backfill; `npx tsc --noEmit` limpio.
- **Dependencias:** ninguna — es la fase raíz.
- **Qué NO incluye:** RFM, eventos, insights, segmentos, consentimiento, Broadcast — nada de eso
  existe todavía al cierre de esta fase.

**Fase 2 — Perfil y métricas**
- **Objetivo:** columnas de comportamiento/COD en `customers`, calculadas y mantenidas.
- **Tablas:** ampliar `customers` con las columnas de comportamiento/COD (sección 8.1 del
  documento base, sin cambios de esquema en esta revisión).
- **Migraciones:** `ALTER TABLE customers ADD COLUMN ...` (aditivo).
- **Endpoints:** ninguno nuevo expuesto todavía (las métricas se calculan pero no hay UI de
  consulta pública fuera de QA interno).
- **Jobs:** recompute incremental (por evento de aplicación, aún sin `customer_events` formal —
  se conecta directo a los puntos de escritura de `orders`/`agent_actions` listados en la sección
  9.1 del documento base) + recompute nocturno completo por tienda.
- **UI:** ninguna.
- **Riesgos:** que el recompute nocturno tarde demasiado a medida que crece `orders` — mitigado
  con el mismo patrón de límite/paginación que ya usa el cron de tracking EFI.
- **Criterios de aceptación:** para una muestra de 20 clientes elegidos a mano, `total_orders`/
  `lifetime_value`/`delivery_rate` calculados coinciden exactamente con un conteo manual sobre
  `orders`.
- **Dependencias:** Fase 1.
- **Qué NO incluye:** RFM (viene en Fase 3, depende de que las métricas base ya sean confiables).

**Fase 3 — Eventos**
- **Objetivo:** `customer_events` como timeline consultable, alimentando RFM de forma más barata
  que recorrer `orders` completo en cada recompute.
- **Tablas:** `customer_events`.
- **Migraciones:** creación de la tabla + índices (sección 8.3 del documento base).
- **Endpoints:** ninguno público — es infraestructura interna del recompute.
- **Jobs:** el recompute de Fase 2 se refactoriza para leer de `customer_events` en vez de
  recorrer `orders` completo cada vez (optimización, no cambio de resultado).
- **UI:** ninguna todavía (un timeline visual de cliente es UI de fases posteriores, fuera de
  alcance de este roadmap de backend).
- **Riesgos:** duplicación de eventos si dos triggers de aplicación llaman al emisor de eventos
  para el mismo hecho — mitigado por `idempotency_key` + `ON CONFLICT DO NOTHING` (sección 4.3).
- **Criterios de aceptación:** para los 6 `event_type` reconstruibles del backfill, el conteo de
  eventos coincide exactamente con el conteo de pedidos que cumplen esa condición en `orders`.
- **Dependencias:** Fase 1 y 2.
- **Qué NO incluye:** eventos de WhatsApp/campañas — esos entran en fases posteriores según su
  propio subsistema madure.

**Fase 4 — Insights de Génesis**
- **Objetivo:** catálogo controlado de insights, escribible por Génesis y por agentes (tags
  manuales), con RLS diferenciado.
- **Tablas:** `insight_definitions` (con seed de los 14 códigos, sección 8), `customer_insights`.
- **Migraciones:** creación de ambas tablas + RLS + función `is_customer_intel_role()`.
- **Endpoints:** `POST /api/customers/[id]/insights` (manual, agente), función interna
  `recordCustomerInsight()` para Génesis (no expuesta como endpoint HTTP público).
- **Jobs:** job nocturno de expiración de insights vencidos (`active=false` cuando corresponde).
- **UI:** panel mínimo de insights en la vista de detalle de un pedido/cliente (para agentes,
  fuera del detalle exacto de este documento de backend).
- **Riesgos:** que Génesis intente escribir un código fuera del catálogo — mitigado por el
  `FOREIGN KEY` + validación explícita con log claro (sección 8.3).
- **Criterios de aceptación:** un insight con `insight_code` inválido es rechazado con error
  claro, nunca silenciosamente ignorado ni guardado con un código distinto al enviado.
- **Dependencias:** Fase 1 (necesita `customers` para el FK).
- **Qué NO incluye:** segmentos que usen insights como condición (eso es Fase 5).

**Fase 5 — Segmentos**
- **Objetivo:** constructor de segmentos dinámicos, con preview y snapshot.
- **Tablas:** `customer_segments`, `customer_segment_memberships`.
- **Migraciones:** creación de ambas + RLS (solo `admin`/futuro `marketing_agent`).
- **Endpoints:** `POST /api/customer-segments` (crear/editar, con `?dry_run=true`), `GET
  /api/customer-segments/[id]/members`.
- **Jobs:** evaluación nocturna de segmentos con `refresh_mode='nightly'`.
- **UI:** constructor visual de reglas (fuera del detalle de este roadmap de backend — se
  documenta como necesario, no se diseña su UI aquí).
- **Riesgos:** queries de segmentos mal escritas que degraden performance — mitigado por los
  límites de complejidad de la sección 9.4.
- **Criterios de aceptación:** el ejemplo de la sección 9.1 se puede crear, evaluar con
  `dry_run` y devuelve un conteo verificable manualmente contra una query directa equivalente.
- **Dependencias:** Fase 2 (métricas), Fase 4 (insights).
- **Qué NO incluye:** envío de nada — los segmentos no disparan ninguna comunicación todavía.

**Fase 6 — Broadcast (preparación, sin envío real)**
- **Objetivo:** que `canReceiveBroadcast()` exista y esté probada, sin ningún caller real
  conectado a un envío masivo todavía.
- **Tablas:** columnas de consentimiento en `customers` (sección 5.1), sin tablas nuevas.
- **Migraciones:** `ALTER TABLE customers ADD COLUMN marketing_opt_in, do_not_contact,
  suppression_reason, suppression_until`.
- **Endpoints:** `POST /api/customers/[id]/opt-out` (manual/UI futura), detección de palabra
  clave añadida al webhook de WhatsApp existente (aditivo, sin tocar el flujo de Génesis actual).
- **Jobs:** ninguno nuevo.
- **UI:** ninguna de campañas todavía — solo, si acaso, un toggle de opt-out en el detalle de
  cliente para uso manual de agentes.
- **Riesgos:** el mayor riesgo de todo el roadmap — **requiere revisión legal antes de cerrar
  esta fase** (sección 15). No es un riesgo técnico, es de cumplimiento normativo.
- **Criterios de aceptación:** `canReceiveBroadcast()` cubre los 10 casos de exclusión de la
  sección 5.3 con pruebas unitarias por cada uno, y ningún caller real la invoca todavía en
  producción (se prueba en aislamiento).
- **Dependencias:** Fase 5 (los segmentos son la entrada natural de a quién se le preguntaría
  `canReceiveBroadcast`).
- **Qué NO incluye:** el sistema de campañas/`campaign_recipients`/envío real vía Meta Cloud API
  — eso es Fase 7, y Fase 7 en sí queda **fuera de este roadmap**, requiere autorización separada
  explícita del negocio (no solo técnica) antes de siquiera diseñarse en detalle.

**Fase 7 — Automatizaciones**
- **Objetivo:** (mencionado en el prompt original de Fase 0 como parte de la visión completa,
  pero deliberadamente el menos definido de todos — depende por completo de que Broadcast exista
  primero).
- **Tablas / Endpoints / Jobs / UI:** no diseñados en este documento — sería prematuro detallarlos
  antes de que exista Broadcast real y se observe cómo se usa.
- **Riesgos:** el mayor riesgo de esta fase es diseñarla antes de tener evidencia de uso real de
  las fases 1-6 — se marca explícitamente como **no diseñada a propósito**, no como un olvido.
- **Dependencias:** Fase 6 completa y en producción, con al menos una campaña real evaluada.
- **Qué NO incluye:** todo — esta fase es un placeholder de roadmap, no un contrato técnico.

---

# 14. Decisiones cerradas V1

| Decisión | Valor aprobado | Razón | Revisable en |
|---|---|---|---|
| Identificador canónico | Teléfono normalizado (`normalizePhoneRD`, migrando al contrato `normalizePhone()` de sección 3.4) | Único campo que ya conecta `orders` y `wa_contacts` con el mismo formato hoy | Fase 1, si se decide capturar `shopify_customer_id` como igual de prioritario |
| Alcance de identidad | Por `store_id`, nunca global | Coherente con el 100% del RLS existente; hoy solo hay 1 tienda real de todos modos | Cualquier fase, vía `global_person_id` opcional (sección 10.2) — nunca automático |
| `customers` vs `wa_contacts` | Tablas separadas, relación 1:1 opcional vía `customers.wa_contact_id` | Ciclos de vida y RLS distintos (sección 1) | No se prevé revisión — es una decisión estructural de bajo riesgo de cambiar |
| Forma de `customer_events` | Tabla física, alimentada por código de aplicación | Vistas/materialized views no cumplen requisitos de latencia ni idempotencia (sección 4.1) | No se prevé revisión |
| Merge de duplicados | Manual únicamente, nunca automático por teléfono solo | Riesgo de fusionar personas distintas irreversiblemente | Nunca se automatiza sin una señal de identidad mucho más fuerte que hoy (ej. verificación biométrica/OTP — no aplica a este negocio) |
| Fuente monetaria de RFM | `payment_status='paid'` + `paid_at` + `cod_amount` | Ya mandatado, ya es la fuente de verdad real de pago (migración 046) | No revisable — es un requisito, no una opción |
| Ventana histórica de RFM v1 | Todo el historial disponible (no 180 días fijos) | Solo hay 12 días de `paid_at` real — 180 no está validado con datos (sección 7) | Recalibración obligatoria al alcanzar ≥90 días de historial y ≥500 clientes pagados |
| Scores RFM 1-5 | Percentiles por tienda, con `rfm_sample_size_warning` si <500 clientes pagados | Umbrales fijos no se adaptan al ticket real de cada tienda; percentiles con poca muestra son ruidosos | Al alcanzar volumen suficiente, se retira la advertencia automáticamente (no requiere cambio de código) |
| Regla de exclusión por pedido activo (Broadcast) | `confirmation_status IN (pending,confirmed) AND normalized_status IN (pending,in_transit,en_reparto,novedad) AND payment_status=pending AND created_at >= now()-10 días` | Cierre concreto pedido explícitamente, calibrado contra los SLA operativos ya documentados (48h crítico) con margen holgado | Fase 6, si el negocio pide un umbral distinto |
| Modelo de consentimiento | Opt-out (consentimiento implícito al iniciar conversación/comprar) para v1 de diseño | Es el modelo que el sistema ya opera de facto | **Bloqueado hasta revisión legal** — ver Preguntas pendientes |
| Catálogo de insights | Cerrado a los 14 códigos de la sección 8.1, sin adición libre por Génesis | Evita vocabulario inventado en producción | Admin puede agregar códigos nuevos a `insight_definitions` vía proceso manual (gobernanza a definir) |
| `customer_metrics`, `customer_segment_rules`, `conversation_insights` como tablas separadas | Rechazadas — fusionadas en `customers`, `customer_segments.rule_definition`, `customer_insights` respectivamente | Evitar tablas partidas sin beneficio real | Se separan solo si aparece una necesidad concreta de versionar/desacoplar independientemente |
| `orders.customer_id` | Columna física con FK, no solo join por valor | Volumen real (3,368 pedidos) hace trivial el backfill; mejora performance e integridad | No revisable — corrección respecto al borrador anterior |
| Doble normalizador de teléfono | Se consolida en Fase 1 (tarea de limpieza, bajo riesgo) | Deuda técnica confirmada, blast radius de solo 4 archivos admin | Se ejecuta como parte de Fase 1, no bloquea el resto |

---

# 15. Preguntas pendientes del negocio

Reducido a lo que **realmente** requiere una decisión del usuario/negocio, no del arquitecto:

1. **¿El modelo de consentimiento de marketing (opt-out implícito, sección 5/16) es legalmente
   aceptable en República Dominicana para este tipo de negocio (COD, WhatsApp Business)?** Esto
   bloquea el cierre real de la Fase 6 — se puede diseñar y construir con el modelo asumido, pero
   no debería activarse en producción sin esa confirmación.

2. **¿La ventana de "pedido activo bloquea marketing" de 10 días (sección 6) es el número
   correcto para el negocio, o hay un caso operativo real que la haga muy corta/muy larga?**
   Es una constante nombrada, fácil de ajustar, pero el valor de 10 días es una propuesta técnica
   razonada, no una cifra del negocio.

3. **¿Vale la pena capturar `email` de forma consistente desde Shopify** (hoy no se persiste en
   `orders` en ningún flujo) **para que `customers.email` sea un dato real y no un campo casi
   siempre vacío?** Es una decisión de alcance para la Fase 1 — agregar la captura es barato, pero
   si el negocio no lo va a usar para nada (ej. no hay planes de email marketing), no vale la pena
   el esfuerzo adicional en el webhook.

4. **Cuando el volumen de pedidos pagados crezca lo suficiente para recalibrar el RFM (sección
   7.4, ≥90 días / ≥500 clientes), ¿quién en el negocio revisa y aprueba la nueva ventana/
   thresholds, o se recalcula automáticamente sin aprobación humana?** Es una decisión de proceso,
   no de arquitectura — el sistema puede calcularlo solo, pero cambiar cómo se segmenta a los
   clientes es una decisión de negocio, no solo un job de cron.

---

# Cierre

Este documento sigue sin autorizar ninguna implementación. La Fase 1 (sección 13) es la primera
candidata a ejecución, pero requiere aprobación explícita separada — incluyendo respuesta a la
pregunta 3 de la sección 15, que afecta directamente el alcance de esa fase.
