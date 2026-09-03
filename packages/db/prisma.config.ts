import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Configuración de Prisma CLI (packages/db). Desde Prisma 6, la ubicación del schema
 * y de las migraciones se configuran acá en vez de en package.json. La conexión en sí
 * (DATABASE_URL con pooler para runtime + DIRECT_URL sin pooler para migraciones) se
 * define en el datasource de prisma/schema.prisma — ver docs/ETAPA-0.1-CORRECCIONES.md,
 * sección 7 ("Compatibilidad con Supabase/PostgreSQL").
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
});
