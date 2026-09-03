# Sistema Grido

Sistema de control de stock, caja y rentabilidad para Heladerías Grido
(Heladerías Habash). Monorepo con backend, dos frontends (panel de
administración y app operativa PWA para heladería/depósito) y paquetes
compartidos.

> Este repositorio está en **Etapa 1 — Base/Core**: sólo contiene la
> infraestructura técnica mínima (auth, usuarios, roles, auditoría base,
> estructura del proyecto). No implementa todavía ninguna funcionalidad de
> negocio (stock, ventas, caja, mermas, etc.) — ver
> [`docs/ETAPA-1-BASE-CORE.md`](docs/ETAPA-1-BASE-CORE.md) para el detalle
> completo de qué se construyó y qué queda explícitamente pendiente.

## Documentación de arquitectura

- [`docs/ETAPA-0-ANALISIS-ARQUITECTURA.md`](docs/ETAPA-0-ANALISIS-ARQUITECTURA.md) — análisis, arquitectura y plan maestro (fuente normativa del proyecto).
- [`docs/ETAPA-0.1-CORRECCIONES.md`](docs/ETAPA-0.1-CORRECCIONES.md) — correcciones y cierre de Etapa 0.
- [`docs/ETAPA-1-BASE-CORE.md`](docs/ETAPA-1-BASE-CORE.md) — qué se construyó en esta etapa (modelo de datos, auth, autorización, auditoría, tests, CI, seguridad, pendientes).

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

# 5. (Opcional) datos de ejemplo para desarrollo — nunca datos reales del cliente
npm run db:seed

# 6. Levantar cada app (en terminales separadas)
npm run dev:api      # http://localhost:3000
npm run dev:admin    # http://localhost:5173
npm run dev:shop     # http://localhost:5174
```

El primer usuario Admin se da de alta manualmente en Supabase Auth y luego se
vincula al sistema — no hay seed de usuarios reales (ver
`docs/ETAPA-1-BASE-CORE.md`, secciones 15 y 20).

## Scripts disponibles (raíz del monorepo)

| Comando                           | Qué hace                                      |
| --------------------------------- | --------------------------------------------- |
| `npm run lint`                    | ESLint sobre todo el repo                     |
| `npm run format` / `format:check` | Prettier (aplicar / sólo verificar)           |
| `npm run typecheck`               | `tsc --noEmit` en cada paquete/app            |
| `npm run test`                    | Tests (Vitest) en cada paquete/app            |
| `npm run build`                   | Build de producción de cada paquete/app       |
| `npm run db:generate`             | Genera el cliente de Prisma                   |
| `npm run db:migrate:dev`          | Crea/aplica migraciones en desarrollo         |
| `npm run db:migrate:deploy`       | Aplica migraciones existentes (CI/producción) |
| `npm run db:seed`                 | Carga datos de ejemplo (sólo desarrollo)      |

## Tests y CI

47 tests (Vitest) en 13 archivos, backend y ambos frontends. Los tests de
`apps/api` corren contra una base PostgreSQL real (no mockeada). CI en GitHub
Actions (`.github/workflows/ci.yml`): instala, genera y migra la base contra
un Postgres de servicio, y corre lint, formato, typecheck, tests y build en
cada push/PR — sin ningún paso de deploy. Ver detalle en
`docs/ETAPA-1-BASE-CORE.md`, secciones 16 y 17.

## Estado del proyecto

Etapa 1 (Base/Core) completa, pendiente de auditoría externa antes de avanzar
a la siguiente etapa. No hay funcionalidad de negocio implementada todavía.
