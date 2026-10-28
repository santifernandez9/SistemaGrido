import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@sistema-grido/db';
import type {
  CreateProductAliasInput,
  ProductAlias as ProductAliasDto,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ValidationError } from '../errors.js';
import { assertProductForMovement } from './inventory-ledger.js';

/**
 * Alias/mapeo de productos del Importador de Ventas (Etapa 5, sección 7 del
 * prompt). SIEMPRE lo crea/confirma un ADMIN explícitamente (nunca se
 * autogenera ni se infiere automáticamente); la ruta (Etapa 5, permisos)
 * sólo permite ADMIN. Un `ProductAlias` es configuración, no un hecho
 * histórico inmutable como `Sale` -- remapear un código externo hacia otro
 * producto es seguro y trazable (auditado) porque el mapeo se resuelve EN
 * VIVO en cada import (nunca se cachea en `SalesImportRow`): remapear no
 * altera ninguna venta ya CONFIRMADA (esa ya fijó su `productId` para
 * siempre en `Sale`, ver sales-import.ts).
 */

const aliasInclude = {
  product: { select: { name: true } },
  confirmedBy: { select: { displayName: true } },
} satisfies Prisma.ProductAliasInclude;

type AliasRow = Prisma.ProductAliasGetPayload<{ include: typeof aliasInclude }>;

function mapAlias(row: AliasRow): ProductAliasDto {
  return {
    id: row.id,
    source: row.source,
    externalCode: row.externalCode,
    externalDescription: row.externalDescription,
    productId: row.productId,
    productName: row.product.name,
    confirmedById: row.confirmedById,
    confirmedByName: row.confirmedBy.displayName,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Crea o remapea (upsert) un alias. Auditado siempre -- ver sección 12 del prompt. */
export async function createProductAlias(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  input: CreateProductAliasInput,
): Promise<ProductAliasDto> {
  const externalCode = input.externalCode.trim();
  if (!externalCode) {
    throw new ValidationError('El código externo no puede estar vacío');
  }
  await assertProductForMovement(fastify, organizationId, input.productId);

  const saved = await fastify.db.productAlias.upsert({
    where: {
      organizationId_source_externalCode: {
        organizationId,
        source: input.source,
        externalCode,
      },
    },
    create: {
      organizationId,
      source: input.source,
      externalCode,
      externalDescription: input.externalDescription ?? null,
      productId: input.productId,
      confirmedById: actor.id,
    },
    update: {
      externalDescription: input.externalDescription ?? null,
      productId: input.productId,
      confirmedById: actor.id,
    },
    include: aliasInclude,
  });

  await fastify.audit.log({
    organizationId,
    userId: actor.id,
    roleCode: actor.roleCode,
    action: 'SALES_IMPORT_PRODUCT_ALIAS_CONFIRMED',
    module: 'SALES_IMPORT',
    entityType: 'product_alias',
    entityId: saved.id,
    afterValue: mapAlias(saved),
  });

  return mapAlias(saved);
}

export async function listProductAliases(
  fastify: FastifyInstance,
  organizationId: string,
): Promise<ProductAliasDto[]> {
  const rows = await fastify.db.productAlias.findMany({
    where: { organizationId },
    include: aliasInclude,
    orderBy: { externalCode: 'asc' },
  });
  return rows.map(mapAlias);
}
