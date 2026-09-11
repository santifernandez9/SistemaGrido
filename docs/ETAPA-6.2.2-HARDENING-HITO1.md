# ETAPA 6.2.2 — Hardening final del Hito 1

Versión: 1.0 · Rama: `claude/etapa-6-cierre-semanal` · HEAD auditado de
Etapa 6.2.1: `dfbf40e9fdc73ee6e87104e1afc294b0c2207f42`

Esta NO es una etapa funcional nueva: corrige 4 áreas encontradas en una
auditoría integral final del Hito 1 (sección 0 del prompt de 6.2.2) para
dejarlo en condiciones reales de staging/piloto. No se avanza a Etapa 7 ni a
Etapa 8. No se rehace nada que ya estaba correcto -- ledger append-only,
stock derivado, idempotencia, concurrencia, auditoría transaccional,
aislamiento multi-tenant, `Decimal`, precios históricos, valorización por
`periodEnd`, regla del 25%, cierre general, snapshots inmutables,
`COUNT_CORRECTION`, categorías dinámicas de la Shop PWA, autoguardado
IndexedDB y conteo ciego se preservan íntegramente.

## 1. Qué corrige esta etapa (mapa rápido)

| #   | Problema de la auditoría                                              | Secciones del prompt | Estado    |
| --- | --------------------------------------------------------------------- | -------------------- | --------- |
| 1   | Un conteo semanal podía quedar COMPLETED incompleto (BLOCKER)         | 1-6                  | Corregido |
| 2   | Una semana podía cerrarse con diferencias sin resolver (BLOCKER)      | 7-13                 | Corregido |
| 3   | Detección de tipeo usaba el precio de venta de "hoy", no el histórico | 13                   | Corregido |
| 4   | Sin modelo genérico para presentaciones múltiples (Unidad/Caja/Pack)  | 14-19                | Corregido |

## 2. BLOCKER 1: universo obligatorio del conteo (secciones 1-6)

**El problema real**: `submitInventoryCount` nunca validaba que el conjunto
de productos enviado cubriera el universo completo del catálogo -- un
conteo con 3 de 200 productos podía llegar a `COMPLETED` igual, dejando el
resto con stock teórico "congelado por omisión" sin que nadie lo notara.

**Interpretación del universo obligatorio (documentada, no inventada)**: el
modelo actual NO tiene ninguna distinción "inventariable/no inventariable"
-- sólo `Product.active`. No existe tampoco una relación producto-ubicación
que acote qué productos corresponden a qué heladería. Ante esa ausencia, se
usó la interpretación más consistente con el sistema ya existente: **el
universo obligatorio de un conteo es TODO producto `active` de la
organización**, exactamente el mismo conjunto que ya devuelve
`GET /api/products` (el que la Shop PWA ya renderiza para elegir qué
contar). No se inventó ningún campo nuevo de catálogo para esto -- si en el
futuro aparece una necesidad real de "producto no inventariable" o
"producto sólo de esta ubicación", son extensiones aditivas sobre este
mismo cálculo (`requiredProducts` en `submitInventoryCount`,
`apps/api/src/services/inventory-count.ts`), no un rediseño.

**Corrección** (`submitInventoryCount`): tras resolver idempotencia (para
que un REINTENTO de un envío ya exitoso nunca falle retroactivamente por
cambios de catálogo posteriores) y antes de crear nada, se calculan los
productos activos de la organización y se comparan contra los enviados. Si
falta alguno: `ValidationError` con la lista de nombres faltantes, ANTES de
tocar la base -- nunca se crea un `InventoryCount` parcial. La detección de
duplicados y de productos inactivos/cross-org ya existía (`productIds.size
!== items.length`, `assertProductForMovement`) -- sólo faltaba la dirección
"falta un producto", que es la que se agregó.

**Explícito-cero vs nunca-contado**: NO se agregó ningún campo nuevo al
modelo -- ya se podía expresar correctamente con lo existente.
`InventoryCountDraftItem.closedUnits` es un `number | undefined`: tipear
"0" en la Shop PWA produce `closedUnits: 0` (distinguible de `undefined`,
campo vacío), y `computeItem` ya trataba "al menos un campo presente,
aunque sea 0" como "contado". Sólo hacía falta usar ese mecanismo
consistentemente para la regla de completitud (ver `isItemCounted` en
`CountPage.tsx`, misma lógica en el cliente y el servidor).

