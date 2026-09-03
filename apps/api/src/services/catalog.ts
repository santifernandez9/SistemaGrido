import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  Category,
  CreateCategoryInput,
  UpdateCategoryInput,
  Flavor,
  CreateFlavorInput,
  UpdateFlavorInput,
  ProductType,
  UnitOfMeasure,
  Product,
  CreateProductInput,
  UpdateProductInput,
} from '@sistema-grido/shared-types';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// ---------------------------------------------------------------------------
// Categorías / grupos (RF-002, RN-002)
// ---------------------------------------------------------------------------

function mapCategory(row: {
  id: string;
  organizationId: string;
  parentCategoryId: string | null;
  name: string;
  active: boolean;
  createdAt: Date;
}): Category {
  return {
    id: row.id,
    organizationId: row.organizationId,
    parentCategoryId: row.parentCategoryId,
    name: row.name,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listCategories(
  fastify: FastifyInstance,
  organizationId: string,
): Promise<Category[]> {
  const rows = await fastify.db.category.findMany({
    where: { organizationId },
    orderBy: [{ parentCategoryId: 'asc' }, { name: 'asc' }],
  });
  return rows.map(mapCategory);
}

/**
 * Postgres considera cada NULL distinto entre sí en una constraint UNIQUE, así que
 * `@@unique([organizationId, parentCategoryId, name])` NO detecta dos categorías
 * raíz (parentCategoryId = NULL) con el mismo nombre -- sólo protege el caso de
 * subcategorías (parentCategoryId no nulo). Se valida acá explícitamente para
 * cubrir también el caso raíz; la constraint de la base queda como red de
 * seguridad adicional contra condiciones de carrera en el caso no-nulo.
 */
async function assertNameNotTaken(
  fastify: FastifyInstance,
  organizationId: string,
  parentCategoryId: string | null,
  name: string,
): Promise<void> {
  const existing = await fastify.db.category.findFirst({
    where: { organizationId, parentCategoryId, name },
  });
  if (existing) {
    throw new ConflictError('Ya existe una categoría con ese nombre en este nivel');
  }
}

/**
 * Sólo se admite un nivel de subcategoría (grupo → subgrupo, RN-002) -- decisión
 * técnica documentada en prisma/schema.prisma y en docs/ETAPA-2-CATALOGO-MAESTROS.md:
 * el material real no muestra evidencia de una jerarquía más profunda.
 */
async function assertValidParentCategory(
  fastify: FastifyInstance,
  organizationId: string,
  parentCategoryId: string,
  selfId?: string,
): Promise<void> {
  if (parentCategoryId === selfId) {
    throw new ValidationError('Una categoría no puede ser su propia categoría padre');
  }
  const parent = await fastify.db.category.findFirst({
    where: { id: parentCategoryId, organizationId },
  });
  if (!parent) {
    throw new ValidationError('La categoría padre indicada no existe en esta organización');
  }
  if (parent.parentCategoryId) {
    throw new ValidationError('No se permite más de un nivel de subcategoría (grupo → subgrupo)');
  }
  if (selfId) {
    const hasChildren = await fastify.db.category.findFirst({
      where: { parentCategoryId: selfId },
    });
    if (hasChildren) {
      throw new ValidationError(
        'Esta categoría tiene subcategorías propias; no puede pasar a ser subcategoría de otra',
      );
    }
  }
}

export async function createCategory(
  fastify: FastifyInstance,
  organizationId: string,
  input: CreateCategoryInput,
): Promise<Category> {
  if (input.parentCategoryId) {
    await assertValidParentCategory(fastify, organizationId, input.parentCategoryId);
  }
  await assertNameNotTaken(fastify, organizationId, input.parentCategoryId, input.name);

  try {
    const created = await fastify.db.category.create({
      data: { organizationId, name: input.name, parentCategoryId: input.parentCategoryId },
    });
    return mapCategory(created);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError('Ya existe una categoría con ese nombre en este nivel');
    }
    throw err;
  }
}

export async function updateCategory(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
  input: UpdateCategoryInput,
): Promise<{ before: Category; after: Category }> {
  const existing = await fastify.db.category.findFirst({ where: { id, organizationId } });
  if (!existing) {
    throw new NotFoundError('Categoría no encontrada en esta organización');
  }
  const before = mapCategory(existing);

  if (input.parentCategoryId !== undefined && input.parentCategoryId !== null) {
    await assertValidParentCategory(fastify, organizationId, input.parentCategoryId, id);
  }

  if (input.name !== undefined || input.parentCategoryId !== undefined) {
    const effectiveParentId =
      input.parentCategoryId !== undefined ? input.parentCategoryId : existing.parentCategoryId;
    const effectiveName = input.name ?? existing.name;
    const collision = await fastify.db.category.findFirst({
      where: {
        organizationId,
        parentCategoryId: effectiveParentId,
        name: effectiveName,
        NOT: { id },
      },
    });
    if (collision) {
      throw new ConflictError('Ya existe una categoría con ese nombre en este nivel');
    }
  }

  try {
    const updated = await fastify.db.category.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.parentCategoryId !== undefined
          ? { parentCategoryId: input.parentCategoryId }
          : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
    });
    return { before, after: mapCategory(updated) };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError('Ya existe una categoría con ese nombre en este nivel');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sabores (RF-003, RN-003)
// ---------------------------------------------------------------------------

function mapFlavor(row: {
  id: string;
  organizationId: string;
  name: string;
  active: boolean;
  createdAt: Date;
}): Flavor {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listFlavors(
  fastify: FastifyInstance,
  organizationId: string,
): Promise<Flavor[]> {
  const rows = await fastify.db.flavor.findMany({
    where: { organizationId },
    orderBy: { name: 'asc' },
  });
  return rows.map(mapFlavor);
}

export async function createFlavor(
  fastify: FastifyInstance,
  organizationId: string,
  input: CreateFlavorInput,
): Promise<Flavor> {
  try {
    const created = await fastify.db.flavor.create({
      data: { organizationId, name: input.name },
    });
    return mapFlavor(created);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(`Ya existe un sabor con el nombre "${input.name}"`);
    }
    throw err;
  }
}

export async function updateFlavor(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
  input: UpdateFlavorInput,
): Promise<{ before: Flavor; after: Flavor }> {
  const existing = await fastify.db.flavor.findFirst({ where: { id, organizationId } });
  if (!existing) {
    throw new NotFoundError('Sabor no encontrado en esta organización');
  }
  const before = mapFlavor(existing);

  try {
    const updated = await fastify.db.flavor.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
    });
    return { before, after: mapFlavor(updated) };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(`Ya existe un sabor con el nombre "${input.name ?? ''}"`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tipos de producto y unidades de manejo: catálogos técnicos sembrados
// (packages/db/src/seed.ts), sólo lectura por API en esta etapa -- ver
// docs/ETAPA-2-CATALOGO-MAESTROS.md, sección "Permisos".
// ---------------------------------------------------------------------------

export async function listProductTypes(
  fastify: FastifyInstance,
  organizationId: string,
): Promise<ProductType[]> {
  const rows = await fastify.db.productType.findMany({
    where: { organizationId, active: true },
    orderBy: { name: 'asc' },
  });
  return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, active: row.active }));
}

