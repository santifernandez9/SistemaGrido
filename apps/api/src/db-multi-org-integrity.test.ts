import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@sistema-grido/db';

/**
 * Etapa 2.1 — Integridad multi-organización en PostgreSQL (ver
 * docs/ETAPA-2.1-INTEGRIDAD-MULTIORGANIZACION.md).
 *
 * A diferencia del resto de los tests de `apps/api`, estos NO pasan por
 * `app.inject()` ni por la capa de servicio (`services/catalog.ts`): usan el
 * cliente de Prisma directamente, igual que un insert directo a la base de
 * datos lo haría, para confirmar que la protección real está en PostgreSQL
 * (foreign keys compuestas) y no depende únicamente de la validación del
 * backend. La validación de `services/catalog.ts` se sigue probando por
 * separado en `routes/categories.test.ts`, `routes/products.test.ts`, etc.
 */
const { prisma } = await import('@sistema-grido/db');
const { resetCoreTables } = await import('./test/db-helpers.js');

function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

describe('Integridad multi-organización a nivel de base de datos (Etapa 2.1)', () => {
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    await resetCoreTables();
    orgA = (await prisma.organization.create({ data: { name: 'Organización A' } })).id;
    orgB = (await prisma.organization.create({ data: { name: 'Organización B' } })).id;
  });

  afterEach(async () => {
    await resetCoreTables();
  });

  it('rechaza una subcategoría cuyo grupo padre pertenece a otra organización', async () => {
    const parentInOrgB = await prisma.category.create({
      data: { organizationId: orgB, name: 'Grupo de B' },
    });

    await expect(
      prisma.category.create({
        data: {
          organizationId: orgA,
          name: 'Subgrupo cruzado',
          parentCategoryId: parentInOrgB.id,
        },
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('permite una subcategoría cuyo grupo padre pertenece a la misma organización', async () => {
    const parentInOrgA = await prisma.category.create({
      data: { organizationId: orgA, name: 'Grupo de A' },
    });

    const child = await prisma.category.create({
      data: { organizationId: orgA, name: 'Subgrupo válido', parentCategoryId: parentInOrgA.id },
    });

    expect(child.parentCategoryId).toBe(parentInOrgA.id);
  });

  it('rechaza un producto cuya categoría pertenece a otra organización', async () => {
    const categoryInOrgB = await prisma.category.create({
      data: { organizationId: orgB, name: 'Categoría de B' },
    });
    const productType = await prisma.productType.create({
      data: { organizationId: orgA, code: 'HELADO', name: 'Helado' },
    });
    const unit = await prisma.unitOfMeasure.create({
      data: { organizationId: orgA, code: 'LATA', name: 'Lata' },
    });

    await expect(
      prisma.product.create({
        data: {
          organizationId: orgA,
          name: 'Producto cruzado (categoría)',
          categoryId: categoryInOrgB.id,
          productTypeId: productType.id,
          unitOfMeasureId: unit.id,
        },
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('rechaza un producto cuyo tipo de producto pertenece a otra organización', async () => {
    const category = await prisma.category.create({
      data: { organizationId: orgA, name: 'Categoría de A' },
    });
    const productTypeInOrgB = await prisma.productType.create({
      data: { organizationId: orgB, code: 'HELADO', name: 'Helado' },
    });
    const unit = await prisma.unitOfMeasure.create({
      data: { organizationId: orgA, code: 'LATA', name: 'Lata' },
    });

    await expect(
      prisma.product.create({
        data: {
          organizationId: orgA,
          name: 'Producto cruzado (tipo)',
          categoryId: category.id,
          productTypeId: productTypeInOrgB.id,
          unitOfMeasureId: unit.id,
        },
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('rechaza un producto cuya unidad de manejo pertenece a otra organización', async () => {
    const category = await prisma.category.create({
      data: { organizationId: orgA, name: 'Categoría de A' },
    });
    const productType = await prisma.productType.create({
      data: { organizationId: orgA, code: 'HELADO', name: 'Helado' },
    });
    const unitInOrgB = await prisma.unitOfMeasure.create({
      data: { organizationId: orgB, code: 'LATA', name: 'Lata' },
    });

    await expect(
      prisma.product.create({
        data: {
          organizationId: orgA,
          name: 'Producto cruzado (unidad)',
          categoryId: category.id,
          productTypeId: productType.id,
          unitOfMeasureId: unitInOrgB.id,
        },
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('rechaza un producto cuyo sabor pertenece a otra organización', async () => {
    const category = await prisma.category.create({
      data: { organizationId: orgA, name: 'Categoría de A' },
    });
    const productType = await prisma.productType.create({
      data: { organizationId: orgA, code: 'HELADO', name: 'Helado' },
    });
    const unit = await prisma.unitOfMeasure.create({
      data: { organizationId: orgA, code: 'LATA', name: 'Lata' },
    });
    const flavorInOrgB = await prisma.flavor.create({
      data: { organizationId: orgB, name: 'Limón' },
    });

    await expect(
      prisma.product.create({
        data: {
          organizationId: orgA,
          name: 'Producto cruzado (sabor)',
          categoryId: category.id,
          productTypeId: productType.id,
          unitOfMeasureId: unit.id,
          flavorId: flavorInOrgB.id,
        },
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('permite un producto sin sabor (flavorId null) sin exigir la FK compuesta', async () => {
    const category = await prisma.category.create({
      data: { organizationId: orgA, name: 'Categoría de A' },
    });
    const productType = await prisma.productType.create({
      data: { organizationId: orgA, code: 'INSUMO', name: 'Insumo' },
    });
    const unit = await prisma.unitOfMeasure.create({
      data: { organizationId: orgA, code: 'CAJA', name: 'Caja' },
    });

    const product = await prisma.product.create({
      data: {
        organizationId: orgA,
        name: 'Insumo sin sabor',
        categoryId: category.id,
        productTypeId: productType.id,
        unitOfMeasureId: unit.id,
      },
    });

    expect(product.flavorId).toBeNull();
  });

  it('permite un producto con todas sus referencias (categoría, tipo, unidad, sabor) en la misma organización', async () => {
    const category = await prisma.category.create({
      data: { organizationId: orgA, name: 'Categoría de A' },
    });
    const productType = await prisma.productType.create({
      data: { organizationId: orgA, code: 'HELADO', name: 'Helado' },
    });
    const unit = await prisma.unitOfMeasure.create({
      data: { organizationId: orgA, code: 'LATA', name: 'Lata' },
    });
    const flavor = await prisma.flavor.create({
      data: { organizationId: orgA, name: 'Limón' },
    });

    const product = await prisma.product.create({
      data: {
        organizationId: orgA,
        name: 'Producto válido',
        categoryId: category.id,
        productTypeId: productType.id,
        unitOfMeasureId: unit.id,
        flavorId: flavor.id,
      },
    });

    expect(product.id).toBeTruthy();
    expect(product.categoryId).toBe(category.id);
    expect(product.productTypeId).toBe(productType.id);
    expect(product.unitOfMeasureId).toBe(unit.id);
    expect(product.flavorId).toBe(flavor.id);
  });
});
