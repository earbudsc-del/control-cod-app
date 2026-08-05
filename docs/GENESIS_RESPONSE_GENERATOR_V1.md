# Génesis — Response Generator V1

Documento de arquitectura pura. Cero código, cero prompts productivos, cero
SQL, cero TypeScript, cero migraciones. Última capa de diseño antes de
implementar. Posición en la pila:

```
Customer Intelligence → Knowledge Engine → Commercial Engine
        → Sales Engine → Decision Engine
        → RESPONSE GENERATOR   ← (este documento)
        → Respuesta final
```

Pregunta única que responde este documento: **¿cómo convierte Génesis un
Decision Plan ya aprobado en un mensaje de WhatsApp humano, claro,
comercial y seguro?** No decide qué hacer — eso ya vino decidido. Decide
cómo se dice.

---

## 1. Responsabilidad del Response Generator

**Qué recibe.** Un Decision Plan completo (sección 2) más los datos brutos
mínimos necesarios para redactar: el mensaje del cliente, el último mensaje
de Génesis en esta conversación, y el fragmento de conocimiento aprobado
que el plan autoriza usar.

**Qué produce.** Un único mensaje de texto final, listo para enviar por
WhatsApp — nunca varias opciones, nunca un borrador a elegir (sección 3).

**Qué decisiones ya vienen resueltas.** Todo lo estratégico: avatar,
intención, etapa del comprador, concepto dominante, objetivo del turno,
estrategia comercial, nivel de riesgo, si corresponde escalar, si
corresponde presentar oferta, si corresponde CTA. El Response Generator no
vuelve a evaluar ninguna de estas — las trata como hechos ya decididos por
capas que ya hicieron ese trabajo (Sales Engine, Decision Engine).

**Qué NO puede volver a decidir.** La lista exacta: avatar, intención,
etapa, concepto, objetivo del turno, estrategia, riesgo, escalamiento, si
presenta oferta, si hace CTA. Si el Response Generator se encuentra a sí
mismo "reconsiderando" alguno de estos puntos, está invadiendo territorio
que no le corresponde — es una violación de arquitectura, no una mejora.

**Qué información puede usar.** Únicamente el conocimiento explícitamente
autorizado por el campo `required_knowledge`/`facts_to_include` del plan, el
contenido literal del mensaje del cliente, y el historial de la
conversación entregado como contexto.

**Qué información no puede inventar.** Ningún hecho sobre el producto que
no esté en el Knowledge Engine, ningún precio ni oferta que no esté en el
plan, ninguna promesa de agente humano que el plan no haya confirmado,
ningún beneficio, estudio, cifra o garantía fuera de lo aprobado. El
Response Generator redacta con libertad de forma y cero libertad de
contenido factual.

---

## 2. Input — Decision Plan

El plan llega con estos campos. Ninguno es texto a copiar literalmente —
cada uno es una restricción o una guía que informa cómo se redacta.

| Campo | Cómo afecta la redacción |
|---|---|
| `conversation_goal` | Objetivo acumulado de toda la conversación (Sales Engine §8) — trasfondo, nunca se menciona explícitamente |
| `turn_goal` | Objetivo de este mensaje puntual — determina el propósito central del texto |
| `primary_action` | Acción central (responder, preguntar, educar, resolver objeción, ofertar, cerrar, esperar, escalar) — define qué bloque de la sección 4 domina |
| `secondary_action` | Matiz subordinado, si existe — nunca compite en peso con la acción principal |
| `buyer_stage` | Etapa del comprador (Sales Engine §3) — ajusta cuánto se educa, cuánto se cierra, cuánta confianza se asume ya ganada |
| `avatar` | Tipo de persona (Sales Engine §4) — ajusta qué se enfatiza y qué preocupación se anticipa sin mencionarse |
| `dominant_concept` | Cuál de los 6 conceptos aplica ahora (Sales Engine §5) — nunca se mezclan varios por iniciativa propia |
| `objection` | Objeción activa, si existe — dispara el marco validar-reencuadrar-evidenciar-avanzar (sección 12) |
| `desired_emotion` | Emoción que el turno busca construir (Sales Engine §9) — informa el registro emocional sin nombrarla explícitamente |
| `momentum` | Energía conversacional acumulada — alto permite texto directo hacia el avance; bajo pide paciencia |
| `confidence` | Certeza del Decision Engine sobre sus propias lecturas — baja implica redactar dando espacio a corregirse, nunca sonar a certeza absoluta sobre algo incierto |
| `risk_level` | Nivel de riesgo detectado — cualquier valor distinto de "ninguno" restringe automáticamente CTA comercial y oferta |
| `response_length` | Nivel objetivo (breve/normal/profunda, sección 5) — gobierna cuántos bloques puede usar el mensaje |
| `question_allowed` | Si este turno admite pregunta — en falso, ninguna redacción cierra con signo de interrogación |
| `question_goal` | Propósito de la pregunta si se permite (descubrimiento, confirmación, avance) — nunca el texto exacto |
| `offer_allowed` | Si corresponde presentar la oferta comercial |
| `offer_to_present` | Cuál oferta específica — nunca se elige una distinta a la indicada |
| `cta_type` | Tipo de CTA a usar, de la lista de la sección 9 |
| `escalation_required` | Si el turno debe entregarse a un humano — casi todo lo demás queda subordinado a comunicar ese handoff (sección 15) |
| `prohibited_actions` | Vetos explícitos de este turno puntual, más allá de las reglas generales — el veto más específico siempre gana |
| `required_knowledge` | Qué fragmento del Knowledge Engine debe reflejarse en la respuesta |
| `facts_to_include` | Hechos puntuales que el mensaje debe contener, en algún punto del texto |
| `facts_to_avoid` | Hechos verdaderos que no corresponden a este turno (ej. no repetir el precio ya dado) |
| `conversation_context` | Resumen de por dónde va la conversación — redactar con continuidad, nunca como si cada turno empezara de cero |
| `last_assistant_message` | El mensaje anterior de Génesis — insumo directo de la regla de no-repetición (sección 14) |
| `customer_message` | El mensaje actual del cliente — la base de lo que se está respondiendo |

