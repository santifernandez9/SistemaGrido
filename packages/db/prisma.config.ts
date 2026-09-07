import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Configuración de Prisma CLI (packages/db). Desde Prisma 6, la ubicación del schema
 * y de las migraciones se configuran acá en vez de en package.json. La conexión en sí
 * (DATABASE_URL con pooler para runtime + DIRECT_URL sin pooler para migraciones) se
 * define en el datasource de prisma/schema.prisma — ver docs/ETAPA-0.1-CORRECCIONES.md,
 * sección 7 ("Compatibilidad con Supabase/PostgreSQL").
 *
 * `datasource.url` fuerza explícitamente DIRECT_URL para el Prisma CLI (`migrate dev`,
 * `migrate deploy`, etc.): sin esto, el CLI puede terminar usando DATABASE_URL (el
 * Transaction Pooler de Supabase, puerto 6543) para migraciones, que no soporta las
 * sentencias de sesión que Prisma Migrate necesita. `engine: 'classic'` es requerido
 * por el tipo de `datasource` de `defineConfig` -- es el motor de esquema por
 * defecto que ya se usaba (no habilita el motor JS experimental).
 */
export default defineConfig({
  engine: 'classic',
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DIRECT_URL'),
  },
});
