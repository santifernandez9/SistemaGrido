# ETAPA 0.1 — Correcciones de arquitectura y planificación
### Revisión correctiva puntual sobre `docs/ETAPA-0-ANALISIS-ARQUITECTURA.md`

Fecha: 2026-09-02 · Autor: Claude (arquitecto de software) · Alcance: exclusivamente correctivo. No se escribió código, no se generó frontend/backend, no se crearon migraciones, no se configuró Supabase/Vercel/Render, y no se avanzó a Etapa 1.

> Este documento registra **qué cambió en el informe de Etapa 0 y por qué**, a pedido explícito de una revisión crítica del cliente. El informe corregido queda en `docs/ETAPA-0-ANALISIS-ARQUITECTURA.md` (versión 1.1). Este archivo es el registro de la corrección, no lo reemplaza.

---

## 1. Correcciones realizadas (punto por punto)

### Corrección 1 — RF-022 / Deshacer baja de lata
**Problema**: la v1.0 tomaba la regla del sistema actual ("deshacer baja de lata sólo el mismo día, excepto Admin") y la presentaba como si fuera la regla del sistema nuevo, con la coletilla "se adopta salvo objeción del cliente" — es decir, convertía un comportamiento heredado en requisito por omisión.

**Corrección aplicada**:
- RF-022 se reescribió: ahora describe únicamente el **mecanismo** (corregir/deshacer una baja de lata vía el mecanismo general de reversión de un movimiento, sección 11.4 del informe), sin ninguna restricción de plazo ni de rol.
- Su estado pasó de "EXISTENTE EN SISTEMA ACTUAL, coherente con reglas confirmadas — se adopta como regla salvo objeción" a **"EXISTENTE EN SISTEMA ACTUAL / PENDIENTE DE CONFIRMACIÓN"**.
- RN-027 se reescribió en el mismo sentido: se mantiene lo confirmado (que la baja de lata es un movimiento completo por sabor, con usuario/ubicación/fecha/hora — eso sí está en el documento del cliente), y se retiró la cláusula "puede deshacerse el mismo día (excepto Admin...)" que no está confirmada.
- No se implementa ninguna restricción temporal ni de rol en el diseño hasta que el cliente confirme la política real.
- Se generó el pendiente **P-009 — Política de corrección/anulación de bajas de lata**, con una pregunta orientada a determinar qué correcciones necesita permitir realmente el cliente (¿la misma persona puede deshacerlo en cualquier momento? ¿sólo el mismo día? ¿sólo el Admin? ¿hay un límite de tiempo o alcanza con que quede auditado quién corrige y por qué?).

### Corrección 2 — Umbrales de reconteo
**Problema**: la Etapa 3 del plan maestro decía textualmente "umbrales de reconteo (P-002 se resuelve aquí, **con valor por defecto** si el cliente aún no lo confirmó)", y la fila de P-002 en la tabla de pendientes decía "puede quedar como parámetro configurable con **un valor por defecto razonable**". Ambas frases proponían inventar un número (porcentaje, cantidad o tolerancia) sin evidencia del cliente.

**Corrección aplicada**:
- Se eliminó toda mención a un "valor por defecto" o "razonable" para el umbral de reconteo, tanto en la Etapa 3 del plan maestro como en la fila P-002 de la tabla de pendientes.
- Se dejó explícito que **configurable ≠ valor inventado**: el campo se diseña como parámetro configurable por tipo de producto (cerrado vs. granel), sin que este informe le asigne ningún número.
- Se especificó exactamente qué puede avanzar sin el valor y qué queda bloqueado: el ledger, el cálculo de stock teórico, la diferencia, los ajustes y el resto de Etapa 3 **no dependen** de este número y pueden completarse igual. Lo único que **sí queda bloqueado** hasta que el cliente confirme P-002 es la **activación real** del disparo automático de reconteo en producción (Etapa 3/4) — la pantalla puede construirse, pero no puede decidir sola cuándo pedir un reconteo sin ese dato.

