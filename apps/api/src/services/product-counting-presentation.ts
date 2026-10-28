import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  CreateProductCountingPresentationInput,
  ProductCountingPresentation as ProductCountingPresentationDto,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { assertProductForMovement } from './inventory-ledger.js';

/**
 * Presentaciones físicas de conteo por producto (Etapa 6.2.2, secciones
 * 14/15/16/17/18 del prompt) -- ver docs/ETAPA-6.2.2-HARDENING-HITO1.md.
 * CRUD administrativo simple (nunca similarity matching, nunca inferido):
 * un ADMIN explícita qué `UnitOfMeasure` son presentaciones válidas de un
 * producto y con qué factor de conversión a la cantidad canónica.
 */

const PRODUCT_UOM_UNIQUE_TARGET = ['organization_id', 'product_id', 'unit_of_measure_id'] as const;

const presentationInclude = {
  product: { select: { name: true } },
  unitOfMeasure: { select: { name: true } },
} satisfies Prisma.ProductCountingPresentationInclude;

export type PresentationRow = Prisma.ProductCountingPresentationGetPayload<{
  include: typeof presentationInclude;
}>;

function mapPresentation(row: PresentationRow): ProductCountingPresentationDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    productId: row.productId,
    productName: row.product.name,
    unitOfMeasureId: row.unitOfMeasureId,
    unitOfMeasureName: row.unitOfMeasure.name,
    conversionFactorToCanonical: row.conversionFactorToCanonical.toFixed(3),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Todas las presentaciones (activas e inactivas) de un producto, para la
 * pantalla de administración -- nunca filtra por `active` acá (a diferencia
 * de `getActiveCountingPresentationsForProduct`, que sí lo hace, usada por
 * el conteo).
 */
