# Etapa 2.1 — Integridad multi-organización en catálogo

> Corrección técnica sobre Etapa 2 (`docs/ETAPA-2-CATALOGO-MAESTROS.md`). No
> agrega funcionalidad nueva ni adelanta ninguna etapa: sólo refuerza, a nivel
> de PostgreSQL, el aislamiento entre organizaciones que las entidades de
> catálogo (Producto, Categoría, Tipo de producto, Unidad de manejo, Sabor) ya
> tenían validado en el backend.

## 1. Problema detectado

Todas las relaciones creadas en Etapa 2 entre entidades de catálogo
(Producto→Categoría, Producto→Tipo de producto, Producto→Unidad de manejo,
Producto→Sabor, Categoría→Categoría padre) se implementaron como foreign
keys de **una sola columna** (el `id` de la entidad referenciada), a pesar de
que tanto la entidad hija como la padre tienen `organizationId`.

Eso significa que, mirando sólo el esquema de PostgreSQL, nada impedía que un
producto de la Organización A quedara asociado a una categoría, tipo, unidad
o sabor de la Organización B: la única barrera contra ese caso era la
validación del lado del backend (`apps/api/src/services/catalog.ts`,
funciones `assertCategoryValid`, `assertProductTypeValid`,
`assertUnitOfMeasureValid`, `assertFlavorValid`, `assertValidParentCategory`).
Esa validación es correcta y necesaria para dar un error claro al usuario,
pero no es la que Etapa 0 exige como garantía final (RNF-011: aislamiento
multi-organización debe estar garantizado, no sólo verificado en el camino
feliz de la API).

## 2. Riesgo

Cualquier vía de escritura a la base de datos que no pase por
`apps/api/src/services/catalog.ts` (una migración de datos futura, un script
administrativo, un bug en una validación, acceso directo a la base en
soporte/operaciones) podía crear una fila de `product` o `category` con
`organizationId` distinto al de la entidad que referencia. Eso rompería el
aislamiento multi-tenant (RNF-011) de forma silenciosa: un administrador de
la Organización A podría, sin saberlo, terminar viendo/editando un producto
que en realidad depende de una categoría de la Organización B, o un reporte
futuro por organización podría filtrar datos entre organizaciones distintas.

## 3. Relaciones revisadas

Se revisó **cada relación entre entidades creadas o tocadas en Etapa 2**, más
las relaciones de Etapa 1 que comparten la misma forma (para clasificarlas,
aunque su corrección quede fuera de alcance de este prompt).

| Entidad hija | Entidad padre | Scope hija | Scope padre | Protección backend (Etapa 2) | Protección DB (antes de 2.1) | Protección DB (después de 2.1) |
| --- | --- | --- | --- | --- | --- | --- |
| Product | Category | Por organización | Por organización | `assertCategoryValid` | FK simple (`categoryId → category.id`) | **FK compuesta** (`organizationId, categoryId → category.organizationId, category.id`) |
| Product | ProductType | Por organización | Por organización | `assertProductTypeValid` | FK simple | **FK compuesta** |
| Product | UnitOfMeasure | Por organización | Por organización | `assertUnitOfMeasureValid` | FK simple | **FK compuesta** |
| Product | Flavor (opcional) | Por organización | Por organización | `assertFlavorValid` | FK simple | **FK compuesta** (no se exige si `flavorId` es NULL) |
| Category | Category (grupo padre, opcional) | Por organización | Por organización | `assertValidParentCategory` | FK simple (self-referencial) | **FK compuesta** (no se exige si `parentCategoryId` es NULL) |
| Product | Organization | Por organización | Raíz | — (`organizationId` viene del usuario autenticado, nunca del body) | FK simple | Sin cambio (ya es la relación raíz, no hay ambigüedad posible) |
| Category / ProductType / UnitOfMeasure / Flavor | Organization | Por organización | Raíz | ídem | FK simple | Sin cambio (mismo motivo) |

Relaciones de Etapa 1 con la misma forma de riesgo, **fuera de alcance de este
prompt** (el prompt pide corregir específicamente el catálogo de Etapa 2), se
dejan documentadas como pendiente no bloqueante en la sección 14:
`AppUser.defaultLocationId → Location.id` y `AuditLog.locationId →
Location.id` (ambas relacionan dos entidades por-organización con FK simple).

## 4. Relaciones protegidas

Las 5 relaciones marcadas en negrita en la tabla de la sección 3 pasaron de
FK simple a **FK compuesta `(organization_id, <fk>) → tabla_padre
(organization_id, id)`** en esta corrección:

1. `product.category_id` → `category`
2. `product.product_type_id` → `product_type`
3. `product.unit_of_measure_id` → `unit_of_measure`
4. `product.flavor_id` → `flavor` (nullable)
5. `category.parent_category_id` → `category` (self-referencial, nullable)

Con esto, un `INSERT`/`UPDATE` que intente asociar una fila hija a una fila
padre de otra organización es rechazado por PostgreSQL mismo (violación de
foreign key, código `23503` / `P2003` visto desde Prisma), **incluso si nunca
pasa por la validación del backend**.

