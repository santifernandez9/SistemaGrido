import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  CreateVariableExpenseInput,
  VariableExpense as VariableExpenseDto,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ConflictError, ValidationError } from '../errors.js';
import { assertLocationForMovement } from './inventory-ledger.js';
import { isUniqueConstraintViolationOn } from './idempotency.js';
import { createReadUrl } from './attachments.js';

/**
 * Gasto variable de una heladería (RF-026/RN-033). NO forma parte del
 * ledger de inventario -- entidad y transacción propias (sección 9 del
 * prompt de Etapa 4). Ver docs/ETAPA-4-APP-HELADERIA.md.
 */

const EXPENSE_IDEMPOTENCY_KEY_TARGET = ['organization_id', 'idempotency_key'] as const;

const expenseInclude = {
  location: { select: { name: true } },
  createdBy: { select: { displayName: true } },
} satisfies Prisma.VariableExpenseInclude;

type ExpenseRow = Prisma.VariableExpenseGetPayload<{ include: typeof expenseInclude }>;

async function mapExpense(
  fastify: FastifyInstance,
  row: ExpenseRow,
  withReadUrl: boolean,
): Promise<VariableExpenseDto> {
  const receiptUrl =
    withReadUrl && row.receiptPath ? await createReadUrl(fastify, row.receiptPath) : null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    locationId: row.locationId,
    locationName: row.location.name,
    amount: row.amount.toFixed(2),
    category: row.category,
    description: row.description,
    receiptPath: row.receiptPath,
    receiptUrl,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    createdByName: row.createdBy.displayName,
  };
}

function computeExpenseFingerprint(input: CreateVariableExpenseInput): string {
  return JSON.stringify({
    locationId: input.locationId,
    amount: new Prisma.Decimal(input.amount).toFixed(2),
    category: input.category.trim(),
    description: input.description.trim(),
    receiptPath: input.receiptPath ?? null,
    occurredAt: input.occurredAt ?? null,
  });
}

async function resolveExpenseIdempotency(
  fastify: FastifyInstance,
  organizationId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<VariableExpenseDto | null> {
  const existing = await fastify.db.variableExpense.findFirst({
    where: { organizationId, idempotencyKey },
    include: expenseInclude,
  });
  if (!existing) return null;
  if (existing.idempotencyFingerprint === fingerprint) {
    return mapExpense(fastify, existing, false);
  }
  throw new ConflictError(
    'Esta clave de idempotencia ya se usó para un gasto distinto; no puede reutilizarse.',
  );
}

export async function createVariableExpense(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  input: CreateVariableExpenseInput,
): Promise<VariableExpenseDto> {
  const category = input.category?.trim();
  if (!category) throw new ValidationError('El gasto requiere una categoría');
  const description = input.description?.trim();
  if (!description) throw new ValidationError('El gasto requiere una descripción');

  const amount = new Prisma.Decimal(input.amount);
  if (amount.lte(0)) {
    throw new ValidationError('El monto del gasto debe ser mayor a cero');
  }

  const fingerprint = computeExpenseFingerprint(input);
  const idempotent = await resolveExpenseIdempotency(
    fastify,
    organizationId,
    input.idempotencyKey,
    fingerprint,
  );
  if (idempotent) return idempotent;

  await assertLocationForMovement(fastify, organizationId, input.locationId);

  try {
    return await fastify.db.$transaction(async (tx) => {
      const created = await tx.variableExpense.create({
        data: {
          organizationId,
          locationId: input.locationId,
          amount,
          category,
          description,
          receiptPath: input.receiptPath ?? null,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
          createdById: actor.id,
          idempotencyKey: input.idempotencyKey,
          idempotencyFingerprint: fingerprint,
        },
        include: expenseInclude,
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'SHOP_VARIABLE_EXPENSE_CREATED',
        module: 'SHOP_OPS',
        entityType: 'variable_expense',
        entityId: created.id,
        afterValue: await mapExpense(fastify, created, false),
      });

      return mapExpense(fastify, created, false);
    });
  } catch (err) {
    if (isUniqueConstraintViolationOn(err, EXPENSE_IDEMPOTENCY_KEY_TARGET)) {
      const winner = await fastify.db.variableExpense.findFirst({
        where: { organizationId, idempotencyKey: input.idempotencyKey },
        include: expenseInclude,
      });
      if (!winner) {
        fastify.log.error(
          { organizationId, idempotencyKey: input.idempotencyKey },
          'Etapa 4: colisión UNIQUE de idempotencyKey de gasto sin fila encontrada al reconsultar',
        );
        throw new ConflictError(
          'No se pudo confirmar el resultado de este gasto por una condición de carrera inesperada; reintentá la solicitud.',
        );
      }
      if (winner.idempotencyFingerprint === fingerprint) {
        return mapExpense(fastify, winner, false);
      }
      throw new ConflictError(
        'Esta clave de idempotencia ya se usó para un gasto distinto; no puede reutilizarse.',
      );
    }
    throw err;
  }
}

export async function listVariableExpenses(
  fastify: FastifyInstance,
  organizationId: string,
  filters: { locationId?: string },
): Promise<VariableExpenseDto[]> {
  const rows = await fastify.db.variableExpense.findMany({
    where: {
      organizationId,
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
    },
    include: expenseInclude,
    orderBy: { occurredAt: 'desc' },
  });
  return Promise.all(rows.map((row) => mapExpense(fastify, row, true)));
}
