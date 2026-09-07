# Invariantes del Motor de Inventario

Contrato técnico del ledger de inventario (`InventoryMovement`), establecido
en Etapa 3 y reforzado en Etapas 3.1 y 3.2 — ver
`docs/ETAPA-3-MOTOR-INVENTARIO.md`, `docs/ETAPA-3.1-HARDENING-INVENTARIO.md`
y `docs/ETAPA-3.2-IDEMPOTENCIA-CONCURRENTE.md` para el detalle completo. Toda
etapa futura que toque stock (conteo, ventas, mermas, BOM, transferencias,
cierre semanal) debe respetar estos invariantes; ninguna debe escribir stock
por fuera de este ledger.

1. **El stock es siempre la suma de movimientos del ledger.** No existe
   ninguna columna `stock_actual` ni equivalente. El saldo teórico se
   calcula agregando `InventoryMovement.quantity` en el momento de la
   consulta (`getStockBalances`), nunca leyendo un valor cacheado como
   fuente de verdad.

2. **El cálculo de saldo suma TODOS los movimientos, activos y
   revertidos.** Una reversión aporta su propia cantidad de signo opuesto;
   excluir del `SUM` los movimientos con `status = REVERSED` resta el
   original sin sumar de vuelta su efecto y deja el saldo mal calculado.
   `status` nunca es un filtro del cálculo de stock.

3. **Un movimiento confirmado no se edita.** Ningún campo de un
   `InventoryMovement` ya creado se modifica, con una única excepción
   explícita: `status` pasa de `ACTIVE` a `REVERSED` cuando ese movimiento
   se revierte. `quantity`, `enteredQuantity`, `conversionFactor`, `reason`
   y el resto de los campos son inmutables desde el momento de la creación.
   Desde Etapa 3.1 esto no depende únicamente de la disciplina del código de
   aplicación: un trigger `BEFORE UPDATE` en PostgreSQL
   (`trg_inventory_movement_prevent_mutation`) rechaza a nivel de base de
   datos cualquier `UPDATE` que modifique una columna distinta de `status`,
   y cualquier transición de `status` que no sea exactamente
   `ACTIVE → REVERSED`.

4. **Un movimiento confirmado no se borra por el flujo normal.** No existe
   ningún `DELETE` de `InventoryMovement` en el código de aplicación. A
   diferencia de la protección contra `UPDATE` (invariante 3), Etapa 3.1
   NO agrega un trigger que bloquee `DELETE` a nivel de PostgreSQL —
   bloquearlo ahí rompería la limpieza de datos entre tests
   (`resetCoreTables`), que necesita poder truncar la tabla. Una defensa
   real contra un `DELETE` manual en producción (por ejemplo, revocar el
   privilegio `DELETE` al rol de runtime de la aplicación) queda como
   pendiente técnico explícito — ver
   `docs/ETAPA-3.1-HARDENING-INVENTARIO.md`, sección de limitaciones.

5. **Una corrección siempre genera un movimiento nuevo.** Nunca se corrige
   un error de carga mutando el movimiento original — se revierte (crea un
   contramovimiento) o se registra un ajuste nuevo.

6. **Una reversión referencia al movimiento original vía
   `reversesMovementId`**, con cantidad de signo exactamente opuesto a la
   del original, mismo `movementType`, misma ubicación y producto.

7. **Un movimiento original tiene como máximo una reversión: 1 movimiento
   original → 0 o 1 reversión.** Sólo se puede revertir un movimiento cuyo
   `status` sea `ACTIVE`. Intentar revertir un movimiento ya `REVERSED` se
   rechaza (`409 CONFLICT`). Desde Etapa 3.1 esta garantía se sostiene
   incluso ante dos solicitudes de reversión genuinamente concurrentes sobre
   el mismo movimiento: la verificación previa de `status` es sólo un atajo,
   nunca la protección real. La protección real tiene dos capas —
   (a) el `UPDATE` que marca `status = REVERSED` es condicional
   (`WHERE id = $1 AND status = 'ACTIVE'`) y corre dentro de una transacción,
   de modo que PostgreSQL serializa las dos solicitudes por el lock de fila:
   la segunda, al reintentar, encuentra 0 filas en `ACTIVE` y nunca llega a
   crear un contramovimiento; y (b) un índice único parcial en PostgreSQL,
   `inventory_movement_unique_reversal_per_original` sobre
   `(organization_id, reverses_movement_id) WHERE reverses_movement_id IS
NOT NULL`, como garantía estructural final independiente del código de
   aplicación. Ver `docs/ETAPA-3.1-HARDENING-INVENTARIO.md`, sección 2.