## 5. Entidades globales (si existen)

Se revisó cada entidad del esquema para decidir si su alcance es
"por organización" o global, sin agregar `organizationId` mecánicamente a
ninguna:

- **`Role`**: **global**, intencional. No tiene `organizationId` — los 3
  roles (ADMIN, DEPOSIT_MANAGER, SHOP_EMPLOYEE) son un catálogo técnico fijo
  del sistema (Etapa 0, sección 7), compartido por todas las organizaciones.
  Esto ya era así desde Etapa 1; Etapa 2.1 no lo modifica, sólo lo confirma
  explícitamente. `AppUser.roleId → Role.id` sigue siendo una FK simple: es
  correcta tal cual, porque el padre (`Role`) no tiene `organizationId` con
  el cual formar una FK compuesta.
- **`Organization`**: es la raíz del modelo multi-tenant, no tiene un scope
  "padre" del cual protegerse.
- Todas las demás entidades del esquema (`Location`, `AppUser`, `AuditLog`,
  `Category`, `ProductType`, `UnitOfMeasure`, `Flavor`, `Product`) son
  **por organización** (`organizationId NOT NULL`) — ninguna se reclasificó
  como global en esta corrección.

## 6. Cambios en Prisma

En `packages/db/prisma/schema.prisma`:

- Se agregó `@@unique([organizationId, id])` a `Category`, `ProductType`,
  `UnitOfMeasure` y `Flavor` — es el prerequisito de Prisma/PostgreSQL para
  que una fila pueda ser el destino de una FK compuesta que incluya
  `organizationId` (no se puede referenciar `(organizationId, id)` desde una
  FK si esa combinación no tiene, a su vez, una constraint única propia). No
  se agregó a `Product` porque, en el alcance de Etapa 2, ninguna otra
  entidad referencia a `Product`.
- Se cambiaron las 5 relaciones listadas en la sección 4 de
  `fields: [xId], references: [id]` a
  `fields: [organizationId, xId], references: [organizationId, id]`.
- No se tocó ninguna otra relación, ni las de Etapa 1 (`Location`, `AppUser`,
  `AuditLog`), ni la relación raíz `*.organization` de cada entidad de
  catálogo (single-column, correcta porque `Organization` no tiene un padre
  del cual protegerse).
- Se mantiene Prisma como ORM único, sin SQL crudo fuera de la migración.

## 7. Constraints PostgreSQL

Generados por Prisma a partir del esquema (ver migración, sección 8) y
verificados manualmente en la base de datos de desarrollo:

- 4 nuevos índices únicos: `category_organization_id_id_key`,
  `flavor_organization_id_id_key`, `product_type_organization_id_id_key`,
  `unit_of_measure_organization_id_id_key`.
- 5 foreign keys reemplazadas por su versión compuesta:
  `category_organization_id_parent_category_id_fkey`,
  `product_organization_id_category_id_fkey`,
  `product_organization_id_product_type_id_fkey`,
  `product_organization_id_unit_of_measure_id_fkey`,
  `product_organization_id_flavor_id_fkey`.
- Las 2 relaciones nullable (`parent_category_id`, `flavor_id`) usan el
  comportamiento estándar de PostgreSQL para FKs compuestas con `MATCH
  SIMPLE` (el default): si **cualquier** columna de la FK es NULL, la
  constraint no se evalúa para esa fila. Es el comportamiento correcto y
  buscado: una categoría raíz (`parentCategoryId = NULL`) o un producto sin
  sabor (`flavorId = NULL`) siguen permitidos sin restricción adicional.
- `onDelete: Restrict` se mantiene igual que en Etapa 2 en las 5 relaciones.

## 8. Migración

Nueva migración versionada (no se editó ninguna migración ya aplicada de
Etapa 1 ni de Etapa 2):

```
packages/db/prisma/migrations/20260903131703_multi_tenant_composite_fk/migration.sql
```

Contenido: 5 `DROP CONSTRAINT` (las FK simples viejas), 4 `CREATE UNIQUE
INDEX` (los nuevos `@@unique([organizationId, id])`) y 5 `ADD CONSTRAINT`
(las FK compuestas nuevas) — generada con `prisma migrate diff` contra el
esquema corregido y aplicada con `prisma migrate deploy` (el entorno de este
agente no admite el modo interactivo de `prisma migrate dev`, así que se usó
el flujo no interactivo equivalente: `diff` para el SQL, `deploy` para
aplicarlo — mismo resultado, sin editar migraciones existentes).

**Falla explícita ante datos inconsistentes preexistentes**: el script no
contiene ninguna lógica de limpieza, borrado o corrección de datos. Si ya
existiera una fila con `organization_id` cruzado respecto de su padre, los
`ADD CONSTRAINT` de PostgreSQL fallan directamente (PostgreSQL no puede
crear una FK que alguna fila existente viole) y la migración se detiene sin
aplicar cambios parciales. En este caso concreto no había datos
inconsistentes (el catálogo real importado en Etapa 2 es de una sola
organización), así que la migración se aplicó sin necesidad de intervención
manual — pero el comportamiento ante datos inconsistentes es "fallar y
detenerse", nunca "corregir en silencio".

