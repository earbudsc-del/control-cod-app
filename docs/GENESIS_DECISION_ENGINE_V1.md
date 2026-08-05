# Génesis — Decision Engine V1

Documento de arquitectura pura. Cero código, cero prompts, cero SQL, cero
TypeScript, cero pseudocódigo, cero implementación. Este documento no
reutiliza ni repite ninguno de los anteriores — los consume como insumos.
Posición en la pila:

```
Customer Intelligence
        ↓
Knowledge Engine
        ↓
Commercial Engine
        ↓
Sales Engine
        ↓
DECISION ENGINE   ← (este documento)
        ↓
Response Generator   (futuro, no diseñado todavía)
        ↓
Respuesta final
```

Cada capa anterior sabe hacer una cosa bien y solo esa cosa. Customer
Intelligence sabe quién es el cliente. Knowledge Engine sabe qué es verdad
sobre el producto. Commercial Engine sabe cómo debería sonar una respuesta.
Sales Engine sabe cómo piensa un vendedor experto — qué estrategia, qué
etapa, qué avatar, qué concepto, qué árbol de decisión comercial aplica.

Ninguna de esas capas, por sí sola, decide qué hacer **en este turno
exacto**. Cada una ofrece un punto de vista parcial. El Decision Engine es
el único lugar del sistema donde todos esos puntos de vista se cruzan, se
pesan unos contra otros, y se resuelven en una sola decisión. No genera
lenguaje. No conoce el catálogo de ofertas ni el precio de nada. No sabe
redactar una frase de cierre. Si se le preguntara "¿qué le dirías a este
cliente?", su respuesta correcta sería "eso no es mi trabajo, pregúntale al
Response Generator" — porque el Decision Engine no responde clientes.
**Decide.**

---

## 1. Filosofía del Decision Engine

**Qué hace.** Recibe el estado completo de una conversación en un instante
dado — quién es el cliente, qué acaba de decir, qué se sabe de él, qué
opina cada motor comercial sobre qué hacer — y produce una única salida
estructurada: un Decision Plan (sección 3). Es un árbitro, no un
generador. Su trabajo termina en el momento exacto en que decide qué debe
pasar; no participa en cómo se ejecuta esa decisión en palabras.

**Qué NO hace.** No sabe redactar. No sabe qué frases suenan bien en
español dominicano (eso es Commercial Engine). No sabe cuál es el
mecanismo del ingrediente activo (eso es Knowledge Engine). No sabe cómo
piensa un vendedor sobre un avatar Comprador desconfiado (eso es Sales
Engine, y el Decision Engine simplemente **usa** esa conclusión, no la
vuelve a razonar desde cero). No mantiene una relación con el cliente — no
tiene tono, no tiene personalidad, no tiene tacto. Es, deliberadamente,
frío y estructural: un sistema operativo no tiene personalidad, tiene
lógica de asignación de recursos y resolución de conflictos.

**Por qué existe.** Sin este motor, cada capa anterior compite por el
control del mensaje sin ningún árbitro: Sales Engine querría avanzar hacia
el cierre, Knowledge Engine insistiría en dar el dato técnico completo,
Customer Intelligence marcaría una alerta de riesgo, y nada en el sistema
decidiría cuál de esas tres voces gana en un turno específico. El Decision
Engine existe para que exactamente una decisión salga de cada turno,
nunca una mezcla de tres impulsos distintos compitiendo en el mismo
mensaje.

**Qué problemas resuelve.** Tres, específicamente: (1) el problema de
**arbitraje** — cuando dos motores comerciales sugieren acciones
incompatibles, algo tiene que decidir cuál gana, con una regla, no al azar;
(2) el problema de **continuidad** — una conversación tiene estado que
persiste turno a turno (momentum, confianza, objetivo activo), y sin un
motor que lo mantenga, cada turno se procesaría como si fuera el primero;
(3) el problema de **contención** — saber cuándo la decisión correcta es no
avanzar nada, no vender nada, no preguntar nada, simplemente esperar o
escalar, incluso cuando otro motor comercial insistiría en actuar.

---

## 2. Inputs

El Decision Engine no recibe "un mensaje" — recibe una fotografía completa
del estado de la conversación en el instante del turno actual. Los inputs
se agrupan en ocho categorías:

**Mensaje actual.** El texto entrante crudo, su tipo (texto, ubicación,
imagen), y metadatos triviales (hora, canal). Es el disparador del turno,
pero nunca la única fuente de la decisión.

**Customer Intelligence.** Quién es este cliente — cliente nuevo, cliente
recurrente, historial de compras previas, si ya tuvo una cancelación o
devolución antes, si hay alguna alerta previa asociada a su número. Esta
capa aporta contexto de identidad, no contexto de la conversación actual.

**Knowledge Engine.** El conjunto de hechos verdaderos disponibles en este
momento — no como texto a repetir, sino como el límite de lo que se puede
afirmar. El Decision Engine consulta esta capa para verificar, nunca para
redactar.

**Commercial Engine.** El conjunto de reglas de tono, estructura y forma —
el Decision Engine no las aplica (eso es el Response Generator), pero sí
necesita saber, por ejemplo, si el turno cae en una categoría donde el
Commercial Engine ya definió un límite explícito (no presentar oferta
inmediatamente después de una pregunta médica sensible, por ejemplo) para
que esa restricción entre al arbitraje.

**Sales Engine.** El punto de vista comercial completo: avatar sugerido,
etapa del comprador sugerida, concepto dominante sugerido, estrategia
recomendada, señales de compra detectadas, objeción activa si la hay. El
Decision Engine trata todo esto como **una opinión de experto a
considerar**, no como una orden a ejecutar automáticamente — el arbitraje
todavía puede anularla si otro input tiene prioridad mayor (sección 5).

**Conversation Context.** Lo inmediato: los últimos mensajes de este
intercambio, qué se dijo hace un turno, hace dos turnos, si ya se presentó
una oferta en este mismo hilo, si ya se hizo una pregunta que sigue sin
respuesta.