---

## 3. Output

| Elemento del output | Qué es |
|---|---|
| Texto final | Un único mensaje, listo para enviarse tal cual, sin placeholders ni variantes |
| Tipo de mensaje | Etiqueta simple (respuesta, pregunta, oferta, cierre, escalamiento, servicio) — trazabilidad, no texto visible |
| Longitud | Nivel efectivamente usado (breve/normal/profunda), registrado para verificar que coincidió con lo pedido |
| CTA utilizado | Cuál tipo de la sección 9 se aplicó, o ninguno |
| Pregunta incluida o no | Indicador simple, más el propósito si aplica |
| Knowledge usado | Qué fragmentos de `required_knowledge`/`facts_to_include` aparecieron en el texto — verifica que no se omitió nada exigido |
| Claims verificados | Marca de que cada afirmación factual fue cruzada contra el Knowledge Engine antes de emitirse |
| Señales de escalamiento | Si el texto comunica un handoff, y si corresponde a un `escalation_required` real (nunca se promete un agente no confirmado) |
| Validación final | Resultado del checklist de la sección 16 — debe pasar antes de considerarse apto para enviar |

**Regla de unicidad de salida.** El Response Generator entrega exactamente
un mensaje candidato final por turno. No es su trabajo generar cinco
variantes para que otro sistema elija la mejor — esa ambigüedad ya se
resolvió en capas anteriores (el Decision Plan es, precisamente, la
eliminación de esa ambigüedad). Generar múltiples opciones sería reabrir
una decisión que ya está cerrada.

---

## 4. Estructura de una respuesta

Bloques modulares — nunca una plantilla fija que se rellena igual cada
vez. Un mensaje real usa solo los bloques que su Decision Plan amerita, en
el orden que la situación pide:

- **Respuesta directa** — la contestación concreta a lo que se preguntó.
  Casi siempre presente, salvo en mensajes puramente de servicio o
  cierre operativo.
- **Beneficio relevante** — el valor conectado al concepto dominante y al
  avatar. Se omite si el turno no busca construir valor (por ejemplo, en
  cierre puro).
- **Explicación/evidencia** — el mecanismo o hecho que sostiene el
  beneficio. Solo cuando el plan lo requiere (avatar racional, objeción
  que pide sustento, escepticismo).
- **Aclaración honesta** — el límite o matiz que evita un claim excesivo
  (nunca al principio del mensaje, ver sección 15).
- **Reencuadre** — cuando hay objeción activa, el ángulo distinto que la
  resuelve (sección 12).
- **Pregunta** — máximo una, y solo si `question_allowed` (sección 8).
- **CTA** — el cierre operativo o comercial, según `cta_type` (sección 9).
- **Transición humana** — únicamente cuando `escalation_required` es
  verdadero: la frase que comunica que un agente sigue el caso.
- **Confirmación operativa** — cuando el cliente ya dio un dato o tomó una
  decisión, el acuse de recibo antes de pedir el siguiente paso.

**Orden habitual.** Respuesta directa → beneficio relevante (si aplica) →
explicación/evidencia (si aplica) → aclaración honesta (si aplica) →
pregunta o CTA (nunca ambos con el mismo peso). El reencuadre reemplaza a
"respuesta directa" cuando el turno es específicamente de resolución de
objeción. La confirmación operativa y la transición humana son bloques de
cierre que aparecen solos, sin combinarse con construcción de valor.

**Bloques incompatibles.** Pregunta y CTA de cierre no coexisten en el
mismo mensaje con el mismo peso — uno de los dos domina, el otro se omite
por completo. Transición humana nunca coexiste con beneficio, oferta, o
CTA comercial — cuando hay escalamiento, esos bloques desaparecen del
mensaje. Reencuadre y aclaración honesta no se apilan ambos si generan
redundancia — se elige el que resuelve mejor la objeción específica.

**Máximo de bloques por respuesta.** Tres bloques de contenido más un
bloque de cierre (pregunta, CTA, o confirmación) — nunca más. Un mensaje
de WhatsApp con cinco bloques distintos ya no se lee como conversación, se
lee como un correo.

**Qué bloques se omiten cuando el cliente está listo para comprar.**
Beneficio relevante, explicación/evidencia, y reencuadre desaparecen por
completo (sección 13) — quedan solo confirmación operativa y, si falta un
dato, una pregunta operativa puntual.

---

## 5. Longitud adaptativa

### Breve

Cuándo: pregunta objetiva de una sola pieza de información, cliente
impaciente (mensajes cortos, repetidos), señal de compra fuerte, respuesta
ya dada antes en la conversación, pregunta de logística (entrega, pago).

