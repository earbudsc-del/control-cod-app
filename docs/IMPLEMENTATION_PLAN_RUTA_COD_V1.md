# Implementation Plan — Ruta COD v1

Este documento ejecuta el contrato definido en `docs/ARCHITECTURE_RUTA_COD_V1.md` (arquitectura
**congelada**). No se implementa nada fuera de este plan sin actualizarlo primero.

Cada fase se implementa, se valida con evidencia real, y espera aprobación explícita antes de
continuar con la siguiente. Ninguna fase avanza automáticamente.

---

# Reglas permanentes

Estas dos reglas rigen toda esta implementación y cualquier trabajo futuro sobre Ruta COD.
No son sugerencias — son criterio de revisión: cualquier PR/diff que las viole se rechaza sin
importar qué tan bien resuelva el problema puntual que atacaba.

### REGLA 1

Ningún endpoint puede modificar directamente:

- `confirmation_status`
- `normalized_status`
- `assigned_to`

si existe un motor compartido responsable de esa transición. Un endpoint que necesita ese efecto
llama al motor — nunca reimplementa el `UPDATE`.

### REGLA 2

Cada motor tiene una única responsabilidad. Ninguno invade el dominio de otro:

| Motor | Dominio |
|---|---|
| `applyConfirmationAction()` | transición comercial |
| `autoAssignSdOrder()` | asignación logística |
| `markDelivered()` | entrega |
| `markPaid()` | pago |
| `sd-status.ts` | proyección de UI — **nunca** persiste nada |

---

# Matriz de estado de fases

| Fase | Nombre | Depende de | Estado |
|---|---|---|---|
| 0 | Baseline de validación | — | ✅ **Validada** |
| 1 | Proyector puro de estado (`sd-status.ts`) | — | ✅ **Validada** |
| 2 | Migraciones aditivas (`is_active`, `confirmation_method`) | — | 🚧 **En progreso** |
| 3 | `autoAssignSdOrder()` standalone | Fase 2 | **Pendiente** |
| 4 | `applyConfirmationAction()` invoca asignación + caso sin mensajero | Fase 2, Fase 3 | **Pendiente** |
| 5 | Webhook WhatsApp — ubicación confirma y despacha | Fase 2, Fase 4 | **Pendiente** |
| 6 | `dispatch-local` delega en el motor compartido | Fase 4 | **Pendiente** |
| 7 | `confirm-client` → wrapper fino | Fase 4 | **Pendiente** |
| 8 | Exponer `commercialStatus`/`operationalStatus`/`displayStatus`/`allowedActions` | Fase 1, Fase 4 | **Pendiente** |
| 9 | Regresión `/sd-delivery` legacy | Fase 5, 6, 7 | **Pendiente** |

Ninguna fase se marca "Completada" hasta recibir aprobación explícita.

---

# Fase 0 — Baseline de validación

| Campo | Detalle |
|---|---|
| **Objetivo** | Capturar una fotografía real del estado del sistema *antes* de tocar cualquier archivo, para que cada fase posterior compare su "antes/después" contra un punto de referencia real, no supuesto |
| **Archivos** | Ninguno — fase de solo lectura, no se crea ni modifica código |
| **Cambios** | Ninguno — solo consultas de lectura contra Supabase (`SUPABASE_SERVICE_ROLE_KEY` local) |
| **Riesgo** | Nulo — solo lectura |
| **Cómo validar** | Ejecutar y registrar la distribución real de pedidos SD activos, el estado del/los mensajero(s), y el volumen histórico de uso de los dos endpoints que se van a refactorizar (Fases 6 y 7) |
| **Rollback** | No aplica |

## Evidencia real capturada (2026-07-19)

**Mensajero(s) SD existentes:** 1 — `Mensajero Santo Domingo` (`53ee5ded-b01c-485f-a387-55379b782477`),
creado 2026-05-20. Como `profiles.is_active` no existe todavía (Fase 2 pendiente), hoy es
"activo" por definición implícita (único candidato posible en `autoAssignSdOrder`).

**Universo SD elegible activo hoy** (`is_test=false`, sin guía EFI, no terminal, filtrado con la
misma lógica de `isSantoDomingoOrder`): **552 pedidos**, de un total de 1226 pedidos no-terminales
sin guía.

