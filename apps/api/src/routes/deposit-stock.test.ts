import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSupabaseMockModule, mockGetUser } from '../test/supabase-mock.js';

vi.mock('@supabase/supabase-js', () => createSupabaseMockModule());

const { buildServer } = await import('../server.js');
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables, seedOrganization, seedRoles, seedProductTypes, seedUnitsOfMeasure } =
  await import('../test/db-helpers.js');

/**
 * Etapa 6.2.1, sección 11 del prompt: "verificar que el modelo actual pueda
 * representar correctamente el stock restante en una Location tipo
 * DEPOT/cámara mediante el ledger" -- NO se desarrolla Etapa 8 (pedidos,
 * remitos, reparto, recepción, Store, Express, transferencias avanzadas).
 *
 * Este archivo demuestra, en un único escenario mínimo, los 5 puntos que
 * pide el prompt -- todos con la MISMA infraestructura genérica de Etapa 3
 * (`InventoryMovement`/`getStockBalances`), sin ningún código nuevo: una
 * `Location` DEPOT nunca recibió trato especial en el ledger (nunca se
 * hardcodeó "depósito" -- ver `LocationType`, Etapa 0), así que esto ya
 * funcionaba de punta a punta desde Etapa 3; lo único que faltaba era la
 * prueba explícita pedida acá. `apps/api/src/routes/inventory.test.ts`
 * (Etapa 3) ya ejercita una `Location` DEPOT como `locationA` a lo largo de
 * TODO ese archivo (decenas de casos) -- este archivo no la duplica, sólo
 * concentra en un solo lugar la demostración explícita de los 5 puntos.
 */