### Corrección 3 — RF-008 / Importación de catálogo y BOM
**Problema**: RF-008 ("importar catálogo maestro de Grido y sugerir automáticamente equivalencias/BOM") figuraba en la v1.0 como un requisito funcional numerado con prioridad propia, cuando en realidad es un mecanismo técnico que existe en el prototipo actual, no algo pedido explícitamente por el cliente. Esto mezclaba "necesidad confirmada" con "mecanismo propuesto", y "necesidad confirmada" (relacionar ventas con su consumo) con "mejora recomendable" (generación asistida de BOM).

**Corrección aplicada**:
- RF-008 se **retiró** de la tabla de requisitos funcionales (sección 4.1). En su lugar hay una nota explícita señalando la reclasificación.
- Se separaron con claridad las dos necesidades confirmadas, que ya estaban cubiertas por otros RF y no cambiaron: (a) tener un catálogo utilizable — RF-001 a RF-007; (b) relacionar ventas con consumo de insumos cuando corresponda — RF-033 a RF-035.
- El mecanismo técnico (importar el archivo de Grido + generar BOM por coincidencia de nombre) se trasladó **íntegramente a R-002** (sección de Recomendaciones), marcado como mejora **opcional y sujeta a aprobación explícita del cliente**, no como alcance obligatorio de Etapa 2.
- Se corrigieron todas las referencias cruzadas a "RF-008" en el resto del documento (sección 13.2 — BOM y consumo automático; sección 13.1 — tabla de problemas de BOM; sección 20 — R-002; Etapa 2 y matriz de trazabilidad en el plan maestro) para que apunten a R-002 en vez de a un requisito retirado.
- No se eliminó la capacidad de importar el catálogo del alcance del informe — sigue documentada como mecanismo válido y recomendado —, sólo se corrigió su clasificación.

### Corrección 4 — Solapamiento Etapa 3 / Etapa 4
**Problema**: la v1.0 listaba varios RF (conteo, latas/granel, umbral de reconteo, marcar sin stock, mermas, gasto variable) simultáneamente en "Requisitos incluidos" de Etapa 3 **y** de Etapa 4, sin indicar qué parte se hacía en cada una. Además, la Etapa 4 decía sobre las entidades `waste_event`, `variable_expense` y `stockout_event`: "ya definidas en Etapa 3 de ser necesario, se activan aquí" — una frase ambigua que no decidía nada.

**Corrección aplicada**:
- Se redefinieron los límites de las dos etapas de forma tajante: **Etapa 3 = motor de dominio/backend/persistencia + UI de Admin (desktop)**, sin ninguna pantalla mobile-first; **Etapa 4 = experiencia operativa/frontend PWA** para Empleada de heladería y Encargado de depósito, sin agregar entidades ni reglas de negocio nuevas.
- Se decidió explícitamente, sin ambigüedad, que `waste_event`, `variable_expense` y `stockout_event` **se crean en Etapa 3** (backend) — son necesarias porque los requisitos que las usan (RF-024, RF-026, RF-019) están confirmados por el documento del cliente — y que Etapa 4 sólo construye la pantalla que las consume, sin crear ni redefinir nada.
- Se agregaron dos tablas (una por etapa) que recorren cada RF involucrado (RF-009 a RF-026) y dicen exactamente qué parte se construye en Etapa 3, qué parte en Etapa 4, y en cuál de las dos queda **COMPLETO** cada uno. Ningún RF figura como terminado en las dos etapas a la vez.
- Casos particulares decididos:
  - RF-009, RF-010, RF-015, RF-016, RF-017, RF-018 (ledger, cálculo de teórico/diferencia, justificación por Admin, cierre de conteo): **completos en Etapa 3**, porque no requieren la PWA de heladería — el Admin opera desde el panel desktop.
  - RF-011, RF-012, RF-013, RF-014, RF-019, RF-020, RF-021, RF-023 (parte de captura), RF-024, RF-025, RF-026: backend/esquema en Etapa 3, **completos recién en Etapa 4** (requieren la pantalla mobile usada por Empleada/Encargado).
  - RF-013 (autoguardado local): **no corresponde a Etapa 3 en absoluto** — es 100% un mecanismo de cliente/PWA, se construye íntegramente en Etapa 4.
  - RF-022 (deshacer baja de lata): mecanismo genérico en Etapa 3, pantalla en Etapa 4, **política final pendiente en ambas** (P-009 — ver Corrección 1).
