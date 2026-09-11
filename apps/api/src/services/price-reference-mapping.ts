import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  CreatePriceReferenceProductMappingInput,
  PriceReference as PriceReferenceDto,
  PriceReferenceFilters,
  PriceReferenceProductMapping as PriceReferenceProductMappingDto,
  PriceType,
  ProductPriceResolution,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { assertProductForMovement } from './inventory-ledger.js';

/**
 * Mapeo referencia Grido <-> catálogo interno (Etapa 6.2, sección 8 del
 * prompt, CONFIRMADO) y resolución del costo/precio VIGENTE por producto
 * (sección 10/11, usado por `weekly-closing.ts` al cerrar). Nunca infiere
 * un mapeo por similitud textual -- toda fila la escribe explícitamente un
 * ADMIN.
 */

const ACTIVE_MAPPING_PER_PRODUCT_TYPE_TARGET = [
  'organization_id',
  'product_id',
  'price_type',
] as const;

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resuelve, EN VIVO y en LOTE, el costo/precio VIGENTE de un conjunto de
 * productos a una fecha dada -- el mismo criterio "vigente" en todos lados:
 * el `PriceValue` con la mayor `effectiveFrom <= asOfDate` de la
 * `PriceReference` mapeada ACTIVAMENTE a ese producto para ese `priceType`.
 * Recibe el cliente de Prisma como parámetro (nunca `FastifyInstance`) para
 * poder usarse tanto fuera de una transacción como DENTRO de una --
 * `weekly-closing.ts` la necesita dentro de la transacción de `close` para
 * que la valorización forme parte de la misma operación atómica.
 */
export async function resolveEffectivePricesForProducts(
  db: Prisma.TransactionClient,
  organizationId: string,
  productIds: string[],
  priceType: PriceType,
  asOfDate: Date,
): Promise<
  Map<
    string,
    | { status: 'OK'; value: Prisma.Decimal; priceValueId: string; priceReferenceId: string }
    | { status: 'NO_MAPPING' }
    | { status: 'NO_VIGENT_VALUE'; priceReferenceId: string }
  >
> {
  const result = new Map<
    string,
    | { status: 'OK'; value: Prisma.Decimal; priceValueId: string; priceReferenceId: string }
    | { status: 'NO_MAPPING' }
    | { status: 'NO_VIGENT_VALUE'; priceReferenceId: string }
  >();
  if (productIds.length === 0) return result;

  const mappings = await db.priceReferenceProductMapping.findMany({
    where: { organizationId, productId: { in: productIds }, priceType, active: true },
  });
  const mappingByProduct = new Map(mappings.map((m) => [m.productId, m]));

  const referenceIds = [...new Set(mappings.map((m) => m.priceReferenceId))];
  const values =
    referenceIds.length > 0
      ? await db.priceValue.findMany({
          where: {
            organizationId,
            priceReferenceId: { in: referenceIds },
            effectiveFrom: { lte: asOfDate },
          },
          orderBy: { effectiveFrom: 'desc' },
        })
      : [];
  const latestByReference = new Map<string, (typeof values)[number]>();
  for (const value of values) {
    if (!latestByReference.has(value.priceReferenceId)) {
      latestByReference.set(value.priceReferenceId, value);
    }
  }

  for (const productId of productIds) {
    const mapping = mappingByProduct.get(productId);
    if (!mapping) {
      result.set(productId, { status: 'NO_MAPPING' });
      continue;
    }
    const value = latestByReference.get(mapping.priceReferenceId);
    if (!value) {
      result.set(productId, {
        status: 'NO_VIGENT_VALUE',
        priceReferenceId: mapping.priceReferenceId,
      });
      continue;
    }
    result.set(productId, {
      status: 'OK',
      value: value.value,
      priceValueId: value.id,
      priceReferenceId: mapping.priceReferenceId,
    });
  }

  return result;
}

/** Wrapper de un solo producto -- usado por la UI de revisión de precios. */
export async function resolveProductPriceResolution(
  fastify: FastifyInstance,
  organizationId: string,
  productId: string,
  priceType: PriceType,
  asOfDate: Date = new Date(),
): Promise<ProductPriceResolution> {
  const product = await fastify.db.product.findFirst({
    where: { organizationId, id: productId },
    select: { name: true },
  });
  if (!product) {
    throw new NotFoundError('Producto no encontrado en esta organización');
  }
  const resolved = await resolveEffectivePricesForProducts(
    fastify.db,
    organizationId,
    [productId],
    priceType,
    asOfDate,
  );
  const entry = resolved.get(productId);
  if (!entry || entry.status !== 'OK') {
    return {
      productId,
      productName: product.name,
      priceType,
      value: null,
      priceValueId: null,
      priceReferenceId: entry && 'priceReferenceId' in entry ? entry.priceReferenceId : null,
      priceReferenceLabel: null,
      effectiveFrom: null,
    };
  }
  const reference = await fastify.db.priceReference.findFirst({
    where: { organizationId, id: entry.priceReferenceId },
    select: { label: true },
  });
  const value = await fastify.db.priceValue.findFirst({
    where: { organizationId, id: entry.priceValueId },
    select: { effectiveFrom: true },
  });
  return {
    productId,
    productName: product.name,
    priceType,
    value: entry.value.toFixed(2),
    priceValueId: entry.priceValueId,
    priceReferenceId: entry.priceReferenceId,
    priceReferenceLabel: reference?.label ?? null,
    effectiveFrom: value ? toIsoDate(value.effectiveFrom) : null,
  };
}