**Conversation Memory (futura).** Lo que se sabe de conversaciones
anteriores con este mismo cliente, en sesiones distintas — no solo este
hilo, sino el historial completo de la relación. En V1 este input puede
llegar vacío o parcial; el Decision Engine está diseñado para funcionar
igual de bien con memoria completa que con memoria ausente, degradando su
confianza (sección 8), no su funcionamiento.

**Pedido actual.** Si existe un pedido en curso asociado a este cliente:
su estado (confirmado, en ruta, entregado, cancelado), y si el mensaje
actual tiene relación directa con ese pedido (una pregunta de entrega) o es
independiente (una consulta sobre un producto nuevo).

**Historial reciente / Estado comercial.** El acumulado de turnos previos
de esta misma conversación ya interpretado por el propio Decision Engine en
turnos anteriores — el objetivo que estaba activo, el nivel de momentum, el
nivel de confianza, el riesgo detectado, si hay una intervención humana
activa. Este es el input más importante de todos: es el propio estado
anterior del motor, lo que le permite pensar en la conversación como un
proceso continuo en vez de una serie de eventos aislados.

Ningún input, por sí solo, es suficiente para decidir. Un mensaje sin
contexto es ambiguo. Un avatar sugerido sin momentum no dice si es momento
de actuar. Un pedido en curso sin intención clara no dice si el cliente
quiere hablar de ese pedido o de algo nuevo. La decisión nace siempre del
cruce de varios inputs, nunca de uno aislado.

---

## 3. Output — el Decision Plan

El Decision Engine produce exactamente un objeto conceptual por turno: el
**Decision Plan**. No es una respuesta. Es una instrucción estructurada
que el Response Generator (capa siguiente, no diseñada aún) tomará para
producir lenguaje. Sus campos:

**Objetivo del turno.** El objetivo único decidido para este mensaje
(heredado conceptualmente del catálogo de objetivos del Sales Engine, pero
la elección final entre ellos es responsabilidad exclusiva de este motor,
no del Sales Engine — ver Goal Engine, sección 6).

**Prioridad.** La razón de más alto nivel que determinó este plan —
referencia a cuál nivel de la jerarquía de la sección 5 fue el que ganó el
arbitraje de este turno (por ejemplo: "este plan existe por Seguridad", o
"este plan existe por Momentum"). Este campo no es decorativo — permite que
cualquier revisión posterior entienda por qué se decidió lo que se decidió,
sin tener que re-derivarlo.

**Acción principal.** La única acción central de este turno: responder,
preguntar, educar, resolver objeción, presentar oferta, cerrar, esperar,
escalar, no responder. (El catálogo completo de acciones posibles es el
mismo catálogo de estrategias ya definido por el Sales Engine — el Decision
Engine no inventa una lista nueva, selecciona una de esa lista existente
con criterio propio).

**Acción secundaria (opcional).** Un matiz que acompaña a la acción
principal sin competir con ella — por ejemplo, "responder" como acción
principal con "sembrar una pregunta breve de descubrimiento" como matiz
secundario. Nunca dos acciones de peso equivalente; la secundaria siempre
es subordinada.

**Pregunta (si aplica).** Un indicador de si este turno debe incluir una
pregunta, y con qué propósito (descubrimiento, confirmación, avance) — sin
especificar el texto de la pregunta, eso pertenece al Response Generator.

**CTA (si aplica).** Un indicador de si el turno debe cerrar con una
llamada a la acción, y de qué tipo (suave, operativo, ninguno) —
nuevamente, sin texto.

**Oferta (si aplica).** Un indicador de si corresponde presentar la oferta
comercial en este turno, y en qué nivel de detalle (mención breve,
presentación completa) — el contenido exacto de la oferta es
responsabilidad del Knowledge Engine, no de este plan.

**Escalar (booleano + razón).** Si este turno debe entregarse a un humano,
y la razón categorizada (seguridad, objeción sin resolver tras múltiples
intentos, solicitud fuera de política, cliente en riesgo, etc.). Cuando
este campo es verdadero, casi todos los demás campos del plan quedan
vacíos o irrelevantes — escalar es, en la práctica, un plan que reemplaza a
todos los demás.

**Esperar (booleano).** Si la decisión correcta es no enviar ningún
movimiento de avance en este turno — deliberadamente distinto de "no
responder": esperar puede coexistir con una respuesta corta de servicio,
simplemente sin ningún empuje comercial.

**No responder (booleano).** Reservado para casos extremos donde
literalmente no corresponde ninguna respuesta (mensaje duplicado ya
procesado, ruido técnico, contenido irrelevante detectado con alta
confianza) — el caso menos común de todos, y el que requiere mayor
confianza (sección 8) antes de activarse, porque el costo de un falso
positivo (ignorar a un cliente real) es alto.

**Cerrar (booleano).** Si el turno debe intentar activamente facilitar el
cierre de una decisión de compra ya tomada por el cliente.

Cada campo de este plan es una decisión, no una sugerencia — pero el plan
completo, como conjunto, es lo único que cruza la frontera hacia la capa
siguiente. El Response Generator no ve los inputs originales ni el
razonamiento interno del Decision Engine; ve únicamente este objeto.

---

## 4. Pipeline mental

El procesamiento de un turno ocurre en una secuencia ordenada de
actualizaciones de estado, cada una construyendo sobre la anterior. Ninguna
etapa se salta, incluso cuando el resultado de una etapa es "sin cambios":

**1. Ingerir el mensaje.** Registrar el contenido crudo del turno, sin
interpretarlo todavía.

**2. Actualizar el contexto conversacional.** Incorporar el mensaje al
hilo — qué se dijo antes, cuánto tiempo pasó, si es continuación o si
reabre algo cerrado.

