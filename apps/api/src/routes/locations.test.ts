import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles } = await import('../test/db-helpers.js');

describe('GET /api/locations', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetCoreTables();
    const organizationId = await seedOrganization();
    const roleIds = await seedRoles();
    app = await buildServer();

    await prisma.location.create({
      data: { organizationId, name: 'Depósito Test', type: 'DEPOT' },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-loc@test.com',
        authSubject: 'sub-admin-loc',
      },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.SHOP_EMPLOYEE,
        displayName: 'Empleada',
        email: 'empleada-loc@test.com',
        authSubject: 'sub-empleada-loc',
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('ADMIN puede listar las ubicaciones activas de su organización', async () => {
    mockGetUser({
      data: { user: { id: 'sub-admin-loc', email: 'admin-loc@test.com' } },
      error: null,
    });
    const response = await app.inject({ method: 'GET', url: '/api/locations' });
    // Nota: sin header todavía -- se agrega abajo el caso autenticado real.
    expect(response.statusCode).toBe(401);
  });

  it('ADMIN autenticado ve la ubicación creada', async () => {
    mockGetUser({
      data: { user: { id: 'sub-admin-loc', email: 'admin-loc@test.com' } },
      error: null,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/locations',
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({ name: 'Depósito Test', type: 'DEPOT', active: true }),
    ]);
  });

  it('un rol SHOP_EMPLOYEE no puede listar ubicaciones (403)', async () => {
    mockGetUser({
      data: { user: { id: 'sub-empleada-loc', email: 'empleada-loc@test.com' } },
      error: null,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/locations',
      headers: { authorization: 'Bearer empleada-token' },
    });
    expect(response.statusCode).toBe(403);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