export async function listPriceReferences(
  fastify: FastifyInstance,
  organizationId: string,
  filters: PriceReferenceFilters,
): Promise<PriceReferenceDto[]> {
  const rows = await fastify.db.priceReference.findMany({
    where: {
      organizationId,
      ...(filters.priceType ? { priceType: filters.priceType } : {}),
    },
    include: {
      mappings: { where: { active: true }, select: { id: true } },
      values: { orderBy: { effectiveFrom: 'desc' }, take: 1 },
    },
    orderBy: { label: 'asc' },
  });

  const now = new Date();
  return rows
    .filter((r) => !filters.onlyUnmapped || r.mappings.length === 0)
    .map((r) => {
      const currentValue = r.values.find((v) => v.effectiveFrom <= now) ?? null;
      return {
        id: r.id,
        priceType: r.priceType,
        label: r.label,
        sourceCategory: r.sourceCategory,
        active: r.active,
        currentValue: currentValue?.value.toFixed(2) ?? null,
        currentValueEffectiveFrom: currentValue ? toIsoDate(currentValue.effectiveFrom) : null,
        mappedProductCount: r.mappings.length,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
}

function mapMapping(
  row: Prisma.PriceReferenceProductMappingGetPayload<{
    include: {
      priceReference: { select: { label: true } };
      product: { select: { name: true } };
      confirmedBy: { select: { displayName: true } };
    };
  }>,
): PriceReferenceProductMappingDto {
  return {
    id: row.id,
    priceReferenceId: row.priceReferenceId,
    priceReferenceLabel: row.priceReference.label,
    priceType: row.priceType,
    productId: row.productId,
    productName: row.product.name,
    active: row.active,
    confirmedById: row.confirmedById,
    confirmedByName: row.confirmedBy.displayName,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listPriceReferenceProductMappings(
  fastify: FastifyInstance,
  organizationId: string,
  filters: { priceReferenceId?: string; productId?: string },
): Promise<PriceReferenceProductMappingDto[]> {
  const rows = await fastify.db.priceReferenceProductMapping.findMany({
    where: {
      organizationId,
      active: true,
      ...(filters.priceReferenceId ? { priceReferenceId: filters.priceReferenceId } : {}),
      ...(filters.productId ? { productId: filters.productId } : {}),
    },
    include: {
      priceReference: { select: { label: true } },
      product: { select: { name: true } },
      confirmedBy: { select: { displayName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(mapMapping);
}

/**
 * Confirma un mapeo (sección 8 del prompt: soporta N productos por
 * referencia). Si el producto ya tenía OTRO mapeo activo para el MISMO
 * `priceType`, lo desactiva en la misma transacción (nunca deja dos activos
 * simultáneos ambiguos -- índice único parcial de la migración es la
 * garantía final a nivel de Postgres).
 */
export async function createPriceReferenceProductMapping(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  input: CreatePriceReferenceProductMappingInput,
): Promise<PriceReferenceProductMappingDto> {
  const reference = await fastify.db.priceReference.findFirst({
    where: { organizationId, id: input.priceReferenceId },
  });
  if (!reference) {
    throw new NotFoundError('Referencia de precio/costo no encontrada en esta organización');
  }
  await assertProductForMovement(fastify, organizationId, input.productId);

  try {
    return await fastify.db.$transaction(async (tx) => {
      await tx.priceReferenceProductMapping.updateMany({
        where: {
          organizationId,
          productId: input.productId,
          priceType: reference.priceType,
          active: true,
        },
        data: { active: false },
      });

      const created = await tx.priceReferenceProductMapping.upsert({
        where: {
          organizationId_priceReferenceId_productId: {
            organizationId,
            priceReferenceId: input.priceReferenceId,
            productId: input.productId,
          },
        },
        create: {
          organizationId,
          priceReferenceId: input.priceReferenceId,
          priceType: reference.priceType,
          productId: input.productId,
          active: true,
          confirmedById: actor.id,
        },
        update: { active: true, confirmedById: actor.id },
        include: {
          priceReference: { select: { label: true } },
          product: { select: { name: true } },
          confirmedBy: { select: { displayName: true } },
        },
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'PRICE_REFERENCE_PRODUCT_MAPPING_CONFIRMED',
        module: 'PRICE_LIST',
        entityType: 'price_reference_product_mapping',
        entityId: created.id,
        afterValue: mapMapping(created),
      });

      return mapMapping(created);
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      Array.isArray(err.meta?.target) &&
      ACTIVE_MAPPING_PER_PRODUCT_TYPE_TARGET.every((c) =>
        (err.meta!.target as string[]).includes(c),
      )
    ) {
      throw new ConflictError(
        'Este producto ya tiene otro mapeo activo para este tipo de precio (condición de carrera); volvé a intentar.',
      );
    }
    throw err;
  }
}

export async function deactivatePriceReferenceProductMapping(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  id: string,
): Promise<void> {
  const mapping = await fastify.db.priceReferenceProductMapping.findFirst({
    where: { organizationId, id },
  });
  if (!mapping) {
    throw new NotFoundError('Mapeo no encontrado en esta organización');
  }
  if (!mapping.active) {
    throw new ValidationError('Este mapeo ya está inactivo');
  }

  await fastify.db.$transaction(async (tx) => {
    await tx.priceReferenceProductMapping.update({
      where: { id },
      data: { active: false },
    });
    await fastify.audit.logTx(tx, {
      organizationId,
      userId: actor.id,
      roleCode: actor.roleCode,
      action: 'PRICE_REFERENCE_PRODUCT_MAPPING_DEACTIVATED',
      module: 'PRICE_LIST',
      entityType: 'price_reference_product_mapping',
      entityId: id,
    });
  });
}
