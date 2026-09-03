# ETAPA 1 — Base / Core del Sistema

Versión: 1.1 · Fecha: 2026-09-03 · Autor: Claude (a pedido del socio programador)
Rama: `claude/etapa-1-base-core` (derivada de la rama aprobada de Etapa 0.1)

> Este documento describe lo que efectivamente se construyó en Etapa 1: la base
> técnica/estructural sobre la que se apoyarán todas las etapas funcionales
> posteriores. No implementa ninguna funcionalidad de negocio (stock, ventas,
> mermas, BOM, caja, cierres, etc.) — ver sección "Qué NO se implementó (a propósito)".
>
> Fuente normativa de este trabajo: `docs/ETAPA-0-ANALISIS-ARQUITECTURA.md` (v1.2)
> y `docs/ETAPA-0.1-CORRECCIONES.md`. Ninguna decisión aprobada en esos documentos
> fue cambiada en silencio; los ajustes puramente técnicos que sí se tomaron están
> documentados en la sección "Decisiones técnicas autónomas" más abajo.
>
> **Actualización v1.1 (Etapa 1.1)**: incorpora las correcciones de la auditoría
> externa de Etapa 1 — validación organización/ubicación en `updateUser()` (§8.1),
> compensación Auth↔`app_user` en `inviteUser()` (§8.1) y la decisión de auditoría
> transaccional para operaciones críticas futuras (§7.1). Detalle completo en
> `docs/ETAPA-1.1-CORRECCIONES.md`.

---

## 1. Alcance y decisión funcional resuelta antes de empezar

**P-001 (modelo de identidad) quedó RESUELTA** antes de iniciar esta etapa:
cada persona que usa el sistema tiene **su propia cuenta individual**; las
operaciones relevantes quedan asociadas al usuario real que las ejecutó (para
auditoría, trazabilidad, responsabilidad, permisos e historial de acciones). Las
cuentas compartidas por sucursal/rol **no** son el modelo de identidad principal.
Esto está reflejado en `docs/ETAPA-0-ANALISIS-ARQUITECTURA.md` v1.2 (secciones 7,
18.1, 18.2, 18.3, 22, 26, 27) y es la base del modelo `AppUser` de esta etapa.

---

## 2. Decisiones de stack heredadas de Etapa 0 / 0.1 (confirmadas, no cambiadas)

| Capa              | Decisión                                          | Estado                                                                    |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| Frontend          | React + TypeScript, PWA (`apps/shop-pwa`)         | Confirmado, sin cambios                                                   |
| Frontend admin    | React + TypeScript (`apps/admin-web`), sin PWA    | Confirmado, sin cambios                                                   |
| Backend           | Node.js + TypeScript                              | Confirmado, sin cambios                                                   |
| Base de datos     | PostgreSQL, gestionado vía Supabase en producción | Confirmado, sin cambios                                                   |
| Auth              | Supabase Auth                                     | Confirmado, sin cambios                                                   |
| Deploy frontend   | Vercel                                            | Confirmado, no ejecutado en esta etapa (sin CD todavía)                   |
| Deploy backend    | Render                                            | Confirmado, no ejecutado en esta etapa (sin CD todavía)                   |
| ORM / migraciones | Prisma, migraciones versionadas en el repo        | Confirmado por Etapa 0.1 sección 7; versión exacta fijada acá (ver abajo) |
| Monorepo          | npm workspaces, `packages/*` + `apps/*`           | Confirmado por Etapa 0.1                                                  |

