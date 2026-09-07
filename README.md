# Sistema Grido

Sistema de control de stock, caja y rentabilidad para Heladerías Grido
(Heladerías Habash). Monorepo con backend, dos frontends (panel de
administración y app operativa PWA para heladería/depósito) y paquetes
compartidos.

> Este repositorio está en **Etapa 3.1 — Hardening del Motor de Inventario**:
> además de la base técnica (auth, usuarios, roles, auditoría) y el catálogo
> (Productos, Categorías, Sabores, con aislamiento multi-organización
> garantizado también en PostgreSQL), ya existe el ledger append-only de
> movimientos de inventario -- el stock nunca se edita directamente, siempre
> es la suma de sus movimientos -- con stock inicial, ajustes y reversiones
> operables desde el panel de Admin. Etapa 3.1 corrigió cuatro problemas
> técnicos señalados por la auditoría externa de Etapa 3 (reversión
> concurrente, precisión decimal, idempotencia semántica, `eslint-disable`)
> sin rediseñar lo que ya funcionaba. Todavía no implementa la experiencia
> operativa de la heladería (conteo semanal, mermas, baja de lata, ventas,
> caja, cierres, transferencias, etc.) — ver
> [`docs/ETAPA-3-MOTOR-INVENTARIO.md`](docs/ETAPA-3-MOTOR-INVENTARIO.md),
> [`docs/ETAPA-3.1-HARDENING-INVENTARIO.md`](docs/ETAPA-3.1-HARDENING-INVENTARIO.md)
> y [`docs/INVARIANTES-INVENTARIO.md`](docs/INVARIANTES-INVENTARIO.md) para
> el detalle completo de qué se construyó y qué queda explícitamente
> pendiente.

## Documentación de arquitectura

- [`docs/ETAPA-0-ANALISIS-ARQUITECTURA.md`](docs/ETAPA-0-ANALISIS-ARQUITECTURA.md) — análisis, arquitectura y plan maestro (fuente normativa del proyecto).
- [`docs/ETAPA-0.1-CORRECCIONES.md`](docs/ETAPA-0.1-CORRECCIONES.md) — correcciones y cierre de Etapa 0.
- [`docs/ETAPA-1-BASE-CORE.md`](docs/ETAPA-1-BASE-CORE.md) — base técnica (modelo de datos, auth, autorización, auditoría, tests, CI, seguridad).
- [`docs/ETAPA-1.1-CORRECCIONES.md`](docs/ETAPA-1.1-CORRECCIONES.md) — correcciones de consistencia organización/ubicación y atomicidad Auth↔app_user.
- [`docs/ETAPA-2-CATALOGO-MAESTROS.md`](docs/ETAPA-2-CATALOGO-MAESTROS.md) — módulo de catálogo (productos, categorías, sabores), importador inicial, staging.
- [`docs/ETAPA-2-PRUEBA-MANUAL.md`](docs/ETAPA-2-PRUEBA-MANUAL.md) — checklist para probar el sistema personalmente.
- [`docs/ETAPA-2.1-INTEGRIDAD-MULTIORGANIZACION.md`](docs/ETAPA-2.1-INTEGRIDAD-MULTIORGANIZACION.md) — foreign keys compuestas para garantizar el aislamiento multi-organización del catálogo a nivel de PostgreSQL.
- [`docs/ETAPA-3-MOTOR-INVENTARIO.md`](docs/ETAPA-3-MOTOR-INVENTARIO.md) — ledger de movimientos de inventario, stock teórico, ajustes, reversiones, auditoría transaccional.
- [`docs/ETAPA-3.1-HARDENING-INVENTARIO.md`](docs/ETAPA-3.1-HARDENING-INVENTARIO.md) — hardening del motor de inventario: reversión concurrente, precisión decimal, idempotencia semántica, `eslint-disable`.
- [`docs/INVARIANTES-INVENTARIO.md`](docs/INVARIANTES-INVENTARIO.md) — contrato técnico corto del motor de inventario, para etapas futuras.

## Estructura del monorepo

```
apps/
  api/          Backend (Fastify + TypeScript)
  admin-web/    Frontend de administración (React + TypeScript)
  shop-pwa/     App operativa para heladería/depósito (React + TypeScript, PWA)
packages/
  shared-types/ Tipos TypeScript compartidos
  db/           Prisma (schema, migraciones, seed, cliente)
  auth-client/  Cliente de autenticación/API compartido entre los dos frontends
```

## Stack

- **Frontend**: React + TypeScript + Vite. `apps/shop-pwa` es una PWA
  (mobile-first, uso desde el piso de venta); `apps/admin-web` es de escritorio.
