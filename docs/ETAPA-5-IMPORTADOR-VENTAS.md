# ETAPA 5 — Importador de Ventas

Versión: 1.0 · Rama: `claude/etapa-5-importador-ventas`

## 1. Archivo real elegido y por qué

Se inspeccionaron dos exportaciones reales del mismo reporte de POS ("Mix de Ventas"),
provistas por el cliente:

- `mixventas desa.xls` → copiado al repo como fixture de test:
  `apps/api/src/test/fixtures/mixventas-desa-saavedra.xls` (156 filas × 25 columnas,
  exportado con el filtro **"Precios: Desagrupados"**).
- `mixventas.xls` → copiado como `apps/api/src/test/fixtures/mixventas-agrupado-saavedra.xls`
  (100 filas × 25 columnas, mismo reporte con **"Precios: Agrupados"**).

**Se eligió la variante Desagrupada como única fuente soportada.** Verificación empírica
directa sobre ambos archivos: la variante Agrupada fusiona líneas por artículo (ej. la fila
"Bombon Crocante en Caja x 8" del archivo agrupado tiene cantidad 20 = 18 normales + 2 de
Canje, importe 235600 = 223200 + 12400, exactamente la suma de las dos filas
correspondientes del desagrupado) y, al fusionarlas, el código `promocion` vuelve a 0 y el
sufijo "(Canje ...)" de la descripción desaparece. Como el prompt exige preservar la
identificación de Canje/promoción, la variante Agrupada es estructuralmente inviable como
fuente — no es una preferencia, es una imposibilidad matemática (la información ya no está en
el archivo).

**Limitación documentada, no inventada:** ambas variantes comparten el mismo encabezado de 25
columnas — no hay ninguna columna ni marca en el contenido del archivo que permita
distinguir "Agrupados" de "Desagrupados" con certeza. El parser no puede rechazar
técnicamente un archivo Agrupado por su contenido (ver
`apps/api/src/services/sales-import-parser.ts`, test
`documenta la limitación real...`); queda como **procedimiento operativo**: el ADMIN debe
exportar siempre con "Precios: Desagrupados" antes de subir. Esto es exactamente el tipo de
dato no confirmable con evidencia que el prompt pide documentar como supuesto reversible en
vez de inventar una validación de software sin respaldo.

`infcomandas.xls` e `infturnos.xls` (también provistos) se inspeccionaron pero no se usan
como fuente del importador: no traen importe real por línea de venta reconciliable contra el
total del período de la forma en que "Mix de Ventas" sí lo hace. `infturnos.xls` sí trae un
agregado por turno `ventaclubgrido`/`porcclubgrido` (verificado numéricamente autoconsistente)
que es una fuente real y distinta de la señal de Canje por línea de "Mix de Ventas" — se
documenta como hallazgo, deliberadamente NO se combinan ambas señales sin evidencia de que
signifiquen lo mismo.

## 2. Columnas reales inspeccionadas

Encabezado real y exacto (fila 0), en este orden — ver
`MIX_VENTAS_EXPECTED_HEADERS` en `sales-import-parser.ts`:

```
succodigo, grudescrip, artdescrip, cantidad, bultos, preciopromedio, total,
porctotalpesos, kilos, sucursal, sucdescrip, desde, hasta, grupo, subgrupo,
articulo, cajero, promocion, tipooperacion, filtrorubro, filtrozona,
filtrovendedor, filtrocajero, filtrovtaoperacion, filtrocaja
```

**Columnas usadas:**

