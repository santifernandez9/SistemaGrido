import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule } from './test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('./server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables } = await import('./test/db-helpers.js');

/**
 * `app.inject()` no reproduce un preflight OPTIONS real de navegador -- por eso este
 * bug (PATCH bloqueado por CORS) pasó los 79 tests de Etapa 1/1.1 sin que ninguno lo
 * detectara, y sólo apareció al probar Etapa 2 en un navegador real. Este archivo
 * simula el preflight explícitamente (`OPTIONS` + `Access-Control-Request-Method`),
 * que Fastify SÍ procesa igual que un navegador real -- ver
 * docs/ETAPA-2-CATALOGO-MAESTROS.md, sección "Seguridad"/"CORS".
 */
describe('CORS — preflight de métodos usados por la API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetCoreTables();
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(['GET', 'POST', 'PATCH'])(
    'permite %s en el preflight para el origen configurado',
    async (method) => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/products/00000000-0000-0000-0000-000000000000',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': method,
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-methods']).toContain(method);
    },
  );

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