**RECONTEO sigue PARCIAL**: la regla de completitud nueva se aplica
EXCLUSIVAMENTE a `submitInventoryCount` (el envío inicial) -- nunca a
`submitInventoryRecount`, que sigue exigiendo exactamente los productos
marcados `needsRecount`, ni más ni menos (sin cambios de Etapa 4).

**Shop PWA** (`apps/shop-pwa/src/pages/CountPage.tsx`): progreso real
`X de Y productos contados` (nunca "productos con algo tipeado" contra un
total inventado); el botón "Enviar conteo" queda deshabilitado mientras
falte algo (con `title` explicando cuántos); un resumen visible lista los
rubros con productos pendientes y cuántos, cada uno con un botón que abre
esa categoría y hace scroll hasta ella. Todo se sigue calculando del mismo
catálogo ya cargado (`GET /api/products`), nunca de una lista aparte.

## 3. BLOCKER 2: no cerrar con diferencias pendientes (secciones 7-13)

**El problema real**: `closeWeeklyClosing` podía generar `COUNT_CORRECTION`
sobre diferencias que nadie había revisado -- ni confirmado como faltante
real, ni resuelto como sobrante explicado. El checklist no reflejaba esto,
y `confirmWeeklyClosingReview` tampoco lo bloqueaba.

**Corrección, en 3 capas (sección 11: "nunca confiar en una sola
validación previa")**:

1. **`computeChecklist`** (informativo): nueva función
   `computePendingDifferenceResolutions` (`weekly-closing.ts`) recorre los
   ítems del conteo gobernante y devuelve, para cada diferencia != 0 sin
   resolución válida, `{productId, productName, difference, reason}` --
   `SHORTAGE_NOT_CONFIRMED` para un faltante sin `SHORTAGE_CONFIRMED`,
   `SURPLUS_NOT_RESOLVED` para un sobrante sin `SURPLUS_RESOLVED`. Una
   diferencia = 0 NUNCA aparece (no requiere resolución, sección H de los
   tests). Se agregó al `WeeklyClosingChecklist` expuesto por la API y entra
   en la fórmula de `canClose`.
2. **`confirmWeeklyClosingReview`** (primera línea, fuera de la
   transacción): recalcula `computePendingDifferenceResolutions` y rechaza
   con `ConflictError` (409) si hay alguna pendiente, ANTES de permitir la
   confirmación de revisión.
3. **`closeWeeklyClosing`** (autoritativo, DENTRO de la misma transacción
   que crea el snapshot/`COUNT_CORRECTION`): recalcula lo mismo con `tx`
   justo antes del bucle que genera las correcciones -- si hay algo
   pendiente, `ConflictError` y ROLLBACK completo (nunca snapshot, nunca
   corrección, nunca `CLOSED`, nunca auditoría de cierre). El chequeo
   rápido pre-transacción (`checklist.canClose`) también lo cubre y da un
   mensaje con motivos legibles, pero la garantía real es la re-validación
   dentro de la transacción -- la invariante "nunca se genera
   `COUNT_CORRECTION` sobre una diferencia pendiente" sale de que ese
   bucle está estructuralmente DESPUÉS del chequeo, no de un caso especial.

No se inventó ningún tipo de resolución nuevo -- siguen siendo exactamente
`SHORTAGE_CONFIRMED`/`SURPLUS_RESOLVED` de Etapa 6.2. El estado de un
candidato de tipeo (confirmado/rechazado) es un concepto DISTINTO y no
sustituye nunca a `InventoryCountItem.differenceResolution` -- un candidato
confirmado no resuelve por sí solo la diferencia subyacente; sigue
haciendo falta el gesto explícito de resolución.

**Admin-web**: el checklist expone `pendingDifferenceResolutions`; la
pantalla de cierre semanal muestra "Hay N diferencia(s) pendientes de
resolver" cuando corresponde (mismo patrón ya usado para
`missingCostProducts`).