- También se revisó explícitamente "pesajes": el sistema actual tiene un módulo de pesaje real con balanza (`Pesajes.gs`), pero el documento del cliente (§17.1) lo reemplaza por fracción estimada a ojo dentro del conteo — se agregó una nota aclarando que "pesaje con balanza" **no es un requisito** del Hito 1 (está evidenciado en el sistema actual pero explícitamente reemplazado por la regla confirmada), para que no quede la duda de si se lo olvidó.

### Corrección 5 — Prisma y migraciones
**Problema**: la v1.0 recomendaba Prisma sin especificar versión, sin explicar cómo se implementan constraints que el ORM no representa de forma nativa (`CHECK`, índices parciales, triggers), y sin detalle de compatibilidad con el pooler de Supabase.

**Corrección aplicada**: se agregó la subsección **17.1 — Detalle de la decisión de ORM y migraciones**, con:
- Versión propuesta (rama estable 5.x, a fijar en número exacto recién al iniciar Etapa 1, documentada en el lockfile del repo, no en este informe).
- Estrategia de migraciones (Prisma Migrate, historial versionado en el repo).
- Qué representa el ORM de forma nativa (tablas, columnas, tipos, FKs, `UNIQUE`, `DEFAULT`, índices simples) y qué no (`CHECK` constraints, índices parciales, triggers) — y cómo se resuelve cada uno de esos casos: SQL manual dentro de las propias migraciones generadas por Prisma, con revisión obligatoria en code review.
- Compatibilidad con Supabase (conexión directa para migraciones vs. pooler pgbouncer para runtime).
- Comparación explícita contra Drizzle ORM (ventajas/desventajas de cada uno para este proyecto).
- Justificación de por qué se mantiene Prisma (velocidad de desarrollo dado el timeline ajustado del cliente) sin cambiar de ORM sólo por esta observación, tal como pidió la corrección.

### Corrección 6 — Autenticación y PIN
**Problema**: la sección de Seguridad de la v1.0 mezclaba identidad, autenticación, autorización y UX operativa, y llegaba a sugerir un PIN corto "como contraseña" de una cuenta técnica de Supabase Auth — exactamente el patrón que la corrección pidió evitar.

**Corrección aplicada**: se reescribió por completo la sección 18 (Seguridad):
- Se separaron explícitamente los cuatro conceptos (Identidad / Autenticación / Autorización / UX operativa) en una tabla, aclarando cuáles dependen de P-001 y cuáles no.
- Se presentaron **tres alternativas técnicamente válidas** para Identidad + Autenticación (identidad individual real; cuenta técnica por rol/ubicación + selección de responsable; híbrido con PIN individual como capa de UX sobre una sesión ya autenticada) — **sin elegir ninguna**, porque la elección depende de P-001.
- Se dejó explícito que **ninguna alternativa usa un PIN corto como si fuera la contraseña convencional de una cuenta de Supabase Auth** — un PIN de 4 dígitos no tiene la entropía necesaria para funcionar como credencial criptográfica, y si es compartido, elimina la posibilidad de atribución individual que la auditoría necesita.
- Autorización (middleware por rol + ubicación) se dejó documentada como independiente de P-001 — no cambia según qué alternativa de identidad se elija.

### Corrección 7 — P-001 debe ser bloqueante, y reformulada en términos no técnicos
**Problema**: P-001 estaba correctamente identificada como relevante para Etapa 1, pero (a) el Resumen Ejecutivo la describía de forma contradictoria como "pendiente no bloqueante que sí condiciona" el diseño, y (b) la pregunta estaba formulada en términos técnicos ("¿cuenta individual en Supabase Auth o PIN compartido?"), no respondibles por una persona no técnica.

