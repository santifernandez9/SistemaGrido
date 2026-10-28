import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles, seedProductTypes, seedUnitsOfMeasure } =
  await import('../test/db-helpers.js');

/**
 * Tests de resolución explícita de diferencias (faltante confirmado /
 * sobrante resuelto, sección 4/5 del prompt de Etapa 6.2) y de detección de
 * posible error de tipeo (sección 6) -- ver docs/ETAPA-6.2-CIERRE-INTEGRAL.md.
 * Ejemplo del prompt: "Posible error de tipeo entre Casatta y Almendrado".
 */
describe('resolución de diferencias y detección de tipeo (Etapa 6.2)', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let adminId: string;
  let locationShop: string;
  let productCasatta: string;
  let productAlmendrado: string;
  let productCrocantino: string;

  const adminAuthHeader = { authorization: 'Bearer admin-token' };

  function asAdmin() {
    mockGetUser({
      data: { user: { id: 'sub-admin-diff', email: 'admin-diff@test.com' } },
      error: null,
    });
  }

  /**
   * Crea/actualiza el precio de venta vigente de un producto. Los sucesivos
   * `PriceValue` de una MISMA referencia se resuelven por
   * `effectiveFrom` (ver `resolveEffectivePricesForProducts`), así que para
   * simular un CAMBIO de precio en el tiempo (tests [P]-[S]) hay que
   * reutilizar la MISMA `PriceReference`/mapeo del producto y agregar un
   * `PriceValue` nuevo -- el mapeo producto->referencia es único por
   * `(organizationId, productId, priceType)`, así que una segunda
   * referencia para el mismo producto violaría esa unicidad.
   */
  async function setSalePrice(
    productId: string,
    label: string,
    value: string,
    effectiveFromIso: string = '2020-01-01',
  ) {
    const effectiveFrom = new Date(`${effectiveFromIso}T00:00:00.000Z`);
    const existingMapping = await prisma.priceReferenceProductMapping.findFirst({
      where: { organizationId, productId, priceType: 'SALE_PRICE' },
    });
    const reference = existingMapping
      ? { id: existingMapping.priceReferenceId }
      : await prisma.priceReference.create({
          data: { organizationId, priceType: 'SALE_PRICE', label },
        });
    const importRow = await prisma.priceListImport.create({
      data: {
        organizationId,
        source: 'HELACOR_SALE_PRICE_LIST',
        priceType: 'SALE_PRICE',
        originalFilename: 'x.xlsx',
        fileHash: `hash-${label}-${effectiveFromIso}-${Math.random()}`,
        status: 'CONFIRMED',
        totalRows: 1,
        validRows: 1,
        createdById: adminId,
        confirmedById: adminId,
        confirmedAt: new Date(),
        effectiveFrom,
        rows: {
          create: [{ rowNumber: 1, rawLabel: label, rawValueWithTax: value, status: 'VALID' }],
        },
      },
      include: { rows: true },
    });
    await prisma.priceValue.create({
      data: {
        organizationId,
        priceReferenceId: reference.id,
        priceType: 'SALE_PRICE',
        value,
        effectiveFrom,
        priceListImportId: importRow.id,
        priceListImportRowId: importRow.rows[0]!.id,
        createdById: adminId,
      },
    });
    if (!existingMapping) {
      await prisma.priceReferenceProductMapping.create({
        data: {
          organizationId,
          priceReferenceId: reference.id,
          priceType: 'SALE_PRICE',
          productId,
          confirmedById: adminId,
        },
      });
    }
  }

  beforeEach(async () => {
    await resetCoreTables();
    organizationId = await seedOrganization();
    const roleIds = await seedRoles();
    const productTypes = await seedProductTypes(organizationId);
    const unitsOfMeasure = await seedUnitsOfMeasure(organizationId);
    app = await buildServer();

    const shop = await prisma.location.create({
      data: { organizationId, name: 'Heladería Centro', type: 'ICE_CREAM_SHOP' },
    });
    locationShop = shop.id;
    const category = await prisma.category.create({ data: { organizationId, name: 'Postres' } });

    async function createProduct(name: string) {
      return (
        await prisma.product.create({
          data: {
            organizationId,
            name,
            categoryId: category.id,
            productTypeId: productTypes.HELADO,
            unitOfMeasureId: unitsOfMeasure.UNIDAD,
            unitsPerHandlingUnit: 1,
          },
        })
      ).id;
    }
    productCasatta = await createProduct('Casatta');
    productAlmendrado = await createProduct('Almendrado');
    productCrocantino = await createProduct('Crocantino');

    const admin = await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-diff@test.com',
        authSubject: 'sub-admin-diff',
      },
    });
    adminId = admin.id;
    asAdmin();

    await app.inject({
      method: 'POST',
      url: '/api/inventory/stock/initial',
      headers: adminAuthHeader,
      payload: { locationId: locationShop, productId: productCasatta, enteredQuantity: '10' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/inventory/stock/initial',
      headers: adminAuthHeader,
      payload: { locationId: locationShop, productId: productAlmendrado, enteredQuantity: '10' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/inventory/stock/initial',
      headers: adminAuthHeader,
      payload: { locationId: locationShop, productId: productCrocantino, enteredQuantity: '10' },
    });
  });

  async function submitCount(items: Array<{ productId: string; closedUnits: number }>) {
    return app.inject({
      method: 'POST',
      url: '/api/shop/counts',
      headers: adminAuthHeader,
      payload: {
        locationId: locationShop,
        weekStart: '2026-09-07',
        items,
        idempotencyKey: 'conteo-1',
      },
    });
  }

  /**
   * Igual que `submitCount`, pero permitiendo elegir `weekStart` -- usado por
   * los tests de precio histórico (sección 13 del prompt de Etapa 6.2.2) para
   * probar semanas distintas a la fija de arriba.
   */
  async function submitCountForWeek(
    items: Array<{ productId: string; closedUnits: number }>,
    weekStart: string,
    idempotencyKey: string,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/shop/counts',
      headers: adminAuthHeader,
      payload: { locationId: locationShop, weekStart, items, idempotencyKey },
    });
  }

  // --- Faltante confirmado / sobrante resuelto (secciones 4/5) -------------

  it('un SOBRANTE nunca se acepta en silencio: queda pendiente de revisión hasta resolverlo explícitamente', async () => {
    const res = await submitCount([
      { productId: productCasatta, closedUnits: 12 }, // +2 sobrante
      { productId: productAlmendrado, closedUnits: 10 },
      { productId: productCrocantino, closedUnits: 10 },
    ]);
    expect(res.statusCode).toBe(201);
    const item = res
      .json()
      .data.items.find((i: { productId: string }) => i.productId === productCasatta);
    expect(item.difference).toBe('2.000');
    expect(item.differenceResolution).toBeNull();

    const countId = res.json().data.id;
    const wrongKind = await app.inject({
      method: 'POST',
      url: `/api/shop/counts/${countId}/items/${item.id}/resolve-difference`,
      headers: adminAuthHeader,
      payload: { kind: 'SHORTAGE_CONFIRMED' },
    });
    expect(wrongKind.statusCode).toBe(400); // no es un faltante

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/shop/counts/${countId}/items/${item.id}/resolve-difference`,
      headers: adminAuthHeader,
      payload: { kind: 'SURPLUS_RESOLVED', note: 'Sobrante revisado, era una venta mal cargada' },
    });
    expect(resolved.statusCode).toBe(200);
    const resolvedItem = resolved
      .json()
      .data.items.find((i: { productId: string }) => i.productId === productCasatta);
    expect(resolvedItem.differenceResolution).toBe('SURPLUS_RESOLVED');
    expect(resolvedItem.differenceResolvedById).toBe(adminId);

    // Resolverlo dos veces es un conflicto controlado, no un error silencioso.
    const again = await app.inject({
      method: 'POST',
      url: `/api/shop/counts/${countId}/items/${item.id}/resolve-difference`,
      headers: adminAuthHeader,
      payload: { kind: 'SURPLUS_RESOLVED' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('un FALTANTE recontado se confirma como FALTANTE CONFIRMADO preservando el primer conteo', async () => {
    // Faltante de 8 sobre 10 (80%) dispara el reconteo obligatorio (>=25%).
    const firstCount = await submitCount([
      { productId: productCasatta, closedUnits: 2 },
      { productId: productAlmendrado, closedUnits: 10 },
      { productId: productCrocantino, closedUnits: 10 },
    ]);
    expect(firstCount.json().data.status).toBe('RECOUNT_REQUIRED');
    const countId = firstCount.json().data.id;
    const originalItem = firstCount
      .json()
      .data.items.find((i: { productId: string }) => i.productId === productCasatta);
    expect(originalItem.physicalQuantity).toBe('2.000');
    expect(originalItem.difference).toBe('-8.000');

    const recount = await app.inject({
      method: 'POST',
      url: `/api/shop/counts/${countId}/recount`,
      headers: adminAuthHeader,
      payload: {
        items: [{ productId: productCasatta, closedUnits: 2 }], // confirma el mismo faltante
        idempotencyKey: 'reconteo-1',
      },
    });
    expect(recount.statusCode).toBe(200);
    expect(recount.json().data.status).toBe('COMPLETED');
    const recountedItem = recount
      .json()
      .data.items.find((i: { productId: string }) => i.productId === productCasatta);
    // El PRIMER conteo nunca se sobrescribe -- sigue siendo -8 (mismo valor
    // acá porque el reconteo reprodujo el mismo físico, pero el campo nunca
    // se pierde/reemplaza por diseño).
    expect(recountedItem.physicalQuantity).toBe('2.000');
    expect(recountedItem.difference).toBe('-8.000');
    expect(recountedItem.recounted).toBe(true);

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/shop/counts/${countId}/items/${recountedItem.id}/resolve-difference`,
      headers: adminAuthHeader,
      payload: { kind: 'SHORTAGE_CONFIRMED' },
    });
    expect(confirmed.statusCode).toBe(200);
    const finalItem = confirmed
      .json()
      .data.items.find((i: { productId: string }) => i.productId === productCasatta);
    expect(finalItem.differenceResolution).toBe('SHORTAGE_CONFIRMED');
    expect(finalItem.physicalQuantity).toBe('2.000'); // preservado, nunca sobrescrito
  });

  // --- Detección de posible error de tipeo (sección 6) ----------------------

  it('detecta un candidato de tipeo cuando faltante y sobrante se compensan EXACTO con el MISMO precio de venta (ejemplo del prompt: Casatta/Almendrado)', async () => {
    await setSalePrice(productCasatta, 'CASATTA x 8 Porciones', '1800.00');
    await setSalePrice(productAlmendrado, 'ALMENDRADO x 8 Porciones', '1800.00');

    const res = await submitCount([
      { productId: productCasatta, closedUnits: 8 }, // -2 faltante
      { productId: productAlmendrado, closedUnits: 12 }, // +2 sobrante
      { productId: productCrocantino, closedUnits: 10 }, // sin diferencia
    ]);
    expect(res.statusCode).toBe(201);
    const candidates = res.json().data.typoCandidates as Array<{
      shortageProductId: string;
      surplusProductId: string;
      compensatingQuantity: string;
      salePriceUsed: string;
      status: string;
    }>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.shortageProductId).toBe(productCasatta);
    expect(candidates[0]!.surplusProductId).toBe(productAlmendrado);
    expect(candidates[0]!.compensatingQuantity).toBe('2.000');
    expect(candidates[0]!.salePriceUsed).toBe('1800.00');
    expect(candidates[0]!.status).toBe('PENDING');

    const countId = res.json().data.id;
    const candidateId = (candidates[0] as unknown as { id: string }).id;
    const resolve = await app.inject({
      method: 'POST',
      url: `/api/shop/counts/${countId}/typo-candidates/${candidateId}/resolve`,
      headers: adminAuthHeader,
      payload: { status: 'CONFIRMED', note: 'Confirmado: se tipeó Almendrado en vez de Casatta' },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().data.status).toBe('CONFIRMED');
    expect(resolve.json().data.resolvedById).toBe(adminId);

    // Nunca modifica Sale/InventoryMovement automáticamente -- sólo documenta.
    const movementCount = await prisma.inventoryMovement.count({
      where: { organizationId, movementType: { not: 'INITIAL_STOCK' } },
    });
    expect(movementCount).toBe(0);
  });

  it('cantidades que NO se compensan exactamente nunca sugieren un candidato de tipeo', async () => {
    await setSalePrice(productCasatta, 'CASATTA x 8 Porciones', '1800.00');
    await setSalePrice(productAlmendrado, 'ALMENDRADO x 8 Porciones', '1800.00');

    const res = await submitCount([
      { productId: productCasatta, closedUnits: 8 }, // -2
      { productId: productAlmendrado, closedUnits: 13 }, // +3 (no compensa)
      { productId: productCrocantino, closedUnits: 10 },
    ]);
    expect(res.json().data.typoCandidates).toHaveLength(0);
  });

  it('mismo precio de venta pero SIN compensación exacta -> ninguna sugerencia', async () => {
    await setSalePrice(productCasatta, 'CASATTA x 8 Porciones', '1800.00');
    await setSalePrice(productAlmendrado, 'ALMENDRADO x 8 Porciones', '1800.00');
    const res = await submitCount([
      { productId: productCasatta, closedUnits: 9 }, // -1
      { productId: productAlmendrado, closedUnits: 15 }, // +5
      { productId: productCrocantino, closedUnits: 10 },
    ]);
    expect(res.json().data.typoCandidates).toHaveLength(0);
  });

  it('compensación exacta pero con precios de venta DISTINTOS -> ninguna sugerencia', async () => {
    await setSalePrice(productCasatta, 'CASATTA x 8 Porciones', '1800.00');
    await setSalePrice(productAlmendrado, 'ALMENDRADO x 8 Porciones', '2500.00'); // distinto
    const res = await submitCount([
      { productId: productCasatta, closedUnits: 8 }, // -2
      { productId: productAlmendrado, closedUnits: 12 }, // +2, compensa en cantidad
      { productId: productCrocantino, closedUnits: 10 },
    ]);
    expect(res.json().data.typoCandidates).toHaveLength(0);
  });

  it('sin precio de venta configurado para alguno de los dos productos, nunca se sugiere (nunca se inventa un precio)', async () => {
    await setSalePrice(productCasatta, 'CASATTA x 8 Porciones', '1800.00');
    // productAlmendrado sin SALE_PRICE mapeado.
    const res = await submitCount([
      { productId: productCasatta, closedUnits: 8 },
      { productId: productAlmendrado, closedUnits: 12 },
      { productId: productCrocantino, closedUnits: 10 },
    ]);
    expect(res.json().data.typoCandidates).toHaveLength(0);
  });

  it('un mismo faltante puede generar VARIOS candidatos ambiguos (múltiples sobrantes que compensan igual, sin decidir cuál es el correcto)', async () => {
    await setSalePrice(productCasatta, 'CASATTA x 8 Porciones', '1800.00');
    await setSalePrice(productAlmendrado, 'ALMENDRADO x 8 Porciones', '1800.00');
    await setSalePrice(productCrocantino, 'CROCANTINO', '1800.00');

    const res = await submitCount([
      { productId: productCasatta, closedUnits: 8 }, // -2 faltante
      { productId: productAlmendrado, closedUnits: 12 }, // +2 sobrante, mismo precio
      { productId: productCrocantino, closedUnits: 12 }, // +2 sobrante, mismo precio -- AMBIGUO
    ]);
    const candidates = res.json().data.typoCandidates as Array<{ surplusProductId: string }>;
    expect(candidates).toHaveLength(2);
    const surplusIds = candidates.map((c) => c.surplusProductId).sort();
    expect(surplusIds).toEqual([productAlmendrado, productCrocantino].sort());
  });

  // --- Precio histórico de la semana del conteo (sección 13, Etapa 6.2.2) --
  //
  // Ejemplo del prompt: en la semana de septiembre Casatta y Almendrado
  // valen ambos $10.500; en octubre cambian a $11.000/$12.000. Analizar el
  // conteo de septiembre tiene que seguir detectando el candidato con los
  // precios DE SEPTIEMBRE, nunca con el precio vigente "hoy" ni con el
  // vigente al momento en que se corre el test. Para que el test discrimine
  // de verdad entre "hoy" (fecha real del sistema) y "la semana del
  // conteo", la semana contada y el precio nuevo quedan ambos en el pasado
  // respecto de la fecha real de ejecución -- así, un bug que usara
  // `new Date()` en lugar de `weekEndDate(weekStart)` resolvería el precio
  // NUEVO (distinto) y el candidato dejaría de detectarse.

  it('[P] la detección de tipeo usa el precio de venta VIGENTE PARA LA SEMANA DEL CONTEO, no el de hoy', async () => {
    // Único precio vigente, muy anterior a la semana contada -- si el
    // detector usara `new Date()` en vez de la fecha del conteo, seguiría
    // encontrando este mismo precio (es el único que existe), así que este
    // test por sí solo no discrimina el bug -- ver [Q] para el caso que sí
    // lo discrimina. Sirve para fijar el comportamiento básico esperado.
    await setSalePrice(productCasatta, 'CASATTA x 8 Porciones', '10500.00', '2026-05-01');
    await setSalePrice(productAlmendrado, 'ALMENDRADO x 8 Porciones', '10500.00', '2026-05-01');

    const res = await submitCountForWeek(
      [
        { productId: productCasatta, closedUnits: 8 }, // -2 faltante
        { productId: productAlmendrado, closedUnits: 12 }, // +2 sobrante
        { productId: productCrocantino, closedUnits: 10 },
      ],
      '2026-06-01',
      'conteo-historico-p',
    );
    expect(res.statusCode).toBe(201);
    const candidates = res.json().data.typoCandidates as Array<{ salePriceUsed: string }>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.salePriceUsed).toBe('10500.00');
  });

  it('[Q] un cambio de precio POSTERIOR a la semana del conteo no altera la detección histórica', async () => {
    // Precio vigente DURANTE la semana contada (junio): mismo precio para
    // ambos productos -> compensación exacta esperable.
    await setSalePrice(productCasatta, 'CASATTA x 8 Porciones', '10500.00', '2026-05-01');
    await setSalePrice(productAlmendrado, 'ALMENDRADO x 8 Porciones', '10500.00', '2026-05-01');
    // Precio NUEVO, vigente DESPUÉS de la semana contada pero ANTES de la
    // fecha real de hoy (2026-09-11) -- distinto entre los dos productos.
    // Si el detector usara `new Date()` en vez de la fecha del conteo,
    // resolvería ESTE precio (distinto) y el candidato NO se detectaría.
    await setSalePrice(productCasatta, 'CASATTA x 8 Porciones (nuevo)', '11000.00', '2026-07-01');
    await setSalePrice(
      productAlmendrado,
      'ALMENDRADO x 8 Porciones (nuevo)',
      '12000.00',
      '2026-07-01',
    );

    const res = await submitCountForWeek(
      [
        { productId: productCasatta, closedUnits: 8 }, // -2 faltante
        { productId: productAlmendrado, closedUnits: 12 }, // +2 sobrante
        { productId: productCrocantino, closedUnits: 10 },
      ],
      '2026-06-01', // semana ANTERIOR al cambio de precio de julio
      'conteo-historico-q',
    );
    expect(res.statusCode).toBe(201);
    const candidates = res.json().data.typoCandidates as Array<{
      surplusProductId: string;
      salePriceUsed: string;
    }>;
    // Se detecta usando el precio DE LA SEMANA CONTADA ($10.500), no el
    // precio nuevo ($11.000/$12.000) vigente hoy.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.surplusProductId).toBe(productAlmendrado);
    expect(candidates[0]!.salePriceUsed).toBe('10500.00');

    // Confirma además que el candidato ya persistido no se recalcula
    // retroactivamente al consultar el conteo más tarde -- sigue reflejando
    // la detección histórica original.
    const countId = res.json().data.id;
    const later = await app.inject({
      method: 'GET',
      url: `/api/shop/counts/${countId}`,
      headers: adminAuthHeader,
    });
    const laterCandidates = later.json().data.typoCandidates as Array<{ salePriceUsed: string }>;
    expect(laterCandidates).toHaveLength(1);
    expect(laterCandidates[0]!.salePriceUsed).toBe('10500.00');
  });

  it('[R] mismo precio histórico + cantidades compensatorias en la semana del conteo -> candidato', async () => {
    // Precio vigente desde ANTES de la semana contada -- sin ningún cambio
    // posterior en juego (eso ya lo cubre [Q]); acá sólo importa que el
    // precio histórico correcto se use y que la compensación se detecte.
    await setSalePrice(productCasatta, 'CASATTA x 8 Porciones', '10500.00', '2026-05-01');
    await setSalePrice(productAlmendrado, 'ALMENDRADO x 8 Porciones', '10500.00', '2026-05-01');

    const res = await submitCountForWeek(
      [
        { productId: productCasatta, closedUnits: 8 }, // -2 faltante
        { productId: productAlmendrado, closedUnits: 12 }, // +2 sobrante
        { productId: productCrocantino, closedUnits: 10 },
      ],
      '2026-06-01',
      'conteo-historico-r',
    );
    expect(res.statusCode).toBe(201);
    const candidates = res.json().data.typoCandidates as Array<{
      compensatingQuantity: string;
      salePriceUsed: string;
    }>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.compensatingQuantity).toBe('2.000');
    expect(candidates[0]!.salePriceUsed).toBe('10500.00');
  });

  it('[S] precios históricos DISTINTOS entre sí en la semana del conteo -> ningún candidato', async () => {
    // Vigentes durante la semana contada (junio), pero DISTINTOS entre los
    // dos productos -- no debe sugerirse nada aunque las cantidades
    // compensen exacto.
    await setSalePrice(productCasatta, 'CASATTA x 8 Porciones', '10500.00', '2026-05-01');
    await setSalePrice(productAlmendrado, 'ALMENDRADO x 8 Porciones', '9000.00', '2026-05-01');

    const res = await submitCountForWeek(
      [
        { productId: productCasatta, closedUnits: 8 }, // -2
        { productId: productAlmendrado, closedUnits: 12 }, // +2, compensa en cantidad
        { productId: productCrocantino, closedUnits: 10 },
      ],
      '2026-06-01',
      'conteo-historico-s',
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().data.typoCandidates).toHaveLength(0);
  });
});