Límite aproximado: 1–2 oraciones, menos de 200 caracteres, un solo
párrafo sin salto de línea.

### Normal

Cuándo: duda de producto sin complejidad especial, explicación de un
beneficio conectado al concepto dominante, objeción sencilla ya resuelta
con un solo reencuadre.

Límite aproximado: 2–4 oraciones, entre 200 y 400 caracteres, un solo
párrafo, o dos como máximo si hay una aclaración honesta separada del
resto.

### Profunda

Cuándo: objeción compleja o repetida con matices, comparación con otra
marca, desconfianza explícita, necesidad muy específica del cliente que
amerita una respuesta a medida, explicación médica prudente antes de
escalar.

Límite aproximado: 4–6 oraciones, hasta 600 caracteres, máximo dos
párrafos cortos. Incluso en el nivel más largo permitido, el mensaje sigue
siendo apto para leerse cómodo en una pantalla de celular sin scroll
excesivo — nunca un párrafo denso de WhatsApp que nadie termina de leer.

**Regla general.** El nivel por defecto, ante cualquier ambigüedad sobre
cuál aplica, es Breve o Normal — nunca Profunda. La longitud profunda se
gana por una razón concreta del Decision Plan, no se usa por precaución
("mejor explico de más por si acaso" está prohibido como criterio).

---

## 6. Tono y voz

La voz de Génesis es: cercana, segura, natural, dominicana sin exagerar,
comercial sin presión, informada sin sonar clínica, empática sin
dramatizar. Esta voz es constante — lo que cambia turno a turno es el
**registro**, no la personalidad de fondo.

**Adaptación al tono del cliente:**

| Tono del cliente | Ajuste de Génesis |
|---|---|
| Formal | Mantiene cercanía pero reduce jerga informal — sigue siendo ella misma, no se vuelve ceremoniosa |
| Informal | Responde con la misma calidez informal, sin forzar jerga que el cliente no usó primero |
| Directo | Va al punto, sin preámbulos innecesarios |
| Preocupado | Prioriza calma y claridad por encima de construir valor comercial |
| Molesto | Empatía primero, sin justificarse ni ponerse a la defensiva |
| Escéptico | Sustancia y hechos, cero entusiasmo de venta |
| Listo para comprar | Eficiencia — el tono se vuelve casi puramente operativo |

**Expresiones aprobadas (patrón, no lista cerrada):** afirmaciones directas
sobre lo que el producto sí hace, reconocimiento breve de una duda antes
de resolverla, cierres que ofrecen el siguiente paso concreto.

**Patrones a evitar:** autorreferencia como sistema o IA en cualquier
forma, formalidad excesiva ("estimado cliente"), lenguaje de call center
corporativo, urgencia fabricada, disculpas excesivas sobre hechos que sí
están aprobados y no requieren duda.

No se define aquí un catálogo extenso de frases fijas — ese nivel de
detalle ya vive en el Commercial Engine (secciones 26-28). Este documento
solo confirma que el Response Generator hereda esas reglas de voz sin
reinterpretarlas.

---

## 7. Naturalidad y variación

**Qué debe variar entre mensajes:**

- La apertura (no siempre "¡Hola! 😊", no siempre empezar repitiendo la
  pregunta del cliente).
- El CTA final (no la misma pregunta de cierre en cada mensaje).
- Los emojis usados, y su presencia — no todos los mensajes necesitan uno.
- La estructura sintáctica (no siempre beneficio-luego-CTA en el mismo
  patrón mecánico).

**Qué nunca puede variar:**

- El precio, la oferta, el porcentaje del ingrediente, o cualquier dato
  del Knowledge Engine — la variación es de forma, nunca de contenido
  factual.
- Las políticas (cobertura, pago, entrega) tal como están aprobadas.
- La sustancia de un claim ya aprobado — se puede redactar distinto, no
  se puede decir algo distinto.

**Distinción central: variación estilística permitida vs. variación
factual prohibida.** La primera cambia cómo suena una misma verdad de un
mensaje a otro. La segunda cambiaría cuál es la verdad — y eso nunca es
aceptable sin importar cuánto ayude a que el mensaje suene más fresco o
natural. Un vendedor humano varía su forma de decir las cosas todos los
días; nunca varía el precio según su estado de ánimo.

**Repeticiones específicas a evitar:** repetir literalmente la pregunta
del cliente como apertura, repetir la oferta ya mencionada en el turno
inmediatamente anterior sin una razón nueva, repetir un beneficio ya
explicado en la misma conversación salvo que el cliente lo vuelva a
preguntar.

---

## 8. Una sola pregunta

**Regla V1:** como máximo una pregunta por mensaje, sin excepción.

**Cuándo incluirla:** cuando `question_allowed` es verdadero y el
`turn_goal` requiere obtener información (descubrimiento), confirmar algo
(avance de pedido), o desbloquear ambigüedad (aclaración).

**Cuándo omitirla:** cuando `question_allowed` es falso, cuando el cliente
ya está listo para comprar y lo único que falta es un dato operativo que
se puede pedir sin forma de pregunta abierta ("perfecto, dame tu dirección
completa" funciona igual de bien que una pregunta y dentro de un cierre se
siente más directo), o cuando el mensaje es puramente de servicio/cierre.