**Corrección aplicada**:
- P-001 quedó marcada explícitamente como **🔴 BLOQUEANTE** en la tabla de pendientes (sección 22), en el consolidado de preguntas (sección 26) y en el Veredicto final (sección 27), aclarando en los tres lugares que bloquea el **inicio de Etapa 1**, no la aprobación de Etapa 0.
- Se corrigió la contradicción del Resumen Ejecutivo (sección 1), que ahora dice explícitamente "decisión BLOQUEANTE para el inicio de Etapa 1" en vez de "pendiente no bloqueante".
- La pregunta se reformuló por completo en términos operativos: en vez de preguntar por una estrategia de autenticación, pregunta si cada persona se identifica individualmente antes de cargar algo, si hay un dispositivo por persona o uno compartido por local, si después hace falta saber exactamente quién hizo cada carga o alcanza con saber el local, y si el ingreso tiene que ser tan rápido como hoy (PIN) aunque eso signifique no saber la persona exacta. La resolución técnica (cuál de las tres opciones de la sección 18.2 se implementa) queda **para después** de tener esa respuesta, no se pide de antemano.

---

## 2. Supuestos eliminados

| Supuesto detectado | Dónde estaba | Cómo quedó reclasificado |
|---|---|---|
| "Deshacer baja de lata sólo el mismo día, excepto Admin" tratado como regla del sistema nuevo | RF-022, RN-027 | **PENDIENTE DE DEFINICIÓN** — nuevo pendiente P-009 |
| Umbral de reconteo con "valor por defecto razonable" | Etapa 3 del plan maestro, fila P-002 | **PENDIENTE**, sin valor asignado; se aclaró qué puede avanzar y qué queda bloqueado sin él |
| Importación automática del catálogo Grido + generación asistida de BOM tratada como requisito obligatorio (RF-008) | Sección 4.1, Etapa 2, matriz de trazabilidad | **RECOMENDACIÓN TÉCNICA (R-002)**, opcional, sujeta a aprobación explícita |
| "Se adopta salvo objeción del cliente" (líneas de venta sin código de artículo) | RF-031 | Reformulado como **RECOMENDACIÓN TÉCNICA** de bajo impacto, sin lenguaje de adopción automática |
| Uso de PIN corto como si fuera contraseña de una cuenta de Supabase Auth | Sección 18 (Seguridad, v1.0) | Retirado explícitamente; sección 18 reescrita separando Identidad/Autenticación/Autorización/UX, con tres alternativas presentadas sin elegir ninguna |
| Peso de lata (~7,8 kg) etiquetado como "EXISTENTE EN SISTEMA ACTUAL, adoptado como parámetro por defecto" | RN-026 | Corregido a **CONFIRMADO** (el propio documento del cliente lo dice explícitamente en §17) + RESPALDADO por dos evidencias independientes — no era un supuesto inventado, estaba mal etiquetado como tal |
| "Ya definidas en Etapa 3 de ser necesario, se activan aquí" (entidades de Etapa 4) | Etapa 4 del plan maestro | Reemplazado por una decisión explícita: las tres entidades se crean en Etapa 3, sin condicional |
| Referencias cruzadas a "sección 14" para hablar de Auth/Seguridad (la sección 14 real es Cierre semanal) | Sección 2, sección 7, sección 10.1 | Corregidas a "sección 18" (la sección de Seguridad real) |

---

## 3. Requisitos reclasificados

| RF/RN | Estado en v1.0 | Estado en v1.1 |
|---|---|---|
| RF-008 | Requisito funcional con prioridad P2 | **Retirado como RF** — reclasificado como R-002 (recomendación opcional) |
| RF-022 | CONFIRMADO/EXISTENTE, con regla de "mismo día" adoptada por defecto | EXISTENTE EN SISTEMA ACTUAL / **PENDIENTE DE CONFIRMACIÓN** (P-009), sin ninguna restricción implementada todavía |
| RF-031 | EXISTENTE EN SISTEMA ACTUAL — "se adopta salvo objeción" | EXISTENTE EN SISTEMA ACTUAL — **RECOMENDACIÓN TÉCNICA** de bajo impacto |
| RN-026 | EXISTENTE EN SISTEMA ACTUAL, "adoptado por defecto" | **CONFIRMADO** (Doc §17) + RESPALDADO — subida de categoría, no bajada: estaba subestimado en la v1.0 |
| RN-027 | CONFIRMADO + EXISTENTE (regla de "mismo día") | CONFIRMADO sólo en la parte de mecánica del movimiento; la política de reversión es **PENDIENTE DE DEFINICIÓN** |

