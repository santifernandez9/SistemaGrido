import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles, seedProductTypes, seedUnitsOfMeasure } =
  await import('../test/db-helpers.js');

/**
 * Tests de presentaciones físicas de conteo (Etapa 6.2.2, secciones
 * 14-19 del prompt, letras T-Z de la sección 20) -- ver
 * docs/ETAPA-6.2.2-HARDENING-HITO1.md. Ejemplo del prompt: Producto X con
 * Unidad=1, Pack=6, Caja=24 configuradas SIN hardcodear esos nombres --
 * cualquier `UnitOfMeasure` ya sembrada puede ser una presentación, con su
 * propio factor de conversión a la cantidad canónica. El backend hace
 * siempre la conversión (nunca el frontend).
 */
describe('presentaciones físicas de conteo (Etapa 6.2.2)', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let locationShop: string;
  let categoryId: string;
  let unitUnidad: string;
  let unitCaja: string;
  let unitPack: string;
  let productTypeInsumo: string;

  const adminAuthHeader = { authorization: 'Bearer admin-token' };

  function asAdmin() {
    mockGetUser({
      data: { user: { id: 'sub-admin-presentaciones', email: 'admin-presentaciones@test.com' } },
      error: null,
    });
  }

  beforeEach(async () => {
    await resetCoreTables();
    organizationId = await seedOrganization();
    const roleIds = await seedRoles();
    const productTypes = await seedProductTypes(organizationId);
    productTypeInsumo = productTypes.INSUMO;
    const unitsOfMeasure = await seedUnitsOfMeasure(organizationId);
    unitUnidad = unitsOfMeasure.UNIDAD;
    unitCaja = unitsOfMeasure.CAJA;
    app = await buildServer();

    const shop = await prisma.location.create({
      data: { organizationId, name: 'Heladería Centro', type: 'ICE_CREAM_SHOP' },
    });
    locationShop = shop.id;
    const category = await prisma.category.create({ data: { organizationId, name: 'Insumos' } });
    categoryId = category.id;

    // Unidad de manejo adicional ("Pack") -- no viene de `seedUnitsOfMeasure`
    // (que sólo siembra UNIDAD/LATA/CAJA), a propósito para demostrar que
    // CUALQUIER `UnitOfMeasure` puede ser presentación, sin lista cerrada.
    const pack = await prisma.unitOfMeasure.create({
      data: { organizationId, code: 'PACK', name: 'Pack' },
    });
    unitPack = pack.id;

    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-presentaciones@test.com',
        authSubject: 'sub-admin-presentaciones',
      },
    });
    asAdmin();
  });

  afterEach(async () => {
    await app.close();
  });

  // --- helpers ---------------------------------------------------------

  async function createProduct(name: string, unitOfMeasureId: string, unitsPerHandlingUnit = 1) {
    const product = await prisma.product.create({
      data: {
        organizationId,
        name,
        categoryId,
        productTypeId: productTypeInsumo,
        unitOfMeasureId,
        unitsPerHandlingUnit,
      },
    });
    return product.id;
  }

  async function seedInitialStock(productId: string, enteredQuantity: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/inventory/stock/initial',
      headers: adminAuthHeader,
      payload: { locationId: locationShop, productId, enteredQuantity },
    });
    expect(res.statusCode).toBe(201);
  }

  async function createPresentation(
    productId: string,
    unitOfMeasureId: string,
    conversionFactorToCanonical: string,
  ) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/products/${productId}/counting-presentations`,
      headers: adminAuthHeader,
      payload: { unitOfMeasureId, conversionFactorToCanonical },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data.id as string;
  }

  async function submitCount(
    items: Array<Record<string, unknown> & { productId: string }>,
    idempotencyKey: string,
    weekStart = '2026-09-07',
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/shop/counts',
      headers: adminAuthHeader,
      payload: { locationId: locationShop, weekStart, items, idempotencyKey },
    });
  }

  // --- GET /api/products/counting-presentations (lote, Shop PWA) --------

  it('GET /api/products/counting-presentations devuelve TODAS las presentaciones activas de la organización en una sola llamada', async () => {
    const productMulti = await createProduct('Bombones surtidos', unitUnidad, 1);
    // Producto sin ninguna presentación configurada -- no debe aportar
    // ninguna fila al listado en lote.
    await createProduct('Cucuruchos caja x12', unitCaja, 12);
    const presUnidad = await createPresentation(productMulti, unitUnidad, '1');
    const presCaja = await createPresentation(productMulti, unitCaja, '24');
    const toDeactivate = await createPresentation(productMulti, unitPack, '6');

    const deactivate = await app.inject({
      method: 'POST',
      url: `/api/products/${productMulti}/counting-presentations/${toDeactivate}/deactivate`,
      headers: adminAuthHeader,
    });
    expect(deactivate.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/api/products/counting-presentations',
      headers: adminAuthHeader,
    });
    expect(list.statusCode).toBe(200);
    const ids = list
      .json()
      .data.map((p: { id: string }) => p.id)
      .sort();
    // Sólo las ACTIVAS -- la desactivada no aparece; `productSimple` (sin
    // ninguna presentación configurada) tampoco aporta filas.
    expect(ids).toEqual([presUnidad, presCaja].sort());
  });

  // --- [T] producto con Unidad/Caja/Pack configuradas genéricamente ----

  it('[T] un producto puede configurarse con múltiples presentaciones simultáneas (Unidad/Caja/Pack), sin nombres hardcodeados', async () => {
    const productId = await createProduct('Bombones surtidos', unitUnidad, 1);
    await seedInitialStock(productId, '100');

    const presUnidad = await createPresentation(productId, unitUnidad, '1');
    const presPack = await createPresentation(productId, unitPack, '6');
    const presCaja = await createPresentation(productId, unitCaja, '24');

    const list = await app.inject({
      method: 'GET',
      url: `/api/products/${productId}/counting-presentations`,
      headers: adminAuthHeader,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(3);
    const ids = list
      .json()
      .data.map((p: { id: string }) => p.id)
      .sort();
    expect(ids).toEqual([presUnidad, presPack, presCaja].sort());

    const res = await submitCount(
      [{ productId, presentations: [{ presentationId: presCaja, quantity: 1 }] }],
      'conteo-presentaciones-t',
    );
    expect(res.statusCode).toBe(201);
    const item = res.json().data.items[0];
    expect(item.physicalQuantity).toBe('24.000');
    expect(item.presentationBreakdown).toEqual([
      {
        presentationId: presCaja,
        unitOfMeasureName: 'Caja',
        quantity: 1,
        conversionFactorToCanonical: '24.000',
      },
    ]);
  });

  // --- [U] la suma de varias presentaciones da la cantidad canónica ----

  it('[U] varias presentaciones cargadas a la vez suman correctamente a la cantidad canónica (ejemplo del prompt: 2 cajas x24 + 1 pack x6 + 3 unidades = 57)', async () => {
    const productId = await createProduct('Bombones surtidos', unitUnidad, 1);
    await seedInitialStock(productId, '100');

    const presUnidad = await createPresentation(productId, unitUnidad, '1');
    const presPack = await createPresentation(productId, unitPack, '6');
    const presCaja = await createPresentation(productId, unitCaja, '24');

    const res = await submitCount(
      [
        {
          productId,
          presentations: [
            { presentationId: presCaja, quantity: 2 }, // 2 x 24 = 48
            { presentationId: presPack, quantity: 1 }, // 1 x 6 = 6
            { presentationId: presUnidad, quantity: 3 }, // 3 x 1 = 3
          ],
        },
      ],
      'conteo-presentaciones-u',
    );
    expect(res.statusCode).toBe(201);
    const item = res.json().data.items[0];
    expect(item.physicalQuantity).toBe('57.000'); // 48 + 6 + 3
    expect(item.presentationBreakdown).toHaveLength(3);
  });

  // --- [V] presentación de OTRO producto -> rechazada -------------------

  it('[V] usar la presentación de OTRO producto se rechaza (nunca se confunde una presentación entre productos)', async () => {
    const productMulti = await createProduct('Bombones surtidos', unitUnidad, 1);
    await seedInitialStock(productMulti, '100');
    await createPresentation(productMulti, unitCaja, '24');

    const productOther = await createProduct('Alfajores', unitUnidad, 1);
    await seedInitialStock(productOther, '50');
    const presOtherBolsa = await createPresentation(productOther, unitPack, '10');

    const res = await submitCount(
      [
        // presentación de `productOther` usada para `productMulti` -- inválido.
        {
          productId: productMulti,
          presentations: [{ presentationId: presOtherBolsa, quantity: 1 }],
        },
        {
          productId: productOther,
          presentations: [{ presentationId: presOtherBolsa, quantity: 0 }],
        },
      ],
      'conteo-presentaciones-v',
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no existe, no está activa, o no pertenece/i);

    // Nunca se crea un InventoryCount parcial.
    const count = await prisma.inventoryCount.findFirst({ where: { organizationId } });
    expect(count).toBeNull();
  });

  // --- [W] presentación INACTIVA -> rechazada ---------------------------

  it('[W] una presentación DESACTIVADA no puede usarse para contar', async () => {
    const productId = await createProduct('Bombones surtidos', unitUnidad, 1);
    await seedInitialStock(productId, '100');
    const presUnidad = await createPresentation(productId, unitUnidad, '1');
    const presCaja = await createPresentation(productId, unitCaja, '24');

    const deactivate = await app.inject({
      method: 'POST',
      url: `/api/products/${productId}/counting-presentations/${presCaja}/deactivate`,
      headers: adminAuthHeader,
    });
    expect(deactivate.statusCode).toBe(200);

    const res = await submitCount(
      [{ productId, presentations: [{ presentationId: presCaja, quantity: 1 }] }],
      'conteo-presentaciones-w',
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no existe, no está activa, o no pertenece/i);

    // La presentación activa restante (`presUnidad`) sigue funcionando bien.
    const ok = await submitCount(
      [{ productId, presentations: [{ presentationId: presUnidad, quantity: 5 }] }],
      'conteo-presentaciones-w-ok',
    );
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.items[0].physicalQuantity).toBe('5.000');
  });

  // --- [X] presentación de OTRA organización -> rechazada ---------------

  it('[X] una presentación de OTRA organización nunca es visible ni utilizable (aislamiento multi-tenant)', async () => {
    const productId = await createProduct('Bombones surtidos', unitUnidad, 1);
    await seedInitialStock(productId, '100');
    // El producto de la organización A SÍ tiene presentaciones propias
    // configuradas (para llegar a la rama de validación cruzada en vez de
    // "no tiene presentaciones configuradas").
    await createPresentation(productId, unitCaja, '24');

    // Organización B, con su propio producto y presentación -- creados
    // directamente en la base (bypass de API, sólo para fijar el fixture
    // cruzado; nunca se llega a esto desde un flujo real de un único tenant).
    const orgB = await prisma.organization.create({ data: { name: 'Otra heladería' } });
    const productTypesB = await seedProductTypes(orgB.id);
    const unitsB = await seedUnitsOfMeasure(orgB.id);
    const categoryB = await prisma.category.create({
      data: { organizationId: orgB.id, name: 'Insumos B' },
    });
    const productB = await prisma.product.create({
      data: {
        organizationId: orgB.id,
        name: 'Producto de otra organización',
        categoryId: categoryB.id,
        productTypeId: productTypesB.INSUMO,
        unitOfMeasureId: unitsB.UNIDAD,
        unitsPerHandlingUnit: 1,
      },
    });
    const presentationB = await prisma.productCountingPresentation.create({
      data: {
        organizationId: orgB.id,
        productId: productB.id,
        unitOfMeasureId: unitsB.CAJA,
        conversionFactorToCanonical: '24',
      },
    });

    const res = await submitCount(
      [{ productId, presentations: [{ presentationId: presentationB.id, quantity: 1 }] }],
      'conteo-presentaciones-x',
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no existe, no está activa, o no pertenece/i);
  });

  // --- [Y] compatibilidad total con un producto SIN presentaciones -----

  it('[Y] un producto SIN presentaciones configuradas sigue funcionando exactamente igual que antes (closedUnits)', async () => {
    const productId = await createProduct('Cucuruchos caja x12', unitCaja, 12);
    await seedInitialStock(productId, '120');

    const okClosedUnits = await submitCount(
      [{ productId, closedUnits: 5 }],
      'conteo-presentaciones-y',
    );
    expect(okClosedUnits.statusCode).toBe(201);
    const item = okClosedUnits.json().data.items[0];
    expect(item.physicalQuantity).toBe('60.000'); // 5 cajas x 12
    expect(item.presentationBreakdown).toBeNull();

    // Enviar `presentations` para un producto sin ninguna configurada
    // también se rechaza (nada que resolver) -- nunca se ignora en silencio.
    const rejected = await submitCount(
      [
        {
          productId,
          presentations: [{ presentationId: '123e4567-e89b-42d3-a456-426614174000', quantity: 1 }],
        },
      ],
      'conteo-presentaciones-y-rechazado',
      '2026-09-14', // semana distinta -- la anterior ya tiene un InventoryCount
    );
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toMatch(
      /no tiene presentaciones de conteo configuradas/i,
    );
  });

  // --- [Z] genérico: sin ningún nombre hardcodeado ----------------------

  it('[Z] el backend es totalmente genérico -- presentaciones con nombres arbitrarios (no "Unidad/Caja/Pack") funcionan idénticamente, listas para que el frontend las renderice dinámicamente', async () => {
    const productId = await createProduct('Insumo raro', unitUnidad, 1);
    await seedInitialStock(productId, '200');

    // Unidades de manejo con nombres que NO son "Unidad/Caja/Pack" -- si
    // hubiera algún hardcodeo de esos tres nombres en el backend, esto
    // fallaría o se comportaría distinto.
    const bandeja = await prisma.unitOfMeasure.create({
      data: { organizationId, code: 'BANDEJA', name: 'Bandeja' },
    });
    const pallet = await prisma.unitOfMeasure.create({
      data: { organizationId, code: 'PALLET', name: 'Pallet' },
    });

    const presBandeja = await createPresentation(productId, bandeja.id, '15');
    const presPallet = await createPresentation(productId, pallet.id, '450');

    const list = await app.inject({
      method: 'GET',
      url: `/api/products/${productId}/counting-presentations`,
      headers: adminAuthHeader,
    });
    expect(list.statusCode).toBe(200);
    const names = list
      .json()
      .data.map((p: { unitOfMeasureName: string }) => p.unitOfMeasureName)
      .sort();
    expect(names).toEqual(['Bandeja', 'Pallet']);

    const res = await submitCount(
      [
        {
          productId,
          presentations: [
            { presentationId: presPallet, quantity: 1 }, // 450
            { presentationId: presBandeja, quantity: 2 }, // 30
          ],
        },
      ],
      'conteo-presentaciones-z',
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().data.items[0].physicalQuantity).toBe('480.000');
  });
});
