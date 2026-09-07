import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@sistema-grido/db';

/**
 * Etapa 3 — Integridad del ledger de inventario a nivel de PostgreSQL (ver
 * docs/ETAPA-3-MOTOR-INVENTARIO.md, sección "Multi-organización", e
 * docs/INVARIANTES-INVENTARIO.md).
 *
 * Mismo criterio que `db-multi-org-integrity.test.ts` (Etapa 2.1): estos
 * tests usan el cliente de Prisma DIRECTAMENTE, sin pasar por
 * `services/inventory-ledger.ts` ni por la API, para confirmar que la
 * protección real está en la base de datos (FKs compuestas, CHECK
 * constraints, índices únicos) y no depende únicamente del backend.
 */
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables } = await import('./test/db-helpers.js');

function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}
/**
 * Prisma no tiene un código propio (P-xxxx) para violaciones de CHECK
 * constraint -- a diferencia de unique (P2002) o foreign key (P2003), las
 * expone como `PrismaClientUnknownRequestError` con el error crudo de
 * PostgreSQL (código `23514`, "check_violation") en el mensaje.
 */
function isCheckViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientUnknownRequestError &&
    err.message.includes('violates check constraint')
  );
}
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

interface OrgFixture {
  organizationId: string;
  locationId: string;
  productId: string;
  unitOfMeasureId: string;
  appUserId: string;
}

async function seedOrgFixture(label: string): Promise<OrgFixture> {
  const org = await prisma.organization.create({ data: { name: `Organización ${label}` } });
  const location = await prisma.location.create({
    data: { organizationId: org.id, name: `Depósito ${label}`, type: 'DEPOT' },
  });
  const category = await prisma.category.create({
    data: { organizationId: org.id, name: `Categoría ${label}` },
  });
  const productType = await prisma.productType.create({
    data: { organizationId: org.id, code: 'HELADO', name: 'Helado' },
  });
  const unitOfMeasure = await prisma.unitOfMeasure.create({
    data: { organizationId: org.id, code: 'LATA', name: 'Lata' },
  });
  const product = await prisma.product.create({
    data: {
      organizationId: org.id,
      name: `Producto ${label}`,
      categoryId: category.id,
      productTypeId: productType.id,
      unitOfMeasureId: unitOfMeasure.id,
    },
  });
  const role = await prisma.role.findFirst({ where: { code: 'ADMIN' } });
  const roleId = role
    ? role.id
    : (await prisma.role.create({ data: { code: 'ADMIN', name: 'Administrador' } })).id;
  const appUser = await prisma.appUser.create({
    data: {
      organizationId: org.id,
      roleId,
      displayName: `Admin ${label}`,
      email: `admin-${label.toLowerCase()}@test.com`,
      authSubject: `sub-admin-${label.toLowerCase()}`,
    },
  });
  return {
    organizationId: org.id,
    locationId: location.id,
    productId: product.id,
    unitOfMeasureId: unitOfMeasure.id,
    appUserId: appUser.id,
  };
}

function validMovementData(fixture: OrgFixture, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: fixture.organizationId,
    locationId: fixture.locationId,
    productId: fixture.productId,
    movementType: 'INITIAL_STOCK' as const,
    quantity: 10,
    enteredQuantity: 10,
    entryUnitOfMeasureId: fixture.unitOfMeasureId,
    conversionFactor: 1,
    createdById: fixture.appUserId,
    ...overrides,
  };
}