export async function listUnitsOfMeasure(
  fastify: FastifyInstance,
  organizationId: string,
): Promise<UnitOfMeasure[]> {
  const rows = await fastify.db.unitOfMeasure.findMany({
    where: { organizationId, active: true },
    orderBy: { name: 'asc' },
  });
  return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, active: row.active }));
}

// ---------------------------------------------------------------------------
// Productos (RF-001)
// ---------------------------------------------------------------------------

const productInclude = {
  category: true,
  productType: true,
  unitOfMeasure: true,
  flavor: true,
} as const;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

function mapProduct(row: ProductRow): Product {
  return {
    id: row.id,
    organizationId: row.organizationId,
    code: row.code,
    name: row.name,
    categoryId: row.categoryId,
    categoryName: row.category.name,
    productTypeId: row.productTypeId,
    productTypeName: row.productType.name,
    unitOfMeasureId: row.unitOfMeasureId,
    unitOfMeasureName: row.unitOfMeasure.name,
    unitsPerHandlingUnit: row.unitsPerHandlingUnit,
    flavorId: row.flavorId,
    flavorName: row.flavor?.name ?? null,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertCategoryValid(
  fastify: FastifyInstance,
  organizationId: string,
  categoryId: string,
): Promise<void> {
  const category = await fastify.db.category.findFirst({
    where: { id: categoryId, organizationId },
  });
  if (!category) {
    throw new ValidationError('La categoría indicada no existe en esta organización');
  }
}

async function assertProductTypeValid(
  fastify: FastifyInstance,
  organizationId: string,
  productTypeId: string,
): Promise<void> {
  const productType = await fastify.db.productType.findFirst({
    where: { id: productTypeId, organizationId },
  });
  if (!productType) {
    throw new ValidationError('El tipo de producto indicado no existe en esta organización');
  }
}

async function assertUnitOfMeasureValid(
  fastify: FastifyInstance,
  organizationId: string,
  unitOfMeasureId: string,
): Promise<void> {
  const unitOfMeasure = await fastify.db.unitOfMeasure.findFirst({
    where: { id: unitOfMeasureId, organizationId },
  });
  if (!unitOfMeasure) {
    throw new ValidationError('La unidad de manejo indicada no existe en esta organización');
  }
}

async function assertFlavorValid(
  fastify: FastifyInstance,
  organizationId: string,
  flavorId: string,
): Promise<void> {
  const flavor = await fastify.db.flavor.findFirst({ where: { id: flavorId, organizationId } });
  if (!flavor) {
    throw new ValidationError('El sabor indicado no existe en esta organización');
  }
}

export async function listProducts(
  fastify: FastifyInstance,
  organizationId: string,
): Promise<Product[]> {
  const rows = await fastify.db.product.findMany({
    where: { organizationId },
    include: productInclude,
    orderBy: { name: 'asc' },
  });
  return rows.map(mapProduct);
}

export async function getProduct(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
): Promise<Product> {
  const row = await fastify.db.product.findFirst({
    where: { id, organizationId },
    include: productInclude,
  });
  if (!row) {
    throw new NotFoundError('Producto no encontrado en esta organización');
  }
  return mapProduct(row);
}

export async function createProduct(
  fastify: FastifyInstance,
  organizationId: string,
  input: CreateProductInput,
): Promise<Product> {
  await assertCategoryValid(fastify, organizationId, input.categoryId);
  await assertProductTypeValid(fastify, organizationId, input.productTypeId);
  await assertUnitOfMeasureValid(fastify, organizationId, input.unitOfMeasureId);
  if (input.flavorId) {
    await assertFlavorValid(fastify, organizationId, input.flavorId);
  }

  try {
    const created = await fastify.db.product.create({
      data: {
        organizationId,
        code: input.code,
        name: input.name,
        categoryId: input.categoryId,
        productTypeId: input.productTypeId,
        unitOfMeasureId: input.unitOfMeasureId,
        unitsPerHandlingUnit: input.unitsPerHandlingUnit,
        flavorId: input.flavorId,
      },
      include: productInclude,
    });
    return mapProduct(created);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(`Ya existe un producto con el código ${input.code ?? ''}`);
    }
    throw err;
  }
}

export async function updateProduct(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
  input: UpdateProductInput,
): Promise<{ before: Product; after: Product }> {
  const existing = await fastify.db.product.findFirst({
    where: { id, organizationId },
    include: productInclude,
  });
  if (!existing) {
    throw new NotFoundError('Producto no encontrado en esta organización');
  }
  const before = mapProduct(existing);

  if (input.categoryId !== undefined) {
    await assertCategoryValid(fastify, organizationId, input.categoryId);
  }
  if (input.productTypeId !== undefined) {
    await assertProductTypeValid(fastify, organizationId, input.productTypeId);
  }
  if (input.unitOfMeasureId !== undefined) {
    await assertUnitOfMeasureValid(fastify, organizationId, input.unitOfMeasureId);
  }
  if (input.flavorId !== undefined && input.flavorId !== null) {
    await assertFlavorValid(fastify, organizationId, input.flavorId);
  }

  try {
    const updated = await fastify.db.product.update({
      where: { id },
      data: {
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.productTypeId !== undefined ? { productTypeId: input.productTypeId } : {}),
        ...(input.unitOfMeasureId !== undefined ? { unitOfMeasureId: input.unitOfMeasureId } : {}),
        ...(input.unitsPerHandlingUnit !== undefined
          ? { unitsPerHandlingUnit: input.unitsPerHandlingUnit }
          : {}),
        ...(input.flavorId !== undefined ? { flavorId: input.flavorId } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
      include: productInclude,
    });
    return { before, after: mapProduct(updated) };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(`Ya existe un producto con el código ${input.code ?? ''}`);
    }
    throw err;
  }
}
