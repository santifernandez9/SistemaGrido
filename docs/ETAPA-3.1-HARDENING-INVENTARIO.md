# ETAPA 3.1 — Hardening del Motor de Inventario

Versión: 1.0 · Fecha: 2026-09-07 · Autor: Claude (a pedido del socio programador)
Rama: `claude/etapa-3.1-hardening-inventario` (derivada del commit final de
Etapa 3, `acf2029fca1d1ea50a9c328803b7eec6e66385f3`, de
`claude/etapa-3-motor-inventario`)

> Corrección técnica sobre Etapa 3 (`docs/ETAPA-3-MOTOR-INVENTARIO.md`), a
> partir de la auditoría externa que la dejó en veredicto B (parcial,
> existen problemas). No agrega funcionalidad nueva ni adelanta ninguna
> etapa: corrige cuatro problemas técnicos puntuales sobre la implementación
> existente del ledger.

---

## 1. Problemas corregidos

| #   | Problema                                     | Riesgo si no se corregía                                                                                                                            | Estado                                                               |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Doble reversión concurrente                  | Dos requests simultáneos podían generar dos contramovimientos para el mismo original, dejando el saldo mal calculado                                | Corregido                                                            |
| 2   | Precisión decimal atravesando `number` de JS | `enteredQuantity: z.number()` + `valueAsNumber` en el frontend reintroducían el riesgo de imprecisión de punto flotante que Etapa 3 ya decía evitar | Corregido                                                            |
| 3   | Idempotencia sin verificación semántica      | Reenviar la misma `idempotencyKey` con un payload distinto devolvía silenciosamente el movimiento anterior, en vez de señalar el conflicto          | Corregido                                                            |
| 4   | `eslint-disable` introducidos en Etapa 3     | Excepciones al linter en las pantallas de inventario, en contra de la instrucción explícita del prompt de Etapa 3                                   | Corregidos (causa raíz resuelta, no reemplazados por otra excepción) |

Se mantiene sin rediseñar todo lo que ya funcionaba: ledger append-only,
stock derivado de movimientos, stock negativo permitido, movimientos
históricos inmutables salvo `status`, ajustes trazables, reversión mediante
contramovimiento, auditoría transaccional, aislamiento multi-organización,
unidad/cantidad normalizada, idempotencia (ahora reforzada), y las pantallas
Admin Stock/Movimientos.

---

## 2. Reversión concurrente

### Causa

`reverseMovement()` (Etapa 3) verificaba `original.status !== 'ACTIVE'`
**antes** de abrir la transacción y, dentro de ella, hacía un
`UPDATE ... WHERE id = $1` **sin condición de estado**. Dos requests que
leyeran el original casi al mismo tiempo (ambos lo ven `ACTIVE`) podían
completar ambos: cada uno actualizaba el `status` incondicionalmente y
creaba su propio contramovimiento -- el invariante "1 movimiento original →
máximo 1 reversión" no estaba garantizado bajo concurrencia real, sólo bajo
uso secuencial.

### Solución aplicada

Dos capas, ambas en `apps/api/src/services/inventory-ledger.ts` y la
migración `20260907130454_inventory_hardening`:

1. **UPDATE condicional atómico** (la que realmente resuelve la carrera):
   dentro de la transacción, `tx.inventoryMovement.updateMany({ where: {
id, organizationId, status: 'ACTIVE' }, data: { status: 'REVERSED' } })`.
   Postgres toma el lock de esa fila al ejecutar el `UPDATE`; la segunda
   transacción concurrente que apunte a la misma fila espera a que la
   primera confirme y, al reintentar, ya no encuentra la fila en `ACTIVE`
   (`updateResult.count === 0`) -- aborta ahí mismo, sin crear ni auditar
   nada. El chequeo de `original.status` que se hace antes de abrir la
   transacción sigue existiendo, pero ahora es sólo un atajo rápido para el
   caso secuencial obvio (evita abrir una transacción para un pedido que ya
   se sabe inválido), no la protección real.
2. **Índice único parcial** `inventory_movement_unique_reversal_per_original`
   sobre `(organization_id, reverses_movement_id) WHERE reverses_movement_id
IS NOT NULL` -- garantía estructural final de PostgreSQL, independiente
   de que la lógica de aplicación sea correcta: ni siquiera un futuro bug o
   un camino de escritura que no pase por `reverseMovement()` podría dejar
   dos filas revirtiendo al mismo original.

### Garantía DB

Ambas capas son de PostgreSQL, no de aplicación: el `UPDATE` condicional se
apoya en el locking de fila estándar de Postgres (nivel de aislamiento
READ COMMITTED, el default), y el índice único es una constraint real de la
tabla.