describe('Integridad del ledger de inventario a nivel de base de datos (Etapa 3)', () => {
  let orgA: OrgFixture;
  let orgB: OrgFixture;

  beforeEach(async () => {
    await resetCoreTables();
    orgA = await seedOrgFixture('A');
    orgB = await seedOrgFixture('B');
  });

  afterEach(async () => {
    await resetCoreTables();
  });

  it('permite un movimiento válido con todas sus referencias en la misma organización', async () => {
    const created = await prisma.inventoryMovement.create({ data: validMovementData(orgA) });
    expect(created.id).toBeTruthy();
    expect(created.organizationId).toBe(orgA.organizationId);
  });

  it('rechaza un movimiento cuya ubicación pertenece a otra organización', async () => {
    await expect(
      prisma.inventoryMovement.create({
        data: validMovementData(orgA, { locationId: orgB.locationId }),
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('rechaza un movimiento cuyo producto pertenece a otra organización', async () => {
    await expect(
      prisma.inventoryMovement.create({
        data: validMovementData(orgA, { productId: orgB.productId }),
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('rechaza un movimiento cuya unidad de entrada pertenece a otra organización', async () => {
    await expect(
      prisma.inventoryMovement.create({
        data: validMovementData(orgA, { entryUnitOfMeasureId: orgB.unitOfMeasureId }),
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('rechaza un movimiento cuyo usuario responsable pertenece a otra organización', async () => {
    await expect(
      prisma.inventoryMovement.create({
        data: validMovementData(orgA, { createdById: orgB.appUserId }),
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('rechaza una reversión que apunta a un movimiento de otra organización', async () => {
    const originalInOrgB = await prisma.inventoryMovement.create({ data: validMovementData(orgB) });
    await expect(
      prisma.inventoryMovement.create({
        data: validMovementData(orgA, { reversesMovementId: originalInOrgB.id }),
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('permite una reversión que apunta a un movimiento de la misma organización', async () => {
    const original = await prisma.inventoryMovement.create({ data: validMovementData(orgA) });
    const reversal = await prisma.inventoryMovement.create({
      data: validMovementData(orgA, {
        quantity: -10,
        enteredQuantity: -10,
        reversesMovementId: original.id,
      }),
    });
    expect(reversal.reversesMovementId).toBe(original.id);
  });

  it('rechaza un movimiento con cantidad cero (CHECK quantity <> 0)', async () => {
    await expect(
      prisma.inventoryMovement.create({ data: validMovementData(orgA, { quantity: 0 }) }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('rechaza un movimiento con cantidad ingresada cero (CHECK entered_quantity <> 0)', async () => {
    await expect(
      prisma.inventoryMovement.create({ data: validMovementData(orgA, { enteredQuantity: 0 }) }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('rechaza un factor de conversión no positivo (CHECK conversion_factor > 0)', async () => {
    await expect(
      prisma.inventoryMovement.create({ data: validMovementData(orgA, { conversionFactor: 0 }) }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('rechaza un ADJUSTMENT sin motivo (CHECK reason obligatorio)', async () => {
    await expect(
      prisma.inventoryMovement.create({
        data: validMovementData(orgA, { movementType: 'ADJUSTMENT', reason: null }),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('permite un ADJUSTMENT con motivo', async () => {
    const created = await prisma.inventoryMovement.create({
      data: validMovementData(orgA, { movementType: 'ADJUSTMENT', reason: 'Ajuste de prueba' }),
    });
    expect(created.reason).toBe('Ajuste de prueba');
  });

  it('rechaza un movimiento que se revierte a sí mismo (CHECK reverses_not_self)', async () => {
    const created = await prisma.inventoryMovement.create({ data: validMovementData(orgA) });
    await expect(
      prisma.inventoryMovement.update({
        where: { id: created.id },
        data: { reversesMovementId: created.id },
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('rechaza dos movimientos INITIAL_STOCK activos y originales para el mismo producto/ubicación', async () => {
    await prisma.inventoryMovement.create({ data: validMovementData(orgA) });
    await expect(
      prisma.inventoryMovement.create({ data: validMovementData(orgA) }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('permite un nuevo INITIAL_STOCK luego de revertir el anterior (la reversión no cuenta para el índice)', async () => {
    const original = await prisma.inventoryMovement.create({ data: validMovementData(orgA) });
    await prisma.inventoryMovement.update({
      where: { id: original.id },
      data: { status: 'REVERSED' },
    });
    await prisma.inventoryMovement.create({
      data: validMovementData(orgA, {
        quantity: -10,
        enteredQuantity: -10,
        reversesMovementId: original.id,
        reason: 'Reversión',
      }),
    });

    const secondInitial = await prisma.inventoryMovement.create({ data: validMovementData(orgA) });
    expect(secondInitial.id).not.toBe(original.id);
  });

  it('rechaza dos movimientos con la misma idempotencyKey en la misma organización', async () => {
    await prisma.inventoryMovement.create({
      data: validMovementData(orgA, { idempotencyKey: 'evento-1' }),
    });
    await expect(
      prisma.inventoryMovement.create({
        data: validMovementData(orgA, {
          movementType: 'ADJUSTMENT',
          reason: 'x',
          idempotencyKey: 'evento-1',
        }),
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('permite la misma idempotencyKey en organizaciones distintas', async () => {
    await prisma.inventoryMovement.create({
      data: validMovementData(orgA, { idempotencyKey: 'evento-compartido' }),
    });
    const createdInB = await prisma.inventoryMovement.create({
      data: validMovementData(orgB, { idempotencyKey: 'evento-compartido' }),
    });
    expect(createdInB.idempotencyKey).toBe('evento-compartido');
  });
});
