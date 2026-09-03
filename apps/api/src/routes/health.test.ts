import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  it('responde ok=true con la base de datos disponible', async () => {
    app = await buildServer();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.data.db).toBe('ok');
  });

  it('no expone ningún secreto en la respuesta', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const raw = response.body;
    expect(raw).not.toContain('service-role');
    expect(raw).not.toContain('SUPABASE');
  });

  afterAll(async () => {
    await app.close();
  });
});

describe('ruta inexistente', () => {
  it('responde 404 con la convención de error de la API', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'GET', url: '/esto-no-existe' });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');

    await app.close();
  });
});