8. **Organización consistente.** Todo movimiento y sus referencias
   (ubicación, producto, unidad de entrada, usuario responsable, movimiento
   revertido) pertenecen a la misma organización — garantizado con foreign
   keys compuestas `(organizationId, x)` en PostgreSQL, no sólo con
   validación de backend.

9. **Ubicación y producto consistentes.** Toda ubicación y todo producto
   referenciados por un movimiento existen, en el momento de crearlo, en la
   misma organización y están activos (`active = true`) — un maestro
   inactivo no admite nuevos movimientos, aunque conserva su historial.

10. **Idempotencia semántica de eventos externos, también bajo
    concurrencia: una `idempotencyKey` representa una única operación
    semántica incluso cuando dos requests con esa clave llegan al mismo
    tiempo.** Un mismo `idempotencyKey`, dentro de la misma organización,
    nunca genera dos movimientos. Desde Etapa 3.1 esto se resuelve por
    identidad semántica del payload, no sólo por la clave: al crear el
    movimiento se calcula un fingerprint (`idempotencyFingerprint`) de sus
    campos relevantes (`movementType`, `locationId`, `productId`,
    `enteredQuantity`, `reason`, `occurredAt` — nunca datos generados por el
    servidor como timestamps de auditoría). La regla es simétrica y vale
    tanto para un retry secuencial como para dos requests genuinamente
    concurrentes (Etapa 3.2):

    - **mismo key + mismo fingerprint → mismo resultado**: se devuelve el
      movimiento ya creado (o recién ganado por el otro request, si la
      colisión ocurrió en paralelo), sin crear uno nuevo ni una segunda
      auditoría, y sin responder un error genérico.
    - **mismo key + fingerprint diferente → conflicto**: `409 CONFLICT`, la
      clave nunca se reutiliza silenciosamente para una operación distinta,
      sea el conflicto detectado antes de escribir (chequeo previo) o
      después de que el `UNIQUE` de PostgreSQL rechazó un `INSERT`
      concurrente.

    El `UNIQUE` de PostgreSQL (`@@unique([organizationId, idempotencyKey])`)
    sigue siendo la única fuente de verdad que decide, bajo carrera real,
    cuál de dos escrituras concurrentes gana — la capa de aplicación sólo
    decide cómo responderle al perdedor, distinguiendo por
    `err.meta.target` cuál constraint se violó realmente (nunca asumiendo
    que cualquier violación de unicidad es una colisión de idempotencia).
    Ver `docs/ETAPA-3.1-HARDENING-INVENTARIO.md`, sección 4, y
    `docs/ETAPA-3.2-IDEMPOTENCIA-CONCURRENTE.md` (completo).

11. **Conversiones históricas preservadas.** `conversionFactor` se copia al
    movimiento en el momento de crearlo, desde `Product.
unitsPerHandlingUnit`. Si la equivalencia del producto se corrige
    después, los movimientos ya creados no cambian de cantidad.

12. **Operaciones críticas auditadas transaccionalmente.** Toda alta de
    movimiento (stock inicial, ajuste, reversión) escribe su
    `InventoryMovement` y su `AuditLog` correspondiente dentro de la misma
    transacción de PostgreSQL (`fastify.audit.logTx`). Si la auditoría
    falla, la transacción entera revierte — nunca queda un movimiento
    aplicado sin su auditoría, ni una auditoría de una operación que en
    realidad no se aplicó.

13. **El stock puede ser negativo.** El motor no rechaza ni corrige
    automáticamente un movimiento válido porque el saldo resultante sea
    negativo (decisión de negocio confirmada explícitamente en Etapa 3, ver
    matriz de decisiones de `docs/ETAPA-3-MOTOR-INVENTARIO.md`). Un saldo
    negativo se conserva tal cual en el ledger, sin ajuste automático ni
    stock ficticio para llevarlo a cero.

14. **Cantidades como `NUMERIC`/`Decimal`, nunca `float`.** `quantity` y
    `enteredQuantity` son `NUMERIC(14,3)` en PostgreSQL / `Decimal` en
    Prisma, para no perder precisión al sumar. Ningún cálculo de suma de
    stock se hace con `number` de JavaScript. Desde Etapa 3.1 esta garantía
    se extiende a todo el recorrido de `enteredQuantity`, no sólo al cálculo
    de saldo: viaja como **string decimal** desde el formulario del
    frontend, a través del contrato de API (validado contra
    `DECIMAL_QUANTITY_PATTERN`), hasta el backend, que lo convierte
    directamente con `new Prisma.Decimal(input)` — nunca
    `new Prisma.Decimal(Number(input))` ni ningún paso intermedio por
    `number` de JavaScript. Ver `docs/ETAPA-3.1-HARDENING-INVENTARIO.md`,
    sección 3.