**Verificación de migración limpia** (ver sección 10 del reporte final): se
recreó una base de datos vacía y se corrió `prisma migrate deploy` con las 3
migraciones (`20260902145407_init_core` → `20260903120307_catalog_masters` →
`20260903131703_multi_tenant_composite_fk`) en cadena, sin errores.

## 9. Tests nuevos

Nuevo archivo `apps/api/src/db-multi-org-integrity.test.ts` (8 tests). A
diferencia del resto de los tests de `apps/api`, estos usan el cliente de
Prisma **directamente**, sin pasar por `app.inject()` ni por
`services/catalog.ts` — es decir, bypasean tanto la API HTTP como la
validación del backend, para probar exclusivamente la garantía de
PostgreSQL:

- Rechaza una subcategoría cuyo grupo padre es de otra organización.
- Permite una subcategoría cuyo grupo padre es de la misma organización.
- Rechaza un producto cuya categoría es de otra organización.
- Rechaza un producto cuyo tipo de producto es de otra organización.
- Rechaza un producto cuya unidad de manejo es de otra organización.
- Rechaza un producto cuyo sabor es de otra organización.
- Permite un producto sin sabor (`flavorId = null`), confirmando que la FK
  compuesta nullable no bloquea el caso normal.
- Permite un producto con las 4 referencias (categoría, tipo, unidad, sabor)
  válidas y de la misma organización.

Cada caso de rechazo verifica que la promesa de Prisma se rechaza con
`Prisma.PrismaClientKnownRequestError` código `P2003` (violación de foreign
key) — no un simple `toThrow()` genérico, para confirmar que el rechazo
viene realmente de la constraint de base de datos.

## 10. Resultado de regresión

Los 112 tests reportados al cierre de Etapa 2 siguen pasando sin
modificarse ni deshabilitarse ninguno. Total actual: **120 tests** (112 +
8 nuevos), en 22 archivos, 0 fallos:

| Paquete | Tests |
| --- | --- |
| `packages/db` | 10 |
| `apps/admin-web` | 16 |
| `apps/api` | 90 (82 previos + 8 nuevos) |
| `apps/shop-pwa` | 4 |
| **Total** | **120** |

## 11. Resultado de calidad

Gate completo corrido sobre el estado final de la rama, todo verde:

- `npm run lint` — sin errores ni warnings.
- `npm run format:check` — sin diferencias.
- `npm run typecheck` — sin errores en los 6 paquetes/apps.
- `npm run test` — 120/120.
- `npm run build` — build de producción de los 4 paquetes/apps compilables.

Ningún `any`, `@ts-ignore`, `eslint-disable` ni test deshabilitado se agregó
para llegar a este resultado.

## 12. Resultado CI

No fue necesario modificar `.github/workflows/ci.yml`: el job existente ya
ejecuta `npm run db:migrate:deploy` (que aplica automáticamente cualquier
migración nueva encontrada en `packages/db/prisma/migrations`) antes de
correr lint/format/typecheck/test/build. La nueva migración de esta
corrección se recoge sin cambios en el workflow. CI se dispara con el push
de esta rama; no se deshabilitó ni se saltó ningún paso.

## 13. Impacto en staging

No se redesplegó a staging en esta corrección (no hay credenciales de
Vercel/Render/Supabase disponibles para este agente — mismo estado que al
cierre de Etapa 2, ver `docs/ETAPA-2-CATALOGO-MAESTROS.md`, sección
"Staging"). Si en el futuro se aplica esta migración contra un proyecto de
Supabase con datos reales ya cargados, el paso manual (`docs/ETAPA-2-CATALOGO-MAESTROS.md`,
sección "Migraciones en staging") debe correr **esta migración después** de
las dos anteriores, con el mismo procedimiento (`prisma migrate deploy`
manual y controlado). No se requiere ningún paso adicional fuera de aplicar
la migración: si el catálogo real ya está correctamente aislado por
organización (como lo está, dado que Etapa 2 sólo maneja una organización
por ahora), la migración se aplica sin fricción. Si existiera algún dato
cruzado real, la migración fallaría explícitamente en ese momento (ver
sección 8) y habría que resolverlo antes de reintentar — nunca de forma
automática.

## 14. Pendientes

**Bloqueantes**: ninguno.

**No bloqueantes**:

- `AppUser.defaultLocationId → Location.id` y `AuditLog.locationId →
  Location.id` (ambas Etapa 1) tienen la misma forma de riesgo descrita en
  la sección 1 (FK simple entre dos entidades por-organización) pero quedan
  fuera de alcance de este prompt, que pide corregir específicamente el
  catálogo de Etapa 2. Se documentan acá para que quede explícito y no se
  pierda de vista, no porque se haya decidido que no importan.

**Futuros**:

- Si en una etapa posterior se agrega una tabla operativa (stock, ventas,
  BOM, etc.) que referencie a `Product`, `Category`, etc., debe replicar el
  mismo patrón de FK compuesta contra `organizationId`, no una FK simple.

## 15. Desviaciones

NINGUNA respecto de lo pedido en el prompt de corrección.
