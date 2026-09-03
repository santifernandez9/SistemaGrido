import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser, mockInviteUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles } = await import('../test/db-helpers.js');

describe('gestión de usuarios (/api/users) — autorización y auditoría', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let roleIds: Record<'ADMIN' | 'DEPOSIT_MANAGER' | 'SHOP_EMPLOYEE', string>;
  let adminAuthHeader: { authorization: string };
  let employeeAuthHeader: { authorization: string };
  let adminId: string;

  beforeEach(async () => {
    await resetCoreTables();
    organizationId = await seedOrganization();
    roleIds = await seedRoles();
    app = await buildServer();

    const admin = await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin@test.com',
        authSubject: 'sub-admin',
      },
    });
    adminId = admin.id;
    const employee = await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.SHOP_EMPLOYEE,
        displayName: 'Empleada',
        email: 'empleada@test.com',
        authSubject: 'sub-empleada',
      },
    });

    adminAuthHeader = { authorization: 'Bearer admin-token' };
    employeeAuthHeader = { authorization: 'Bearer empleada-token' };

    // El mock de Supabase resuelve según el último `mockGetUser` seteado, así que
    // cada request de este describe pisa el valor antes de inyectar -- ver tests.
    void admin;
    void employee;
  });

  afterEach(async () => {
    await app.close();
  });

  it('un rol SHOP_EMPLOYEE no puede listar usuarios (403, autorización backend real)', async () => {
    mockGetUser({
      data: { user: { id: 'sub-empleada', email: 'empleada@test.com' } },
      error: null,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: employeeAuthHeader,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('un rol ADMIN sí puede listar usuarios', async () => {
    mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
    const response = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: adminAuthHeader,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(2);
  });

  it('ADMIN invita a una persona nueva: crea Auth + app_user + auditoría USER_INVITED', async () => {
    mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
    mockInviteUser({
      data: { user: { id: 'sub-nueva-empleada', email: 'nueva@test.com' } },
      error: null,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: adminAuthHeader,
      payload: {
        email: 'nueva@test.com',
        displayName: 'Empleada Nueva',
        roleCode: 'SHOP_EMPLOYEE',
        defaultLocationId: null,
      },
    });

    expect(response.statusCode).toBe(201);
    const created = response.json().data;
    expect(created.email).toBe('nueva@test.com');
    expect(created.roleCode).toBe('SHOP_EMPLOYEE');

    const persisted = await prisma.appUser.findUnique({
      where: { authSubject: 'sub-nueva-empleada' },
    });
    expect(persisted).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'USER_INVITED', entityId: created.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(adminId);
    expect(audit?.module).toBe('USERS');
  });

  it('no permite invitar dos veces el mismo email (409 CONFLICT)', async () => {
    mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });

    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: adminAuthHeader,
      payload: {
        email: 'empleada@test.com', // ya existe, creado en beforeEach
        displayName: 'Duplicada',
        roleCode: 'SHOP_EMPLOYEE',
        defaultLocationId: null,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
  });

  it('rechaza un payload de invitación inválido (400 VALIDATION_ERROR)', async () => {
    mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });

    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: adminAuthHeader,
      payload: { email: 'no-es-un-email', displayName: '', roleCode: 'NO_EXISTE' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('ADMIN desactiva un usuario: PATCH deja auditoría USER_DEACTIVATED con antes/después', async () => {
    mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
    const employee = await prisma.appUser.findUniqueOrThrow({
      where: { authSubject: 'sub-empleada' },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/users/${employee.id}`,
      headers: adminAuthHeader,
      payload: { active: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.active).toBe(false);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'USER_DEACTIVATED', entityId: employee.id },
    });
    expect(audit).not.toBeNull();
    expect((audit?.beforeValue as { active: boolean }).active).toBe(true);
    expect((audit?.afterValue as { active: boolean }).active).toBe(false);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
