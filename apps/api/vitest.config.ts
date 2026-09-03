import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Los tests de integración comparten UNA base de datos Postgres real (no un mock).
    // Si Vitest corriera varios archivos de test en paralelo, sus resetCoreTables()/
    // seedRoles() se pisarían entre sí (violaciones de UNIQUE por condición de carrera).
    // Se desactiva el paralelismo entre archivos a propósito: es una base de datos
    // compartida, no muchas bases aisladas.
    fileParallelism: false,
    // Config de test aislada de .env real -- nunca toca la base de desarrollo.
    // Ver docs/ETAPA-1-BASE-CORE.md, sección "Tests" para cómo levantar esta base
    // localmente (packages/db/prisma/migrations aplicadas contra sistemagrido_test).
    env: {
      NODE_ENV: 'test',
      PORT: '4099',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/sistemagrido_test?schema=public',
      DIRECT_URL: 'postgresql://postgres:postgres@localhost:5432/sistemagrido_test?schema=public',
      SUPABASE_URL: 'https://test-project.supabase.co',
      SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      CORS_ORIGINS: 'http://localhost:5173,http://localhost:5174',
      LOG_LEVEL: 'fatal',
    },
  },
});