- **Backend**: Node.js + TypeScript, [Fastify](https://fastify.dev/).
- **Base de datos**: PostgreSQL (Supabase en producción), [Prisma](https://www.prisma.io/) como ORM.
- **Autenticación**: [Supabase Auth](https://supabase.com/docs/guides/auth) — identidad individual por persona (ver `docs/ETAPA-0-ANALISIS-ARQUITECTURA.md`, sección 18).
- **Deploy previsto**: Vercel (frontends), Render (backend) — sin CD configurado todavía en esta etapa.

## Requisitos

- Node.js ≥ 20
- npm ≥ 10
- PostgreSQL 16 (local para desarrollo) o un proyecto de Supabase
- Una cuenta/proyecto de Supabase (Auth) — necesario incluso en desarrollo local, salvo que se mockee

## Puesta en marcha (desarrollo local)

```bash
# 1. Instalar dependencias del monorepo
npm install

# 2. Configurar variables de entorno (copiar y completar cada .env.example)
cp apps/api/.env.example apps/api/.env
cp packages/db/.env.example packages/db/.env
cp apps/admin-web/.env.example apps/admin-web/.env
cp apps/shop-pwa/.env.example apps/shop-pwa/.env

# 3. Compilar packages/shared-types (lo consumen el resto de los paquetes)
npm run build --workspace packages/shared-types

# 4. Generar el cliente de Prisma y aplicar migraciones
npm run db:generate
npm run db:migrate:dev

# 5. Datos técnicos de ejemplo (roles, organización, ubicaciones, tipos/unidades) — nunca datos reales del cliente
npm run db:seed

# 5b. (Opcional) importar el catálogo real del cliente desde un archivo .xlsx local
#     (nunca se commitea al repo) — ver docs/ETAPA-2-CATALOGO-MAESTROS.md, sección 12
npm run db:import-catalog -- /ruta/al/archivo.xlsx

# 6. Levantar cada app (en terminales separadas)
npm run dev:api      # http://localhost:3000
npm run dev:admin    # http://localhost:5173
npm run dev:shop     # http://localhost:5174
```

El primer usuario Admin se da de alta manualmente en Supabase Auth y luego se
vincula al sistema — no hay seed de usuarios reales (ver
`docs/ETAPA-1-BASE-CORE.md`, secciones 15 y 20).

> **Nota técnica**: si alguna vez hace falta regenerar `package-lock.json` desde
> cero (sin ningún lockfile previo), usá `npm install --legacy-peer-deps` para el
> primer `install` — hay un bug conocido de `npm`/`@npmcli/arborist` al resolver
> el árbol de peer dependencies opcionales de `vitest` desde cero que rompe un
> `npm install` normal en ese único escenario. Una vez que el lockfile ya existe
> (como en este repo), `npm install`/`npm ci` normales funcionan sin el flag —
> ver `docs/ETAPA-2-CATALOGO-MAESTROS.md`, sección 19, para el detalle completo.

## Scripts disponibles (raíz del monorepo)

| Comando                               | Qué hace                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `npm run lint`                        | ESLint sobre todo el repo                                                                       |
| `npm run format` / `format:check`     | Prettier (aplicar / sólo verificar)                                                             |
| `npm run typecheck`                   | `tsc --noEmit` en cada paquete/app                                                              |
| `npm run test`                        | Tests (Vitest) en cada paquete/app                                                              |
| `npm run build`                       | Build de producción de cada paquete/app                                                         |
| `npm run db:generate`                 | Genera el cliente de Prisma                                                                     |
| `npm run db:migrate:dev`              | Crea/aplica migraciones en desarrollo                                                           |
| `npm run db:migrate:deploy`           | Aplica migraciones existentes (CI/producción)                                                   |
| `npm run db:seed`                     | Carga datos de ejemplo (sólo desarrollo)                                                        |
| `npm run db:import-catalog -- <ruta>` | Importa el catálogo real desde un `.xlsx` (ver `docs/ETAPA-2-CATALOGO-MAESTROS.md`, sección 12) |

## Tests y CI

177 tests (Vitest) en 24 archivos, backend y ambos frontends. Los tests de
`apps/api` corren contra una base PostgreSQL real (no mockeada), incluyendo
tests de integridad a nivel de base de datos que bypasean la API para
confirmar el aislamiento multi-organización (Etapa 2.1), las garantías del
ledger de inventario (Etapa 3: FKs compuestas, CHECK constraints, índice
único de stock inicial, idempotencia) y su hardening (Etapa 3.1: reversión
concurrente real, precisión decimal, idempotencia semántica, protección del
ledger contra `UPDATE` destructivo). CI en GitHub Actions
(`.github/workflows/ci.yml`): instala, genera y migra la base contra un
Postgres de servicio, y corre lint, formato, typecheck, tests y build en
cada push/PR — sin ningún paso de deploy. Ver detalle en
`docs/ETAPA-1-BASE-CORE.md`, secciones 16 y 17,
`docs/ETAPA-2-CATALOGO-MAESTROS.md`, sección 14,
`docs/ETAPA-2.1-INTEGRIDAD-MULTIORGANIZACION.md`, secciones 9 a 11,
`docs/ETAPA-3-MOTOR-INVENTARIO.md`, sección 23, y
`docs/ETAPA-3.1-HARDENING-INVENTARIO.md`, sección 7.

## Estado del proyecto

Etapa 3.1 (Hardening del Motor de Inventario) completa, pendiente de
auditoría externa antes de avanzar a la siguiente etapa. El sistema tiene
base técnica, gestión de usuarios, catálogo (con aislamiento
multi-organización garantizado en PostgreSQL) y el ledger central de
inventario -- stock teórico siempre calculado desde los movimientos, nunca
un valor editable, con stock inicial/ajustes/reversiones operables desde el
panel de Admin, reversión protegida ante concurrencia real, cantidades como
string decimal de punta a punta e idempotencia semántica por fingerprint;
todavía no hay experiencia operativa de heladería (conteo, mermas, ventas,
caja, cierres, transferencias, etc.).
