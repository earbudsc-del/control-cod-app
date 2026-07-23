# Arquitectura Ruta COD v1

Este documento es el contrato de arquitectura para Ruta COD y su backend en Control COD.
Toda implementación futura debe respetarlo. Si un cambio propuesto contradice este documento,
el documento se actualiza primero (explícitamente, en su propio commit) — nunca se contradice
en silencio con un endpoint nuevo.

Estado: **congelado para implementación**. Fecha de congelamiento: 2026-07-19.

---

# Filosofía

La IA organiza el trabajo.
El mensajero ejecuta el trabajo.

Ruta COD no administra pedidos.
Ruta COD ejecuta entregas.

El mensajero no decide qué pedido es suyo, cuándo un cliente quedó confirmado, ni en qué orden
existen las rutas. Esas son decisiones del sistema (hoy: reglas determinísticas; a futuro: el
Supervisor Operativo IA). El mensajero decide únicamente qué pasó en la calle: si entregó, si el
cliente no contestó, si hay que reprogramar, si cobró.

---

# Principios

1. **Separación completa entre estado comercial y estado operativo.**
   El estado comercial responde "¿este cliente va a recibir y pagar este pedido?".
   El estado operativo responde "¿en qué punto de la ejecución logística está?".
   Son dos máquinas de estado independientes que viven en columnas distintas de `orders` y
   se leen con funciones distintas (`computePool`/`computeStatus` en
   `src/lib/deliveries/sd-status.ts` para el operativo; `confirmation_status` +
   `customer_confirmed` para el comercial).

2. **Ningún estado comercial depende del mensajero.**
   `confirmation_status`, `customer_confirmed`, `customer_confirmed_at`, `confirmation_method`
   nunca deben escribirse desde una acción del rol `santo_domingo_delivery_agent` actuando como
   mensajero de campo. El mensajero no confirma clientes — la única razón por la que hoy existe
   una acción de confirmación manual disponible para ese rol es la excepción documentada más
   abajo, no el flujo normal.

3. **Ningún estado operativo confirma clientes.**
   `assigned_to`, `normalized_status`, `status_since`, la pertenencia a una ruta derivada — nada
   de esto puede, por sí mismo, mover `confirmation_status` a `'confirmed'`. El motor de
   asignación (`autoAssignSdOrder`) tiene explícitamente prohibido tocar columnas comerciales.

4. **Existe una única transición comercial.**
   `applyConfirmationAction()` (`src/lib/orders/confirmation.ts`) es la única función autorizada
   para mover un pedido a `confirmed` o a un estado de cancelación. Cualquier código que escriba
   `confirmation_status` fuera de esa función es una violación de este contrato.

5. **Existe una única transición logística por etapa.**
   Cada salto del estado operativo tiene exactamente una función autorizada:
   - `Sin asignar → Asignado`: `autoAssignSdOrder()`
   - `Ruta preparada → En recorrido`: `executeStartRoute()` (`src/lib/deliveries/action-executors.ts`)
   - `En recorrido → Entregado`: `markSdOrderDelivered()` (`src/lib/deliveries/mark-delivered.ts`)
   - `Entregado → Pagado`: el case `'paid'` de `POST /api/v1/deliveries/orders/[id]/actions`,
     respaldado por `payment-status.ts`
   Cualquier `UPDATE` directo a `orders.normalized_status` o `orders.assigned_to` fuera de estas
   funciones es una violación de este contrato.

---

# Estado Comercial

```
Nuevo
  │
  ▼
Esperando confirmación
  │
  ▼
Esperando ubicación
  │
  ▼
Confirmado ──────────► Cancelado
```

`Cancelado` es alcanzable desde cualquier estado anterior — no solo desde `Confirmado`.

| Estado | Significado | Campos reales |
|---|---|---|
| **Nuevo** | El pedido acaba de entrar (webhook de Shopify). Todavía no se intentó contactar al cliente por ningún canal. | `confirmation_status='pending'`, sin `agent_actions`, `sd_location_request` sin encolar |
| **Esperando confirmación** | El sistema está encolando o enviando el mensaje automático de WhatsApp (confirmación + solicitud de ubicación). | `confirmation_status='pending'`, `locationRequestStatus IN ('pending','processing')` (ver `src/lib/deliveries/sd-location-request-status.ts`) |
| **Esperando ubicación** | El mensaje ya se entregó al cliente. El sistema espera activamente su respuesta (compartir ubicación, o una confirmación equivalente). | `confirmation_status='pending'`, `locationRequestStatus='sent'` |
| **Confirmado** | El cliente confirmó — por ubicación de WhatsApp, por botón de WhatsApp, o por llamada de un agente humano (caso excepcional). | `confirmation_status='confirmed'`, `customer_confirmed=true`, `customer_confirmed_at` seteado, `confirmation_method` refleja el canal real |
| **Cancelado** | El cliente rechazó, no se pudo contactar tras los intentos permitidos, o está fuera de cobertura. | `confirmation_status IN ('cancelled','no_coverage','unreachable')` |