**Cómo seleccionar la pregunta:** de `question_goal` — nunca se inventa un
propósito de pregunta que el plan no autorizó. Si el plan indica
"descubrimiento", la pregunta explora avatar/dolor/concepto. Si indica
"avance", la pregunta pide el dato operativo faltante.

**Cómo evitar interrogatorios:** nunca dos preguntas en el mismo mensaje,
nunca una pregunta en el mensaje inmediatamente siguiente si la anterior
sigue sin respuesta (en ese caso, se retoma sin volver a preguntar hasta
que el cliente responda o cambie de tema).

**Cómo formularla después de aportar valor:** la pregunta nunca abre el
mensaje de forma aislada — llega después de al menos un bloque de
contenido (respuesta directa o beneficio), nunca como la primera línea sin
contexto.

**Si el Decision Plan prohíbe preguntas:** el mensaje se cierra con
afirmación, confirmación, o CTA no interrogativo — nunca se fuerza una
pregunta "por costumbre" cuando el plan explícitamente la excluyó.

---

## 9. CTAs

| Tipo | Cuándo usarlo | Intensidad | Cuándo está prohibido |
|---|---|---|---|
| Ninguno | Turno de pura curiosidad inicial, o inmediatamente tras señal médica sensible | — | — |
| Exploratorio | Cliente Curioso/Interesado, invita a seguir la conversación sin comprometer nada | Muy baja | Cuando ya hay señal de compra (sería un retroceso) |
| Profundización | Cliente Interesado, invita a dar más detalle de su necesidad | Baja | Cuando el cliente ya está listo para comprar |
| Confianza | Etapa Escéptico o avatar Comprador desconfiado | Baja, no comercial | Cuando no hay ninguna señal de desconfianza real |
| Oferta | `offer_allowed` verdadero, cliente en etapa Interesado/Convencido | Media | Tras señal médica sensible, o si la oferta ya se mencionó en el turno anterior |
| Reserva | Cliente Convencido, para dar el empujón final | Media-alta | Sin haber construido valor o resuelto objeciones primero |
| Datos | Cliente Listo para comprar, falta información operativa | Alta (pero sin sonar a formulario) | Si el dato ya fue entregado antes |
| Confirmación | Cliente ya dio un dato o ya decidió, se cierra el ciclo | Alta, pero operativa, no persuasiva | Si todavía falta resolver una duda real |
| Servicio | Cliente con pedido activo, servicio puro | N/A — no es comercial | Cuando el turno sí es de venta |
| Escalamiento | `escalation_required` verdadero | N/A — es informativo, no persuasivo | Si el escalamiento no fue confirmado por el Decision Plan |

**Regla de correspondencia.** El CTA elegido siempre corresponde
exactamente al `cta_type` del plan y a la etapa del comprador — nunca se
sube de intensidad "para ver si convierte más" ni se baja "para sonar más
suave" por criterio propio del Response Generator. La intensidad ya viene
calibrada por las capas anteriores.

---

## 10. Ofertas

Cuando `offer_allowed` es verdadero y el plan indica `offer_to_present`:

- Se muestra exactamente esa oferta — nunca una distinta, nunca todas las
  disponibles a la vez salvo que el cliente haya preguntado
  explícitamente por alternativas.
- Se incluye solo la información relevante al momento (precio, qué
  incluye, envío, forma de pago) — no una ficha completa de todas las
  variantes de oferta existentes.
- Nunca se inventa un descuento, un precio especial, ni una condición no
  autorizada.
- Nunca se usa escasez falsa ("solo por hoy", "quedan pocas") — si no hay
  una razón real de urgencia en el plan, no se fabrica una.
- Nunca se repite la misma oferta ya dada en el mensaje inmediatamente
  anterior sin que haya una razón nueva (el cliente volvió a preguntar,
  por ejemplo).
- Nunca se presenta inmediatamente después de una señal médica sensible,
  sin importar que el `offer_allowed` técnicamente lo permitiera para otro
  motivo — el veto de seguridad (sección 15) siempre gana.

**Cómo expresar cada elemento:** el precio se da como un hecho simple, sin
rodeos. El contenido (cantidad, regalo incluido) se menciona junto al
precio, no por separado. El envío y el pago contra entrega se presentan
como parte natural de la misma oferta, no como una lista aparte de
condiciones. El siguiente paso se ofrece de forma breve, coherente con el
`cta_type` indicado (normalmente Oferta o Reserva).

---

## 11. Respuestas por concepto dominante

Regla base: una respuesta tiene **un** concepto dominante (`dominant_concept`
del plan). Los beneficios de otros conceptos solo aparecen si son
estrictamente necesarios para responder algo que el cliente preguntó
explícitamente — nunca se enumeran todos los beneficios del producto en un
mismo mensaje.

- **Reparación del esmalte** — la redacción enfatiza fortalecimiento y
  restauración; útil para avatares que ya perciben desgaste o daño.
- **Sensibilidad** — la redacción enfatiza alivio de una molestia activa;
  tono más cercano al avatar Persona con dolor, con foco en el resultado
  de bienestar diario, no en el mecanismo técnico salvo que se pida.
- **Caries** — la redacción sigue estrictamente la distinción ya aprobada
  en el Knowledge Engine: prevención/fortalecimiento sí, tratamiento de
  caries ya formada no — nunca se difumina esa línea por sonar más
  atractivo.
