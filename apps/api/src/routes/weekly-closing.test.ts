import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles, seedProductTypes, seedUnitsOfMeasure } =
  await import('../test/db-helpers.js');

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

  /** Prepara + envía el conteo gobernante + confirma revisión -- deja el
   * cierre listo para `close` (`canClose === true`). */
  async function readyToClose() {
    const prepared = await prepareClosing();
    const id = prepared.json().data.id as string;
    const countResponse = await submitGoverningCount();
    expect(countResponse.statusCode).toBe(201);
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
      await submitGoverningCount();
      const detail = await getDetail(id);
      expect(detail.json().data.checklist.countSubmitted).toBe(true);
      expect(detail.json().data.checklist.governingCountStatus).toBe('COMPLETED');
    });

    it('canClose sigue false sin la confirmación de revisión de un ADMIN, aun con el conteo completo', async () => {
      const prepared = await prepareClosing();
      const id = prepared.json().data.id as string;
      await submitGoverningCount();
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
      const corrections = await prisma.inventoryMovement.findMany({
        where: { organizationId, locationId: locationShop, movementType: 'COUNT_CORRECTION' },
      });
      expect(corrections).toHaveLength(3);
      const revision2SnapshotWithCorrection = revision2.filter(
        (i) => i.countCorrectionMovementId !== null,
      );
      expect(revision2SnapshotWithCorrection).toHaveLength(0);

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
});
