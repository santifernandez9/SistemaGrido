import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  CreateStockoutEventInput,
  StockoutEvent as StockoutEventDto,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ConflictError } from '../errors.js';
import {
  assertLocationForMovement,
  assertProductForMovement,
  getStockBalances,
} from './inventory-ledger.js';
import { isUniqueConstraintViolationOn } from './idempotency.js';

/**
 * "Sin stock" (RF-019/RN-019). NO es un movimiento de inventario: no
 * modifica stock, no crea stock artificial, no bloquea nada por saldo
 * negativo (sección 10 del prompt de Etapa 4) -- es una incidencia/evento.
 * Ver docs/ETAPA-4-APP-HELADERIA.md.
 */

const STOCKOUT_IDEMPOTENCY_KEY_TARGET = ['organization_id', 'idempotency_key'] as const;

const stockoutInclude = {
  location: { select: { name: true } },
  product: { select: { name: true } },
  createdBy: { select: { displayName: true } },
} satisfies Prisma.StockoutEventInclude;

type StockoutRow = Prisma.StockoutEventGetPayload<{ include: typeof stockoutInclude }>;

function mapStockout(row: StockoutRow): StockoutEventDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    locationId: row.locationId,
    locationName: row.location.name,
    productId: row.productId,
    productName: row.product.name,
    classification: row.classification,
    occurredAt: row.occurredAt.toISOString(),
    createdById: row.createdById,
    createdByName: row.createdBy.displayName,
  };
}

function computeStockoutFingerprint(input: CreateStockoutEventInput): string {
  return JSON.stringify({ locationId: input.locationId, productId: input.productId });
}

/**
 * Clasificación (RF-019, CONFIRMADO): "reposición urgente posible" si algún
 * depósito de la organización tiene stock del producto; "faltante de
 * abastecimiento" si no. Se calcula leyendo el stock YA EXISTENTE (mismo
 * cálculo de `getStockBalances`, sin ninguna funcionalidad de depósito
 * nueva) -- null si la organización no tiene ninguna ubicación DEPOT
 * configurada, en vez de inventar una clasificación por defecto.
 */
async function classifyStockout(
  fastify: FastifyInstance,
  organizationId: string,
  productId: string,
): Promise<'URGENT_RESTOCK' | 'SUPPLY_SHORTAGE' | null> {
  const depots = await fastify.db.location.findMany({
    where: { organizationId, type: 'DEPOT', active: true },
    select: { id: true },
  });
  if (depots.length === 0) return null;

  const balances = await Promise.all(
    depots.map((depot) =>
      getStockBalances(fastify, organizationId, { locationId: depot.id, productId }),
    ),
  );
  const depotHasStock = balances
    .flat()
    .some((balance) => new Prisma.Decimal(balance.quantity).greaterThan(0));

  return depotHasStock ? 'URGENT_RESTOCK' : 'SUPPLY_SHORTAGE';
}

export async function createStockoutEvent(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  input: CreateStockoutEventInput,
): Promise<StockoutEventDto> {
  const fingerprint = computeStockoutFingerprint(input);

  const existing = await fastify.db.stockoutEvent.findFirst({
    where: { organizationId, idempotencyKey: input.idempotencyKey },
    include: stockoutInclude,
  });
  if (existing) {
    if (existing.idempotencyFingerprint === fingerprint) {
      return mapStockout(existing);
    }
    throw new ConflictError(
      'Esta clave de idempotencia ya se usó para un evento distinto; no puede reutilizarse.',
    );
  }

  await assertLocationForMovement(fastify, organizationId, input.locationId);
  await assertProductForMovement(fastify, organizationId, input.productId);

  const classification = await classifyStockout(fastify, organizationId, input.productId);

  try {
    return await fastify.db.$transaction(async (tx) => {
      const created = await tx.stockoutEvent.create({
        data: {
          organizationId,
          locationId: input.locationId,
          productId: input.productId,
          classification: classification ?? undefined,
          createdById: actor.id,
          idempotencyKey: input.idempotencyKey,
          idempotencyFingerprint: fingerprint,
        },
        include: stockoutInclude,
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'SHOP_STOCKOUT_REPORTED',
        module: 'SHOP_OPS',
        entityType: 'stockout_event',
        entityId: created.id,
        afterValue: mapStockout(created),
      });

      return mapStockout(created);
    });
  } catch (err) {
    if (isUniqueConstraintViolationOn(err, STOCKOUT_IDEMPOTENCY_KEY_TARGET)) {
      const winner = await fastify.db.stockoutEvent.findFirst({
        where: { organizationId, idempotencyKey: input.idempotencyKey },
        include: stockoutInclude,
      });
      if (!winner) {
        fastify.log.error(
          { organizationId, idempotencyKey: input.idempotencyKey },
          'Etapa 4: colisión UNIQUE de idempotencyKey de sin-stock sin fila encontrada al reconsultar',
        );
        throw new ConflictError(
          'No se pudo confirmar el resultado de este evento por una condición de carrera inesperada; reintentá la solicitud.',
        );
      }
      if (winner.idempotencyFingerprint === fingerprint) {
        return mapStockout(winner);
      }
      throw new ConflictError(
        'Esta clave de idempotencia ya se usó para un evento distinto; no puede reutilizarse.',
      );
    }
    throw err;
  }
}

export async function listStockoutEvents(
  fastify: FastifyInstance,
  organizationId: string,
  filters: { locationId?: string },
): Promise<StockoutEventDto[]> {
  const rows = await fastify.db.stockoutEvent.findMany({
    where: {
      organizationId,
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
    },
    include: stockoutInclude,
    orderBy: { occurredAt: 'desc' },
  });
  return rows.map(mapStockout);
}