Ningún otro RF/RN cambió de estado en esta revisión.

---

## 4. Cambios al plan de etapas

- **Etapa 2**: se separó "alcance obligatorio" (RF-001 a RF-007, catálogo y BOM manual) de "mejora opcional, sujeta a aprobación" (R-002, importador asistido del catálogo Grido). Etapa 2 puede cerrarse sin R-002.
- **Etapa 3**: se redefinió como exclusivamente backend/dominio/persistencia + UI de Admin (desktop). Se agregó una tabla que asigna, RF por RF, qué se construye acá y si queda completo acá o en Etapa 4. Se agregó el tratamiento explícito de P-002 (qué avanza, qué queda bloqueado).
- **Etapa 4**: se redefinió como exclusivamente frontend PWA para Empleada/Encargado de depósito, sin agregar entidades ni reglas de negocio nuevas — sólo consume lo construido en Etapa 3. Se agregó una tabla equivalente a la de Etapa 3, marcando qué RF queda completo en esta etapa y con qué salvedades (RF-014 y RF-022 quedan "operables, no activos/finales" hasta resolver P-002/P-009).
- Ninguna otra etapa (0, 1, 5, 6, 7, 8, Post-temporada) cambió de alcance, dependencias o criterios de aceptación — sólo se corrigieron referencias cruzadas rotas (ej. "sección 14" → "sección 18") y la numeración de RF de catálogo (RF-001..008 → RF-001..007) en la matriz de trazabilidad.

---

## 5. Pendientes bloqueantes

| ID | Pregunta | Bloquea |
|---|---|---|
| **P-001** | Cómo se identifica realmente cada persona al usar el sistema (individual vs. compartido, dispositivo por persona o por local, necesidad real de saber "quién" ante una diferencia, y qué tan rápido tiene que ser el ingreso) — pregunta reformulada en términos operativos, no técnicos | **Inicio de Etapa 1** (Auth). No bloquea la aprobación de este informe. |

Es el único pendiente bloqueante de todo el informe, antes y después de esta corrección.

---

## 6. Pendientes no bloqueantes

| ID | Pregunta | Antes de qué etapa conviene resolverla |
|---|---|---|
| P-002 | Umbrales de reconteo (producto cerrado vs. helado a granel) | No bloquea Etapa 3; bloquea activar el disparo automático de reconteo en producción (Etapa 3/4) |
| P-003 | Stack real del socio programador | No bloquea nada de este plan; afecta velocidad |
| P-004 | Formato real del insumo semanal de Mercado Pago | Etapa 7 |
| P-005 | Si Encargado de depósito puede registrar mermas de depósito | Ninguna etapa (se construye con la restricción heredada del prototipo hasta tener respuesta) |
| P-006 | Nombre/lista real de ubicaciones operativas | Etapa 1 (seed de datos) |
| P-007 | Mapeo campo a campo de la planilla de papel real | Etapa 4 |
| P-008 | FIFO al transferir entre ubicaciones | Hito 1b/2 — no bloquea nada de este plan |
| **P-009 (nueva)** | Política de corrección/anulación de bajas de lata | Etapa 4 (la pantalla se construye igual; sin política, deshacer exige motivo y queda auditado, sin límite automático) |

---

## 7. Decisiones técnicas revisadas

