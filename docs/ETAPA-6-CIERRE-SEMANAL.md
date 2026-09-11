# ETAPA 6 — Cierre Semanal del Núcleo

Versión: 1.1 · Rama: `claude/etapa-6-cierre-semanal`

> **Actualización — Etapa 6.1 (hardening: consistencia temporal de la
> reconciliación).** Auditoría posterior detectó una carrera real en
> `closeWeeklyClosing`: el ajuste `COUNT_CORRECTION` se calculaba como
> `cantidad real del conteo − saldo VIGENTE del ledger al momento de cerrar`,
> lo que podía absorber, como si fueran parte de la diferencia física del
> conteo, movimientos legítimos (ventas, mermas, otros ajustes) ocurridos
> DESPUÉS del conteo pero antes o durante el cierre. Corregido: el ajuste es
> SIEMPRE la diferencia histórica congelada en el conteo
> (`InventoryCountItem.difference`), y la reconciliación "ya aplicada" se
> determina consultando la trazabilidad YA PERSISTIDA del ledger
> (`InventoryMovement.sourceDocumentType`/`sourceDocumentId`), nunca
> comparando contra el saldo actual. También se corrigió un `continue`
> silencioso que hubiera dejado un cierre parcialmente aplicado si un
> producto del conteo gobernante no podía resolverse -- ahora aborta todo el
> cierre (rollback completo). Ver la sección "Etapa 6.1" más abajo para el
> detalle completo.

> **Actualización — Etapa 6.2 (cierre integral del Hito 1).** Este cierre
> semanal por ubicación ahora es un componente de un alcance mucho más
> amplio: modelo histórico de precios/costos, reconteo obligatorio por
> faltante ≥25%, revisión de sobrantes, detección de posible error de
> tipeo, valorización congelada del stock con costo C/IVA vigente, y un
> cierre semanal GENERAL a nivel organización (todas las heladerías
> requeridas). Ninguna garantía de esta etapa (Etapa 6) ni de Etapa 6.1 se
> modificó de fondo -- sólo se le agregaron las tres columnas de
> valorización a `InventorySnapshotItem` y el chequeo de costo faltante al
> checklist. Ver `docs/ETAPA-6.2-CIERRE-INTEGRAL.md` para el detalle
> completo.

## 1. Fuente de verdad

Único material fuente: `sistema_grido.zip`, en particular "Informe Corregido Grido Stock
v2 (2).docx" (extraído a texto plano para grep exhaustivo). El sistema anterior
(mixventas, infcomandas, infturnos, mercadopago.pdf, planillas HELADERIAS_HABASH) sólo se
usó como evidencia de refuerzo, nunca como fuente de reglas de negocio nuevas.

Citas textuales del documento que gobernaron las decisiones de esta etapa:

- §24: **"Período: lunes a domingo. Cierre: lunes siguiente."**
- §15: **"El conteo semanal principal se realiza los lunes por la mañana, antes de
  recibir o despachar mercadería."**
- §16.1: **"Al cerrar el período, el real pasa a ser el nuevo punto de partida
  operativo, pero la diferencia histórica se conserva."**
- §24.1 (checklist sugerido): "Ventas importadas. Efectivo contado (Hito 1b). Stock de
  cada heladería. Stock depósito. Mermas procesadas. Gastos variables procesados.
  Diferencias revisadas (teórico vs. real). Estados sugeridos: OPEN, INCOMPLETE,
  READY_TO_CLOSE, CLOSED, REOPENED."
- §12/§13/§23/§46: costo/precio de producto y su gestión son explícitamente **"Hito 1b en
  adelante"** / **"fuera del Hito 1"**.

Ningún campo, regla ni estado de este módulo se inventó sin poder señalar una de estas
citas (o una decisión mínima documentada en la sección 17).

## 2. Principio central: el ledger nunca se reemplaza

`InventoryMovement` (Etapa 3) sigue siendo la única fuente de verdad de stock. El cierre
semanal:

- **Consulta** `InventoryCountItem` (Etapa 4) para el teórico/real/diferencia ya
  calculados y persistidos al momento del conteo.
- **Compara** ese teórico/real contra el estado vigente del ledger al momento de cerrar.
- **Consolida** un snapshot histórico inmutable (`InventorySnapshotItem`).
- **Genera**, cuando corresponde, un movimiento `COUNT_CORRECTION` (ya reservado desde la
  migración original del ledger, Etapa 3) — nunca edita `quantity` de un movimiento
  existente, nunca escribe un "saldo" directamente.

## 3. Período semanal y qué conteo lo gobierna

`WeeklyClosing.periodStart` es siempre un lunes; `periodEnd = periodStart + 6` (domingo de
la misma semana) — CHECK agregado a mano en la migración. Ambos se derivan de la cita
literal de §24.