**3. Verificar intervención humana.** Antes de razonar nada más,
comprobar si un humano tiene la conversación tomada (ver Human Override,
sección 14). Si es así, el pipeline se detiene aquí para casi todo lo
demás — el Decision Engine sigue observando pero no decide acciones
comerciales.

**4. Actualizar identidad del comprador.** Incorporar cualquier señal
nueva de Customer Intelligence — ¿es la misma persona que ya se conocía?
¿hay un pedido activo relevante?

**5. Actualizar avatar.** Revisar si el mensaje actual confirma, ajusta o
contradice el avatar sugerido por el Sales Engine hasta este punto de la
conversación.

**6. Actualizar concepto dominante.** Igual que el avatar — el concepto de
producto relevante (sección 5 del Sales Engine) puede mantenerse, ampliarse
o cambiar según lo que el mensaje actual introduce.

**7. Actualizar etapa del comprador.** Reevaluar en qué punto del
recorrido (Sales Engine, sección 3) está el cliente ahora, que puede ser
igual, más avanzado, o retrocedido respecto al turno anterior.

**8. Actualizar intención del turno.** Interpretar qué busca el cliente
específicamente con este mensaje puntual — distinto de la etapa general,
es la lectura de las 4 capas del mensaje actual (Sales Engine, sección 2).

**9. Actualizar objeciones activas.** ¿Este mensaje introduce una objeción
nueva, repite una ya existente, o la resuelve?

**10. Actualizar riesgo.** Correr la detección de señales de riesgo
(sección 9) sobre el mensaje actual y el estado acumulado.

**11. Actualizar confianza del propio motor.** Recalcular qué tan seguro
está el Decision Engine de sus propias lecturas de los pasos 5-9 (sección
8) — este paso es sobre la certeza del sistema, no sobre la confianza del
cliente.

**12. Actualizar momentum.** Ajustar el estado de energía conversacional
acumulada según lo que pasó en este turno (sección 7).

**13. Resolver el objetivo del turno.** Con todo lo anterior actualizado,
el Goal Engine (sección 6) decide el objetivo único de este mensaje.

**14. Elegir estrategia.** Traducir ese objetivo, cruzado con el avatar,
etapa, concepto y estrategia sugerida por el Sales Engine, en una acción
concreta candidata.

**15. Aplicar el Priority Engine.** Verificar si algo de mayor jerarquía
(sección 5) anula, modifica o reemplaza la acción candidata del paso 14.

**16. Validar contra errores críticos.** Revisar la decisión final contra
la lista de la sección 16 antes de emitirla — una última red de
seguridad, no un paso creativo.

**17. Emitir el Decision Plan.** Producir el objeto final de la sección 3.

**18. Registrar en el historial de decisiones.** Guardar (conceptualmente,
sección 15) qué se decidió y por qué, para que el siguiente turno empiece
con este turno ya incorporado como parte del estado, no como información
perdida.

Esta secuencia no es un requisito burocrático — cada paso existe porque el
paso siguiente depende de él. Elegir estrategia (14) sin haber actualizado
avatar y etapa (5, 7) sería elegir a ciegas. Emitir el plan (17) sin
validar contra errores críticos (16) sería confiar en el arbitraje sin
ninguna verificación final.

---

## 5. Priority Engine

Cuando dos o más motores dentro del pipeline sugieren acciones
incompatibles en el mismo turno, esta jerarquía decide, de mayor a menor,
sin excepción:

1. **Seguridad.** Cualquier señal de riesgo real (médica, de daño, de
   fraude hacia el cliente) anula cualquier otra consideración. Nada
   compite con esto.
2. **Verdad.** Ninguna decisión puede requerir, implícita o
   explícitamente, afirmar algo fuera del Knowledge Engine.
3. **Pedido existente.** Si hay un pedido activo y el mensaje se relaciona
   con él, atenderlo tiene prioridad sobre cualquier objetivo comercial
   nuevo — un cliente con un pedido en curso no es, en ese momento, un
   lead a trabajar.
4. **Escalamiento activo o necesario.** Si ya hay una escalación abierta,
   o si este turno la dispara, el Decision Engine deja de generar
   decisiones comerciales activas — su rol pasa a ser de observador, no de
   actor.
5. **Sales Engine.** Con seguridad, verdad, pedido y escalamiento
   descartados como factores presentes, el punto de vista comercial del
   Sales Engine (estrategia, objetivo, señales de compra) es la siguiente
   autoridad.
6. **Knowledge Engine.** Los límites de lo que se puede afirmar acotan
   cómo se ejecuta lo que el Sales Engine sugiere, incluso cuando no hay
   ningún riesgo de seguridad involucrado — una sugerencia comercial nunca
   puede pedir un hecho que el Knowledge Engine no respalda.
7. **Conversation Goals.** El objetivo acumulado de toda la conversación
   (Sales Engine, sección 8) desempata cuando el objetivo del turno
   inmediato admite más de una interpretación razonable.
8. **Momentum.** Cuando ninguno de los niveles anteriores define un
   ganador claro, el estado de momentum (sección 7) decide si conviene
   avanzar con energía o mantener cautela.
9. **Confianza del motor.** El último nivel de desempate: si después de
   todo lo anterior la confianza del propio Decision Engine en su lectura
   del turno es baja, se prefiere la opción más conservadora disponible
   (generalmente: preguntar en vez de asumir, o responder en vez de
   avanzar).

Cada nivel de esta jerarquía **solo actúa si el nivel anterior no dictó ya
una decisión inequívoca**. Es una cascada de veto, no una suma ponderada —
Seguridad no "pesa más" que Momentum en un promedio, Seguridad **anula**
Momentum por completo cuando ambos aplican al mismo turno.

---

## 6. Goal Engine