| `confirmation_status` | `normalized_status` | `assigned_to` seteado | Pedidos |
|---|---|---|---|
| pending | pending | no | 265 |
| confirmed | en_reparto | no | 222 |
| cancelled | pending | no | 44 |
| **confirmed** | **pending** | **no** | **15** |
| confirmed | en_reparto | sí | 3 |
| pending | pending | sí | 2 |
| no_coverage | pending | no | 1 |

**Hallazgo crítico del baseline:** la combinación que el diseño llama `confirmado_sin_asignar`
(decisión 5 de la arquitectura) **no es un caso hipotético — ya existe backlog real hoy**: 15
pedidos SD están `confirmed` pero nunca se despacharon ni asignaron. Esto es exactamente el
"backlog legacy" ya documentado en el historial del proyecto (SD Delivery V2, Fase 3 pendiente,
nunca cerrada). Estos 15 pedidos son candidatos reales de prueba para las Fases 4-6 — no hace
falta simular el escenario "sin mensajero activo", ya existe en producción.

**`sd_location_status`:** `NULL` en los 552 pedidos SD elegibles, sin excepción — confirma (otra
vez, con el universo completo esta vez, no solo una muestra) que el webhook de ubicación nunca ha
escrito un resultado real en ningún pedido activo hoy.

**Teléfono:** 0 de los 552 pedidos SD elegibles carecen de `customer_phone` — el 100% del backlog
activo es candidato al flujo automático de ubicación una vez desplegado.

**Volumen histórico de los endpoints a refactorizar:**

| Endpoint / origen | `action_type` / nota | Volumen histórico |
|---|---|---|
| `dispatch-local` (agente de despacho) | `local_dispatched` — "Despachado por agente de despacho" | 158 |
| `dispatch-local` (admin) | `local_dispatched` — "Despachado por admin" | 33 |
| `dispatch-local` (mensajero SD, desde `/sd-delivery`) | `local_dispatched` — "Despachado por mensajero SD" | 20 |
| `applyConfirmationAction` (auto-despacho, ya vigente) | `local_dispatched` — "Auto-despachado al confirmar" | 41 |
| `confirm-client` (mensajero SD) | `confirmed` — "Confirmado por mensajero SD" | 33 |

**`confirmation_method` de los pedidos SD ya confirmados:** `other`=341, `call`=33 (coincide
exactamente con el volumen de `confirm-client`), `whatsapp`=19. Ningún valor `whatsapp_location`
existe todavía (correcto — esa columna aún no acepta ese valor, Fase 2 pendiente).

**Uso de este baseline en fases posteriores:**
- Fase 4 se prueba directamente contra 1-2 de los 15 pedidos `confirmado_sin_asignar` reales.
- Fase 6 (`dispatch-local`) tiene volumen real (211 usos legítimos: 158+33+20) para dimensionar el
  impacto de tocar ese endpoint — no es una ruta muerta.
- Fase 7 (`confirm-client`) tiene 33 usos históricos como referencia de que el wrapper nuevo debe
  producir el mismo `confirmation_method='call'` para no romper esa serie histórica.
- Fase 9 debe reconfirmar, al cerrar, que el conteo de pedidos en `confirmado_sin_asignar` bajó
  (idealmente a 0, si se resuelve el backlog) o se mantiene explicable, nunca sube por un bug.

---

## Fase 0 — ✅ Validada (aprobada 2026-07-19)

Evidencia real capturada arriba. Usada como referencia directa por la Fase 1.

---

# Fase 1 — Proyector puro de estado — ✅ Validada (aprobada 2026-07-19)

**Archivo tocado:** únicamente `src/lib/deliveries/sd-status.ts` (agregado `computeCommercialStatus()`,
`computeOperationalStatus()`, `computeDisplayStatus()`, `computeAllowedActionsV2()`, junto a las
funciones existentes — ninguna se modificó ni se eliminó, nada las consume todavía).

**Evidencia real:**
- **641 pedidos SD reales comparados** (1226 no-terminales + 58 entregados de muestra, filtrados
  por `isSantoDomingoOrder`).
- **593 coincidencias exactas** entre `computeStatus()`/`computeAllowedActions()` (viejo) y
  `computeDisplayStatus()`/`computeAllowedActionsV2()` (nuevo).
