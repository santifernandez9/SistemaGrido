import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { AuditResult, RoleCode } from '@sistema-grido/shared-types';
import type { Prisma } from '@sistema-grido/db';

export interface AuditLogInput {
  organizationId: string;
  userId?: string | null;
  roleCode?: RoleCode | null;
  locationId?: string | null;
  /** Ej: 'LOGIN', 'USER_INVITED'. Texto libre a propósito -- ver prisma/schema.prisma. */
  action: string;
  /** Ej: 'AUTH', 'USERS'. Texto libre a propósito -- los módulos futuros agregan el suyo. */
  module: string;
  entityType?: string | null;
  entityId?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
  reason?: string | null;
  result?: AuditResult;
  errorDetail?: string | null;
  correlationId?: string | null;
  ipAddress?: string | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    audit: {
      log(input: AuditLogInput): Promise<void>;
      logTx(tx: Prisma.TransactionClient, input: AuditLogInput): Promise<void>;
    };
  }
}

function toAuditData(input: AuditLogInput) {
  return {
    organizationId: input.organizationId,
    userId: input.userId ?? null,
    roleCode: input.roleCode ?? null,
    locationId: input.locationId ?? null,
    action: input.action,
    module: input.module,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    beforeValue: toJsonInput(input.beforeValue),
    afterValue: toJsonInput(input.afterValue),
    reason: input.reason ?? null,
    result: input.result ?? 'OK',
    errorDetail: input.errorDetail ?? null,
    correlationId: input.correlationId ?? null,
    ipAddress: input.ipAddress ?? null,
  };
}

/**
 * Infraestructura de auditoría base (sección 10 del prompt de Etapa 1). Reutilizable
 * por cualquier módulo futuro: sólo hace falta llamar `fastify.audit.log(...)`, sin
 * tocar el esquema ni este plugin.
 *
 * `log()` es best-effort: nunca lanza -- un fallo al auditar no debe tumbar una
 * operación no crítica, pero sí queda logueado como error de aplicación (Pino).
 * Etapa 1.1 ya documentó que esto es insuficiente como única garantía para
 * operaciones críticas de inventario (docs/ETAPA-1.1-CORRECCIONES.md).
 *
 * `logTx()` es la garantía transaccional que Etapa 1.1 dejó pendiente y que
 * Etapa 3 activa (sección 18 del prompt: "movimiento + auditoría deben ser
 * consistentes"): recibe el mismo `Prisma.TransactionClient` con el que se
 * escribió la operación de dominio y escribe el `AuditLog` DENTRO de esa
 * misma transacción -- a propósito NO atrapa errores: si falla, debe
 * propagar y hacer rollback de toda la transacción (movimiento incluido),
 * nunca dejar un movimiento aplicado sin su auditoría, ni una auditoría de
 * una operación que en realidad no se aplicó.
 */
export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('audit', {
    async log(input: AuditLogInput): Promise<void> {
      try {
        await fastify.db.auditLog.create({ data: toAuditData(input) });
      } catch (err) {
        fastify.log.error(
          { err, auditInput: input },
          'No se pudo escribir el registro de auditoría',
        );
      }
    },
    async logTx(tx: Prisma.TransactionClient, input: AuditLogInput): Promise<void> {
      await tx.auditLog.create({ data: toAuditData(input) });
    },
  });
});

function toJsonInput(value: unknown) {
  return value === undefined ? undefined : (value as never);
}