- **Prisma**: se mantiene como recomendación, ahora con versión a fijar en Etapa 1 (no en Etapa 0), estrategia de migraciones explícita, y el tratamiento concreto de `CHECK`/índices parciales/triggers vía SQL manual dentro de las migraciones — comparado explícitamente contra Drizzle ORM. No se cambió de ORM: se documentó la justificación pedida.
- **Autenticación**: no se eligió una solución. Se documentaron tres alternativas técnicamente válidas (identidad individual; cuenta técnica + selección de responsable; híbrido con PIN individual como capa de UX), separando Identidad/Autenticación/Autorización/UX operativa, y se dejó la elección condicionada a la respuesta de P-001. Se descartó explícitamente usar un PIN corto como contraseña convencional de Supabase Auth, en cualquiera de las alternativas.
- **Monorepo vs. repos separados, Fastify/Express, Zod, Vitest/Playwright, Pino, SheetJS/pdf-parse server-side, Supabase Storage, Sentry**: sin cambios — no fueron objeto de ninguna de las 7 correcciones y no se detectaron supuestos indebidos en ellas durante la revisión adicional.

---

## 8. Preguntas al usuario

Sólo una pregunta requiere respuesta para poder avanzar a Etapa 1 (las demás pueden resolverse más adelante, cada una antes de la etapa que realmente la necesita — sección 22 del informe corregido tiene el detalle completo):

**P-001** — Cuando una Empleada de heladería o el Encargado de depósito usan el sistema:
- (a) ¿cada persona se identifica individualmente (con su nombre/usuario propio) antes de cargar algo, o varias personas comparten el mismo acceso/dispositivo sin distinguirse entre sí?
- (b) ¿hay un celular/tablet por persona, o uno solo compartido por local?
- (c) si es compartido: cuando después hace falta preguntar "¿quién cargó esto?" (por ejemplo, ante una diferencia de stock), ¿necesitan poder saber exactamente qué persona lo hizo, o alcanza con saber que fue "alguien de tal heladería"?
- (d) ¿el ingreso al sistema tiene que ser lo más rápido posible (unos segundos, como hoy con el PIN), aunque eso signifique no saber la persona exacta, o puede tomar un poco más si eso permite identificarla?

No se pide elegir una solución técnica — eso se decide después, con la respuesta.

---

## 9. Veredicto

## **B — ETAPA 0 CORREGIDA, PERO EXISTEN PREGUNTAS BLOQUEANTES**

Las 7 correcciones puntuales pedidas se aplicaron sin necesidad de rehacer secciones que no estaban señaladas, y la revisión adicional de supuestos ("se adopta", "por defecto", "salvo objeción", valores heredados sin confirmar) no encontró más casos de fondo que los ya corregidos — sólo dos ajustes menores de coherencia (una regla mal etiquetada como supuesto cuando en realidad estaba confirmada por el documento del cliente — RN-026 —, y referencias cruzadas rotas a "sección 14"). El plan de etapas quedó sin solapamientos: cada funcionalidad tiene un dueño claro de dónde se construye y dónde queda completa, las decisiones estructurales (ledger, `organization_id`, ORM) siguen tomadas antes de necesitarse, y ninguna recomendación no aprobada aparece ya como requisito obligatorio.

El veredicto es **B**, no A, precisamente porque la Corrección 7 exigía que **P-001 quedara explícitamente marcada como bloqueante** — y así quedó, de forma consistente en las secciones 1, 22, 26 y 27 del informe corregido. Sería contradictorio corregir el documento para remarcar que existe una pregunta bloqueante y al mismo tiempo declarar en este veredicto que no hay preguntas bloqueantes. La corrección no agregó nuevas decisiones bloqueantes respecto de la v1.0 ni dejó ninguna otra sin resolver por falta de información — sigue siendo la misma y única pregunta (P-001), ahora reformulada para que el cliente pueda responderla sin necesitar conocimiento técnico, y sigue sin bloquear la aprobación de este documento en sí, sólo el inicio de Etapa 1.

**Recomendación**: aprobar esta corrección, responder P-001, y recién entonces avanzar a Etapa 1. El resto de los pendientes (P-002 a P-009) no bloquean nada de lo que sigue y pueden resolverse en paralelo, cada uno antes de la etapa que efectivamente lo necesita.