- **48 diferencias, las 48 intencionales y explicadas** — corresponden a pedidos con
  `confirmation_status IN ('cancelled','no_coverage')`: el viejo `computeStatus()` nunca fue
  diseñado para recibir `pool=null` (ese input solo ocurre para esos dos estados) y por omisión
  caía al mismo bloque que `pool='nuevo'`, mostrando `status:'nuevo'` con acción `accept`
  disponible — un pedido que el cliente ya rechazó. El nuevo `computeCommercialStatus()` lo
  resuelve correctamente (`cancelado`, sin acciones). Confirmado que esto **no es una regresión**:
  las 4 queries SQL de `GET /api/v1/deliveries/orders` ya excluyen esos pedidos hoy antes de
  llegar a `computeStatus()`, así que ningún usuario real ve este comportamiento en producción.
- **22 pedidos reales proyectados como `confirmado_sin_asignar`** (subieron de los 15 del baseline
  de la Fase 0 — backlog creciendo, esperado sin corrección todavía).
- `npx tsc --noEmit` → limpio, sin errores.

---

# Fase 1 — Proyector puro de estado

| Campo | Detalle |
|---|---|
| **Objetivo** | Introducir el proyector de tres ejes sin tocar ningún endpoint todavía — código muerto hasta que algo lo invoque |
| **Archivos** | `src/lib/deliveries/sd-status.ts` |
| **Cambios** | Agregar, junto a las funciones actuales (no se borran todavía): `computeCommercialStatus()` (nuevo / esperando_confirmacion / esperando_ubicacion / confirmado / cancelado — deriva solo de `confirmation_status` + estado del template, nunca lee `assigned_to`); `computeOperationalStatus()` (sin_asignar / asignado / ruta_preparada / en_recorrido / entregado / pagado — deriva solo de `assigned_to` + `normalized_status` + `agent_actions`, nunca lee `confirmation_status`); `computeDisplayStatus()` (síntesis de los dos ejes, incluye `confirmado_sin_asignar` de la decisión 5, conserva los overlays `no_responde`/`reprogramado`/`cancelado`); `computeAllowedActionsV2()` |
| **Riesgo** | Nulo funcionalmente — nada lo invoca aún |
| **Cómo validar** | Script aislado que corre las 4 funciones nuevas contra los 552 pedidos del baseline de la Fase 0 y compara `displayStatus` contra `computeStatus` (función vieja) para los mismos pedidos — deben coincidir 1 a 1 en los 537 que NO están en `confirmado_sin_asignar`, y los 15 que sí deben proyectar correctamente ese nuevo valor |
| **Rollback** | Revertir el commit — cero impacto, nada lo consume |

---

# Fase 2 — Migraciones aditivas

| Campo | Detalle |
|---|---|
| **Objetivo** | Habilitar en el esquema real lo que el resto del plan necesita |
| **Archivos** | `supabase/migrations/0XX_profiles_is_active.sql` (contenido a definir en su propio turno) · `supabase/migrations/0XX_confirmation_method_whatsapp_location.sql` (contenido a definir en su propio turno) |
| **Cambios** | `profiles.is_active boolean not null default true` (aditivo — el único mensajero real queda activo automáticamente) · extender el `CHECK` de `orders.confirmation_method` para aceptar `'whatsapp_location'` |
| **Riesgo** | Bajo — ambos aditivos, nunca restringen |
| **Cómo validar** | `SELECT is_active FROM profiles WHERE role='santo_domingo_delivery_agent'` → `true` sin acción manual. Un `UPDATE` de prueba con `confirmation_method='whatsapp_location'` pasa sin error `23514` |
| **Rollback** | `DROP COLUMN is_active` / revertir el `CHECK` a los 3 valores originales — reversible sin pérdida de datos |

---

# Fase 3 — `autoAssignSdOrder()` standalone