**Decisión no obvia, verificada con un ejemplo concreto de fechas:** el conteo que
gobierna el cierre del período `[Lunes N .. Domingo N]` es el `InventoryCount` cuyo
`weekStart = Lunes N + 7 días` (el lunes **siguiente**), no el del propio `Lunes N`.

Ejemplo (Semana A = lunes 3 de agosto a domingo 9 de agosto de 2026):

- El conteo tomado el **lunes 3/8** (antes de operar esa mañana) valida el **cierre de la
  semana anterior** (la que terminó el domingo 2/8) — es el conteo que valida el domingo
  2/8, no ningún día de la Semana A.
- Durante la Semana A (3/8 a 9/8) ocurren ventas, mermas, gastos.
- El conteo tomado el **lunes 10/8** (`weekStart = 3/8 + 7 días`) es el primero que
  refleja TODO lo que pasó durante la Semana A — es el que efectivamente puede validar
  "cuánto había en realidad al cerrar esa semana".

Por eso `apps/api/src/services/weekly-closing.ts` (`governingCountWeekStart`) calcula
`periodStart + 7 días` y busca ese `InventoryCount`, nunca el de `periodStart`. Se eligió
documentar esto extensamente (en el schema, en el servicio y acá) porque es fácil
invertirlo por error.

No se asumió ninguna definición de semana distinta a la ya documentada (Etapa 0 no fija
un día de corte explícito para el cierre administrativo, así que esta lectura de §15/§24
es la única con respaldo textual directo).

## 4. Entidades

Dos modelos nuevos (`packages/db/prisma/schema.prisma`, migración
`20260909140000_weekly_closing_etapa6`):

### `WeeklyClosing`

Una fila por (organización, ubicación, período). Campos: `id`, `organizationId`,
`locationId`, `periodStart`/`periodEnd`, `status` (`OPEN` / `CLOSED` / `REOPENED`),
`currentRevision` (entero, empieza en 0, se incrementa en cada `close` exitoso),
`reviewConfirmedById`/`reviewConfirmedAt` (gesto único de revisión del checklist),
`createdById`/`createdAt`, `closedById`/`closedAt` (reflejan el cierre MÁS reciente),
`reopenedById`/`reopenedAt`/`reopenReason` (reflejan la reapertura MÁS reciente),
`closeIdempotencyKey`/`closeIdempotencyFingerprint` (idempotencia del cierre, se resetea a
`null` en cada `reopen`).

Constraints: `@@unique([organizationId, id])` (FK compuesta desde `InventorySnapshotItem`);
`@@unique([organizationId, locationId, periodStart])` (a lo sumo un cierre activo por
ubicación/período, sin solapamientos ni duplicados); `@@unique([organizationId,
closeIdempotencyKey])`; CHECK a mano `period_end = period_start + 6`; CHECK a mano
`reopened_at IS NULL OR reopen_reason IS NOT NULL` (motivo obligatorio en toda
reapertura).

### `InventorySnapshotItem`

Una fila por (cierre, producto, revisión) — nunca se edita ni se borra tras crearse.
Campos: `id`, `organizationId`, `locationId` (denormalizado), `weeklyClosingId`,
`productId`, `revision` (coincide con `WeeklyClosing.currentRevision` al momento de
generarse), `quantityTheoretical`/`quantityReal`/`difference` (`Decimal(14,3)`, copiados
directamente del conteo gobernante), `countCorrectionMovementId` (nullable, FK compuesta
opcional hacia `InventoryMovement` — `null` cuando la diferencia histórica es cero),
`createdAt`.

Constraints: `@@unique([organizationId, weeklyClosingId, productId, revision])` (una fila
por producto y revisión — habilita reabrir y volver a cerrar sin pisar la anterior);
`@@unique([organizationId, countCorrectionMovementId])` (defensa en profundidad; NULLs no
colisionan entre sí en Postgres).

**Se descartó explícitamente** `WeeklyClosingChecklist` como tabla propia (§3 del prompt:
"nombres adaptables... no inventar campos sin necesidad"): el checklist es enteramente
DERIVADO en cada consulta (ver sección 5) — no hay nada que persistir además de
`reviewConfirmedById`/`reviewConfirmedAt`, ya parte de `WeeklyClosing`. Agregar una tabla
aparte sólo hubiera duplicado ese único dato real.

## 5. Estados

Tres estados PERSISTIDOS: `OPEN` → `CLOSED` → (opcional) `REOPENED` → `CLOSED` (nueva
revisión) → ...

Los dos estados "sugeridos" adicionales de §24.1 (`INCOMPLETE`, `READY_TO_CLOSE`) son
DERIVADOS, nunca guardados: se calculan en cada consulta a partir del checklist
(`WeeklyClosingChecklist.canClose`), mismo criterio que `SalesImportPreview.canConfirm`
de la Etapa 5.1. Persistirlos por separado arriesgaría desincronizarse del checklist real.