### Comportamiento concurrente (verificado con test real, no secuencial)

Con dos requests HTTP disparados a la vez (`Promise.all`, mismo movimiento):

- Exactamente una responde `201` con el contramovimiento creado.
- La otra responde `409 CONFLICT`.
- `reverseCount` = exactamente 1 (`reversesMovementId` apunta al original).
- El original queda `REVERSED`, con su `quantity` intacta.
- La auditoría registra exactamente una reversión (`INVENTORY_MOVEMENT_REVERSED`), nunca dos.
- El saldo final es correcto (`+original -reversión = 0`).
- No queda estado parcial: se verificó además que si la auditoría de la
  reversión falla a mitad de camino, ni el contramovimiento ni el cambio de
  `status` quedan aplicados (la transacción entera revierte) -- ver sección
  "Auditoría transaccional" de `docs/ETAPA-3-MOTOR-INVENTARIO.md`.

Test: `apps/api/src/routes/inventory.test.ts`, "dos reversiones
CONCURRENTES del mismo movimiento: exactamente una gana (Etapa 3.1,
Problema 1)". Complementado por dos tests a nivel de PostgreSQL puro (sin
pasar por el servicio) en `apps/api/src/db-inventory-integrity.test.ts` que
prueban el índice único directamente.

---

## 3. Precisión decimal

### Representación frontend

`apps/admin-web/src/pages/InventoryStockPage.tsx`: los campos de cantidad
(`init-quantity`, `adj-quantity`) pasaron de `<input type="number">` +
`event.target.valueAsNumber` a `<input type="text" inputMode="decimal">` +
`event.target.value` -- el estado del formulario (`CreateInitialStockInput.
enteredQuantity`, `CreateAdjustmentInput.enteredQuantity`) es un `string`
tal cual lo tipeó la persona, nunca convertido a `number` en ningún punto
de ese archivo. Antes de enviar, se valida el formato contra
`DECIMAL_QUANTITY_PATTERN` (el mismo patrón que usa el backend) y se
muestra un error comprensible si no matchea, sin intentar adivinar ni
corregir el valor.

### Representación API

`packages/shared-types/src/inventory.ts`: `CreateInitialStockInput.
enteredQuantity` y `CreateAdjustmentInput.enteredQuantity` pasaron de
`number` a `string`. Contrato antes/después:

```diff
- { "enteredQuantity": 12.375 }
+ { "enteredQuantity": "12.375" }
```

`apps/api/src/routes/inventory.ts` valida el string con un schema Zod
(`decimalQuantitySchema`, basado en `DECIMAL_QUANTITY_PATTERN`: signo
opcional, hasta 3 decimales) -- sólo formato; el signo/cero se valida contra
la operación concreta en el servicio.

### Prisma

`apps/api/src/services/inventory-ledger.ts`: la conversión es
`new Prisma.Decimal(input.enteredQuantity)` -- directo desde el string ya
validado por Zod, **nunca** `new Prisma.Decimal(Number(input))` ni
`Number(input.enteredQuantity)` en ningún punto del camino de escritura. La
validación de signo/cero usa métodos de `Decimal` (`.lte(0)`, `.isZero()`),
no comparaciones sobre un `number` de JS. El único cálculo que involucra
esta cantidad (`enteredQuantity.mul(conversionFactor)`, donde
`conversionFactor` es el entero pequeño y exacto de `Product.
unitsPerHandlingUnit`) se hace con la aritmética propia de `decimal.js`, sin
pasar por punto flotante de JS.

### PostgreSQL

Se mantiene `NUMERIC(14,3)` (la precisión elegida en Etapa 3) sin cambios --
no había ninguna razón técnica para modificarla; el problema estaba
exclusivamente en el tramo frontend/API/Prisma antes de llegar a la base de
datos, que ya persistía con precisión exacta.

### Tests

`apps/api/src/routes/inventory.test.ts`, describe "precisión decimal":
`0.1` se conserva exacto (`"0.100"`); `0.1 + 0.2` (dos movimientos
distintos, sumados por PostgreSQL vía `SUM`) da exactamente `"0.300"`, no
`0.30000000000000004`; `12.375` con factor de conversión 12 da exactamente
`"148.500"`; formatos inválidos (`"abc"`, `"1,5"`, `"1.2345"` -- 4
decimales, `"1.2.3"`, string vacío) se rechazan con `400` sin persistir
nada.

---

## 4. Idempotencia semántica

### Definición

Un mismo `idempotencyKey`, dentro de la misma organización, sólo puede
significar **una** operación. Reenviarlo es válido únicamente si describe
exactamente la misma operación (retry legítimo, ej. el cliente no recibió
la respuesta y reintenta); si describe una operación distinta, es un error
de uso de la clave, no una segunda ejecución silenciosa de "lo que sea que
haya cambiado".

