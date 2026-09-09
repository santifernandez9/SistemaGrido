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

  it('el preview muestra productos sin mapear, bloquea canConfirm y nunca crea Sale ni movimientos', async () => {
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
    // Etapa 5.1: con productos sin mapear, canConfirm es SIEMPRE false, aunque
    // el status siga siendo PREVIEW_READY -- ver test B más abajo.
    expect(body.data.canConfirm).toBe(false);
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

  /**
   * Sube el archivo real y mapea TODAS las filas VALID a un producto (Etapa
   * 5.1: una importación con cualquier fila VALID sin alias no puede
   * confirmarse -- ver sección "confirmación bloqueada por productos sin
   * mapear" más abajo). El artículo `24` (el que usan las aserciones de
   * Canje/SALE/BOM) se mapea explícitamente vía la API al `product` de
   * `beforeEach`; el resto de los ~134 códigos restantes se mapean en bloque
   * a un producto "genérico" vía `createMany` directo (más rápido que 134
   * llamadas HTTP, y esos códigos no son el foco de estos tests -- ya están
   * cubiertos por los tests de alias dedicados de arriba).
   */
  async function setupMappedImport() {
    const product = await prisma.product.findFirstOrThrow({ where: { organizationId } });
    const admin = await prisma.appUser.findFirstOrThrow({
      where: { organizationId, email: 'admin-sales@test.com' },
    });
    const category = await prisma.category.findFirstOrThrow({ where: { organizationId } });
    const productTypes = await prisma.productType.findMany({ where: { organizationId } });
    const unitOfMeasure = await prisma.unitOfMeasure.findFirstOrThrow({
      where: { organizationId, code: 'UNIDAD' },
    });
    const genericProduct = await prisma.product.create({
      data: {
        organizationId,
        name: 'Producto genérico (resto del Mix de Ventas)',
        categoryId: category.id,
        productTypeId: productTypes[0]!.id,
        unitOfMeasureId: unitOfMeasure.id,
        unitsPerHandlingUnit: 1,
      },
    });

    const upload = await uploadFixture();
    const importId = JSON.parse(upload.payload).data.id;

    const validRows = await prisma.salesImportRow.findMany({
      where: { organizationId, salesImportId: importId, status: 'VALID' },
      select: { rawArticleCode: true },
      distinct: ['rawArticleCode'],
    });
    const restCodes = validRows.map((r) => r.rawArticleCode).filter((code) => code !== '24');
    await prisma.productAlias.createMany({
      data: restCodes.map((externalCode) => ({
        organizationId,
        source: 'MIX_VENTAS' as const,
        externalCode,
        productId: genericProduct.id,
        confirmedById: admin.id,
      })),
    });

    asAdmin();
    await app.inject({
      method: 'POST',
      url: '/api/product-aliases',
      headers: adminAuthHeader,
      payload: { source: 'MIX_VENTAS', externalCode: '24', productId: product.id },
    });
    return { importId, productId: product.id, genericProductId: genericProduct.id };
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

    // Etapa 5.1: la importación sólo pudo confirmarse porque TODAS las 136
    // filas VALID quedaron mapeadas (ver `setupMappedImport`) -- se generó
    // una Sale + un movimiento SALE por cada una, ninguna quedó afuera.
    expect(await prisma.sale.count()).toBe(136);
    expect(await prisma.inventoryMovement.count({ where: { movementType: 'SALE' } })).toBe(136);

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

  // --- Confirmación bloqueada por productos sin mapear (Etapa 5.1) -----------

  /** Mapea (vía `createMany` directo) todos los códigos VALID del import a un
   * producto genérico, salvo los listados en `exceptCodes`. */
  async function mapAllValidCodesExcept(importId: string, exceptCodes: string[]) {
    const admin = await prisma.appUser.findFirstOrThrow({
      where: { organizationId, email: 'admin-sales@test.com' },
    });
    const category = await prisma.category.findFirstOrThrow({ where: { organizationId } });
    const productTypes = await prisma.productType.findMany({ where: { organizationId } });
    const unitOfMeasure = await prisma.unitOfMeasure.findFirstOrThrow({
      where: { organizationId, code: 'UNIDAD' },
    });
    const genericProduct = await prisma.product.create({
      data: {
        organizationId,
        name: `Producto genérico ${Date.now()}`,
        categoryId: category.id,
        productTypeId: productTypes[0]!.id,
        unitOfMeasureId: unitOfMeasure.id,
        unitsPerHandlingUnit: 1,
      },
    });
    const validRows = await prisma.salesImportRow.findMany({
      where: { organizationId, salesImportId: importId, status: 'VALID' },
      select: { rawArticleCode: true },
      distinct: ['rawArticleCode'],
    });
    const codesToMap = validRows
      .map((r) => r.rawArticleCode)
      .filter((code) => !exceptCodes.includes(code));
    await prisma.productAlias.createMany({
      data: codesToMap.map((externalCode) => ({
        organizationId,
        source: 'MIX_VENTAS' as const,
        externalCode,
        productId: genericProduct.id,
        confirmedById: admin.id,
      })),
    });
  }

  // A. Preview completamente mapeado.
  it('A. preview con todas las filas VALID mapeadas: hasUnmappedProducts=false, canConfirm=true', async () => {
    const { importId } = await setupMappedImport();
    asAdmin();
    const res = await app.inject({
      method: 'GET',
      url: `/api/sales-imports/${importId}`,
      headers: adminAuthHeader,
    });
    const body = JSON.parse(res.payload);
    expect(body.data.hasUnmappedProducts).toBe(false);
    expect(body.data.canConfirm).toBe(true);
  });

  // B. Preview con un único producto sin mapear.
  it('B. preview con un producto sin mapear: hasUnmappedProducts=true, canConfirm=false', async () => {
    const upload = await uploadFixture();
    const importId = JSON.parse(upload.payload).data.id;
    await mapAllValidCodesExcept(importId, ['24']); // deja SÓLO el artículo 24 sin mapear.

    asAdmin();
    const res = await app.inject({
      method: 'GET',
      url: `/api/sales-imports/${importId}`,
      headers: adminAuthHeader,
    });
    const body = JSON.parse(res.payload);
    expect(body.data.hasUnmappedProducts).toBe(true);
    expect(body.data.unmappedCodes).toHaveLength(1);
    expect(body.data.unmappedCodes[0].rawArticleCode).toBe('24');
    expect(body.data.canConfirm).toBe(false);
  });

  // C. Confirmación directa (sin depender del frontend) con un producto sin mapear.
  it('C. confirmar directamente con un producto sin mapear devuelve 409 sin ningún efecto', async () => {
    const upload = await uploadFixture();
    const importId = JSON.parse(upload.payload).data.id;
    await mapAllValidCodesExcept(importId, ['24']);

    asAdmin();
    const res = await app.inject({
      method: 'POST',
      url: `/api/sales-imports/${importId}/confirm`,
      headers: adminAuthHeader,
      payload: { idempotencyKey: 'blocked-confirm-1' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error.message).toMatch(/sin mapear/i);

    const importAfter = await prisma.salesImport.findUniqueOrThrow({ where: { id: importId } });
    expect(importAfter.status).toBe('PREVIEW_READY');
    expect(importAfter.confirmedAt).toBeNull();
    expect(importAfter.confirmIdempotencyKey).toBeNull();
    expect(await prisma.sale.count({ where: { organizationId, salesImportId: importId } })).toBe(0);
    expect(
      await prisma.inventoryMovement.count({
        where: { organizationId, sourceDocumentType: 'SALES_IMPORT', sourceDocumentId: importId },
      }),
    ).toBe(0);
    expect(
      await prisma.inventoryMovement.count({ where: { movementType: 'BOM_CONSUMPTION' } }),
    ).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'SALES_IMPORT_CONFIRMED' } })).toBe(0);
  });

  // D. Varios productos sin mapear -- misma protección, sin confirmación parcial.
  it('D. varios productos sin mapear: misma protección, ningún efecto parcial', async () => {
    // Sin mapear NADA: los ~135 códigos distintos quedan todos sin alias.
    const upload = await uploadFixture();
    const importId = JSON.parse(upload.payload).data.id;

    asAdmin();
    const res = await app.inject({
      method: 'POST',
      url: `/api/sales-imports/${importId}/confirm`,
      headers: adminAuthHeader,
      payload: { idempotencyKey: 'blocked-confirm-2' },
    });
    expect(res.statusCode).toBe(409);

    const importAfter = await prisma.salesImport.findUniqueOrThrow({ where: { id: importId } });
    expect(importAfter.status).toBe('PREVIEW_READY');
    expect(await prisma.sale.count({ where: { organizationId, salesImportId: importId } })).toBe(0);
    expect(
      await prisma.inventoryMovement.count({
        where: { organizationId, sourceDocumentType: 'SALES_IMPORT', sourceDocumentId: importId },
      }),
    ).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'SALES_IMPORT_CONFIRMED' } })).toBe(0);
  });

  // E. Alias resueltos DESPUÉS del preview inicial -- el backend siempre
  // decide con el estado actual de la base, nunca con lo que vio el preview
  // anterior (protección TOCTOU, sección 6 del prompt de hardening).
  it('E. mapear los códigos restantes después del preview inicial habilita la confirmación completa', async () => {
    const upload = await uploadFixture();
    const importId = JSON.parse(upload.payload).data.id;

    asAdmin();
    const initialPreview = await app.inject({
      method: 'GET',
      url: `/api/sales-imports/${importId}`,
      headers: adminAuthHeader,
    });
    expect(JSON.parse(initialPreview.payload).data.hasUnmappedProducts).toBe(true);

    // Mapea TODO (incluido el 24) directamente en base, simulando que el
    // ADMIN terminó de mapear todos los códigos sin mapear del preview.
    await mapAllValidCodesExcept(importId, []);

    const secondPreview = await app.inject({
      method: 'GET',
      url: `/api/sales-imports/${importId}`,
      headers: adminAuthHeader,
    });
    const secondBody = JSON.parse(secondPreview.payload);
    expect(secondBody.data.hasUnmappedProducts).toBe(false);
    expect(secondBody.data.canConfirm).toBe(true);

    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/sales-imports/${importId}/confirm`,
      headers: adminAuthHeader,
      payload: { idempotencyKey: 'confirm-after-mapping' },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(JSON.parse(confirmRes.payload).data.status).toBe('CONFIRMED');
    expect(await prisma.sale.count({ where: { organizationId, salesImportId: importId } })).toBe(
      136,
    );
  });

  // --- Etapa 5.2: consistencia transaccional de alias bajo concurrencia real ---

  /**
   * F. Reproduce el riesgo TOCTOU descrito en el hardening de Etapa 5.2:
   *
   *   1. import PREVIEW_READY, código externo `24` mapeado a Product A (el
   *      resto de los ~135 códigos restantes también mapeados -- Etapa 5.1
   *      exige mapeo completo para poder confirmar en absoluto);
   *   2. arranca la confirmación (POST .../confirm) -- una transacción real
   *      que, al recorrer las 136 filas creando Sale + movimientos uno por
   *      uno, tarda varios milisegundos reales (el mismo mecanismo que ya
   *      demuestran los tests de "confirmaciones CONCURRENTES" de más
   *      abajo), dando una ventana real para que otra operación se
   *      intercale;
   *   3. CONCURRENTEMENTE (mismo `Promise.all`, sin sleeps ni locks
   *      artificiales de este test) otro flujo remapea el código `24` de
   *      Product A a Product B vía `POST /api/product-aliases`.
   *
   * Qué se verifica (la propiedad de corrección real, no un resultado fijo):
   * bajo aislamiento `Serializable` (`confirmSalesImport`, Etapa 5.2),
   * PostgreSQL garantiza que la transacción de confirmación se comporta
   * como si hubiera corrido en algún orden serial válido respecto del
   * remapeo -- así que sólo hay DOS desenlaces legítimos, y el test
   * verifica que SIEMPRE ocurre exactamente uno de los dos, nunca un
   * estado intermedio/mezclado:
   *
   *   (a) La confirmación se serializa ANTES del remapeo: responde 200,
   *       queda CONFIRMED, y genera una Sale para el artículo 24 apuntando
   *       a Product A (el valor que leyó, coherente porque lo leyó y lo
   *       usó dentro de la MISMA transacción) -- el remapeo a B se aplica
   *       después, sin conflicto, y gobierna las importaciones futuras.
   *   (b) PostgreSQL detecta que no puede serializar ambas operaciones de
   *       forma consistente y aborta la confirmación (P2034 -> 409,
   *       ver `resolveConfirmConflictAfterTransactionConflict`): la
   *       transacción entera se revierte -- CERO Sale, CERO movimientos,
   *       CERO auditoría, `SalesImport` sigue PREVIEW_READY -- nunca una
   *       Sale creada con un alias a mitad de camino entre A y B.
   *
   * Lo que NUNCA debe pasar (y es lo que este test verdaderamente
   * comprueba, sea cual sea el desenlace real de la carrera en esta
   * corrida): una respuesta 200 sin que TODAS las 136 filas hayan generado
   * su Sale, o una Sale creada mientras la respuesta HTTP fue 409 -- eso
   * sería exactamente la "confirmación silenciosa con datos obsoletos"
   * que la Etapa 5.2 prohíbe.
   */
  it('F. remapear un alias concurrentemente con la confirmación nunca deja un estado parcial/torcido', async () => {
    const productA = await prisma.product.findFirstOrThrow({ where: { organizationId } });
    const category = await prisma.category.findFirstOrThrow({ where: { organizationId } });
    const productTypes = await prisma.productType.findMany({ where: { organizationId } });
    const unitOfMeasure = await prisma.unitOfMeasure.findFirstOrThrow({
      where: { organizationId, code: 'UNIDAD' },
    });
    const productB = await prisma.product.create({
      data: {
        organizationId,
        name: 'Bombon Crocante en Caja x 8 (remapeado B)',
        categoryId: category.id,
        productTypeId: productTypes[0]!.id,
        unitOfMeasureId: unitOfMeasure.id,
        unitsPerHandlingUnit: 1,
      },
    });

    const { importId } = await setupMappedImport(); // artículo 24 -> productA; resto -> genérico.

    asAdmin();
    async function confirm() {
      return app.inject({
        method: 'POST',
        url: `/api/sales-imports/${importId}/confirm`,
        headers: adminAuthHeader,
        payload: { idempotencyKey: 'confirm-vs-remap-race' },
      });
    }
    async function remapTo(productId: string) {
      return app.inject({
        method: 'POST',
        url: '/api/product-aliases',
        headers: adminAuthHeader,
        payload: { source: 'MIX_VENTAS', externalCode: '24', productId },
      });
    }

    const [confirmRes] = await Promise.all([confirm(), remapTo(productB.id)]);

    const finalImport = await prisma.salesImport.findUniqueOrThrow({ where: { id: importId } });
    const salesForImport = await prisma.sale.count({
      where: { organizationId, salesImportId: importId },
    });
    const movementsForImport = await prisma.inventoryMovement.count({
      where: { organizationId, sourceDocumentType: 'SALES_IMPORT', sourceDocumentId: importId },
    });
    const auditCount = await prisma.auditLog.count({
      where: { action: 'SALES_IMPORT_CONFIRMED', entityId: importId },
    });

    if (confirmRes.statusCode === 200) {
      // Desenlace (a): se serializó ANTES del remapeo -- coherente y completo.
      expect(finalImport.status).toBe('CONFIRMED');
      expect(salesForImport).toBe(136); // TODAS las filas, nunca una confirmación parcial.
      expect(movementsForImport).toBe(136);
      expect(auditCount).toBe(1);

      const saleForArticle24 = await prisma.sale.findFirstOrThrow({
        where: { organizationId, productId: { in: [productA.id, productB.id] } },
      });
      // Coherente con AMBOS órdenes seriales válidos: si la transacción de
      // confirmación leyó el alias antes de que el remapeo committeara, usa
      // A (y el remapeo a B se aplica después, sin conflicto); si el
      // remapeo ya había committeado cuando la confirmación tomó su
      // snapshot, lee y usa B directamente -- ninguno de los dos es un bug,
      // lo que NUNCA debe pasar es un valor que no sea ni A ni B (ya
      // descartado por el `where` de arriba) o una confirmación con menos
      // de 136 Sale (ya verificado arriba).
      expect([productA.id, productB.id]).toContain(saleForArticle24.productId);
    } else {
      // Desenlace (b): PostgreSQL abortó la confirmación por el conflicto de
      // serialización -- CERO efectos, nunca un estado a medio camino.
      expect(confirmRes.statusCode).toBe(409);
      expect(finalImport.status).toBe('PREVIEW_READY');
      expect(finalImport.confirmedAt).toBeNull();
      expect(finalImport.confirmIdempotencyKey).toBeNull();
      expect(salesForImport).toBe(0);
      expect(movementsForImport).toBe(0);
      expect(auditCount).toBe(0);
    }

    // El remapeo en sí (una operación independiente, no transaccionada con
    // la confirmación) siempre se aplica -- gobierna cualquier confirmación
    // FUTURA de este código, sea cual haya sido el desenlace de arriba.
    const finalAlias = await prisma.productAlias.findFirstOrThrow({
      where: { organizationId, source: 'MIX_VENTAS', externalCode: '24' },
    });
    expect(finalAlias.productId).toBe(productB.id);
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