Reglas: no se puede cerrar si el checklist obligatorio está incompleto (sección 6); un
cierre `CLOSED` es inmutable (ninguna operación de este módulo lo modifica salvo
`reopen`); toda reapertura queda auditada con motivo obligatorio; no hay edición silenciosa
en ningún estado.

## 6. Checklist

`WeeklyClosingChecklist` (calculado en `computeChecklist`, `weekly-closing.ts`) distingue
DOS tipos de condición, deliberadamente:

1. **`countSubmitted`** — la ÚNICA sub-condición auto-verificada de forma inequívoca:
   ¿existe un `InventoryCount` con `status = COMPLETED` para `weekStart = periodStart + 7
días`? Sí/no, sin ambigüedad posible.
2. **Resúmenes informativos** — `salesImportsTotal`/`salesImportsConfirmed` (ventas cuyo
   rango declarado se solapa con el período), `wastesTotal`, `variableExpensesTotal`
   (ambos filtrados por `occurredAt` dentro del período). **Nunca bloquean el cierre por
   sí solos** — el prompt prohíbe explícitamente inventar "debe haber al menos una
   merma"; una semana con 0 mermas o 0 gastos es perfectamente válida.

**El problema señalado por el prompt** ("si el modelo actual no tiene forma inequívoca de
distinguir 'no hubo mermas' de 'nadie revisó las mermas', no inventar una regla oculta")
se resolvió así: en vez de cuatro flags booleanos por sub-ítem (que además multiplicarían
columnas/relaciones sin necesidad real), hay **un único gesto explícito y consolidado**:
`reviewConfirmedById`/`reviewConfirmedAt`, seteado sólo cuando un ADMIN llama
`POST /api/weekly-closings/:id/confirm-review` después de ver el resumen completo en la
misma pantalla (admin-web, sección 12). Ese gesto cubre "revisé mermas, gastos, ventas y
diferencias" de una sola vez — la única alternativa que distingue de forma inequívoca
"nadie miró esto todavía" de "se miró y está bien así, aunque sea 0".

`canClose = status !== 'CLOSED' && countSubmitted && reviewConfirmedById !== null`.

## 7. Cálculo teórico y real

**No se reimplementa la captura del conteo.** `InventoryCountItem.theoreticalQuantity` /
`.physicalQuantity` / `.difference` (Etapa 4, `submitInventoryCount`) ya están calculados
y persistidos en el momento del envío del conteo — el cierre los COPIA directamente
(`computeLiveItems`), nunca los recalcula por otra vía. `difference = physicalQuantity -
theoreticalQuantity` (real - teórico), mismo criterio ya establecido en Etapa 4
(RN-016), confirmado antes de tocar código.

Todo el camino usa `Prisma.Decimal` end-to-end — nunca `Number()` sobre una cantidad
sensible (ver el test "precisión Decimal" en la sección 16).

Un producto con teórico NEGATIVO (por ejemplo, ventas o mermas que superaron el stock
cargado) se procesa exactamente igual — no hay ninguna validación que lo bloquee (sección
23 del prompt, ítem explícito).

## 8. Diferencia y ajuste (`COUNT_CORRECTION`)

El documento del cliente (§16.1) confirma que el cierre SÍ reconcilia automáticamente:
"el real pasa a ser el nuevo punto de partida operativo". Se genera, entonces, un
movimiento `COUNT_CORRECTION` por producto con diferencia histórica no nula — tipo YA
reservado en el ledger desde la migración original de Etapa 3
(`inventory_movement.reason IS NOT NULL OR movement_type NOT IN
('ADJUSTMENT','COUNT_CORRECTION')`), sin necesidad de tocar el ledger.

El ajuste efectivamente aplicado es SIEMPRE la diferencia histórica congelada del conteo
(`InventoryCountItem.difference`, copiada a `InventorySnapshotItem.difference`) — nunca se
recalcula comparando contra el saldo actual del ledger. Cómo se evita duplicarlo en un
recierre sin absorber movimientos posteriores al conteo se explica en detalle en la
sección "Etapa 6.1 — Consistencia temporal de la reconciliación" más abajo (una revisión
anterior de este documento describía acá una estrategia -- comparar contra el teórico
vigente del ledger -- que resultó tener una carrera real; ver esa sección para la
corrección completa).

Nunca se genera un `COUNT_CORRECTION` cuando la diferencia histórica es exactamente cero.

`quantity`/`enteredQuantity` del movimiento se cargan con el mismo valor exacto
(`conversionFactor = 1`) en vez de convertir a la unidad de manejo del producto —
documentado en el propio código: evita cualquier división/multiplicación intermedia que
arriesgue redondeo sobre una cantidad ya calculada con precisión. `sourceDocumentType =
'WEEKLY_CLOSING'`, `sourceDocumentId = WeeklyClosing.id` (mismo mecanismo de trazabilidad
reservado desde Etapa 3) — y, desde Etapa 6.1, también la CLAVE que determina si la
diferencia de un producto ya fue reconciliada por este cierre.

## 9. Snapshot histórico

Al cerrar, se crea una fila `InventorySnapshotItem` por cada producto del conteo
gobernante (con o sin diferencia), etiquetada con la `revision` recién incrementada de su
`WeeklyClosing`. Nunca se recalcula retroactivamente: si se reabre y se vuelve a cerrar
sin un conteo nuevo, la revisión siguiente muestra la MISMA diferencia histórica (copiada
del mismo conteo gobernante), no un valor recién calculado contra el estado actual del
ledger — sólo el AJUSTE aplicado (sección 8) puede diferir entre revisiones.

## 10. Valoración monetaria — DELIBERADAMENTE OMITIDA

Antes de implementar la parte monetaria del snapshot se verificaron, en este orden:

1. **Qué campo de costo/precio existe hoy en `Product` o modelos relacionados:**
   ninguno. `SalesImportRow.unitPriceAvg` (Etapa 5) es un promedio INFORMATIVO de precio
   de VENTA de una línea de ventas ya importada — no es un costo de producto, no está
   asociado a `Product`, y no sirve como fuente de valoración de inventario.
2. **Qué define el documento del cliente:** §12/§13/§23/§46 reservan explícitamente la
   lista de costos/precios para "Hito 1b en adelante" / "fuera del Hito 1".
3. **Conclusión:** no hay ninguna fuente confiable de costo hoy. Se omite por completo
   `cost`/`totalValue` de `InventorySnapshotItem` — inventar FIFO, costo promedio
   ponderado, margen, costo logístico o IVA imputado sin ese respaldo habría violado
   directamente la instrucción de "no inventar" del prompt (sección 10).

**Limitación documentada, no un olvido:** cuando Hito 1b agregue costo/precio a
`Product`, el snapshot de valoración se podrá agregar como una migración nueva
(`InventorySnapshotItem` ganaría columnas opcionales) sin tocar la lógica de cierre ya
construida acá.

> **Resuelto en Etapa 6.2.** Los dos archivos reales de listas de precios/
> costos de Grido llegaron como evidencia nueva; se construyó el modelo
> histórico de precios/costos completo (`PriceReference`/`PriceValue`/
> `PriceReferenceProductMapping`) y `InventorySnapshotItem` ganó
> `unitCostWithTax`/`totalValue`/`priceValueId`, exactamente como se
> anticipaba acá (migración nueva, sin tocar esta lógica de cierre). Ver
> `docs/ETAPA-6.2-CIERRE-INTEGRAL.md`, secciones 2 y 8.

## 11. Idempotencia

Mismo patrón endurecido de Etapa 3.2/4.1/5.1: `closeIdempotencyKey` +
`closeIdempotencyFingerprint` (huella = `{ weeklyClosingId }`) + `@@unique` en Postgres +
UPDATE condicional (`status: OPEN|REOPENED → CLOSED WHERE closeIdempotencyKey IS NULL`) +
resolución explícita de la carrera reconsultando lo que Postgres efectivamente persistió
(nunca asumida sin comparar). Un reintento secuencial con la misma clave devuelve el
mismo resultado sin duplicar snapshot, `COUNT_CORRECTION` ni auditoría — verificado en
tests (sección 16).

`closeIdempotencyKey`/`closeIdempotencyFingerprint` se resetean a `null` en cada
`reopen`, así que el PRÓXIMO cierre usa necesariamente una clave nueva — nunca se
confunde con la revisión anterior.

## 12. Concurrencia

**Decisión explícita: no hace falta aislamiento `Serializable`** (a diferencia de la
Etapa 5.2, donde `ProductAlias` es remapeable en cualquier momento — una ventana TOCTOU
real). Razonamiento verificado leyendo `apps/api/src/services/inventory-count.ts`:
`submitInventoryCount`/`submitInventoryRecount` NUNCA vuelven a tocar
`InventoryCountItem` una vez que el `InventoryCount` llega a `COMPLETED` — es un estado
terminal. Como el checklist exige `countSubmitted` (conteo gobernante `COMPLETED`) antes
de permitir cerrar, leer teórico/real/diferencia ANTES de abrir la transacción de cierre
es seguro: no existe ninguna escritura concurrente posible sobre esos datos entre esa
lectura y el commit.

La protección real contra dos cierres concurrentes de UN MISMO `WeeklyClosing` sigue
siendo el UPDATE condicional + el `@@unique` de `closeIdempotencyKey` (mismo mecanismo que
`reverseMovement` de Etapa 3.1) — nunca un lock en memoria ni un mutex, funciona igual con
una o varias instancias del backend. El ajuste efectivamente aplicado al ledger (sección 8) SÍ se calcula dentro de la transacción de cierre, contra el teórico vigente en ese
instante — sin necesitar `Serializable` porque no hay lectura previa fuera de la
transacción de la que dependa esa cifra.

Verificado con un test de concurrencia real (`Promise.all`, misma clave y claves
distintas) contra Postgres real — ver sección 16.

## 13. Reapertura

Sólo desde `CLOSED`; exige `reason` no vacío (validado en la API con 400, y con un CHECK
de base de datos que exige `reopen_reason IS NOT NULL` cuando `reopened_at IS NOT NULL`).
Un cierre `OPEN`/`REOPENED` no puede "reabrirse" (409).

Al reabrir: `status → REOPENED`; se resetean `closeIdempotencyKey`,
`closeIdempotencyFingerprint`, `reviewConfirmedById`, `reviewConfirmedAt` (el ADMIN debe
volver a confirmar la revisión del checklist antes del próximo cierre); el snapshot de la
revisión anterior (`InventorySnapshotItem` con `revision = currentRevision` vigente) NUNCA
se borra ni se edita. Auditado (`WEEKLY_CLOSING_REOPENED`, con `reason`).

Al volver a cerrar: `currentRevision` se incrementa de nuevo, se genera una fila de
snapshot NUEVA por producto (`revision` incrementada) sin tocar la anterior — ver sección
9 para qué se conserva igual y sección 8 para por qué el ajuste NO se duplica.

## 14. Permisos

Todas las rutas bajo `/api/weekly-closings` exigen `requireRole('ADMIN')` — el documento
del cliente reserva el cierre semanal a la administración (§24, "cierre semanal") y no hay
ningún flujo real que justifique ampliar el acceso a `SHOP_EMPLOYEE` o
`DEPOSIT_MANAGER` (sección 18 del prompt: "no expandir permisos sin respaldo"). Ni la
Shop PWA ni ningún endpoint de otro rol consultan `WeeklyClosing`.

`organizationId` nunca se toma del payload — siempre de `request.currentUser`, mismo
patrón que el resto del backend desde Etapa 1.

## 15. Auditoría

`fastify.audit.logTx` (dentro de la misma transacción, propaga error y hace rollback si
falla) para `WEEKLY_CLOSING_PREPARED`, `WEEKLY_CLOSING_CLOSED` y
`WEEKLY_CLOSING_REOPENED`. `fastify.audit.log` (best-effort) para
`WEEKLY_CLOSING_REVIEW_CONFIRMED` (no crítico: repetirlo sólo actualiza un timestamp, sin
efectos destructivos). Un reintento idempotente de `close` nunca duplica la auditoría —
verificado en tests.

## 16. Tests agregados (backend)

`apps/api/src/routes/weekly-closing.test.ts` — 32 tests (27 de Etapa 6 + 5 de Etapa 6.1),
todos contra Postgres real (mismo criterio que el resto del proyecto desde Etapa 1),
organizados en:

- **Preparación:** cierre nuevo OPEN; preparar el mismo período dos veces no duplica
  (get-or-create); `periodStart` que no es lunes → 400; dos ubicaciones con el mismo
  período no colisionan.
- **Checklist:** `countSubmitted`/`canClose` en falso sin conteo; `countSubmitted` en
  verdadero tras el conteo de `periodStart + 7`; `canClose` sigue en falso sin revisión
  confirmada; `canClose` en verdadero con ambas condiciones; teórico/real/diferencia en
  vivo copiados directamente del conteo (incluye producto con **teórico negativo** y
  aserciones de **precisión Decimal** exacta, ej. `'-5.000'`); ventas importadas
  confirmadas de Etapa 5 reflejadas en el checklist.
- **Cierre:** checklist incompleto → 409 sin NINGÚN efecto (cero movimientos, cero
  snapshot, cero auditoría); cierre exitoso → snapshot completo generado **exactamente
  una vez**, `COUNT_CORRECTION` sólo para las 3 diferencias no nulas de 4 productos
  contados (positiva, negativa, teórico-negativo — la de diferencia cero NO genera
  movimiento); el ledger refleja el nuevo punto de partida tras el ajuste; el snapshot es
  inmutable (reconsultar devuelve exactamente lo mismo); reintento secuencial con la
  misma clave no duplica nada; clave distinta sobre un cierre ya cerrado → 409 sin
  duplicar; **dos cierres concurrentes con la misma clave** (`Promise.all` real) no
  duplican snapshot/ajustes/auditoría; dos cierres concurrentes con claves distintas → uno
  gana (200), el otro 409, sin estado torcido; permisos (`SHOP_EMPLOYEE`/
  `DEPOSIT_MANAGER` → 403 en cerrar/preparar/listar); sin autenticación → 401.
- **Reapertura:** sólo desde `CLOSED` (409 si no); motivo obligatorio (400 si falta);
  reabrir preserva intacto el snapshot de la revisión anterior (comparación explícita
  antes/después); **cerrar de nuevo tras reabrir genera una revisión nueva, conserva la
  historia (ambas revisiones con 4 filas cada una, misma diferencia histórica) y NO
  duplica el ajuste ya aplicado al ledger** (test de regresión dedicado a la corrección
  descripta en la sección 8 — verifica el saldo final exacto, no sólo la ausencia de un
  segundo `COUNT_CORRECTION`); permisos en reapertura.
- **Aislamiento multi-organización:** un cierre de otra organización → 404.
- **Etapa 6.1 — consistencia temporal de la reconciliación** (ver sección 21 más abajo
  para el detalle de cada escenario): TEST A (movimiento posterior al conteo, antes del
  cierre, no se absorbe); TEST B (reapertura con movimiento posterior: recierre no
  duplica el ajuste ni revierte el movimiento); TEST C (producto inconsistente aborta
  TODO el cierre, rollback completo verificado); TEST D (dos cierres concurrentes, un
  único conjunto de correcciones); TEST E (movimiento concurrente durante el cierre,
  resultado determinístico).

Regresión completa: `npm run test` (apps/api) corre los 282 tests del monorepo backend
(17 archivos, incluidas todas las suites de Etapas 1 a 6) — todos verdes.

## 17. Supuestos y decisiones mínimas documentadas

- **Ajuste generado con `conversionFactor = 1`** (sección 8): se prefirió precisión
  Decimal exacta sobre expresar el ajuste en la unidad de manejo habitual del producto —
  reversible sin migrar si se pide lo contrario.
- **Ventana de "ventas importadas del período" para el checklist:** solapamiento entre
  `[SalesImport.periodStart, periodEnd]` (el rango que el propio archivo declara, Etapa 5)
  y `[WeeklyClosing.periodStart, periodEnd]` — es informativo, nunca bloquea el cierre,
  así que un criterio de solapamiento razonable no requiere mayor precisión.
- **`WeeklyClosingChecklist` como cálculo derivado, no tabla propia** — ver sección 4.

## 18. Pendiente / fuera de alcance de Etapa 6

Explícitamente NO implementado, por instrucción directa del prompt (sección 28):

caja semanal, efectivo, Mercado Pago, conciliación, infturnos/turnos, depósito,
transferencias entre ubicaciones, remitos, recepción de mercadería, facturas, FIFO,
compras, proyecciones, IA, clima, eventos, rentabilidad avanzada, valoración monetaria
del snapshot (ver sección 10, explícitamente diferida a Hito 1b), RLS real de
PostgreSQL, comercialización multi-organización (Hito 2).

No se tocó ningún endpoint, servicio, tabla ni pantalla de Etapas 1 a 5.2 más allá de las
adiciones puramente aditivas descriptas acá (nuevas relaciones/tablas en el schema, nuevas
rutas, nuevo ítem de menú).

## 19. Shop PWA — sin cambios (decisión documentada)

Se evaluó la sección 20 del prompt ("sólo hacer cambios si son estrictamente necesarios
para que el ADMIN pueda reconocer que la carga semanal de la sucursal está completa") y se
decidió **no modificar la Shop PWA**: quien necesita reconocer que la semana está
completa es el ADMIN, y el ADMIN no usa la Shop PWA — la nueva pantalla "Cierre semanal"
de admin-web (sección 20) ya expone exactamente esa información (checklist con
`countSubmitted`, ventas importadas, mermas, gastos) sin depender de ningún cambio en la
PWA. Agregar una señal redundante en la PWA hubiera sido una funcionalidad no pedida por
ningún flujo real.

## 20. Admin-web

Pantalla nueva "Cierre semanal" (`apps/admin-web/src/pages/WeeklyClosingPage.tsx`, ruta
`/cierre-semanal`, sólo ADMIN): elegir sucursal, elegir semana (cualquier fecha, calculada
al lunes correspondiente en el navegador — el backend igual valida), ver listado de
cierres existentes, y un panel de detalle con: estado, checklist completo (conteo, ventas,
mermas, gastos, revisión), tabla teórico/real/diferencia/ajuste-generado por producto,
botón "Confirmar que revisé el checklist", botón "Cerrar semana" (deshabilitado con el
motivo exacto de qué falta hasta que `canClose` sea verdadero, mismo criterio de UX que
Etapa 5.1 con la confirmación de ventas), y — sólo para cierres `CLOSED` — un formulario
de reapertura con motivo obligatorio. Sin dashboards ni gráficos avanzados.

## 21. Etapa 6.1 — Consistencia temporal de la reconciliación

Hardening posterior a la entrega inicial de Etapa 6. Corrige una carrera real en
`closeWeeklyClosing` (`apps/api/src/services/weekly-closing.ts`) y un `continue` silencioso
que podía dejar un cierre parcialmente aplicado. No cambia el modelo de datos conceptual,
el checklist, los permisos ni el flujo de admin-web — sólo cómo se decide y aplica el
ajuste `COUNT_CORRECTION` dentro de la transacción de cierre.

### 21.1. Por qué `real histórico − saldo actual` es incorrecto

La versión original de Etapa 6 calculaba, DENTRO de la transacción de cierre:

```
pendingAdjustment = cantidad_real_del_conteo − SUM(InventoryMovement.quantity vigente)
```

Esto parece razonable a primera vista ("cuánto falta para que el ledger refleje lo que el
conteo dijo"), pero el saldo vigente del ledger **no es un valor congelado** — sigue
recibiendo movimientos legítimos (ventas importadas, mermas, bajas de lata, otros ajustes)
en cualquier momento, incluso mientras se está cerrando la semana. Ejemplo concreto (el
mismo que reprodujo el TEST A):

1. El conteo gobernante ya está `COMPLETED`: teórico = 10, real = 12, diferencia
   histórica = +2.
2. Antes de que un ADMIN llegue a apretar "Cerrar semana", entra una venta real de -3
   (legítima, del período siguiente, sin relación con el conteo). Saldo del ledger: 7.
3. `closeWeeklyClosing` calcula `pendingAdjustment = 12 − 7 = +5` y genera un
   `COUNT_CORRECTION` de +5.

Ese +5 es incorrecto: absorbe la venta de -3 como si fuera parte de la diferencia física
que el conteo detectó, cuando en realidad son dos hechos independientes (una diferencia de
conteo de +2, y una venta de -3 ocurrida después). El stock final quedaba en 12 en vez de
9 — un error real de reconciliación, no sólo un problema de duplicación.

La inmutabilidad de `InventoryCount` (una vez `COMPLETED`, nunca se vuelve a tocar) **no
resuelve esto**: protege la LECTURA del conteo, pero `InventoryMovement` sigue siendo
mutable por diseño (es el ledger operativo) y nada impide que reciba movimientos nuevos en
cualquier momento, conteo de por medio o no.

### 21.2. Regla aplicada ahora

El ajuste que se aplica al ledger es SIEMPRE la diferencia histórica congelada del conteo:

```
countCorrectionQuantity = InventoryCountItem.difference   (real − teórico AL MOMENTO DEL CONTEO)
```

Copiada 1:1 desde `InventoryCountItem` (vía `computeLiveItems`) a
`InventorySnapshotItem.difference` — nunca se recalcula contra ningún estado posterior del
ledger, ni al cerrar por primera vez, ni al recerrar. Un movimiento ocurrido después del
conteo (venta, merma, ajuste, otro `COUNT_CORRECTION` de otra semana) nunca puede alterar
cuánto vale este ajuste.

### 21.3. Cómo se sabe si la diferencia ya fue reconciliada (sin mirar el saldo)

En vez de inferir "cuánto falta" comparando contra el saldo actual, `closeWeeklyClosing`
consulta la trazabilidad YA PERSISTIDA del propio ledger, DENTRO de la transacción:

```sql
SELECT id, product_id FROM inventory_movement
WHERE organization_id = :organizationId
  AND location_id = :locationId
  AND movement_type = 'COUNT_CORRECTION'
  AND source_document_type = 'WEEKLY_CLOSING'
  AND source_document_id = :weeklyClosingId   -- constante a través de todas las revisiones
  AND product_id IN (:productIds)
```

`sourceDocumentType`/`sourceDocumentId` es el mecanismo de trazabilidad reservado desde la
migración original del ledger (Etapa 3) — ya usado por `SALE`/`BOM_CONSUMPTION`, no una
tabla nueva. Como `WeeklyClosing.id` es constante a lo largo de todas sus revisiones
(reabrir nunca cambia el id), esta consulta encuentra la corrección de CUALQUIER cierre
previo de ESTE `WeeklyClosing` para el mismo producto:

- **No existe todavía** → se crea un `COUNT_CORRECTION` por la diferencia histórica exacta
  (si es distinta de cero).
- **Ya existe** → la revisión actual REUTILIZA esa misma referencia
  (`InventorySnapshotItem.countCorrectionMovementId` apunta al movimiento YA creado) — no
  se crea un segundo movimiento, no se vuelve a tocar el ledger.

Consecuencia de schema (ver sección 4 y la migración
`20260910120000_weekly_closing_correction_traceability_etapa6_1`): como ahora un mismo
`COUNT_CORRECTION` puede quedar referenciado por varias `InventorySnapshotItem` (una por
cada revisión que lo reutiliza), el UNIQUE anterior sobre
`inventory_snapshot_item.count_correction_movement_id` dejó de ser un invariante válido y
se reemplazó por un índice simple. La garantía real de unicidad se movió al lugar
correcto: un índice único PARCIAL sobre `inventory_movement(organization_id,
source_document_id, product_id) WHERE movement_type = 'COUNT_CORRECTION' AND
source_document_type = 'WEEKLY_CLOSING'` — PostgreSQL rechaza, a nivel de base de datos,
cualquier intento (con o sin bug de aplicación de por medio) de crear un segundo ajuste
para el mismo (cierre, producto).

### 21.4. Movimientos posteriores al conteo, durante el cierre, y tras el primer cierre

Los tres escenarios pedidos quedan cubiertos por el mismo mecanismo, sin necesitar tres
soluciones distintas:

- **Posterior al conteo, antes del cierre** (TEST A): el ajuste sigue siendo la diferencia
  histórica (+2 en el ejemplo); el movimiento posterior (venta -3) se conserva
  íntegramente. Resultado: 7 (tras la venta) + 2 (ajuste) = 9 — nunca 12.
- **Concurrente con el cierre** (TEST E): como el ajuste nunca lee el saldo del ledger, es
  imposible que un movimiento que se inserta "mientras" corre la transacción de cierre
  altere el valor del `COUNT_CORRECTION` — el resultado es determinístico
  independientemente del orden real de ejecución entre ambas operaciones.
- **Tras el primer cierre + reapertura + recierre, sin conteo nuevo** (TEST B): la consulta
  de trazabilidad de la sección 21.3 encuentra el `COUNT_CORRECTION` ya existente y lo
  reutiliza — cero movimientos nuevos, el efecto de cualquier venta/merma ocurrida entre
  medio se conserva intacto.

### 21.5. Rollback ante un producto inconsistente

La versión original tenía:

```ts
if (!product) {
  fastify.log.error(...);
  continue; // saltea este producto y sigue con el resto
}
```

Esto podía dejar, en teoría, un cierre `CLOSED` con snapshot parcial (99 productos con su
fila, 1 sin ella) si algún producto del conteo gobernante no se pudiera resolver. Corregido:
ese `continue` se reemplazó por `throw new InternalError(...)`, dentro de la misma
transacción — Postgres hace ROLLBACK completo: el `WeeklyClosing` NO queda `CLOSED`
(vuelve a su estado previo, `currentRevision` sin incrementar, `closeIdempotencyKey` sin
setear), no queda ningún `InventorySnapshotItem` nuevo, ningún `COUNT_CORRECTION` nuevo, ni
auditoría `WEEKLY_CLOSING_CLOSED`. Verificado en TEST C, forzando la condición mediante un
`Proxy` sobre el cliente de Prisma usado dentro de la transacción (la integridad
referencial de `InventoryCountItem -> Product` hace que este caso sea, en la práctica,
irreproducible por otra vía — la FK ya lo impide a nivel de base de datos; el `throw` es
una defensa adicional, no una validación de negocio esperable).

### 21.6. Estrategia de concurrencia (sin cambios de fondo respecto a Etapa 6)

Sigue sin hacer falta `Serializable`. La causa de la carrera corregida acá NO era "el
`InventoryCount` puede cambiar" (eso ya estaba cubierto — sigue siendo terminal una vez
`COMPLETED`) sino "el ajuste dependía de leer `InventoryMovement`, que SÍ es mutable". La
corrección elimina esa dependencia por completo: el ajuste nunca vuelve a leer
`InventoryMovement` para decidir su valor, sólo para decidir si YA EXISTE uno (una consulta
de existencia, no un cálculo). Esa consulta ocurre DENTRO de la transacción, después del
UPDATE condicional que ya serializa cualquier cierre concurrente de ESTE `WeeklyClosing`
contra sí mismo (Postgres no deja que dos transacciones ganen esa misma fila a la vez) — y
el UNIQUE parcial de la sección 21.3 es la garantía final a nivel de base de datos. Sigue
sin usarse ningún lock en memoria, mutex, cache ni sleep.

### 21.7. Migración

Una migración nueva, `20260910120000_weekly_closing_correction_traceability_etapa6_1`
(no se modificó ninguna migración histórica): reemplaza el UNIQUE de
`inventory_snapshot_item.count_correction_movement_id` por un índice simple, y agrega el
índice único parcial sobre `inventory_movement` descripto en la sección 21.3. Verificada
aplicando limpio desde cero (`prisma migrate deploy` contra una base vacía, las 10
migraciones en orden) antes de dar por terminada la etapa.
