import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const {
  resetCoreTables,
  seedOrganization,
  seedRoles,
  seedProductTypes,
  seedUnitsOfMeasure,
  seedProductCost,
} = await import('../test/db-helpers.js');

/**
 * Tests del cierre semanal GENERAL (Etapa 6.2, sección 12 del prompt,
 * CONFIRMADO: "la semana cierra cuando TODAS las heladerías requeridas
 * terminaron su conteo") -- ver docs/ETAPA-6.2-CIERRE-INTEGRAL.md. Dos
 * heladerías activas requeridas; el `WeeklyClosing` por ubicación de Etapa
 * 6/6.1 sigue existiendo intacto.
 */
describe('/api/weekly-closings/general', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let adminId: string;
  let locationA: string;
  let locationB: string;
  let productA: string;

  const PERIOD_START = '2026-08-31';
  const GOVERNING_WEEK_START = '2026-09-07';

  const adminAuthHeader = { authorization: 'Bearer admin-token' };

  function asAdmin() {
    mockGetUser({
      data: { user: { id: 'sub-admin-general', email: 'admin-general@test.com' } },
      error: null,
    });
  }

  beforeEach(async () => {
    await resetCoreTables();
    organizationId = await seedOrganization();
    const roleIds = await seedRoles();
    const productTypes = await seedProductTypes(organizationId);
    const unitsOfMeasure = await seedUnitsOfMeasure(organizationId);
    app = await buildServer();

    locationA = (
      await prisma.location.create({
        data: { organizationId, name: 'Heladería A', type: 'ICE_CREAM_SHOP' },
      })
    ).id;
    locationB = (
      await prisma.location.create({
        data: { organizationId, name: 'Heladería B', type: 'ICE_CREAM_SHOP' },
      })
    ).id;
    // Un DEPOT nunca es una "heladería requerida" -- no debe aparecer en `locations`.
    await prisma.location.create({ data: { organizationId, name: 'Depósito', type: 'DEPOT' } });

    const category = await prisma.category.create({ data: { organizationId, name: 'Insumos' } });
    productA = (
      await prisma.product.create({
        data: {
          organizationId,
          name: 'Producto A',
          categoryId: category.id,
          productTypeId: productTypes.INSUMO,
          unitOfMeasureId: unitsOfMeasure.UNIDAD,
          unitsPerHandlingUnit: 1,
        },
      })
    ).id;

    const admin = await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-general@test.com',
        authSubject: 'sub-admin-general',
      },
    });
    adminId = admin.id;
    asAdmin();

    await seedProductCost({
      organizationId,
      productId: productA,
      productName: 'Producto A',
      actorId: adminId,
      costWithTax: '10.00',
    });
  });

  async function closeLocation(locationId: string, idempotencySuffix: string) {
    await prisma.inventoryMovement.create({
      data: {
        organizationId,
        locationId,
        productId: productA,
        movementType: 'INITIAL_STOCK',
        quantity: '10',
        enteredQuantity: '10',
        entryUnitOfMeasureId: (
          await prisma.unitOfMeasure.findFirstOrThrow({ where: { organizationId, code: 'UNIDAD' } })
        ).id,
        conversionFactor: 1,
        createdById: adminId,
      },
    });
    const prepared = await app.inject({
      method: 'POST',
      url: '/api/weekly-closings',
      headers: adminAuthHeader,
      payload: { locationId, periodStart: PERIOD_START },
    });
    const id = prepared.json().data.id as string;
    await app.inject({
      method: 'POST',
      url: '/api/shop/counts',
      headers: adminAuthHeader,
      payload: {
        locationId,
        weekStart: GOVERNING_WEEK_START,
        items: [{ productId: productA, closedUnits: 10 }],
        idempotencyKey: `conteo-${idempotencySuffix}`,
      },
    });
    await app.inject({
      method: 'POST',
      url: `/api/weekly-closings/${id}/confirm-review`,
      headers: adminAuthHeader,
    });
    const close = await app.inject({
      method: 'POST',
      url: `/api/weekly-closings/${id}/close`,
      headers: adminAuthHeader,
      payload: { idempotencyKey: `cierre-${idempotencySuffix}` },
    });
    expect(close.statusCode).toBe(200);
    return id;
  }

  it('lista las dos heladerías requeridas, ninguna lista, canClose false', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/weekly-closings/general?periodStart=${PERIOD_START}`,
      headers: adminAuthHeader,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.status).toBe('OPEN');
    expect(data.locations).toHaveLength(2); // el DEPOT nunca cuenta
    expect(data.locations.every((l: { ready: boolean }) => !l.ready)).toBe(true);
    expect(data.canClose).toBe(false);
  });

  it('el cierre general está BLOQUEADO si falta el cierre de una sola heladería', async () => {
    await closeLocation(locationA, 'a');
    const detail = await app.inject({
      method: 'GET',
      url: `/api/weekly-closings/general?periodStart=${PERIOD_START}`,
      headers: adminAuthHeader,
    });
    expect(detail.json().data.canClose).toBe(false);

    const closeAttempt = await app.inject({
      method: 'POST',
      url: '/api/weekly-closings/general/close',
      headers: adminAuthHeader,
      payload: { periodStart: PERIOD_START, idempotencyKey: 'cierre-general-1' },
    });
    expect(closeAttempt.statusCode).toBe(409);
    expect(closeAttempt.json().error.message).toContain('Heladería B');
  });

  it('el cierre general se HABILITA cuando todas las heladerías requeridas están listas', async () => {
    await closeLocation(locationA, 'a');
    await closeLocation(locationB, 'b');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/weekly-closings/general?periodStart=${PERIOD_START}`,
      headers: adminAuthHeader,
    });
    expect(detail.json().data.canClose).toBe(true);

    const close = await app.inject({
      method: 'POST',
      url: '/api/weekly-closings/general/close',
      headers: adminAuthHeader,
      payload: { periodStart: PERIOD_START, idempotencyKey: 'cierre-general-2' },
    });
    expect(close.statusCode).toBe(200);
    expect(close.json().data.status).toBe('CLOSED');
    expect(close.json().data.closedById).toBe(adminId);

    // Reintento idempotente con la misma clave -- no duplica.
    const retry = await app.inject({
      method: 'POST',
      url: '/api/weekly-closings/general/close',
      headers: adminAuthHeader,
      payload: { periodStart: PERIOD_START, idempotencyKey: 'cierre-general-2' },
    });
    expect(retry.statusCode).toBe(200);
    const count = await prisma.generalWeeklyClosing.count({ where: { organizationId } });
    expect(count).toBe(1);
  });

  it('reabrir UNA heladería después del cierre general la marca como no lista otra vez (el cierre general ya persistido no se borra retroactivamente)', async () => {
    const idA = await closeLocation(locationA, 'a');
    await closeLocation(locationB, 'b');
    await app.inject({
      method: 'POST',
      url: '/api/weekly-closings/general/close',
      headers: adminAuthHeader,
      payload: { periodStart: PERIOD_START, idempotencyKey: 'cierre-general-3' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/weekly-closings/${idA}/reopen`,
      headers: adminAuthHeader,
      payload: { reason: 'Corrección post-cierre' },
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/weekly-closings/general?periodStart=${PERIOD_START}`,
      headers: adminAuthHeader,
    });
    // El registro de cierre general YA CERRADO se conserva como trazabilidad
    // histórica (nunca se borra retroactivamente) -- pero la vista de
    // heladerías refleja el estado ACTUAL (A ya no está lista).
    expect(detail.json().data.status).toBe('CLOSED');
    const locA = detail
      .json()
      .data.locations.find((l: { locationId: string }) => l.locationId === locationA);
    expect(locA.ready).toBe(false);
  });
});
