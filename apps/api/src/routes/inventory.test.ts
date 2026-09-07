import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles, seedProductTypes, seedUnitsOfMeasure } =
  await import('../test/db-helpers.js');

describe('/api/inventory', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let locationA: string;
  let locationB: string;
  let productLata: string; // unitsPerHandlingUnit = 1 (LATA)
  let productCaja: string; // unitsPerHandlingUnit = 12 (CAJA)
  const adminAuthHeader = { authorization: 'Bearer admin-token' };
  const employeeAuthHeader = { authorization: 'Bearer empleada-token' };
  const depositAuthHeader = { authorization: 'Bearer deposito-token' };

  function asAdmin() {
    mockGetUser({
      data: { user: { id: 'sub-admin-inv', email: 'admin-inv@test.com' } },
      error: null,
    });
  }
  function asEmployee() {
    mockGetUser({
      data: { user: { id: 'sub-empleada-inv', email: 'empleada-inv@test.com' } },
      error: null,
    });
  }
  function asDeposit() {
    mockGetUser({
      data: { user: { id: 'sub-deposito-inv', email: 'deposito-inv@test.com' } },
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

    const locA = await prisma.location.create({
      data: { organizationId, name: 'Depósito Central', type: 'DEPOT' },
    });
    const locB = await prisma.location.create({
      data: { organizationId, name: 'Heladería Centro', type: 'ICE_CREAM_SHOP' },
    });
    locationA = locA.id;
    locationB = locB.id;

    const category = await prisma.category.create({
      data: { organizationId, name: 'Sabores al agua' },
    });

    const lata = await prisma.product.create({
      data: {
        organizationId,
        name: 'Limón lata',
        categoryId: category.id,
        productTypeId: productTypes.HELADO,
        unitOfMeasureId: unitsOfMeasure.LATA,
        unitsPerHandlingUnit: 1,
      },
    });
    productLata = lata.id;

    const caja = await prisma.product.create({
      data: {
        organizationId,
        name: 'Cucuruchos caja x12',
        categoryId: category.id,
        productTypeId: productTypes.INSUMO,
        unitOfMeasureId: unitsOfMeasure.CAJA,
        unitsPerHandlingUnit: 12,
      },
    });
    productCaja = caja.id;

    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-inv@test.com',
        authSubject: 'sub-admin-inv',
      },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.SHOP_EMPLOYEE,
        displayName: 'Empleada',
        email: 'empleada-inv@test.com',
        authSubject: 'sub-empleada-inv',
        defaultLocationId: locationB,
      },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.DEPOSIT_MANAGER,
        displayName: 'Encargado',
        email: 'deposito-inv@test.com',
        authSubject: 'sub-deposito-inv',
        defaultLocationId: locationA,
      },
    });

    asAdmin();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('autenticación y autorización', () => {
    it('rechaza sin autenticación (401)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/inventory/stock' });
      expect(response.statusCode).toBe(401);
    });

    it('SHOP_EMPLOYEE no puede cargar stock inicial (403)', async () => {
      asEmployee();
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: employeeAuthHeader,
        payload: { locationId: locationB, productId: productLata, enteredQuantity: 10 },
      });
      expect(response.statusCode).toBe(403);
    });

    it('DEPOSIT_MANAGER no puede crear un ajuste (403)', async () => {
      asDeposit();
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: depositAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 1, reason: 'x' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('SHOP_EMPLOYEE sólo ve el stock de su propia ubicación', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });

      asEmployee();
      const ownLocation = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationB}`,
        headers: employeeAuthHeader,
      });
      expect(ownLocation.statusCode).toBe(200);

      const otherLocation = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationA}`,
        headers: employeeAuthHeader,
      });
      expect(otherLocation.statusCode).toBe(403);

      const noFilter = await app.inject({
        method: 'GET',
        url: '/api/inventory/stock',
        headers: employeeAuthHeader,
      });
      expect(noFilter.statusCode).toBe(200);
      // Sin filtro explícito, se restringe automáticamente a su propia ubicación --
      // como el stock inicial se cargó en locationA, no debería aparecer nada acá.
      expect(noFilter.json().data).toEqual([]);
    });
  });

  describe('stock inicial', () => {
    it('ADMIN carga stock inicial válido y queda auditado', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });
      expect(response.statusCode).toBe(201);
      const created = response.json().data;
      expect(created.movementType).toBe('INITIAL_STOCK');
      expect(created.quantity).toBe('10.000');
      expect(created.enteredQuantity).toBe('10.000');
      expect(created.conversionFactor).toBe(1);
      expect(created.status).toBe('ACTIVE');

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'INVENTORY_INITIAL_STOCK_CREATED', entityId: created.id },
      });
      expect(audit).not.toBeNull();
      expect(audit?.module).toBe('INVENTORY');
    });

    it('rechaza una carga de stock inicial duplicada para el mismo producto/ubicación (409)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 5 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFLICT');
    });

    it('rechaza cantidad cero o negativa (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 0 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('normaliza la cantidad ingresada a la unidad canónica usando la equivalencia del producto', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productCaja, enteredQuantity: 2 },
      });
      expect(response.statusCode).toBe(201);
      const created = response.json().data;
      expect(created.enteredQuantity).toBe('2.000');
      expect(created.conversionFactor).toBe(12);
      expect(created.quantity).toBe('24.000');
    });

    it('la equivalencia queda preservada históricamente aunque el producto cambie después', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productCaja, enteredQuantity: 2 },
      });
      const firstMovement = first.json().data;
      expect(firstMovement.quantity).toBe('24.000');

      // Se corrige la equivalencia del producto (ej. el proveedor cambió el empaque).
      await prisma.product.update({
        where: { id: productCaja },
        data: { unitsPerHandlingUnit: 6 },
      });

      // El movimiento histórico no cambia.
      const detail = await app.inject({
        method: 'GET',
        url: `/api/inventory/movements/${firstMovement.id}`,
        headers: adminAuthHeader,
      });
      expect(detail.json().data.quantity).toBe('24.000');
      expect(detail.json().data.conversionFactor).toBe(12);

      // Un ajuste nuevo sobre el mismo producto ya usa el factor corregido.
      const adjustment = await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productCaja,
          enteredQuantity: 1,
          reason: 'Ingreso adicional',
        },
      });
      expect(adjustment.json().data.conversionFactor).toBe(6);
      expect(adjustment.json().data.quantity).toBe('6.000');
    });

    it('idempotencia: la misma idempotencyKey no genera dos movimientos', async () => {
      const payload = {
        locationId: locationA,
        productId: productLata,
        enteredQuantity: 10,
        idempotencyKey: 'evento-externo-123',
      };
      const first = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload,
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().data.id).toBe(first.json().data.id);

      const count = await prisma.inventoryMovement.count({
        where: { organizationId, idempotencyKey: 'evento-externo-123' },
      });
      expect(count).toBe(1);
    });
  });

  describe('ajustes', () => {
    it('rechaza un ajuste sin motivo (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 5, reason: '' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('permite un ajuste negativo que deje el stock en negativo, sin rechazarlo', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productLata,
          enteredQuantity: -5,
          reason: 'Corrección por diferencia detectada',
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.quantity).toBe('-5.000');

      const stock = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationA}&productId=${productLata}`,
        headers: adminAuthHeader,
      });
      expect(stock.json().data[0].quantity).toBe('-5.000');
    });
  });

  describe('stock teórico', () => {
    it('la suma de movimientos produce el saldo correcto', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });
      await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productLata,
          enteredQuantity: 3,
          reason: 'Ingreso no registrado',
        },
      });
      await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productLata,
          enteredQuantity: -2,
          reason: 'Merma no registrada',
        },
      });

      const stock = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationA}&productId=${productLata}`,
        headers: adminAuthHeader,
      });
      expect(stock.json().data[0].quantity).toBe('11.000');
    });

    it('ubicaciones distintas mantienen saldos independientes para el mismo producto', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationB, productId: productLata, enteredQuantity: 4 },
      });

      const balances = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?productId=${productLata}`,
        headers: adminAuthHeader,
      });
      const byLocation = Object.fromEntries(
        balances
          .json()
          .data.map((b: { locationId: string; quantity: string }) => [b.locationId, b.quantity]),
      );
      expect(byLocation[locationA]).toBe('10.000');
      expect(byLocation[locationB]).toBe('4.000');
    });

    it('productos distintos no interfieren entre sí', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productCaja, enteredQuantity: 1 },
      });

      const balances = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationA}`,
        headers: adminAuthHeader,
      });
      const byProduct = Object.fromEntries(
        balances
          .json()
          .data.map((b: { productId: string; quantity: string }) => [b.productId, b.quantity]),
      );
      expect(byProduct[productLata]).toBe('10.000');
      expect(byProduct[productCaja]).toBe('12.000');
    });

    it('organizaciones distintas no comparten saldo', async () => {
      const otherOrg = await prisma.organization.create({ data: { name: 'Otra organización' } });
      const otherLocation = await prisma.location.create({
        data: { organizationId: otherOrg.id, name: 'Depósito de otra org', type: 'DEPOT' },
      });
      const otherCategory = await prisma.category.create({
        data: { organizationId: otherOrg.id, name: 'Categoría de otra org' },
      });
      const productTypes = await prisma.productType.findMany({ where: { organizationId } });
      const unitsOfMeasure = await prisma.unitOfMeasure.findMany({ where: { organizationId } });
      const otherProductType = await prisma.productType.create({
        data: {
          organizationId: otherOrg.id,
          code: productTypes[0]!.code,
          name: productTypes[0]!.name,
        },
      });
      const otherUnit = await prisma.unitOfMeasure.create({
        data: {
          organizationId: otherOrg.id,
          code: unitsOfMeasure[0]!.code,
          name: unitsOfMeasure[0]!.name,
        },
      });
      const otherProduct = await prisma.product.create({
        data: {
          organizationId: otherOrg.id,
          name: 'Producto de otra organización',
          categoryId: otherCategory.id,
          productTypeId: otherProductType.id,
          unitOfMeasureId: otherUnit.id,
        },
      });
      await prisma.inventoryMovement.create({
        data: {
          organizationId: otherOrg.id,
          locationId: otherLocation.id,
          productId: otherProduct.id,
          movementType: 'INITIAL_STOCK',
          quantity: 999,
          enteredQuantity: 999,
          entryUnitOfMeasureId: otherUnit.id,
          conversionFactor: 1,
          createdById: (
            await prisma.appUser.create({
              data: {
                organizationId: otherOrg.id,
                roleId: (await prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } })).id,
                displayName: 'Admin de otra org',
                email: 'admin-otraorg@test.com',
                authSubject: 'sub-admin-otraorg',
              },
            })
          ).id,
        },
      });

      const balances = await app.inject({
        method: 'GET',
        url: '/api/inventory/stock',
        headers: adminAuthHeader,
      });
      expect(balances.json().data).toEqual([]);
    });
  });

  describe('reversión', () => {
    it('revertir un movimiento crea un contramovimiento y deja intacto el original', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });
      const movementId = created.json().data.id;

      const reversed = await app.inject({
        method: 'POST',
        url: `/api/inventory/movements/${movementId}/reverse`,
        headers: adminAuthHeader,
        payload: { reason: 'Error de carga' },
      });
      expect(reversed.statusCode).toBe(201);
      const reversal = reversed.json().data;
      expect(reversal.reversesMovementId).toBe(movementId);
      expect(reversal.quantity).toBe('-10.000');
      expect(reversal.movementType).toBe('INITIAL_STOCK');

      const original = await app.inject({
        method: 'GET',
        url: `/api/inventory/movements/${movementId}`,
        headers: adminAuthHeader,
      });
      expect(original.json().data.status).toBe('REVERSED');
      expect(original.json().data.quantity).toBe('10.000'); // el original nunca cambia de cantidad

      const stock = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationA}&productId=${productLata}`,
        headers: adminAuthHeader,
      });
      // El saldo suma TODOS los movimientos (activo y revertido): +10 (original,
      // aunque su status ya sea REVERSED) + (-10) de la reversión = 0. La fila
      // sigue existiendo (hay movimientos para esa combinación), sólo que su
      // saldo neto es cero.
      expect(stock.json().data).toHaveLength(1);
      expect(stock.json().data[0].quantity).toBe('0.000');
    });

    it('permite volver a cargar un stock inicial luego de revertir el anterior', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });
      await app.inject({
        method: 'POST',
        url: `/api/inventory/movements/${created.json().data.id}/reverse`,
        headers: adminAuthHeader,
        payload: { reason: 'Error de carga' },
      });

      const secondAttempt = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 8 },
      });
      expect(secondAttempt.statusCode).toBe(201);
    });

    it('rechaza revertir un movimiento dos veces (409)', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });
      const movementId = created.json().data.id;

      await app.inject({
        method: 'POST',
        url: `/api/inventory/movements/${movementId}/reverse`,
        headers: adminAuthHeader,
        payload: { reason: 'Primera reversión' },
      });
      const second = await app.inject({
        method: 'POST',
        url: `/api/inventory/movements/${movementId}/reverse`,
        headers: adminAuthHeader,
        payload: { reason: 'Segunda reversión' },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('CONFLICT');
    });

    it('rechaza revertir sin motivo (400)', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });
      const response = await app.inject({
        method: 'POST',
        url: `/api/inventory/movements/${created.json().data.id}/reverse`,
        headers: adminAuthHeader,
        payload: { reason: '' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('SHOP_EMPLOYEE no puede revertir movimientos (403)', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });
      asEmployee();
      const response = await app.inject({
        method: 'POST',
        url: `/api/inventory/movements/${created.json().data.id}/reverse`,
        headers: employeeAuthHeader,
        payload: { reason: 'Intento no autorizado' },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('historial de movimientos', () => {
    beforeEach(async () => {
      for (let i = 0; i < 5; i += 1) {
        await app.inject({
          method: 'POST',
          url: '/api/inventory/adjustments',
          headers: adminAuthHeader,
          payload: {
            locationId: locationA,
            productId: productLata,
            enteredQuantity: 1,
            reason: `Ajuste ${i}`,
          },
        });
      }
    });

    it('pagina el historial', async () => {
      const page1 = await app.inject({
        method: 'GET',
        url: '/api/inventory/movements?pageSize=2&page=1',
        headers: adminAuthHeader,
      });
      const body1 = page1.json().data;
      expect(body1.items).toHaveLength(2);
      expect(body1.total).toBe(5);
      expect(body1.page).toBe(1);

      const page2 = await app.inject({
        method: 'GET',
        url: '/api/inventory/movements?pageSize=2&page=2',
        headers: adminAuthHeader,
      });
      expect(page2.json().data.items).toHaveLength(2);
    });

    it('filtra por tipo de movimiento', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationB, productId: productLata, enteredQuantity: 1 },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/inventory/movements?movementType=INITIAL_STOCK',
        headers: adminAuthHeader,
      });
      const items = response.json().data.items;
      expect(items).toHaveLength(1);
      expect(items[0].movementType).toBe('INITIAL_STOCK');
    });

    it('el detalle de un movimiento incluye nombres resueltos, no sólo UUIDs', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/inventory/movements?pageSize=1',
        headers: adminAuthHeader,
      });
      const id = list.json().data.items[0].id;
      const detail = await app.inject({
        method: 'GET',
        url: `/api/inventory/movements/${id}`,
        headers: adminAuthHeader,
      });
      expect(detail.json().data.locationName).toBe('Depósito Central');
      expect(detail.json().data.productName).toBe('Limón lata');
      expect(detail.json().data.createdByName).toBe('Admin');
    });

    it('devuelve 404 si el movimiento no existe en la organización', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/inventory/movements/00000000-0000-0000-0000-000000000000',
        headers: adminAuthHeader,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('auditoría transaccional', () => {
    it('si falla la escritura de auditoría, el movimiento tampoco queda persistido (todo o nada)', async () => {
      const originalLogTx = app.audit.logTx;
      app.audit.logTx = async () => {
        throw new Error('Falla simulada al escribir la auditoría');
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: 10 },
      });
      expect(response.statusCode).toBe(500);

      const movements = await prisma.inventoryMovement.findMany({ where: { organizationId } });
      expect(movements).toHaveLength(0);
      const auditRows = await prisma.auditLog.findMany({
        where: { organizationId, module: 'INVENTORY' },
      });
      expect(auditRows).toHaveLength(0);

      app.audit.logTx = originalLogTx;
    });
  });
});