Ninguna de estas decisiones fue reabierta ni cambiada. Las únicas decisiones
tomadas en esta etapa son **de versión exacta de herramienta** (no de arquitectura),
permitidas por la regla 27 del prompt de Etapa 1 ("si la decisión es puramente
técnica... podés recomendar la mejor alternativa"):

| Herramienta                 | Versión fijada      | Por qué no "latest"                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `typescript`                | **5.9.3** (exacta)  | El dist-tag `latest` de npm apunta a `7.0.2`, un compilador nativo (Go) recién lanzado, con compatibilidad de ecosistema todavía inmadura. Se fija la última estable de la serie 5.x.                                                                                                                                                                                                                                                            |
| `prisma` / `@prisma/client` | **6.19.3** (exacta) | El dist-tag `latest` del CLI (`prisma`) resuelve a un release candidate `8.0.0-rc.12`. Incluso la serie 7 estable cambia de forma significativa el mecanismo de configuración (`prisma.config.ts` + generador `prisma-client`) respecto a la mayoría de la documentación/tooling actual. Se fija la última estable de la serie 6.x, que ya incluye el nuevo generador `prisma-client` (ver sección Migraciones) pero sobre una base más probada. |
| `eslint-plugin-react-hooks` | **5.2.0** (exacta)  | Las series 6.x/7.x agregan la regla `react-hooks/set-state-in-effect` ("React Compiler"), que marca como error el patrón estándar `useEffect(() => { void load(); }, [])` para carga de datos al montar un componente — un patrón correcto y ampliamente usado, no un bug. Se fija 5.2.0 (reglas clásicas de hooks + `exhaustive-deps`, sin esa regla nueva).                                                                                    |

Runtime de ejecución del backend en producción: **`tsx`** (no `node dist/index.js`).
El generador `prisma-client` de Prisma 6 emite el cliente como **fuente TypeScript**,
no JavaScript precompilado; `packages/db` se consume como fuente TS en todo el
monorepo (mismo patrón que `packages/shared-types` antes de su build, y que
`packages/auth-client`, que no tiene paso de build). `apps/api` usa `tsx` tanto
para `dev` como para `start` por consistencia y para evitar depender de un paso
de compilación adicional sólo para el backend. Documentado acá porque no es una
decisión anticipable en Etapa 0 (depende de una particularidad del generador de
Prisma 6) y determina cómo se debe desplegar el backend en Render.

---

## 3. Estructura del repositorio

```
SistemaGrido/
├── apps/
│   ├── api/            Backend Fastify (Node + TS)
│   ├── admin-web/       Frontend desktop (Admin)
│   └── shop-pwa/        Frontend operativo (heladería/depósito), PWA
├── packages/
│   ├── shared-types/    Tipos TS compartidos entre backend y frontends
│   ├── db/              Cliente Prisma, schema, migraciones, seed
│   └── auth-client/      Cliente de auth/API compartido entre admin-web y shop-pwa
├── docs/                 Documentación de etapas (Etapa 0, 0.1, 1)
├── .github/workflows/    CI
├── package.json           Raíz del monorepo (npm workspaces)
├── tsconfig.base.json      Config TS estricta compartida
├── eslint.config.mjs        Lint (flat config)
└── .prettierrc.json         Formato
```

Todo paquete/app interno se referencia por su nombre de workspace
(`@sistema-grido/shared-types`, `@sistema-grido/db`, `@sistema-grido/auth-client`),
nunca por ruta relativa entre `apps/`/`packages/`.

---

## 4. Modelo de datos (Core)

Implementado en `packages/db/prisma/schema.prisma`, migración
`20260902145407_init_core`. Sólo las entidades estructurales de Etapa 0 (sección
10.1 "Núcleo organizacional" y 10.9 "Auditoría") — ninguna tabla funcional de
etapas futuras.

- **`organization`** — preparado para el futuro modelo multi-organización (Hito 2 /
  SaaS), pero usado hoy con una sola fila (organización única, la de Habash). No
  se implementa ningún flujo de alta/onboarding de organizaciones: eso es
  explícitamente futuro (ver sección "Qué NO se implementó").
- **`location`** — ubicaciones (depósito, heladería, etc.), tipadas por
  `LocationType` (`DEPOT | ICE_CREAM_SHOP | STORE | OTHER`), no hardcodeadas.
  Única por `(organizationId, name)`.
- **`role`** — catálogo de roles operativos confirmados en Etapa 0:
  `ADMIN`, `DEPOSIT_MANAGER`, `SHOP_EMPLOYEE`. `SUPER_ADMIN` (multi-organización,
  Hito 2) no se agrega todavía — no está respaldado como necesidad de Hito 1.
- **`app_user`** — identidad individual (P-001, Opción A). Cada fila es una
  persona física con cuenta propia en Supabase Auth (`authSubject`, único,
  1:1 con `auth.users.id`). `email` único, agregado en esta etapa como
  necesidad técnica del flujo de invitación (ver sección "Desviaciones").
  `defaultLocationId` nulo para ADMIN (acceso a toda la organización).
- **`audit_log`** — infraestructura de auditoría base, append-only.
  `action`/`module`/`entityType` son texto libre a propósito: los módulos
  funcionales futuros (stock, ventas, mermas, caja, cierres) agregan sus
  propias acciones sin requerir una migración de esquema.

Convenciones (heredadas de Etapa 0, sección 10, sin cambios): PK `uuid` con
default aleatorio; `organization_id NOT NULL` en toda entidad operativa;
`created_at` en toda tabla, `updated_at` sólo en catálogos editables in-place;
nunca `DELETE` físico de historial (`audit_log` no tiene `updated_at`); nombres
de tabla/columna en `snake_case` en Postgres vía `@map`/`@@map`, `camelCase` del
lado de TypeScript/Prisma.

---

## 5. Autenticación

Supabase Auth gestiona credenciales y emisión de tokens; el backend **nunca**
maneja contraseñas. En cada request protegido, `apps/api/src/plugins/auth.ts`:

1. Exige `Authorization: Bearer <token>`.
2. Valida el token contra Supabase con `supabase.auth.getUser(token)` (método
   oficial de la SDK — se prefirió a verificar la firma del JWT a mano, que
   requeriría conocer de antemano el algoritmo/clave de cada proyecto Supabase).
3. Busca el `AppUser` correspondiente por `authSubject`. Si no existe, la
   cuenta de Supabase es válida pero no tiene usuario en el sistema (mensaje
   explícito pidiendo que un Admin invite a la persona). Si existe pero
   `active = false`, se rechaza.
4. Deja `request.currentUser` resuelto (id, organización, rol, ubicación por
   defecto) para el resto del handler y para autorización.

**El backend valida el token siempre, en cada request** — nunca confía en que
el frontend ya controló la sesión (regla explícita del prompt, sección 8).

Dos clientes de Supabase separados (`apps/api/src/plugins/supabase.ts`), por
mínimo privilegio:

- Cliente con **anon key**: sólo para `auth.getUser(token)`.
- Cliente con **service role key**: sólo para la Auth Admin API (invitar
  usuarios). Nunca se expone al frontend ni se usa para nada más.

Login/logout: el intercambio de credenciales lo hace el frontend directamente
contra Supabase (`@supabase/supabase-js`). `POST /api/auth/session` y
`POST /api/auth/logout` son el "acuse de recibo" server-side de esos eventos:
registran auditoría con el usuario ya resuelto por `fastify.authenticate`.

---

## 6. Autorización

`apps/api/src/plugins/authorize.ts` expone dos helpers de `preHandler`, usados
siempre **después** de `fastify.authenticate`:

- **`requireRole(...roles)`** — sólo dejan pasar los roles indicados. Usado hoy
  en `/api/users` (ADMIN) y `/api/locations` (ADMIN).
- **`requireLocationAccess(locationId)`** — infraestructura preparada para
  etapas futuras (ninguna ruta de Etapa 1 tiene datos por ubicación en el
  Core). ADMIN siempre pasa; el resto sólo si `locationId` coincide con su
  `defaultLocationId`. Queda lista para usarse sin rediseñar el mecanismo
  cuando aparezcan endpoints con datos de ubicación.

Autorización real **siempre en el backend**. `packages/auth-client`'s
`RequireAuth` (guard de rutas en el frontend) está explícitamente documentado
como una ayuda de UX (ocultar/mostrar navegación), no como control de acceso.

---

## 7. Auditoría

`apps/api/src/plugins/audit.ts` expone `fastify.audit.log(input)`, reutilizable
por cualquier módulo futuro sin tocar el esquema. Nunca lanza: un fallo al
auditar no debe tumbar la operación de negocio que se estaba auditando, pero
sí queda logueado como error de aplicación (Pino) para poder detectarlo.

Usado hoy en: `LOGIN`, `LOGOUT` (módulo `AUTH`), `USER_INVITED`, `USER_UPDATED`,
`USER_DEACTIVATED`, `USER_REACTIVATED` (módulo `USERS`). Constantes centralizadas
en `@sistema-grido/shared-types` (`CORE_AUDIT_MODULES`, `CORE_AUDIT_ACTIONS`).

### 7.1. Decisión arquitectónica: auditoría transaccional para operaciones críticas futuras

**Agregado en Etapa 1.1**, a partir de la auditoría externa de Etapa 1. `fastify.audit.log()`
es, a propósito, **best-effort**: nunca lanza, y un fallo al escribir el registro de
auditoría no revierte ni bloquea la operación de negocio que se estaba auditando (ver
§7 arriba). Eso es correcto y suficiente para los usos actuales de esta etapa (`LOGIN`,
`LOGOUT`, alta/edición/activación de usuarios) — son eventos donde perder una fila de
auditoría en el caso extremo de un fallo de escritura no compromete ninguna garantía
funcional del sistema.

**Esto deja de ser suficiente para operaciones funcionales futuras donde el registro de
auditoría es parte de la garantía de trazabilidad del propio dominio** — por ejemplo (a
título ilustrativo, ninguna de estas se implementa en esta etapa):

- ajustes de inventario;
- cierre semanal;
- anulaciones;
- reversión de movimientos;
- correcciones críticas sobre stock, caja o costos.

Para ese tipo de operación, la modificación de dominio y su registro de auditoría
**deberán ejecutarse dentro de la misma transacción de PostgreSQL** cuando técnicamente
corresponda (es decir: si la escritura de auditoría falla, la transacción completa hace
rollback — la operación de negocio nunca queda aplicada sin su rastro de auditoría). El
mecanismo actual, `fastify.audit.log()` best-effort tal como está hoy, **no debe
reutilizarse tal cual como única garantía de auditoría** para esas operaciones futuras.

Esta etapa no implementa ningún mecanismo de auditoría transaccional nuevo, ni ninguno
de los módulos funcionales listados arriba — sólo deja esta decisión documentada para
que las etapas que sí los implementen no reintroduzcan por descuido el mismo patrón
best-effort donde no corresponde.

---

## 8. Backend (`apps/api`)

Fastify 5, arquitectura de plugins (`fastify-plugin`) registrados en
`src/server.ts`: config → supabase → prisma → error-handler → audit → auth →
cors → rate-limit → rutas. `buildServer(overrides?)` arma la app sin
escucharla en un puerto (la usan tanto `src/index.ts` como los tests, vía
`app.inject()`, sin abrir un socket real).

**Endpoints implementados:**

| Método | Ruta                | Auth    | Rol               | Descripción                                                                                                    |
| ------ | ------------------- | ------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`           | Pública | —                 | Healthcheck: confirma proceso vivo + conexión a DB (`SELECT 1`)                                                |
| POST   | `/api/auth/session` | Sí      | Cualquiera activo | Acuse de sesión iniciada, registra auditoría `LOGIN`                                                           |
| POST   | `/api/auth/logout`  | Sí      | Cualquiera activo | Acuse de cierre de sesión, registra auditoría `LOGOUT`                                                         |
| GET    | `/api/me`           | Sí      | Cualquiera activo | Perfil del usuario autenticado (sin efecto de auditoría)                                                       |
| GET    | `/api/users`        | Sí      | ADMIN             | Lista de usuarios de la organización                                                                           |
| POST   | `/api/users`        | Sí      | ADMIN             | Invitar usuario (Supabase Auth Admin API + fila `app_user`, con compensación ante fallo — ver §8.1)            |
| PATCH  | `/api/users/:id`    | Sí      | ADMIN             | Editar rol/ubicación/nombre/estado activo de un usuario (ubicación validada contra la organización — ver §8.1) |
| GET    | `/api/locations`    | Sí      | ADMIN             | Lista de ubicaciones activas de la organización                                                                |

### 8.1. Correcciones de consistencia aplicadas en Etapa 1.1

A partir de la auditoría externa de Etapa 1, `apps/api/src/services/users.ts` recibió
dos correcciones (detalle completo, motivación y tests en
`docs/ETAPA-1.1-CORRECCIONES.md`):

- **`updateUser()` valida `defaultLocationId` contra la organización del usuario**, con
  la misma regla que ya aplicaba `inviteUser()` (helper compartido
  `assertLocationBelongsToOrganization`): una ubicación sólo puede asignarse si
  `location.organization_id = user.organization_id`. Nunca se confía en el UUID
  recibido, en el rol del usuario ni en datos previos — se revalida en cada request.
  `defaultLocationId: null` (quitar la ubicación) sigue permitido sin cambios.
- **`inviteUser()` compensa una cuenta de Supabase Auth huérfana** cuando la creación
  del usuario en Auth tiene éxito pero la persistencia de `app_user` en PostgreSQL falla
  después (no hay transacción distribuida entre ambos sistemas). La compensación
  elimina **únicamente** el usuario de Auth creado por esa llamada puntual (se conserva
  su id explícitamente, nunca se busca/elimina por email); si la propia compensación
  también falla, se loguea con contexto completo (organización, email, id de Auth,
  error de persistencia y error de compensación) para intervención manual, y la
  operación **nunca devuelve éxito** en ningún escenario de fallo.

`GET /api/locations` **no estaba enumerado explícitamente** en la lista de
endpoints del prompt de Etapa 1 — ver sección "Desviaciones respecto de Etapa 0".

Respuesta uniforme (`@sistema-grido/shared-types`): éxito como
`{ ok: true, data }`, error como `{ ok: false, error: { code, message } }`.
Errores de dominio tipados (`apps/api/src/errors.ts`, subclases de `AppError`)
mapeados a código HTTP por `plugins/error-handler.ts` — ningún handler de ruta
arma una respuesta de error a mano.

---

## 9. Frontend base

Dos SPA independientes con React 19 + Vite + `react-router-dom` 7, ambas
consumiendo `@sistema-grido/auth-client` (contexto de auth, cliente de API,
guard de rutas) para no duplicar esa lógica:

- **`apps/admin-web`** — pantallas: Login, Dashboard (placeholder neutro, sin
  contenido funcional todavía), Usuarios (alta/listado/activar-desactivar,
  la única pantalla funcional real de esta etapa, porque gestión de usuarios
  es parte explícita del Core).
- **`apps/shop-pwa`** — pantallas: Login, Home (placeholder neutro). Mobile-first,
  botones grandes (uso desde el piso de venta).

Ambas con `ErrorBoundary` (evita pantalla en blanco ante un error de render) y
`Layout` con navegación mínima según rol.

---

## 10. PWA (`apps/shop-pwa`)

`vite-plugin-pwa`, `registerType: 'prompt'` (nunca reemplaza la app en uso sin
avisar — `UpdatePrompt.tsx` usa `useRegisterSW` de `virtual:pwa-register/react`
para mostrar un aviso y dejar que la persona decida cuándo actualizar). Manifest
con íconos (**placeholders** generados para esta etapa — `public/icon-*.png`;
reemplazar por assets de marca reales antes de un lanzamiento real). El service
worker precachea sólo el shell estático de la app; no cachea respuestas de la
API ni implementa sincronización offline de datos — eso es una decisión
funcional de etapas futuras (conteo con autoguardado), no algo a inventar acá.

---

## 11. Validación

Zod centralizado en dos frentes:

- **Entrada de config** (`apps/api/src/config.ts`): valida todas las variables
  de entorno al bootear; si falta o es inválida alguna, el proceso no arranca
  y el error lista **todos** los problemas encontrados (no sólo el primero).
- **Entrada de requests** (`apps/api/src/routes/users.ts`): esquemas Zod para
  body/params de cada ruta que recibe input externo.

---

## 12. Manejo de errores

`apps/api/src/errors.ts`: `AppError` abstracta + subclases tipadas
(`ValidationError`, `AuthenticationError`, `AuthorizationError`, `NotFoundError`,
`ConflictError`, `InternalError`), cada una con su código HTTP. El
`error-handler` plugin es el único lugar que arma la respuesta de error;
cualquier error no reconocido se trata como `InternalError` (500) sin filtrar
detalles internos al cliente, y se loguea completo del lado del servidor.

---

## 13. Logging

Pino (`apps/api/src/logger.ts`), logs estructurados (JSON). `redact` configurado
para nunca loguear tokens/headers de autorización ni claves de Supabase, aunque
aparezcan en el objeto de request/config. Nivel configurable por
`LOG_LEVEL` (`fatal|error|warn|info|debug|trace`).

---

## 14. Migraciones (Prisma)

Estrategia confirmada por Etapa 0.1 (sección 7): migraciones versionadas en el
repo (`packages/db/prisma/migrations/`), no `db push`. `prisma.config.ts` (nuevo
mecanismo de Prisma 6, reemplaza el bloque `generator`/env implícito de
versiones anteriores). Dos variables de conexión, explicadas en
`packages/db/.env.example`:

- `DATABASE_URL` — conexión **con pooler** (PgBouncer), la usa el cliente en
  tiempo de ejecución.
- `DIRECT_URL` — conexión **directa**, la usa el CLI de Prisma para
  migrate/generate (PgBouncer no soporta algunas sentencias que las
  migraciones necesitan).

Migración inicial: `20260902145407_init_core`. Verificada de punta a punta en
esta etapa: `prisma migrate deploy` desde una base vacía, dos veces (base de
desarrollo y base de test), sin errores.

---

## 15. Seeds

`packages/db/src/seed.ts` (`npm run db:seed`, sólo para desarrollo local —
nunca se ejecuta en CI ni está pensado para producción): crea los 3 roles
confirmados, **una** organización demo (`"Organización Demo (desarrollo)"`,
sin usar el nombre real del cliente) y 3 ubicaciones genéricas de ejemplo
("Depósito Demo", "Heladería Demo 1", "Heladería Demo 2"). **No crea ningún
usuario** — la primera persona (Admin) se da de alta manualmente contra
Supabase Auth + `POST /api/users` en modo desarrollo (ver sección "Comandos
locales").

---

## 16. Testing

Vitest en todos los paquetes/apps que tienen lógica propia.

| Paquete/app             | Archivos de test | Tests | Qué cubre                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ---------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/db`           | 1                | 1     | Roles confirmados (`ROLE_CODES`)                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/api`              | 6                | 44    | Config (variables inválidas/faltantes), errores tipados, `/health`, flujo completo de auth (token inválido, usuario inexistente, usuario inactivo, sesión válida), flujo completo de usuarios (listar, invitar, editar, activar/desactivar, autorización por rol, validación organización/ubicación en `updateUser`, compensación Auth↔`app_user` en `inviteUser` — Etapa 1.1), `/api/locations` |
| `apps/admin-web`        | 3                | 7     | `ErrorBoundary`, `App` (ruteo protegido por rol), `LoginPage`                                                                                                                                                                                                                                                                                                                                    |
| `apps/shop-pwa`         | 3                | 4     | `ErrorBoundary`, `App`, `LoginPage`                                                                                                                                                                                                                                                                                                                                                              |
| `packages/shared-types` | —                | —     | Sin tests propios (sólo tipos; se ejercitan indirectamente vía los consumidores)                                                                                                                                                                                                                                                                                                                 |
| `packages/auth-client`  | —                | —     | Sin tests propios en esta etapa (se ejercita indirectamente vía `admin-web`/`shop-pwa`, que mockean el paquete completo)                                                                                                                                                                                                                                                                         |

**Total: 56 tests, 13 archivos de test, 100% en verde** (última corrida completa,
confirmada en Etapa 1.1 con una base de datos Postgres real recién creada y
migrada desde cero — no una base reusada de corridas anteriores). 9 tests nuevos
respecto de Etapa 1 (4 de Corrección 1, 5 de Corrección 2 — detalle en
`docs/ETAPA-1.1-CORRECCIONES.md`).

Los tests de `apps/api` corren contra una base Postgres **real**
(`sistemagrido_test`), no mockeada — se consideró más representativo para
infraestructura de auth/autorización/auditoría que dependen directamente del
comportamiento real de Prisma/Postgres. Supabase sí se mockea (no hay
credenciales reales de un proyecto Supabase en este entorno de desarrollo).

---

## 17. CI

`.github/workflows/ci.yml`, job `build-and-test` sobre `ubuntu-latest`, con un
contenedor de servicio Postgres 16 (`sistemagrido_test`). Pasos: checkout →
Node 22 → `npm ci` → auditoría de dependencias (informativa, no bloquea) →
build de `packages/shared-types` → generar cliente Prisma → aplicar
migraciones contra la base de test → lint → formato → typecheck → tests →
build completo. **Sin ningún job de deploy/CD** — corre en cada push a
cualquier rama y en cada PR, tal como pide la sección 21 del prompt.

Esta secuencia fue **validada localmente paso a paso en esta etapa** (instalación
limpia desde cero, dos bases de datos recreadas desde cero, y cada comando de
CI ejecutado con los mismos valores de entorno que usa el workflow) — no es
sólo un archivo escrito sin probar. Resultado: todos los pasos en verde.

---

## 18. Seguridad de referencia

- CORS restringido a orígenes explícitos (`CORS_ORIGINS`), nunca `*`.
- Rate limiting global (`@fastify/rate-limit`, 100 req/min por defecto) contra
  fuerza bruta y abuso básico.
- `trustProxy: true` (Render/Vercel están detrás de un proxy) para que
  `request.ip` en los logs de auditoría sea el real, no el del proxy.
- `SUPABASE_SERVICE_ROLE_KEY` sólo en el backend, nunca en variables `VITE_*`
  (que Vite expone al bundle del navegador).
- Ningún secreto en el repo: `.env` está en `.gitignore`; sólo se versionan
  `.env.example` con placeholders.
- `npm audit --audit-level=high` corre en CI (informativo); en esta etapa,
  `npm audit` local reporta **0 vulnerabilidades** tras fijar
  `deepmerge-ts@^8.0.2` vía `overrides` (parche de una vulnerabilidad alta,
  GHSA-ggr8-5vv4-36mx, que llegaba transitivamente por el paquete de config
  de Prisma).

---

## 19. Variables de entorno (nombres, sin valores)

Ver `.env.example` en cada paquete/app para el detalle documentado de cada una.

**`apps/api`**: `NODE_ENV`, `PORT`, `DATABASE_URL`, `DIRECT_URL`,
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`CORS_ORIGINS`, `LOG_LEVEL`.

**`apps/admin-web`** / **`apps/shop-pwa`**: `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`.

**`packages/db`**: `DATABASE_URL`, `DIRECT_URL`.

---

## 20. Comandos locales

```bash
# Instalar todo el monorepo
npm install

# Copiar los .env.example y completar valores reales (Supabase, Postgres local)
cp apps/api/.env.example apps/api/.env
cp packages/db/.env.example packages/db/.env
cp apps/admin-web/.env.example apps/admin-web/.env
cp apps/shop-pwa/.env.example apps/shop-pwa/.env

# Compilar packages/shared-types (lo consumen el resto de los paquetes como npm package)
npm run build --workspace packages/shared-types

# Migraciones + cliente Prisma
npm run db:generate
npm run db:migrate:dev      # crea/actualiza la base local a partir del schema
npm run db:seed             # roles + organización demo + ubicaciones demo (sólo dev)

# Levantar en paralelo (tres terminales, o un orquestador propio)
npm run dev:api
npm run dev:admin
npm run dev:shop

# Calidad
npm run lint
npm run format:check
npm run typecheck
npm run test
npm run build
```

Alta del primer Admin en desarrollo: crear la persona en Supabase Auth
(Dashboard o Auth Admin API) y luego, con la sesión de esa persona ya
autenticada contra `/api/auth/session`, dar de alta el resto vía
`POST /api/users` desde `apps/admin-web` (pantalla Usuarios) — no hay
seed de usuarios reales, a propósito (ver sección Seeds).

---

## 21. Qué NO se implementó (a propósito)

Explícitamente fuera de esta etapa, tal como lo prohíbe el prompt de Etapa 1:
ledger de stock completo, conteos, importación de ventas, BOM funcional,
mermas, gastos, pesajes, bajas de lata, caja, cierre semanal, integración con
Mercado Pago, reportes, predicción/IA, y cualquier funcionalidad comercial
SaaS multi-empresa completa (billing, onboarding de organizaciones, etc.).
`organization_id` está **preparado** en el modelo de datos para ese futuro,
pero no hay ningún flujo de alta/gestión de organizaciones — hoy el sistema
opera con una única organización.

---

## 22. Desviaciones respecto de Etapa 0

**Una desviación a señalar, no bloqueante:**

`GET /api/locations` (sólo ADMIN) no estaba en la lista explícita de endpoints
enumerados en el prompt de Etapa 1. Se agregó porque la pantalla de alta de
usuarios necesita dejar elegir la `defaultLocationId` del Admin, y `location`
ya es una entidad estructural confirmada del Core desde Etapa 0 (no una
funcionalidad de etapa futura) — no se inventó ningún dato ni tabla nueva,
sólo se expuso lectura de algo que ya estaba modelado. Se señala igual porque
es una adición por fuera de la enumeración literal del prompt, y el criterio
de esta etapa es reportar toda adición de esa clase para auditoría externa,
en vez de decidir en silencio que "no cuenta".

Fuera de eso: **ninguna** desviación respecto de la arquitectura, modelo de
datos o convenciones aprobadas en Etapa 0 / 0.1.

---

## 23. Pendientes

**Bloqueantes para funcionalidad futura (no para cerrar esta etapa):**

- Ninguno nuevo generado por esta etapa. Los pendientes bloqueantes que
  Etapa 0.1 dejó abiertos para etapas _funcionales_ (no de Base/Core) siguen
  abiertos y sin tocar — ver `docs/ETAPA-0.1-CORRECCIONES.md`.

**No bloqueantes:**

- Íconos de PWA son placeholders (sección 10 de este documento) — reemplazar
  por marca real antes de un lanzamiento.
- No hay página de "olvidé mi contraseña" ni flujo de reseteo (Supabase Auth
  lo soporta nativamente; no se pidió explícitamente para esta etapa y no es
  necesario para las pruebas de aceptación).
- `Dashboard` (admin-web) y `Home` (shop-pwa) son placeholders neutros
  intencionales — su contenido real depende de las etapas funcionales.

**Etapas futuras (fuera de todo alcance de Etapa 1, informativo):**

- Todo lo listado en la sección 21 ("Qué NO se implementó").
- Modelo multi-organización real (Hito 2 / SaaS), billing, onboarding.
- Deploy real a Vercel/Render (CD) — hoy sólo hay CI de verificación.

---

## 24. Veredicto de esta etapa

Este documento y el código que describe **no se autoaprueban**. Etapa 1 queda
entregada para auditoría externa. No se avanza a Etapa 2 ni se hace merge
hasta recibir esa autorización — ver cierre del prompt de Etapa 1.
