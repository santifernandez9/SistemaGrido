# ETAPA 6.2 — Cierre Integral del Hito 1 / Pilot Readiness

> **Etapa 6.2.1** (`docs/ETAPA-6.2.1-CORRECCIONES-HITO1.md`) corrigió varios
> gaps encontrados en la auditoría de esta etapa -- el más importante, la
> Shop PWA (sección 17), que quedaba explícitamente sin implementar acá.
> Este documento se mantiene como registro histórico del diseño original,
> con banners `>` en cada sección que Etapa 6.2.1 corrigió; para el estado
> ACTUAL de esos puntos, seguí los banners hacia el documento de 6.2.1.

Versión: 1.0 · Rama: `claude/etapa-6-cierre-semanal`

Extiende Etapa 6/6.1 (`docs/ETAPA-6-CIERRE-SEMANAL.md`) sin reabrir ni destruir
ninguna de sus garantías: el ledger (`InventoryMovement`, Etapa 3) sigue siendo
la única fuente de verdad de stock; el `WeeklyClosing` por ubicación sigue
existiendo; la consistencia temporal de la reconciliación (Etapa 6.1) sigue
intacta y con su cobertura de tests preservada.

## 1. Fuentes de verdad de esta etapa

Además del documento del cliente ya usado en etapas anteriores, esta etapa
agrega evidencia REAL nueva, inspeccionada con `openpyxl`/`exceljs` antes de
diseñar nada:

- **`Lista_Precio_Costo.xlsx`**, hoja `"Precio Helacor"` (`A1:N118`, 49 filas
  con contenido real) — lista de COSTOS. Título en B1; encabezado en fila 2
  (`B2` = rótulo de período libre, `C2` = "Precio S/ IVA", `D2` = "Precio C/
  IVA"); luego filas intercaladas de categoría (sólo `B` con texto, ej.
  "GRANEL", "POSTRES") y de producto (`B` = descripción, `C`/`D` = precio,
  algunos como fórmula `=C*1.21`). **Sin código de artículo en ninguna fila**
  — confirmado inspeccionando las 49 filas reales. 36 filas de producto
  reales (el resto, categorías/separadores).
- **`Lista_Valor_venta_de_SEP2026.xlsx`**, hoja `"Precios Grido"` (`A1:F92`,
  92 filas con contenido real) — lista de PRECIOS DE VENTA. Mismo patrón
  (título/encabezado/categoría/producto), un solo precio en `C` (sin
  columna S/IVA). También sin código de artículo. 78 filas de producto
  reales. Una fila real (`C21`) trae un espacio suelto sin descripción —
  particularidad real del archivo, tratada como separador, nunca como error.
- 2 fotos de planillas físicas de conteo semanal usadas hoy por el cliente
  (familias: Térmicos, Juguetes, Sabores, Postres, Baldes, Bombones, Sin
  TACC, Congelados, entre otras) — evidencia de la agrupación real por
  familia y de la mecánica Salón-abierta/Salón-cerrada/Depósito para
  sabores. Usadas para diseñar (no para hardcodear) el modelo de conteo;
  ver sección 16 ("Pendiente") sobre qué de esto NO llegó a implementarse en
  esta entrega.

Ambos archivos se commitearon como fixtures reales de test
(`apps/api/src/test/fixtures/lista-precio-costo-helacor.xlsx` y
`lista-valor-venta-sep2026.xlsx`) — los parsers (`price-list-parser.ts`) y
los tests de importación end-to-end (`price-list.test.ts`) corren contra
estos archivos reales, nunca contra un fixture inventado.

Ninguna de las dos listas trae una columna de vigencia/período estructurada
— el texto "Septiembre 2026"/"Septiembre 2026" es un rótulo libre en una
celda (`rawPeriodLabel`), NUNCA parseado como fecha. La vigencia
(`effectiveFrom`) la indica el ADMIN explícitamente al confirmar el import
(`ConfirmPriceListImportInput`), nunca al subir el archivo ni inferida del
rótulo.

## 2. Modelo histórico de precios/costos

Nuevas entidades (`packages/db/prisma/schema.prisma`, migración
`20260911120000_price_costs_diff_resolution_etapa6_2`):

- **`PriceListImport`** / **`PriceListImportRow`** — mismo patrón que
  `SalesImport`/`SalesImportRow` de Etapa 5: subida idempotente por
  `(organizationId, source, fileHash)`, filas crudas VALID/ERROR,
  confirmación con idempotencia propia (`confirmIdempotencyKey`).
  `source` es `HELACOR_COST_LIST` | `HELACOR_SALE_PRICE_LIST`, cada una
  produce siempre el mismo `priceType` (`PRICE_TYPE_BY_SOURCE`).
