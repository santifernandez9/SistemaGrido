import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const { closeWeeklyClosing, confirmWeeklyClosingReview } =
  await import('../services/weekly-closing.js');

/**
 * Tests del Cierre Semanal del núcleo operativo (Etapa 6) -- ver
 * docs/ETAPA-6-CIERRE-SEMANAL.md. Cubre lo pedido por la sección 23 del
 * prompt: preparación/checklist/cierre/reapertura, aislamiento
 * multi-tenant y por ubicación, cálculo teórico/real/diferencia,
 * COUNT_CORRECTION sólo con diferencia no nula (incluyendo teórico
 * negativo), snapshot generado una sola vez e inmutable, idempotencia
 * secuencial y concurrente, una sola auditoría por confirmación lógica,
 * reapertura que preserva el snapshot anterior, recierre que no destruye
 * historia ni duplica el ajuste ya aplicado, ventas importadas de Etapa 5
 * reflejadas en el checklist, precisión Decimal y permisos.
 *
 * Escenario común (ver beforeEach): período [2026-08-31 .. 2026-09-06],
 * conteo gobernante de la semana siguiente (2026-09-07, documento del
 * cliente, sección 15/24 -- ver comentario de `WeeklyClosing` en el
 * schema). Cuatro productos cubren diferencia positiva, negativa, cero y
 * teórico negativo.
 */