### Fingerprint/comparación

`apps/api/src/services/inventory-ledger.ts`, `computeIdempotencyFingerprint`:
un string JSON canónico de los campos que definen la identidad semántica de
la operación -- `movementType`, `locationId`, `productId`,
`enteredQuantity` (canonicalizado vía `Prisma.Decimal(...).toString()`, así
que `"5"` y `"5.00"` cuentan como la misma cantidad), `reason` (sólo en
ajustes) y `occurredAt` **únicamente si el llamador lo mandó explícito**
(el valor por default del servidor, "ahora", nunca forma parte de la
identidad -- si formara parte, ningún retry sin `occurredAt` explícito
podría coincidir jamás, porque "ahora" cambia en cada llamada).
Deliberadamente NO incluye: `id`, `createdAt`, ni ningún otro valor
generado internamente por el servidor.

Este fingerprint se guarda en la columna `idempotency_fingerprint`
(migración `20260907130454_inventory_hardening`) junto al movimiento, sólo
cuando se mandó `idempotencyKey`.

### Retry (mismo payload)

`resolveIdempotency()`: si ya existe un movimiento con esa
`idempotencyKey` en la organización y su `idempotencyFingerprint` coincide
con el de la request actual, se devuelve ese movimiento tal cual --
`201`, mismo `id`, no se crea nada nuevo.

### Conflicto (payload distinto)