- **`PriceReference`** — la referencia ESTABLE de precio/costo, identificada
  por `(organizationId, priceType, label)`. `label` es la descripción EXACTA
  (recortada) de la fuente real, porque ninguno de los dos archivos trae
  código de artículo (sección 9 del prompt). Reimportar el mismo archivo
  reutiliza la MISMA referencia.

  **Limitación documentada** (sección 9/26 del prompt: "documentar en vez de
  inventar"): si Grido cambia la redacción exacta de una etiqueta entre
  listas, este criterio crea una referencia NUEVA en vez de continuar el
  historial de la vieja — nunca corrompe un valor existente (es
  estrictamente aditivo), pero exige que un ADMIN vuelva a confirmar el
  mapeo de la etiqueta nueva. Deliberadamente NO se resuelve con
  coincidencia difusa (similarity matching): el prompt prohíbe explícitamente
  inferir mapeos por similitud textual sin confirmación humana (sección 8).

- **`PriceValue`** — valor histórico de una referencia: `value`,
  `effectiveFrom`, más la trazabilidad de qué import/fila lo generó y quién.
  Nunca se edita ni se borra — un cambio de precio agrega una fila nueva. El
  valor "vigente" de una referencia a una fecha dada es el `PriceValue` con
  la mayor `effectiveFrom <= esa fecha` (`resolveEffectivePricesForProducts`,
  `apps/api/src/services/price-reference-mapping.ts`) — nunca el más
  recientemente importado si su vigencia es posterior a la fecha consultada.
  Único por `(priceReferenceId, effectiveFrom)`: dos archivos que declaren
  vigencias distintas para el mismo día son, por definición, un conflicto
  que el ADMIN debe resolver (ver sección 4), nunca algo que el sistema
  decida solo.
- **`PriceReferenceProductMapping`** — mapeo ADMIN-confirmado entre una
  `PriceReference` y UNO O VARIOS `Product` (sección 8 del prompt: el
  ejemplo textual "Grido 'Palito Frutales' → Palito Frutal
  Frutilla/Limón/Naranja" se probó literalmente en
  `price-list.test.ts`). Nunca se crea sola/automáticamente. A lo sumo UN
  mapeo ACTIVO por `(producto, priceType)` — índice único parcial
  (`WHERE active`) agregado a mano en la migración; el servicio desactiva el
  mapeo anterior en la misma transacción al confirmar uno nuevo.

Tipos implementados (`PriceType`): `COST_WITH_TAX` (exclusivamente el costo
CON IVA — columna "Precio C/ IVA" del archivo real; el S/IVA se conserva
sólo como dato informativo en `PriceListImportRow.rawValueWithoutTax`, nunca
como un `PriceValue` propio, porque ningún RN pide valorizar sin IVA) y
`SALE_PRICE`.

## 3. Importación de listas de precios (`price-list-import.ts`)

Mismo flujo de 3 pasos que Etapa 5: subir → parsear (`price-list-parser.ts`,
exclusivamente contra la estructura real de ambos archivos, sin inventar
columnas) → preview (sólo lectura) → confirmar. Al confirmar
(`confirmPriceListImport`):

1. Se crea/reutiliza `PriceReference` por `(priceType, label)`.
2. Por cada fila VALID se busca un `PriceValue` existente en
   `(referencia, effectiveFrom)`: si coincide el valor, se reutiliza
   (reimportar el mismo archivo, o dos archivos que declaren el mismo
   valor, nunca duplica historial); si el valor DIFIERE, se aborta TODA la
   confirmación (rollback completo) con un mensaje explícito — nunca se
   decide solo cuál de los dos vale.
3. Concurrencia (sección 17 del prompt): dos confirmaciones concurrentes que
   intentan crear la misma `PriceReference`/`PriceValue` chocan contra el
   UNIQUE de Postgres — se aborta la transacción perdedora completa (nunca
   un ajuste parcial) y se pide reintentar; el reintento encuentra la fila
   ya creada y avanza idempotentemente. Test:
   `price-list.test.ts` → "dos subidas CONCURRENTES del mismo archivo... no
   duplican el import" (usa `Promise.all` real contra Postgres, mismo
   patrón que Etapa 3.2).

## 4. Mapeo referencia ↔ catálogo (`price-reference-mapping.ts`)

`resolveEffectivePricesForProducts` es la función central, en LOTE, usada
tanto por la UI de revisión de precios como por `weekly-closing.ts` al
cerrar (dentro de la misma transacción, para que la valorización sea
atómica con el resto del cierre). Nunca infiere un mapeo por similitud
textual — la única forma de crear uno es `POST
/api/price-reference-product-mappings`, siempre con `confirmedById`.

## 5. Reconteo obligatorio por faltante ≥25% (sección 4 del prompt)

`inventory-count.ts`, `exceedsMandatoryShortagePercentage`: regla
PORCENTUAL, CONFIRMADA textualmente por el cliente, que se suma (nunca
reemplaza) al umbral ABSOLUTO opcional ya existente desde Etapa 4.1
(`RECOUNT_THRESHOLD_CLOSED_PRODUCTS`/`_BULK_FLAVOR`, todavía sin valor
confirmado por el cliente, así que sigue sin default). Es el MISMO campo
`needsRecount`/estado `RECOUNT_REQUIRED` disparado por dos condiciones
distintas — nunca un sistema paralelo.