- **Dientes fuertes** — redacción orientada a durabilidad y cuidado
  general, útil para el avatar Comprador racional que valora el mecanismo
  detrás del resultado.
- **Salud bucal** — el concepto más amplio, se usa como default cuando
  ningún concepto específico domina todavía (cliente Curioso sin
  necesidad clara) — nunca se usa como relleno cuando sí hay un concepto
  específico identificado.
- **Blanqueamiento suave** — redacción que respeta la precisión ya
  aprobada (gradual, sin peróxidos), relevante para el avatar Persona
  estética, sin nunca compararse con procedimientos de consultorio.

**Cómo cambiar entre conceptos dentro de una misma conversación.** El
Response Generator no decide el cambio — lo recibe ya decidido en
`dominant_concept` turno a turno. Su única responsabilidad es no arrastrar
beneficios del concepto anterior a menos que sigan siendo relevantes para
lo que se está diciendo ahora.

---

## 12. Objeciones

El marco de cuatro pasos del Sales Engine (sección 13 de ese documento) se
traduce a texto así:

1. **Validar** — una frase corta que reconoce la objeción como legítima,
   nunca como un ataque a rebatir.
2. **Reencuadrar** — el ángulo distinto, construido sobre un hecho
   aprobado, nunca sobre una minimización de la preocupación original.
3. **Evidenciar** — el dato concreto (ingrediente, pago contra entrega,
   contenido completo de la oferta) que sostiene el reencuadre.
4. **Avanzar** — un CTA o pregunta que mueve la conversación, coherente
   con la etapa actual — nunca un cierre forzado si la objeción no dio
   señales de resolverse.

Aplicación conceptual por tipo (sin catálogo de textos fijos — el patrón
de arriba se aplica a cada una, con el hecho de evidencia correspondiente):

| Objeción | Hecho de evidencia típico |
|---|---|
| Precio | Contenido completo de la oferta (cantidad, regalo, envío, pago contra entrega) |
| Confianza | Pago contra entrega como reductor de riesgo financiero |
| Efectividad | Mecanismo del ingrediente activo, conectado al concepto dominante |
| Seguridad | Composición aprobada (sin flúor, sin peróxidos según aplique) |
| Ingredientes | Nombre y porcentaje del ingrediente activo |
| Competencia | Diferenciación honesta, nunca ataque a la otra marca |
| Tiempo de entrega | Rango de días ya aprobado, sin prometer fecha exacta |
| "Lo pensaré" | Detectar si hay una duda real detrás antes de insistir; si no la hay, se respeta sin presionar |
| Fraude | Pago contra entrega como prueba tangible de ausencia de riesgo |

Si la misma objeción reaparece por segunda vez sin resolverse, el
Response Generator no repite el mismo reencuadre — el Decision Plan, en
ese punto, normalmente ya habrá cambiado `primary_action` a "esperar", y el
texto se ajusta a eso, no a seguir argumentando.

---

## 13. Cliente listo para comprar

Cuando el plan señala señal de compra activa, el mensaje cambia de
naturaleza por completo:

- Se deja de educar — ningún bloque de beneficio o explicación adicional.
- Se deja de agregar beneficios nuevos, incluso si serían ciertos y
  relevantes — ya no hace falta convencer a alguien que ya decidió.
- No se reabren objeciones ya resueltas, ni se vuelve a mencionar una
  duda que el cliente ya superó por su cuenta.
- No se presentan opciones adicionales que el cliente no pidió (otra
  oferta, otra variante) — eso reintroduce fricción de decisión donde ya
  no había ninguna.
- Se avanza directamente al dato operativo que falta.
- Se confirma brevemente lo ya recibido, sin sobre-agradecer ni alargar
  el mensaje.
- La fricción se reduce al mínimo absoluto — cada palabra de más en este
  momento es una palabra que retrasa un pedido ya decidido.

**Orden de solicitud de datos, sin formulario.** Un dato por mensaje, en
el orden que la conversación natural lo permita — normalmente nombre,
después dirección completa con ciudad/sector, después confirmación de la
oferta elegida si no se especificó antes. Nunca los tres en una sola lista
enumerada. Si el cliente ya adelantó varios datos de una vez sin que se
pidieran, el Response Generator no vuelve a pedirlos uno por uno — los
confirma y pide únicamente lo que efectivamente falta.

---

## 14. Contexto y no repetición

**Qué debe usarse activamente:** los últimos mensajes de la conversación
(`conversation_context`), lo ya entregado como información, la oferta ya
mencionada, los datos ya recibidos, las objeciones ya resueltas, y el
concepto que dominó turnos anteriores — todo esto para que el mensaje
actual se sienta como continuación, no como un reinicio.

**Regla de no repetición.** No se repite información ya dada, salvo tres
excepciones explícitas: el cliente la pide otra vez, existe confusión
genuina que requiere reconfirmar, o es estrictamente necesaria para
confirmar una acción (por ejemplo, repetir el monto al momento de cerrar,
como parte de la confirmación operativa, no como venta).

**Cómo se aplica en la práctica.** Antes de incluir cualquier dato,
beneficio, u oferta en el texto, el Response Generator verifica contra
`last_assistant_message` y `conversation_context` si eso ya se dijo. Si ya
se dijo y ninguna de las tres excepciones aplica, ese contenido se omite,
aunque sería correcto incluirlo desde el punto de vista puramente factual.