El Sales Engine ofrece un catálogo de objetivos posibles por turno
(generar confianza, descubrir intención, resolver objeción, cerrar, etc.) —
pero **decidir cuál de ellos aplica a este turno específico, y cuándo
cambiarlo**, es trabajo exclusivo del Decision Engine, no del Sales Engine.
Esta distinción importa: el Sales Engine sabe qué objetivos existen y qué
significan; el Goal Engine sabe cuál corresponde ahora, dado todo el
estado acumulado, no solo el contenido del mensaje.

**Cómo decide el objetivo del turno.** El Goal Engine parte del objetivo
que estaba activo en el turno anterior (persistencia por defecto — un
objetivo no cambia sin una razón) y evalúa tres preguntas en orden: ¿el
mensaje actual resuelve el objetivo activo? (si sí, se libera y se busca el
siguiente). ¿El mensaje actual introduce algo de mayor prioridad que
interrumpe el objetivo activo? (una objeción nueva interrumpe un objetivo
de "construir valor" en curso; una señal de compra interrumpe casi
cualquier objetivo en curso). ¿El mensaje actual es simplemente continuo
con el objetivo activo? (si sí, se mantiene sin cambios).

**Regla de unicidad.** Nunca existe más de un objetivo activo a la vez.
Cuando el análisis anterior sugiere dos candidatos simultáneos (el mensaje
resuelve una objeción Y muestra una señal de compra en el mismo texto), el
Goal Engine no promedia ni combina — aplica la jerarquía de prioridad
comercial ya definida en el Sales Engine (sección 2 de ese documento: una
señal de compra activa siempre gana sobre cualquier objetivo de
descubrimiento o construcción).

**Cómo resolver conflictos.** Cuando el propio Sales Engine sugiere un
objetivo pero el Priority Engine (sección 5) detecta un factor de mayor
jerarquía (un pedido existente, una señal de riesgo), el Goal Engine no
"negocia" — adopta el objetivo que ese nivel superior imponga, incluso si
contradice lo que el análisis puramente comercial hubiera sugerido.

**Cuándo cambiar de objetivo.** Solo ante una de tres condiciones: el
objetivo activo ya se cumplió, un factor de prioridad superior lo
interrumpe, o han pasado suficientes turnos sin ningún progreso hacia ese
objetivo como para considerar que insistir en él ya no es productivo (esto
se mide con el Momentum Engine, sección 7 — un objetivo que no avanza
drena momentum, y momentum bajo es, en sí mismo, una señal para
reconsiderar el objetivo).

**Cuándo mantenerlo.** Por defecto, siempre — el cambio de objetivo es la
excepción que requiere justificación, no la regla. Un sistema que cambia
de objetivo en cada turno sin una razón concreta se comporta exactamente
como el error crítico #16 del Sales Engine describe: una conversación que
nunca avanza en ninguna dirección sostenida.

---

## 7. Momentum Engine

Momentum es la energía acumulada de avance dentro de una conversación —
una medida de si la conversación se está moviendo hacia una decisión o se
está estancando. No es una emoción del cliente (eso pertenece al Emotion
Engine del Sales Engine) — es una propiedad del **proceso**, observada por
el Decision Engine desde afuera.

**Cómo crece.** Cada micro-compromiso del cliente (Sales Engine, sección
11) suma momentum: continuar la conversación después de una respuesta,
hacer una pregunta de seguimiento, aceptar una afirmación sin objetarla,
dar un dato sin que se pida, mostrar cualquier señal de avance en la
etapa del comprador. El momentum crece de forma incremental, turno a
turno, nunca de un salto por un solo mensaje entusiasta aislado.

**Cómo disminuye.** Silencios largos, respuestas monosilábicas repetidas,
repetición de una objeción ya resuelta, un retroceso de etapa (de
Convencido a Escéptico, por ejemplo), o un cambio de tema que abandona sin
resolver lo que se venía construyendo.

**Qué señales lo aumentan específicamente.** Señales de compra (Sales
Engine, sección 11), preguntas que profundizan en vez de reabrir temas ya
cerrados, aceptación de un reencuadre de objeción sin repetirla después,
continuidad rápida entre mensajes del cliente (respuestas casi inmediatas).

**Qué señales lo rompen específicamente.** Una objeción que reaparece por
segunda vez, un silencio que se extiende más allá de lo esperable para el
ritmo que traía la conversación, una contradicción del cliente respecto a
algo que él mismo dijo antes (ver Recovery Engine, sección 13), o una señal
explícita de duda nueva después de haber estado en una etapa avanzada.

**Cómo afecta las decisiones.** El momentum no decide una acción por sí
solo — modula la intensidad de la acción que otros motores ya sugieren.
Con momentum alto, el Decision Engine se inclina hacia acciones que avanzan
activamente (presentar oferta, cerrar) incluso con menos certeza de la que
normalmente exigiría. Con momentum bajo, se inclina hacia acciones de bajo
riesgo (responder, esperar) incluso cuando el Sales Engine sugeriría
avanzar — porque avanzar sin momentum real se siente forzado, y el
Decision Engine está diseñado para evitar exactamente esa sensación.
Momentum es, en efecto, el "sentido de oportunidad" del sistema: no cambia
qué es verdad ni qué está permitido, cambia cuánto se arriesga en el
siguiente movimiento.

---

## 8. Confidence Engine

Este motor no mide la confianza **del cliente** en el producto o el
negocio (esa es la emoción "Confianza" del Sales Engine) — mide la
confianza **del propio Decision Engine** en la exactitud de su propia
lectura del estado de la conversación. Es autoevaluación del sistema, no
del usuario.

**Qué se mide.** Un nivel de certeza independiente para cada una de las
lecturas clave del pipeline: ¿qué tan seguro está el motor de haber
identificado correctamente el avatar? ¿de la intención de este mensaje
puntual? ¿del concepto de producto relevante? ¿de la etapa del comprador?
¿del estado real del pedido asociado? ¿de si existe o no una objeción
activa? Cada una de estas seis lecturas tiene su propio nivel de certeza,
no un solo número global — es posible tener alta confianza en el avatar
pero baja confianza en la intención del mensaje actual, y el sistema debe
tratar cada una según corresponda, no promediarlas en una sola cifra que
oculte cuál lectura específica es la débil.