- `= |difference| / theoreticalQuantity >= 0.25`, sólo para FALTANTE
  (`difference < 0`). Un sobrante nunca dispara esta regla, sin importar su
  magnitud (puede seguir dispando el umbral ABSOLUTO si está configurado).
- Maneja teórico cero o negativo SIN dividir por cero/negativo: en ese caso
  el porcentaje no está definido de forma significativa, así que la regla
  simplemente no se activa — el umbral ABSOLUTO configurado (si existe)
  sigue disponible para cubrir ese caso por su cuenta, sin inventar una
  convención de "qué es 25% de un teórico negativo".
- Umbral inclusive (`>=`), verificado con un test exacto al 25%.

Tests: `shop-ops.test.ts`, cuatro casos nuevos (>=25% dispara sin umbral
absoluto configurado, sobrante grande nunca dispara, <25% no dispara, =25%
exacto sí dispara).

## 6. Sobrantes y faltante confirmado (secciones 4/5 del prompt)

Nuevos campos en `InventoryCountItem`: `differenceResolution` (enum
`SHORTAGE_CONFIRMED` | `SURPLUS_RESOLVED`, null mientras está pendiente),
`differenceResolvedById`/`At`/`Note`. Servicio
`inventory-count-resolution.ts`, `resolveInventoryDifference`:

- Un FALTANTE recontado se confirma como `SHORTAGE_CONFIRMED` — el PRIMER
  conteo (`physicalQuantity`/`difference` originales) NUNCA se sobrescribe,
  ni siquiera por el reconteo: el reconteo actualiza esos mismos campos
  (porque es el valor FINAL, no uno adicional) pero la resolución explícita
  es un gesto aparte, auditado, que preserva quién y cuándo lo confirmó.
- Un SOBRANTE nunca se acepta en silencio como diferencia normal — requiere
  el mismo gesto (`SURPLUS_RESOLVED`) antes de considerarse resuelto.
- Sólo se puede resolver una diferencia sobre un conteo COMPLETED (nunca
  mientras está `RECOUNT_REQUIRED`, porque las diferencias todavía no son
  finales). `kind` debe ser consistente con el signo de la diferencia — el
  backend lo valida, nunca lo infiere el cliente. Resolver dos veces es un
  409 controlado, no un error silencioso ni una sobrescritura.

Auditado: `SHOP_COUNT_SHORTAGE_CONFIRMED` / `SHOP_COUNT_SURPLUS_RESOLVED`.

## 7. Detección de posible error de tipeo (sección 6 del prompt)

Nueva tabla `InventoryCountTypoCandidate`. `detectAndPersistTypoCandidates`
(`inventory-count.ts`) se llama DENTRO de la misma transacción que deja un
`InventoryCount` en `COMPLETED` (directo o tras reconteo) — nunca antes, para
trabajar siempre sobre las diferencias FINALES:

1. Toma todos los ítems con faltante (`difference < 0`) y sobrante
   (`difference > 0`) del conteo.
2. Para cada combinación (faltante, sobrante) de productos DISTINTOS: si
   `|faltante| == sobrante` (compensación EXACTA) Y ambos resuelven el MISMO
   `SALE_PRICE` vigente (nunca costo), se crea un
   `InventoryCountTypoCandidate` con `status = PENDING`.