describe('/api/weekly-closings', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let adminUserId: string;
  let locationShop: string;
  let productA: string; // diferencia positiva
  let productB: string; // diferencia negativa
  let productC: string; // diferencia cero
  let productD: string; // teórico negativo

  const PERIOD_START = '2026-08-31';
  const PERIOD_END = '2026-09-06';
  const GOVERNING_WEEK_START = '2026-09-07';

  const adminAuthHeader = { authorization: 'Bearer admin-token' };
  const employeeAuthHeader = { authorization: 'Bearer empleada-token' };
  const depositAuthHeader = { authorization: 'Bearer deposito-token' };

  function asAdmin() {
    mockGetUser({
      data: { user: { id: 'sub-admin-wc', email: 'admin-wc@test.com' } },
      error: null,
    });
  }
  function asEmployee() {
    mockGetUser({
      data: { user: { id: 'sub-empleada-wc', email: 'empleada-wc@test.com' } },
      error: null,
    });
  }
  function asDeposit() {
    mockGetUser({
      data: { user: { id: 'sub-deposito-wc', email: 'deposito-wc@test.com' } },
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

    const shop = await prisma.location.create({
      data: { organizationId, name: 'Heladería Centro', type: 'ICE_CREAM_SHOP' },
    });
    locationShop = shop.id;

    const category = await prisma.category.create({
      data: { organizationId, name: 'Insumos' },
    });

    async function createProduct(name: string) {
      const product = await prisma.product.create({
        data: {
          organizationId,
          name,
          categoryId: category.id,
          productTypeId: productTypes.INSUMO,
          unitOfMeasureId: unitsOfMeasure.UNIDAD,
          unitsPerHandlingUnit: 1,
        },
      });
      return product.id;
    }
    productA = await createProduct('Producto A');
    productB = await createProduct('Producto B');
    productC = await createProduct('Producto C');
    productD = await createProduct('Producto D');

    const admin = await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-wc@test.com',
        authSubject: 'sub-admin-wc',
      },
    });
    adminUserId = admin.id;
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.SHOP_EMPLOYEE,
        displayName: 'Empleada',
        email: 'empleada-wc@test.com',
        authSubject: 'sub-empleada-wc',
        defaultLocationId: locationShop,
      },
    });
    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.DEPOSIT_MANAGER,
        displayName: 'Encargado',
        email: 'deposito-wc@test.com',
        authSubject: 'sub-deposito-wc',
      },
    });

    asAdmin();

    // Etapa 6.2, sección 11 del prompt: cerrar exige costo C/IVA vigente
    // para todo producto con stock REAL != 0 -- productA/B/C sí tienen
    // stock real en el conteo gobernante (ver `submitGoverningCount`),
    // productD queda en 0 (no lo necesita). El importador/mapeo real de
    // precios se prueba aparte, en price-list.test.ts -- acá sólo se
    // necesita que el costo EXISTA para no desviar el foco de estos tests
    // (herencia de Etapa 6/6.1) hacia la valorización.
    for (const [productId, productName] of [
      [productA, 'Producto A'],
      [productB, 'Producto B'],
      [productC, 'Producto C'],
    ] as const) {
      await seedProductCost({
        organizationId,
        productId,
        productName,
        actorId: adminUserId,
        costWithTax: '100.00',
      });
    }

    // Stock teórico inicial: A=10, B=8, C=4, D=-3 (ajuste negativo, sección
    // I -- "stock teórico negativo permitido").
    await app.inject({
      method: 'POST',
      url: '/api/inventory/stock/initial',
      headers: adminAuthHeader,
      payload: { locationId: locationShop, productId: productA, enteredQuantity: '10' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/inventory/stock/initial',
      headers: adminAuthHeader,
      payload: { locationId: locationShop, productId: productB, enteredQuantity: '8' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/inventory/stock/initial',
      headers: adminAuthHeader,
      payload: { locationId: locationShop, productId: productC, enteredQuantity: '4' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/inventory/adjustments',
      headers: adminAuthHeader,
      payload: {
        locationId: locationShop,
        productId: productD,
        enteredQuantity: '-3',
        reason: 'Setup de test: stock teórico negativo',
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  // --- helpers ---------------------------------------------------------

  async function submitGoverningCount() {
    return app.inject({
      method: 'POST',
      url: '/api/shop/counts',
      headers: adminAuthHeader,
      payload: {
        locationId: locationShop,
        weekStart: GOVERNING_WEEK_START,
        items: [
          { productId: productA, closedUnits: 12 }, // real 12, teórico 10 -> +2
          { productId: productB, closedUnits: 3 }, // real 3, teórico 8 -> -5
          { productId: productC, closedUnits: 4 }, // real 4, teórico 4 -> 0
          { productId: productD, closedUnits: 0 }, // real 0, teórico -3 -> +3
        ],
        idempotencyKey: 'conteo-gobernante-1',
      },
    });
  }

  /**
   * Etapa 6.2, sección 4 del prompt: envía el conteo gobernante y, si algún
   * ítem queda `RECOUNT_REQUIRED` (productB dispara la regla porcentual
   * obligatoria de faltante >=25%, ver comentario de `readyToClose`),
   * reenvía el MISMO valor físico como reconteo para que el conteo llegue
   * a COMPLETED sin alterar ninguna diferencia esperada por los tests.
   */
  async function submitGoverningCountAndComplete() {
    const countResponse = await submitGoverningCount();
    expect(countResponse.statusCode).toBe(201);
    const countBody = countResponse.json().data;
    if (countBody.status === 'RECOUNT_REQUIRED') {
      const flaggedItems = countBody.items.filter((i: { needsRecount: boolean }) => i.needsRecount);
      const recountResponse = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${countBody.id}/recount`,
        headers: adminAuthHeader,
        payload: {
          items: flaggedItems.map((i: { productId: string; closedUnits: number | null }) => ({
            productId: i.productId,
            closedUnits: i.closedUnits,
          })),
          idempotencyKey: `reconteo-${countBody.id}`,
        },
      });
      expect(recountResponse.statusCode).toBe(200);
    }
    return countResponse;
  }

  async function prepareClosing(headers: Record<string, string> = adminAuthHeader) {
    return app.inject({
      method: 'POST',
      url: '/api/weekly-closings',
      headers,
      payload: { locationId: locationShop, periodStart: PERIOD_START },
    });
  }

  async function getDetail(id: string, headers: Record<string, string> = adminAuthHeader) {
    return app.inject({ method: 'GET', url: `/api/weekly-closings/${id}`, headers });
  }

  async function confirmReview(id: string, headers: Record<string, string> = adminAuthHeader) {
    return app.inject({
      method: 'POST',
      url: `/api/weekly-closings/${id}/confirm-review`,
      headers,
    });
  }

  async function closeClosing(
    id: string,
    idempotencyKey: string,
    headers: Record<string, string> = adminAuthHeader,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/weekly-closings/${id}/close`,
      headers,
      payload: { idempotencyKey },
    });
  }

  async function reopenClosing(
    id: string,
    reason: string,
    headers: Record<string, string> = adminAuthHeader,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/weekly-closings/${id}/reopen`,
      headers,
      payload: { reason },
    });
  }

  /**
   * Etapa 6.2.2, secciones 7/8/10 del prompt (BLOCKER, CONFIRMADO): ninguna
   * diferencia distinta de cero puede quedar sin resolución explícita antes
   * de cerrar -- un FALTANTE necesita `SHORTAGE_CONFIRMED`, un SOBRANTE
   * necesita `SURPLUS_RESOLVED` (mismos dos `DifferenceResolutionKind` de
   * Etapa 6.2, nunca inventados de nuevo). Resuelve TODAS las diferencias
   * pendientes del conteo gobernante, releyendo su estado FINAL (después de
   * cualquier reconteo) para no resolver contra valores desactualizados.
   */
  async function resolveAllDifferences(countId: string) {
    const detail = await app.inject({
      method: 'GET',
      url: `/api/shop/counts/${countId}`,
      headers: adminAuthHeader,
    });
    const items = detail.json().data.items as Array<{
      id: string;
      difference: string | null;
      differenceResolution: string | null;
    }>;
    for (const item of items) {
      if (item.difference === null || item.differenceResolution !== null) continue;
      const diff = Number(item.difference);
      if (diff === 0) continue;
      const kind = diff < 0 ? 'SHORTAGE_CONFIRMED' : 'SURPLUS_RESOLVED';
      const resolveResponse = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${countId}/items/${item.id}/resolve-difference`,
        headers: adminAuthHeader,
        payload: { kind },
      });
      expect(resolveResponse.statusCode).toBe(200);
    }
  }

  /** Prepara + envía el conteo gobernante (con reconteo automático si hace
   * falta, ver `submitGoverningCountAndComplete`), resuelve TODAS sus
   * diferencias (ver `resolveAllDifferences`) y confirma revisión -- deja
   * el cierre listo para `close` (`canClose === true`). */
  async function readyToClose() {
    const prepared = await prepareClosing();
    const id = prepared.json().data.id as string;
    const countResponse = await submitGoverningCountAndComplete();
    await resolveAllDifferences(countResponse.json().data.id as string);
    await confirmReview(id);
    return id;
  }

  // --- A: preparación / get-or-create -----------------------------------

  describe('preparación', () => {
    it('crea un cierre OPEN nuevo para una ubicación y período', async () => {
      const response = await prepareClosing();
      expect(response.statusCode).toBe(201);
      const data = response.json().data;
      expect(data.status).toBe('OPEN');
      expect(data.periodStart).toBe(PERIOD_START);
      expect(data.periodEnd).toBe(PERIOD_END);
      expect(data.currentRevision).toBe(0);
    });

    it('preparar el mismo período dos veces no duplica (get-or-create idempotente)', async () => {
      const first = await prepareClosing();
      const second = await prepareClosing();
      expect(first.json().data.id).toBe(second.json().data.id);
      const count = await prisma.weeklyClosing.count({ where: { organizationId } });
      expect(count).toBe(1);
    });

    it('rechaza un periodStart que no cae en lunes (400)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/weekly-closings',
        headers: adminAuthHeader,
        payload: { locationId: locationShop, periodStart: '2026-09-01' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('dos ubicaciones distintas con el mismo período no colisionan', async () => {
      const otherShop = await prisma.location.create({
        data: { organizationId, name: 'Heladería Norte', type: 'ICE_CREAM_SHOP' },
      });
      const first = await prepareClosing();
      const second = await app.inject({
        method: 'POST',
        url: '/api/weekly-closings',
        headers: adminAuthHeader,
        payload: { locationId: otherShop.id, periodStart: PERIOD_START },
      });
      expect(second.statusCode).toBe(201);
      expect(second.json().data.id).not.toBe(first.json().data.id);
    });
  });

  // --- checklist ---------------------------------------------------------

  describe('checklist', () => {
    it('countSubmitted y canClose son false cuando todavía no hay conteo gobernante', async () => {
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      const detail = await getDetail(id);
      const checklist = detail.json().data.checklist;
      expect(checklist.countSubmitted).toBe(false);
      expect(checklist.governingCountWeekStart).toBe(GOVERNING_WEEK_START);
      expect(checklist.canClose).toBe(false);
    });

    it('countSubmitted pasa a true tras enviar el conteo de la semana siguiente (periodStart + 7)', async () => {
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      await submitGoverningCountAndComplete();
      const detail = await getDetail(id);
      expect(detail.json().data.checklist.countSubmitted).toBe(true);
      expect(detail.json().data.checklist.governingCountStatus).toBe('COMPLETED');
    });

    it('canClose sigue false sin la confirmación de revisión de un ADMIN, aun con el conteo completo', async () => {
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      await submitGoverningCountAndComplete();
      const detail = await getDetail(id);
      expect(detail.json().data.checklist.countSubmitted).toBe(true);
      expect(detail.json().data.checklist.reviewConfirmedById).toBeNull();
      expect(detail.json().data.checklist.canClose).toBe(false);
    });

    it('canClose pasa a true una vez completado el conteo y confirmada la revisión', async () => {
      const id = await readyToClose();
      const detail = await getDetail(id);
      expect(detail.json().data.checklist.canClose).toBe(true);
      expect(detail.json().data.checklist.reviewConfirmedById).toBe(adminUserId);
    });

    it('muestra teórico/real/diferencia en vivo, copiados directamente del conteo (sin recalcular) -- incluye producto con teórico negativo y precisión Decimal', async () => {
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      await submitGoverningCount();
      const detail = await getDetail(id);
      const items = detail.json().data.items as Array<{
        productId: string;
        quantityTheoretical: string;
        quantityReal: string;
        difference: string;
      }>;
      expect(items).toHaveLength(4);
      const byProduct = new Map(items.map((i) => [i.productId, i]));
      expect(byProduct.get(productA)).toMatchObject({
        quantityTheoretical: '10.000',
        quantityReal: '12.000',
        difference: '2.000',
      });
      expect(byProduct.get(productB)).toMatchObject({
        quantityTheoretical: '8.000',
        quantityReal: '3.000',
        difference: '-5.000',
      });
      expect(byProduct.get(productC)).toMatchObject({
        quantityTheoretical: '4.000',
        quantityReal: '4.000',
        difference: '0.000',
      });
      // Teórico negativo permitido (sección I): nunca bloquea el cálculo.
      expect(byProduct.get(productD)).toMatchObject({
        quantityTheoretical: '-3.000',
        quantityReal: '0.000',
        difference: '3.000',
      });
    });

    it('ventas importadas confirmadas de Etapa 5, solapadas con el período, se reflejan en el checklist', async () => {
      await prisma.salesImport.create({
        data: {
          organizationId,
          locationId: locationShop,
          source: 'MIX_VENTAS',
          originalFilename: 'mixventas-test.xls',
          fileHash: 'hash-cierre-semanal-test',
          periodStart: new Date(`${PERIOD_START}T00:00:00.000Z`),
          periodEnd: new Date(`${PERIOD_END}T00:00:00.000Z`),
          status: 'CONFIRMED',
          totalRows: 1,
          validRows: 1,
          errorRows: 0,
          confirmedById: adminUserId,
          confirmedAt: new Date(),
          createdById: adminUserId,
        },
      });
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      const detail = await getDetail(id);
      expect(detail.json().data.checklist.salesImportsTotal).toBe(1);
      expect(detail.json().data.checklist.salesImportsConfirmed).toBe(1);
    });
  });

  // --- cierre --------------------------------------------------------------

  describe('cierre', () => {
    it('rechaza cerrar con checklist incompleto y no genera ningún efecto (409)', async () => {
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      const response = await closeClosing(id, 'cierre-incompleto-1');
      expect(response.statusCode).toBe(409);

      const closing = await prisma.weeklyClosing.findUniqueOrThrow({ where: { id } });
      expect(closing.status).toBe('OPEN');
      expect(closing.currentRevision).toBe(0);
      const snapshotCount = await prisma.inventorySnapshotItem.count({
        where: { weeklyClosingId: id },
      });
      expect(snapshotCount).toBe(0);
      const correctionCount = await prisma.inventoryMovement.count({
        where: { organizationId, movementType: 'COUNT_CORRECTION' },
      });
      expect(correctionCount).toBe(0);
      const auditCount = await prisma.auditLog.count({
        where: { entityId: id, action: 'WEEKLY_CLOSING_CLOSED' },
      });
      expect(auditCount).toBe(0);
    });

    it('cierra la semana: snapshot completo (una vez) y COUNT_CORRECTION sólo para diferencias no nulas', async () => {
      const id = await readyToClose();
      const response = await closeClosing(id, 'cierre-1');
      expect(response.statusCode).toBe(200);
      const data = response.json().data;
      expect(data.closing.status).toBe('CLOSED');
      expect(data.closing.currentRevision).toBe(1);
      expect(data.revision).toBe(1);

      const snapshotItems = await prisma.inventorySnapshotItem.findMany({
        where: { weeklyClosingId: id },
      });
      expect(snapshotItems).toHaveLength(4);

      const corrections = await prisma.inventoryMovement.findMany({
        where: { organizationId, locationId: locationShop, movementType: 'COUNT_CORRECTION' },
      });
      expect(corrections).toHaveLength(3); // A, B, D -- C tiene diferencia cero
      const correctionByProduct = new Map(corrections.map((c) => [c.productId, c]));
      expect(correctionByProduct.get(productA)!.quantity.toFixed(3)).toBe('2.000');
      expect(correctionByProduct.get(productB)!.quantity.toFixed(3)).toBe('-5.000');
      expect(correctionByProduct.get(productD)!.quantity.toFixed(3)).toBe('3.000');
      expect(correctionByProduct.has(productC)).toBe(false);

      const snapshotC = snapshotItems.find((i) => i.productId === productC)!;
      expect(snapshotC.countCorrectionMovementId).toBeNull();
      expect(snapshotC.difference.toFixed(3)).toBe('0.000');

      const auditCount = await prisma.auditLog.count({
        where: { entityId: id, action: 'WEEKLY_CLOSING_CLOSED' },
      });
      expect(auditCount).toBe(1);
    });

    it('el stock teórico posterior refleja el ajuste (real pasa a ser el nuevo punto de partida)', async () => {
      const id = await readyToClose();
      await closeClosing(id, 'cierre-balance-1');
      const balance = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationShop}`,
        headers: adminAuthHeader,
      });
      const balances = balance.json().data as Array<{ productId: string; quantity: string }>;
      const byProduct = new Map(balances.map((b) => [b.productId, b.quantity]));
      expect(byProduct.get(productA)).toBe('12.000');
      expect(byProduct.get(productB)).toBe('3.000');
      expect(byProduct.get(productD)).toBe('0.000');
    });

    it('el snapshot es inmutable tras CLOSED: reconsultar devuelve exactamente los mismos valores persistidos', async () => {
      const id = await readyToClose();
      await closeClosing(id, 'cierre-inmutable-1');
      const first = await getDetail(id);
      const second = await getDetail(id);
      expect(second.json().data.items).toEqual(first.json().data.items);
      expect(second.json().data.revision).toBe(1);
    });

    it('reintento secuencial con la misma clave de idempotencia no duplica nada', async () => {
      const id = await readyToClose();
      await closeClosing(id, 'cierre-retry-1');
      const retry = await closeClosing(id, 'cierre-retry-1');
      expect(retry.statusCode).toBe(200);
      expect(retry.json().data.revision).toBe(1);

      const snapshotCount = await prisma.inventorySnapshotItem.count({
        where: { weeklyClosingId: id },
      });
      expect(snapshotCount).toBe(4);
      const correctionCount = await prisma.inventoryMovement.count({
        where: { organizationId, movementType: 'COUNT_CORRECTION' },
      });
      expect(correctionCount).toBe(3);
      const auditCount = await prisma.auditLog.count({
        where: { entityId: id, action: 'WEEKLY_CLOSING_CLOSED' },
      });
      expect(auditCount).toBe(1);
    });

    it('una clave de idempotencia distinta sobre un cierre ya cerrado devuelve 409 sin duplicar', async () => {
      const id = await readyToClose();
      await closeClosing(id, 'cierre-clave-a');
      const conflicting = await closeClosing(id, 'cierre-clave-b');
      expect(conflicting.statusCode).toBe(409);
      const snapshotCount = await prisma.inventorySnapshotItem.count({
        where: { weeklyClosingId: id },
      });
      expect(snapshotCount).toBe(4);
    });

    it('dos cierres concurrentes con la MISMA clave no duplican snapshot, ajustes ni auditoría', async () => {
      const id = await readyToClose();
      const [r1, r2] = await Promise.all([
        closeClosing(id, 'cierre-concurrente-misma'),
        closeClosing(id, 'cierre-concurrente-misma'),
      ]);
      expect([r1.statusCode, r2.statusCode].every((s) => s === 200)).toBe(true);

      const closing = await prisma.weeklyClosing.findUniqueOrThrow({ where: { id } });
      expect(closing.status).toBe('CLOSED');
      expect(closing.currentRevision).toBe(1);
      const snapshotCount = await prisma.inventorySnapshotItem.count({
        where: { weeklyClosingId: id },
      });
      expect(snapshotCount).toBe(4);
      const correctionCount = await prisma.inventoryMovement.count({
        where: { organizationId, movementType: 'COUNT_CORRECTION' },
      });
      expect(correctionCount).toBe(3);
      const auditCount = await prisma.auditLog.count({
        where: { entityId: id, action: 'WEEKLY_CLOSING_CLOSED' },
      });
      expect(auditCount).toBe(1);
    });

    it('dos cierres concurrentes con claves DISTINTAS: uno gana (200), el otro pierde (409), sin estado torcido', async () => {
      const id = await readyToClose();
      const results = await Promise.allSettled([
        closeClosing(id, 'cierre-concurrente-a'),
        closeClosing(id, 'cierre-concurrente-b'),
      ]);
      const statusCodes = results.map((r) => (r.status === 'fulfilled' ? r.value.statusCode : -1));
      expect(statusCodes.sort()).toEqual([200, 409]);

      const closing = await prisma.weeklyClosing.findUniqueOrThrow({ where: { id } });
      expect(closing.status).toBe('CLOSED');
      expect(closing.currentRevision).toBe(1);
      const snapshotCount = await prisma.inventorySnapshotItem.count({
        where: { weeklyClosingId: id },
      });
      expect(snapshotCount).toBe(4);
    });

    it('SHOP_EMPLOYEE y DEPOSIT_MANAGER no pueden cerrar una semana (403)', async () => {
      const id = await readyToClose();
      asEmployee();
      const asEmployeeResponse = await closeClosing(id, 'k-empleada', employeeAuthHeader);
      expect(asEmployeeResponse.statusCode).toBe(403);
      asDeposit();
      const asDepositResponse = await closeClosing(id, 'k-deposito', depositAuthHeader);
      expect(asDepositResponse.statusCode).toBe(403);
    });

    it('SHOP_EMPLOYEE y DEPOSIT_MANAGER no pueden preparar ni consultar cierres (403)', async () => {
      asEmployee();
      const prepareAsEmployee = await prepareClosing(employeeAuthHeader);
      expect(prepareAsEmployee.statusCode).toBe(403);
      const listAsEmployee = await app.inject({
        method: 'GET',
        url: '/api/weekly-closings',
        headers: employeeAuthHeader,
      });
      expect(listAsEmployee.statusCode).toBe(403);

      asDeposit();
      const prepareAsDeposit = await prepareClosing(depositAuthHeader);
      expect(prepareAsDeposit.statusCode).toBe(403);
    });

    it('rechaza sin autenticación (401)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/weekly-closings' });
      expect(response.statusCode).toBe(401);
    });
  });

  // --- reapertura ----------------------------------------------------------

  describe('reapertura', () => {
    it('sólo se puede reabrir un cierre CLOSED (409 si sigue OPEN)', async () => {
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      const response = await reopenClosing(id, 'motivo cualquiera');
      expect(response.statusCode).toBe(409);
    });

    it('exige un motivo obligatorio (400 si falta o está vacío)', async () => {
      const id = await readyToClose();
      await closeClosing(id, 'cierre-reopen-motivo');
      const response = await app.inject({
        method: 'POST',
        url: `/api/weekly-closings/${id}/reopen`,
        headers: adminAuthHeader,
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('reabre un cierre CLOSED, preservando intacto el snapshot de la revisión anterior', async () => {
      const id = await readyToClose();
      await closeClosing(id, 'cierre-reopen-1');
      const beforeSnapshot = await prisma.inventorySnapshotItem.findMany({
        where: { weeklyClosingId: id, revision: 1 },
        orderBy: { productId: 'asc' },
      });

      const reopenResponse = await reopenClosing(
        id,
        'Corrección de gastos variables cargados tarde',
      );
      expect(reopenResponse.statusCode).toBe(200);
      const data = reopenResponse.json().data;
      expect(data.closing.status).toBe('REOPENED');
      expect(data.closing.reopenReason).toBe('Corrección de gastos variables cargados tarde');
      // Se resetea para exigir una nueva revisión de checklist antes del
      // próximo cierre (sección 5/12 del prompt).
      expect(data.checklist.reviewConfirmedById).toBeNull();
      expect(data.checklist.canClose).toBe(false);

      const afterSnapshot = await prisma.inventorySnapshotItem.findMany({
        where: { weeklyClosingId: id, revision: 1 },
        orderBy: { productId: 'asc' },
      });
      expect(afterSnapshot).toEqual(beforeSnapshot);

      const auditCount = await prisma.auditLog.count({
        where: { entityId: id, action: 'WEEKLY_CLOSING_REOPENED' },
      });
      expect(auditCount).toBe(1);
    });

    it('cerrar de nuevo tras reabrir genera una revisión nueva, conserva la historia y NO duplica el ajuste ya aplicado', async () => {
      const id = await readyToClose();
      await closeClosing(id, 'cierre-recierre-1');
      await reopenClosing(id, 'Revisión administrativa');
      await confirmReview(id);
      const secondClose = await closeClosing(id, 'cierre-recierre-2');
      expect(secondClose.statusCode).toBe(200);
      expect(secondClose.json().data.closing.currentRevision).toBe(2);
      expect(secondClose.json().data.revision).toBe(2);

      // Historia conservada: la revisión 1 sigue existiendo, sin tocar.
      const revision1 = await prisma.inventorySnapshotItem.findMany({
        where: { weeklyClosingId: id, revision: 1 },
      });
      expect(revision1).toHaveLength(4);
      const revision2 = await prisma.inventorySnapshotItem.findMany({
        where: { weeklyClosingId: id, revision: 2 },
      });
      expect(revision2).toHaveLength(4);
      // La diferencia histórica se preserva igual en ambas revisiones
      // (documento del cliente, sección 16.1).
      const diffByProductRev1 = new Map(
        revision1.map((i) => [i.productId, i.difference.toFixed(3)]),
      );
      const diffByProductRev2 = new Map(
        revision2.map((i) => [i.productId, i.difference.toFixed(3)]),
      );
      expect(diffByProductRev2).toEqual(diffByProductRev1);

      // El ajuste YA fue aplicado al ledger en la primera revisión -- el
      // recierre (sin un conteo nuevo) no debe generar un segundo
      // COUNT_CORRECTION que duplique el ajuste sobre el mismo stock.
      // Sigue habiendo exactamente 3 movimientos (A, B, D -- C con
      // diferencia cero nunca generó ninguno).
      const corrections = await prisma.inventoryMovement.findMany({
        where: { organizationId, locationId: locationShop, movementType: 'COUNT_CORRECTION' },
      });
      expect(corrections).toHaveLength(3);
      // La revisión 2 REUTILIZA la misma referencia de movimiento que la
      // revisión 1 para cada producto (nunca las deja en null ni apunta a
      // un movimiento nuevo) -- es la trazabilidad persistida que evita
      // duplicar el ajuste (sección 7 del prompt de Etapa 6.1).
      const correctionByProductRev1 = new Map(
        revision1.map((i) => [i.productId, i.countCorrectionMovementId]),
      );
      const correctionByProductRev2 = new Map(
        revision2.map((i) => [i.productId, i.countCorrectionMovementId]),
      );
      expect(correctionByProductRev2).toEqual(correctionByProductRev1);

      const balance = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationShop}`,
        headers: adminAuthHeader,
      });
      const balances = balance.json().data as Array<{ productId: string; quantity: string }>;
      const byProduct = new Map(balances.map((b) => [b.productId, b.quantity]));
      // Si se hubiera duplicado el ajuste, A valdría 14 en vez de 12.
      expect(byProduct.get(productA)).toBe('12.000');
      expect(byProduct.get(productB)).toBe('3.000');
      expect(byProduct.get(productD)).toBe('0.000');
    });

    it('SHOP_EMPLOYEE y DEPOSIT_MANAGER no pueden reabrir un cierre (403)', async () => {
      const id = await readyToClose();
      await closeClosing(id, 'cierre-reopen-permisos');
      asEmployee();
      const response = await reopenClosing(id, 'motivo', employeeAuthHeader);
      expect(response.statusCode).toBe(403);
    });
  });

  // --- aislamiento multi-tenant --------------------------------------------

  describe('aislamiento multi-organización', () => {
    it('un cierre de otra organización no es accesible (404)', async () => {
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;

      const otherOrgId = await seedOrganization();
      const roles = await prisma.role.findMany();
      await prisma.appUser.create({
        data: {
          organizationId: otherOrgId,
          roleId: roles.find((r) => r.code === 'ADMIN')!.id,
          displayName: 'Admin Otra Org',
          email: 'admin-otra-org@test.com',
          authSubject: 'sub-admin-otra-org',
        },
      });
      mockGetUser({
        data: { user: { id: 'sub-admin-otra-org', email: 'admin-otra-org@test.com' } },
        error: null,
      });
      const response = await app.inject({
        method: 'GET',
        url: `/api/weekly-closings/${id}`,
        headers: { authorization: 'Bearer otra-org-token' },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  // --- Etapa 6.1 -- consistencia temporal de la reconciliación -------------

  /**
   * Etapa 6.1: corrige una carrera real en `closeWeeklyClosing` -- la
   * versión de Etapa 6 calculaba el ajuste como
   * `quantityReal - saldoVigenteDelLedger`, lo que podía absorber, como si
   * fueran parte de la diferencia física del conteo, movimientos legítimos
   * (ventas, mermas, otros ajustes) ocurridos DESPUÉS del conteo. Ahora el
   * ajuste es SIEMPRE la diferencia histórica congelada del conteo, y la
   * reconciliación "ya aplicada" se determina por trazabilidad persistida
   * (`InventoryMovement.sourceDocumentType`/`sourceDocumentId`), nunca
   * comparando contra el saldo actual. Estos tests reproducen exactamente
   * los escenarios señalados en la corrección.
   */
  describe('Etapa 6.1 — consistencia temporal de la reconciliación', () => {
    async function createAdjustment(productId: string, enteredQuantity: string, reason: string) {
      return app.inject({
        method: 'POST',
        url: '/api/inventory/adjustments',
        headers: adminAuthHeader,
        payload: { locationId: locationShop, productId, enteredQuantity, reason },
      });
    }

    async function stockOf(productId: string): Promise<string | undefined> {
      const response = await app.inject({
        method: 'GET',
        url: `/api/inventory/stock?locationId=${locationShop}`,
        headers: adminAuthHeader,
      });
      const balances = response.json().data as Array<{ productId: string; quantity: string }>;
      return balances.find((b) => b.productId === productId)?.quantity;
    }

    it('TEST A — un movimiento legítimo posterior al conteo (pero antes del cierre) no se absorbe como diferencia del conteo', async () => {
      const id = await readyToClose();

      // Después de que el conteo ya quedó COMPLETED (real 12, teórico 10,
      // diferencia +2 para productA) pero ANTES de cerrar, ocurre una venta
      // legítima: stock 10 -> 7.
      const saleResponse = await createAdjustment(productA, '-3', 'Venta simulada post-conteo');
      expect(saleResponse.statusCode).toBe(201);
      expect(await stockOf(productA)).toBe('7.000');

      const closeResponse = await closeClosing(id, 'cierre-test-a');
      expect(closeResponse.statusCode).toBe(200);

      // El COUNT_CORRECTION sigue representando ÚNICAMENTE la diferencia
      // histórica del conteo (+2) -- nunca `12 - 7 = 5`.
      const correction = await prisma.inventoryMovement.findFirst({
        where: {
          organizationId,
          locationId: locationShop,
          productId: productA,
          movementType: 'COUNT_CORRECTION',
        },
      });
      expect(correction?.quantity.toFixed(3)).toBe('2.000');

      // El efecto de la venta se conserva de forma independiente: 7 + 2 = 9
      // (nunca 12, que sería el resultado si el ajuste hubiese absorbido la
      // venta como si fuera parte de la diferencia física).
      expect(await stockOf(productA)).toBe('9.000');
    });

    it('TEST B — reapertura con movimiento posterior: recerrar no duplica el ajuste ni revierte el movimiento legítimo', async () => {
      const id = await readyToClose();
      await closeClosing(id, 'cierre-test-b-1');
      expect(await stockOf(productA)).toBe('12.000'); // 10 inicial + 2 de ajuste

      // Venta legítima DESPUÉS del primer cierre.
      const saleResponse = await createAdjustment(productA, '-3', 'Venta simulada post-cierre');
      expect(saleResponse.statusCode).toBe(201);
      expect(await stockOf(productA)).toBe('9.000');

      await reopenClosing(id, 'Revisar antes de recerrar');
      await confirmReview(id);
      const secondClose = await closeClosing(id, 'cierre-test-b-2');
      expect(secondClose.statusCode).toBe(200);
      expect(secondClose.json().data.closing.currentRevision).toBe(2);

      // Sigue existiendo UN SOLO COUNT_CORRECTION para productA (no dos).
      const corrections = await prisma.inventoryMovement.findMany({
        where: {
          organizationId,
          locationId: locationShop,
          productId: productA,
          movementType: 'COUNT_CORRECTION',
        },
      });
      expect(corrections).toHaveLength(1);

      // El stock final CONSERVA el efecto de la venta -- nunca vuelve a 12
      // (que sería el resultado de duplicar el +2) ni a 10 (que sería el
      // resultado de "deshacer" la venta).
      expect(await stockOf(productA)).toBe('9.000');

      // Ambas revisiones muestran la MISMA diferencia histórica (+2) y
      // referencian el MISMO movimiento de corrección.
      const revision1 = await prisma.inventorySnapshotItem.findFirst({
        where: { weeklyClosingId: id, productId: productA, revision: 1 },
      });
      const revision2 = await prisma.inventorySnapshotItem.findFirst({
        where: { weeklyClosingId: id, productId: productA, revision: 2 },
      });
      expect(revision2?.difference.toFixed(3)).toBe(revision1?.difference.toFixed(3));
      expect(revision2?.countCorrectionMovementId).toBe(revision1?.countCorrectionMovementId);
    });

    it('TEST C — un producto del conteo gobernante que no puede resolverse hace fallar TODO el cierre (rollback completo)', async () => {
      const id = await readyToClose();

      // Fastify "roto" a propósito: SÓLO intercepta `tx.product.findMany`
      // para simular que un producto del conteo gobernante no se pudo
      // resolver -- todo lo demás (auditoría, resto de Prisma) sigue
      // siendo real, para que el resto de la lógica corra tal cual en
      // producción.
      const brokenDb = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === '$transaction') {
            return (callback: (tx: unknown) => unknown, options?: unknown) =>
              (target.$transaction as (cb: (tx: unknown) => unknown, opts?: unknown) => unknown)(
                (tx: Record<string, unknown>) => {
                  const brokenTx = new Proxy(tx, {
                    get(txTarget, txProp, txReceiver) {
                      if (txProp === 'product') {
                        const productDelegate = txTarget.product as Record<string, unknown>;
                        return new Proxy(productDelegate, {
                          get(prodTarget, prodProp) {
                            if (prodProp === 'findMany') {
                              return async () => [];
                            }
                            return Reflect.get(prodTarget, prodProp);
                          },
                        });
                      }
                      return Reflect.get(txTarget, txProp, txReceiver);
                    },
                  });
                  return callback(brokenTx);
                },
                options,
              );
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const brokenFastify = new Proxy(app, {
        get(target, prop, receiver) {
          if (prop === 'db') return brokenDb;
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as FastifyInstance;

      const admin = await prisma.appUser.findFirstOrThrow({ where: { id: adminUserId } });
      const actor = {
        id: admin.id,
        organizationId,
        roleCode: 'ADMIN' as const,
        defaultLocationId: admin.defaultLocationId,
        displayName: admin.displayName,
        email: admin.email,
      };

      await expect(
        closeWeeklyClosing(brokenFastify, organizationId, actor, id, {
          idempotencyKey: 'cierre-test-c',
        }),
      ).rejects.toThrow();

      // Rollback completo: nada quedó CLOSED, ni parcial ni totalmente.
      const closing = await prisma.weeklyClosing.findUniqueOrThrow({ where: { id } });
      expect(closing.status).not.toBe('CLOSED');
      expect(closing.currentRevision).toBe(0);
      expect(closing.closeIdempotencyKey).toBeNull();
      const snapshotCount = await prisma.inventorySnapshotItem.count({
        where: { weeklyClosingId: id },
      });
      expect(snapshotCount).toBe(0);
      const correctionCount = await prisma.inventoryMovement.count({
        where: { organizationId, movementType: 'COUNT_CORRECTION' },
      });
      expect(correctionCount).toBe(0);
      const auditCount = await prisma.auditLog.count({
        where: { entityId: id, action: 'WEEKLY_CLOSING_CLOSED' },
      });
      expect(auditCount).toBe(0);

      // El cierre sigue siendo operable normalmente después (no quedó en un
      // estado intermedio corrupto): con el `db` real puede cerrarse bien.
      const realClose = await closeClosing(id, 'cierre-test-c-retry');
      expect(realClose.statusCode).toBe(200);
    });

    it('TEST D — dos solicitudes de cierre concurrentes generan un único conjunto de correcciones (sin duplicar)', async () => {
      const id = await readyToClose();
      const [r1, r2] = await Promise.all([
        closeClosing(id, 'cierre-test-d'),
        closeClosing(id, 'cierre-test-d'),
      ]);
      expect([r1.statusCode, r2.statusCode].every((s) => s === 200)).toBe(true);

      const corrections = await prisma.inventoryMovement.findMany({
        where: { organizationId, locationId: locationShop, movementType: 'COUNT_CORRECTION' },
      });
      expect(corrections).toHaveLength(3);
      // A lo sumo un movimiento por producto (garantía del UNIQUE parcial
      // agregado en la migración de Etapa 6.1).
      const productIdsWithCorrection = corrections.map((c) => c.productId);
      expect(new Set(productIdsWithCorrection).size).toBe(productIdsWithCorrection.length);

      const auditCount = await prisma.auditLog.count({
        where: { entityId: id, action: 'WEEKLY_CLOSING_CLOSED' },
      });
      expect(auditCount).toBe(1);
    });

    it('TEST E — un movimiento concurrente durante el cierre nunca se absorbe como diferencia de conteo (resultado determinístico)', async () => {
      const id = await readyToClose();

      const [closeResponse, saleResponse] = await Promise.all([
        closeClosing(id, 'cierre-test-e'),
        createAdjustment(productA, '-3', 'Venta concurrente con el cierre'),
      ]);
      expect(closeResponse.statusCode).toBe(200);
      expect(saleResponse.statusCode).toBe(201);

      // El COUNT_CORRECTION sigue siendo exactamente +2, sin importar el
      // orden real de ejecución entre el cierre y la venta concurrente.
      const correction = await prisma.inventoryMovement.findFirst({
        where: {
          organizationId,
          locationId: locationShop,
          productId: productA,
          movementType: 'COUNT_CORRECTION',
        },
      });
      expect(correction?.quantity.toFixed(3)).toBe('2.000');

      // El resultado final es determinístico independientemente del orden:
      // 10 (inicial) + 2 (corrección histórica) - 3 (venta) = 9.
      expect(await stockOf(productA)).toBe('9.000');
    });
  });

  describe('Etapa 6.2 — valorización del cierre (costo C/IVA)', () => {
    it('cerrar queda BLOQUEADO si un producto con stock real no tiene costo vigente; se habilita al resolver el mapeo/costo', async () => {
      const category = await prisma.category.create({
        data: { organizationId, name: 'Sin costo' },
      });
      const productType = await prisma.productType.findFirstOrThrow({
        where: { organizationId, code: 'INSUMO' },
      });
      const unitOfMeasure = await prisma.unitOfMeasure.findFirstOrThrow({
        where: { organizationId, code: 'UNIDAD' },
      });
      const productE = await prisma.product.create({
        data: {
          organizationId,
          name: 'Producto E',
          categoryId: category.id,
          productTypeId: productType.id,
          unitOfMeasureId: unitOfMeasure.id,
          unitsPerHandlingUnit: 1,
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/inventory/stock/initial',
        headers: adminAuthHeader,
        payload: { locationId: locationShop, productId: productE.id, enteredQuantity: '5' },
      });

      // Etapa 6.2.2, secciones 1/2/5 del prompt: el universo obligatorio del
      // conteo es TODO producto activo de la organización -- A/B/C/D del
      // `beforeEach` ya no son el foco de este test (que sólo le interesa
      // Producto E, sin costo), así que se desactivan para que el universo
      // obligatorio sea exactamente {Producto E}, sin tener que inventar
      // valores/resoluciones de diferencia para productos irrelevantes acá.
      await prisma.product.updateMany({
        where: { organizationId, id: { in: [productA, productB, productC, productD] } },
        data: { active: false },
      });

      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      const countRes = await app.inject({
        method: 'POST',
        url: '/api/shop/counts',
        headers: adminAuthHeader,
        payload: {
          locationId: locationShop,
          weekStart: GOVERNING_WEEK_START,
          items: [{ productId: productE.id, closedUnits: 5 }],
          idempotencyKey: 'conteo-sin-costo',
        },
      });
      expect(countRes.statusCode).toBe(201);
      // Producto E: real 5, teórico 0 (nunca se cargó stock inicial) ->
      // sobrante +5 -- Etapa 6.2.2, secciones 7/8/11 del prompt: hay que
      // resolverlo explícitamente antes de poder confirmar la revisión, sin
      // que eso tenga nada que ver con el foco real de este test (el costo
      // faltante).
      const countId = countRes.json().data.id as string;
      await resolveAllDifferences(countId);
      await confirmReview(id);

      const blocked = await closeClosing(id, 'cierre-sin-costo-1');
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.message).toContain('Producto E');

      await seedProductCost({
        organizationId,
        productId: productE.id,
        productName: 'Producto E',
        actorId: adminUserId,
        costWithTax: '50.00',
      });

      const retry = await closeClosing(id, 'cierre-sin-costo-2');
      expect(retry.statusCode).toBe(200);
      const item = retry
        .json()
        .data.items.find((i: { productId: string }) => i.productId === productE.id);
      expect(item.unitCostWithTax).toBe('50.00');
      expect(item.totalValue).toBe('250.00'); // 5 * 50.00
    });

    it('una lista de precios importada DESPUÉS del cierre nunca altera el snapshot ya congelado (ejemplo del prompt: costo $100 -> $1.200 congelado, sube después)', async () => {
      const id = await readyToClose();
      const closeRes = await closeClosing(id, 'cierre-valorizacion-1');
      expect(closeRes.statusCode).toBe(200);
      const before = closeRes
        .json()
        .data.items.find((i: { productId: string }) => i.productId === productA);
      expect(before.unitCostWithTax).toBe('100.00');
      expect(before.quantityReal).toBe('12.000'); // real del conteo gobernante
      expect(before.totalValue).toBe('1200.00'); // 12 * 100.00

      // Simula un import de precios POSTERIOR con un costo distinto para el
      // MISMO producto (misma PriceReference, label "Producto A").
      const reference = await prisma.priceReference.findFirstOrThrow({
        where: { organizationId, priceType: 'COST_WITH_TAX', label: 'Producto A' },
      });
      const laterImport = await prisma.priceListImport.create({
        data: {
          organizationId,
          source: 'HELACOR_COST_LIST',
          priceType: 'COST_WITH_TAX',
          originalFilename: 'costo-octubre.xlsx',
          fileHash: 'hash-costo-octubre',
          status: 'CONFIRMED',
          totalRows: 1,
          validRows: 1,
          createdById: adminUserId,
          confirmedById: adminUserId,
          confirmedAt: new Date(),
          effectiveFrom: new Date('2026-10-01'),
          rows: {
            create: [
              { rowNumber: 1, rawLabel: 'Producto A', rawValueWithTax: '999.00', status: 'VALID' },
            ],
          },
        },
        include: { rows: true },
      });
      await prisma.priceValue.create({
        data: {
          organizationId,
          priceReferenceId: reference.id,
          priceType: 'COST_WITH_TAX',
          value: '999.00',
          effectiveFrom: new Date('2026-10-01'),
          priceListImportId: laterImport.id,
          priceListImportRowId: laterImport.rows[0]!.id,
          createdById: adminUserId,
        },
      });

      const detail = await getDetail(id);
      const after = detail
        .json()
        .data.items.find((i: { productId: string }) => i.productId === productA);
      expect(after.unitCostWithTax).toBe('100.00'); // sin cambios
      expect(after.totalValue).toBe('1200.00'); // sin cambios
    });

    /**
     * Etapa 6.2.1, sección 9 del prompt: importa un `PriceValue` nuevo para
     * la MISMA `PriceReference` de productA ("Producto A", creada por
     * `seedProductCost` en el `beforeEach`) con la `effectiveFrom` indicada
     * -- mismo patrón que el test de arriba, parametrizado para reutilizarse
     * en los 3 casos A/C/D de abajo.
     */
    async function importCostForProductA(value: string, effectiveFromIso: string) {
      const reference = await prisma.priceReference.findFirstOrThrow({
        where: { organizationId, priceType: 'COST_WITH_TAX', label: 'Producto A' },
      });
      const imp = await prisma.priceListImport.create({
        data: {
          organizationId,
          source: 'HELACOR_COST_LIST',
          priceType: 'COST_WITH_TAX',
          originalFilename: `costo-${effectiveFromIso}.xlsx`,
          fileHash: `hash-costo-${effectiveFromIso}-${value}`,
          status: 'CONFIRMED',
          totalRows: 1,
          validRows: 1,
          createdById: adminUserId,
          confirmedById: adminUserId,
          confirmedAt: new Date(),
          effectiveFrom: new Date(`${effectiveFromIso}T00:00:00.000Z`),
          rows: {
            create: [
              { rowNumber: 1, rawLabel: 'Producto A', rawValueWithTax: value, status: 'VALID' },
            ],
          },
        },
        include: { rows: true },
      });
      await prisma.priceValue.create({
        data: {
          organizationId,
          priceReferenceId: reference.id,
          priceType: 'COST_WITH_TAX',
          value,
          effectiveFrom: new Date(`${effectiveFromIso}T00:00:00.000Z`),
          priceListImportId: imp.id,
          priceListImportRowId: imp.rows[0]!.id,
          createdById: adminUserId,
        },
      });
    }

    it('TEST A/B/D -- un costo que entra en vigencia el día POSTERIOR al periodEnd (2026-09-07, el lunes siguiente) NUNCA se usa al cerrar, sin importar cuándo el ADMIN haga clic en cerrar', async () => {
      const id = await readyToClose();
      // Importado ANTES de cerrar (a diferencia del test anterior, que lo
      // importa después) -- el punto es que YA está en la base de datos al
      // momento del `close`, y aun así no debe usarse: `effectiveFrom`
      // (2026-09-07) es un día POSTERIOR al `periodEnd` (2026-09-06) de
      // este cierre, sin importar que sea muy anterior a "hoy" (la fecha
      // real del sistema, muy posterior a 2026).
      await importCostForProductA('1200.00', GOVERNING_WEEK_START); // 2026-09-07

      const closeRes = await closeClosing(id, 'cierre-periodend-a');
      expect(closeRes.statusCode).toBe(200);
      const item = closeRes
        .json()
        .data.items.find((i: { productId: string }) => i.productId === productA);
      // Sigue siendo el costo original ($100, sembrado por seedProductCost
      // con effectiveFrom 2020-01-01) -- NUNCA el $1.200 importado, aunque
      // ya exista en la base al momento de cerrar.
      expect(item.unitCostWithTax).toBe('100.00');
      expect(item.totalValue).toBe('1200.00'); // 12 * 100.00
    });

    it('TEST C -- un costo que entra en vigencia DENTRO de la semana cerrada (2026-09-03, miércoles) SÍ se usa al cerrar', async () => {
      const id = await readyToClose();
      await importCostForProductA('150.00', '2026-09-03'); // dentro de 08-31..09-06

      const closeRes = await closeClosing(id, 'cierre-periodend-c');
      expect(closeRes.statusCode).toBe(200);
      const item = closeRes
        .json()
        .data.items.find((i: { productId: string }) => i.productId === productA);
      expect(item.unitCostWithTax).toBe('150.00'); // el vigente al periodEnd, no el original
      expect(item.totalValue).toBe('1800.00'); // 12 * 150.00
    });

    it('TEST E -- reabrir y recerrar usa el MISMO costo histórico del período, aunque entretanto se importe un costo con vigencia posterior al periodEnd', async () => {
      const id = await readyToClose();
      const firstClose = await closeClosing(id, 'cierre-periodend-e-1');
      expect(firstClose.statusCode).toBe(200);
      const firstItem = firstClose
        .json()
        .data.items.find((i: { productId: string }) => i.productId === productA);
      expect(firstItem.unitCostWithTax).toBe('100.00');

      // Motivo de reapertura + un costo nuevo importado ENTRE la reapertura
      // y el recierre, con vigencia posterior al periodEnd -- no debería
      // poder "colarse" en la segunda revisión tampoco.
      const reopenRes = await reopenClosing(id, 'Corrección de prueba (Etapa 6.2.1, TEST E)');
      expect(reopenRes.statusCode).toBe(200);
      await importCostForProductA('9999.00', '2026-09-08');
      await confirmReview(id);

      const secondClose = await closeClosing(id, 'cierre-periodend-e-2');
      expect(secondClose.statusCode).toBe(200);
      const secondItem = secondClose
        .json()
        .data.items.find((i: { productId: string }) => i.productId === productA);
      expect(secondItem.unitCostWithTax).toBe('100.00'); // idéntico a la primera revisión
      expect(secondItem.totalValue).toBe('1200.00');
    });
  });

  // Etapa 6.2.2, secciones 7-13 del prompt (BLOCKER): ninguna semana puede
  // cerrarse con diferencias sin resolver, y nunca se genera un
  // COUNT_CORRECTION sobre una diferencia pendiente -- letras H-O de la
  // sección 20. Reusa el fixture común del `beforeEach` (productA +2
  // sobrante, productB -5 faltante con reconteo obligatorio, productC sin
  // diferencia, productD +3 sobrante con teórico negativo).
  describe('diferencias pendientes bloquean el cierre (Etapa 6.2.2, letras H-O)', () => {
    async function countCorrectionMovements() {
      return prisma.inventoryMovement.findMany({
        where: { organizationId, movementType: 'COUNT_CORRECTION' },
      });
    }

    it('[H] una diferencia = 0 nunca requiere resolución (nunca aparece entre las pendientes)', async () => {
      await submitGoverningCountAndComplete();
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      const detail = await getDetail(id);
      const pending = detail.json().data.checklist.pendingDifferenceResolutions as Array<{
        productId: string;
      }>;
      expect(pending.map((p) => p.productId)).not.toContain(productC);
      // A (+2), B (-5) y D (+3) sí tienen diferencia distinta de cero y
      // ninguna fue resuelta todavía -- las tres deben aparecer.
      expect(pending.map((p) => p.productId).sort()).toEqual([productA, productB, productD].sort());
    });

    it('[I] un FALTANTE sin confirmar deja canClose en false', async () => {
      await submitGoverningCountAndComplete();
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      const detail = await getDetail(id);
      const checklist = detail.json().data.checklist;
      expect(checklist.canClose).toBe(false);
      const productBPending = checklist.pendingDifferenceResolutions.find(
        (p: { productId: string }) => p.productId === productB,
      );
      expect(productBPending).toBeDefined();
      expect(productBPending.reason).toBe('SHORTAGE_NOT_CONFIRMED');
    });

    it('[J] un FALTANTE confirmado (SHORTAGE_CONFIRMED) deja de figurar como pendiente y permite avanzar', async () => {
      const countResponse = await submitGoverningCountAndComplete();
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      const countBody = countResponse.json().data;
      const itemB = countBody.items.find((i: { productId: string }) => i.productId === productB);

      const resolve = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${countBody.id}/items/${itemB.id}/resolve-difference`,
        headers: adminAuthHeader,
        payload: { kind: 'SHORTAGE_CONFIRMED' },
      });
      expect(resolve.statusCode).toBe(200);

      const detail = await getDetail(id);
      const pending = detail.json().data.checklist.pendingDifferenceResolutions as Array<{
        productId: string;
      }>;
      expect(pending.map((p) => p.productId)).not.toContain(productB);
    });

    it('[K] un SOBRANTE sin resolver deja canClose en false', async () => {
      await submitGoverningCountAndComplete();
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      const detail = await getDetail(id);
      const checklist = detail.json().data.checklist;
      expect(checklist.canClose).toBe(false);
      const productAPending = checklist.pendingDifferenceResolutions.find(
        (p: { productId: string }) => p.productId === productA,
      );
      expect(productAPending).toBeDefined();
      expect(productAPending.reason).toBe('SURPLUS_NOT_RESOLVED');
    });

    it('[L] un SOBRANTE resuelto (SURPLUS_RESOLVED) deja de figurar como pendiente y permite avanzar', async () => {
      const countResponse = await submitGoverningCountAndComplete();
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      const countBody = countResponse.json().data;
      const itemA = countBody.items.find((i: { productId: string }) => i.productId === productA);

      const resolve = await app.inject({
        method: 'POST',
        url: `/api/shop/counts/${countBody.id}/items/${itemA.id}/resolve-difference`,
        headers: adminAuthHeader,
        payload: { kind: 'SURPLUS_RESOLVED' },
      });
      expect(resolve.statusCode).toBe(200);

      const detail = await getDetail(id);
      const pending = detail.json().data.checklist.pendingDifferenceResolutions as Array<{
        productId: string;
      }>;
      expect(pending.map((p) => p.productId)).not.toContain(productA);
    });

    it('[M] cerrar directamente con TODAS las diferencias sin resolver: rechazado (409), rollback total (nada se crea)', async () => {
      await submitGoverningCountAndComplete();
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;

      // Ni siquiera se confirmó la revisión -- el cierre directo debe
      // rechazarse citando las diferencias pendientes, nunca sólo "falta la
      // revisión" en silencio.
      const attempt = await closeClosing(id, 'cierre-diferencias-pendientes-m');
      expect(attempt.statusCode).toBe(409);
      expect(attempt.json().error.message).toMatch(/diferencia\(s\) pendientes de resolución/);
      expect(attempt.json().error.message).toContain('Producto A');
      expect(attempt.json().error.message).toContain('Producto B');
      expect(attempt.json().error.message).toContain('Producto D');

      const closing = await prisma.weeklyClosing.findUniqueOrThrow({ where: { id } });
      expect(closing.status).toBe('OPEN');
      expect(closing.closedAt).toBeNull();
      expect(await countCorrectionMovements()).toHaveLength(0);
      const snapshotCount = await prisma.inventorySnapshotItem.count({
        where: { weeklyClosingId: id },
      });
      expect(snapshotCount).toBe(0);
      const auditCount = await prisma.auditLog.count({
        where: { entityId: id, action: 'WEEKLY_CLOSING_CLOSED' },
      });
      expect(auditCount).toBe(0);
    });

    it('[N] con la MAYORÍA de las diferencias resueltas pero UNA sola pendiente, el cierre sigue rechazado y no genera NINGÚN COUNT_CORRECTION (todo o nada)', async () => {
      const countResponse = await submitGoverningCountAndComplete();
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      const countBody = countResponse.json().data;

      // Se resuelven A (sobrante) y D (sobrante), pero se deja B (faltante)
      // deliberadamente sin confirmar.
      for (const productId of [productA, productD]) {
        const item = countBody.items.find((i: { productId: string }) => i.productId === productId);
        const resolve = await app.inject({
          method: 'POST',
          url: `/api/shop/counts/${countBody.id}/items/${item.id}/resolve-difference`,
          headers: adminAuthHeader,
          payload: { kind: 'SURPLUS_RESOLVED' },
        });
        expect(resolve.statusCode).toBe(200);
      }

      // La confirmación de revisión también queda bloqueada mientras quede
      // UNA sola diferencia pendiente (capa 1 de la triple defensa).
      const reviewAttempt = await confirmReview(id);
      expect(reviewAttempt.statusCode).toBe(409);
      expect(reviewAttempt.json().error.message).toContain('Producto B');

      const attempt = await closeClosing(id, 'cierre-diferencias-pendientes-n');
      expect(attempt.statusCode).toBe(409);
      expect(attempt.json().error.message).toContain('Producto B');
      expect(attempt.json().error.message).not.toContain('Producto A');
      expect(attempt.json().error.message).not.toContain('Producto D');

      expect(await countCorrectionMovements()).toHaveLength(0);
      const closing = await prisma.weeklyClosing.findUniqueOrThrow({ where: { id } });
      expect(closing.status).toBe('OPEN');
    });

    it('[O] con TODAS las diferencias resueltas, el cierre se completa y genera COUNT_CORRECTION sólo para las diferencias no nulas', async () => {
      const id = await readyToClose();
      const closeRes = await closeClosing(id, 'cierre-diferencias-pendientes-o');
      expect(closeRes.statusCode).toBe(200);
      expect(closeRes.json().data.closing.status).toBe('CLOSED');

      const corrections = await countCorrectionMovements();
      const correctedProductIds = corrections.map((m) => m.productId).sort();
      // A (+2), B (-5) y D (+3) generan ajuste; C (diferencia 0) nunca.
      expect(correctedProductIds).toEqual([productA, productB, productD].sort());

      const closing = await prisma.weeklyClosing.findUniqueOrThrow({ where: { id } });
      expect(closing.status).toBe('CLOSED');
    });
  });

  describe('Etapa 6.2.1 -- atomicidad de la auditoría de confirmWeeklyClosingReview', () => {
    it('si falla el INSERT de auditoría dentro de la transacción, el cambio de estado también hace rollback (nunca queda confirmado sin su auditoría)', async () => {
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;

      // Fastify "roto" a propósito, mismo patrón que el TEST C de
      // `closeWeeklyClosing` (arriba): SÓLO intercepta `tx.auditLog.create`
      // para forzar que la escritura de auditoría falle DENTRO de la
      // transacción -- todo lo demás (el propio `updateMany`, el resto de
      // Prisma) sigue siendo real Postgres, para que la aserción demuestre
      // atomicidad OBSERVABLE (el UPDATE de estado no persiste), no sólo
      // que `logTx` fue invocado.
      const brokenDb = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === '$transaction') {
            return (callback: (tx: unknown) => unknown, options?: unknown) =>
              (target.$transaction as (cb: (tx: unknown) => unknown, opts?: unknown) => unknown)(
                (tx: Record<string, unknown>) => {
                  const brokenTx = new Proxy(tx, {
                    get(txTarget, txProp, txReceiver) {
                      if (txProp === 'auditLog') {
                        const auditDelegate = txTarget.auditLog as Record<string, unknown>;
                        return new Proxy(auditDelegate, {
                          get(auditTarget, auditProp) {
                            if (auditProp === 'create') {
                              return async () => {
                                throw new Error('Fallo forzado de auditoría (test de atomicidad)');
                              };
                            }
                            return Reflect.get(auditTarget, auditProp);
                          },
                        });
                      }
                      return Reflect.get(txTarget, txProp, txReceiver);
                    },
                  });
                  return callback(brokenTx);
                },
                options,
              );
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const brokenFastify = new Proxy(app, {
        get(target, prop, receiver) {
          if (prop === 'db') return brokenDb;
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as FastifyInstance;

      const admin = await prisma.appUser.findFirstOrThrow({ where: { id: adminUserId } });
      const actor = {
        id: admin.id,
        organizationId,
        roleCode: 'ADMIN' as const,
        defaultLocationId: admin.defaultLocationId,
        displayName: admin.displayName,
        email: admin.email,
      };

      await expect(
        confirmWeeklyClosingReview(brokenFastify, organizationId, actor, id),
      ).rejects.toThrow('Fallo forzado de auditoría');

      // Rollback completo, verificado contra el cliente REAL de Prisma (no
      // el roto): el UPDATE de `reviewConfirmedById`/`reviewConfirmedAt`
      // NUNCA se hizo efectivo, aunque la promesa del `updateMany` en sí
      // misma no lanzó ningún error -- lo que prueba que ambas escrituras
      // comparten la misma transacción, no sólo que se llaman en secuencia.
      const closing = await prisma.weeklyClosing.findUniqueOrThrow({ where: { id } });
      expect(closing.reviewConfirmedById).toBeNull();
      expect(closing.reviewConfirmedAt).toBeNull();
      const auditCount = await prisma.auditLog.count({
        where: { entityId: id, action: 'WEEKLY_CLOSING_REVIEW_CONFIRMED' },
      });
      expect(auditCount).toBe(0);

      // El cierre sigue siendo operable normalmente después (no quedó en un
      // estado intermedio corrupto): con el `db` real la confirmación
      // funciona bien.
      const realConfirm = await confirmReview(id);
      expect(realConfirm.statusCode).toBe(200);
      expect(realConfirm.json().data.checklist.reviewConfirmedById).toBe(adminUserId);
    });
  });
});