| Campo | Detalle |
|---|---|
| **Objetivo** | Crear el motor de asignación completo, invocable de forma aislada, sin que ningún endpoint lo llame todavía |
| **Archivos** | `src/lib/deliveries/sd-auto-assign.ts` (nuevo) |
| **Cambios** | `autoAssignSdOrder(supabase, orderId, storeId)` — candidatos: `santo_domingo_delivery_agent` con `is_active=true`, orden estable por `id`. 0 → `no_active_courier`. 1 → `only_candidate`. 2+ → `least_loaded` con desempate por `id`. Sin ninguna rama de `is_sd_primary`. Nunca toca columnas comerciales |
| **Riesgo** | Nulo funcionalmente. Depende de Fase 2 aplicada |
| **Cómo validar** | Invocación manual aislada contra 2-3 pedidos SD de prueba y 2 perfiles de mensajero de prueba (uno activo, uno inactivo) — confirmar `assigned_to` correcto, auditoría con `agent_id:null`, y que 0 candidatos activos no lanza excepción |
| **Rollback** | Eliminar el archivo — ningún endpoint depende de él todavía |

---

# Fase 4 — `applyConfirmationAction()` invoca la asignación + maneja "confirmado sin mensajero"

| Campo | Detalle |
|---|---|
| **Objetivo** | La única transición comercial dispara, cuando corresponde, la única transición logística de asignación — y el caso sin mensajero activo (15 pedidos reales hoy, según baseline) queda cubierto |
| **Archivos** | `src/lib/orders/confirmation.ts` |
| **Cambios** | Dentro de `isSdAutoDispatch`: llamar primero `autoAssignSdOrder()`; si `assigned:true` → `normalized_status='en_reparto'`+`status_since` (sin cambio de comportamiento); si `assigned:false` → **no** tocar `normalized_status`, pero sí escribir `confirmation_status='confirmed'`+`customer_confirmed`+`customer_confirmed_at`+`confirmation_method` igual (transición comercial incondicional) + alerta operativa. `ConfirmMethod` amplía a `'whatsapp_location'`. Se extrae la mecánica de despacho a una función reutilizable por la Fase 6 |
| **Riesgo** | **Alto** — función compartida por TODA confirmación del sistema, no solo SD |
| **Cómo validar** | (a) Confirmar un pedido NO-SD real → sin cambios observables. (b) Confirmar un pedido SD con mensajero activo → igual que hoy. (c) Con mensajero desactivado, confirmar uno de los 15 pedidos del baseline (o uno nuevo de prueba) → `confirmed`+`assigned_to=null`+`normalized_status` sin cambiar, `displayStatus='confirmado_sin_asignar'` |
| **Rollback** | Revertir el commit. Flag de entorno `SD_AUTO_ASSIGN_ENABLED` para apagar en producción sin redeploy |

---

# Fase 5 — Webhook de WhatsApp: ubicación válida y no ambigua confirma y despacha

*(orden invertido respecto al borrador anterior — ahora primero)*

| Campo | Detalle |
|---|---|
| **Objetivo** | Cerrar el gap central del MVP — la ubicación deja de ser solo informativa |
| **Archivos** | `src/app/api/webhooks/whatsapp/route.ts` (bloque 4b, líneas 551-584) |
| **Cambios** | Cuando `locationStatus==='received'`: además de guardar `sd_location_*` (sin cambios), llamar `applyConfirmationAction({action:'confirmed', method:'whatsapp_location', userId:null, guardAutomated:true})`. Cuando `'ambiguous'`: sin cambios |
| **Riesgo** | **Alto** — depende de Fase 2 y Fase 4 ya probadas. Único punto donde un cliente real dispara la cadena sin humano de por medio |
| **Cómo validar** | Con un pedido SD de prueba real y el mensajero activo, enviar un pin de ubicación real desde un teléfono de prueba → verificar en orden: `wa_messages` real → `sd_location_status='received'` → `confirmation_status='confirmed'`+`confirmation_method='whatsapp_location'` → `assigned_to` → `en_reparto` → aparece en `GET /routes` con `displayStatus='confirmado_listo'`. Reenviar el mismo pin → nada se duplica. Probar con 2 pedidos activos del mismo teléfono → ninguno cambia (ambiguo) |
| **Rollback** | Revertir el commit — vuelve a ser puramente informativo. Flag `SD_LOCATION_AUTO_CONFIRM_ENABLED` |

---

# Fase 6 — `dispatch-local` delega en el motor compartido

*(antes Fase 5)*