Si existe un movimiento con esa `idempotencyKey` pero el fingerprint NO
coincide, se rechaza con `409 CONFLICT` y un mensaje explícito ("esta clave
de idempotencia ya se usó con datos distintos... no puede reutilizarse para
una operación diferente"). No se crea ningún movimiento nuevo ni se altera
el existente.

### Tests

`apps/api/src/routes/inventory.test.ts`: "idempotencia semántica: reutilizar
la clave con un payload distinto es un conflicto (409), no un retry
silencioso" (cantidad distinta) y "...también detecta payload distinto en
un ajuste (producto distinto, misma key)". El retry idéntico ya estaba
cubierto desde Etapa 3 ("idempotencia: la misma idempotencyKey no genera
dos movimientos") y sigue pasando sin cambios de comportamiento.

---

## 5. ESLint

Se identificaron y eliminaron las 4 excepciones `eslint-disable-next-line
react-hooks/exhaustive-deps` introducidas por Etapa 3 (2 en
`InventoryStockPage.tsx`, 2 en `InventoryMovementsPage.tsx`). Causa raíz:
los efectos de carga inicial/por filtro llamaban a una función (`loadMasters`/
`loadBalances`/`loadMovements`) declarada de nuevo en cada render, que el
linter correctamente marcaba como dependencia faltante -- agregarla tal
cual habría causado un loop de refetch en cada render.

Corrección real (no un silenciamiento con otro mecanismo): esas funciones
pasaron a declararse con `useCallback`, con sus dependencias reales
explícitas (`api`, y para las de filtro también los propios filtros). Al
ser estables mientras esas dependencias no cambian, el `useEffect` que las
llama puede listarlas en su array de dependencias sin disparar un loop --
el linter queda satisfecho porque la dependencia SÍ está expresada
correctamente, no porque se lo silenció.

No se introdujo ningún `@ts-ignore` ni `any` para compensar. No había
ningún `eslint-disable` heredado de una etapa anterior en estos dos
archivos (ambos son enteramente de Etapa 3) que quedara fuera de alcance.

Verificado: `grep -rn "eslint-disable" apps/admin-web/src/pages/InventoryStockPage.tsx apps/admin-web/src/pages/InventoryMovementsPage.tsx` no devuelve ninguna directiva activa (sólo comentarios explicativos que mencionan la palabra).

---

## 6. Migraciones

Una única migración nueva, no se editó ninguna migración ya aplicada de
Etapas 1/2/2.1/3:

```
packages/db/prisma/migrations/20260907130454_inventory_hardening/migration.sql
```

Contenido:

1. `ALTER TABLE inventory_movement ADD COLUMN idempotency_fingerprint TEXT`
   (Problema 3).
2. `CREATE UNIQUE INDEX inventory_movement_unique_reversal_per_original ...`
   -- índice único parcial `(organization_id, reverses_movement_id) WHERE
reverses_movement_id IS NOT NULL` (Problema 1).
3. Función `inventory_movement_prevent_mutation()` + trigger
   `trg_inventory_movement_prevent_mutation` `BEFORE UPDATE` -- protección
   del ledger (ver sección 9 de este documento).

**Verificación de migración limpia**: se recreó una base de datos vacía y se
corrió `prisma migrate deploy` con las 5 migraciones en cadena
(`init_core` → `catalog_masters` → `multi_tenant_composite_fk` →
`inventory_ledger` → `inventory_hardening`), sin errores ni intervención
manual.

---

## 7. Tests

14 tests nuevos:

- `apps/api/src/routes/inventory.test.ts`: +8 (idempotencia semántica ×2,
  precisión decimal ×4, reversión concurrente ×1, auditoría transaccional
  durante una reversión fallida ×1). Total del archivo: 26 → 34.
- `apps/api/src/db-inventory-integrity.test.ts`: +6 (índice único de
  reversión ×2, protección del ledger contra UPDATE destructivo ×4). Total
  del archivo: 17 → 23.

Ningún test anterior se modificó en su intención ni se eliminó -- los
existentes que usaban `enteredQuantity` como `number` se actualizaron
mecánicamente a `string` (mismo comportamiento esperado, sólo el formato
del payload cambió) y uno (`reverses_not_self`) se adaptó para seguir
probando el mismo CHECK por la vía que sigue siendo alcanzable (INSERT en
vez de UPDATE, ya que el nuevo trigger de inmutabilidad bloquea el UPDATE
antes de llegar al CHECK) -- ver sección 9.

**Total**: 163 (cierre de Etapa 3) + 14 nuevos = **177**, 0 fallos.

Desglose completo por paquete: `packages/db` 10, `apps/admin-web` 16,
`apps/api` 147 (133 + 14), `apps/shop-pwa` 4.

---

## 8. CI

No fue necesario modificar `.github/workflows/ci.yml`: el job existente ya
corre `db:migrate:deploy`, que recoge la migración nueva automáticamente
antes de lint/format/typecheck/test/build. CI depende de PostgreSQL real
(servicio `postgres:16` en el workflow) -- los tests de integración y la
migración corren contra esa base real, igual que en desarrollo local; no se
usó ningún mock de base de datos en ningún test de este hardening.

---

## 9. Limitaciones restantes

- **Protección del ledger contra `DELETE`**: se agregó un trigger que
  bloquea cualquier `UPDATE` que no sea `status: ACTIVE -> REVERSED`
  (función `inventory_movement_prevent_mutation`, sección 6), pero
  deliberadamente **no** se bloqueó `DELETE` a nivel de trigger. Motivo:
  `apps/api/src/test/db-helpers.ts` (`resetCoreTables`) depende de poder
  truncar `inventory_movement` entre tests -- un trigger que bloqueara todo
  `DELETE` incondicionalmente rompería la suite completa. Una protección de
  `DELETE` robusta en producción (ej. revocar el privilegio `DELETE` al rol
  de runtime de la aplicación, manteniéndolo sólo en un rol separado de
  migraciones/administración) es una decisión de separación de roles de
  base de datos -- no un simple trigger -- y excede lo que esta corrección
  puntual debía resolver. Hoy, la única protección contra `DELETE` es que
  ningún camino de código de la aplicación lo ejecuta (verificable por
  inspección: `grep -rn "inventoryMovement.delete" apps/api/src` no
  devuelve ningún resultado fuera de los propios helpers de test). Queda
  como pendiente técnico explícito (sección 10).
- El trigger de inmutabilidad compara filas completas vía
  `to_jsonb(NEW) - 'status' IS DISTINCT FROM to_jsonb(OLD) - 'status'` --
  simple y correcto, pero cualquier columna nueva que se agregue a
  `inventory_movement` en el futuro queda automáticamente protegida sin
  tocar el trigger (ventaja), a costa de que el trigger no puede, por
  diseño, permitir selectivamente que una columna nueva sea mutable sin
  volver a evaluar esta decisión explícitamente.

---

## 10. Pendientes

**Bloqueantes**: ninguno.

**No bloqueantes**: ninguno detectado en esta corrección.

**Futuros**:

- Separación de roles de base de datos (rol de runtime de la aplicación sin
  privilegio `DELETE` sobre tablas transaccionales, distinto del rol usado
  para migraciones/tests) para cerrar la protección de `DELETE` mencionada
  en la sección 9 -- requiere diseño de infraestructura, no se resuelve con
  un trigger simple.
- Los pendientes futuros ya documentados en `docs/ETAPA-3-MOTOR-INVENTARIO.md`
  (umbrales de reconteo P-002, política de bajas de lata P-009, eventual
  vista materializada de saldo si el volumen lo justifica) siguen vigentes
  sin cambios.

---

## 11. Desviaciones

NINGUNA respecto de lo pedido en el prompt de corrección.
