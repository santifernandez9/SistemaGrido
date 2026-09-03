import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { AuditResult, RoleCode } from '@sistema-grido/shared-types';

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
    };
  }
}

/**
 * Infraestructura de auditoría base (sección 10 del prompt de Etapa 1). Reutilizable
 * por cualquier módulo futuro: sólo hace falta llamar `fastify.audit.log(...)`, sin
 * tocar el esquema ni este plugin. Nunca lanza -- un fallo al auditar no debe tumbar
 * la operación de negocio que se estaba auditando, pero sí queda logueado como error
 * de aplicación (Pino) para poder detectarlo.
 */
export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('audit', {
    async log(input: AuditLogInput): Promise<void> {
      try {
        await fastify.db.auditLog.create({
          data: {
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
          },
        });
      } catch (err) {
        fastify.log.error(
          { err, auditInput: input },
          'No se pudo escribir el registro de auditoría',
        );
      }
    },
  });
});

function toJsonInput(value: unknown) {
  return value === undefined ? undefined : (value as never);
}
