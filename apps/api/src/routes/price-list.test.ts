import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles, seedProductTypes, seedUnitsOfMeasure } =
  await import('../test/db-helpers.js');

/**
 * Tests del importador de listas de precios/costos y del mapeo
 * referencia<->catálogo (Etapa 6.2) -- ver docs/ETAPA-6.2-CIERRE-INTEGRAL.md.
 * Construidos contra los DOS archivos reales inspeccionados
 * (`test/fixtures/lista-precio-costo-helacor.xlsx` y
 * `lista-valor-venta-sep2026.xlsx`, ver price-list-parser.test.ts para los
 * tests del parser puro en sí).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COST_FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'test',
  'fixtures',
  'lista-precio-costo-helacor.xlsx',
);
const SALE_PRICE_FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'test',
  'fixtures',
  'lista-valor-venta-sep2026.xlsx',
);

function buildMultipartBody(
  fields: Record<string, string>,
  file: { fieldName: string; filename: string; content: Buffer; contentType: string },
): { body: Buffer; contentType: string } {
  const boundary = '----sistemaGridoTestBoundaryPL';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  parts.push(file.content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('/api/price-list-imports', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let costFixture: Buffer;
  let salePriceFixture: Buffer;

  const adminAuthHeader = { authorization: 'Bearer admin-token' };
  const employeeAuthHeader = { authorization: 'Bearer empleada-token' };

  function asAdmin() {
    mockGetUser({
      data: { user: { id: 'sub-admin-pl', email: 'admin-pl@test.com' } },
      error: null,
    });
  }
  function asEmployee() {
    mockGetUser({
      data: { user: { id: 'sub-empleada-pl', email: 'empleada-pl@test.com' } },
      error: null,
    });
  }

  async function uploadCostFixture() {
    asAdmin();
    const { body, contentType } = buildMultipartBody(
      { source: 'HELACOR_COST_LIST' },
      {
        fieldName: 'file',
        filename: 'lista-precio-costo-helacor.xlsx',
        content: costFixture,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    );
    return app.inject({
      method: 'POST',
      url: '/api/price-list-imports',
      headers: { ...adminAuthHeader, 'content-type': contentType },
      payload: body,
    });
  }

  async function uploadSalePriceFixture() {
    asAdmin();
    const { body, contentType } = buildMultipartBody(
      { source: 'HELACOR_SALE_PRICE_LIST' },
      {
        fieldName: 'file',
        filename: 'lista-valor-venta-sep2026.xlsx',
        content: salePriceFixture,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    );
    return app.inject({
      method: 'POST',
      url: '/api/price-list-imports',
      headers: { ...adminAuthHeader, 'content-type': contentType },
      payload: body,
    });
  }

  async function confirmImport(id: string, effectiveFrom: string, idempotencyKey: string) {
    return app.inject({
      method: 'POST',
      url: `/api/price-list-imports/${id}/confirm`,
      headers: adminAuthHeader,
      payload: { idempotencyKey, effectiveFrom },
    });
  }

  beforeEach(async () => {
    costFixture = await readFile(COST_FIXTURE_PATH);
    salePriceFixture = await readFile(SALE_PRICE_FIXTURE_PATH);
    await resetCoreTables();
    organizationId = await seedOrganization();
    const roleIds = await seedRoles();
    app = await buildServer();

    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-pl@test.com',
        authSubject: 'sub-admin-pl',
      },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.SHOP_EMPLOYEE,
        displayName: 'Empleada',
        email: 'empleada-pl@test.com',
        authSubject: 'sub-empleada-pl',
      },
    });
  });

  // --- Subida + parser real end-to-end ------------------------------------

  it('ADMIN sube el archivo REAL de costos y queda PREVIEW_READY con las 36 filas de producto reales', async () => {
    const res = await uploadCostFixture();
    expect(res.statusCode).toBe(201);
    const body = res.json().data;
    expect(body.status).toBe('PREVIEW_READY');
    expect(body.priceType).toBe('COST_WITH_TAX');
    expect(body.totalRows).toBe(36);
    expect(body.validRows).toBe(36);
    expect(body.errorRows).toBe(0);
    expect(body.rawPeriodLabel).toContain('2026');
  });

  it('ADMIN sube el archivo REAL de precios de venta y queda PREVIEW_READY con las 78 filas de producto reales', async () => {
    const res = await uploadSalePriceFixture();
    expect(res.statusCode).toBe(201);
    const body = res.json().data;
    expect(body.status).toBe('PREVIEW_READY');
    expect(body.priceType).toBe('SALE_PRICE');
    expect(body.totalRows).toBe(78);
    expect(body.validRows).toBe(78);
  });

  it('el preview del archivo de costos usa el valor "Precio C/ IVA" (nunca S/IVA) para CASSATA', async () => {
    const upload = await uploadCostFixture();
    const preview = await app.inject({
      method: 'GET',
      url: `/api/price-list-imports/${upload.json().data.id}`,
      headers: adminAuthHeader,
    });
    const rows = preview.json().data.rows as Array<{
      rawLabel: string;
      rawValueWithoutTax: string;
      rawValueWithTax: string;
    }>;
    const cassata = rows.find((r) => r.rawLabel === 'CASSATA x 8 Porciones');
    expect(cassata).toBeDefined();
    // Precio S/ IVA real = 14689.471058215544, C/ IVA = 17774.25998044081
    // (ver inspección del archivo real) -- redondeado a 2 decimales.
    expect(cassata!.rawValueWithoutTax).toBe('14689.47');
    expect(cassata!.rawValueWithTax).toBe('17774.26');
  });

  it('SHOP_EMPLOYEE no puede subir una lista de precios', async () => {
    asEmployee();
    const { body, contentType } = buildMultipartBody(
      { source: 'HELACOR_COST_LIST' },
      {
        fieldName: 'file',
        filename: 'x.xlsx',
        content: costFixture,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/price-list-imports',
      headers: { ...employeeAuthHeader, 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
  });

  it('subir el MISMO archivo exacto dos veces no duplica el import (idempotencia de archivo)', async () => {
    const first = await uploadCostFixture();
    const second = await uploadCostFixture();
    expect(second.statusCode).toBe(200);
    expect(second.json().data.id).toBe(first.json().data.id);
    expect(second.json().data.alreadyImported).toBe(true);
    const count = await prisma.priceListImport.count({ where: { organizationId } });
    expect(count).toBe(1);
  });

  it('Etapa 6.2, sección 17: dos subidas CONCURRENTES del mismo archivo de precios no duplican el import', async () => {
    const [r1, r2] = await Promise.all([uploadCostFixture(), uploadCostFixture()]);
    expect([r1.statusCode, r2.statusCode].every((s) => s === 200 || s === 201)).toBe(true);
    expect([r1.statusCode, r2.statusCode].filter((s) => s === 201)).toHaveLength(1);
    const count = await prisma.priceListImport.count({ where: { organizationId } });
    expect(count).toBe(1);
  });

  // --- Confirmación --------------------------------------------------------

  it('confirmar sin effectiveFrom es rechazado (400) -- nunca se infiere del rótulo de período del archivo', async () => {
    const upload = await uploadCostFixture();
    const res = await app.inject({
      method: 'POST',
      url: `/api/price-list-imports/${upload.json().data.id}/confirm`,
      headers: adminAuthHeader,
      payload: { idempotencyKey: 'confirmar-sin-fecha' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('confirmar crea PriceReference + PriceValue para cada fila válida; reconfirmar con la misma clave es idempotente', async () => {
    const upload = await uploadCostFixture();
    const id = upload.json().data.id as string;
    const first = await confirmImport(id, '2026-09-01', 'confirmar-costos-1');
    expect(first.statusCode).toBe(200);
    expect(first.json().data.status).toBe('CONFIRMED');

    const referenceCount = await prisma.priceReference.count({
      where: { organizationId, priceType: 'COST_WITH_TAX' },
    });
    expect(referenceCount).toBe(36);
    const valueCount = await prisma.priceValue.count({ where: { organizationId } });
    expect(valueCount).toBe(36);

    const second = await confirmImport(id, '2026-09-01', 'confirmar-costos-1');
    expect(second.statusCode).toBe(200);
    const referenceCountAfterRetry = await prisma.priceReference.count({
      where: { organizationId, priceType: 'COST_WITH_TAX' },
    });
    expect(referenceCountAfterRetry).toBe(36);
  });

  it('reimportar el mismo archivo con una vigencia distinta AGREGA un PriceValue nuevo sin duplicar la PriceReference', async () => {
    const upload1 = await uploadCostFixture();
    await confirmImport(upload1.json().data.id, '2026-09-01', 'confirmar-costos-v1');

    // "Reimportar" con otra vigencia: mismo archivo, otra fecha -- nunca se
    // asume que dos archivos del mismo período son necesariamente
    // duplicados (sección 9 del prompt), pero acá es el MISMO valor, así
    // que agrega historial sin conflicto.
    await prisma.priceListImport.updateMany({
      where: { organizationId },
      data: { fileHash: 'otro-hash-simulado-reimport' },
    });
    const upload2 = await uploadCostFixture();
    const confirm2 = await confirmImport(
      upload2.json().data.id,
      '2026-10-01',
      'confirmar-costos-v2',
    );
    expect(confirm2.statusCode).toBe(200);

    const referenceCount = await prisma.priceReference.count({
      where: { organizationId, priceType: 'COST_WITH_TAX' },
    });
    expect(referenceCount).toBe(36); // nunca duplica la referencia
    const valueCount = await prisma.priceValue.count({ where: { organizationId } });
    expect(valueCount).toBe(72); // pero sí agrega un valor histórico por cada fila, para cada vigencia
  });

  it('confirmar con la MISMA vigencia pero un valor DISTINTO al ya registrado es un conflicto controlado (409), sin aplicar nada parcial', async () => {
    const upload1 = await uploadCostFixture();
    await confirmImport(upload1.json().data.id, '2026-09-01', 'confirmar-costos-conflicto-1');
    const referenceCountBefore = await prisma.priceReference.count({ where: { organizationId } });

    // Simula un archivo distinto con el mismo label pero otro valor,
    // reimportado exactamente a la misma vigencia -- se arma insertando
    // directamente una fila de import con un valor manualmente distinto en
    // vez de depender de tener un segundo archivo real con valores
    // distintos (no lo tenemos).
    const secondImport = await prisma.priceListImport.create({
      data: {
        organizationId,
        source: 'HELACOR_COST_LIST',
        priceType: 'COST_WITH_TAX',
        originalFilename: 'costo-conflicto.xlsx',
        fileHash: 'hash-conflicto-simulado',
        status: 'PREVIEW_READY',
        totalRows: 1,
        validRows: 1,
        errorRows: 0,
        createdById: (
          await prisma.appUser.findFirstOrThrow({
            where: { organizationId, email: 'admin-pl@test.com' },
          })
        ).id,
        rows: {
          create: [
            {
              rowNumber: 1,
              rawLabel: 'CASSATA x 8 Porciones',
              rawValueWithTax: '99999.99',
              status: 'VALID',
            },
          ],
        },
      },
    });
    const conflictConfirm = await confirmImport(
      secondImport.id,
      '2026-09-01',
      'confirmar-conflicto',
    );
    expect(conflictConfirm.statusCode).toBe(409);

    // Nada parcial: ni un nuevo PriceValue ni una PriceReference nueva.
    const referenceCountAfter = await prisma.priceReference.count({ where: { organizationId } });
    expect(referenceCountAfter).toBe(referenceCountBefore);
    const conflictValue = await prisma.priceValue.findFirst({
      where: { organizationId, priceListImportId: secondImport.id },
    });
    expect(conflictValue).toBeNull();
  });
});

describe('/api/price-reference-product-mappings', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let productFrutilla: string;
  let productLimon: string;
  let productNaranja: string;
  let referenceId: string;

  const adminAuthHeader = { authorization: 'Bearer admin-token' };

  function asAdmin() {
    mockGetUser({
      data: { user: { id: 'sub-admin-mapping', email: 'admin-mapping@test.com' } },
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
    asAdmin();

    const category = await prisma.category.create({ data: { organizationId, name: 'Palitos' } });
    const admin = await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-mapping@test.com',
        authSubject: 'sub-admin-mapping',
      },
    });

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
    productFrutilla = await createProduct('Palito Frutal Frutilla');
    productLimon = await createProduct('Palito Frutal Limón');
    productNaranja = await createProduct('Palito Frutal Naranja');

    // Referencia Grido "Palito Frutales" -- ejemplo textual del prompt
    // (sección 8): una referencia de Grido más gruesa que el catálogo
    // interno, que distingue 3 productos por sabor.
    referenceId = (
      await prisma.priceReference.create({
        data: { organizationId, priceType: 'COST_WITH_TAX', label: 'Palito Frutales' },
      })
    ).id;
    await prisma.priceValue.create({
      data: {
        organizationId,
        priceReferenceId: referenceId,
        priceType: 'COST_WITH_TAX',
        value: '500.00',
        effectiveFrom: new Date('2020-01-01'),
        priceListImportId: (
          await prisma.priceListImport.create({
            data: {
              organizationId,
              source: 'HELACOR_COST_LIST',
              priceType: 'COST_WITH_TAX',
              originalFilename: 'x.xlsx',
              fileHash: 'hash-mapping-test',
              status: 'CONFIRMED',
              totalRows: 1,
              validRows: 1,
              createdById: admin.id,
              confirmedById: admin.id,
              confirmedAt: new Date(),
              effectiveFrom: new Date('2020-01-01'),
              rows: {
                create: [
                  {
                    rowNumber: 1,
                    rawLabel: 'Palito Frutales',
                    rawValueWithTax: '500.00',
                    status: 'VALID',
                  },
                ],
              },
            },
            include: { rows: true },
          })
        ).id,
        priceListImportRowId: (
          await prisma.priceListImportRow.findFirstOrThrow({
            where: { organizationId, rawLabel: 'Palito Frutales' },
          })
        ).id,
        createdById: admin.id,
      },
    });
  });

  it('una referencia Grido se mapea a VARIOS productos internos (1 referencia -> N productos, nunca 1:1 forzado)', async () => {
    for (const productId of [productFrutilla, productLimon, productNaranja]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/price-reference-product-mappings',
        headers: adminAuthHeader,
        payload: { priceReferenceId: referenceId, productId },
      });
      expect(res.statusCode).toBe(201);
    }
    const list = await app.inject({
      method: 'GET',
      url: `/api/price-reference-product-mappings?priceReferenceId=${referenceId}`,
      headers: adminAuthHeader,
    });
    expect(list.json().data).toHaveLength(3);
  });

  it('un producto SIN mapeo resuelve price-resolution con value null (nunca inventa un costo)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/products/${productFrutilla}/price-resolution?priceType=COST_WITH_TAX`,
      headers: adminAuthHeader,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.value).toBeNull();
  });

  it('mapear un producto a una nueva referencia desactiva el mapeo activo anterior del MISMO tipo de precio (a lo sumo uno activo)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/price-reference-product-mappings',
      headers: adminAuthHeader,
      payload: { priceReferenceId: referenceId, productId: productFrutilla },
    });
    const otherReference = await prisma.priceReference.create({
      data: { organizationId, priceType: 'COST_WITH_TAX', label: 'Otra referencia' },
    });
    const remap = await app.inject({
      method: 'POST',
      url: '/api/price-reference-product-mappings',
      headers: adminAuthHeader,
      payload: { priceReferenceId: otherReference.id, productId: productFrutilla },
    });
    expect(remap.statusCode).toBe(201);

    const activeMappings = await prisma.priceReferenceProductMapping.findMany({
      where: { organizationId, productId: productFrutilla, active: true },
    });
    expect(activeMappings).toHaveLength(1);
    expect(activeMappings[0].priceReferenceId).toBe(otherReference.id);
  });

  it('un producto CON mapeo resuelve price-resolution con el valor vigente de su referencia', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/price-reference-product-mappings',
      headers: adminAuthHeader,
      payload: { priceReferenceId: referenceId, productId: productFrutilla },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/products/${productFrutilla}/price-resolution?priceType=COST_WITH_TAX`,
      headers: adminAuthHeader,
    });
    expect(res.json().data.value).toBe('500.00');
    expect(res.json().data.priceReferenceLabel).toBe('Palito Frutales');
  });
});