### Quién mueve cada transición

| Transición | Actor autorizado |
|---|---|
| Nuevo → Esperando confirmación | **Sistema** (webhook de Shopify encola `sd_location_request`) |
| Esperando confirmación → Esperando ubicación | **Sistema** (cron de `wa_template_queue` confirma el envío) |
| Esperando ubicación → Confirmado | **Cliente** (comparte ubicación o responde el botón de WhatsApp) — a futuro también **Génesis** si asiste la conversación |
| Cualquier estado → Confirmado (manual) | **Agente** — únicamente como excepción (ver sección Excepciones), nunca como flujo normal |
| Cualquier estado → Cancelado | **Cliente** (rechaza), **Agente** (marca sin cobertura / inalcanzable tras agotar intentos) |

**El mensajero nunca aparece en esta tabla.** Ningún estado comercial se mueve desde el rol
`santo_domingo_delivery_agent` actuando en Ruta COD.

---

# Estado Operativo

```
Sin asignar
  │
  ▼
Asignado
  │
  ▼
Ruta preparada
  │
  ▼
En recorrido
  │
  ▼
Entregado
  │
  ▼
Pagado
```

Este eje representa **únicamente la ejecución logística** — nunca dice nada sobre si el cliente
va a pagar o quiso el pedido. Un pedido puede estar `Asignado` sin estar `Confirmado` todavía (no
debería ocurrir bajo las reglas de este documento, pero el modelo de datos no lo impide por sí
solo — el motor de asignación es el que garantiza el orden correcto).

| Estado | Significado | Campos reales |
|---|---|---|
| **Sin asignar** | Ningún mensajero es dueño todavía. | `assigned_to IS NULL` |
| **Asignado** | Un mensajero fue seleccionado por `autoAssignSdOrder()`. | `assigned_to` seteado, `assigned_at` seteado |
| **Ruta preparada** | El pedido está despachado (`en_reparto`) y agrupado en la ruta derivada de su zona, pero el mensajero no inició el recorrido general todavía. | `normalized_status='en_reparto'`, sin `route_confirmed` en `agent_actions` — `SdStatus='confirmado_listo'` en `sd-status.ts` |
| **En recorrido** | El mensajero pulsó "Comenzar recorrido" (o "Continuar recorrido") para la ruta de su zona. | `agent_actions.action_type='route_confirmed'` más reciente sin transición posterior — `SdStatus='en_ruta'` |
| **Entregado** | El mensajero confirmó la entrega física. | `normalized_status='delivered'` |
| **Pagado** | El cobro quedó registrado — hecho distinto e independiente de "entregado" (regla ya vigente en el código: *"entregado ≠ pagado"*, ver `orders/[id]/actions/route.ts`). | fila `agent_actions.action_type` de pago + `shopify_sync_log(event_type='mark_paid')` |

Este eje es exactamente el que hoy modela `src/lib/deliveries/sd-status.ts` — no se reemplaza,
se documenta y se le agrega el peldaño explícito `Asignado` (hoy implícito en `assigned_to`, sin
nombre propio en el código).

---

# Motor único de transición comercial

`applyConfirmationAction()` — `src/lib/orders/confirmation.ts`

Es la **única puerta autorizada** para mover `confirmation_status` a `confirmed` o a cualquier
estado de cancelación. Ya la usan hoy:

- `POST /api/orders/[id]/confirmation` (agente humano, llamada telefónica)
- el webhook de WhatsApp, rama de botón `"Confirmar"`/`"No, gracias"`

Y debe extenderse para cubrir también:

- el webhook de WhatsApp, rama de **ubicación válida y no ambigua**

Esta función ya contiene, en una sola transacción, el auto-despacho SD (`normalized_status
='en_reparto'`) cuando corresponde — esto **no** viola el Principio 1: es el único puente
sancionado entre el eje comercial y el eje operativo, controlado y centralizado precisamente para
que no exista un segundo lugar donde ese puente ocurra.

**No deben existir endpoints que escriban directamente:**

```
normalized_status = 'en_reparto'
```

**saltándose `applyConfirmationAction()`.** Hoy existen dos violaciones activas de esta regla —
documentadas explícitamente en la sección de auditoría más abajo:

1. `src/app/api/orders/[id]/dispatch-local/route.ts:64`
2. `src/app/api/sd-delivery/orders/[id]/confirm-client/route.ts:52-61` (esta además duplica
   `confirmation_status='confirmed'` de forma completamente independiente — es la violación más
   grave, ya documentada como deuda pendiente en el propio historial del proyecto desde SD
   Delivery V2 Fase 4)

Corregirlas es explícitamente parte de la Fase 1 del roadmap.

---

# Motor de asignación