**De dónde viene la certeza.** Aumenta con: señales explícitas y directas
del cliente (decir literalmente "soy madre y es para mi hijo" da certeza
alta de avatar; una inferencia indirecta da certeza media). Aumenta con
consistencia a través de varios turnos (un avatar que se confirma en 3
mensajes seguidos es más cierto que uno inferido de un solo mensaje
ambiguo). Disminuye con señales contradictorias, con mensajes ambiguos que
admiten varias lecturas igualmente válidas, y con la ausencia de historial
previo (una conversación que empieza en este mismo turno tiene, por
definición, menos certeza acumulada que una que lleva diez intercambios).

**Cómo actuar cuando la confianza es baja.** Nunca ocultando la
incertidumbre ni "adivinando con seguridad fingida" — el Decision Engine
responde a la baja confianza escogiendo la acción que menos depende de
estar en lo correcto. Si la confianza sobre el avatar es baja, el objetivo
del turno se inclina hacia descubrir (una pregunta), no hacia construir
valor específico (que requeriría ya saber para quién). Si la confianza
sobre si existe una objeción activa es baja, se prefiere responder de
forma neutra antes que asumir una objeción que tal vez no está ahí. La
baja confianza nunca detiene el sistema por completo (eso sería
sobre-reaccionar) — lo hace más conservador y más orientado a obtener
información antes que a actuar con convicción.

**Relación con el Priority Engine.** La confianza es, deliberadamente, el
último nivel de la jerarquía de prioridad (sección 5) — solo entra a
desempatar cuando ningún nivel superior ya definió la decisión. No tiene
sentido que la incertidumbre del motor sobre el avatar del cliente compita
con una señal de seguridad real; la jerarquía ya refleja eso.

---

## 9. Risk Engine

**Qué riesgos existen.** Cuatro categorías, cada una con su propio
mecanismo de detección y su propia respuesta:

- **Riesgo de seguridad/salud** — heredado directamente del Knowledge
  Engine (señales médicas reales ya catalogadas: dolor intenso,
  inflamación, sangrado, reacción adversa, embarazo/niños sin información
  aprobada). El Decision Engine no reinterpreta estas señales, las recibe
  ya clasificadas.
- **Riesgo de confianza/fraude percibido** — cuando el cliente muestra
  señales fuertes de sospechar que el negocio no es legítimo, más allá de
  un escepticismo normal manejable comercialmente — el umbral donde
  seguir "vendiendo confianza" ya no es suficiente y se necesita
  intervención distinta.
- **Riesgo comercial** — el riesgo de tomar una decisión de venta
  incorrecta: cerrar sin señales reales, presentar una oferta a alguien en
  riesgo de cancelación, insistir después de rechazo claro. Este es el
  riesgo que el propio Decision Engine puede generar si ignora sus propias
  reglas.
- **Riesgo de datos** — información contradictoria o incompleta sobre el
  pedido, la identidad del cliente, o el estado de la conversación, que
  hace que cualquier decisión basada en esos datos sea potencialmente
  errónea.

**Cómo se clasifican.** Por severidad (bloqueante vs. advertencia) y por
reversibilidad (¿una decisión equivocada aquí se puede corregir en el
siguiente turno, o genera un daño que ya no se deshace?). El riesgo de
seguridad es siempre bloqueante e idealmente irreversible si se ignora —
de ahí su posición en el nivel 1 de la jerarquía de prioridad. El riesgo
comercial suele ser una advertencia reversible — una oferta presentada de
más se corrige fácilmente en el turno siguiente.

**Qué motor los detecta.** El riesgo de seguridad se detecta comparando el
mensaje contra las categorías ya definidas en el Knowledge Engine — el
Decision Engine no inventa nuevas categorías médicas, solo reconoce las
existentes con la máxima prioridad posible. El riesgo de confianza se
detecta cruzando la etapa del comprador (Escéptico, con Sales Engine) con
la intensidad y repetición de las señales de sospecha. El riesgo comercial
se detecta principalmente en la validación final del pipeline (paso 16 de
la sección 4) — comparando la decisión candidata contra los errores
críticos de la sección 16. El riesgo de datos se detecta comparando el
estado actual contra el historial — cuando algo no cuadra (ver Recovery
Engine, sección 13).

**Cuándo bloquear ventas.** Ante cualquier riesgo de seguridad activo, sin
excepción — no hay ninguna condición donde continuar vendiendo sea la
decisión correcta mientras ese riesgo esté presente. También ante riesgo
de confianza severo (más allá del escepticismo manejable) — insistir en
vender a alguien que activamente sospecha fraude profundiza la sospecha en
vez de resolverla.

**Cuándo bloquear respuestas por completo.** Solo en el caso extremo del
campo "No responder" del Decision Plan (sección 3) — reservado para
riesgo de datos tan severo que cualquier respuesta generada correría alto
riesgo de estar basada en una lectura incorrecta de la situación (por
ejemplo, mensajes duplicados ya procesados, o contenido que el sistema no
puede interpretar con ninguna confianza razonable).

**Cuándo escalar.** Ante riesgo de seguridad siempre. Ante riesgo de
confianza severo cuando ya se intentó una vez responder comercialmente y no
se resolvió. Ante riesgo de datos cuando la contradicción no se puede
resolver con una pregunta simple de aclaración.

---

## 10. Conversation Goal Engine

Es indispensable separar dos conceptos que suenan parecidos pero cumplen
funciones distintas:

**Objetivo del turno** — lo que se decide para **este mensaje específico**
(Goal Engine, sección 6). Cambia con frecuencia, turno a turno, según lo
que efectivamente ocurre en el intercambio inmediato.

