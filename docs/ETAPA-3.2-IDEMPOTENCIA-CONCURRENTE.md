# ETAPA 3.2 — Cierre de concurrencia en idempotencia

Rama: `claude/etapa-3.2-idempotencia-concurrente` (derivada del commit final
aprobado de Etapa 3.1, `decb43ba9bba4649a8317034bdb93fa7cce06870`).

> Este documento describe el único hardening técnico pendiente para cerrar
> definitivamente Etapa 3, señalado por la auditoría de Etapa 3.1: la
> idempotencia (`idempotencyKey`) resolvía correctamente los retries
> **secuenciales**, pero no garantizaba un comportamiento idempotente
> correcto cuando dos requests con la misma clave llegaban de forma
> **realmente concurrente**. No se rediseñó el motor de inventario ni se
> avanzó a Etapa 4 — ver sección 12.

---

## 1. Problema

El mecanismo de idempotencia de Etapa 3.1 seguía, conceptualmente, este
patrón:

```
buscar idempotencyKey
→ no existe
→ crear movimiento
```

Esto es correcto para un retry secuencial (`create(); create();`), pero es
una simple lectura sin lock: no evita que dos requests concurrentes con la
misma `idempotencyKey` pasen AMBOS por "no existe" antes de que cualquiera
de los dos haya insertado nada:

```
Request A → busca key → no existe
Request B → busca key → no existe

A → INSERT
B → INSERT
```

El `UNIQUE` de PostgreSQL (`@@unique([organizationId, idempotencyKey])`,
existente desde Etapa 3) ya protegía correctamente la integridad: nunca se
duplicó el movimiento ni el stock, en ningún escenario de esta etapa ni de
la anterior. El problema real era exclusivamente de **comportamiento de
API**: el request que perdía la carrera (el `INSERT` que violaba el
`UNIQUE`) podía terminar recibiendo un error incorrecto en vez de
comportarse como el retry idempotente que en realidad es.

---

## 2. Escenario de carrera

Se identificaron y corrigieron **dos** puntos de carrera distintos dentro de
`createInitialStock`/`createAdjustment` (`apps/api/src/services/inventory-ledger.ts`),
no sólo el señalado explícitamente por el prompt:

1. **El `INSERT` final.** Dos requests concurrentes con la misma
   `idempotencyKey` y el mismo payload pueden ambos superar el chequeo
   previo (`resolveIdempotency`, una simple lectura) y llegar a intentar el
   `INSERT` dentro de su propia transacción. Postgres deja pasar sólo a uno;
   el otro recibe una violación `P2002` del `UNIQUE` de `idempotencyKey`.

2. **El chequeo previo de stock inicial ya cargado** (`existingInitial`,
   específico de `createInitialStock`). Es, igual que el anterior, una
   lectura sin lock. Si dos requests comparten `idempotencyKey` (y por lo
   tanto, al formar parte del mismo fingerprint, el mismo
   `locationId`/`productId`), el que llega a este chequeo después de que el
   otro ya **confirmó** su transacción encuentra el `INITIAL_STOCK` recién
   creado y, sin distinguirlo, lo interpretaría como "ya existe un stock
   inicial" — un mensaje y código HTTP incorrectos para lo que en realidad
   es el mismo evento reenviado. Este segundo punto se descubrió al escribir
   el TEST 3 (sección 10): el test falló contra la primera versión de la
   corrección, que sólo cubría el `INSERT` del punto 1, confirmando que la
   carrera real también pasaba por acá.

Ambos puntos comparten la misma causa raíz: una lectura de "¿ya existe?"
seguida de una escritura, sin que la lectura tome ningún lock — el patrón
clásico de TOCTOU (time-of-check to time-of-use).

---

## 3. Solución

Se mantuvo el `UNIQUE` de PostgreSQL como la única fuente de verdad para
decidir quién "ganó" — nunca se debilitó ni se reemplazó por un lock de
aplicación. Se corrigieron los dos puntos:

