import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createSupabaseMockModule,
  getDeleteUserCalls,
  mockDeleteUser,
  mockDeleteUserThrows,
  mockGetUser,
  mockInviteUser,
  resetSupabaseMock,
} from '../test/supabase-mock.js';

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
    resetSupabaseMock();
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

  describe('Corrección 1.1 — validación organización/ubicación en updateUser', () => {
    it('permite asignar una ubicación que pertenece a la misma organización del usuario', async () => {
      mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
      const employee = await prisma.appUser.findUniqueOrThrow({
        where: { authSubject: 'sub-empleada' },
      });
      const location = await prisma.location.create({
        data: { organizationId, name: 'Depósito Org A', type: 'DEPOT' },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/users/${employee.id}`,
        headers: adminAuthHeader,
        payload: { defaultLocationId: location.id },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.defaultLocationId).toBe(location.id);
    });

    it('rechaza asignar una ubicación de OTRA organización (usuario org A, ubicación org B)', async () => {
      mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
      const employee = await prisma.appUser.findUniqueOrThrow({
        where: { authSubject: 'sub-empleada' },
      });
      const otherOrg = await prisma.organization.create({ data: { name: 'Organización B' } });
      const otherLocation = await prisma.location.create({
        data: { organizationId: otherOrg.id, name: 'Depósito Org B', type: 'DEPOT' },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/users/${employee.id}`,
        headers: adminAuthHeader,
        payload: { defaultLocationId: otherLocation.id },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');

      const stillUnchanged = await prisma.appUser.findUniqueOrThrow({
        where: { id: employee.id },
      });
      expect(stillUnchanged.defaultLocationId).toBeNull();
    });

    it('rechaza un defaultLocationId que no existe', async () => {
      mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
      const employee = await prisma.appUser.findUniqueOrThrow({
        where: { authSubject: 'sub-empleada' },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/users/${employee.id}`,
        headers: adminAuthHeader,
        payload: { defaultLocationId: '00000000-0000-0000-0000-000000000000' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('sigue permitiendo defaultLocationId: null para quitar la ubicación asignada', async () => {
      mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
      const employee = await prisma.appUser.findUniqueOrThrow({
        where: { authSubject: 'sub-empleada' },
      });
      const location = await prisma.location.create({
        data: { organizationId, name: 'Depósito para luego quitar', type: 'DEPOT' },
      });
      await prisma.appUser.update({
        where: { id: employee.id },
        data: { defaultLocationId: location.id },
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/users/${employee.id}`,
        headers: adminAuthHeader,
        payload: { defaultLocationId: null },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.defaultLocationId).toBeNull();
    });
  });

  describe('Corrección 2 — consistencia Supabase Auth ↔ app_user al invitar', () => {
    it('caso normal: Auth creado + app_user creado -> operación exitosa, sin compensación', async () => {
      mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
      mockInviteUser({
        data: { user: { id: 'sub-caso-normal', email: 'normal@test.com' } },
        error: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: adminAuthHeader,
        payload: {
          email: 'normal@test.com',
          displayName: 'Caso Normal',
          roleCode: 'SHOP_EMPLOYEE',
          defaultLocationId: null,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(getDeleteUserCalls()).toEqual([]);
    });

    it('si falla la persistencia de app_user tras crear el usuario en Auth, compensa y NO deja huérfano ni devuelve éxito', async () => {
      mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
      // Fuerza una colisión real de constraint única (auth_subject) en Postgres para que
      // appUser.create() falle DESPUÉS de que el mock de Supabase ya "creó" el usuario --
      // sin mockear Prisma, usando la restricción real del schema.
      await prisma.appUser.create({
        data: {
          organizationId,
          roleId: roleIds.SHOP_EMPLOYEE,
          displayName: 'Ya ocupa ese auth_subject',
          email: 'colision-previa@test.com',
          authSubject: 'sub-colision',
        },
      });
      mockInviteUser({
        data: { user: { id: 'sub-colision', email: 'nueva-huerfana@test.com' } },
        error: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: adminAuthHeader,
        payload: {
          email: 'nueva-huerfana@test.com',
          displayName: 'Nunca debería persistir',
          roleCode: 'SHOP_EMPLOYEE',
          defaultLocationId: null,
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().ok).toBe(false);

      // Se compensó: se intentó eliminar exactamente el usuario de Auth recién creado por
      // ESTA operación (no el preexistente, que ni participa de esta llamada).
      expect(getDeleteUserCalls()).toEqual(['sub-colision']);

      // No quedó ningún app_user nuevo con el email de la operación fallida.
      const leaked = await prisma.appUser.findUnique({
        where: { email: 'nueva-huerfana@test.com' },
      });
      expect(leaked).toBeNull();
    });

    it('si la propia compensación también falla, no devuelve éxito y registra el problema con contexto', async () => {
      mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
      await prisma.appUser.create({
        data: {
          organizationId,
          roleId: roleIds.SHOP_EMPLOYEE,
          displayName: 'Ya ocupa ese auth_subject',
          email: 'colision-previa-2@test.com',
          authSubject: 'sub-colision-2',
        },
      });
      mockInviteUser({
        data: { user: { id: 'sub-colision-2', email: 'nueva-huerfana-2@test.com' } },
        error: null,
      });
      mockDeleteUser({ data: null, error: { message: 'Supabase no disponible' } });

      const errorSpy = vi.spyOn(app.log, 'error').mockImplementation(() => app.log);

      const response = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: adminAuthHeader,
        payload: {
          email: 'nueva-huerfana-2@test.com',
          displayName: 'Tampoco debería persistir',
          roleCode: 'SHOP_EMPLOYEE',
          defaultLocationId: null,
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().ok).toBe(false);
      expect(getDeleteUserCalls()).toEqual(['sub-colision-2']);

      const leaked = await prisma.appUser.findUnique({
        where: { email: 'nueva-huerfana-2@test.com' },
      });
      expect(leaked).toBeNull();

      const compensationLog = errorSpy.mock.calls.find(
        (call) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as Record<string, unknown>).authUserId === 'sub-colision-2',
      );
      expect(compensationLog).toBeDefined();
      const logContext = compensationLog?.[0] as Record<string, unknown>;
      expect(logContext.dbError).toBeDefined();
      expect(logContext.compensationError).toBeDefined();

      errorSpy.mockRestore();
    });

    it('si Supabase informa que el usuario ya existe, no crea nada ni compensa (409, sin llamar a deleteUser)', async () => {
      mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
      mockInviteUser({
        data: { user: null },
        error: { message: 'A user with this email address has already been registered' },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: adminAuthHeader,
        payload: {
          email: 'ya-existe-en-auth@test.com',
          displayName: 'No debería crearse',
          roleCode: 'SHOP_EMPLOYEE',
          defaultLocationId: null,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFLICT');
      expect(getDeleteUserCalls()).toEqual([]);
    });

    it('también compensa cuando la propia llamada a deleteUser lanza (no sólo cuando devuelve error)', async () => {
      mockGetUser({ data: { user: { id: 'sub-admin', email: 'admin@test.com' } }, error: null });
      await prisma.appUser.create({
        data: {
          organizationId,
          roleId: roleIds.SHOP_EMPLOYEE,
          displayName: 'Ya ocupa ese auth_subject',
          email: 'colision-previa-3@test.com',
          authSubject: 'sub-colision-3',
        },
      });
      mockInviteUser({
        data: { user: { id: 'sub-colision-3', email: 'nueva-huerfana-3@test.com' } },
        error: null,
      });
      mockDeleteUserThrows(new Error('timeout de red hacia Supabase'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: adminAuthHeader,
        payload: {
          email: 'nueva-huerfana-3@test.com',
          displayName: 'Tampoco debería persistir',
          roleCode: 'SHOP_EMPLOYEE',
          defaultLocationId: null,
        },
      });

      expect(response.statusCode).toBe(500);
      expect(getDeleteUserCalls()).toEqual(['sub-colision-3']);
      const leaked = await prisma.appUser.findUnique({
        where: { email: 'nueva-huerfana-3@test.com' },
      });
      expect(leaked).toBeNull();
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
