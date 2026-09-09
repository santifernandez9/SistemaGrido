# ETAPA 4 — App Heladería Operativa

Versión: 1.1 · Fecha: 2026-09-09 · Autor: Claude (a pedido del socio programador)
Rama: `claude/etapa-4-app-heladeria` (derivada del commit aprobado
`c6ea51b` de `claude/etapa-3.2-idempotencia-concurrente`)

> Este documento describe lo que efectivamente se construyó en Etapa 4:
> la primera versión operativa de la App Heladería, con exactamente 6
> capacidades (conteo físico semanal ciego, conteo por sabor con reconteo
> inteligente, baja normal de lata, merma con foto, gasto variable, y "sin
> stock"), pensadas para reemplazar la planilla de papel y el WhatsApp
> ("si una acción tarda más que anotarla en papel, el diseño está mal").
> NO implementa caja, ventas, Mercado Pago, depósito operativo, remitos,
> predicción, IA, FIFO ni multi-tenant real — ver sección 9, "Control de
> alcance".
>
> **Actualización — Etapa 4.1 (hardening final)**: una auditoría posterior
> encontró dos puntos concretos a corregir, ambos ya resueltos sin
> rediseñar nada de lo ya construido: (1) `BULK_FLAVOR_NEARLY_EMPTY_FRACTION`
> traía un default de 0.10 sin respaldo del cliente — se eliminó el
> default; sin configurar, la conversión de `NEARLY_EMPTY` rechaza con un
> error explícito de configuración (sección 6); (2) el reconteo
> (`POST /api/shop/counts/:id/recount`) resolvía la concurrencia sólo con
> el UPDATE condicional de estado, lo que podía darle 409 a un segundo
> request idéntico al primero en vez de reconocerlo como el mismo retry —
> se le agregó idempotencia por clave + fingerprint, mismo patrón que el
> envío original del conteo (sección 4). Este documento se deja actualizado
> in place (no como un documento aparte, dado el alcance acotado de la
> corrección).

---

## 1. Fuente de verdad

Exclusivamente el material del cliente ya relevado (`docs/ETAPA-0-ANALISIS-ARQUITECTURA.md`,
particularmente las secciones 5 ("App Heladería"), 10.3-10.4 (conteo y
diferencias), 11.3-11.4 (correcciones de conteo), 22 (P-001..P-006, pendientes
de confirmación) y la matriz RF/RN) más lo ya construido en Etapas 1-3.2
(catálogo, ledger de inventario, idempotencia). No se inventó ningún
requerimiento nuevo; donde algo no estaba confirmado, se construyó una
estructura configurable y se documentó como supuesto (sección 8).

---

## 2. Modelo de datos

Cinco entidades nuevas, todas con `organizationId` y FKs compuestas
tenant-safe siguiendo el patrón de Etapa 2.1/3 (`(organizationId, x) ->
parent(organizationId, id)`). Ninguna reabre ni duplica lo que Etapa 3 ya
resolvió (el ledger de `InventoryMovement` sigue siendo la única puerta de
escritura de stock).

- **`InventoryCount`** (`inventory_count`) — un conteo semanal por
  ubicación/semana (`@@unique([organizationId, locationId, weekStart])`).
  Estados: `DRAFT` (no usado por el backend — el borrador vive enteramente
  en el dispositivo, ver sección 5), `SUBMITTED`, `RECOUNT_REQUIRED`,
  `COMPLETED`. `idempotencyKey`/`idempotencyFingerprint` obligatorios (a
  diferencia del ledger): el origen es siempre una PWA con conectividad
  intermitente.
- **`InventoryCountItem`** (`inventory_count_item`) — una línea por
  producto: `closedUnits`/`openUnits`/`openFraction` (lo que tipeó la
  empleada) + `physicalQuantity`/`theoreticalQuantity`/`difference`
  (calculados por el backend) + `needsRecount`/`recounted`. CHECK
  constraints agregados a mano en la migración (cantidades ≥ 0, fracción
  sólo si `openUnits > 0`).
- **`Waste`** (`waste`) — 1:1 con el `InventoryMovement` WASTE que genera
  (`movementId` único); sólo agrega lo que el ledger no tiene: la foto
  (`photoPath`, obligatoria). Deliberadamente **sin** columnas de
  idempotencia propias: reutiliza las del movimiento al que está atada
  (evita un segundo mecanismo paralelo para la misma operación).
- **`VariableExpense`** (`variable_expense`) — entidad y transacción
  propias, **fuera** del ledger de inventario (nunca genera un
  `InventoryMovement`). `receiptPath` opcional.
- **`StockoutEvent`** (`stockout_event`) — sólo una incidencia: nunca
  modifica stock, nunca bloquea por saldo negativo. `classification`
  opcional (`URGENT_RESTOCK` / `SUPPLY_SHORTAGE` / `null`).

Migración original de Etapa 4: nueva —
`packages/db/prisma/migrations/20260909113243_shop_ops_etapa4/migration.sql`
— nunca se tocó ninguna migración anterior. Etapa 4.1 (sección 4) agregó
UNA migración adicional, también nueva, sin tocar ninguna de las
anteriores —
`packages/db/prisma/migrations/20260909122635_recount_idempotency/migration.sql`
(dos columnas nullable en `inventory_count` + un índice único; compatible
con una base que ya tenía Etapa 4 aplicada, sin backfill necesario ya que
ambas columnas nacen en `NULL`). Ambas verificadas contra
`sistemagrido_dev`/`sistemagrido_test` y contra una base vacía (los 7
migraciones de la cadena completa, de punta a punta).

---

## 3. Endpoints (`/api/shop/*`, `apps/api/src/routes/shop-ops.ts`)

| Método | Ruta                                       | Roles                                 |
| ------ | ------------------------------------------ | ------------------------------------- |
| POST   | `/api/shop/counts`                         | ADMIN, SHOP_EMPLOYEE, DEPOSIT_MANAGER |
| POST   | `/api/shop/counts/:id/recount`             | ADMIN, SHOP_EMPLOYEE, DEPOSIT_MANAGER |
| GET    | `/api/shop/counts`, `/api/shop/counts/:id` | ADMIN, SHOP_EMPLOYEE, DEPOSIT_MANAGER |
| POST   | `/api/shop/ice-cream-containers/close`     | ADMIN, SHOP_EMPLOYEE                  |
| POST   | `/api/shop/waste`                          | ADMIN, SHOP_EMPLOYEE                  |
| GET    | `/api/shop/waste`                          | ADMIN, SHOP_EMPLOYEE, DEPOSIT_MANAGER |
| POST   | `/api/shop/expenses`                       | ADMIN, SHOP_EMPLOYEE                  |
| GET    | `/api/shop/expenses`                       | ADMIN, SHOP_EMPLOYEE, DEPOSIT_MANAGER |
| POST   | `/api/shop/stockouts`                      | ADMIN, SHOP_EMPLOYEE                  |
| GET    | `/api/shop/stockouts`                      | ADMIN, SHOP_EMPLOYEE, DEPOSIT_MANAGER |
| POST   | `/api/shop/attachments/upload-url`         | ADMIN, SHOP_EMPLOYEE                  |

Roles calcados de los actores CONFIRMADOS por RF, no una regla pareja "todo
el personal de heladería puede todo" (ver sección 8, permisos). Ubicación:
mismo mecanismo que `apps/api/src/routes/inventory.ts`
(`requireLocationAccess`) — ADMIN opera cualquier ubicación, el resto sólo
la propia (`defaultLocationId`).

**Cambio de permisos necesario y agregado en esta etapa**: `GET
/api/products` y `GET /api/products/:id` (Etapa 2, antes sólo ADMIN) ahora
también aceptan SHOP_EMPLOYEE/DEPOSIT_MANAGER — la App Heladería necesita
poder **leer** el catálogo para elegir un producto en cada pantalla. Esto
no es "gestionar catálogo" (crear/editar sigue siendo exclusivo de ADMIN).

---

## 4. Idempotencia

Mismo patrón de Etapa 3.1/3.2 en las cinco operaciones de escritura
originales (conteo, baja de lata, merma, gasto, sin stock): la pareja
`idempotencyKey` / `idempotencyFingerprint`, columna
`UNIQUE(organizationId, idempotencyKey)`, `resolveIdempotency` pre-chequea
antes de insertar, y el `catch` distingue la violación UNIQUE real
(`isUniqueConstraintViolationOn`, por columnas de Postgres, nunca
"cualquier P2002") de una colisión de idempotencia concurrente
(`resolveIdempotencyConflictAfterRace`). Cada operación tiene su propia
clave — nunca se reutiliza una `idempotencyKey` entre operaciones
distintas.

**El reconteo (`POST /api/shop/counts/:id/recount`) sigue exactamente el
mismo patrón desde Etapa 4.1** (corrige el diseño original de Etapa 4, que
resolvía la concurrencia sólo con el UPDATE condicional y podía darle 409 a
un retry legítimo). `InventoryCount` ganó dos columnas propias --
`recountIdempotencyKey`/`recountIdempotencyFingerprint`, nunca las mismas
que el envío original -- con `@@unique([organizationId,
recountIdempotencyKey])` (Postgres no hace colisionar múltiples `NULL`
entre sí, así que esto no afecta a los conteos que nunca pasaron por un
reconteo). El fingerprint incluye `countId` + los productos recontados +
sus valores físicos, canonicalizados (mismo `canonicalItemsForFingerprint`
que usa el envío original, ordenado por `productId`) para que el orden del
array nunca cambie la identidad de la operación.

Flujo: (1) si `recountIdempotencyKey` de este conteo ya coincide con la
clave del request, se compara el fingerprint -- coincide → devuelve el
resultado ya persistido (retry idempotente, sin volver a escribir ni
auditar); no coincide → 409. (2) si todavía no tiene clave, se intenta el
UPDATE condicional (`RECOUNT_REQUIRED -> COMPLETED`, guardando la clave +
fingerprint en la MISMA sentencia, mismo mecanismo de lock de fila que
`reverseMovement` de Etapa 3.1) dentro de una transacción que también
actualiza los ítems y audita -- todo o nada. (3) si esa transacción pierde
la carrera (0 filas afectadas) o choca contra el índice único (reutilizo de
clave en OTRO conteo), `resolveRecountConflictAfterRace` reconsulta lo que
quedó persistido: mismo `countId` + clave + fingerprint → devuelve ese
resultado como éxito; si no coincide → 409. Nunca locks en memoria, mutex
de proceso ni sleeps -- Postgres (el lock de fila del propio UPDATE y el
índice único) es la única fuente de verdad, así que funciona igual con una
o con varias instancias del backend.

---

## 5. Autoguardado (conteo, `apps/shop-pwa/src/lib/countDraftStore.ts`)

Requisito crítico (RN-013: sobrevivir a un corte de conexión, una recarga
accidental o el cierre de la app). Diseño:

- El borrador vive **enteramente en IndexedDB del dispositivo** — no existe
  ningún endpoint de "guardar borrador" en el backend; el servidor sólo
  recibe el conteo ya terminado (`submitInventoryCount`).
- Clave: `${locationId}:${weekStart}` — a lo sumo un conteo en curso por
  ubicación/semana.
- Se genera **una** `idempotencyKey` al empezar a contar y se persiste de
  inmediato (incluso con `items: {}`), para que sobreviva incluso si el
  primer campo tipeado nunca llega a autoguardarse.
- Cada cambio de un campo dispara un `useEffect` que reescribe el borrador
  completo en IndexedDB (sin debounce: el volumen de cambios — decenas de
  taps, no miles de keystrokes — no lo justifica).
- El borrador **sólo se borra tras la confirmación del servidor** (2xx). Si
  el envío falla (red caída), el borrador queda intacto con la MISMA
  `idempotencyKey`, listo para reintentar sin duplicar nada.
- Al montar la pantalla, si ya existe un borrador para esa
  ubicación/semana, se restaura tal cual quedó (probado con un
  unmount/remount real del componente + reinicio del `IDBFactory` global,
  simulando un reload).

---

## 6. Reconteo inteligente

Umbrales de diferencia configurables por variable de entorno
(`RECOUNT_THRESHOLD_CLOSED_PRODUCTS`, `RECOUNT_THRESHOLD_BULK_FLAVOR`),
**deliberadamente sin default**: si no se configuran, el reconteo automático
queda deshabilitado (nunca se marca `needsRecount`) en vez de asumir un
número no confirmado por el cliente. Separados para producto cerrado y
sabor a granel, tal como pide el prompt.

`OpenContainerFraction` (LLENA/3-4/1-2/1-4/CASI_VACÍA): las primeras cuatro
son literales (1, 0.75, 0.5, 0.25); "casi vacía" **no tiene ningún valor
numérico confirmado ni default** (Etapa 4.1, sección 1 — corrige la
versión anterior de esta etapa, que sí traía un default de 0.10 sin
respaldo del cliente). `BULK_FLAVOR_NEARLY_EMPTY_FRACTION` queda
configurable y sin definir por omisión; si una operación necesita
convertir `NEARLY_EMPTY` a cantidad canónica sin esa variable configurada,
`openContainerFractionMultiplier` (`apps/api/src/services/bulk-flavor.ts`)
rechaza con `ConfigurationError` (503, código `CONFIGURATION_ERROR`) antes
de escribir nada — nunca `NaN`, nunca un cero implícito, nunca un número
inventado.

`COUNT_CORRECTION` **no se genera en esta etapa** — el propio
`docs/ETAPA-0-ANALISIS-ARQUITECTURA.md` (sección 11.3) describe ese paso
como posterior a que un ADMIN justifique cada diferencia (RF-017), algo que
el prompt de Etapa 4 explícitamente difiere a "una etapa administrativa
posterior". El conteo guarda la diferencia, la preserva para siempre, y no
toca el ledger.

---

## 7. UX de `apps/shop-pwa`

Home con 5 botones grandes (Conteo, Merma, Baja de lata, Gasto, Sin stock),
sin tablas de escritorio ni confirmaciones innecesarias. Baja de lata: un
único toque (elegir sabor + confirmar), sin cantidad ni motivo. Merma:
producto, cantidad exacta O fracción (radio buttons, nunca ambas), motivo,
foto obligatoria (sube directo a Supabase Storage vía URL firmada — el
backend nunca toca los bytes). Gasto: monto/categoría/descripción,
comprobante opcional. Sin stock: producto + confirmar, sin ningún campo
más.

El formulario físico de papel **no fue provisto**; no se inventaron campos
para imitarlo. La lista de productos a contar es el catálogo activo
completo (no hay una "lista asignada" separada en el material relevado) —
documentado como supuesto (sección 8).

---

## 8. Supuestos documentados (nada de esto es una decisión de negocio inventada)

| #   | Supuesto                                                                                                                                                                                                                  | Dónde                                                            | Reversible sin migrar                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `BULK_FLAVOR_NEARLY_EMPTY_FRACTION` sin valor por defecto (rechaza con `ConfigurationError` si se usa sin configurar)                                                                                                     | `apps/api/src/config.ts`, `apps/api/src/services/bulk-flavor.ts` | Sí, variable de entorno                                    |
| 2   | Umbrales de reconteo sin valor por defecto (deshabilitado hasta configurar)                                                                                                                                               | `apps/api/.env.example`                                          | Sí, variables de entorno                                   |
| 3   | DEPOSIT_MANAGER no registra merma/no da de baja/no gasta/no marca sin stock (RF-024 lo lista, pero P-005 de Etapa 0 deja explícito que sin confirmación se mantiene la restricción ya evidenciada en el prototipo actual) | `apps/api/src/routes/shop-ops.ts` (comentario de cabecera)       | Sí, agregar el rol a `requireRole(...)`                    |
| 4   | La lista de productos a contar es el catálogo activo completo                                                                                                                                                             | `apps/shop-pwa/src/pages/CountPage.tsx`                          | Sí, sin cambio de esquema                                  |
| 5   | GET del catálogo (`/api/products`) habilitado también para SHOP_EMPLOYEE/DEPOSIT_MANAGER (sólo lectura)                                                                                                                   | `apps/api/src/routes/products.ts`                                | N/A — es un requisito funcional, no un supuesto reversible |

---

## 9. Control de alcance

**No se implementó**, y no se avanzó hacia, Etapa 5+: sin importación de
ventas, sin caja, sin Mercado Pago, sin cierre semanal ni snapshot, sin
depósito operativo, sin transferencias/remitos, sin compras/facturas, sin
FIFO, sin transporte, sin IA/predicción/pedidos sugeridos, sin RLS
multi-tenant real, sin onboarding comercial ni facturación. `admin-web`
sólo recibió vistas de **revisión** (`apps/admin-web/src/pages/ShopOpsPage.tsx`),
sin dashboards avanzados ni reportes de rentabilidad.

---

## 10. Pendientes dependientes de datos reales del cliente

- El formulario físico de papel real (para adaptar exactamente los campos
  de conteo si difieren del diseño actual).
- Confirmación del valor numérico de "casi vacía" (hoy sin ningún valor:
  la operación se rechaza con un error de configuración explícito hasta
  que se confirme y configure).
- Confirmación de los umbrales de reconteo (hoy deshabilitado sin config).
- Confirmación de si DEPOSIT_MANAGER debe poder registrar mermas (RF-024 vs
  P-005, hoy resuelto de forma conservadora).
- Catálogo de motivos de merma cerrado (hoy texto libre, sin inventar una
  lista fija) y de categorías de gasto (ídem).

---

## 11. Tests ejecutados

- **Backend** (`apps/api/src/routes/shop-ops.test.ts`, 63 tests -- 56 de
  Etapa 4 + 7 nuevos de Etapa 4.1):
  autenticación/autorización por rol y ubicación; conteo (conversión
  caja+unidad, conversión de sabor con fracción, ciego —
  teórico/diferencia nunca vienen del cliente—, duplicado de producto,
  duplicado de ubicación/semana, idempotencia simple y semántica,
  aislamiento por ubicación y organización, umbral de reconteo separado
  por categoría, sin umbral configurado nunca marca `needsRecount`);
  reconteo (sólo productos marcados, completa el conteo; **Etapa 4.1**:
  retry idempotente por clave sin volver a auditar, retry secuencial con la
  misma clave pero payload distinto → 409, retry con otra clave y payload
  distinto → 409, canonicalización -- mismos ítems en otro orden se
  reconocen como la misma operación --, dos reconteos CONCURRENTES
  idénticos vía `Promise.all` contra Postgres real → ambos 200, un único
  efecto persistido, una sola auditoría, dos concurrentes con la misma
  clave pero payload distinto → uno 200 y el otro 409 con una sola
  auditoría, dos concurrentes con clave y payload distintos → uno 200 y el
  otro 409); **fracción "casi vacía" (Etapa 4.1)**: con
  `BULK_FLAVOR_NEARLY_EMPTY_FRACTION` configurada convierte correctamente,
  sin configurar rechaza con 503 `CONFIGURATION_ERROR` sin persistir nada,
  las cuatro fracciones confirmadas (LLENA/3-4/1-2/1-4) siguen funcionando
  sin necesitar configuración; baja de lata (un único movimiento `ICE_CREAM_CONTAINER_CLOSE`, nunca
  `WASTE`, sin motivo, idempotencia, stock negativo permitido, auditoría);
  merma (genera `WASTE`, reduce el teórico, fracción sólo para sabor,
  cantidad+fracción mutuamente excluyentes, foto y motivo obligatorios,
  idempotencia, stock negativo permitido, auditoría con foto asociada);
  gasto variable (no genera movimiento de inventario, comprobante
  opcional, validaciones, idempotencia, auditoría); sin stock (no modifica
  stock, no bloquea con teórico negativo, clasificación según stock de
  depósito, idempotencia); subida de adjuntos. Además, un test nuevo en
  `products.test.ts` confirma que SHOP_EMPLOYEE puede leer el catálogo sin
  poder gestionarlo.
- **Frontend `shop-pwa`** (`apps/shop-pwa/src/{lib,pages}/*.test.{ts,tsx}`,
  22 tests nuevos): `week.ts` (lunes de la semana, cruces de mes/domingo);
  `countDraftStore.ts` (guardar/leer/sobrescribir/borrar, sobrevive a un
  reload simulado —reinicio del `IDBFactory` global—, borradores de
  ubicaciones distintas no se pisan); `CountPage` (conteo ciego sin
  mostrar teórico/diferencia, fracción sólo para sabor con unidades
  abiertas, envío sin multiplicar en el cliente, autoguardado +
  restauración tras un remount simulando un reload, reintento tras un
  fallo de red usando la MISMA `idempotencyKey` sin borrar el borrador,
  flujo completo de reconteo mostrando sólo los productos marcados);
  `CloseContainerPage`, `WastePage`, `ExpensePage`, `StockoutPage` (flujo
  feliz, validaciones, subida de adjuntos). `App.test.tsx` extendido para
  cubrir los 5 accesos de la home.
- **Frontend `admin-web`** (`apps/admin-web/src/pages/ShopOpsPage.test.tsx`,
  4 tests nuevos): las 4 pestañas de revisión (conteos con detalle de
  diferencias, mermas con foto, gastos, sin stock con clasificación).
- **Regresión**: los 151 tests preexistentes de `apps/api` y los 26 de
  `admin-web`/`shop-pwa` combinados de Etapas 1-3.2 siguen en verde.

**Total**: 291 tests (284 de Etapa 4 + 7 nuevos de Etapa 4.1), todos en
verde (`npm run test` en la raíz del monorepo). Los tests de concurrencia
del reconteo (igual que los de idempotencia de Etapa 3.2) disparan
requests realmente concurrentes con `Promise.all` contra el mismo Postgres
real usado en los tests -- nunca un mock que evite ejercitar la carrera.

---

## 12. Calidad

`npm run lint`, `npm run format:check`, `npm run typecheck` y `npm run
build` (los cuatro a nivel monorepo) terminan sin errores. Ningún `any`,
`eslint-disable`, `@ts-ignore` ni test saltado se agregó para lograrlo.

---

## 13. Confirmación explícita

No se avanzó a Etapa 5 ni posteriores. Todo lo construido en esta etapa
está descrito en las secciones anteriores; cualquier funcionalidad no
mencionada acá (caja, ventas, Mercado Pago, cierre, depósito operativo,
remitos, FIFO, IA, RLS real) **no existe** en esta rama.
