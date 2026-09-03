import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles } = await import('../test/db-helpers.js');

describe('/api/flavors', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let adminAuthHeader: { authorization: string };
  let employeeAuthHeader: { authorization: string };

  beforeEach(async () => {
    await resetCoreTables();
    organizationId = await seedOrganization();
    const roleIds = await seedRoles();
    app = await buildServer();

    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-flavor@test.com',
        authSubject: 'sub-admin-flavor',
      },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.SHOP_EMPLOYEE,
        displayName: 'Empleada',
        email: 'empleada-flavor@test.com',
        authSubject: 'sub-empleada-flavor',
      },
    });

    adminAuthHeader = { authorization: 'Bearer admin-token' };
    employeeAuthHeader = { authorization: 'Bearer empleada-token' };
    mockGetUser({
      data: { user: { id: 'sub-admin-flavor', email: 'admin-flavor@test.com' } },
      error: null,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('un rol SHOP_EMPLOYEE no puede administrar sabores (403)', async () => {
    mockGetUser({
      data: { user: { id: 'sub-empleada-flavor', email: 'empleada-flavor@test.com' } },
      error: null,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/flavors',
      headers: employeeAuthHeader,
      payload: { name: 'Limón' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('ADMIN crea un sabor válido y queda auditado', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/flavors',
      headers: adminAuthHeader,
      payload: { name: 'Limón' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.name).toBe('Limón');
    expect(response.json().data.active).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'FLAVOR_CREATED', module: 'CATALOG' },
    });
    expect(audit).not.toBeNull();
  });

  it('rechaza un sabor con nombre duplicado en la organización (409 CONFLICT)', async () => {
    await prisma.flavor.create({ data: { organizationId, name: 'Limón' } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/flavors',
      headers: adminAuthHeader,
      payload: { name: 'Limón' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
  });

  it('ADMIN actualiza el nombre de un sabor', async () => {
    const flavor = await prisma.flavor.create({ data: { organizationId, name: 'Limon' } });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/flavors/${flavor.id}`,
      headers: adminAuthHeader,
      payload: { name: 'Limón' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.name).toBe('Limón');
  });

  it('ADMIN desactiva un sabor y queda auditado como FLAVOR_DEACTIVATED', async () => {
    const flavor = await prisma.flavor.create({ data: { organizationId, name: 'Limón' } });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/flavors/${flavor.id}`,
      headers: adminAuthHeader,
      payload: { active: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.active).toBe(false);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'FLAVOR_DEACTIVATED', entityId: flavor.id },
    });
    expect(audit).not.toBeNull();
  });

  it('rechaza un sabor inexistente de otra organización (relación inválida, 404)', async () => {
    const otherOrg = await prisma.organization.create({ data: { name: 'Organización D' } });
    const otherFlavor = await prisma.flavor.create({
      data: { organizationId: otherOrg.id, name: 'Ajeno' },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/flavors/${otherFlavor.id}`,
      headers: adminAuthHeader,
      payload: { active: false },
    });
    expect(response.statusCode).toBe(404);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