`autoAssignSdOrder()` — `src/lib/deliveries/sd-auto-assign.ts` (nuevo, diseñado, no implementado)

Es la **única función autorizada** para asignar un pedido a un mensajero (`orders.assigned_to`).

- **Nunca** confirma pedidos.
- **Nunca** modifica ninguna columna comercial (`confirmation_status`, `customer_confirmed`,
  `customer_confirmed_at`, `confirmation_method`).
- Se invoca desde dentro de `applyConfirmationAction()`, en la rama de auto-despacho SD — es decir,
  la asignación ocurre en el momento de la **confirmación efectiva**, no en el momento de
  creación del pedido (decisión ya verificada contra `computePool`, `routes.ts`,
  `orders_with_sla` y el trigger de SLA — no rompe ninguna de esas dependencias).
- Regla de selección (MVP, sin round-robin avanzado): mensajero principal configurado si existe →
  si no, el mensajero activo con menor cantidad de pedidos SD no terminales → desempate estable
  por `id`.
- Si no hay ningún mensajero SD activo: no falla el flujo que la invoca, deja `assigned_to=null`,
  registra una alerta operativa, y el pedido queda visible como excepción.

---

# Supervisor Operativo IA (futuro — no implementado en v1)

Responsabilidades que asumirá en fases posteriores, siempre operando exclusivamente sobre el eje
**operativo** (nunca sobre el comercial):

- Seleccionar mensajero (reemplazando la regla determinística simple de `autoAssignSdOrder` por
  una optimización real cuando haya más de un mensajero activo).
- Construir rutas (reemplazando el agrupamiento por zona de `buildDerivedRoutes` por una
  secuencia optimizada real).
- Insertar nuevas paradas en una ruta ya en curso.
- Reordenar rutas dinámicamente (tráfico, cancelaciones, nuevas confirmaciones).
- Optimizar recorridos (distancia real, no solo agrupación por zona).
- Emitir recomendaciones al mensajero (alertas in-app: "el pedido X ya tiene ubicación,
  agrégalo a tu recorrido").

El Supervisor Operativo IA es un **consumidor** de `autoAssignSdOrder`/`buildDerivedRoutes`, no un
reemplazo del Principio 3 — sigue sin poder confirmar clientes.

---

# Ruta COD

El mensajero, en el flujo normal, solo ejecuta acciones operativas:

- **Comenzar recorrido** (o **Continuar recorrido** si ya hay una ruta activa)
- **Entregado**
- **No responde**
- **Reprogramar**
- **Pagado** (solo disponible después de "Entregado")

Las acciones **Aceptar**, **Cliente confirma** y **Agregar a ruta individualmente** dejan de
formar parte del flujo principal. El pedido llega ya asignado y ya incorporado a la ruta derivada
de su zona antes de que el mensajero interactúe con él.

---

# Excepciones

Los botones manuales (`Aceptar`, `Cliente confirma`/`ready_for_route`, iniciar ruta por pedido
individual) **no se eliminan del sistema** — se conservan exclusivamente como acciones
secundarias, visibles solo dentro del detalle de un pedido, para rescates operativos:

- el cliente nunca respondió el WhatsApp automático y hay que llamarlo,
- el pedido quedó en la excepción "sin mensajero activo" y hay que reclamarlo manualmente,
- cualquier caso donde la automatización falló y un humano necesita intervenir.

Estas acciones **nunca** son el camino esperado para un pedido normal. Si se usan con frecuencia
para el flujo normal, es una señal de que la automatización tiene un bug — no una señal de que el
botón manual "es útil, dejarlo como estaba".

---

# Roadmap

**Fase 1 — Backend**
- Unificar transiciones: eliminar las escrituras paralelas a `normalized_status='en_reparto'` y
  `confirmation_status='confirmed'` fuera de `applyConfirmationAction()`.
- Implementar `autoAssignSdOrder()`.
- Extender el webhook de WhatsApp para confirmar y despachar automáticamente en ubicación válida
  y no ambigua.
- Migraciones aditivas: `profiles.is_active`, `profiles.is_sd_primary`,
  `orders.confirmation_method` acepta `'whatsapp_location'`.

**Fase 2 — Ruta COD UI**
- Ocultar del camino principal: Aceptar, Cliente confirma, Iniciar ruta por pedido individual.
- CTA principal: Comenzar recorrido / Continuar recorrido.
- Exponer el estado `Esperando ubicación` en la tarjeta de pedido.

**Fase 3 — Supervisor Operativo IA**
- Selección de mensajero más allá de la regla determinística simple.
- Recomendaciones y alertas in-app con datos reales.

**Fase 4 — Optimización de rutas**
- Reordenar y optimizar recorridos con distancia real, no solo agrupación por zona.

No se avanza a la fase siguiente sin haber probado la anterior con un pedido real — misma regla
de evidencia que rige el resto de esta auditoría.