**Objetivo global de la conversación** — la lista acumulada y priorizada
ya definida por el Sales Engine (sección 8 de ese documento: descubrir
avatar, descubrir dolor, descubrir concepto, descubrir intención, reducir
riesgo, construir confianza, mover un paso, conseguir pedido). Este
objetivo global no cambia turno a turno — evoluciona lentamente a medida
que cada elemento de la lista se considera suficientemente cubierto.

**Cómo interactúan.** El objetivo global actúa como un mapa de fondo; el
objetivo del turno es la posición actual en ese mapa. El Goal Engine
(sección 6) nunca decide el objetivo del turno mirando solo el mensaje
actual — siempre lo hace preguntando primero "¿qué falta todavía del
objetivo global?" y usando eso para inclinar la decisión. Si el objetivo
global todavía no tiene avatar descubierto, el objetivo del turno se
inclina hacia descubrir, incluso si el mensaje puntual admitiría otra
lectura razonable. Si el objetivo global ya cubrió avatar, dolor, concepto
e intención, y lo único pendiente es conseguir pedido, el objetivo del
turno se inclina hacia mover un paso o cerrar con mucha más facilidad que
al principio de la conversación.

La relación es, en esencia, la misma que existe entre una estrategia de
largo plazo y una táctica de corto plazo: la táctica de cada turno sirve a
la estrategia global, y cuando ambas parecen apuntar en direcciones
distintas, es señal de que algo en la lectura del turno actual necesita
revisarse antes de actuar (esto también reduce la confianza del motor,
sección 8, en esa lectura puntual).

---

## 11. Decision Matrix

Una matriz conceptual que cruza los inputs procesados (columnas) contra las
decisiones posibles (filas), mostrando qué combinación de estado tiende a
producir qué tipo de plan — sin ser una tabla de búsqueda literal que el
sistema consulte mecánicamente, sino el mapa de relaciones que el
arbitraje de las secciones 5-9 termina produciendo en la práctica:

| Estado combinado | Acción principal tendencia | Prioridad que domina |
|---|---|---|
| Riesgo de seguridad activo (cualquier etapa/avatar/momentum) | Escalar | Seguridad |
| Pedido activo + mensaje relacionado a ese pedido | Responder (servicio) | Pedido existente |
| Escalamiento ya abierto | Esperar / observar | Escalamiento activo |
| Etapa No consciente/Curioso + momentum bajo | Responder breve, sin oferta | Sales Engine (etapa) |
| Etapa Interesado + confianza alta en avatar/concepto | Educar / contar beneficio | Sales Engine (concepto) |
| Objeción repetida por segunda vez | Esperar, sin insistir más | Sales Engine (objeción) + Momentum bajo |
| Señal de compra fuerte, cualquier etapa previa | Presentar oferta / cerrar | Sales Engine (señal) |
| Confianza baja en avatar + mensaje ambiguo | Preguntar (descubrimiento) | Confianza del motor |
| Momentum alto + etapa Convencido | Cerrar | Momentum |
| Momentum bajo + silencio extendido | Esperar | Momentum |
| Cliente recurrente + mensaje sobre pedido anterior | Responder (servicio, cero venta) | Pedido existente |
| Contradicción de datos sin resolver | No responder / pedir aclaración | Riesgo de datos |
| Riesgo de confianza severo, ya intentado una vez | Escalar | Riesgo de confianza |
| Humano interviniendo activamente | Observar sin decidir acción comercial | Human Override |

Esta matriz no reemplaza el arbitraje jerárquico (sección 5) — es su
resumen visual. Cada fila es, en realidad, el resultado de haber corrido
todo el pipeline (sección 4) para ese estado combinado específico, no una
regla independiente que se pueda aplicar sin el resto del sistema.

---

## 12. Decision Trees

A diferencia de los árboles del Sales Engine (que decidían estrategia
comercial), estos árboles deciden **qué motor tiene el control del
turno** — son árboles de arbitraje, no de venta.

**Árbol — entrada de cualquier turno**
```
Nuevo mensaje entra
  ├─ ¿Hay intervención humana activa?
  │     ├─ Sí → Human Override (sección 14) — fin del árbol
  │     └─ No → continuar
  ├─ ¿Se detecta riesgo de seguridad?
  │     ├─ Sí → Escalar — fin del árbol
  │     └─ No → continuar
  ├─ ¿Hay un pedido activo relacionado con este mensaje?
  │     ├─ Sí → Responder como servicio de pedido — fin del árbol
  │     └─ No → continuar hacia evaluación comercial completa
```

**Árbol — evaluación comercial completa (cuando el árbol de entrada no
resolvió el turno)**
```
Continúa evaluación comercial
  ├─ ¿Confianza del motor sobre avatar/intención es alta?
  │     ├─ Sí → proceder con Goal Engine normal (sección 6)
  │     └─ No → inclinar objetivo hacia "descubrir" antes de cualquier otra cosa
  ├─ ¿Momentum es alto y hay señal de compra?
  │     ├─ Sí → Cerrar o presentar oferta según etapa
  │     └─ No → ¿hay objeción activa?
  │           ├─ Sí → ¿es la primera vez o ya se repitió?
  │           │     ├─ Primera vez → Resolver objeción
  │           │     └─ Repetida → Esperar
  │           └─ No → seguir objetivo global de la conversación (sección 10)
```

**Árbol — riesgo de confianza/fraude percibido**
```
Se detecta señal de sospecha del cliente
  ├─ ¿Es la primera vez en esta conversación?
  │     ├─ Sí → Responder con Crear confianza (Sales Engine)
  │     └─ No, ya se intentó antes sin resolverse
  │           → ¿el cliente insiste con la misma intensidad o mayor?
  │                 ├─ Sí → Escalar (riesgo de confianza severo)
  │                 └─ No, parece haberse suavizado → continuar comercial normal
```

