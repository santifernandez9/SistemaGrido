# ETAPA 1.1 — Correcciones de consistencia y atomicidad

Versión: 1.0 · Fecha: 2026-09-03 · Autor: Claude (a pedido del socio programador)
Rama: `claude/etapa-1-base-core` (misma rama de Etapa 1, sin merge a `main`)

> Este documento responde exclusivamente al "PROMPT 1.1 — CORRECCIONES DE ETAPA 1 /
> BASE CORE", resultado de la auditoría externa de Etapa 1. Cubre únicamente los tres
> puntos pedidos: (1) consistencia organización↔ubicación al modificar usuarios, (2)
> consistencia Supabase Auth↔`app_user` durante el alta, (3) tests correspondientes, y
> (4) aclaración documental sobre auditoría transaccional futura. No se tocó ningún
> módulo funcional fuera de alcance, no se avanzó a Etapa 2 y no se hizo merge.

---

## 1. Hallazgos corregidos

1. **`updateUser()` no revalidaba que `defaultLocationId` perteneciera a la organización
   del usuario.** `inviteUser()` sí lo hacía al crear, pero al editar un usuario ya
   existente se podía escribir cualquier UUID de ubicación recibido del cliente sin
   comprobar que fuera de la misma organización — abriendo la puerta a asociar
   `usuario organización A → ubicación organización B`.
2. **`inviteUser()` podía dejar un usuario huérfano en Supabase Auth.** El alta de un
   usuario ocurre en dos sistemas sin transacción distribuida entre ellos: primero se
   crea la cuenta en Supabase Auth, después la fila `app_user` en PostgreSQL. Si el
   primer paso tenía éxito y el segundo fallaba (por ejemplo, una violación de
   constraint), la cuenta de Auth quedaba creada y visible en el proyecto de Supabase,
   pero sin ningún `app_user` correspondiente en el sistema — inconsistente y sin
   ningún mecanismo para detectarlo o revertirlo.

---

## 2. Archivos modificados

- `apps/api/src/services/users.ts` — corrección 1 (validación de ubicación en
  `updateUser`, factorizada en un helper compartido con `inviteUser`) y corrección 2
  (compensación de la cuenta de Auth ante fallo de persistencia).
- `apps/api/src/test/supabase-mock.ts` — se agregó soporte al doble de prueba para
  `auth.admin.deleteUser` (`mockDeleteUser`, `mockDeleteUserThrows`,
  `getDeleteUserCalls`, `resetSupabaseMock`), necesario para poder testear la
  compensación sin un proyecto Supabase real.
- `apps/api/src/routes/users-flow.test.ts` — 9 tests nuevos (detalle en sección 6);
  se agregó `resetSupabaseMock()` al `beforeEach` para aislar el estado del mock del
  doble de Supabase entre tests.
- `docs/ETAPA-1-BASE-CORE.md` — nueva sección 7.1 (decisión arquitectónica de
  auditoría transaccional para operaciones críticas futuras — corrección 3), nueva
  sección 8.1 (resumen de las correcciones 1 y 2 aplicadas), tabla de endpoints y
  tabla de tests actualizadas (35 → 44 tests en `apps/api`, 47 → 56 en total),
  encabezado actualizado a v1.1.

Archivo creado: `docs/ETAPA-1.1-CORRECCIONES.md` (este documento).

---

## 3. Validación organización/ubicación implementada

`apps/api/src/services/users.ts` ahora expone un helper privado compartido:

```ts
async function assertLocationBelongsToOrganization(
  fastify: FastifyInstance,
  organizationId: string,
  locationId: string,
): Promise<void> {
  const location = await fastify.db.location.findFirst({
    where: { id: locationId, organizationId },
  });
  if (!location) {
    throw new ValidationError('La ubicación indicada no existe en esta organización');
  }
}
```

`inviteUser()` ya lo usaba conceptualmente (ahora llama al mismo helper, sin cambiar su
comportamiento observable) y `updateUser()` lo llama ahora también, **antes** de
persistir el `update`:

```ts
if (input.defaultLocationId !== undefined && input.defaultLocationId !== null) {
  await assertLocationBelongsToOrganization(fastify, organizationId, input.defaultLocationId);
}
```

Puntos clave, tal como pedía la corrección:

- La regla se aplica **en el backend**, contra la base de datos, en cada request — no
  se confía en el frontend, en el UUID recibido, en el rol del usuario ni en los datos
  previos del registro.
- Si `defaultLocationId` viene `undefined` (el campo no se mandó), no se toca — sigue
  el comportamiento previo de "actualización parcial".
- Si `defaultLocationId` viene `null` explícito, se **conserva el comportamiento
  existente**: quita la ubicación asignada, sin ninguna validación adicional (no se
  inventó una regla nueva de obligatoriedad de ubicación — el prompt lo pidió
  explícitamente).
