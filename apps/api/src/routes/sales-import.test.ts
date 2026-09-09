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
 * Tests del Importador de Ventas (Etapa 5) -- ver
 * docs/ETAPA-5-IMPORTADOR-VENTAS.md. Cubre, sobre el archivo real "Mix de
 * Ventas" (`test/fixtures/mixventas-desa-saavedra.xls`, ver
 * sales-import-parser.test.ts para los tests del parser en sí): preview
 * (nunca toca stock), alias (mapea sin tocar ventas confirmadas), confirmación
 * (Sale + SALE + BOM_CONSUMPTION en una transacción), Canje (venta real, no
 * merma), idempotencia de archivo y de confirmación (secuencial y
 * concurrente, real Promise.all sobre PostgreSQL), BOM, stock negativo
 * permitido, aislamiento multi-organización y auditoría.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', 'test', 'fixtures', 'mixventas-desa-saavedra.xls');

function buildMultipartBody(
  fields: Record<string, string>,
  file: { fieldName: string; filename: string; content: Buffer; contentType: string },
): { body: Buffer; contentType: string } {
  const boundary = '----sistemaGridoTestBoundary';
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

describe('/api/sales-imports', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let locationId: string;
  let fixtureBuffer: Buffer;

  const adminAuthHeader = { authorization: 'Bearer admin-token' };
  const employeeAuthHeader = { authorization: 'Bearer empleada-token' };

  function asAdmin() {
    mockGetUser({
      data: { user: { id: 'sub-admin-sales', email: 'admin-sales@test.com' } },
      error: null,
    });
  }
  function asEmployee() {
    mockGetUser({
      data: { user: { id: 'sub-empleada-sales', email: 'empleada-sales@test.com' } },
      error: null,
    });
  }

  async function uploadFixture(locId: string = locationId) {
    asAdmin();
    const { body, contentType } = buildMultipartBody(
      { locationId: locId },
      {
        fieldName: 'file',
        filename: 'mixventas-desa-saavedra.xls',
        content: fixtureBuffer,
        contentType: 'application/vnd.ms-excel',
      },
    );
    return app.inject({
      method: 'POST',
      url: '/api/sales-imports',
      headers: { ...adminAuthHeader, 'content-type': contentType },
      payload: body,
    });
  }

  beforeEach(async () => {
    fixtureBuffer = await readFile(FIXTURE_PATH);
    await resetCoreTables();
    organizationId = await seedOrganization();
    const roleIds = await seedRoles();
    const productTypes = await seedProductTypes(organizationId);
    const unitsOfMeasure = await seedUnitsOfMeasure(organizationId);
    app = await buildServer();

    const location = await prisma.location.create({
      data: { organizationId, name: 'Heladería Saavedra', type: 'ICE_CREAM_SHOP' },
    });
    locationId = location.id;

    const category = await prisma.category.create({ data: { organizationId, name: 'Bombones' } });
    await prisma.product.create({
      data: {
        organizationId,
        name: 'Bombon Crocante en Caja x 8',
        code: 'ART-24',
        categoryId: category.id,
        productTypeId: productTypes.HELADO,
        unitOfMeasureId: unitsOfMeasure.UNIDAD,
        unitsPerHandlingUnit: 1,
      },
    });

    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-sales@test.com',
        authSubject: 'sub-admin-sales',
      },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.SHOP_EMPLOYEE,
        displayName: 'Empleada',
        email: 'empleada-sales@test.com',
        authSubject: 'sub-empleada-sales',
        defaultLocationId: locationId,
      },
    });
  });

  // --- Subida + parser real end-to-end ------------------------------------

  it('ADMIN sube el archivo real y queda PREVIEW_READY (reconcilia contra el total del archivo)', async () => {
    const res = await uploadFixture();
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('PREVIEW_READY');
    expect(body.data.totalRows).toBe(136);
    expect(body.data.validRows).toBe(136);
    expect(body.data.fileStatedTotal).toBe('11778196.68');
    expect(body.data.alreadyImported).toBeUndefined();
  });

  it('SHOP_EMPLOYEE no puede subir un archivo de ventas', async () => {
    asEmployee();
    const { body, contentType } = buildMultipartBody(
      { locationId },
      {
        fieldName: 'file',
        filename: 'mixventas-desa-saavedra.xls',
        content: fixtureBuffer,
        contentType: 'application/vnd.ms-excel',
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales-imports',
      headers: { ...employeeAuthHeader, 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
  });

  it('un archivo no soportado se rechaza sin crear ningún import (FAILED nunca se persiste para esto)', async () => {
    asAdmin();
    const { body, contentType } = buildMultipartBody(
      { locationId },
      {
        fieldName: 'file',
        filename: 'no-es-un-xls.txt',
        content: Buffer.from('esto no es un archivo xls'),
        contentType: 'text/plain',
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales-imports',
      headers: { ...adminAuthHeader, 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.salesImport.count()).toBe(0);
  });

  // --- Idempotencia de ARCHIVO (sección 8, CRÍTICO) -----------------------

  it('subir el mismo archivo exacto dos veces no lo duplica (idempotencia de archivo)', async () => {
    const first = await uploadFixture();
    const second = await uploadFixture();
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.payload);
    expect(secondBody.data.alreadyImported).toBe(true);
    expect(secondBody.data.id).toBe(JSON.parse(first.payload).data.id);
    expect(await prisma.salesImport.count()).toBe(1);
  });

  it('dos subidas CONCURRENTES del mismo archivo no lo duplican', async () => {
    const [r1, r2] = await Promise.all([uploadFixture(), uploadFixture()]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 201]);
    expect(await prisma.salesImport.count()).toBe(1);
  });

  // --- Preview (nunca toca stock) ------------------------------------------

  it('el preview muestra productos sin mapear y nunca crea Sale ni movimientos', async () => {
    const upload = await uploadFixture();
    const id = JSON.parse(upload.payload).data.id;

    asAdmin();
    const res = await app.inject({
      method: 'GET',
      url: `/api/sales-imports/${id}`,
      headers: adminAuthHeader,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data.hasUnmappedProducts).toBe(true);
    expect(body.data.canConfirm).toBe(true);
    expect(body.data.rows).toHaveLength(136);

    expect(await prisma.sale.count()).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  // --- Alias ----------------------------------------------------------------

  it('un código mapeado vía alias aparece en mappedProducts y deja de estar sin mapear', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { organizationId } });
    const upload = await uploadFixture();
    const id = JSON.parse(upload.payload).data.id;

    asAdmin();
    const aliasRes = await app.inject({
      method: 'POST',
      url: '/api/product-aliases',
      headers: adminAuthHeader,
      payload: { source: 'MIX_VENTAS', externalCode: '24', productId: product.id },
    });
    expect(aliasRes.statusCode).toBe(201);

    const preview = await app.inject({
      method: 'GET',
      url: `/api/sales-imports/${id}`,
      headers: adminAuthHeader,
    });
    const body = JSON.parse(preview.payload);
    const mapped = body.data.mappedProducts.find(
      (m: { productId: string }) => m.productId === product.id,
    );
    expect(mapped).toBeDefined();
    expect(mapped.rowCount).toBe(2); // artículo 24 aparece 2 veces (normal + Canje).
    const stillUnmapped = body.data.unmappedCodes.find(
      (u: { rawArticleCode: string }) => u.rawArticleCode === '24',
    );
    expect(stillUnmapped).toBeUndefined();
  });

  it('SHOP_EMPLOYEE no puede crear un alias', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { organizationId } });
    asEmployee();
    const res = await app.inject({
      method: 'POST',
      url: '/api/product-aliases',
      headers: employeeAuthHeader,
      payload: { source: 'MIX_VENTAS', externalCode: '24', productId: product.id },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- Confirmación, Canje, BOM, stock negativo ------------------------------

  async function setupMappedImport() {
    const product = await prisma.product.findFirstOrThrow({ where: { organizationId } });
    const upload = await uploadFixture();
    const importId = JSON.parse(upload.payload).data.id;

    asAdmin();
    await app.inject({
      method: 'POST',
      url: '/api/product-aliases',
      headers: adminAuthHeader,
      payload: { source: 'MIX_VENTAS', externalCode: '24', productId: product.id },
    });
    return { importId, productId: product.id };
  }

  it('confirmar genera Sale + movimiento SALE sólo para las filas mapeadas, usa el importe real y permite stock negativo', async () => {
    const { importId, productId } = await setupMappedImport();

    asAdmin();
    const res = await app.inject({
      method: 'POST',
      url: `/api/sales-imports/${importId}/confirm`,
      headers: adminAuthHeader,
      payload: { idempotencyKey: 'confirm-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.status).toBe('CONFIRMED');

    const sales = await prisma.sale.findMany({ where: { organizationId, productId } });
    expect(sales).toHaveLength(2); // fila normal + fila Canje, mismo artículo 24.
    const canjeSale = sales.find((s) => s.isCanje);
    const normalSale = sales.find((s) => !s.isCanje);
    expect(canjeSale).toBeDefined();
    expect(normalSale).toBeDefined();
    // El importe real de la fila Canje (evidencia real: 12400, no un % inventado).
    expect(canjeSale!.amountReal.toString()).toBe('12400');
    expect(canjeSale!.isPromotion).toBe(true);

    const saleMovements = await prisma.inventoryMovement.findMany({
      where: { organizationId, productId, movementType: 'SALE' },
    });
    expect(saleMovements).toHaveLength(2);
    // No debe generarse ningún movimiento WASTE por el Canje -- es una venta real.
    expect(await prisma.inventoryMovement.count({ where: { movementType: 'WASTE' } })).toBe(0);

    // Sólo se creó Sale para el artículo mapeado (24) -- el resto de las 134
    // filas válidas quedaron sin mapear y NUNCA impactaron stock.
    expect(await prisma.sale.count()).toBe(2);
    expect(await prisma.inventoryMovement.count({ where: { movementType: 'SALE' } })).toBe(2);

    // Stock negativo permitido: nunca hubo INITIAL_STOCK para este producto,
    // así que el saldo queda negativo -- la confirmación igual tuvo éxito (arriba).
    const balance = await prisma.inventoryMovement.aggregate({
      where: { organizationId, productId },
      _sum: { quantity: true },
    });
    expect(balance._sum.quantity!.lessThan(0)).toBe(true);
  });

  it('BOM: una receta configurada genera BOM_CONSUMPTION trazado a la venta; sin receta no se inventa consumo', async () => {
    const { importId, productId } = await setupMappedImport();
    const category = await prisma.category.findFirstOrThrow({ where: { organizationId } });

    const insumoType = await prisma.productType.findFirstOrThrow({
      where: { organizationId, code: 'INSUMO' },
    });
    const unidad = await prisma.unitOfMeasure.findFirstOrThrow({
      where: { organizationId, code: 'UNIDAD' },
    });
    const pote = await prisma.product.create({
      data: {
        organizationId,
        name: 'Pote descartable',
        categoryId: category.id,
        productTypeId: insumoType.id,
        unitOfMeasureId: unidad.id,
        unitsPerHandlingUnit: 1,
      },
    });

    asAdmin();
    await app.inject({
      method: 'POST',
      url: '/api/bill-of-material-items',
      headers: adminAuthHeader,
      payload: { productId, componentProductId: pote.id, quantityPerUnit: '1' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/sales-imports/${importId}/confirm`,
      headers: adminAuthHeader,
      payload: { idempotencyKey: 'confirm-bom-1' },
    });

    const bomMovements = await prisma.inventoryMovement.findMany({
      where: { organizationId, productId: pote.id, movementType: 'BOM_CONSUMPTION' },
    });
    // 2 ventas de artículo 24 (normal + Canje), 1 pote por unidad vendida.
    expect(bomMovements).toHaveLength(2);
    for (const m of bomMovements) {
      expect(m.sourceDocumentType).toBe('SALE');
      expect(m.quantity.lessThan(0)).toBe(true);
    }
    const sales = await prisma.sale.findMany({ where: { organizationId, productId } });
    const saleIds = new Set(sales.map((s) => s.id));
    for (const m of bomMovements) {
      expect(saleIds.has(m.sourceDocumentId!)).toBe(true);
    }
  });

  // --- Idempotencia de CONFIRMACIÓN ------------------------------------------

  it('retry secuencial con la misma clave de confirmación devuelve el mismo resultado sin re-auditar', async () => {
    const { importId } = await setupMappedImport();

    asAdmin();
    await app.inject({
      method: 'POST',
      url: `/api/sales-imports/${importId}/confirm`,
      headers: adminAuthHeader,
      payload: { idempotencyKey: 'retry-key' },
    });
    const salesAfterFirst = await prisma.sale.count();
    const auditAfterFirst = await prisma.auditLog.count({
      where: { action: 'SALES_IMPORT_CONFIRMED' },
    });

    const second = await app.inject({
      method: 'POST',
      url: `/api/sales-imports/${importId}/confirm`,
      headers: adminAuthHeader,
      payload: { idempotencyKey: 'retry-key' },
    });
    expect(second.statusCode).toBe(200);
    expect(await prisma.sale.count()).toBe(salesAfterFirst);
    expect(await prisma.auditLog.count({ where: { action: 'SALES_IMPORT_CONFIRMED' } })).toBe(
      auditAfterFirst,
    );
  });

  it('retry secuencial con una clave distinta después de confirmado devuelve 409', async () => {
    const { importId } = await setupMappedImport();
    asAdmin();
    await app.inject({
      method: 'POST',
      url: `/api/sales-imports/${importId}/confirm`,
      headers: adminAuthHeader,
      payload: { idempotencyKey: 'key-a' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sales-imports/${importId}/confirm`,
      headers: adminAuthHeader,
      payload: { idempotencyKey: 'key-b' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('dos confirmaciones CONCURRENTES con la misma clave tienen éxito ambas con un único resultado', async () => {
    const { importId, productId } = await setupMappedImport();
    asAdmin();

    async function confirm() {
      return app.inject({
        method: 'POST',
        url: `/api/sales-imports/${importId}/confirm`,
        headers: adminAuthHeader,
        payload: { idempotencyKey: 'concurrent-same' },
      });
    }
    const [r1, r2] = await Promise.all([confirm(), confirm()]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r1.payload).data.id).toBe(JSON.parse(r2.payload).data.id);

    expect(await prisma.sale.count({ where: { organizationId, productId } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'SALES_IMPORT_CONFIRMED' } })).toBe(1);
  });

  it('dos confirmaciones CONCURRENTES con claves distintas: una gana, la otra responde 409, sin doble modificación', async () => {
    const { importId, productId } = await setupMappedImport();
    asAdmin();

    async function confirm(key: string) {
      return app.inject({
        method: 'POST',
        url: `/api/sales-imports/${importId}/confirm`,
        headers: adminAuthHeader,
        payload: { idempotencyKey: key },
      });
    }
    const [r1, r2] = await Promise.all([confirm('race-a'), confirm('race-b')]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    expect(await prisma.sale.count({ where: { organizationId, productId } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'SALES_IMPORT_CONFIRMED' } })).toBe(1);
  });

  // --- Aislamiento multi-organización/ubicación ------------------------------

  it('no se puede ver ni confirmar un import de otra organización', async () => {
    const { importId } = await setupMappedImport();

    const otherOrg = await prisma.organization.create({ data: { name: 'Otra heladería' } });
    const roles = await prisma.role.findMany();
    const otherLocation = await prisma.location.create({
      data: { organizationId: otherOrg.id, name: 'Otra sucursal', type: 'ICE_CREAM_SHOP' },
    });
    await prisma.appUser.create({
      data: {
        organizationId: otherOrg.id,
        roleId: roles.find((r) => r.code === 'ADMIN')!.id,
        displayName: 'Admin Otra Org',
        email: 'admin-otra-org@test.com',
        authSubject: 'sub-admin-otra-org',
        defaultLocationId: otherLocation.id,
      },
    });

    mockGetUser({
      data: { user: { id: 'sub-admin-otra-org', email: 'admin-otra-org@test.com' } },
      error: null,
    });
    const previewRes = await app.inject({
      method: 'GET',
      url: `/api/sales-imports/${importId}`,
      headers: { authorization: 'Bearer admin-otra-org-token' },
    });
    expect(previewRes.statusCode).toBe(404);

    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/sales-imports/${importId}/confirm`,
      headers: { authorization: 'Bearer admin-otra-org-token' },
      payload: { idempotencyKey: 'cross-org' },
    });
    expect(confirmRes.statusCode).toBe(404);
  });

  it('no se puede subir un archivo a una ubicación de otra organización', async () => {
    const otherOrg = await prisma.organization.create({ data: { name: 'Otra heladería 2' } });
    const otherLocation = await prisma.location.create({
      data: { organizationId: otherOrg.id, name: 'Otra sucursal 2', type: 'ICE_CREAM_SHOP' },
    });
    const res = await uploadFixture(otherLocation.id);
    expect(res.statusCode).toBe(400);
    expect(await prisma.salesImport.count()).toBe(0);
  });
});
