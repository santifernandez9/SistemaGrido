import type { FastifyInstance } from 'fastify';
import type {
  InventoryCount as InventoryCountDto,
  InventoryCountTypoCandidate as TypoCandidateDto,
  ResolveInventoryDifferenceInput,
  ResolveTypoCandidateInput,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { getInventoryCountDetail } from './inventory-count.js';

/**
 * Resolución explícita de diferencias de conteo y de candidatos de posible
 * error de tipeo (Etapa 6.2, secciones 4/5/6 del prompt) -- ver
 * docs/ETAPA-6.2-CIERRE-INTEGRAL.md. La DETECCIÓN de candidatos de tipeo
 * vive en `inventory-count.ts` (`detectAndPersistTypoCandidates`, se llama
 * dentro de la misma transacción que deja un conteo COMPLETED) -- este
 * archivo sólo agrega la revisión explícita POSTERIOR de un ADMIN, para no
 * crear un ciclo de módulos entre ambos archivos.
 */

/**
 * Resolución explícita de una diferencia (sección 4/5 del prompt): un
 * FALTANTE se confirma como "FALTANTE CONFIRMADO" (`SHORTAGE_CONFIRMED`,
 * preservando el conteo original -- nunca se sobrescribe `physicalQuantity`/
 * `difference`), un SOBRANTE nunca se acepta en silencio y requiere este
 * mismo gesto (`SURPLUS_RESOLVED`) antes de considerarse resuelto.
 */
export async function resolveInventoryDifference(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  countId: string,
  itemId: string,
  input: ResolveInventoryDifferenceInput,
): Promise<InventoryCountDto> {
  const count = await fastify.db.inventoryCount.findFirst({
    where: { id: countId, organizationId },
  });
  if (!count) {
    throw new NotFoundError('Conteo no encontrado en esta organización');
  }
  if (count.status === 'RECOUNT_REQUIRED') {
    throw new ConflictError(
      'Este conteo todavía espera un reconteo -- las diferencias no son finales hasta que se complete.',
    );
  }

  const item = await fastify.db.inventoryCountItem.findFirst({
    where: { id: itemId, organizationId, countId },
  });
  if (!item) {
    throw new NotFoundError('Ítem de conteo no encontrado en este conteo');
  }
  if (item.difference === null || item.difference.isZero()) {
    throw new ValidationError('Este ítem no tiene una diferencia para resolver');
  }
  if (input.kind === 'SHORTAGE_CONFIRMED' && !item.difference.isNegative()) {
    throw new ValidationError(
      'SHORTAGE_CONFIRMED sólo aplica a un ítem con FALTANTE (diferencia negativa)',
    );
  }
  if (input.kind === 'SURPLUS_RESOLVED' && !item.difference.isPositive()) {
    throw new ValidationError(
      'SURPLUS_RESOLVED sólo aplica a un ítem con SOBRANTE (diferencia positiva)',
    );
  }
  if (item.differenceResolution !== null) {
    throw new ConflictError(`Esta diferencia ya fue resuelta (${item.differenceResolution}).`);
  }

  await fastify.db.$transaction(async (tx) => {
    const updateResult = await tx.inventoryCountItem.updateMany({
      where: { id: itemId, organizationId, countId, differenceResolution: null },
      data: {
        differenceResolution: input.kind,
        differenceResolvedById: actor.id,
        differenceResolvedAt: new Date(),
        differenceResolutionNote: input.note?.trim() || null,
      },
    });
    if (updateResult.count === 0) {
      throw new ConflictError(
        'Esta diferencia ya fue resuelta por otra solicitud; volvé a consultarla.',
      );
    }

    await fastify.audit.logTx(tx, {
      organizationId,
      userId: actor.id,
      roleCode: actor.roleCode,
      locationId: count.locationId,
      action:
        input.kind === 'SHORTAGE_CONFIRMED'
          ? 'SHOP_COUNT_SHORTAGE_CONFIRMED'
          : 'SHOP_COUNT_SURPLUS_RESOLVED',
      module: 'SHOP_OPS',
      entityType: 'inventory_count_item',
      entityId: itemId,
      reason: input.note,
    });
  });

  return getInventoryCountDetail(fastify, organizationId, countId);
}

/**
 * Confirma o rechaza una sugerencia de posible error de tipeo (sección 6
 * del prompt). SIEMPRE documentación pura -- nunca modifica `Sale` ni
 * genera un `InventoryMovement`, con o sin confirmación.
 */
export async function resolveTypoCandidate(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  countId: string,
  candidateId: string,
  input: ResolveTypoCandidateInput,
): Promise<TypoCandidateDto> {
  const candidate = await fastify.db.inventoryCountTypoCandidate.findFirst({
    where: { id: candidateId, organizationId, countId },
  });
  if (!candidate) {
    throw new NotFoundError('Candidato de posible error de tipeo no encontrado en este conteo');
  }
  if (candidate.status !== 'PENDING') {
    throw new ConflictError(`Este candidato ya fue revisado (${candidate.status}).`);
  }

  const count = await fastify.db.inventoryCount.findFirstOrThrow({
    where: { id: countId, organizationId },
  });

  await fastify.db.$transaction(async (tx) => {
    const updateResult = await tx.inventoryCountTypoCandidate.updateMany({
      where: { id: candidateId, organizationId, countId, status: 'PENDING' },
      data: {
        status: input.status,
        resolvedById: actor.id,
        resolvedAt: new Date(),
        resolutionNote: input.note?.trim() || null,
      },
    });
    if (updateResult.count === 0) {
      throw new ConflictError(
        'Este candidato ya fue revisado por otra solicitud; volvé a consultarlo.',
      );
    }

    await fastify.audit.logTx(tx, {
      organizationId,
      userId: actor.id,
      roleCode: actor.roleCode,
      locationId: count.locationId,
      action:
        input.status === 'CONFIRMED'
          ? 'SHOP_COUNT_TYPO_CANDIDATE_CONFIRMED'
          : 'SHOP_COUNT_TYPO_CANDIDATE_REJECTED',
      module: 'SHOP_OPS',
      entityType: 'inventory_count_typo_candidate',
      entityId: candidateId,
      reason: input.note,
    });
  });

  const updated = await fastify.db.inventoryCountTypoCandidate.findFirstOrThrow({
    where: { id: candidateId, organizationId },
    include: {
      shortageItem: { select: { productId: true, product: { select: { name: true } } } },
      surplusItem: { select: { productId: true, product: { select: { name: true } } } },
      resolvedBy: { select: { displayName: true } },
    },
  });
  return {
    id: updated.id,
    countId: updated.countId,
    shortageItemId: updated.shortageItemId,
    shortageProductId: updated.shortageItem.productId,
    shortageProductName: updated.shortageItem.product.name,
    surplusItemId: updated.surplusItemId,
    surplusProductId: updated.surplusItem.productId,
    surplusProductName: updated.surplusItem.product.name,
    compensatingQuantity: updated.compensatingQuantity.toFixed(3),
    salePriceUsed: updated.salePriceUsed.toFixed(2),
    status: updated.status,
    resolvedById: updated.resolvedById,
    resolvedByName: updated.resolvedBy?.displayName ?? null,
    resolvedAt: updated.resolvedAt?.toISOString() ?? null,
    resolutionNote: updated.resolutionNote,
    createdAt: updated.createdAt.toISOString(),
  };
}