**Punto 1 (el `INSERT`)**: se envuelve en `try/catch`. Al capturar una
violación de unicidad que corresponde específicamente al constraint de
`idempotencyKey` (ver sección 4), se reconsulta el movimiento por esa
clave y se aplica el mismo criterio de identidad semántica que ya usaba
Etapa 3.1 para el caso secuencial (`resolveIdempotencyConflictAfterRace`):
fingerprint igual → se devuelve el movimiento ganador (retry legítimo);
fingerprint distinto → `409 CONFLICT` real. `createAdjustment`, que en
Etapa 3.1 no tenía ningún `try/catch` alrededor de su `INSERT`, ahora
también lo tiene con el mismo tratamiento.

**Punto 2 (`existingInitial`)**: antes de tratar el hallazgo como "ya existe
stock inicial", se verifica si el request trae `idempotencyKey` y si
coincide con la del movimiento encontrado. Si coincide, se aplica el mismo
criterio de fingerprint (igual → se devuelve el existente; distinto → 409
de idempotencia). Sólo cuando el conflicto no tiene relación con la clave
del request (clave distinta o ausente) se trata como lo que realmente es:
otro stock inicial ya cargado, sin ninguna relación con idempotencia.

En ningún caso se abrió una segunda transacción para "reintentar" el
`INSERT`, ni se introdujo un lock explícito (`SELECT ... FOR UPDATE`) — la
propia constraint `UNIQUE` de PostgreSQL, evaluada de forma atómica por el
motor de base de datos, es la que decide qué transacción gana; la capa de
aplicación sólo decide cómo responderle al perdedor.

---

## 4. Manejo de P2002

Antes de esta etapa, cualquier `P2002` capturado en `createInitialStock` se
interpretaba siempre como "ya existe un stock inicial activo" — exactamente
el bug que señala el prompt: una colisión de `idempotencyKey` podía
reportarse con el mensaje/código equivocado.

Un mismo `INSERT` sobre `inventory_movement` puede violar **dos**
constraints `UNIQUE` distintos según el caso: el de `idempotencyKey`
(`@@unique([organizationId, idempotencyKey])`, declarado en el schema de
Prisma) o el índice único parcial de stock inicial
(`inventory_movement_unique_active_initial_stock`, agregado a mano en la
migración de Etapa 3 porque Prisma no expresa índices parciales
declarativamente). Nunca se asume cuál de los dos fue: se inspecciona
`err.meta.target` de Prisma, que trae las columnas EXACTAS del
constraint/índice que realmente disparó el error — Prisma lo obtiene desde
PostgreSQL, así que funciona igual de bien para el `@@unique` declarativo
que para el índice parcial agregado a mano:

```ts
function isUniqueConstraintViolationOn(err: unknown, targetColumns: readonly string[]): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  if (!Array.isArray(target)) return false;
  return (
    target.length === targetColumns.length &&
    targetColumns.every((column) => target.includes(column))
  );
}

const IDEMPOTENCY_KEY_UNIQUE_TARGET = ['organization_id', 'idempotency_key'] as const;
const INITIAL_STOCK_UNIQUE_TARGET = ['organization_id', 'location_id', 'product_id'] as const;
```

(Verificado empíricamente antes de escribir esta corrección: se provocó cada
una de las dos colisiones por separado contra Postgres real y se inspeccionó
`err.meta` para confirmar el formato exacto de `target` en este proyecto.)

`createInitialStock` ahora, en su `catch`, comprueba primero si el `target`
corresponde a `idempotencyKey` (y sólo si el request efectivamente mandó una
`idempotencyKey`) y resuelve por fingerprint; si no, comprueba si
corresponde al índice de stock inicial y responde el conflicto de "ya
existe" de siempre; cualquier otro error se relanza sin tocar —
`reverseMovement`, que sólo tiene una causa posible de `P2002` en su
`INSERT` (el índice único parcial de reversión, Etapa 3.1), conserva su
manejo genérico sin cambios: no había ninguna ambigüedad ahí que corregir.

---

## 5. Retry idéntico

Dos requests concurrentes con la misma `idempotencyKey` y el mismo payload
(mismo fingerprint semántico definido en Etapa 3.1: tipo de movimiento,
ubicación, producto, cantidad, motivo, fecha efectiva explícita):