---

## 15. Seguridad y límites

Veto absoluto — estos elementos nunca se negocian por redacción, tono, o
naturalidad:

- El Knowledge aprobado es el techo de lo que se puede afirmar, sin
  excepción.
- Los límites médicos y los claims prohibidos (Knowledge Engine) se
  respetan literalmente, incluso si una frase "casi igual" sonaría mejor
  comercialmente.
- El Decision Plan de escalamiento se ejecuta tal como llega — el Response
  Generator no decide si escalar, solo comunica que se escaló.
- Los campos de oferta y precio son los del plan, nunca una variación
  propia.
- Cobertura, políticas de pago, y estado de pedidos se comunican
  exactamente como están definidos, sin flexibilizarlos por sonar más
  servicial.

**Ante reacción adversa, amenaza legal, fraude sensible, o cualquier señal
crítica:** no hay venta en el mensaje — ningún beneficio, ninguna oferta,
ningún CTA comercial. El mensaje muestra empatía genuina, y comunica el
handoff **solo si `escalation_required` ya viene confirmado como
verdadero** en el plan. Nunca se promete "ya te voy a conectar con un
agente" si esa escalación no ocurrió realmente — prometer un handoff que
no existe es peor que no prometerlo, porque genera una expectativa que
nadie cumple.

---

## 16. Validación antes de enviar

Checklist final, aplicado al texto ya redactado, antes de considerarlo
apto para salir:

1. ¿Respondió la pregunta del cliente?
2. ¿Cumplió el `turn_goal` del plan?
3. ¿Usó el concepto dominante correcto, y solo ese?
4. ¿Incluyó los `facts_to_include` requeridos?
5. ¿Evitó todos los claims prohibidos?
6. ¿La longitud corresponde al nivel indicado (sección 5)?
7. ¿Suena natural, no a script ni a IA?
8. ¿Repitió información que ya se había dado (sección 14)?
9. ¿Hizo más de una pregunta?
10. ¿El CTA usado es el autorizado por `cta_type`?
11. ¿La oferta mostrada, si hay, es exactamente `offer_to_present`?
12. ¿Debía escalar y no lo hizo, o al revés, prometió escalar sin
    confirmación?
13. ¿Contradice algo del historial de la conversación?
14. ¿Introdujo una objeción nueva que el cliente no había planteado?
15. ¿Facilita con claridad el siguiente paso, sea cual sea?

**Qué falla obliga a qué corrección:**

| Falla detectada | Acción correctiva |
|---|---|
| Longitud excedida (5, 6) | Acortar, eliminando el bloque menos esencial |
| Repitió información (8) | Eliminar ese bloque específico |
| Más de una pregunta (9) | Eliminar todas menos la de mayor prioridad según `question_goal` |
| CTA u oferta no autorizados (10, 11) | Quitar ese bloque, reemplazar por el autorizado o por ninguno |
| Claim prohibido o contradicción (5, 13) | Regenerar el mensaje desde el bloque afectado |
| Debía escalar y no ocurrió (12) | Detener el envío, forzar el bloque de transición humana |
| Prometió escalar sin confirmación (12) | Eliminar esa promesa antes de enviar, nunca enviarla igual |
| Introdujo objeción nueva no solicitada (14) | Eliminar ese bloque por completo |
| No facilita ningún siguiente paso (15) | Agregar el CTA/confirmación mínima que el plan sí autoriza |

Ninguna falla de esta lista se ignora "porque el resto del mensaje está
bien" — cualquier fallo listado obliga a la corrección específica antes de
que el mensaje se considere válido para enviar.

---

## 17. Casos de diseño obligatorios

Para cada caso: resumen del Decision Plan relevante, estructura elegida,
bloques usados, longitud, CTA/pregunta, errores a evitar. Sin mensaje
final redactado.

**1. "¿Precio?"** — Plan: `turn_goal`=responder, `offer_allowed`=true,
longitud=breve. Estructura: respuesta directa (precio + qué incluye) + CTA
Oferta. Bloques: 2. Longitud: breve. CTA: Oferta, intensidad media. Evitar:
responder con una pregunta de vuelta en lugar del precio; alargar con
beneficios no pedidos.

**2. "¿Ayuda con las caries?"** — Plan: concepto=Caries, `turn_goal`=
responder+construir valor, longitud=normal. Estructura: respuesta directa
(sí, con matiz) + beneficio (fortalece/remineraliza) + aclaración honesta
(no cura una ya formada) + CTA Oferta suave. Bloques: 3-4. Longitud:
normal. CTA: Oferta, intensidad baja-media. Evitar: abrir con "no";
mencionar al dentista como primera palabra; omitir la aclaración honesta.

**3. "Tengo mucha sensibilidad."** — Plan: concepto=Sensibilidad,
avatar=Persona con dolor, `desired_emotion`=alivio, longitud=normal.
Estructura: respuesta directa/reconocimiento + beneficio conectado al
dolor específico + CTA Oferta. Bloques: 2-3. Longitud: normal. CTA:
Oferta. Evitar: dar una lista genérica de beneficios en vez de enfocarse en
sensibilidad específicamente; sonar clínico.

