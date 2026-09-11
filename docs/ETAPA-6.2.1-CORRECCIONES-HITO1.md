# ETAPA 6.2.1 — Correcciones finales del Hito 1

Versión: 1.0 · Rama: `claude/etapa-6-cierre-semanal` · HEAD auditado de
Etapa 6.2: `9d73bc79908f10e891e6dc925c2e9222543e042a`

Esta NO es una etapa funcional nueva: corrige gaps encontrados en la
auditoría de Etapa 6.2 (`docs/ETAPA-6.2-CIERRE-INTEGRAL.md`, especialmente su
sección "Pendiente/limitaciones documentadas") para dejar el Hito 1
realmente en condiciones de una auditoría integral final. No se avanza a
Etapa 7 ni a Etapa 8. No se rehace nada de Etapa 6.2 que ya estaba correcto
— toda la infraestructura de precios/costos, mapeo, regla del 25%,
resolución de diferencias, tipeo, valorización, cierre general, snapshots,
auditoría e idempotencia de Etapa 6.2 se preserva íntegramente (sección 12
del prompt de 6.2.1).

## 1. Qué corrige esta etapa (mapa rápido)

| #   | Gap de la auditoría                                                      | Sección del prompt | Estado                                  |
| --- | ------------------------------------------------------------------------ | ------------------ | --------------------------------------- |
| 1   | Shop PWA nunca adaptada a las planillas reales (BLOCKER)                 | 1-8, 13, 14        | Corregido                               |
| 2   | Valorización usaba "ahora" en vez del `periodEnd` del período cerrado    | 9                  | Corregido                               |
| 3   | Faltaba test de atomicidad observable de `confirmWeeklyClosingReview`    | 10                 | Corregido                               |
| 4   | Faltaba validación/documentación explícita del stock en `Location` DEPOT | 11                 | Corregido (sin cambios de arquitectura) |

## 2. Shop PWA: rediseño del conteo físico semanal

`apps/shop-pwa/src/pages/CountPage.tsx` se reconstruyó por completo (ver
`git show` de este commit para el detalle línea por línea). Principios de
diseño, todos verificables contra el código:

- **Agrupación dinámica por categoría**: los productos se agrupan por
  `Product.categoryName` (dato del catálogo, Etapa 2), nunca por una lista
  fija en el código. Un producto con una categoría inventada en un test
  (`"Categoría Inventada XYZ"`, ver `CountPage.test.tsx`) aparece agrupado
  correctamente sin tocar el código — es la prueba directa de que nada está
  hardcodeado. Los ejemplos de familias de las planillas reales (Térmicos,
  Juguetes, Sabores, Postres, Baldes, Bombones, Sin TACC, Congelados) son
  simplemente valores que hoy existen en `Category.name`, nunca una lista
  cerrada en el frontend.
- **Presentación por producto**, siempre derivada de
  `unitOfMeasureName`/`unitsPerHandlingUnit`/`flavorId` (nunca de comparar
  nombres de producto/categoría por texto):
  - Siempre un campo "Cerrados (`unitOfMeasureName`)".
  - Un campo "Sueltos" sólo cuando `unitsPerHandlingUnit > 1` o el producto
    es un sabor — evita un campo "sueltos" sin sentido para un producto cuya
    unidad de manejo YA es la unidad mínima (ej. un insumo contado en
    "Unidad", `unitsPerHandlingUnit = 1`, sin sabor).
  - La fracción estimada (`OPEN_CONTAINER_FRACTIONS`, sin cambios desde
    Etapa 4) sólo para sabores con `openUnits > 0` -- igual que antes.