## 4. Tipeo: precio de venta VIGENTE PARA LA SEMANA DEL CONTEO (sección 13)

**El bug real**: `detectAndPersistTypoCandidates` resolvía el precio de
venta contra `new Date()` -- el instante del envío, no el período que se
está analizando. Ejemplo del prompt: Casatta/Almendrado a $10.500 en
septiembre, a $11.000/$12.000 en octubre -- analizar el conteo de
septiembre debía seguir usando $10.500, y con el bug hubiera podido usar el
precio de octubre si el conteo se procesaba tarde.

**Corrección**: mismo mecanismo ya usado para el costo del cierre (Etapa
6.2.1, `periodEnd`) -- `detectAndPersistTypoCandidates` ganó un 4to
parámetro obligatorio, `asOfDate: Date`. Nuevo helper `weekEndDate(weekStart)`
(`weekStart + 6 días`, el domingo de la semana contada) reemplaza a
`new Date()` en ambos call sites: `submitInventoryCount` pasa
`weekEndDate(weekStart)`; `submitInventoryRecount` pasa
`weekEndDate(count.weekStart)` (misma semana que el envío original, nunca
la fecha del reconteo). `resolveEffectivePricesForProducts` ya resolvía por
"el `PriceValue` más reciente con `effectiveFrom <= asOfDate`" -- sólo
hacía falta pasarle la fecha correcta.

Tests nuevos en `inventory-count-resolution.test.ts` ([P]-[S]): un precio
histórico compartido detecta el candidato aun con un precio NUEVO y
distinto ya importado para después de la semana contada (discriminando
against la fecha real del sistema, no sólo contra un fixture trivial);
misma compensación con precios históricos iguales detecta, con precios
históricos distintos no detecta.

## 5. Presentaciones múltiples: Unidad/Caja/Pack (secciones 14-19)

**El problema real**: `Product` sólo tiene un `unitOfMeasureId` +
`unitsPerHandlingUnit` -- no puede representar que un mismo producto se
cuenta simultáneamente por más de una presentación física (ej. Unidad, Caja
y Pack a la vez en la misma planilla), como muestran las planillas reales.

**Modelo nuevo, genérico y aditivo** (migración
`20260912150000_product_counting_presentations_etapa6_2_2`):
`ProductCountingPresentation` (`id`, `organizationId`, `productId`,
`unitOfMeasureId`, `conversionFactorToCanonical` `Decimal(14,3)`, `active`,
`createdAt`). NUNCA hardcodea "Unidad/Caja/Pack" -- cualquier
`UnitOfMeasure` ya sembrada en la organización puede ser una presentación
de cualquier producto SIN sabor, con su propio factor de conversión a la
cantidad canónica. `UNIQUE(organizationId, productId, unitOfMeasureId)`
evita duplicados; `CHECK (conversion_factor_to_canonical > 0)` (agregado a
mano al SQL de la migración, Prisma no expresa `CHECK` declarativamente);
FKs compuestas por organización hacia `product` y `unit_of_measure`.

