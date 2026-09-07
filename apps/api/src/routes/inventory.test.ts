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
        payload: { locationId: locationB, productId: productLata, enteredQuantity: '10' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('DEPOSIT_MANAGER no puede crear un ajuste (403)', async () => {
      asDeposit();
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: depositAuthHeader,
        payload: {
          locationId: locationA,
          productId: productLata,
          enteredQuantity: '1',
          reason: 'x',
        },
      });
      expect(response.statusCode).toBe(403);
    });

    it('SHOP_EMPLOYEE sólo ve el stock de su propia ubicación', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
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
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
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
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '5' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CONFLICT');
    });

    it('rechaza cantidad cero o negativa (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '0' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('normaliza la cantidad ingresada a la unidad canónica usando la equivalencia del producto', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productCaja, enteredQuantity: '2' },
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
        payload: { locationId: locationA, productId: productCaja, enteredQuantity: '2' },
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
          enteredQuantity: '1',
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
        enteredQuantity: '10',
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

    it('idempotencia semántica: reutilizar la clave con un payload distinto es un conflicto (409), no un retry silencioso', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productLata,
          enteredQuantity: '10',
          idempotencyKey: 'evento-externo-456',
        },
      });
      expect(first.statusCode).toBe(201);

      // Misma key, distinta cantidad -- no puede ser "la misma operación reenviada".
      const conflicting = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productLata,
          enteredQuantity: '50',
          idempotencyKey: 'evento-externo-456',
        },
      });
      expect(conflicting.statusCode).toBe(409);
      expect(conflicting.json().error.code).toBe('CONFLICT');

      // No se creó un segundo movimiento ni se alteró el primero.
      const movements = await prisma.inventoryMovement.findMany({
        where: { organizationId, idempotencyKey: 'evento-externo-456' },
      });
      expect(movements).toHaveLength(1);
      expect(movements[0]!.enteredQuantity.toString()).toBe('10');
    });

    it('idempotencia semántica: también detecta payload distinto en un ajuste (producto distinto, misma key)', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productLata,
          enteredQuantity: '3',
          reason: 'Ingreso no registrado',
          idempotencyKey: 'evento-ajuste-789',
        },
      });
      expect(first.statusCode).toBe(201);

      const conflicting = await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productCaja,
          enteredQuantity: '3',
          reason: 'Ingreso no registrado',
          idempotencyKey: 'evento-ajuste-789',
        },
      });
      expect(conflicting.statusCode).toBe(409);
    });
  });

  describe('precisión decimal', () => {
    it('acepta y conserva exactamente 0.1, sin pasar por float de JS', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '0.1' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.enteredQuantity).toBe('0.100');
      expect(response.json().data.quantity).toBe('0.100');
    });

    it('0.1 + 0.2 (dos movimientos) da exactamente 0.300, no 0.30000000000000004', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '0.1' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productLata,
          enteredQuantity: '0.2',
          reason: 'Ajuste de prueba de precisión',
        },
      });

      const stock = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationA}&productId=${productLata}`,
        headers: adminAuthHeader,
      });
      expect(stock.json().data[0].quantity).toBe('0.300');
    });

    it('conserva 3 posiciones decimales exactas (12.375) normalizadas por el factor de conversión', async () => {
      // productCaja tiene unitsPerHandlingUnit = 12: 12.375 * 12 = 148.5 exacto.
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productCaja,
          enteredQuantity: '12.375',
          reason: 'Ajuste con decimales',
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.enteredQuantity).toBe('12.375');
      expect(response.json().data.quantity).toBe('148.500');
    });

    it('rechaza un formato decimal inválido (400), sin llegar a persistir nada', async () => {
      const cases = ['abc', '1,5', '1.2345', '1.2.3', ''];
      for (const enteredQuantity of cases) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/inventory/stock/initial',
          headers: adminAuthHeader,
          payload: { locationId: locationA, productId: productLata, enteredQuantity },
        });
        expect(response.statusCode).toBe(400);
      }
      const count = await prisma.inventoryMovement.count({ where: { organizationId } });
      expect(count).toBe(0);
    });
  });

  describe('ajustes', () => {
    it('rechaza un ajuste sin motivo (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productLata,
          enteredQuantity: '5',
          reason: '',
        },
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
          enteredQuantity: '-5',
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
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: {
          locationId: locationA,
          productId: productLata,
          enteredQuantity: '3',
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
          enteredQuantity: '-2',
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
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationB, productId: productLata, enteredQuantity: '4' },
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
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productCaja, enteredQuantity: '1' },
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
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
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
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
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
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '8' },
      });
      expect(secondAttempt.statusCode).toBe(201);
    });

    it('rechaza revertir un movimiento dos veces (409)', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
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

    it('dos reversiones CONCURRENTES del mismo movimiento: exactamente una gana (Etapa 3.1, Problema 1)', async () => {
      // No es un test secuencial (revert(); revert();) -- ambos requests se
      // disparan a la vez con Promise.all, contra la misma conexión/pool de
      // Postgres real, para ejercitar de verdad el UPDATE condicional
      // atómico + el índice único parcial de la migración
      // 20260907130454_inventory_hardening.
      const created = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
      });
      const movementId = created.json().data.id;

      const [responseA, responseB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/inventory/movements/${movementId}/reverse`,
          headers: adminAuthHeader,
          payload: { reason: 'Reversión concurrente A' },
        }),
        app.inject({
          method: 'POST',
          url: `/api/inventory/movements/${movementId}/reverse`,
          headers: adminAuthHeader,
          payload: { reason: 'Reversión concurrente B' },
        }),
      ]);

      const statusCodes = [responseA.statusCode, responseB.statusCode].sort();
      expect(statusCodes).toEqual([201, 409]);

      const winner = responseA.statusCode === 201 ? responseA : responseB;
      expect(winner.json().data.reversesMovementId).toBe(movementId);

      // reversal count = 1 (invariante: 1 movimiento original -> máximo 1 reversión).
      const reversals = await prisma.inventoryMovement.count({
        where: { organizationId, reversesMovementId: movementId },
      });
      expect(reversals).toBe(1);

      // El original quedó REVERSED, con su cantidad intacta (nunca se edita).
      const originalRow = await prisma.inventoryMovement.findUniqueOrThrow({
        where: { id: movementId },
      });
      expect(originalRow.status).toBe('REVERSED');
      expect(originalRow.quantity.toString()).toBe('10');

      // La auditoría también registra exactamente una reversión, no dos.
      const auditRows = await prisma.auditLog.count({
        where: { organizationId, action: 'INVENTORY_MOVEMENT_REVERSED' },
      });
      expect(auditRows).toBe(1);

      // Saldo final correcto: +10 (original) + -10 (única reversión) = 0.
      const stock = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationA}&productId=${productLata}`,
        headers: adminAuthHeader,
      });
      expect(stock.json().data[0].quantity).toBe('0.000');
    });

    it('rechaza revertir sin motivo (400)', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
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
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
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
            enteredQuantity: '1',
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
        payload: { locationId: locationB, productId: productLata, enteredQuantity: '1' },
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
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
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

    it('si falla la auditoría durante una reversión, ni el contramovimiento ni el status del original quedan aplicados', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationA, productId: productLata, enteredQuantity: '10' },
      });
      const movementId = created.json().data.id;

      const originalLogTx = app.audit.logTx;
      app.audit.logTx = async () => {
        throw new Error('Falla simulada al escribir la auditoría de la reversión');
      };

      const response = await app.inject({
        method: 'POST',
        url: `/api/inventory/movements/${movementId}/reverse`,
        headers: adminAuthHeader,
        payload: { reason: 'Reversión que debería abortar' },
      });
      expect(response.statusCode).toBe(500);

      app.audit.logTx = originalLogTx;

      // El original sigue ACTIVE (el UPDATE condicional se revirtió con la transacción).
      const originalRow = await prisma.inventoryMovement.findUniqueOrThrow({
        where: { id: movementId },
      });
      expect(originalRow.status).toBe('ACTIVE');

      // No quedó ningún contramovimiento a medio crear.
      const reversals = await prisma.inventoryMovement.count({
        where: { organizationId, reversesMovementId: movementId },
      });
      expect(reversals).toBe(0);

      // Y ahora sí se puede revertir normalmente -- no quedó en un estado inconsistente.
      const retry = await app.inject({
        method: 'POST',
        url: `/api/inventory/movements/${movementId}/reverse`,
        headers: adminAuthHeader,
        payload: { reason: 'Reintento después de la falla simulada' },
      });
      expect(retry.statusCode).toBe(201);
    });
  });
});