- El error usa el mecanismo ya existente del Core: `ValidationError` (400,
  `VALIDATION_ERROR`), la misma clase y el mismo mensaje que ya usaba `inviteUser()`
  para el mismo caso — no se agregó una segunda estrategia de manejo de errores.

---

## 4. Estrategia compensatoria Auth implementada

`inviteUser()` ahora conserva explícitamente el id que Supabase devolvió para esa
invitación puntual (`createdAuthUserId = data.user.id`) y envuelve la creación de
`app_user` en un `try/catch`:

```ts
try {
  const created = await fastify.db.appUser.create({ data: { ..., authSubject: createdAuthUserId }, include: { role: true } });
  return mapToProfile(created);
} catch (dbError) {
  await compensateOrphanedAuthUser(fastify, {
    authUserId: createdAuthUserId,
    email: input.email,
    organizationId,
    dbError,
  });
  throw dbError; // el error original de persistencia nunca se reemplaza ni se oculta
}
```

`compensateOrphanedAuthUser()` intenta `fastify.supabase.admin.auth.admin.deleteUser(authUserId)`
usando **únicamente** el id conservado de esa llamada — nunca busca ni elimina por
email, y nunca toca un usuario preexistente (ver sección 5). Nunca lanza: cualquier
error propio de la compensación se atrapa y se loguea, sin reemplazar el error
original que ya va a propagarse.

## 5. Comportamiento si falla la compensación

Tres desenlaces posibles después de un fallo de persistencia en PostgreSQL, todos con
el mismo resultado hacia el cliente (nunca éxito) y distinto nivel de detalle en el
log del servidor (Pino, nunca en la respuesta HTTP):

| Escenario                                                                    | Qué hace la compensación                                                                 | Resultado para el cliente                                                                                                                                                            | Log                                                                                 |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| DB falla, compensación exitosa                                               | Se elimina el usuario de Auth recién creado                                              | Error (mismo código que hubiera dado el fallo de DB — normalmente 500 `INTERNAL_ERROR`, o el tipo de `AppError` correspondiente si la falla es una violación de una regla ya tipada) | `warn` con `authUserId`, `email`, `organizationId`, `dbError`                       |
| DB falla, `deleteUser` responde `error`                                      | No se pudo revertir el usuario de Auth: queda huérfano                                   | Error, igual que arriba — nunca éxito                                                                                                                                                | `error` con `authUserId`, `email`, `organizationId`, `dbError`, `compensationError` |
| DB falla, la llamada a `deleteUser` lanza una excepción (ej. timeout de red) | Igual que el caso anterior — se captura también ese caso, no sólo la respuesta `{error}` | Error, nunca éxito                                                                                                                                                                   | `error` con el mismo contexto (`compensationError` es la excepción atrapada)        |

En los tres casos el **error original de persistencia** (`dbError`) es el que se
relanza y el que determina la respuesta HTTP — la compensación nunca sustituye ese
error ni convierte el resultado en éxito. No se implementó reconciliación automática
(reintentos, jobs de limpieza, etc.): si la compensación falla, queda un usuario de
Auth huérfano y el log deja el contexto necesario (organización, email, id de Auth,
ambos errores) para resolverlo a mano. Se documenta como pendiente no bloqueante en
la sección 10.

---

## 6. Tests

**Cantidad anterior**: 47 tests totales (35 en `apps/api`, en 6 archivos).
**Cantidad nueva**: 56 tests totales (44 en `apps/api`, mismos 6 archivos — todos los
tests nuevos se agregaron a `users-flow.test.ts`, sin crear un archivo nuevo).

Los 9 tests agregados, todos contra una base PostgreSQL real (no mockeada):

**Corrección 1 — validación organización/ubicación (`updateUser`)**

1. Caso válido: usuario y ubicación de la misma organización → `PATCH` permitido (200).
2. Caso inválido: usuario de organización A, ubicación de organización B → `PATCH`
   rechazado (400 `VALIDATION_ERROR`), y se confirma que el usuario **no** quedó
   modificado.
3. Caso inexistente: `defaultLocationId` no existe → rechazado (400 `VALIDATION_ERROR`).
4. Caso `null`: se confirma que `defaultLocationId: null` sigue funcionando para quitar
   una ubicación ya asignada (200).

**Corrección 2 — consistencia Supabase Auth ↔ `app_user` (`inviteUser`)** 5. Caso normal: Auth creado + `app_user` creado → 201, y se confirma que
`deleteUser` **no** se llamó. 6. Falla PostgreSQL después de crear Auth: se fuerza una colisión real de constraint
única (`auth_subject`) en Postgres (sin mockear Prisma) para que `appUser.create()`
falle genuinamente después de que el mock de Supabase ya "creó" el usuario. Se
confirma: la respuesta es un error (500), se llamó a `deleteUser` con exactamente
el id recién creado por esa operación, y no quedó ningún `app_user` con el email de
la operación fallida. 7. Falla también la compensación: mismo escenario, pero `deleteUser` responde con
`error`. Se confirma: la respuesta sigue siendo error (nunca éxito), se registra el
problema (se espía `app.log.error` y se confirma que se logueó con `authUserId`,
`dbError` y `compensationError` presentes) y no quedó ningún `app_user` huérfano. 8. Usuario preexistente: Supabase informa que el email ya está registrado (`data.user`
nulo + `error`) → 409 `CONFLICT`, y se confirma que `deleteUser` **nunca** se llamó
(no hay nada que compensar; no se creó nada nuevo). 9. La propia llamada a `deleteUser` lanza una excepción (no sólo responde `error`) →
se confirma que también se maneja ese caso: error, `deleteUser` se llamó con el id
correcto, sin `app_user` huérfano.

