# Invariantes del Motor de Inventario

Contrato técnico del ledger de inventario (`InventoryMovement`), establecido
en Etapa 3 — ver `docs/ETAPA-3-MOTOR-INVENTARIO.md` para el detalle
completo. Toda etapa futura que toque stock (conteo, ventas, mermas, BOM,
transferencias, cierre semanal) debe respetar estos invariantes; ninguna
debe escribir stock por fuera de este ledger.

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

4. **Un movimiento confirmado no se borra.** No existe ningún `DELETE` de
   `InventoryMovement` en el código de aplicación.

5. **Una corrección siempre genera un movimiento nuevo.** Nunca se corrige
   un error de carga mutando el movimiento original — se revierte (crea un
   contramovimiento) o se registra un ajuste nuevo.

6. **Una reversión referencia al movimiento original vía
   `reversesMovementId`**, con cantidad de signo exactamente opuesto a la
   del original, mismo `movementType`, misma ubicación y producto.

7. **No existe doble reversión.** Sólo se puede revertir un movimiento cuyo
   `status` sea `ACTIVE`. Intentar revertir un movimiento ya `REVERSED` se
   rechaza (`409 CONFLICT`).

8. **Organización consistente.** Todo movimiento y sus referencias
   (ubicación, producto, unidad de entrada, usuario responsable, movimiento
   revertido) pertenecen a la misma organización — garantizado con foreign
   keys compuestas `(organizationId, x)` en PostgreSQL, no sólo con
   validación de backend.

9. **Ubicación y producto consistentes.** Toda ubicación y todo producto
   referenciados por un movimiento existen, en el momento de crearlo, en la
   misma organización y están activos (`active = true`) — un maestro
   inactivo no admite nuevos movimientos, aunque conserva su historial.

10. **Idempotencia de eventos externos.** Un mismo `idempotencyKey`, dentro
    de la misma organización, nunca genera dos movimientos: la segunda
    llamada con la misma clave devuelve el movimiento ya creado.

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
    stock se hace con `number` de JavaScript.