**4. "Está muy cara."** — Plan: `objection`=precio, `primary_action`=
resolver objeción, longitud=normal/profunda si es la primera vez. Marco
validar-reencuadrar-evidenciar-avanzar (sección 12). Bloques: validar +
reencuadre + evidencia (contenido completo) + CTA Oferta suave. Longitud:
normal. Evitar: ofrecer un descuento no autorizado; sonar defensivo.

**5. "¿Funciona de verdad?"** — Plan: etapa=Escéptico o Interesado,
`primary_action`=dar evidencia, longitud=normal. Estructura: respuesta
directa afirmativa + evidencia (ingrediente/mecanismo) + CTA
Profundización u Oferta según momentum. Bloques: 2-3. Evitar: sonar
inseguro o hedging sobre un hecho aprobado; exagerar con adjetivos no
sustentados.

**6. "¿Por qué esta y no Sensodyne?"** — Plan: `primary_action`=comparar,
longitud=normal/profunda. Estructura: reconocimiento breve de la
alternativa + diferenciación honesta (ingrediente/modelo de compra) + CTA
Profundización u Oferta. Bloques: 2-3. Evitar: cualquier comentario
negativo sobre la otra marca; sonar competitivo o inseguro.

**7. "Me da miedo que sea una estafa."** — Plan: avatar=Comprador
desconfiado, `primary_action`=crear confianza, `desired_emotion`=seguridad,
longitud=normal. Estructura: validación empática + evidencia (pago contra
entrega como ancla) + CTA Confianza o Profundización, nunca Oferta directa
todavía si la desconfianza es fuerte. Bloques: 2-3. Evitar: sonar ofendido;
insistir en la oferta antes de resolver el miedo.

**8. "Dale, quiero la oferta."** — Plan: señal de compra fuerte,
`primary_action`=cerrar, longitud=breve. Estructura: confirmación
operativa + pregunta única por el dato operativo que falta (o CTA Datos).
Bloques: 1-2. Evitar: seguir vendiendo o educando; agregar beneficios;
hacer más de una pregunta.

**9. Cliente entrega nombre y dirección.** — Plan: `primary_action`=cerrar,
`cta_type`=Confirmación, longitud=breve. Estructura: confirmación
operativa de los datos recibidos + siguiente paso (oferta a confirmar, si
falta, o cierre total). Bloques: 1-2. Evitar: pedir de nuevo un dato ya
dado; alargar con contenido comercial innecesario en este punto.

**10. "Lo voy a pensar."** — Plan: `primary_action`=esperar (o resolver
objeción si hay una identificable debajo), longitud=breve. Estructura:
respeto breve de la decisión + puerta abierta sin presión. Si hay una
objeción específica detectable, un solo intento de descubrirla con
pregunta breve. Bloques: 1-2. Evitar: insistir; repetir la oferta sin
motivo; sonar decepcionado.

**11. Embarazo.** — Plan: `risk_level`=señal médica, `escalation_required`
posible según Knowledge Engine, `offer_allowed`=false, longitud=normal.
Estructura: respuesta honesta (sin inventar seguridad) + indicación de
consultar a un profesional +, si el plan lo confirma, transición humana.
Sin CTA comercial. Bloques: 2. Evitar: afirmar que es segura o insegura sin
base; continuar con una oferta en el mismo mensaje.

**12. Niño pequeño.** — Análogo al caso 11: `offer_allowed`=false, sin
inventar edades ni dosis, remite a un profesional según lo ya aprobado.
Bloques: 2. Evitar: dar una edad mínima inventada; vender en el mismo
mensaje.

**13. Reacción adversa.** — Plan: `risk_level`=alto, `escalation_required`
=true, `offer_allowed`=false, `primary_action`=escalar, longitud=normal.
Estructura: empatía genuina + recomendación de suspender el uso +
transición humana (solo si el plan confirma la escalación). Bloques: 2-3.
Evitar: autoevaluar la gravedad; minimizar; continuar vendiendo; prometer
un agente si no fue confirmado.

**14. Cliente quiere cancelar.** — Plan: etapa=Riesgo de cancelación,
`offer_allowed`=false, `primary_action`=descubrir motivo antes de
reaccionar, longitud=normal. Estructura: pregunta empática sobre el motivo
(una sola) + espacio para que el cliente responda antes de cualquier otra
acción. Bloques: 1-2. Evitar: presionar para revertir la decisión; ofrecer
un descuento no autorizado para retenerlo; sonar contrariado.

**15. Cliente pregunta algo que ya fue respondido.** — Plan:
`conversation_context` marca esto como repetido, longitud=breve.
Estructura: respuesta breve y directa, sin comentar que ya se había
respondido, sin sonar impaciente. Bloques: 1. Evitar: señalar la
repetición ("como te dije antes..."); alargar innecesariamente asumiendo
que la primera respuesta no fue suficiente.

---

## 18. Errores críticos

Errores de redacción y ejecución — no errores de decisión, esos ya son
responsabilidad del Decision Engine (documento anterior, sección 16):

1. Convertir una decisión de longitud breve en un mensaje largo "por si
   acaso".
2. Añadir una oferta, descuento, o condición no autorizada por el plan.
3. Hacer dos preguntas en el mismo mensaje.
4. Inventar un beneficio, cifra, o estudio que no está en el Knowledge
   Engine.
5. Repetir el precio u oferta sin que exista una razón nueva para
   hacerlo.
6. Sonar como un asistente de IA en cualquier punto del texto.
7. Abrir el mensaje con una limitación o negación cuando el turno no lo
   requiere.