describe('Etapa 6.2.1 -- validación mínima de stock en una Location DEPOT/cámara', () => {
  let app: FastifyInstance;
  let organizationId: string;
  let locationDepot: string;
  let locationShop: string;
  let productA: string;

  const adminAuthHeader = { authorization: 'Bearer admin-token' };

  beforeEach(async () => {
    await resetCoreTables();
    organizationId = await seedOrganization();
    const roleIds = await seedRoles();
    const productTypes = await seedProductTypes(organizationId);
    const unitsOfMeasure = await seedUnitsOfMeasure(organizationId);
    app = await buildServer();

    locationDepot = (
      await prisma.location.create({
        data: { organizationId, name: 'Depósito Central', type: 'DEPOT' },
      })
    ).id;
    locationShop = (
      await prisma.location.create({
        data: { organizationId, name: 'Heladería Centro', type: 'ICE_CREAM_SHOP' },
      })
    ).id;

    const category = await prisma.category.create({ data: { organizationId, name: 'Insumos' } });
    productA = (
      await prisma.product.create({
        data: {
          organizationId,
          name: 'Producto A',
          categoryId: category.id,
          productTypeId: productTypes.INSUMO,
          unitOfMeasureId: unitsOfMeasure.UNIDAD,
          unitsPerHandlingUnit: 1,
        },
      })
    ).id;

    await prisma.appUser.create({
      data: {
        organizationId,
        roleId: roleIds.ADMIN,
        displayName: 'Admin',
        email: 'admin-deposit@test.com',
        authSubject: 'sub-admin-deposit',
      },
    });
    mockGetUser({
      data: { user: { id: 'sub-admin-deposit', email: 'admin-deposit@test.com' } },
      error: null,
    });
  });

  it('1/2/3/4 -- una Location DEPOT recibe movimientos de inventario, su stock se deriva del ledger, se puede consultar, y nunca se mezcla con el de una heladería', async () => {
    // 1. Movimiento de inventario contra una Location DEPOT: mismo endpoint
    // genérico de stock inicial que usa cualquier otra ubicación -- nunca
    // hubo un camino separado para DEPOT.
    const initial = await app.inject({
      method: 'POST',
      url: '/api/inventory/stock/initial',
      headers: adminAuthHeader,
      payload: { locationId: locationDepot, productId: productA, enteredQuantity: '50' },
    });
    expect(initial.statusCode).toBe(201);

    // Un segundo movimiento (ajuste) sobre la MISMA Location DEPOT.
    const adjustment = await app.inject({
      method: 'POST',
      url: '/api/inventory/adjustments',
      headers: adminAuthHeader,
      payload: {
        locationId: locationDepot,
        productId: productA,
        enteredQuantity: '-8',
        reason: 'Merma detectada en cámara',
      },
    });
    expect(adjustment.statusCode).toBe(201);

    // Movimiento independiente en la heladería, con una cantidad DISTINTA --
    // para probar que ambos stocks no se confunden (punto 4).
    await app.inject({
      method: 'POST',
      url: '/api/inventory/stock/initial',
      headers: adminAuthHeader,
      payload: { locationId: locationShop, productId: productA, enteredQuantity: '5' },
    });

    // 2/3. El stock restante del DEPOT se DERIVA del ledger (nunca de un
    // campo de saldo aparte) y puede consultarse por la API genérica de
    // stock, filtrando por locationId.
    const depotStock = await app.inject({
      method: 'GET',
      url: `/api/inventory/stock?locationId=${locationDepot}`,
      headers: adminAuthHeader,
    });
    expect(depotStock.statusCode).toBe(200);
    const depotBalances = depotStock.json().data as { productId: string; quantity: string }[];
    expect(depotBalances).toHaveLength(1);
    expect(depotBalances[0]!.quantity).toBe('42.000'); // 50 - 8, calculado por el ledger

    // 4. El stock de la heladería es independiente -- nunca absorbe ni se ve
    // afectado por los movimientos del DEPOT del mismo producto.
    const shopStock = await app.inject({
      method: 'GET',
      url: `/api/inventory/stock?locationId=${locationShop}`,
      headers: adminAuthHeader,
    });
    const shopBalances = shopStock.json().data as { productId: string; quantity: string }[];
    expect(shopBalances).toHaveLength(1);
    expect(shopBalances[0]!.quantity).toBe('5.000');

    // Los movimientos también son consultables/filtrables por ubicación,
    // confirmando la misma independencia a nivel de historial (no sólo de
    // saldo agregado).
    const depotMovements = await app.inject({
      method: 'GET',
      url: `/api/inventory/movements?locationId=${locationDepot}`,
      headers: adminAuthHeader,
    });
    const depotMovementRows = depotMovements.json().data.items as { locationId: string }[];
    expect(depotMovementRows).toHaveLength(2);
    expect(depotMovementRows.every((m) => m.locationId === locationDepot)).toBe(true);
  });

  it('5 -- el cierre semanal GENERAL de Hito 1 depende únicamente de las heladerías (ICE_CREAM_SHOP) requeridas activas, nunca de un DEPOT', async () => {
    // El beforeEach sembró un DEPOT y una única heladería ICE_CREAM_SHOP --
    // la lista de "ubicaciones requeridas" del cierre general debe traer
    // EXCLUSIVAMENTE la heladería, nunca el DEPOT (ver
    // `computeLocationStatuses` en general-weekly-closing.ts, que filtra
    // explícitamente `type: 'ICE_CREAM_SHOP'`; el mismo criterio ya está
    // cubierto en detalle, con dos heladerías reales de por medio, en
    // `general-weekly-closing.test.ts`).
    const detail = await app.inject({
      method: 'GET',
      url: '/api/weekly-closings/general?periodStart=2026-08-31',
      headers: adminAuthHeader,
    });
    expect(detail.statusCode).toBe(200);
    const data = detail.json().data;
    expect(data.locations).toHaveLength(1);
    expect(data.locations[0].locationId).toBe(locationShop);
    expect(data.locations.some((l: { locationId: string }) => l.locationId === locationDepot)).toBe(
      false,
    );
  });
});