**Árbol — pedido activo con mensaje ambiguo**
```
Cliente con pedido activo escribe algo que podría ser sobre el pedido
o sobre algo nuevo
  ├─ ¿El mensaje menciona explícitamente el pedido (entrega, estado)?
  │     ├─ Sí → Responder como servicio de pedido
  │     └─ No, es ambiguo
  │           → Confianza baja sobre la intención → Preguntar para aclarar
  │             antes de asumir cuál de los dos casos es
```

**Árbol — contradicción detectada (Recovery Engine)**
```
El mensaje actual contradice algo dicho antes en la conversación
  ├─ ¿La contradicción es sobre un dato operativo (dirección, nombre)?
  │     ├─ Sí → Preguntar para confirmar cuál dato es el correcto
  │     └─ No, es sobre una preferencia o intención (cambió de opinión)
  │           → Aceptar el cambio como válido, actualizar estado,
  │             sin señalar la contradicción al cliente
```

**Árbol — cliente vuelve después de una ausencia larga**
```
Cliente escribe después de un vacío prolongado en la conversación
  ├─ ¿Hay un pedido que haya cambiado de estado mientras tanto?
  │     ├─ Sí → Priorizar informar sobre eso antes que retomar venta
  │     └─ No → ¿el objetivo global de la conversación seguía activo?
  │           ├─ Sí, sin resolver → Retomar ese objetivo con confianza
  │           │     reducida (mucho tiempo pudo cambiar su situación)
  │           └─ No relevante ya → Tratar como una conversación nueva de
  │                 descubrimiento, conservando identidad ya conocida
```

Estos árboles son el patrón de arbitraje, no una lista exhaustiva — igual
que en el Sales Engine, cualquier situación no cubierta explícitamente se
resuelve aplicando la misma lógica de niveles (sección 5), no buscando un
árbol nuevo para cada caso posible.

---

## 13. Recovery Engine

Diseñado para los momentos donde el flujo normal del pipeline no alcanza:

**Cuando no entiende el mensaje.** Confianza baja generalizada, sin
ninguna lectura clara de intención. La respuesta correcta no es adivinar
con falsa seguridad — es una pregunta breve de aclaración, tratada como el
objetivo del turno, sin avanzar ningún otro objetivo mientras tanto.

**Cuando faltan datos.** Si el objetivo del turno requiere un dato que no
está disponible (por ejemplo, presentar una oferta específica sin saber
qué concepto le interesa al cliente), el Recovery Engine redirige el
objetivo hacia obtener ese dato específico antes de continuar, en vez de
proceder con una versión genérica que probablemente no aplique.

**Cuando el cliente cambia de tema.** No se trata como una interrupción a
corregir — se trata como una señal legítima de que el objetivo global debe
reevaluarse. El Recovery Engine no fuerza el regreso al tema anterior; dejar
que el cliente dirija el tema es parte de servir su necesidad real, y el
pipeline simplemente reinicia el análisis de avatar/concepto/intención
sobre el tema nuevo (conservando lo ya aprendido de identidad y contexto
general).

**Cuando el cliente vuelve días después.** Ver el árbol de la sección 12.
La clave conceptual es que el tiempo transcurrido reduce la confianza en
todo lo que se había concluido antes (una necesidad de hace dos semanas
puede ya no ser la misma), sin descartar por completo ese conocimiento
previo — se retoma con cautela, no desde cero y no como si no hubiera
pasado el tiempo.

**Cuando el cliente contradice mensajes anteriores.** Ver también el árbol
de la sección 12. La distinción central: una contradicción sobre un dato
operativo objetivo (una dirección distinta a la que dio antes) es un error
a resolver con una pregunta. Una contradicción sobre una preferencia o
decisión (dijo que no quería comprar, ahora dice que sí) no es un error —
es un cambio legítimo de estado que el sistema debe aceptar y actualizar,
nunca señalar como una inconsistencia al cliente.

En todos los casos de recuperación, el principio subyacente es el mismo: la
incertidumbre se resuelve con una acción de bajo riesgo (preguntar,
esperar, responder de forma neutral) nunca con una acción de alto
compromiso (cerrar, presentar oferta, escalar sin necesidad) tomada sobre
una base de información que el propio sistema sabe que es débil.

---

## 14. Human Override

**Cómo debe comportarse el Decision Engine cuando un humano interviene.**
En el instante en que un agente humano toma la conversación, el Decision
Engine dejar de emitir Decision Plans que produzcan cualquier acción
comercial. Sigue **observando** — actualizando contexto, avatar, etapa,
momentum, confianza, exactamente igual que si estuviera decidiendo — pero
el resultado de ese procesamiento no se traduce en ninguna acción hacia el
cliente. Es la diferencia entre apagar el motor y ponerlo en modo lectura:
el estado se mantiene sincronizado y actualizado, listo para retomar
control con contexto completo cuando la intervención humana termine, en
vez de tener que reconstruir todo el estado desde cero.

**Qué puede seguir decidiendo.** Únicamente detección de riesgo (sección
9) — si durante la intervención humana aparece una señal de seguridad
real, el Decision Engine sigue teniendo la responsabilidad de marcarla,
incluso si no actúa directamente sobre ella (la acción, en ese caso, es
notificar la señal, no generar una respuesta comercial).

**Qué deja de decidir.** Todo lo demás: objetivo del turno con fines
comerciales, estrategia, momentum como motor de acción, cierre, cualquier
Decision Plan que contenga una acción dirigida al cliente. El humano tiene
el control total de la conversación mientras dura la intervención; el
Decision Engine no compite ni sugiere por encima de esa decisión humana.

**Al finalizar la intervención humana.** El Decision Engine retoma el
control con el estado que había mantenido actualizado durante la
intervención, más lo que haya ocurrido durante ese periodo (que el propio
sistema humano haya registrado como resultado, si esa integración existe) —
nunca reiniciando la conversación desde el primer mensaje.

---

## 15. Decision History

Diseño conceptual únicamente — qué debería recordarse, no cómo se
almacena.

