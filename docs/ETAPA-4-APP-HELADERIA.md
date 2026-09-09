# ETAPA 4 — App Heladería Operativa

Versión: 1.0 · Fecha: 2026-09-09 · Autor: Claude (a pedido del socio programador)
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

Migración: **una sola**, nueva —
`packages/db/prisma/migrations/20260909113243_shop_ops_etapa4/migration.sql`
— nunca se tocó ninguna migración anterior. Aplicada y verificada contra
`sistemagrido_dev`/`sistemagrido_test` y contra una base vacía (los 6
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
(conteo, baja de lata, merma, gasto, sin stock): `idempotencyKey` +
`idempotencyFingerprint`, columna `UNIQUE(organizationId, idempotencyKey)`,
`resolveIdempotency` pre-chequea antes de insertar, y el `catch` distingue
la violación UNIQUE real (`isUniqueConstraintViolationOn`, por columnas de
Postgres, nunca "cualquier P2002") de una colisión de idempotencia
concurrente (`resolveIdempotencyConflictAfterRace`). Cada operación tiene su
propia clave — nunca se reutiliza una `idempotencyKey` entre operaciones
distintas.

El reconteo (`POST /api/shop/counts/:id/recount`) es la única excepción: no
tiene su propia columna de idempotencia. Al estar atado a un `countId` ya
existente, la carrera concurrente se resuelve con un UPDATE condicional
atómico (`status: RECOUNT_REQUIRED -> COMPLETED`, mismo patrón que
`reverseMovement` de Etapa 3.1) y el reintento secuencial se reconoce por
**igualdad de valores** contra lo ya guardado — una simplificación
deliberada, documentada, dado el alcance acotado de la operación (un único
reenvío adicional, nunca un loop).

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
son literales (1, 0.75, 0.5, 0.25); "casi vacía" no tiene un valor
numérico confirmado — se usa `BULK_FLAVOR_NEARLY_EMPTY_FRACTION` (default
0.10), documentado como supuesto pendiente de confirmación (sección 8).

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

| #   | Supuesto                                                                                                                                                                                                                  | Dónde                                                      | Reversible sin migrar                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `BULK_FLAVOR_NEARLY_EMPTY_FRACTION = 0.10`                                                                                                                                                                                | `apps/api/src/config.ts`                                   | Sí, variable de entorno                                    |
| 2   | Umbrales de reconteo sin valor por defecto (deshabilitado hasta configurar)                                                                                                                                               | `apps/api/.env.example`                                    | Sí, variables de entorno                                   |
| 3   | DEPOSIT_MANAGER no registra merma/no da de baja/no gasta/no marca sin stock (RF-024 lo lista, pero P-005 de Etapa 0 deja explícito que sin confirmación se mantiene la restricción ya evidenciada en el prototipo actual) | `apps/api/src/routes/shop-ops.ts` (comentario de cabecera) | Sí, agregar el rol a `requireRole(...)`                    |
| 4   | La lista de productos a contar es el catálogo activo completo                                                                                                                                                             | `apps/shop-pwa/src/pages/CountPage.tsx`                    | Sí, sin cambio de esquema                                  |
| 5   | GET del catálogo (`/api/products`) habilitado también para SHOP_EMPLOYEE/DEPOSIT_MANAGER (sólo lectura)                                                                                                                   | `apps/api/src/routes/products.ts`                          | N/A — es un requisito funcional, no un supuesto reversible |

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
- Confirmación del valor numérico de "casi vacía" (hoy 0.10, configurable).
- Confirmación de los umbrales de reconteo (hoy deshabilitado sin config).
- Confirmación de si DEPOSIT_MANAGER debe poder registrar mermas (RF-024 vs
  P-005, hoy resuelto de forma conservadora).
- Catálogo de motivos de merma cerrado (hoy texto libre, sin inventar una
  lista fija) y de categorías de gasto (ídem).

---

## 11. Tests ejecutados

- **Backend** (`apps/api/src/routes/shop-ops.test.ts`, 56 tests nuevos):
  autenticación/autorización por rol y ubicación; conteo (conversión
  caja+unidad, conversión de sabor con fracción, ciego —
  teórico/diferencia nunca vienen del cliente—, duplicado de producto,
  duplicado de ubicación/semana, idempotencia simple y semántica,
  aislamiento por ubicación y organización, umbral de reconteo separado
  por categoría, sin umbral configurado nunca marca `needsRecount`);
  reconteo (sólo productos marcados, completa el conteo, retry idempotente
  por valor, conflicto con valores distintos, dos reconteos concurrentes);
  baja de lata (un único movimiento `ICE_CREAM_CONTAINER_CLOSE`, nunca
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

**Total**: 284 tests, todos en verde (`npm run test` en la raíz del
monorepo).

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