- **Sabores: mecánica Salón/Depósito** (secciones 2/3/4 del prompt,
  CONFIRMADO por las planillas físicas reales): se implementó extendiendo el
  modelo EXISTENTE, nunca un modelo paralelo de inventario de helado --
  `InventoryCountItem` ganó una columna nueva y puramente aditiva,
  `depositoClosedUnits` (migración
  `20260912090000_deposito_closed_units_etapa6_2_1`), que sólo se acepta
  para productos sabor (`Product.flavorId` no nulo; el backend rechaza con
  400 si se envía para cualquier otro producto -- ver `computeItem` en
  `apps/api/src/services/inventory-count.ts`). "Salón - cerrada" +
  "Salón - abierta"/fracción son los campos `closedUnits`/`openUnits`/
  `openFraction` YA existentes desde Etapa 4 (sin cambios); "Depósito" es el
  campo nuevo. Las tres cantidades se suman a `physicalQuantity` con el
  MISMO mecanismo de conversión (`unitsPerHandlingUnit`), porque
  físicamente están en la MISMA `Location` (la heladería) -- el "depósito"
  de la planilla es la cámara/storage PROPIO de esa heladería, no una
  `Location` de tipo `DEPOT` separada. Nunca se inventó una fracción nueva
  para latas del depósito: son siempre latas CERRADAS, igual que
  `closedUnits`.
- **Conteo ciego preservado**: la pantalla de conteo (y la de reconteo)
  nunca llaman a ningún endpoint que devuelva `theoreticalQuantity`/
  `difference` mientras se está contando -- sólo se conocen después de
  `POST /api/shop/counts`, exactamente igual que desde Etapa 4. Verificado
  con tests explícitos en ambas pantallas (conteo y reconteo).
- **Autoguardado/IndexedDB**: se preservó `countDraftStore.ts` sin ningún
  cambio de esquema/versión de IndexedDB -- `InventoryCountDraftItem` ganó
  el campo opcional `depositoClosedUnits`, que entra en el mismo objeto ya
  persistido sin requerir una migración de base local. El borrador sigue
  sin borrarse hasta una respuesta 2xx real del servidor, y la
  `idempotencyKey` se sigue generando una sola vez por borrador y
  reutilizándose en cada reintento.
- **Reconteo**: mismo mecanismo de una sola ronda adicional de Etapa 4,
  ahora mostrando también el campo "Depósito" cuando corresponde, y sin
  revelar nunca la cantidad teórica ni un "objetivo" que sesgue el segundo
  conteo -- sólo se listan los productos marcados `needsRecount` (la regla
  del 25% de Etapa 6.2 sigue siendo la única fuente de esa marca, sin ningún
  sistema paralelo).
- **FECHA/COLABORADOR**: siguen derivándose de la sesión (`weekStart`
  calculado localmente, colaborador del usuario autenticado) -- nunca
  pedidos manualmente.

Cobertura de tests nueva/extendida: `apps/shop-pwa/src/pages/CountPage.test.tsx`
(comportamental, no snapshots) -- agrupación dinámica con una categoría
inventada, presentación condicional por producto, mecánica Salón/Depósito
de un sabor, conteo ciego en ambas pantallas, envío sin multiplicación
cliente-side, ítem de sabor con SÓLO `depositoClosedUnits` (sin nada en
Salón) igual es enviable, autoguardado sobrevive a un remount simulado,
reintento tras corte de red reutiliza la misma `idempotencyKey`, flujo
`RECOUNT_REQUIRED` completo, y que cambiar de categoría no pierde lo ya
tipeado en otra.

## 3. Valorización: costo vigente al `periodEnd`, no al momento del cierre