**Qué se registra por turno.** El objetivo decidido, la acción principal
emitida, el nivel de prioridad que la determinó (sección 3, campo
Prioridad), los niveles de confianza asociados a las lecturas clave de ese
turno, y el estado de momentum antes y después del turno.

**Para qué sirve recordarlo.** Tres propósitos futuros, ninguno
implementado en V1: (1) **continuidad** — que el siguiente turno de la
misma conversación no tenga que re-derivar el estado desde el mensaje
crudo, sino partir de lo ya decidido; (2) **auditoría** — poder explicar,
después de los hechos, por qué el sistema decidió lo que decidió en un
punto específico de una conversación real, igual que se audita cualquier
otra decisión de negocio; (3) **aprendizaje futuro** — una base eventual
para que fases posteriores (fuera de alcance de este documento) puedan
evaluar si ciertos patrones de decisión correlacionan con mejores o peores
resultados reales, sin que esa evaluación exista todavía.

**Qué NO es este historial.** No es una transcripción de la conversación
(eso ya existe en la capa de mensajes) — es una traza de las **decisiones**
tomadas sobre esa conversación, un nivel de abstracción distinto y más
compacto. Tampoco es, en V1, un mecanismo de aprendizaje automático — es
simplemente memoria estructurada de qué se decidió y por qué, disponible
para que un humano o una fase futura la revise.

---

## 16. Errores críticos

Decisiones que el Decision Engine jamás debe tomar, bajo ninguna
combinación de inputs:

1. Emitir un Decision Plan con más de un objetivo de turno activo al
   mismo tiempo.
2. Permitir que Momentum o Sales Engine anulen una señal de Seguridad —
   la jerarquía de la sección 5 no admite excepciones por "la conversación
   iba muy bien".
3. Decidir "Cerrar" sin que exista al menos una señal de compra real
   verificada, sin importar cuánto tiempo lleve la conversación.
4. Presentar oferta inmediatamente después de una señal de riesgo de
   seguridad, incluso si el cliente retoma un tono comercial normal en el
   mismo mensaje.
5. Ignorar un pedido activo relacionado para perseguir un objetivo
   comercial nuevo con el mismo cliente.
6. Actuar con alta confianza (cerrar, presentar oferta, escalar) cuando la
   confianza real del motor sobre la lectura del turno es baja — la baja
   confianza siempre debe traducirse en una acción conservadora, nunca
   ocultarse detrás de una decisión que aparenta seguridad.
7. Generar cualquier Decision Plan con acción comercial mientras un
   humano tiene la conversación activa (sección 14).
8. Cambiar el objetivo del turno sin que ninguna de las tres condiciones
   válidas de la sección 6 se haya cumplido — cambiar "porque sí" en cada
   turno.
9. Tratar una contradicción de preferencia legítima del cliente (cambió
   de opinión) como un error a corregir o señalar.
10. Escalar como salida fácil ante una objeción simplemente difícil de
    resolver, sin que exista una razón real de riesgo o política detrás.
11. Usar "No responder" fuera de los casos de altísima confianza descritos
    en la sección 3 — el costo de ignorar a un cliente real por error es
    demasiado alto para usarlo como opción por defecto ante la duda.
12. Reconstruir el estado de una conversación desde cero cuando existe
    historial disponible (Decision History, Conversation Memory) que
    debería informar la decisión actual.
13. Dejar que el objetivo global de la conversación (sección 10) se
    ignore por completo en favor de una lectura miope del mensaje
    puntual, turno tras turno, sin que la conversación avance nunca hacia
    ningún objetivo acumulado.
14. Permitir que el Sales Engine, el Commercial Engine o cualquier otro
    input dicten una acción directamente sin pasar por el arbitraje de la
    sección 5 — ningún input tiene autoridad de decisión final por sí
    mismo, solo el Decision Engine la tiene.

---

## 17. Roadmap

Este documento es arquitectura de decisión — no ejecución. Ninguna fase de
las siguientes está aprobada ni iniciada:

- **Fase 5A — Diseño del Response Generator.** La capa inmediatamente
  inferior en la pila (ver diagrama al inicio) definiría cómo un Decision
  Plan conceptual se traduce en instrucciones reales de generación de
  lenguaje — sin todavía escribir esas instrucciones ni tocar
  `buildSystemPrompt()`.
- **Fase 5B — Validación offline del arbitraje.** Antes de cualquier
  cambio de infraestructura, correr escenarios simulados de conflicto
  deliberado entre motores (una señal de compra fuerte simultánea con una
  objeción repetida, por ejemplo) contra este modelo de arbitraje, para
  confirmar que la jerarquía de la sección 5 produce el resultado
  esperado en la práctica, no solo en el papel.
- **Fase 5C — Diseño de Conversation Memory real.** Este documento asume
  que la memoria entre sesiones (input de la sección 2) puede llegar
  vacía o parcial; una fase futura definiría cómo se construye esa
  memoria realmente, sin diseñar todavía su almacenamiento técnico.
- **Fase 5D — Diseño del historial de decisiones persistente.** Convertir
  el diseño conceptual de la sección 15 en un mecanismo real de registro,
  todavía sin esquema de datos ni implementación — solo la definición de
  qué garantías necesitaría ese mecanismo (nunca perder una decisión de
  seguridad, por ejemplo).
- **Fase 5E — Integración quirúrgica.** Solo después de 5A-5D validadas y
  aprobadas por separado, decidir qué parte mínima de este modelo se
  traduce primero en algo ejecutable, siguiendo el mismo estándar ya
  aplicado en cada fase anterior de Génesis: cambios aislados y medibles,
  nunca una reescritura de la infraestructura de runs ya validada y en
  producción.

Ninguna fase de este roadmap está aprobada. Cada una requiere su propio
visto bueno explícito antes de tocar código, exactamente igual que todas
las fases anteriores de Génesis.
