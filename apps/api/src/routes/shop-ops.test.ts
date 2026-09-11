import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles, seedProductTypes, seedUnitsOfMeasure } =
  await import('../test/db-helpers.js');

/**
 * Tests de la App Heladería Operativa (Etapa 4) -- ver
 * docs/ETAPA-4-APP-HELADERIA.md. Cubre, como mínimo, lo pedido por el prompt
 * de Etapa 4 (sección 17): conteo (ciego, conversión caja+unidad, sabor,
 * retry idempotente, aislamiento), reconteo (umbral separado, sin valores
 * inventados), baja de lata (un único movimiento ICE_CREAM_CONTAINER_CLOSE,
 * retry no duplica), merma (genera WASTE, reduce teórico, foto, retry no
 * duplica), gasto variable (no genera movimiento), sin stock (no modifica
 * stock), permisos, y que un saldo negativo nunca bloquea un movimiento
 * válido (mismo criterio que Etapa 3).
 */
describe('/api/shop', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let locationShop: string; // ICE_CREAM_SHOP
  let locationDepot: string; // DEPOT
  let productFlavor: string; // sabor a granel, lata, unitsPerHandlingUnit = 1
  let productClosed: string; // producto cerrado, caja x12

  const adminAuthHeader = { authorization: 'Bearer admin-token' };
  const employeeAuthHeader = { authorization: 'Bearer empleada-token' };
  const depositAuthHeader = { authorization: 'Bearer deposito-token' };

  function asAdmin() {
    mockGetUser({
      data: { user: { id: 'sub-admin-shop', email: 'admin-shop@test.com' } },
      error: null,
    });
  }
  function asEmployee() {
    mockGetUser({
      data: { user: { id: 'sub-empleada-shop', email: 'empleada-shop@test.com' } },
      error: null,
    });
  }
  function asDeposit() {
    mockGetUser({
      data: { user: { id: 'sub-deposito-shop', email: 'deposito-shop@test.com' } },
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

    const depot = await prisma.location.create({
      data: { organizationId, name: 'Depósito Central', type: 'DEPOT' },
    });
    const shop = await prisma.location.create({
      data: { organizationId, name: 'Heladería Centro', type: 'ICE_CREAM_SHOP' },
    });
    locationDepot = depot.id;
    locationShop = shop.id;

    const category = await prisma.category.create({
      data: { organizationId, name: 'Sabores al agua' },
    });
    const flavor = await prisma.flavor.create({ data: { organizationId, name: 'Limón' } });

    const flavorProduct = await prisma.product.create({
      data: {
        organizationId,
        name: 'Limón lata',
        categoryId: category.id,
        productTypeId: productTypes.HELADO,
        unitOfMeasureId: unitsOfMeasure.LATA,
        unitsPerHandlingUnit: 1,
        flavorId: flavor.id,
      },
    });
    productFlavor = flavorProduct.id;

    const closedProduct = await prisma.product.create({
      data: {
        organizationId,
        name: 'Cucuruchos caja x12',
        categoryId: category.id,
        productTypeId: productTypes.INSUMO,
        unitOfMeasureId: unitsOfMeasure.CAJA,
        unitsPerHandlingUnit: 12,
      },
    });
    productClosed = closedProduct.id;

    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-shop@test.com',
        authSubject: 'sub-admin-shop',
      },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.SHOP_EMPLOYEE,
        displayName: 'Empleada',
        email: 'empleada-shop@test.com',
        authSubject: 'sub-empleada-shop',
        defaultLocationId: locationShop,
      },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.DEPOSIT_MANAGER,
        displayName: 'Encargado',
        email: 'deposito-shop@test.com',
        authSubject: 'sub-deposito-shop',
        defaultLocationId: locationDepot,
      },
    });

    asAdmin();
  });

  afterEach(async () => {
    await app.close();
  });

  // --- helpers -------------------------------------------------------------

  async function submitCount(headers: Record<string, string>, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/shop/counts', headers, payload });
  }

  async function loadInitialStock(locationId: string, productId: string, enteredQuantity: string) {
    return app.inject({
      method: 'POST',
      url: '/api/inventory/stock/initial',
      headers: adminAuthHeader,
      payload: { locationId, productId, enteredQuantity },
    });
  }

  // --- autenticación y autorización ----------------------------------------

  describe('autenticación y autorización', () => {
    it('rechaza sin autenticación (401)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/shop/counts' });
      expect(response.statusCode).toBe(401);
    });

    it('DEPOSIT_MANAGER no puede dar de baja una lata (403)', async () => {
      asDeposit();
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/ice-cream-containers/close',
        headers: depositAuthHeader,
        payload: { locationId: locationDepot, productId: productFlavor, idempotencyKey: 'k1' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('DEPOSIT_MANAGER no puede registrar una merma (403, P-005)', async () => {
      asDeposit();
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: depositAuthHeader,
        payload: {
          locationId: locationDepot,
          productId: productFlavor,
          enteredQuantity: '1',
          reason: 'Se cayó',
          photoPath: 'org/WASTE_PHOTO/foto.jpg',
          idempotencyKey: 'k2',
        },
      });
      expect(response.statusCode).toBe(403);
    });

    it('DEPOSIT_MANAGER no puede registrar un gasto variable (403)', async () => {
      asDeposit();
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/expenses',
        headers: depositAuthHeader,
        payload: {
          locationId: locationDepot,
          amount: '100.00',
          category: 'Limpieza',
          description: 'Detergente',
          idempotencyKey: 'k3',
        },
      });
      expect(response.statusCode).toBe(403);
    });

    it('DEPOSIT_MANAGER no puede marcar sin stock (403)', async () => {
      asDeposit();
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/stockouts',
        headers: depositAuthHeader,
        payload: { locationId: locationDepot, productId: productFlavor, idempotencyKey: 'k4' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('DEPOSIT_MANAGER sí puede enviar un conteo (RF-012)', async () => {
      asDeposit();
      const response = await submitCount(depositAuthHeader, {
        locationId: locationDepot,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 1 }],
        idempotencyKey: 'deposito-conteo-1',
      });
      expect(response.statusCode).toBe(201);
    });

    it('SHOP_EMPLOYEE no puede operar sobre otra ubicación (403)', async () => {
      asEmployee();
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/ice-cream-containers/close',
        headers: employeeAuthHeader,
        payload: { locationId: locationDepot, productId: productFlavor, idempotencyKey: 'k5' },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  // --- conteo físico semanal -------------------------------------------------

  describe('conteo físico semanal', () => {
    it('convierte cajas + unidades sueltas de un producto cerrado sin que el cliente multiplique', async () => {
      // 2 cajas (x12) + 5 unidades = 29, calculado enteramente en el backend.
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 2, openUnits: 5 }],
        idempotencyKey: 'conteo-caja-unidad',
      });
      expect(response.statusCode).toBe(201);
      const item = response.json().data.items[0];
      expect(item.physicalQuantity).toBe('29.000');
    });

    it('convierte latas cerradas + latas abiertas con fracción estimada de un sabor', async () => {
      // 3 latas cerradas + 1 lata abierta a la MITAD = 3 + 0.5 = 3.5.
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productFlavor, closedUnits: 3, openUnits: 1, openFraction: 'HALF' }],
        idempotencyKey: 'conteo-sabor-fraccion',
      });
      expect(response.statusCode).toBe(201);
      const item = response.json().data.items[0];
      expect(item.physicalQuantity).toBe('3.500');
    });

    it('Etapa 6.2.1: la existencia de depósito de un sabor se suma a la física con el mismo mecanismo que las latas cerradas de salón', async () => {
      // 2 latas cerradas en salón + 1 lata abierta a la MITAD + 4 latas
      // cerradas en el depósito propio de la heladería = 2 + 0.5 + 4 = 6.5.
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [
          {
            productId: productFlavor,
            closedUnits: 2,
            openUnits: 1,
            openFraction: 'HALF',
            depositoClosedUnits: 4,
          },
        ],
        idempotencyKey: 'conteo-sabor-deposito',
      });
      expect(response.statusCode).toBe(201);
      const item = response.json().data.items[0];
      expect(item.depositoClosedUnits).toBe(4);
      expect(item.physicalQuantity).toBe('6.500');
    });

    it('Etapa 6.2.1: un producto SIN sabor no admite existencia de depósito (400)', async () => {
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 1, depositoClosedUnits: 2 }],
        idempotencyKey: 'conteo-deposito-no-sabor',
      });
      expect(response.statusCode).toBe(400);
    });

    it('exige la fracción estimada cuando hay latas abiertas de un sabor (400)', async () => {
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productFlavor, closedUnits: 1, openUnits: 1 }],
        idempotencyKey: 'conteo-sabor-sin-fraccion',
      });
      expect(response.statusCode).toBe(400);
    });

    it('conteo ciego: la diferencia se calcula contra el teórico en el backend, nunca la manda el cliente', async () => {
      // productFlavor tiene unitsPerHandlingUnit = 1: la cantidad ingresada en
      // el stock inicial ya es la cantidad canónica, simplificando la cuenta.
      await loadInitialStock(locationShop, productFlavor, '20');
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productFlavor, closedUnits: 18, openUnits: 0 }],
        idempotencyKey: 'conteo-ciego-diferencia',
      });
      expect(response.statusCode).toBe(201);
      const item = response.json().data.items[0];
      expect(item.theoreticalQuantity).toBe('20.000');
      expect(item.physicalQuantity).toBe('18.000');
      expect(item.difference).toBe('-2.000');
    });

    // productClosed es "caja x12" (unitsPerHandlingUnit = 12): tanto
    // `loadInitialStock` (enteredQuantity en cajas) como `closedUnits` del
    // conteo se convierten ×12 a cantidad canónica -- estos tests usan
    // SIEMPRE `closedUnits` (nunca `openUnits`, que no se escala) para que
    // el porcentaje sea fácil de verificar contra el teórico canónico real.

    it('sin umbral ABSOLUTO configurado, un FALTANTE >=25% del teórico igual dispara needsRecount (regla obligatoria de Etapa 6.2)', async () => {
      // Etapa 6.2, sección 4 del prompt (CONFIRMADO): el 25% de faltante es
      // una regla PORCENTUAL obligatoria, independiente de que el umbral
      // ABSOLUTO opcional (Etapa 4.1) esté configurado o no -- teórico
      // 10 cajas (120 canónico), real 1 caja (12) -> faltante 108 = 90%.
      await loadInitialStock(locationShop, productClosed, '10');
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 1 }],
        idempotencyKey: 'conteo-sin-umbral',
      });
      expect(response.statusCode).toBe(201);
      const body = response.json().data;
      expect(body.items[0].needsRecount).toBe(true);
      expect(body.status).toBe('RECOUNT_REQUIRED');
    });

    it('sin umbral ABSOLUTO configurado, un SOBRANTE grande nunca dispara needsRecount (el 25% obligatorio sólo aplica a faltantes)', async () => {
      // Teórico 1 caja (12 canónico), real 1000 unidades sueltas -> sobrante
      // enorme (+988); el 25% obligatorio nunca aplica a un sobrante.
      await loadInitialStock(locationShop, productClosed, '1');
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 0, openUnits: 1000 }],
        idempotencyKey: 'conteo-sobrante-sin-umbral',
      });
      expect(response.statusCode).toBe(201);
      const body = response.json().data;
      expect(body.items[0].needsRecount).toBe(false);
      expect(body.status).toBe('COMPLETED');
    });

    it('sin umbral ABSOLUTO configurado, un FALTANTE menor al 25% del teórico no dispara needsRecount', async () => {
      // Teórico 10 cajas (120 canónico), real 8 cajas (96) -> faltante 24 = 20% < 25%.
      await loadInitialStock(locationShop, productClosed, '10');
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 8 }],
        idempotencyKey: 'conteo-faltante-chico',
      });
      expect(response.statusCode).toBe(201);
      const body = response.json().data;
      expect(body.items[0].needsRecount).toBe(false);
      expect(body.status).toBe('COMPLETED');
    });

    it('un FALTANTE EXACTAMENTE 25% del teórico dispara needsRecount (umbral inclusive)', async () => {
      // Teórico 4 cajas (48 canónico), real 3 cajas (36) -> faltante 12 = exactamente 25%.
      await loadInitialStock(locationShop, productClosed, '4');
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 3 }],
        idempotencyKey: 'conteo-faltante-exacto-25',
      });
      expect(response.statusCode).toBe(201);
      const body = response.json().data;
      expect(body.items[0].needsRecount).toBe(true);
      expect(body.status).toBe('RECOUNT_REQUIRED');
    });

    it('con umbral configurado, una diferencia mayor al umbral marca needsRecount y deja el conteo en RECOUNT_REQUIRED', async () => {
      app.config.shopOps.recountThresholdClosedProducts = 5;
      await loadInitialStock(locationShop, productClosed, '1000');
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 0, openUnits: 1 }],
        idempotencyKey: 'conteo-con-umbral',
      });
      expect(response.statusCode).toBe(201);
      const body = response.json().data;
      expect(body.items[0].needsRecount).toBe(true);
      expect(body.status).toBe('RECOUNT_REQUIRED');
    });

    it('el umbral de producto cerrado y el de sabor a granel son independientes', async () => {
      app.config.shopOps.recountThresholdClosedProducts = 5; // diferencia del cerrado será 0 -> no dispara
      app.config.shopOps.recountThresholdBulkFlavor = 1; // diferencia del sabor será -99 -> sí dispara
      await loadInitialStock(locationShop, productClosed, '10'); // 10 cajas * 12 = 120 canónico
      await loadInitialStock(locationShop, productFlavor, '100');

      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [
          { productId: productClosed, closedUnits: 10, openUnits: 0 }, // 10*12=120, diferencia 0 -> no marca
          { productId: productFlavor, closedUnits: 1, openUnits: 0 }, // diferencia -99, umbral bajo -> marca
        ],
        idempotencyKey: 'conteo-umbral-independiente',
      });
      expect(response.statusCode).toBe(201);
      const items = response.json().data.items;
      const closedItem = items.find((i: { productId: string }) => i.productId === productClosed);
      const flavorItem = items.find((i: { productId: string }) => i.productId === productFlavor);
      expect(closedItem.needsRecount).toBe(false);
      expect(flavorItem.needsRecount).toBe(true);
      expect(response.json().data.status).toBe('RECOUNT_REQUIRED');
    });

    it('rechaza un mismo producto repetido en el mismo envío (400)', async () => {
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [
          { productId: productClosed, closedUnits: 1 },
          { productId: productClosed, closedUnits: 2 },
        ],
        idempotencyKey: 'conteo-producto-repetido',
      });
      expect(response.statusCode).toBe(400);
    });

    it('rechaza un segundo conteo para la misma ubicación y semana (409)', async () => {
      const first = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 1 }],
        idempotencyKey: 'conteo-semana-a',
      });
      expect(first.statusCode).toBe(201);

      const second = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 2 }],
        idempotencyKey: 'conteo-semana-b',
      });
      expect(second.statusCode).toBe(409);
    });

    it('idempotencia: la misma idempotencyKey no genera dos conteos', async () => {
      const payload = {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 3 }],
        idempotencyKey: 'conteo-retry-identico',
      };
      const first = await submitCount(adminAuthHeader, payload);
      const second = await submitCount(adminAuthHeader, payload);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().data.id).toBe(first.json().data.id);

      const count = await prisma.inventoryCount.count({
        where: { organizationId, idempotencyKey: 'conteo-retry-identico' },
      });
      expect(count).toBe(1);
    });

    it('idempotencia semántica: la misma clave con un payload distinto es un conflicto (409)', async () => {
      const key = 'conteo-key-reusada';
      const first = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 3 }],
        idempotencyKey: key,
      });
      expect(first.statusCode).toBe(201);

      const conflicting = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 9 }],
        idempotencyKey: key,
      });
      expect(conflicting.statusCode).toBe(409);
    });

    it('aislamiento por ubicación: SHOP_EMPLOYEE no ve el conteo de otra ubicación', async () => {
      await submitCount(adminAuthHeader, {
        locationId: locationDepot,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 1 }],
        idempotencyKey: 'conteo-otra-ubicacion',
      });

      asEmployee();
      const list = await app.inject({
        method: 'GET',
        url: '/api/shop/counts',
        headers: employeeAuthHeader,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().data.items).toEqual([]);

      const filtered = await app.inject({
        method: 'GET',
        url: `/api/shop/counts?locationId=${locationDepot}`,
        headers: employeeAuthHeader,
      });
      expect(filtered.statusCode).toBe(403);
    });

    it('aislamiento por organización: un conteo de otra organización nunca aparece', async () => {
      const otherOrg = await prisma.organization.create({ data: { name: 'Otra heladería' } });
      const otherRole = await prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
      const otherLocation = await prisma.location.create({
        data: { organizationId: otherOrg.id, name: 'Depósito de otra org', type: 'ICE_CREAM_SHOP' },
      });
      await prisma.appUser.create({
        data: {
          organizationId: otherOrg.id,
          roleId: otherRole.id,
          displayName: 'Admin otra org',
          email: 'admin-otraorg-shop@test.com',
          authSubject: 'sub-admin-otraorg-shop',
        },
      });
      await prisma.inventoryCount.create({
        data: {
          organizationId: otherOrg.id,
          locationId: otherLocation.id,
          weekStart: new Date('2026-09-07T00:00:00.000Z'),
          status: 'COMPLETED',
          completedAt: new Date(),
          createdById: (
            await prisma.appUser.findFirstOrThrow({ where: { organizationId: otherOrg.id } })
          ).id,
          idempotencyKey: 'conteo-otra-org',
          idempotencyFingerprint: 'x',
        },
      });

      const list = await app.inject({
        method: 'GET',
        url: '/api/shop/counts',
        headers: adminAuthHeader,
      });
      expect(list.json().data.items).toEqual([]);
    });

    it('devuelve 404 al pedir el detalle de un conteo inexistente', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/shop/counts/00000000-0000-0000-0000-000000000000',
        headers: adminAuthHeader,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  // --- reconteo ---------------------------------------------------------------

  describe('reconteo', () => {
    async function submitFlaggedCount() {
      app.config.shopOps.recountThresholdClosedProducts = 5;
      await loadInitialStock(locationShop, productClosed, '1000');
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [{ productId: productClosed, closedUnits: 0, openUnits: 1 }],
        idempotencyKey: 'conteo-para-reconteo',
      });
      return response.json().data;
    }

    it('sólo puede reenviar productos marcados needsRecount (400)', async () => {
      const count = await submitFlaggedCount();
      const response = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${count.id}/recount`,
        headers: adminAuthHeader,
        payload: {
          items: [{ productId: productFlavor, closedUnits: 1 }],
          idempotencyKey: 'reconteo-producto-no-marcado',
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('completa el conteo tras el reconteo y no vuelve a pedir un tercero', async () => {
      const count = await submitFlaggedCount();
      const response = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${count.id}/recount`,
        headers: adminAuthHeader,
        payload: {
          items: [{ productId: productClosed, closedUnits: 80 }], // 80*12=960, diferencia -40 (aún > umbral)
          idempotencyKey: 'reconteo-completa',
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json().data;
      expect(body.status).toBe('COMPLETED');
      expect(body.items[0].needsRecount).toBe(true); // se preserva el flag original
      expect(body.items[0].recounted).toBe(true);
      expect(body.items[0].physicalQuantity).toBe('960.000');
    });

    async function submitFlaggedCountTwoItems() {
      app.config.shopOps.recountThresholdClosedProducts = 5;
      app.config.shopOps.recountThresholdBulkFlavor = 5;
      await loadInitialStock(locationShop, productClosed, '1000');
      await loadInitialStock(locationShop, productFlavor, '1000');
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [
          { productId: productClosed, closedUnits: 0, openUnits: 1 },
          { productId: productFlavor, closedUnits: 1, openUnits: 0 },
        ],
        idempotencyKey: 'conteo-para-reconteo-2items',
      });
      return response.json().data;
    }

    it('retry idempotente por clave: reenviar el mismo reconteo (misma idempotencyKey) tras COMPLETED devuelve el mismo resultado, sin volver a auditar', async () => {
      const count = await submitFlaggedCount();
      const payload = {
        items: [{ productId: productClosed, closedUnits: 80 }],
        idempotencyKey: 'reconteo-retry-misma-clave',
      };
      const first = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${count.id}/recount`,
        headers: adminAuthHeader,
        payload,
      });
      expect(first.statusCode).toBe(200);

      const retry = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${count.id}/recount`,
        headers: adminAuthHeader,
        payload, // misma idempotencyKey, mismo payload
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().data.id).toBe(first.json().data.id);
      expect(retry.json().data.items[0].physicalQuantity).toBe(
        first.json().data.items[0].physicalQuantity,
      );

      const auditRows = await prisma.auditLog.count({
        where: { organizationId, action: 'SHOP_COUNT_RECOUNTED', entityId: count.id },
      });
      expect(auditRows).toBe(1);
    });

    it('retry secuencial con la MISMA clave pero valores distintos es un conflicto (409, no reutiliza ambiguamente la clave)', async () => {
      const count = await submitFlaggedCount();
      const key = 'reconteo-misma-clave-otro-payload';
      const first = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${count.id}/recount`,
        headers: adminAuthHeader,
        payload: { items: [{ productId: productClosed, closedUnits: 80 }], idempotencyKey: key },
      });
      expect(first.statusCode).toBe(200);

      const conflicting = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${count.id}/recount`,
        headers: adminAuthHeader,
        payload: { items: [{ productId: productClosed, closedUnits: 50 }], idempotencyKey: key },
      });
      expect(conflicting.statusCode).toBe(409);

      const auditRows = await prisma.auditLog.count({
        where: { organizationId, action: 'SHOP_COUNT_RECOUNTED', entityId: count.id },
      });
      expect(auditRows).toBe(1);
    });

    it('retry secuencial con OTRA clave y valores distintos tras COMPLETED es un conflicto (409)', async () => {
      const count = await submitFlaggedCount();
      await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${count.id}/recount`,
        headers: adminAuthHeader,
        payload: {
          items: [{ productId: productClosed, closedUnits: 80 }],
          idempotencyKey: 'reconteo-conflicto-a',
        },
      });

      const conflicting = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${count.id}/recount`,
        headers: adminAuthHeader,
        payload: {
          items: [{ productId: productClosed, closedUnits: 50 }],
          idempotencyKey: 'reconteo-conflicto-b',
        },
      });
      expect(conflicting.statusCode).toBe(409);

      const auditRows = await prisma.auditLog.count({
        where: { organizationId, action: 'SHOP_COUNT_RECOUNTED', entityId: count.id },
      });
      expect(auditRows).toBe(1);
    });

    it('canonicalización: los mismos ítems en distinto orden se reconocen como la MISMA operación (mismo resultado exitoso)', async () => {
      const count = await submitFlaggedCountTwoItems();
      const key = 'reconteo-canonicalizacion';
      const itemsInOrderA = [
        { productId: productClosed, closedUnits: 80 },
        { productId: productFlavor, closedUnits: 500 },
      ];
      const itemsInOrderB = [...itemsInOrderA].reverse();

      const first = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${count.id}/recount`,
        headers: adminAuthHeader,
        payload: { items: itemsInOrderA, idempotencyKey: key },
      });
      expect(first.statusCode).toBe(200);

      const retryReordered = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${count.id}/recount`,
        headers: adminAuthHeader,
        payload: { items: itemsInOrderB, idempotencyKey: key },
      });
      expect(retryReordered.statusCode).toBe(200);
      expect(retryReordered.json().data.id).toBe(first.json().data.id);

      const auditRows = await prisma.auditLog.count({
        where: { organizationId, action: 'SHOP_COUNT_RECOUNTED', entityId: count.id },
      });
      expect(auditRows).toBe(1);
    });

    it('dos reconteos CONCURRENTES IDÉNTICOS (misma clave, mismo payload): ambos exitosos, un único efecto persistido, una sola auditoría', async () => {
      const count = await submitFlaggedCount();
      const payload = {
        items: [{ productId: productClosed, closedUnits: 80 }],
        idempotencyKey: 'reconteo-concurrente-identico',
      };

      const [responseA, responseB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/shop/counts/${count.id}/recount`,
          headers: adminAuthHeader,
          payload,
        }),
        app.inject({
          method: 'POST',
          url: `/api/shop/counts/${count.id}/recount`,
          headers: adminAuthHeader,
          payload,
        }),
      ]);

      // Ninguno de los dos debe recibir 409 -- ambos representan la misma
      // operación, así que ambos deben resolver como un retry idempotente
      // exitoso (Etapa 4.1, objetivo: "ambos deben poder obtener el mismo
      // resultado exitoso").
      expect(responseA.statusCode).toBe(200);
      expect(responseB.statusCode).toBe(200);
      expect(responseA.json().data.id).toBe(responseB.json().data.id);
      expect(responseA.json().data.items[0].physicalQuantity).toBe('960.000');
      expect(responseB.json().data.items[0].physicalQuantity).toBe('960.000');

      // Un único efecto persistido: el ítem no quedó escrito dos veces con
      // valores distintos, y una sola auditoría (no doble procesamiento).
      const itemRow = await prisma.inventoryCountItem.findFirst({
        where: { organizationId, countId: count.id, productId: productClosed },
      });
      expect(itemRow?.physicalQuantity.toString()).toBe('960');

      const auditRows = await prisma.auditLog.count({
        where: { organizationId, action: 'SHOP_COUNT_RECOUNTED', entityId: count.id },
      });
      expect(auditRows).toBe(1);
    });

    it('dos reconteos CONCURRENTES con la MISMA clave pero payload DISTINTO: uno gana, el incompatible devuelve 409, una sola auditoría', async () => {
      const count = await submitFlaggedCount();
      const key = 'reconteo-concurrente-misma-clave-payload-distinto';

      const [responseA, responseB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/shop/counts/${count.id}/recount`,
          headers: adminAuthHeader,
          payload: { items: [{ productId: productClosed, closedUnits: 80 }], idempotencyKey: key },
        }),
        app.inject({
          method: 'POST',
          url: `/api/shop/counts/${count.id}/recount`,
          headers: adminAuthHeader,
          payload: { items: [{ productId: productClosed, closedUnits: 50 }], idempotencyKey: key },
        }),
      ]);

      const statusCodes = [responseA.statusCode, responseB.statusCode].sort();
      expect(statusCodes).toEqual([200, 409]);

      const auditRows = await prisma.auditLog.count({
        where: { organizationId, action: 'SHOP_COUNT_RECOUNTED', entityId: count.id },
      });
      expect(auditRows).toBe(1);
    });

    it('dos reconteos CONCURRENTES con claves y payloads DISTINTOS: exactamente uno gana, una sola auditoría', async () => {
      const count = await submitFlaggedCount();
      const [responseA, responseB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/shop/counts/${count.id}/recount`,
          headers: adminAuthHeader,
          payload: {
            items: [{ productId: productClosed, closedUnits: 80 }],
            idempotencyKey: 'reconteo-concurrente-a',
          },
        }),
        app.inject({
          method: 'POST',
          url: `/api/shop/counts/${count.id}/recount`,
          headers: adminAuthHeader,
          payload: {
            items: [{ productId: productClosed, closedUnits: 50 }],
            idempotencyKey: 'reconteo-concurrente-b',
          },
        }),
      ]);
      const statusCodes = [responseA.statusCode, responseB.statusCode].sort();
      expect(statusCodes).toEqual([200, 409]);

      const auditRows = await prisma.auditLog.count({
        where: { organizationId, action: 'SHOP_COUNT_RECOUNTED', entityId: count.id },
      });
      expect(auditRows).toBe(1);
    });
  });

  // --- fracción "casi vacía" (NEARLY_EMPTY) -- Etapa 4.1 ---------------------

  describe('fracción "casi vacía" (NEARLY_EMPTY)', () => {
    it('con BULK_FLAVOR_NEARLY_EMPTY_FRACTION configurada, convierte correctamente', async () => {
      app.config.shopOps.bulkFlavorNearlyEmptyFraction = 0.2; // valor arbitrario, nunca el viejo 0.10
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [
          { productId: productFlavor, closedUnits: 0, openUnits: 1, openFraction: 'NEARLY_EMPTY' },
        ],
        idempotencyKey: 'casi-vacia-configurada',
      });
      expect(response.statusCode).toBe(201);
      // productFlavor tiene unitsPerHandlingUnit = 1: 1 unidad * 0.2 * 1 = 0.200.
      expect(response.json().data.items[0].physicalQuantity).toBe('0.200');
    });

    it('sin configurar, rechaza con un error explícito de configuración (503), sin fallback ni NaN', async () => {
      // El entorno de test no define BULK_FLAVOR_NEARLY_EMPTY_FRACTION (ver
      // apps/api/vitest.config.ts) -- éste es exactamente el estado "sin
      // configurar" que debe rechazarse, nunca resolverse en silencio.
      const response = await submitCount(adminAuthHeader, {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items: [
          { productId: productFlavor, closedUnits: 0, openUnits: 1, openFraction: 'NEARLY_EMPTY' },
        ],
        idempotencyKey: 'casi-vacia-sin-configurar',
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('CONFIGURATION_ERROR');
      expect(response.json().error.message).toMatch(/casi vacía|NEARLY_EMPTY/i);

      // No debe quedar ningún estado a medio crear: el rechazo ocurre ANTES
      // de la transacción, así que no se persiste ni el conteo ni sus ítems.
      const counts = await prisma.inventoryCount.count({
        where: { organizationId, idempotencyKey: 'casi-vacia-sin-configurar' },
      });
      expect(counts).toBe(0);
    });

    it('las demás fracciones confirmadas (LLENA, 3/4, 1/2, 1/4) siguen funcionando sin necesitar ninguna configuración', async () => {
      const cases: {
        weekStart: string;
        fraction: 'FULL' | 'THREE_QUARTERS' | 'HALF' | 'QUARTER';
        expected: string;
      }[] = [
        { weekStart: '2026-08-03', fraction: 'FULL', expected: '1.000' },
        { weekStart: '2026-08-10', fraction: 'THREE_QUARTERS', expected: '0.750' },
        { weekStart: '2026-08-17', fraction: 'HALF', expected: '0.500' },
        { weekStart: '2026-08-24', fraction: 'QUARTER', expected: '0.250' },
      ];
      for (const testCase of cases) {
        const response = await submitCount(adminAuthHeader, {
          locationId: locationShop,
          weekStart: testCase.weekStart,
          items: [
            {
              productId: productFlavor,
              closedUnits: 0,
              openUnits: 1,
              openFraction: testCase.fraction,
            },
          ],
          idempotencyKey: `fraccion-confirmada-${testCase.fraction}`,
        });
        expect(response.statusCode).toBe(201);
        expect(response.json().data.items[0].physicalQuantity).toBe(testCase.expected);
      }
    });
  });

  // --- baja de lata -------------------------------------------------------

  describe('baja de lata', () => {
    it('genera un único movimiento ICE_CREAM_CONTAINER_CLOSE, nunca WASTE', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/ice-cream-containers/close',
        headers: adminAuthHeader,
        payload: { locationId: locationShop, productId: productFlavor, idempotencyKey: 'baja-1' },
      });
      expect(response.statusCode).toBe(201);
      const movement = response.json().data;
      expect(movement.movementType).toBe('ICE_CREAM_CONTAINER_CLOSE');
      expect(movement.quantity).toBe('-1.000');
    });

    it('no exige motivo/observaciones (pocos toques, RN-027)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/ice-cream-containers/close',
        headers: adminAuthHeader,
        payload: { locationId: locationShop, productId: productFlavor, idempotencyKey: 'baja-2' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.reason).toBeNull();
    });

    it('rechaza dar de baja un producto que no es un sabor de helado (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/ice-cream-containers/close',
        headers: adminAuthHeader,
        payload: { locationId: locationShop, productId: productClosed, idempotencyKey: 'baja-3' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('idempotencia: la misma idempotencyKey no genera dos bajas', async () => {
      const payload = {
        locationId: locationShop,
        productId: productFlavor,
        idempotencyKey: 'baja-retry',
      };
      const first = await app.inject({
        method: 'POST',
        url: '/api/shop/ice-cream-containers/close',
        headers: adminAuthHeader,
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/shop/ice-cream-containers/close',
        headers: adminAuthHeader,
        payload,
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().data.id).toBe(first.json().data.id);

      const count = await prisma.inventoryMovement.count({
        where: { organizationId, idempotencyKey: 'baja-retry' },
      });
      expect(count).toBe(1);
    });

    it('permite dejar el stock en negativo sin rechazar la baja', async () => {
      // Sin stock inicial: dar de baja igual deja el saldo en -1, no se bloquea.
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/ice-cream-containers/close',
        headers: adminAuthHeader,
        payload: {
          locationId: locationShop,
          productId: productFlavor,
          idempotencyKey: 'baja-negativa',
        },
      });
      expect(response.statusCode).toBe(201);

      const stock = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationShop}&productId=${productFlavor}`,
        headers: adminAuthHeader,
      });
      expect(stock.json().data[0].quantity).toBe('-1.000');
    });

    it('queda auditado', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/ice-cream-containers/close',
        headers: adminAuthHeader,
        payload: {
          locationId: locationShop,
          productId: productFlavor,
          idempotencyKey: 'baja-audit',
        },
      });
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'SHOP_ICE_CREAM_CONTAINER_CLOSED', entityId: response.json().data.id },
      });
      expect(audit).not.toBeNull();
      expect(audit?.module).toBe('SHOP_OPS');
    });
  });

  // --- merma ----------------------------------------------------------------

  describe('merma', () => {
    function wastePayload(overrides: Record<string, unknown> = {}) {
      return {
        locationId: locationShop,
        productId: productFlavor,
        enteredQuantity: '1',
        reason: 'Se cayó al piso',
        photoPath: 'org1/WASTE_PHOTO/foto.jpg',
        idempotencyKey: 'merma-1',
        ...overrides,
      };
    }

    it('genera un movimiento WASTE y reduce el stock teórico', async () => {
      await loadInitialStock(locationShop, productFlavor, '10');
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: adminAuthHeader,
        payload: wastePayload(),
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.quantity).toBe('1.000'); // se muestra siempre positivo

      const movement = await prisma.inventoryMovement.findFirst({
        where: { organizationId, movementType: 'WASTE' },
      });
      expect(movement?.quantity.toString()).toBe('-1');

      const stock = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationShop}&productId=${productFlavor}`,
        headers: adminAuthHeader,
      });
      expect(stock.json().data[0].quantity).toBe('9.000');
    });

    it('acepta una fracción de lata abierta para un sabor', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: adminAuthHeader,
        payload: wastePayload({ enteredQuantity: undefined, fraction: 'QUARTER' }),
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.quantity).toBe('0.250');
    });

    it('rechaza una fracción para un producto que no es sabor (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: adminAuthHeader,
        payload: wastePayload({
          productId: productClosed,
          enteredQuantity: undefined,
          fraction: 'QUARTER',
        }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('rechaza mandar cantidad y fracción a la vez (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: adminAuthHeader,
        payload: wastePayload({ fraction: 'HALF' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('rechaza no mandar ni cantidad ni fracción (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: adminAuthHeader,
        payload: wastePayload({ enteredQuantity: undefined }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('la foto es obligatoria (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: adminAuthHeader,
        payload: wastePayload({ photoPath: '' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('el motivo es obligatorio (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: adminAuthHeader,
        payload: wastePayload({ reason: '' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('idempotencia: la misma idempotencyKey no genera dos mermas', async () => {
      const payload = wastePayload();
      const first = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: adminAuthHeader,
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: adminAuthHeader,
        payload,
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().data.id).toBe(first.json().data.id);

      const count = await prisma.waste.count({ where: { organizationId } });
      expect(count).toBe(1);
    });

    it('permite dejar el stock en negativo sin rechazar la merma', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: adminAuthHeader,
        payload: wastePayload({ enteredQuantity: '999' }),
      });
      expect(response.statusCode).toBe(201);

      const stock = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationShop}&productId=${productFlavor}`,
        headers: adminAuthHeader,
      });
      expect(stock.json().data[0].quantity).toBe('-999.000');
    });

    it('queda auditada, con la foto asociada', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/waste',
        headers: adminAuthHeader,
        payload: wastePayload(),
      });
      expect(response.json().data.photoPath).toBe('org1/WASTE_PHOTO/foto.jpg');

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'SHOP_WASTE_CREATED', entityId: response.json().data.id },
      });
      expect(audit).not.toBeNull();
      expect(audit?.module).toBe('SHOP_OPS');
    });
  });

  // --- gasto variable ---------------------------------------------------------

  describe('gasto variable', () => {
    function expensePayload(overrides: Record<string, unknown> = {}) {
      return {
        locationId: locationShop,
        amount: '1500.50',
        category: 'Limpieza',
        description: 'Detergente y lavandina',
        idempotencyKey: 'gasto-1',
        ...overrides,
      };
    }

    it('crea el gasto y no genera ningún movimiento de inventario', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/expenses',
        headers: adminAuthHeader,
        payload: expensePayload(),
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.amount).toBe('1500.50');

      const movements = await prisma.inventoryMovement.count({ where: { organizationId } });
      expect(movements).toBe(0);
    });

    it('el comprobante es opcional', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/expenses',
        headers: adminAuthHeader,
        payload: expensePayload(),
      });
      expect(response.json().data.receiptPath).toBeNull();
    });

    it('rechaza un monto cero o negativo (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/expenses',
        headers: adminAuthHeader,
        payload: expensePayload({ amount: '0' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('rechaza sin categoría o sin descripción (400)', async () => {
      const noCategory = await app.inject({
        method: 'POST',
        url: '/api/shop/expenses',
        headers: adminAuthHeader,
        payload: expensePayload({ category: '' }),
      });
      expect(noCategory.statusCode).toBe(400);

      const noDescription = await app.inject({
        method: 'POST',
        url: '/api/shop/expenses',
        headers: adminAuthHeader,
        payload: expensePayload({ description: '' }),
      });
      expect(noDescription.statusCode).toBe(400);
    });

    it('idempotencia: la misma idempotencyKey no genera dos gastos', async () => {
      const payload = expensePayload();
      const first = await app.inject({
        method: 'POST',
        url: '/api/shop/expenses',
        headers: adminAuthHeader,
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/shop/expenses',
        headers: adminAuthHeader,
        payload,
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().data.id).toBe(first.json().data.id);

      const count = await prisma.variableExpense.count({ where: { organizationId } });
      expect(count).toBe(1);
    });

    it('queda auditado', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/expenses',
        headers: adminAuthHeader,
        payload: expensePayload(),
      });
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'SHOP_VARIABLE_EXPENSE_CREATED', entityId: response.json().data.id },
      });
      expect(audit).not.toBeNull();
      expect(audit?.module).toBe('SHOP_OPS');
    });
  });

  // --- sin stock ------------------------------------------------------------

  describe('sin stock', () => {
    it('registra el evento sin modificar el stock', async () => {
      await loadInitialStock(locationShop, productFlavor, '5');
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/stockouts',
        headers: adminAuthHeader,
        payload: {
          locationId: locationShop,
          productId: productFlavor,
          idempotencyKey: 'stockout-1',
        },
      });
      expect(response.statusCode).toBe(201);

      const stock = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationShop}&productId=${productFlavor}`,
        headers: adminAuthHeader,
      });
      expect(stock.json().data[0].quantity).toBe('5.000'); // sin cambios
    });

    it('no bloquea aunque el teórico ya sea negativo', async () => {
      // Sin depósito con stock configurado: nada impide registrar el evento.
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/stockouts',
        headers: adminAuthHeader,
        payload: {
          locationId: locationShop,
          productId: productFlavor,
          idempotencyKey: 'stockout-2',
        },
      });
      expect(response.statusCode).toBe(201);
    });

    it('classification es null cuando no hay ningún depósito activo configurado', async () => {
      // El fixture del beforeEach ya trae un DEPOT -- se desactiva para probar
      // el caso "ninguno configurado" sin inventar una organización aparte.
      await prisma.location.update({ where: { id: locationDepot }, data: { active: false } });
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/stockouts',
        headers: adminAuthHeader,
        payload: {
          locationId: locationShop,
          productId: productFlavor,
          idempotencyKey: 'stockout-3',
        },
      });
      expect(response.json().data.classification).toBeNull();
    });

    it('classification es URGENT_RESTOCK cuando el depósito tiene stock del producto', async () => {
      await loadInitialStock(locationDepot, productFlavor, '50');
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/stockouts',
        headers: adminAuthHeader,
        payload: {
          locationId: locationShop,
          productId: productFlavor,
          idempotencyKey: 'stockout-4',
        },
      });
      expect(response.json().data.classification).toBe('URGENT_RESTOCK');
    });

    it('classification es SUPPLY_SHORTAGE cuando el depósito no tiene stock del producto', async () => {
      // El depósito existe (activo) pero nunca recibió stock de este producto.
      await loadInitialStock(locationDepot, productClosed, '10'); // otro producto, no el consultado
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/stockouts',
        headers: adminAuthHeader,
        payload: {
          locationId: locationShop,
          productId: productFlavor,
          idempotencyKey: 'stockout-5',
        },
      });
      expect(response.json().data.classification).toBe('SUPPLY_SHORTAGE');
    });

    it('idempotencia: la misma idempotencyKey no genera dos eventos', async () => {
      const payload = {
        locationId: locationShop,
        productId: productFlavor,
        idempotencyKey: 'stockout-retry',
      };
      const first = await app.inject({
        method: 'POST',
        url: '/api/shop/stockouts',
        headers: adminAuthHeader,
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/shop/stockouts',
        headers: adminAuthHeader,
        payload,
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().data.id).toBe(first.json().data.id);

      const count = await prisma.stockoutEvent.count({ where: { organizationId } });
      expect(count).toBe(1);
    });
  });

  // --- adjuntos (fotos / comprobantes) ---------------------------------------

  describe('subida de adjuntos', () => {
    it('genera una URL de subida firmada para una foto de merma', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/attachments/upload-url',
        headers: adminAuthHeader,
        payload: { purpose: 'WASTE_PHOTO', filename: 'merma.jpg' },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json().data;
      expect(body.bucket).toBe('shop-attachments');
      expect(body.path).toMatch(new RegExp(`^${organizationId}/WASTE_PHOTO/`));
      expect(body.signedUrl).toContain('https://');
    });

    it('DEPOSIT_MANAGER no puede pedir una URL de subida (403, mismo criterio que merma)', async () => {
      asDeposit();
      const response = await app.inject({
        method: 'POST',
        url: '/api/shop/attachments/upload-url',
        headers: depositAuthHeader,
        payload: { purpose: 'WASTE_PHOTO', filename: 'merma.jpg' },
      });
      expect(response.statusCode).toBe(403);
    });
  });
});