3. Genera TODAS las combinaciones que califiquen — soporta múltiples
   candidatos ambiguos sin decidir cuál es "el correcto" (test: "un mismo
   faltante puede generar VARIOS candidatos ambiguos").
4. Si a alguno de los dos productos le falta el `SALE_PRICE` (sin mapeo o
   sin `PriceValue` vigente), NUNCA se sugiere nada — no se inventa un
   precio para comparar.

`resolveTypoCandidate` (`inventory-count-resolution.ts`): un ADMIN confirma
o rechaza la sugerencia (`CONFIRMED`/`REJECTED`), con nota opcional.
**SIEMPRE documentación pura** — verificado con un test explícito que
cuenta `InventoryMovement` antes/después de confirmar un candidato: nunca
genera ni modifica `Sale`/`InventoryMovement`. Auditado:
`SHOP_COUNT_TYPO_CANDIDATE_CONFIRMED`/`_REJECTED`.

Ejemplo real del prompt ("Posible error de tipeo entre Casatta y
Almendrado...") probado literalmente en
`inventory-count-resolution.test.ts`.

## 8. Valorización del stock en el cierre (secciones 10/11 del prompt)

`InventorySnapshotItem` gana tres columnas: `unitCostWithTax`, `totalValue`,
`priceValueId` (FK al `PriceValue` EXACTO usado). `closeWeeklyClosing`
(`weekly-closing.ts`), dentro de la transacción de cierre:

> **Corrección de Etapa 6.2.1** (`docs/ETAPA-6.2.1-CORRECCIONES-HITO1.md`,
> sección 3): `asOfDate` YA NO es `new Date()` -- pasó a ser
> `closing.periodEnd`, para que un cierre hecho tarde nunca congele un
> costo que entró en vigencia después del período. El resto de esta
> sección (congelado permanente, `priceValueId`, Decimal end-to-end) sigue
> exactamente igual.

1. Captura `asOfDate = closing.periodEnd` UNA sola vez (Etapa 6.2.1:
   antes era `new Date()` -- ver el banner de arriba).
2. Chequeo AUTORITATIVO de costos faltantes (`computeMissingCostProducts`,
   con `tx`) — repite, pero DENTRO de la transacción, el mismo chequeo que
   ya se muestra como adelanto informativo en el checklist (fuera de
   transacción, con `fastify.db`), para que sea consistente incluso si un
   mapeo se desactivó entre el chequeo rápido y el cierre real (sección 17
   del prompt).
3. Resuelve `COST_WITH_TAX` para todos los productos con
   `resolveEffectivePricesForProducts(tx, ...)`.
4. Por producto: si `quantityReal == 0`, `unitCostWithTax`/`totalValue`
   quedan `null` (nunca costo=0 inventado — 0 unidades no necesitan costo
   para valer $0). Si no, `totalValue = quantityReal * unitCostWithTax`
   (`Prisma.Decimal` de punta a punta, nunca `number`).

**Congelado para siempre**: una vez `CLOSED`, `loadPersistedItems` lee estas
tres columnas directamente de `InventorySnapshotItem` — nunca las
recalcula. Un `PriceValue` importado DESPUÉS de un cierre, aunque tenga una
`effectiveFrom` anterior a "hoy", NUNCA cambia el `unitCostWithTax`/
`totalValue` ya persistidos. Verificado con el ejemplo EXACTO del prompt
(costo $100 → $1.200 congelado; sube a $999 después; el cierre sigue
mostrando $1.200) en `weekly-closing.test.ts`.

## 9. Falta de costo — bloqueo controlado (sección 11 del prompt)

`WeeklyClosingChecklist.missingCostProducts` (poblado por
`computeMissingCostProducts`, fuera de transacción, contra `fastify.db`)
lista cada producto con `quantityReal != 0` sin costo vigente resoluble
(`reason: 'NO_MAPPING' | 'NO_VIGENT_VALUE'`). No vacío ⇒ `canClose = false`
Y, si se intenta cerrar de todos modos, el chequeo AUTORITATIVO dentro de la
transacción (sección 8, punto 2) lo bloquea igual con un 409 explícito
nombrando los productos — nunca se cierra una semana con valuaciones
incompletas como si estuvieran completas. Test dedicado en
`weekly-closing.test.ts`: bloqueo → se resuelve el mapeo/costo → reintento
exitoso, con `unitCostWithTax`/`totalValue` correctos.

## 10. Cierre semanal general (sección 12 del prompt)

Nueva entidad `GeneralWeeklyClosing` (`general-weekly-closing.ts`) — agrega
la vista/estado a NIVEL SEMANA sobre los `WeeklyClosing` por ubicación de
Etapa 6/6.1, que siguen existiendo intactos para la trazabilidad individual.
"Heladerías requeridas" = `Location.active && Location.type ===
'ICE_CREAM_SHOP'` de la organización — **nunca una lista hardcodeada**
(evita que una sola heladería cerrada haga parecer cerrada toda la semana,
y evita que una heladería dada de baja bloquee para siempre un cierre
general).

- `GET /api/weekly-closings/general?periodStart=...` — estado agregado:
  para cada heladería requerida, su `WeeklyClosing` (si existe) y si está
  `ready` (== `CLOSED`; `REOPENED` cuenta como "no lista" hasta volver a
  cerrar). `canClose = todas ready`.
- `POST /api/weekly-closings/general/close` — sólo si `canClose`, mismo
  patrón de idempotencia endurecida (clave + fingerprint + UNIQUE +
  resolución de carrera) que el resto del proyecto desde Etapa 3.1.
- Reabrir UNA heladería después del cierre general la vuelve a marcar "no
  lista" en la vista, pero el registro `GeneralWeeklyClosing` ya cerrado
  se CONSERVA como trazabilidad histórica (nunca se borra retroactivamente)
  — test dedicado en `general-weekly-closing.test.ts`.

## 11. Depósito en Hito 1 (sección 13 del prompt)

> **Corrección de Etapa 6.2.1** (`docs/ETAPA-6.2.1-CORRECCIONES-HITO1.md`,
> sección 5): se agregó `apps/api/src/routes/deposit-stock.test.ts`, una
> demostración/prueba explícita y dedicada de que el ledger genérico ya
> soporta correctamente una `Location` DEPOT -- sin ningún cambio de
> arquitectura, exactamente como esta sección ya predecía. Sigue sin
> construirse ninguna pantalla/flujo NUEVO de depósito (pedidos, remitos,
> reparto, etc. siguen fuera de alcance, Etapa 8).

**NO se implementó nada nuevo para depósito/cámara en esta entrega.** El
ledger de Etapa 3 ya permite registrar/consultar stock de una ubicación
`DEPOT` como cualquier otra (`InventoryMovement.locationId`), así que
técnicamente "existe" una forma coherente de representar mercadería en
cámara — pero no se construyó ninguna pantalla, regla o flujo NUEVO
específico de depósito en Etapa 6.2 (pedidos, reparto, remitos, recepción,
transferencias, Store/Express siguen explícitamente fuera de alcance,
sección 24). Si el cliente necesita contar/cerrar semanalmente también el
depósito, hoy podría hacerlo con el mismo mecanismo de `WeeklyClosing` que
usa una heladería (un `Location` tipo `DEPOT` puede tener su propio
`InventoryCount`/`WeeklyClosing`), pero **esto no se verificó ni se
documentó como flujo soportado en esta etapa** — queda como limitación
documentada, no como funcionalidad entregada.

## 12. Correcciones de stock

Sin cambios de diseño respecto de Etapa 6.1: las correcciones del cierre
siguen siendo movimientos `COUNT_CORRECTION` del ledger, nunca un
`UPDATE stock = ...`; el mecanismo de "a lo sumo un `COUNT_CORRECTION` por
(cierre, producto)" (índice único parcial, migración de Etapa 6.1) sigue
intacto y su cobertura de tests (TEST A-E) sigue pasando sin
modificaciones de fondo.

## 13. Auditoría

Nuevas acciones auditadas (todas con `module` propio, nunca reutilizando
`SALES_IMPORT`/`WEEKLY_CLOSING` de forma ambigua):

- `PRICE_LIST_IMPORT_UPLOADED` / `_ALREADY_IMPORTED` / `_FAILED` /
  `_CONFIRMED` (`module: 'PRICE_LIST'`)
- `PRICE_REFERENCE_PRODUCT_MAPPING_CONFIRMED` / `_DEACTIVATED`
  (`module: 'PRICE_LIST'`)
- `SHOP_COUNT_SHORTAGE_CONFIRMED` / `SHOP_COUNT_SURPLUS_RESOLVED`
  (`module: 'SHOP_OPS'`)
- `SHOP_COUNT_TYPO_CANDIDATE_CONFIRMED` / `_REJECTED`
  (`module: 'SHOP_OPS'`)
- `GENERAL_WEEKLY_CLOSING_CLOSED` (`module: 'WEEKLY_CLOSING'`)

**Corrección de atomicidad (sección 16 del prompt, revisión explícitamente
pedida):** `confirmWeeklyClosingReview` usaba `fastify.audit.log()` (NO
transaccional) DESPUÉS del `updateMany` de estado — una ventana real donde
la revisión podía quedar confirmada sin su auditoría, o el proceso podía
caer entre ambas líneas. Corregido: el `updateMany` y el `audit.logTx`
ahora viven dentro de la MISMA transacción (`fastify.db.$transaction`).
Todas las operaciones sensibles nuevas de esta etapa (import de precios,
mapeo, confirmación de faltante/sobrante, resolución de tipeo, cierre
general) usan `audit.logTx` dentro de su propia transacción desde el
diseño inicial, nunca `audit.log` suelto.

> **Corrección de Etapa 6.2.1** (`docs/ETAPA-6.2.1-CORRECCIONES-HITO1.md`,
> sección 4): esta corrección de atomicidad quedó sin un test que la
> probara de forma OBSERVABLE (más allá de que `logTx` se llamara). Se
> agregó ese test -- fuerza el fallo real del `INSERT` de auditoría dentro
> de la transacción y verifica, contra Postgres real, que el `UPDATE` de
> estado también hizo rollback.

## 14. Concurrencia e idempotencia

Adicional a lo ya cubierto en Etapa 3.1/3.2/4.1/5.1/5.2/6/6.1 (que sigue
intacto y probado): mismo archivo de precios importado concurrentemente
(`price-list.test.ts`), colisión de creación concurrente de
`PriceReference`/`PriceValue` (manejada explícitamente en el `catch` de
`confirmPriceListImport`, aborta y pide reintentar), cierre general
idempotente. Los escenarios de concurrencia de Etapa 6.1 (cierre
concurrente, movimiento concurrente durante el cierre) se re-verificaron
íntegros bajo el nuevo requisito de costo (los fixtures de
`weekly-closing.test.ts` ahora seedean costo para A/B/C antes de cada
test) — ningún test de Etapa 6.1 cambió su aserción de fondo, sólo su
setup.

## 15. Migraciones

Una única migración nueva, puramente ADITIVA:
`packages/db/prisma/migrations/20260911120000_price_costs_diff_resolution_etapa6_2/`.
Agrega 6 enums, 6 tablas nuevas (`price_list_import`,
`price_list_import_row`, `price_reference`, `price_value`,
`price_reference_product_mapping`, `inventory_count_typo_candidate`,
`general_weekly_closing`), columnas nuevas en `inventory_count_item`
(resolución de diferencia) e `inventory_snapshot_item` (valorización), más
CHECK constraints e índices únicos parciales a mano (mismo patrón que
Etapa 2/3/4/6/6.1: Prisma no expresa CHECK/índices parciales
declarativamente). Ninguna migración histórica se modificó. Verificado
aplicando las 11 migraciones desde una base en blanco
(`sistemagrido_scratch`) y confirmando `prisma migrate diff` vacío contra
el schema final (sin drift).

## 16. UI Admin (sección 18 del prompt)

Nueva pantalla **Precios** (`/precios`): subir listas de costo/venta, ver
preview (reconocidos/nuevos/sin mapear), confirmar con `effectiveFrom`
explícito, revisar referencias y su valor vigente, crear/desactivar
mapeos referencia↔producto (soporta N productos por referencia).

**Cierre semanal** (`/cierre-semanal`, extendida): costo unitario y valor
total por producto, productos sin costo bloqueando el cierre (con motivo),
diferencias pendientes de revisión con botones de confirmación de
faltante/sobrante, candidatos de posible error de tipeo con
confirmar/rechazar, y un panel de cierre semanal GENERAL (estado por
heladería + botón de cierre general).

## 17. Shop PWA (sección 3/19 del prompt) — implementado en Etapa 6.2.1

> **Corrección de Etapa 6.2.1** (`docs/ETAPA-6.2.1-CORRECCIONES-HITO1.md`,
> sección 2): este era el BLOCKER principal señalado por la auditoría de
> Etapa 6.2. Se implementó por completo -- agrupación dinámica por
> categoría, presentación por producto, mecánica Salón/Depósito para
> sabores (columna nueva y aditiva `InventoryCountItem.depositoClosedUnits`,
> migración `20260912090000_...`), conteo ciego y autoguardado preservados.
> El resto de esta sección queda como registro histórico de lo que NO
> estaba hecho al cierre de Etapa 6.2.

**Limitación documentada, no funcionalidad entregada [ESTADO ANTERIOR A
ETAPA 6.2.1 -- ver el banner de arriba].** El pedido incluía
reestructurar la pantalla de conteo de la Shop PWA para agrupar por
familia/categoría del catálogo (no hardcodeada), soportar presentaciones
reales por producto, distinguir Salón/Depósito, y la mecánica de sabores
Salón-abierta/Salón-cerrada + Depósito observada en las planillas físicas
reales. **Nada de esto se construyó en esta sesión** — el backend de
conteo (Etapa 4) y sus extensiones de esta etapa (25% obligatorio,
resolución de diferencias, tipeo) son independientes de cómo la PWA agrupa
visualmente los productos, así que backend y PWA no quedaron acoplados por
esta omisión, pero la experiencia de captura real (agrupación por familia,
mecánica de sabores) sigue siendo la de Etapa 4, sin los cambios pedidos
acá. Se documenta como bloqueante para considerar el Hito 1 completo en su
alcance total (ver sección 20).

## 18. Tests obligatorios (sección 21 del prompt)

| #   | Caso                                                                  | Archivo / test                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Faltante <25% no dispara reconteo                                     | `shop-ops.test.ts`                                                                                                                                                                                                                                                    |
| B   | Faltante =25% dispara (inclusive)                                     | `shop-ops.test.ts`                                                                                                                                                                                                                                                    |
| C   | Faltante >25% dispara                                                 | `shop-ops.test.ts`                                                                                                                                                                                                                                                    |
| D   | Reconteo confirma faltante (FALTANTE CONFIRMADO, preserva 1er conteo) | `inventory-count-resolution.test.ts`                                                                                                                                                                                                                                  |
| E   | Sobrante fuerza revisión (nunca se acepta en silencio)                | `inventory-count-resolution.test.ts`                                                                                                                                                                                                                                  |
| F   | Match exacto de tipeo (mismo precio, compensación exacta)             | `inventory-count-resolution.test.ts`                                                                                                                                                                                                                                  |
| G   | Cantidades que no compensan → sin sugerencia                          | `inventory-count-resolution.test.ts`                                                                                                                                                                                                                                  |
| H   | Mismo precio sin compensación → sin sugerencia                        | `inventory-count-resolution.test.ts`                                                                                                                                                                                                                                  |
| I   | Compensación con precios distintos → sin sugerencia                   | `inventory-count-resolution.test.ts`                                                                                                                                                                                                                                  |
| J   | Múltiples candidatos ambiguos                                         | `inventory-count-resolution.test.ts`                                                                                                                                                                                                                                  |
| K   | Import real de costos (archivo real, 36 filas)                        | `price-list.test.ts`, `price-list-parser.test.ts`                                                                                                                                                                                                                     |
| L   | Import real de precios de venta (archivo real, 78 filas)              | `price-list.test.ts`, `price-list-parser.test.ts`                                                                                                                                                                                                                     |
| M   | Mapeo 1 referencia → N productos                                      | `price-list.test.ts`                                                                                                                                                                                                                                                  |
| N   | Producto sin mapeo → resolución null                                  | `price-list.test.ts`                                                                                                                                                                                                                                                  |
| O   | Producto sin costo → bloqueo controlado del cierre                    | `weekly-closing.test.ts`                                                                                                                                                                                                                                              |
| P   | Snapshot congela el costo                                             | `weekly-closing.test.ts`                                                                                                                                                                                                                                              |
| Q   | Nueva lista de precios no altera un cierre anterior                   | `weekly-closing.test.ts`                                                                                                                                                                                                                                              |
| R   | Cierre general bloqueado si falta una heladería                       | `general-weekly-closing.test.ts`                                                                                                                                                                                                                                      |
| S   | Cierre general habilitado cuando todas están listas                   | `general-weekly-closing.test.ts`                                                                                                                                                                                                                                      |
| T   | Reapertura preserva el snapshot anterior                              | `weekly-closing.test.ts` (Etapa 6, sin cambios)                                                                                                                                                                                                                       |
| U   | Movimiento posterior al conteo no altera la diferencia congelada      | `weekly-closing.test.ts` (Etapa 6.1, TEST A/E)                                                                                                                                                                                                                        |
| V   | `COUNT_CORRECTION` no se duplica                                      | `weekly-closing.test.ts` (Etapa 6.1, TEST B/D)                                                                                                                                                                                                                        |
| W   | Teórico negativo                                                      | `weekly-closing.test.ts` (Etapa 6, sin cambios)                                                                                                                                                                                                                       |
| X   | Concurrencia de cierre                                                | `weekly-closing.test.ts` (Etapa 6.1, TEST D)                                                                                                                                                                                                                          |
| Y   | Concurrencia de import                                                | `price-list.test.ts`                                                                                                                                                                                                                                                  |
| Z   | Auditoría transaccional                                               | Corrección aplicada en `confirmWeeklyClosingReview` (sección 13); no tiene un test dedicado que fuerce la falla a mitad de transacción — cubierto por revisión de código, no por un test de interrupción forzada. **Gap documentado explícitamente**, ver sección 20. |

Suite completa del backend: **320/320 tests verdes** (285 preexistentes +
35 nuevos de esta etapa), `lint`/`format:check`/`typecheck` limpios.

## 19. Staging / Pilot readiness (sección 22 del prompt)

**Migraciones requeridas contra Supabase Postgres** (proyecto ya
desplegado, ref conocido por el usuario): aplicar
`20260911120000_price_costs_diff_resolution_etapa6_2` con
`npx prisma migrate deploy` (workspace `packages/db`) apuntando a
`DATABASE_URL`/`DIRECT_URL` del proyecto real — es la única migración
pendiente de aplicar en el entorno desplegado (las 10 anteriores ya se
aplicaron cuando se levantó el pilot en la sesión previa).

**Variables de entorno** (sin exponer secretos, sólo el nombre y su
origen): ninguna variable NUEVA se agregó en esta etapa — el subsistema de
precios reutiliza exactamente el mismo `DATABASE_URL`/`DIRECT_URL` que el
resto de la app; no requiere credenciales de Supabase Storage (los archivos
de precios se parsean en memoria al subir, igual que Etapa 5, sin guardarse
como blob).

**Bootstrap temporal de `render.yaml` — revertido en esta etapa** (sección
22 del prompt, explícito): el `buildCommand` tenía agregado
`&& npm run migrate:deploy --workspace packages/db && npm run seed
--workspace packages/db` como excepción TEMPORAL para el primer deploy
(documentada como tal en su propio commit). El usuario ya confirmó login
exitoso contra ese primer deploy, así que esa excepción ya cumplió su
propósito — se revirtió el `buildCommand` al flujo manual documentado
(`npm ci && build shared-types && generate db`, sin migrar/seedear
automáticamente en cada deploy). **Acción pendiente del usuario**: aplicar
la migración de esta etapa a mano ANTES (o inmediatamente después) del
próximo deploy de Render, siguiendo el paso anterior.

**Cómo importar las listas de precios reales** (una vez el pilot está
desplegado y migrado):

1. Ingresar como ADMIN → pantalla **Precios**.
2. Elegir "Lista de costos" (`HELACOR_COST_LIST`), subir el `.xlsx` real de
   Helacor, revisar el preview (filas reconocidas/nuevas/sin mapear),
   indicar la vigencia real (`effectiveFrom`, ej. el primer día del mes que
   representa esa lista) y confirmar.
3. Repetir con "Lista de precios de venta" (`HELACOR_SALE_PRICE_LIST`).
4. En la sección de referencias, mapear cada referencia de Grido a el/los
   producto(s) del catálogo interno correspondientes (una referencia puede
   mapear a varios productos, ej. "Palito Frutales" → cada sabor).
5. Repetir el import mensualmente (o cuando cambien los precios), siempre
   con una `effectiveFrom` real y explícita — nunca reimportar "para
   probar" sin pensar la vigencia, porque un valor con vigencia incorrecta
   puede aparecer como "vigente" antes de lo real.

**Cómo correr un piloto completo**: seguir el flujo E2E de la sección 20 de
punta a punta contra el entorno de staging real, con datos de al menos una
heladería y una semana completa.

## 20. Flujo E2E de 20 pasos (sección 23 del prompt) — documentado, no automatizado end-to-end

No existe un único test automatizado que ejecute las 20 acciones en
secuencia (cada paso individual SÍ está cubierto por tests de integración
contra Postgres real, ver sección 18) — se documenta acá como procedimiento
MANUAL/de referencia para validar un piloto real, tal como pide la sección
23 ("al menos un test/procedimiento documentado"):

1. Configurar catálogo (categorías, productos, unidades) — Etapa 2.
2. Importar/crear la lista de costos real (`HELACOR_COST_LIST`), confirmar
   con vigencia real.
3. Importar/crear la lista de precios de venta real
   (`HELACOR_SALE_PRICE_LIST`), confirmar con vigencia real.
4. Resolver los mapeos referencia↔producto pendientes (1:N cuando
   corresponda).
5. Cargar stock inicial / movimientos iniciales del período (Etapa 3).
6. Importar ventas del período (Etapa 5).
7. Realizar el conteo semanal ciego (Etapa 4) desde la Shop PWA.
8. El sistema calcula diferencias; si alguna es un faltante ≥25%, se marca
   `RECOUNT_REQUIRED`.
9. Si corresponde, reenviar el reconteo de los ítems marcados.
10. Confirmar cada faltante recontado como FALTANTE CONFIRMADO (o resolver
    el sobrante correspondiente) desde el admin.
11. Si el sistema detecta un posible error de tipeo, revisarlo y
    confirmar/rechazar la sugerencia.
12. El ADMIN revisa el checklist/diferencias de cada `WeeklyClosing` por
    ubicación.
13. Repetir los pasos 7-12 para TODAS las heladerías requeridas de la
    semana.
14. El sistema calcula la valorización usando el costo C/IVA vigente para
    cada producto con stock real; si falta algún costo, se bloquea y se
    resuelve el mapeo/import faltante antes de continuar.
15. El ADMIN confirma la revisión del checklist de cada cierre
    (`confirm-review`).
16. La semana se cierra por ubicación (`close`) — se generan las
    correcciones `COUNT_CORRECTION` del ledger y el snapshot histórico.
17. Una vez todas las heladerías requeridas están `CLOSED`, se habilita y
    se ejecuta el cierre semanal GENERAL.
18. Se genera el snapshot histórico congelado (teórico, real, diferencia,
    costo, valor) para cada producto y ubicación.
19. Más adelante se importa una lista de precios NUEVA con costos
    distintos.
20. Se vuelve a consultar el cierre histórico de la semana ya cerrada: la
    valorización debe permanecer EXACTAMENTE igual a la del paso 18, sin
    importar el nuevo import del paso 19.

## 21. Fuera de alcance (sección 24 del prompt, reafirmado)

Sin cambios respecto del prompt original: caja semanal completa, Mercado
Pago, conciliación de medios de pago, pedidos heladería→depósito, remitos,
reparto, recepción de mercadería, Store/Express, fábrica, FIFO, lotes
avanzados, transporte, IA, predicciones, clima, promociones avanzadas, SaaS
comercial multi-tenant con RLS real, Etapa 7, Etapa 8. Ninguno de estos se
tocó ni se expandió en esta entrega.

## 22. Ambigüedades y decisiones documentadas (sin inventar comportamiento)

- **Identidad de `PriceReference` por `label` exacto** (sección 2 de este
  doc) — la única alternativa sin código de artículo hubiera sido
  similarity matching, explícitamente prohibido por el prompt sin
  confirmación humana.
- **`asOfDate` de la valorización** — Etapa 6.2 eligió el momento REAL del
  `close` (`closedAt`) por ser la lectura más literal de "costo vigente".
  **Etapa 6.2.1 revirtió esta decisión**: el cliente confirmó explícitamente
  que debe ser el `periodEnd` del período que se cierra, no el instante del
  clic — ver `docs/ETAPA-6.2.1-CORRECCIONES-HITO1.md`, sección 3, con el
  ejemplo numérico exacto que motivó el cambio.
- **25% de faltante como constante de código, no variable de entorno**: a
  diferencia de los umbrales ABSOLUTOS de Etapa 4.1 (nunca confirmados con
  un valor concreto, por eso siguen sin default), el 25% SÍ es un literal
  confirmado textualmente por el cliente — mismo criterio que las
  fracciones de `OpenContainerFraction`.
- **Depósito**: ver sección 11 — validación mínima agregada en Etapa 6.2.1
  (sin cambios de arquitectura); Etapa 8 sigue fuera de alcance.
- **Shop PWA**: ver sección 17 — implementada en Etapa 6.2.1 (era el
  blocker principal de la auditoría de Etapa 6.2).
