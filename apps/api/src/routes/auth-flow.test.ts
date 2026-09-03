import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles } = await import('../test/db-helpers.js');

describe('autenticación (fastify.authenticate)', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let roleIds: Record<'ADMIN' | 'DEPOSIT_MANAGER' | 'SHOP_EMPLOYEE', string>;

  beforeEach(async () => {
    await resetCoreTables();
    organizationId = await seedOrganization();
    roleIds = await seedRoles();
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rechaza sin header Authorization', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rechaza un token que Supabase considera inválido', async () => {
    mockGetUser({ data: { user: null }, error: { message: 'invalid token' } });
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: 'Bearer token-invalido' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rechaza un token válido de Supabase sin app_user asociado (cuenta no provisionada)', async () => {
    mockGetUser({ data: { user: { id: 'sub-sin-perfil', email: 'nadie@test.com' } }, error: null });
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: 'Bearer token-valido' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toContain('todavía no tiene un usuario');
  });

  it('rechaza un usuario desactivado', async () => {
    const user = await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.SHOP_EMPLOYEE,
        displayName: 'Empleada Inactiva',
        email: 'inactiva@test.com',
        authSubject: 'sub-inactiva',
        active: false,
      },
    });
    mockGetUser({ data: { user: { id: user.authSubject, email: user.email } }, error: null });

    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: 'Bearer token-valido' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('deja pasar un usuario individual activo y devuelve su perfil real', async () => {
    const user = await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin de Test',
        email: 'admin@test.com',
        authSubject: 'sub-admin',
      },
    });
    mockGetUser({ data: { user: { id: user.authSubject, email: user.email } }, error: null });

    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: 'Bearer token-valido' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      id: user.id,
      email: 'admin@test.com',
      roleCode: 'ADMIN',
      displayName: 'Admin de Test',
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