export async function listProductCountingPresentations(
  fastify: FastifyInstance,
  organizationId: string,
  productId: string,
): Promise<ProductCountingPresentationDto[]> {
  await assertProductForMovement(fastify, organizationId, productId);
  const rows = await fastify.db.productCountingPresentation.findMany({
    where: { organizationId, productId },
    include: presentationInclude,
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(mapPresentation);
}

/**
 * TODAS las presentaciones ACTIVAS de la organización, sin importar el
 * producto -- usada por la Shop PWA (sección 18 del prompt) para saber, de
 * una sola llamada al cargar el conteo, qué productos deben renderizar
 * campos dinámicos por presentación en vez de "Cerrados" (evita N llamadas,
 * una por producto, contra un catálogo de ~200 productos). Sigue siendo de
 * SOLO LECTURA -- nunca decide nada acá, sólo informa a la pantalla; la
 * conversión real sigue validándose y calculándose exclusivamente en
 * `submitInventoryCount`/`submitInventoryRecount` (nunca el frontend).
 */
export async function listAllActiveCountingPresentations(
  fastify: FastifyInstance,
  organizationId: string,
): Promise<ProductCountingPresentationDto[]> {
  const rows = await fastify.db.productCountingPresentation.findMany({
    where: { organizationId, active: true },
    include: presentationInclude,
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(mapPresentation);
}

/**
 * Presentaciones ACTIVAS de un LOTE de productos, usadas por
 * `inventory-count.ts` para decidir, por ítem, si debe capturarse por
 * presentaciones (sección 18 del prompt: "el backend hace las
 * conversiones") o seguir usando `closedUnits` tal cual (sección 16:
 * compatibilidad si no hay ninguna configurada). Recibe el cliente de
 * Prisma como parámetro (mismo patrón que `resolveEffectivePricesForProducts`)
 * para poder usarse fuera o dentro de una transacción.
 *
 * Batch de UNA sola consulta para todos los productos del conteo -- nunca
 * una consulta por ítem dentro del `Promise.all` de `computeItem` (mismo
 * criterio de lote que `theoreticalByProduct`/`productFlavorFlags` en
 * `submitInventoryCount`): además de evitar N round-trips redundantes,
 * evita disparar muchas queries concurrentes innecesarias sobre el mismo
 * cliente compartido.
 */
export async function getActiveCountingPresentationsForProducts(
  db: Prisma.TransactionClient,
  organizationId: string,
  productIds: string[],
): Promise<Map<string, PresentationRow[]>> {
  if (productIds.length === 0) return new Map();
  const rows = await db.productCountingPresentation.findMany({
    where: { organizationId, productId: { in: productIds }, active: true },
    include: presentationInclude,
  });
  const byProduct = new Map<string, PresentationRow[]>();
  for (const row of rows) {
    const list = byProduct.get(row.productId) ?? [];
    list.push(row);
    byProduct.set(row.productId, list);
  }
  return byProduct;
}

/**
 * Crea una presentación nueva (sección 14/15 del prompt). Exclusivo de
 * productos SIN sabor (sección 17: "no mezclar el modelo especial de
 * sabores con las presentaciones de productos cerrados") -- un sabor sigue
 * usando únicamente la mecánica Salón/Depósito de Etapa 6.2.1.
 */
export async function createProductCountingPresentation(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  productId: string,
  input: CreateProductCountingPresentationInput,
): Promise<ProductCountingPresentationDto> {
  const product = await assertProductForMovement(fastify, organizationId, productId);
  if (product.flavorId !== null) {
    throw new ValidationError(
      'Un sabor de helado no admite presentaciones de conteo -- usa la mecánica Salón/Depósito existente.',
    );
  }

  const unitOfMeasure = await fastify.db.unitOfMeasure.findFirst({
    where: { organizationId, id: input.unitOfMeasureId },
  });
  if (!unitOfMeasure) {
    throw new NotFoundError('Unidad de manejo no encontrada en esta organización');
  }

  const factor = new Prisma.Decimal(input.conversionFactorToCanonical);
  if (!factor.isFinite() || factor.lessThanOrEqualTo(0)) {
    throw new ValidationError('El factor de conversión debe ser un número mayor a cero');
  }

  try {
    return await fastify.db.$transaction(async (tx) => {
      const created = await tx.productCountingPresentation.create({
        data: {
          organizationId,
          productId,
          unitOfMeasureId: input.unitOfMeasureId,
          conversionFactorToCanonical: factor,
        },
        include: presentationInclude,
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'PRODUCT_COUNTING_PRESENTATION_CREATED',
        module: 'CATALOG',
        entityType: 'product_counting_presentation',
        entityId: created.id,
        afterValue: mapPresentation(created),
      });

      return mapPresentation(created);
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      Array.isArray(err.meta?.target) &&
      PRODUCT_UOM_UNIQUE_TARGET.every((c) => (err.meta!.target as string[]).includes(c))
    ) {
      throw new ConflictError(
        'Este producto ya tiene una presentación configurada con esa unidad de manejo.',
      );
    }
    throw err;
  }
}

export async function deactivateProductCountingPresentation(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  productId: string,
  presentationId: string,
): Promise<void> {
  const presentation = await fastify.db.productCountingPresentation.findFirst({
    where: { id: presentationId, organizationId, productId },
  });
  if (!presentation) {
    throw new NotFoundError('Presentación no encontrada en este producto');
  }
  if (!presentation.active) {
    throw new ValidationError('Esta presentación ya está inactiva');
  }

  await fastify.db.$transaction(async (tx) => {
    await tx.productCountingPresentation.update({
      where: { id: presentationId },
      data: { active: false },
    });
    await fastify.audit.logTx(tx, {
      organizationId,
      userId: actor.id,
      roleCode: actor.roleCode,
      action: 'PRODUCT_COUNTING_PRESENTATION_DEACTIVATED',
      module: 'CATALOG',
      entityType: 'product_counting_presentation',
      entityId: presentationId,
    });
  });
}