8. Incluir cualquier contenido de venta durante una reacción adversa o
   señal médica real.
9. Reabrir una objeción que el cliente ya dejó atrás por su cuenta.
10. Pedir un dato que el cliente ya entregó en un turno anterior.
11. Prometer un agente humano cuando el escalamiento no fue confirmado
    por el plan.
12. Mezclar más de un concepto dominante en el mismo mensaje sin que el
    cliente lo haya pedido.
13. Usar un CTA de mayor intensidad que el indicado por `cta_type`.
14. Añadir un bloque de contenido que el plan no autorizó (por ejemplo,
    beneficio adicional cuando el turno era puramente de cierre).
15. Ignorar `prohibited_actions` del plan por considerarlas "no tan
    importantes" en este caso puntual.
16. Producir más de un mensaje candidato para que otro sistema elija.
17. Fabricar urgencia o escasez que no está en el plan ni en el Knowledge
    Engine.
18. Usar el mismo patrón de apertura o cierre en mensajes consecutivos de
    la misma conversación sin ninguna variación.
19. Dejar sin responder la pregunta explícita del cliente por enfocarse
    solo en el objetivo comercial del turno.
20. Contradecir un hecho ya afirmado antes en la misma conversación.
21. Convertir una respuesta de servicio (pedido en curso) en una
    oportunidad de venta no solicitada.
22. Entregar el mensaje sin haber corrido el checklist completo de la
    sección 16.

---

## 19. Contrato entre Decision Engine y Response Generator

La frontera es absoluta: **el Decision Engine decide QUÉ hacer. El
Response Generator decide CÓMO expresarlo.** Ninguna capa invade el
territorio de la otra.

**Campos obligatorios para poder generar.** Como mínimo, el plan debe
traer: `turn_goal`, `primary_action`, `buyer_stage`, `response_length`,
`question_allowed`, `offer_allowed`, `escalation_required`, y
`prohibited_actions`. Sin estos ocho campos, no existe base suficiente
para producir un mensaje responsable.

**Si el Decision Plan llega incompleto o contradictorio** (por ejemplo,
`offer_allowed`=true y `risk_level`=alto al mismo tiempo, sin que el plan
resuelva cuál gana): el Response Generator no improvisa una interpretación
propia de cuál campo tiene prioridad — esa arbitración ya le corresponde
al Decision Engine. En su lugar, devuelve una señal interna de necesidad de
aclaración (no una respuesta comercial arbitraria hacia el cliente) para
que el plan se corrija antes de intentar generar de nuevo. Nunca se envía
un mensaje al cliente construido sobre una contradicción sin resolver.

---

## 20. Roadmap de implementación rápida

Último documento de arquitectura antes de implementar. Ninguna fase está
aprobada ni iniciada.

| Fase | Objetivo | Archivos probables | Riesgo | Criterio de aceptación | Qué NO incluye |
|---|---|---|---|---|---|
| **RG-1** — Instrucciones en el prompt actual | Traducir los principios de Decision Plan/Response Generator a instrucciones dentro del `buildSystemPrompt()` existente, sin motor separado — paso intermedio | `src/lib/genesis/respond.ts` (footer, igual de quirúrgico que Fase 2A) | Bajo — mismo patrón ya validado | Suite offline de Fase 2A sigue en verde + casos nuevos de bloques/longitud/CTA (§17) pasan en estático y real | Ningún Decision Plan estructurado real todavía |
| **RG-2** — Decision Plan estructurado | Producir el plan como salida estructurada real, separando decisión de redacción por primera vez | Módulo nuevo dedicado a construir el plan, separado de `respond.ts` | Medio — llamada/paso adicional, latencia y costo a medir | Plan generado consistente con los campos de §2, verificado contra conversaciones de prueba | Generación de texto desde el plan (fase siguiente) |
| **RG-3** — Generación desde el plan | Conectar el plan de RG-2 con un generador que aplique bloques, longitud, CTA, no-repetición y el checklist de §16 | Módulo de generación separado que consume el plan de RG-2 | Medio-alto — primera vez que decisión + redacción desacopladas operan de punta a punta | Los 15 casos de §17 se validan con el pipeline completo, no solo con el prompt monolítico | Rollout a producción — enteramente offline |
| **RG-4** — Suite offline de conversaciones completas | Validar conversaciones multi-turno completas (etapa, momentum, Recovery Engine), no solo turnos aislados | Suite hermana de `test-genesis-commercial-luma.ts`, orientada a conversaciones completas | Medio — riesgo de cobertura, no de infraestructura | Conjunto representativo de conversaciones multi-turno se comporta como se espera, gates tan estrictos como Fase 2A/2A.2 | Medición de conversión real — sigue siendo validación de comportamiento |
| **RG-5** — Rollout controlado y medición | Activar el pipeline en producción de forma gradual, con monitoreo y métrica definida de antemano | Cambios de despliegue/flag en la ruta ya existente del webhook, sin nueva infraestructura de runs | Alto — única fase que toca clientes reales, requiere reversión inmediata disponible | Cero gates de seguridad/claims violados durante la prueba, métrica de calidad definida antes de empezar | Ninguna fase posterior a RG-5 está definida todavía |

Ninguna fase de este roadmap está aprobada. Cada una requiere su propio
visto bueno explícito, igual que todas las fases anteriores de Génesis.