**Exclusivo de productos SIN sabor** (sección 17: "no mezclar el modelo de
sabores con las presentaciones de productos cerrados") --
`createProductCountingPresentation` rechaza un producto con `flavorId`
no nulo; un sabor sigue usando únicamente Salón/Depósito de Etapa 6.2.1.

**Compatibilidad total** (sección 16): un producto con CERO presentaciones
activas configuradas sigue funcionando exactamente como antes
(`closedUnits`/`unitsPerHandlingUnit`) -- no se migraron datos ni se
generaron presentaciones automáticas para los ~200 productos ya sembrados;
"sin filas activas" es, por diseño, equivalente a "seguir usando el campo
simple", sin ninguna escritura adicional.

**Mutua exclusión, validada por el backend** (`computeItem`,
`inventory-count.ts`): si un producto tiene ≥1 presentación ACTIVA, el
ítem debe traer `presentations` (no vacío) y `closedUnits` se rechaza; si
no tiene ninguna, es al revés. El backend valida cada entrada: la
presentación existe, está activa y pertenece a ESE producto (rechaza una
presentación de otro producto, una inactiva, o una de otra organización --
las tres caen en el mismo chequeo, ya que todas se resuelven contra el
mapa de presentaciones activas de ESE producto en ESA organización);
cantidad entera no negativa; sin duplicados dentro del mismo ítem. La
conversión (`cantidad × conversionFactorToCanonical`, sumada entre todas
las presentaciones del ítem) la hace SIEMPRE el backend -- nunca el
cliente. Ejemplo del prompt verificado por test: 2 cajas×24 + 1 pack×6 + 3
unidades = 57 unidades canónicas.

**Trazabilidad histórica**: `InventoryCountItem.presentationBreakdown`
(`Json?`, misma migración) guarda un snapshot inmutable de lo tipeado por
presentación (mismo patrón que `AuditLog.beforeValue`/`afterValue`) --
puramente informativo, nunca se vuelve a leer para recalcular nada
(`physicalQuantity` ya trae la suma autoritativa).

**Batching, no N+1**: `getActiveCountingPresentationsForProducts` hace UNA
consulta para todos los productos de un envío (no una por ítem dentro del
`Promise.all` de `computeItem`) -- ver la nota de la sección 8 sobre por
qué esto importó más allá del estilo.

**API nueva**:

- `GET /api/products/:id/counting-presentations` (ADMIN/SHOP_EMPLOYEE/
  DEPOSIT_MANAGER) -- todas (activas e inactivas) de un producto.
- `POST /api/products/:id/counting-presentations` (ADMIN) -- crea.
- `POST /api/products/:id/counting-presentations/:presentationId/deactivate`
  (ADMIN).
- `GET /api/products/counting-presentations` (ADMIN/SHOP_EMPLOYEE/
  DEPOSIT_MANAGER, ruta ESTÁTICA con prioridad sobre `/:id`) -- TODAS las
  presentaciones activas de la organización en una sola llamada, agregada
  específicamente para que la Shop PWA no tenga que hacer una consulta por
  producto contra un catálogo de ~200.

**Shop PWA**: `CountPage.tsx` carga esta lista en lote junto con el
catálogo; un producto con presentaciones activas renderiza un `<input>`
por presentación, rotulado con `unitOfMeasureName` tal cual viene del
backend (nunca "Unidad/Caja/Pack" en el código) -- agregar una presentación
nueva desde el admin aparece sola en la pantalla sin tocar código, mismo
principio que la agrupación dinámica por categoría de Etapa 6.2.1. Cada
campo pide la cantidad FÍSICA de esa presentación (nunca ya multiplicada);
el backend hace la conversión al recibir el envío.

**Idempotencia**: `canonicalItemsForFingerprint` (huella de idempotencia,
`inventory-count.ts`) ahora incluye `presentations` (ordenadas por
`presentationId`) -- sin esto, dos envíos con la MISMA `idempotencyKey`
pero presentaciones DISTINTAS para un producto habrían sido indistinguibles
para la reconsulta de idempotencia.

## 6. Migraciones nuevas

Una única migración, puramente aditiva:

- `20260912150000_product_counting_presentations_etapa6_2_2` -- crea
  `product_counting_presentation` (con sus índices/uniques/FKs/CHECK) y
  agrega `inventory_count_item.presentation_breakdown` (`JSONB`,
  nullable). Ninguna migración histórica se modificó (en particular,
  `20260911120000_price_costs_diff_resolution_etapa6_2` y
  `20260912090000_deposito_closed_units_etapa6_2_1` quedaron intactas).
  Verificado sin drift: las 13 migraciones aplicadas en orden desde una
  base vacía (`sistemagrido_scratch`) dan `prisma migrate diff --exit-code`
  = "No difference detected" contra el schema final.

**Staging**: esta migración debe aplicarse a mano con
`npx prisma migrate deploy` apuntando a `DATABASE_URL`/`DIRECT_URL` de
Supabase ANTES de desplegar este código (junto con cualquier migración
previa de Etapa 6.2/6.2.1 que todavía no se haya aplicado ahí). No se
reintrodujo ningún `migrate:deploy` automático en el build de Render.

## 7. Fragilidad pre-existente detectada (documentada, no corregida)

Durante el desarrollo de esta etapa se detectó (no se introdujo) una
fragilidad latente en `apps/api/src/plugins/prisma.ts`: `onClose` llama a
`prisma.$disconnect()` sobre el cliente COMPARTIDO de todo el proceso
(`@sistema-grido/db`), y CADA test hace `app.close()` en su `afterEach` --
es decir, el cliente compartido se desconecta después de literalmente cada
test, dependiendo de la reconexión perezosa de Prisma para seguir
funcionando. Normalmente esto "simplemente funciona", pero una
implementación intermedia (no la final) de la búsqueda de presentaciones
que hacía una consulta POR ÍTEM en vez de en lote duplicó el volumen de
queries de los tests de conteo y expuso esta fragilidad como fallos
deterministas ("Engine is not yet connected"). La corrección real fue la
implementación en lote (que además es objetivamente mejor, no sólo un
parche), no tocar `plugins/prisma.ts` -- ese archivo queda fuera del
alcance de esta etapa, pero vale documentarlo: un aumento futuro
significativo del volumen de queries por test podría volver a exponer la
misma fragilidad.

## 8. Qué NO cambió (preservado íntegramente)

Todo lo de Etapa 6.2/6.2.1: `PriceListImport`/`PriceReference`/
`PriceValue`/mapeos, la regla del 25%, la mecánica Salón/Depósito de
sabores, el cierre semanal general, los snapshots, la auditoría
transaccional, la idempotencia y concurrencia del ledger, el aislamiento
multi-tenant. No se tocó nada de Caja semanal, Mercado Pago, conciliación,
pedidos, remitos, reparto, recepción, fábrica, Store/Express, FIFO, IA,
predicciones ni clima -- fuera de alcance explícito, reafirmado.

## 9. Limitaciones reales que siguen pendientes (documentadas, no inventadas)

- No existe una pantalla dedicada en admin-web para gestionar
  presentaciones de conteo (crear/desactivar) -- las rutas CRUD existen y
  están probadas, pero el único consumidor de escritura hoy sería una
  llamada directa a la API o una futura pantalla de catálogo extendida.
  Se dejó así deliberadamente: no formaba parte de lo pedido explícitamente
  y agregar una pantalla nueva no era necesario para que el flujo real
  (Shop PWA contando por presentación) funcione de punta a punta.
- La detección de "universo obligatorio" no distingue por ubicación (no
  existe ese concepto en el catálogo) -- un producto activo de la
  organización es obligatorio para CUALQUIER heladería que cuente esa
  semana, aunque en la práctica ese producto nunca se venda ahí. Es una
  limitación heredada del modelo de catálogo, no introducida por esta
  etapa -- documentada en la sección 2 de este archivo como una decisión
  explícita, extensible si en el futuro aparece una relación
  producto-ubicación real.
- No existe un único test E2E automatizado que ejecute el flujo completo
  descrito en Etapa 6.2 sección 23 incorporando además las 4 correcciones
  de esta etapa -- sigue siendo un procedimiento documentado, no una
  prueba automatizada. No formaba parte del alcance de esta corrección.
- `apps/admin-web/src/pages/WeeklyClosingPage.tsx` no tiene ningún archivo
  de test propio (gap heredado, previo a esta etapa -- de las 8 páginas de
  admin-web con cobertura, ésta nunca la tuvo). El bloque nuevo "Diferencias
  pendientes de resolver" agregado ahí (sección 3 de este archivo) sigue
  exactamente el mismo patrón ya usado, campo por campo, para "Costos
  faltantes" -- verificado por lectura de código y por `typecheck`/`build`,
  pero sin un test de React Testing Library dedicado. Cerrar este gap
  (para esta sección y para el resto de la pantalla) es un trabajo aparte,
  más allá de lo que esta corrección puntual necesitaba.

## 10. Tests / calidad

Ver el reporte de entrega para los números finales de tests/lint/format/
typecheck/build de esta etapa (backend + admin-web + Shop PWA + regresión
completa del resto del monorepo).