---

## 7. Resultado lint / typecheck / test / build

Corrida completa sobre todo el monorepo después de las correcciones, en este entorno:

| Verificación                               | Resultado                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `npm run lint` (ESLint, todo el repo)      | ✅ Verde, 0 problemas                                                                    |
| `npm run format:check` (Prettier)          | ✅ Verde, 0 problemas                                                                    |
| `npm run typecheck` (todos los workspaces) | ✅ Verde, 0 errores                                                                      |
| `npm run test` (todos los workspaces)      | ✅ Verde — **56/56 tests**, 13 archivos                                                  |
| `npm run build` (todos los workspaces)     | ✅ Verde — `shared-types`, `api`, `admin-web` y `shop-pwa` compilan/buildean sin errores |
| `npm audit --audit-level=high`             | ✅ 0 vulnerabilidades                                                                    |

No se deshabilitó ningún test, no se redujo ninguna validación existente, y no se
agregó ningún `any`, `eslint-disable`, `@ts-ignore` ni exclusión de cobertura.

## 8. Resultado CI

`.github/workflows/ci.yml` no necesitó cambios (mismos pasos que en Etapa 1: install →
build de `shared-types` → generar cliente Prisma → migrar la base de test → lint →
formato → typecheck → tests → build). La secuencia completa fue validada localmente en
esta corrección, paso a paso, con los mismos comandos y las mismas variables de entorno
que usa el workflow — ver tabla de la sección 7. No hubo cambios de esquema (no se
agregó ninguna migración nueva), así que `prisma migrate deploy` sigue siendo un no-op
sobre una base ya migrada.

---

## 9. Auditoría transaccional futura documentada

Agregado a `docs/ETAPA-1-BASE-CORE.md`, sección 7.1: `fastify.audit.log()` sigue siendo
best-effort (no revierte la operación de negocio si falla) y **eso es correcto para los
usos actuales de Etapa 1** (login/logout, alta/edición/activación de usuarios). Queda
documentado explícitamente que para operaciones funcionales futuras donde la auditoría
sea parte de la garantía de trazabilidad del dominio — ajustes de inventario, cierre
semanal, anulaciones, reversión de movimientos, correcciones críticas — la modificación
de dominio y su registro de auditoría deberán ejecutarse dentro de la **misma
transacción de PostgreSQL** cuando corresponda, y que el mecanismo best-effort actual no
debe reutilizarse tal cual como única garantía de auditoría para esos casos. No se
implementó ningún mecanismo nuevo ni ninguno de esos módulos — es sólo una decisión
documentada para etapas futuras.

---

## 10. Pendientes detectados

**Bloqueantes**: ninguno.

**No bloqueantes**:

- Si la compensación de Auth también falla (Auth creado, DB falla, `deleteUser`
  también falla), el usuario de Auth queda huérfano hasta que alguien lo revise a mano
  con el log estructurado que se deja (organización, email, id de Auth, ambos
  errores). No se construyó reconciliación automática — el propio prompt de esta
  corrección lo excluye explícitamente ("No hace falta construir un sistema completo
  de reconciliación").
- No existe todavía un job/endpoint administrativo para listar o resolver cuentas de
  Auth huérfanas detectadas por este mecanismo. Queda como recomendación para una
  etapa futura si en la práctica llega a ocurrir con cierta frecuencia.

**Futuros** (informativo, fuera de todo alcance de esta corrección y de Etapa 1):

- Implementación real de auditoría transaccional (misma transacción de PostgreSQL)
  para los módulos funcionales que la necesiten (inventario, cierre semanal,
  anulaciones, reversiones, correcciones críticas) — documentada como decisión, no
  implementada (sección 9).
- Todo lo ya listado como fuera de alcance en `docs/ETAPA-1-BASE-CORE.md`, sección
  "Qué NO se implementó (a propósito)" — sin cambios.

---

## 11. Desviaciones

**NINGUNA.** Ambas correcciones se implementaron con el mecanismo de errores y la
arquitectura ya existentes (sin agregar una segunda estrategia de manejo de errores,
sin nueva infraestructura de reconciliación, sin cambiar el modelo de datos ni las
migraciones). No se modificó ningún módulo fuera de los tres puntos pedidos por el
prompt de corrección.