- Exactamente **un** movimiento queda persistido.
- Exactamente **una** afectación al stock (el saldo refleja la cantidad una
  sola vez, nunca duplicada).
- **Ambos** requests responden `201`, con el mismo `id` de movimiento en el
  cuerpo — ninguno responde un error genérico ni un `500`.
- Exactamente **una** auditoría (`AuditLog`) — el request que perdió la
  carrera nunca ejecuta `audit.logTx`: su transacción aborta en el propio
  `INSERT`, antes de llegar a auditar nada, así que no hay forma de que
  queden dos registros de auditoría para la misma operación.

---

## 6. Payload incompatible

Dos requests concurrentes con la misma `idempotencyKey` pero payload
incompatible (fingerprint distinto — otra cantidad, otro producto, etc.):

- Exactamente **un** movimiento queda persistido (el que ganó la carrera del
  `UNIQUE`, sin importar cuál de los dos payloads era).
- El request que pierde responde `409 CONFLICT` (código `CONFLICT`), nunca
  un `500` ni un `201` silencioso.
- No se asume cuál de los dos requests gana la carrera — el test
  correspondiente (TEST 2, sección 10) verifica el resultado agregado
  (exactamente un movimiento, exactamente un `409`), no un ganador
  específico.
- No hay doble impacto en stock: el saldo refleja únicamente la cantidad del
  request que ganó.

---

## 7. Stock inicial

`createInitialStock` es el caso más delicado porque tiene DOS motivos
posibles de conflicto que no deben confundirse entre sí (ver secciones 2 y
4): la colisión de `idempotencyKey` (misma operación reenviada, debe
resolver idempotente) y el índice único parcial de stock inicial (otro
stock inicial genuinamente distinto ya cargado para esa
ubicación/producto, debe rechazarse). Se corrigieron ambos puntos de carrera
que podían disparar cada uno (el `INSERT`, sección 3, y el chequeo previo
`existingInitial`, también sección 3) para que, bajo concurrencia real:

- Un retry concurrente idéntico (misma `idempotencyKey`, mismo payload)
  **nunca** se interpreta como "stock inicial ya cargado" — recibe el mismo
  movimiento existente, `201`, sin importar por cuál de los dos puntos de
  carrera pasó.
- El stock inicial sigue existiendo una única vez.
- Una colisión genuina de stock inicial duplicado (dos requests concurrentes
  SIN `idempotencyKey`, o con claves distintas, para la misma
  ubicación/producto) sigue rechazándose con el mensaje de "ya existe un
  stock inicial activo" de siempre — no se debilitó esa protección.

---

## 8. Ajustes

`createAdjustment` no tiene ningún constraint `UNIQUE` propio más allá del
de `idempotencyKey` (no existe, para `ADJUSTMENT`, un equivalente al índice
de stock inicial), así que su corrección es más simple: se envolvió el
`INSERT` (que en Etapa 3.1 no tenía ningún `try/catch`) para que una carrera
sobre la misma `idempotencyKey` no termine como `500` cuando corresponde a
un retry legítimo, con el mismo criterio de fingerprint que el resto de las
operaciones. Igual que en `createInitialStock`, se valida `err.meta.target`
antes de asumir la causa — no se captura indiscriminadamente cualquier
`P2002`.

---

## 9. Auditoría

Un retry concurrente que simplemente devuelve una operación ya persistida
**no** crea una segunda auditoría. Esto no requirió ningún cambio adicional
de diseño: como la resolución de la carrera ocurre reconsultando el
movimiento ganador DESPUÉS de que la transacción perdedora ya abortó (o,
en el caso de `existingInitial`, sin abrir ninguna transacción), el camino
que pierde la carrera nunca ejecuta `fastify.audit.logTx` — no hay
auditoría "fantasma" de una segunda modificación que en realidad no
ocurrió. Verificado explícitamente en el TEST 1 (sección 10): tras dos
ajustes concurrentes idénticos, `AuditLog` tiene exactamente una fila para
esa operación.