| Campo | Detalle |
|---|---|
| **Objetivo** | Eliminar la escritura directa de `en_reparto` (Regla 1); redefinir su propósito real: botón de rescate manual para resolver un pedido `confirmado_sin_asignar` — hay 15 candidatos reales hoy (baseline) |
| **Archivos** | `src/app/api/orders/[id]/dispatch-local/route.ts` |
| **Cambios** | Reemplazar el `UPDATE` directo (líneas 61-66) por: llamar `autoAssignSdOrder()`; si asigna, usar la mecánica de despacho de la Fase 4; si `no_active_courier`, `422` explícito en vez de despachar a ciegas. Validaciones existentes sin cambio |
| **Riesgo** | Medio — 211 usos legítimos históricos (baseline), endpoint activo desde `/confirmados` y `/sd-delivery` |
| **Cómo validar** | Sobre uno de los 15 pedidos reales `confirmado_sin_asignar` del baseline, con el mensajero activo, llamar `dispatch-local` → `assigned_to`+`en_reparto`. Repetir con mensajero desactivado → `422` sin tocar el pedido |
| **Rollback** | Revertir el commit — vuelve al `UPDATE` directo actual |

---

# Fase 7 — `confirm-client` → wrapper fino

*(antes Fase 6)*

| Campo | Detalle |
|---|---|
| **Objetivo** | Eliminar la duplicación completa de lógica comercial — 33 usos históricos (baseline) corrían esta lógica por fuera de `applyConfirmationAction` |
| **Archivos** | `src/app/api/sd-delivery/orders/[id]/confirm-client/route.ts` |
| **Cambios** | Reemplazar el `Promise.all` de 3 escrituras manuales (líneas 43-82) por una llamada a `applyConfirmationAction({action:'confirmed', method:'call', userId:profile.id})`. El chequeo previo "ya confirmado → 409" se conserva. Respuesta JSON sin cambios |
| **Riesgo** | Bajo — un solo consumidor (`/sd-delivery/page.tsx`) |
| **Cómo validar** | Desde `/sd-delivery` (fallback, decisión 9), con usuario mensajero de prueba, tocar "Cliente confirma" sobre un pedido real → mismo resultado visible + `confirmation_method='call'` en DB, igual que los 33 históricos |
| **Rollback** | Revertir el commit — vuelve a la implementación duplicada, sigue siendo funcional aunque viole la Regla 1 |

---

# Fase 8 — Exponer `commercialStatus` / `operationalStatus` / `displayStatus` / `allowedActions`

| Campo | Detalle |
|---|---|
| **Objetivo** | El contrato externo de la API refleja explícitamente los tres ejes |
| **Archivos** | `src/app/api/v1/deliveries/orders/route.ts` · `orders/[id]/actions/route.ts` · `routes/route.ts` · `routes/[id]/route.ts` |
| **Cambios** | Sustituir `computeStatus`/`computeAllowedActions` por las funciones de la Fase 1, agregar los 4 campos al JSON. `status` se mantiene como alias de `displayStatus` hasta la fase de UI (fuera de este plan) |
| **Riesgo** | Medio — nada en producción los consume todavía |
| **Cómo validar** | Comparar respuesta antes/después para los mismos pedidos del baseline — `status` (alias) idéntico a `displayStatus` salvo en los 15 casos `confirmado_sin_asignar` |
| **Rollback** | Revertir los commits — la API vuelve a exponer solo `status`/`allowedActions` |

---

# Fase 9 — Regresión de `/sd-delivery` legacy

| Campo | Detalle |
|---|---|
| **Objetivo** | Confirmar que mantener `/sd-delivery` como fallback (decisión 9) sigue siendo cierto tras las Fases 4-7 |
| **Archivos** | Ninguno se modifica — verificación sobre `src/app/(app)/sd-delivery/page.tsx` y sus endpoints de soporte |
| **Cambios** | Ninguno |
| **Riesgo** | Bajo — red de seguridad final |
| **Cómo validar** | Recorrer el flujo completo en `/sd-delivery` con el mensajero real: Nuevos → Cliente confirma (Fase 7) → Confirmados/Listos → Iniciar ruta → En ruta → Marcar entregado, sobre un pedido real — igual que antes, incluida persistencia tras F5. Reconfirmar el conteo de pedidos `confirmado_sin_asignar` contra el baseline de la Fase 0 (15) — debe explicarse cualquier cambio, nunca subir por un bug |
| **Rollback** | No aplica — si hay regresión, se revierte la fase específica causante (4, 5, 6 o 7) |