| Columna real      | Uso                                                                        |
| ----------------- | -------------------------------------------------------------------------- |
| `articulo`        | Identidad ESTABLE del producto (nunca `artdescrip`) → `rawArticleCode`     |
| `artdescrip`      | Descripción tal cual, incluye sufijo de Canje/promo → `rawDescription`     |
| `grudescrip`      | Grupo/rubro, informativo → `rawGroup`                                      |
| `cantidad`        | Cantidad vendida → `quantity`                                              |
| `total`           | Importe REAL de la línea (puede ser negativo, ver "Canje") → `amount`      |
| `promocion`       | Código ≠ 0 ⇒ `isPromotion = true`; se guarda como `promotionCode`          |
| `subgrupo`        | Discriminador estructural: 1 = venta real, 2 = subtotal, 3 = total general |
| `desde` / `hasta` | Período del reporte completo → `SalesImport.periodStart/periodEnd`         |
| `preciopromedio`  | Informativo → `unitPriceAvg`                                               |
| `bultos`          | Informativo, string libre (puede ser `"N/A"`) → `bultos`                   |
| `kilos`           | Informativo → `kilos`                                                      |
| `porctotalpesos`  | Informativo → `pctOfTotal`                                                 |

**Columnas ignoradas deliberadamente:**

- `sucursal`: valores numéricos pequeños (0.94, 4.71, ...) que NO son un identificador de
  sucursal — comparados contra las capturas de pantalla reales del POS ("mixde ventas
  img.png"), el orden visible de columnas termina en "Kilos, % Total": `sucursal` es en
  realidad un segundo "% Total" (sobre kilos), mal nombrado en el export crudo. Se excluye
  por completo para no transmitir un significado incorrecto; la identidad de sucursal real
  se toma de `succodigo`/`sucdescrip` (no almacenadas como columna propia: la sucursal ya
  está representada por `SalesImport.locationId`, elegido explícitamente por el ADMIN al
  subir).
- `grupo`, `cajero`, `tipooperacion`, `filtrorubro`, `filtrozona`, `filtrovendedor`,
  `filtrocajero`, `filtrovtaoperacion`, `filtrocaja`: constantes o vacías en el archivo real
  inspeccionado (siempre el mismo valor, ej. `cajero = "Todos"`), sin evidencia de que
  aporten algo al Hito 1.

**Subgrupo, evidencia real:** `subgrupo = 1` en las 136 filas de detalle del fixture
desagrupado; `subgrupo = 2` en las 18 filas de subtotal por grupo (`artdescrip` vacío,
`articulo` vacío); `subgrupo = 3` en la única fila "Total General" (usada para
`fileStatedTotal`, la reconciliación).

## 3. Modelo de datos

Migración `packages/db/prisma/migrations/20260909130410_sales_import_etapa5/` (nueva, no
modifica ninguna migración anterior). Entidades:

- **`SalesImport`**: un archivo subido. `organizationId`, `locationId`, `source`,
  `originalFilename`, `fileHash` (SHA-256), `periodStart`/`periodEnd`, `status`, totales,
  `blockedReason`/`failedReason`, `createdById`/`confirmedById`, y el par
  `confirmIdempotencyKey`/`confirmIdempotencyFingerprint` (idempotencia de confirmación).
- **`SalesImportRow`**: cada fila parseada y validada (sólo las columnas reales, nunca el
  Excel entero). Nunca cachea a qué producto se mapea — eso se resuelve EN VIVO.
- **`ProductAlias`**: mapeo ADMIN-confirmado `(organización, fuente, código externo)` →
  `Product`.
- **`BillOfMaterialItem`**: receta (producto vendido → insumo consumido, cantidad canónica
  por unidad canónica).
- **`Sale`**: venta CONFIRMADA (hecho inmutable), 1:1 con el movimiento SALE que generó
  (`movementId`), referenciando `SalesImportRow`.

Todas las FKs hacia tablas tenant-scoped son compuestas `(organizationId, id)` (mismo
criterio que Etapa 2.1/3). No se creó ninguna tabla de trazabilidad nueva para
BOM_CONSUMPTION: reutiliza `InventoryMovement.sourceDocumentType`/`sourceDocumentId`,
reservados desde Etapa 3 para exactamente este uso.

`enum SalesImportStatus`: `UPLOADED` (transitorio, nunca queda persistido en reposo — ver
sección 5) → `PREVIEW_READY` | `BLOCKED` | `FAILED` → `CONFIRMED` (inmutable).

## 4. Parser (`apps/api/src/services/sales-import-parser.ts`)

Función pura `parseMixVentasRows(headers, rawRows)`: recibe celdas ya leídas y devuelve
`{ periodStart, periodEnd, rows, fileStatedTotal }`, sin tocar disco ni base de datos —
separada de la lectura IO (`readXlsFile`), que sólo abre el archivo y expone celdas crudas.

Validaciones por fila (subgrupo 1 únicamente): código de artículo no vacío, descripción no
vacía, cantidad numérica > 0, importe numérico (se acepta negativo — ver "Canje" más abajo).
Una fila inválida se marca `status: 'ERROR'` con `errorMessage`; no aborta el resto del
archivo (sección 13 del prompt: error fila por fila).

Se usa `node-xlrd` (no `xlsx`/SheetJS: tenía una vulnerabilidad HIGH sin fix disponible en el
registro de npm). Bug real encontrado y corregido durante el desarrollo: `node-xlrd` puede
lanzar una excepción síncrona dentro de un callback de `fs.read` ante un archivo que no es
realmente OLE2 (ej. un `.txt` renombrado a `.xls`), lo que escapaba de la Promise y colgaba
el request. Se agregó una validación de la firma OLE2 (`D0 CF 11 E0 A1 B1 1A E1`) ANTES de
entregarle bytes a la librería, convirtiendo ese caso en un rechazo controlado.

## 5. Flujo (los 10 pasos obligatorios)

`apps/api/src/services/sales-import.ts`:

1. **Subir** (`POST /api/sales-imports`, multipart, sólo ADMIN): calcula `fileHash`
   (SHA-256), busca un `SalesImport` existente `(organizationId, locationId, fileHash)`.
2. Si existe → se devuelve el existente (`alreadyImported: true`), nunca se duplica ni se
   reparsea.
3. Si no existe → el buffer se escribe a un archivo temporal (`node-xlrd` sólo lee de disco),
   se parsea, y se limpia siempre (`finally`).
4. Cualquier falla al interpretar el archivo (formato no soportado, corrupto) es un
   `ValidationError` (400) — **nunca se persiste un `SalesImport`** para un archivo que ni
   siquiera se pudo leer (por eso `UPLOADED`/`FAILED`-por-formato nunca aparecen en reposo;
   `FAILED` sí es alcanzable cuando el archivo parsea pero no tiene ninguna fila de venta).
5. Se calculan totales, se reconcilia la suma de importes válidos contra `fileStatedTotal`
   (tolerancia $0.02 por redondeo) → `PREVIEW_READY` si reconcilia, `BLOCKED` si no.
6. `GET /api/sales-imports/:id` (preview): resuelve el mapeo de cada fila EN VIVO contra
   `ProductAlias`, arma resumen de mapeados/sin mapear/posibles duplicados/totales. Nunca
   escribe nada — ni una consulta de escritura, tampoco para un import ya `CONFIRMED`.
   7-8. El ADMIN revisa el preview, crea alias para códigos sin mapear
   (`POST /api/product-aliases`) desde la misma pantalla.
7. El ADMIN confirma (`POST /api/sales-imports/:id/confirm`).
8. Sólo ahí se generan `Sale` + movimientos `SALE`/`BOM_CONSUMPTION` + auditoría, todo en
   una única transacción (`fastify.db.$transaction`) — si cualquier parte falla, nada queda
   aplicado.

## 6. Alias (mapeo de productos)

`ProductAlias(organizationId, source, externalCode)` único por organización. Siempre lo crea
un ADMIN explícitamente vía `POST /api/product-aliases` (upsert: crear o remapear). Nunca se
auto-genera ni se infiere un match automático que impacte sin confirmación — no existe
fuzzy-matching en el sistema. Una fila sin alias nunca genera `Sale` ni movimiento: es el
mecanismo de "nunca impactar stock sin mapear" (sección 7 del prompt), sin necesitar un flag
aparte en `Product`.

`ProductAlias` es configuración, no un hecho histórico: remapear un código hacia otro
producto no afecta ninguna venta ya `CONFIRMED` (el mapeo se resuelve en vivo en cada
preview/confirm, nunca se cachea en `SalesImportRow`).

## 7. Idempotencia

Dos mecanismos DISTINTOS, nunca confundidos:

- **De archivo** (subida): `@@unique([organizationId, locationId, fileHash])`. Subir el
  mismo archivo exacto dos veces (secuencial o concurrente, verificado con `Promise.all`
  sobre PostgreSQL real) devuelve el import existente, nunca lo duplica.
- **De confirmación**: mismo patrón endurecido de Etapa 3.2/4.1 —
  `confirmIdempotencyKey`/`confirmIdempotencyFingerprint` + `UNIQUE` + `UPDATE` condicional
  (`status: PREVIEW_READY → CONFIRMED`) + resolución explícita de la carrera reconsultando
  lo que Postgres dejó persistido. Misma clave + mismo fingerprint (el fingerprint sólo
  ata la clave a ESTE import, ya que la confirmación no recibe más payload variable) → se
  devuelve el resultado ya confirmado, sin re-ejecutar nada ni re-auditar. Clave distinta →
  `409 CONFLICT`. Verificado con tests reales de concurrencia (`Promise.all`), nunca con
  locks en memoria ni mutex — Postgres es la única fuente de verdad, funciona igual con
  varias instancias del backend.

## 8. Movimientos SALE

Al confirmar, cada fila `VALID` mapeada genera exactamente un movimiento `SALE` (tipo ya
reservado desde Etapa 3): `enteredQuantity` = cantidad vendida negada (unidad propia del
producto), `quantity` = canónica (`enteredQuantity × unitsPerHandlingUnit`),
`sourceDocumentType = 'SALES_IMPORT'` / `sourceDocumentId = SalesImport.id`. Igual que el
resto del ledger, se permite stock negativo (nunca se bloquea una venta válida por el saldo
teórico — mismo criterio ya establecido en Etapa 3).

## 9. BOM_CONSUMPTION

Para cada `Sale` confirmada, se buscan las recetas activas (`BillOfMaterialItem`) del
producto vendido. Por cada una, se genera un movimiento `BOM_CONSUMPTION` del componente:
`componentCanonicalQty = |quantity vendida canónica| × quantityPerUnit`,
`sourceDocumentType = 'SALE'` / `sourceDocumentId = Sale.id` (trazabilidad sin tabla nueva).
Sin receta configurada para un producto, no se genera NINGÚN consumo — nunca se inventa una
cantidad. Las recetas se gestionan por API (`/api/bill-of-material-items`, sólo ADMIN); no
hay pantalla dedicada en Hito 1 (no está en la lista de la pantalla mínima pedida).

## 10. Canje Club Grido

Evidencia real: `promocion ≠ 0` es la señal genérica de "el POS aplicó un precio
promocional" (incluye Canje, pero también descuentos de apps de delivery — ej. "Pedi
Grido"/"Peya" — que NO son Canje). `isCanje` es la señal MÁS específica: la descripción
incluye literalmente la palabra "Canje" — el único indicador textual real que el archivo
usa. Nunca se asume un % fijo de descuento (el doc del cliente menciona ~50%, pero esto no
está en los datos y no se hardcodea nada).

Una venta Canje es una venta real: genera `Sale`/`SALE` normalmente (descuenta stock), con
`amountReal` = el importe REAL de la fila (ej. $12.400, el precio de Canje efectivamente
cobrado/registrado), nunca la mitad de un precio de lista inventado. Nunca genera `WASTE`.

## 11. Transaccionalidad y estados

La confirmación completa (`SalesImport.updateMany` + `Sale.create` × N + `InventoryMovement`
SALE/BOM_CONSUMPTION × N + `AuditLog`) corre dentro de una única `$transaction`. Un
`CONFIRMED` es inmutable en sus efectos — no hay endpoint de edición; una corrección futura
(fuera de alcance de Hito 1) sería una reversa trazable, mismo criterio que
`reverseMovement` de Etapa 3.1.

## 12. Storage del archivo original

**Decisión documentada:** el `.xls` original NO se conserva en Supabase Storage para Hito 1.
Se guarda su `fileHash` (SHA-256, para idempotencia) y todas las filas ya parseadas
(suficiente para auditoría/reconstrucción del import). `SalesImport.storagePath` queda
`nullable` y sin usar — reservado para si el cliente confirma que necesita el archivo
original conservado en una etapa futura, sin requerir migración nueva.

## 13. Permisos

Sólo `ADMIN` puede: subir, ver el preview, confirmar, crear/remapear alias, gestionar
recetas — `requireRole('ADMIN')` en las tres rutas de `apps/api/src/routes/sales-import.ts`.
`SHOP_EMPLOYEE`/`DEPOSIT_MANAGER` no tienen ninguna operación de este módulo (verificado en
tests: 403).

## 14. Auditoría

`module: 'SALES_IMPORT'`. Acciones: `SALES_IMPORT_UPLOADED`, `SALES_IMPORT_ALREADY_IMPORTED`,
`SALES_IMPORT_BLOCKED`, `SALES_IMPORT_FAILED`, `SALES_IMPORT_CONFIRMED`,
`SALES_IMPORT_PRODUCT_ALIAS_CONFIRMED`, `SALES_IMPORT_BOM_ITEM_CREATED`/`_UPDATED`. Una
confirmación lógica genera exactamente una fila de auditoría `SALES_IMPORT_CONFIRMED`
(verificado en tests de idempotencia secuencial y concurrente — nunca se re-audita un
retry).

## 15. Supuestos documentados (reversibles, no decisiones de negocio inventadas)

| #   | Supuesto                                                                                              | Reversible si…                                                                   |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `Sale.occurredAt` = `SalesImport.periodEnd` (el archivo no trae fecha por línea)                      | El cliente confirma una fuente de fecha por línea distinta                       |
| 2   | El ADMIN siempre exporta "Precios: Desagrupados" (procedimiento operativo, no validable por software) | Se encuentra una marca real en el contenido del archivo que distinga la variante |
| 3   | El archivo original no se conserva en Storage en Hito 1                                               | El cliente confirma que lo necesita                                              |
| 4   | `sucursal` se excluye por completo (mal etiquetada en el export crudo)                                | El cliente aclara su significado real                                            |
| 5   | Tolerancia de reconciliación de $0.02 (redondeo)                                                      | El cliente define una tolerancia distinta                                        |

## 16. Pendientes dependientes de datos reales/decisiones del cliente

- Confirmar si `ventaclubgrido`/`porcclubgrido` de `infturnos.xls` debe usarse para algo
  (auditoría cruzada del Canje, por ejemplo) — hoy es sólo un hallazgo documentado, no se usa.
- Pantalla de gestión de recetas (BOM) en admin-web — hoy sólo API, no está en el alcance de
  la pantalla mínima pedida por este prompt.
- Confirmación/reapertura de una venta ya `CONFIRMED` (reversa) — explícitamente fuera de
  alcance de Etapa 5 (mencionado como corrección futura, no se construye acá).

## 17. Control de alcance

Explícitamente NO tocado ni implementado: cierre semanal, caja/efectivo, Mercado Pago,
depósito, remitos, compras/facturas, FIFO, transporte, IA/predicciones, RLS real,
multi-organización comercial, reportes avanzados. Nada de Etapa 1-4.1 (conteo, baja de lata,
merma, gasto variable, sin stock, catálogo, login/auth) se modificó — sólo se agregaron
tablas/rutas/servicios nuevos.
