import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  BillOfMaterialItem as BillOfMaterialItemDto,
  CreateBillOfMaterialItemInput,
  UpdateBillOfMaterialItemInput,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { assertProductForMovement } from './inventory-ledger.js';

/**
 * BOM/recetas (Etapa 5, sección 18 del prompt: "las recetas se gestionan en
 * base de datos, nunca hardcodeadas"). Sólo backend/API en el Hito 1 -- la
 * pantalla mínima obligatoria de admin-web es "Ventas / Importar ventas"
 * (sección 20 del prompt); una pantalla de gestión de recetas no está en esa
 * lista, así que queda documentada como pendiente en
 * docs/ETAPA-5-IMPORTADOR-VENTAS.md en vez de construirse sin pedido.
 */

const bomInclude = {
  product: { select: { name: true } },
  componentProduct: { select: { name: true } },
} satisfies Prisma.BillOfMaterialItemInclude;

type BomRow = Prisma.BillOfMaterialItemGetPayload<{ include: typeof bomInclude }>;

function mapBomItem(row: BomRow): BillOfMaterialItemDto {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.product.name,
    componentProductId: row.componentProductId,
    componentProductName: row.componentProduct.name,
    quantityPerUnit: row.quantityPerUnit.toFixed(6),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createBillOfMaterialItem(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  input: CreateBillOfMaterialItemInput,
): Promise<BillOfMaterialItemDto> {
  if (input.productId === input.componentProductId) {
    throw new ValidationError('Un producto no puede ser insumo de sí mismo');
  }
  const quantityPerUnit = new Prisma.Decimal(input.quantityPerUnit);
  if (quantityPerUnit.lte(0)) {
    throw new ValidationError('La cantidad por unidad debe ser mayor a cero');
  }
  await assertProductForMovement(fastify, organizationId, input.productId);
  await assertProductForMovement(fastify, organizationId, input.componentProductId);

  const saved = await fastify.db.billOfMaterialItem.upsert({
    where: {
      organizationId_productId_componentProductId: {
        organizationId,
        productId: input.productId,
        componentProductId: input.componentProductId,
      },
    },
    create: {
      organizationId,
      productId: input.productId,
      componentProductId: input.componentProductId,
      quantityPerUnit,
      active: input.active ?? true,
    },
    update: {
      quantityPerUnit,
      active: input.active ?? true,
    },
    include: bomInclude,
  });

  await fastify.audit.log({
    organizationId,
    userId: actor.id,
    roleCode: actor.roleCode,
    action: 'SALES_IMPORT_BOM_ITEM_CREATED',
    module: 'SALES_IMPORT',
    entityType: 'bill_of_material_item',
    entityId: saved.id,
    afterValue: mapBomItem(saved),
  });

  return mapBomItem(saved);
}

export async function updateBillOfMaterialItem(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  id: string,
  input: UpdateBillOfMaterialItemInput,
): Promise<BillOfMaterialItemDto> {
  const existing = await fastify.db.billOfMaterialItem.findFirst({ where: { id, organizationId } });
  if (!existing) {
    throw new NotFoundError('Receta no encontrada en esta organización');
  }

  let quantityPerUnit = existing.quantityPerUnit;
  if (input.quantityPerUnit !== undefined) {
    quantityPerUnit = new Prisma.Decimal(input.quantityPerUnit);
    if (quantityPerUnit.lte(0)) {
      throw new ValidationError('La cantidad por unidad debe ser mayor a cero');
    }
  }

  const saved = await fastify.db.billOfMaterialItem.update({
    where: { id },
    data: {
      quantityPerUnit,
      active: input.active ?? existing.active,
    },
    include: bomInclude,
  });

  await fastify.audit.log({
    organizationId,
    userId: actor.id,
    roleCode: actor.roleCode,
    action: 'SALES_IMPORT_BOM_ITEM_UPDATED',
    module: 'SALES_IMPORT',
    entityType: 'bill_of_material_item',
    entityId: saved.id,
    afterValue: mapBomItem(saved),
  });

  return mapBomItem(saved);
}

export async function listBillOfMaterialItems(
  fastify: FastifyInstance,
  organizationId: string,
  filters: { productId?: string },
): Promise<BillOfMaterialItemDto[]> {
  const rows = await fastify.db.billOfMaterialItem.findMany({
    where: {
      organizationId,
      ...(filters.productId ? { productId: filters.productId } : {}),
    },
    include: bomInclude,
    orderBy: [{ product: { name: 'asc' } }, { componentProduct: { name: 'asc' } }],
  });
  return rows.map(mapBomItem);
}