**El bug real que esto corrige**: Etapa 6.2 resolvía el costo vigente contra
`new Date()` -- el instante en que el checklist se consulta o el ADMIN
ejecuta `close`. Si un cierre se hacía tarde (ej. la semana 01/09..07/09 se
cierra recién el 10/09) y un costo nuevo entraba en vigencia el 09/09 (ya
después del período, pero antes del clic de cierre), ese costo NUEVO se
congelaba en el snapshot histórico -- exactamente lo que la sección 10 de
Etapa 6.2 dice que nunca debe pasar ("el momento administrativo del cierre
no debe alterar la valorización histórica del período").

**La corrección** (`apps/api/src/services/weekly-closing.ts`,
`computeChecklist`/`closeWeeklyClosing`): `asOfDate` pasa a ser siempre
`closing.periodEnd` -- el domingo del período que se está cerrando, columna
fija de ese `WeeklyClosing` -- en vez de `new Date()`, tanto en el chequeo
informativo del checklist como en el chequeo AUTORITATIVO dentro de la
transacción de `close` (los dos deben predecir/producir el mismo número).
`periodEnd` y `PriceValue.effectiveFrom` son ambos `@db.Date` (fecha pura,
sin hora ni huso horario -- ver el comentario de `PriceValue` en
`schema.prisma`), así que la comparación es un simple "mismo día calendario
o antes", sin ninguna conversión de zona horaria que pudiera introducir un
error de un día.

Efecto práctico: un costo con `effectiveFrom` DENTRO de la semana cerrada
(ej. miércoles) sí aplica a esa semana; uno con `effectiveFrom` el día
POSTERIOR al `periodEnd` (el lunes siguiente) nunca aplica, sin importar
cuándo el ADMIN haga clic en cerrar; reabrir y recerrar usa el MISMO
`periodEnd`, así que nunca puede "colarse" hacia adelante un costo que entró
en vigencia después de la semana, sin importar cuántas veces se recierre.

Tests nuevos en `apps/api/src/routes/weekly-closing.test.ts` (describe
`Etapa 6.2 -- valorización...`): un costo que entra en vigencia el día
posterior al `periodEnd` nunca se usa aunque ya exista en la base al momento
de cerrar; un costo que entra en vigencia DENTRO de la semana sí se usa;
reabrir + importar un costo con vigencia posterior al `periodEnd` + recerrar
reproduce EXACTAMENTE el mismo costo que la primera revisión.

## 4. Auditoría: test de atomicidad observable de `confirmWeeklyClosingReview`

Etapa 6.2 ya había corregido `confirmWeeklyClosingReview` para ejecutar el
cambio de estado y su `AuditLog` dentro de la MISMA transacción
(`audit.logTx`), pero no existía un test que demostrara el rollback de
forma observable -- sólo que `logTx` se llamaba.

Test nuevo (`apps/api/src/routes/weekly-closing.test.ts`, describe
`Etapa 6.2.1 -- atomicidad de la auditoría...`): mismo patrón ya establecido
en el TEST C de `closeWeeklyClosing` (un `Proxy` sobre el cliente real de
Prisma que intercepta ÚNICAMENTE `tx.auditLog.create` dentro de la
transacción para forzar que falle, dejando todo lo demás -- el resto de
Prisma, el propio `updateMany` -- corriendo contra Postgres real). Se llama
`confirmWeeklyClosingReview` directamente con ese cliente roto, se espera
que rechace, y se verifica CONTRA EL CLIENTE REAL (no el roto) que
`reviewConfirmedById`/`reviewConfirmedAt` siguen `null` y que no existe
ningún `AuditLog` de esa acción -- es decir, que el `UPDATE` de estado NO
quedó aplicado, no sólo que la promesa rechazó. Por último se confirma que,
con el cliente real, la operación vuelve a funcionar normalmente (no quedó
en un estado intermedio corrupto).

## 5. Depósito/cámara: validación mínima (sin desarrollar Etapa 8)

No se implementó nada de Etapa 8 (pedidos, remitos, reparto, recepción,
Store, Express, transferencias avanzadas) -- eso sigue explícitamente fuera
de alcance.

Se verificó que el modelo YA vigente desde Etapa 3 representa correctamente
el stock de una `Location` de tipo `DEPOT` sin ningún cambio de código
productivo: el ledger (`InventoryMovement`) nunca trató a `DEPOT` como un
caso especial (`LocationType` es una enumeración genérica desde Etapa 0,
nunca hardcodeada como "depósito"). De hecho, `apps/api/src/routes/inventory.test.ts`
(Etapa 3) ya ejercitaba una `Location` DEPOT como una de sus dos ubicaciones
principales a lo largo de TODO ese archivo, sin ningún trato diferencial.

Se agregó `apps/api/src/routes/deposit-stock.test.ts`, un archivo dedicado y
mínimo que concentra en un solo lugar la demostración explícita de los 5
puntos pedidos: (1) una `Location` DEPOT recibe movimientos de inventario
por la misma API genérica; (2) su stock se DERIVA del ledger (nunca de un
campo de saldo aparte); (3) ese stock puede consultarse por la API genérica
de stock; (4) nunca se mezcla con el stock de una heladería del mismo
producto; (5) el cierre semanal GENERAL de Hito 1 (Etapa 6.2) sigue
dependiendo EXCLUSIVAMENTE de las heladerías (`ICE_CREAM_SHOP`) activas
requeridas -- un `DEPOT` nunca aparece en su lista de ubicaciones
requeridas, aunque tenga movimientos propios.

## 6. Migraciones nuevas

Una única migración, puramente aditiva:

- `20260912090000_deposito_closed_units_etapa6_2_1` -- agrega
  `inventory_count_item.deposito_closed_units` (`INTEGER`, nullable) + un
  `CHECK (deposito_closed_units IS NULL OR deposito_closed_units >= 0)`.
  Ninguna migración histórica se modificó. Verificado sin drift desde una
  base de datos vacía aplicando las 12 migraciones en orden (`prisma migrate
diff` contra el schema final da "empty migration").

**Staging**: esta migración (y, si todavía no se aplicó, la de Etapa 6.2,
`20260911120000_...`) deben aplicarse a mano con `npx prisma migrate
deploy` apuntando a `DATABASE_URL`/`DIRECT_URL` de Supabase ANTES de
desplegar este código -- ver el comentario actualizado en `render.yaml`. No
se reintrodujo ningún `migrate:deploy` automático en el build de Render.

## 7. Qué NO cambió (preservado íntegramente de Etapa 6.2)

`PriceListImport`/`PriceListImportRow`/`PriceReference`/`PriceValue`/
`PriceReferenceProductMapping`, `COST_WITH_TAX`/`SALE_PRICE`, los imports
reales de las listas Excel, los mapeos 1:N, el historial de precios, la
regla del 25% de faltante, la resolución de faltantes/sobrantes,
`InventoryCountTypoCandidate` y su detección por mismo precio de venta +
cantidades compensatorias, el cierre semanal general, los snapshots,
`COUNT_CORRECTION`, la auditoría transaccional, la idempotencia y la
concurrencia de Etapa 6.2 -- ninguno de estos mecanismos se tocó ni se
simplificó para implementar la PWA.

## 8. Limitaciones reales que siguen pendientes (documentadas, no inventadas)

- La mecánica Salón/Depósito de sabores es un diseño razonado a partir del
  texto del prompt y de la descripción escrita de las planillas reales
  (las fotos originales no están disponibles como archivos en este repo,
  sólo la descripción que el cliente ya había dado) -- no se validó pixel a
  pixel contra las fotos físicas. Si al revisarlo el cliente identifica que
  el layout real difiere (ej. más de una columna de "Depósito", o una
  cámara compartida entre heladerías), el modelo aditivo actual
  (`depositoClosedUnits`, un solo entero por ítem) puede necesitar
  ajustarse -- es una extensión menor sobre una base ya congelada, no un
  rediseño.
- Depósito/cámara sigue limitado a "el stock se puede registrar y consultar
  vía el ledger genérico" -- no hay ninguna pantalla dedicada de
  depósito/cámara en admin-web ni en la PWA más allá de las ya existentes
  de Etapa 3 (consulta de stock/movimientos). Esto es exactamente lo que
  pedía la sección 11 del prompt ("si esto ya funciona sin modificar código
  productivo, no agregar arquitectura innecesaria").
- No existe un único test E2E automatizado que ejecute las 20 etapas del
  flujo completo descrito en la sección 23 de Etapa 6.2 -- sigue siendo un
  procedimiento documentado (`docs/ETAPA-6.2-CIERRE-INTEGRAL.md`), no una
  prueba automatizada. No formaba parte del alcance de esta corrección.

## 9. Tests / calidad

Ver el reporte de entrega para los números finales de tests/lint/typecheck/
build de esta etapa (backend + Shop PWA + regresión completa del resto del
monorepo).
