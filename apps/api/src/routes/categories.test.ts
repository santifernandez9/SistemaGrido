import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles } = await import('../test/db-helpers.js');

describe('/api/categories', () => {
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
        email: 'admin-cat@test.com',
        authSubject: 'sub-admin-cat',
      },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.SHOP_EMPLOYEE,
        displayName: 'Empleada',
        email: 'empleada-cat@test.com',
        authSubject: 'sub-empleada-cat',
      },
    });

    adminAuthHeader = { authorization: 'Bearer admin-token' };
    employeeAuthHeader = { authorization: 'Bearer empleada-token' };
    mockGetUser({
      data: { user: { id: 'sub-admin-cat', email: 'admin-cat@test.com' } },
      error: null,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('rechaza sin autenticación (401)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/categories' });
    expect(response.statusCode).toBe(401);
  });

  it('un rol SHOP_EMPLOYEE no puede administrar categorías (403)', async () => {
    mockGetUser({
      data: { user: { id: 'sub-empleada-cat', email: 'empleada-cat@test.com' } },
      error: null,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: employeeAuthHeader,
      payload: { name: 'Bombones', parentCategoryId: null },
    });
    expect(response.statusCode).toBe(403);
  });

  it('ADMIN crea una categoría válida y queda auditada', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: adminAuthHeader,
      payload: { name: 'Bombones', parentCategoryId: null },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json().data;
    expect(created.name).toBe('Bombones');
    expect(created.active).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'CATEGORY_CREATED', entityId: created.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.module).toBe('CATALOG');
  });

  it('rechaza una categoría con nombre duplicado en el mismo nivel (409 CONFLICT)', async () => {
    await prisma.category.create({ data: { organizationId, name: 'Bombones' } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: adminAuthHeader,
      payload: { name: 'Bombones', parentCategoryId: null },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
  });

  it('crea una subcategoría (grupo -> subgrupo) y la lista junto con su padre', async () => {
    const grupo = await prisma.category.create({ data: { organizationId, name: 'Bombones' } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: adminAuthHeader,
      payload: { name: 'Bombón Suizo', parentCategoryId: grupo.id },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.parentCategoryId).toBe(grupo.id);

    const list = await app.inject({
      method: 'GET',
      url: '/api/categories',
      headers: adminAuthHeader,
    });
    expect(list.json().data).toHaveLength(2);
  });

  it('rechaza crear una subcategoría de tercer nivel (máximo grupo -> subgrupo)', async () => {
    const grupo = await prisma.category.create({ data: { organizationId, name: 'Bombones' } });
    const subgrupo = await prisma.category.create({
      data: { organizationId, name: 'Bombón Suizo', parentCategoryId: grupo.id },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: adminAuthHeader,
      payload: { name: 'Tercer nivel', parentCategoryId: subgrupo.id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rechaza una categoría padre inexistente (400 VALIDATION_ERROR)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: adminAuthHeader,
      payload: { name: 'Huérfana', parentCategoryId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rechaza una categoría padre de OTRA organización (aislamiento organizacional)', async () => {
    const otherOrg = await prisma.organization.create({ data: { name: 'Organización B' } });
    const otherCategory = await prisma.category.create({
      data: { organizationId: otherOrg.id, name: 'Categoría de otra org' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: adminAuthHeader,
      payload: { name: 'Subcategoría', parentCategoryId: otherCategory.id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('ADMIN actualiza el nombre de una categoría', async () => {
    const category = await prisma.category.create({ data: { organizationId, name: 'Bombones' } });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${category.id}`,
      headers: adminAuthHeader,
      payload: { name: 'Bombones Premium' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.name).toBe('Bombones Premium');
  });

  it('ADMIN desactiva una categoría y queda auditado como CATEGORY_DEACTIVATED', async () => {
    const category = await prisma.category.create({ data: { organizationId, name: 'Bombones' } });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${category.id}`,
      headers: adminAuthHeader,
      payload: { active: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.active).toBe(false);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'CATEGORY_DEACTIVATED', entityId: category.id },
    });
    expect(audit).not.toBeNull();
  });

  it('rechaza actualizar una categoría que no existe en la organización (404)', async () => {
    const otherOrg = await prisma.organization.create({ data: { name: 'Organización C' } });
    const otherCategory = await prisma.category.create({
      data: { organizationId: otherOrg.id, name: 'Ajena' },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${otherCategory.id}`,
      headers: adminAuthHeader,
      payload: { active: false },
    });
    expect(response.statusCode).toBe(404);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
