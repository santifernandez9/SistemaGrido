# ETAPA 6 — Cierre Semanal del Núcleo

Versión: 1.0 · Rama: `claude/etapa-6-cierre-semanal`

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
"el real pasa a ser el nuevo punto de partida operativo". Se generó, entonces, un
movimiento `COUNT_CORRECTION` por producto con diferencia pendiente — tipo YA reservado
en el ledger desde la migración original de Etapa 3 (`inventory_movement.reason IS NOT
NULL OR movement_type NOT IN ('ADJUSTMENT','COUNT_CORRECTION')`), sin necesidad de tocar
el ledger.

**Decisión de diseño no trivial, verificada con un test de regresión dedicado** (ver
sección 16, "recierre no duplica el ajuste"): el ajuste efectivamente aplicado al ledger
**no** es la diferencia histórica congelada del conteo. Es, calculado DENTRO de la misma
transacción de cierre:

```
ajuste_pendiente = cantidad_real_contada − teórico_VIGENTE_del_ledger_en_este_instante
```

Por qué: si se usara siempre la diferencia congelada del conteo, un `WeeklyClosing`
reabierto y vuelto a cerrar (sin un conteo nuevo — no existe forma de generar uno para la
misma semana, ver sección 11) volvería a aplicar el MISMO ajuste una segunda vez, dejando
el ledger mal (doble corrección). Calculando contra el teórico vigente, la primera vez que
se cierra el ajuste pendiente coincide exactamente con la diferencia histórica (nada más
tocó el ledger todavía); en un recierre posterior sin conteo nuevo, el teórico vigente ya
quedó reconciliado por el `COUNT_CORRECTION` anterior, así que el ajuste pendiente da
CERO y no se genera un segundo movimiento — exactamente lo que pide §16.1 ("el real pasa a
ser el nuevo punto de partida").

El snapshot (`InventorySnapshotItem.difference`) sigue mostrando SIEMPRE la diferencia
HISTÓRICA original del conteo, sin importar cuántas veces se recierre — es un campo
puramente informativo/histórico, distinto del ajuste que efectivamente se aplicó
(`countCorrectionMovementId`, `null` cuando no hubo ajuste pendiente esa vez).

Nunca se genera un `COUNT_CORRECTION` cuando el ajuste pendiente da exactamente cero.

`quantity`/`enteredQuantity` del movimiento se cargan con el mismo valor exacto
(`conversionFactor = 1`) en vez de convertir a la unidad de manejo del producto —
documentado en el propio código: evita cualquier división/multiplicación intermedia que
arriesgue redondeo sobre una cantidad ya calculada con precisión. `sourceDocumentType =
'WEEKLY_CLOSING'`, `sourceDocumentId = WeeklyClosing.id` (mismo mecanismo de trazabilidad
reservado desde Etapa 3).

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

`apps/api/src/routes/weekly-closing.test.ts` — 27 tests nuevos, todos contra Postgres
real (mismo criterio que el resto del proyecto desde Etapa 1), organizados en:

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

Regresión completa: `npm run test` (apps/api) corre los 277 tests del monorepo backend
(17 archivos, incluidas todas las suites de Etapas 1 a 5.2) — todos verdes junto con los
27 nuevos de Etapa 6.

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