No se debilitó ninguna transacción existente: `createInitialStock` y
`createAdjustment` siguen envolviendo movimiento + auditoría en un único
`fastify.db.$transaction(...)` (Etapa 3), y la reconsulta tras una colisión
de idempotencia (`resolveIdempotencyConflictAfterRace`) es una simple
lectura fuera de transacción — no persiste nada, así que no hay riesgo de
dejar un registro a medias.

---

## 10. Tests concurrentes

Nuevo `describe('idempotencia concurrente (Etapa 3.2)')` en
`apps/api/src/routes/inventory.test.ts`, con paralelismo real
(`Promise.all` contra Postgres real, nunca `await a(); await b();`):

- **TEST 1** — dos ajustes concurrentes, misma `idempotencyKey` y mismo
  payload: verifica `movement count = 1`, ambos requests `201` con el mismo
  `id`, saldo afectado una única vez, y una única fila de auditoría.
- **TEST 2** — dos ajustes concurrentes, misma `idempotencyKey`, payload
  distinto (otra cantidad): verifica exactamente un movimiento persistido,
  códigos `[201, 409]` (sin asumir cuál gana), y que el saldo refleja sólo
  una de las dos cantidades.
- **TEST 3** — stock inicial, misma `idempotencyKey` y mismo payload,
  concurrente: verifica que ningún request recibe el mensaje de "stock
  inicial ya cargado", ambos responden `201` con el mismo `id`, y que sigue
  existiendo un único `INITIAL_STOCK` para esa combinación. Este test
  falló contra la primera versión de la corrección (sólo el `INSERT`) y fue
  el que reveló el segundo punto de carrera de `existingInitial` — ver
  sección 2.
- **TEST 4** — dos altas de stock inicial concurrentes, SIN
  `idempotencyKey`, mismo producto/ubicación: confirma que una violación
  `UNIQUE` genuinamente distinta a la de `idempotencyKey` no se absorbe
  erróneamente como retry — responde `[201, 409]` con el mensaje de stock
  inicial duplicado, no uno de idempotencia.

Los cuatro se corrieron 3 veces seguidas de forma aislada
(`vitest -t "Etapa 3.2"`) para descartar flakiness — sin fallos.

---

## 11. Resultado CI

No fue necesario modificar `.github/workflows/ci.yml`: no hay migración
nueva (sección 12) ni ningún paso adicional que agregar — el job existente
ya corre lint/format/typecheck/test/build contra Postgres real de servicio
en cada push, y los tests de concurrencia de esta etapa corren dentro de la
misma suite de integración de `apps/api` que ya usaba Postgres real desde
Etapa 3.

## Migraciones

**No fue necesaria ninguna migración.** El único constraint relevante
(`@@unique([organizationId, idempotencyKey])`) ya existía desde Etapa 3; el
índice único parcial de stock inicial, desde Etapa 3 también. Esta etapa es
puramente una corrección de la capa de aplicación (cómo se interpreta y
responde una violación de esos constraints ya existentes), no un cambio de
esquema — no se creó una migración vacía.

---

## 12. Pendientes

**Bloqueantes**: ninguno.

**No bloqueantes**: ninguno.

**Futuros**:

- Los mismos pendientes ya documentados en
  `docs/ETAPA-3.1-HARDENING-INVENTARIO.md` (protección de `DELETE` a nivel
  de rol de base de datos) siguen vigentes, sin cambios por esta etapa.
- Si en una etapa futura se agrega una tercera operación que use
  `idempotencyKey` (por ejemplo, al implementar `PURCHASE_RECEIPT` u otro
  tipo `RESERVADO`), debe aplicar el mismo patrón de manejo de `P2002` por
  `target` documentado en la sección 4 — no capturar `P2002` genéricamente.

Con este hardening, no queda ningún problema técnico pendiente de los
señalados por la auditoría de Etapa 3.1 para cerrar Etapa 3.

---

Ver también `docs/ETAPA-3-MOTOR-INVENTARIO.md` (diseño original del
ledger), `docs/ETAPA-3.1-HARDENING-INVENTARIO.md` (hardening previo:
reversión concurrente, precisión decimal, idempotencia semántica
secuencial, `eslint-disable`) y `docs/INVARIANTES-INVENTARIO.md` (contrato
técnico vigente, actualizado por esta etapa).
