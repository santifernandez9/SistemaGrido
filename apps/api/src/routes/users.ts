import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLE_CODES, type ApiSuccess, type UserProfile } from '@sistema-grido/shared-types';
import { requireRole } from '../plugins/authorize.js';
import { inviteUser, listUsers, updateUser } from '../services/users.js';

const inviteUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1, 'Falta el nombre visible'),
  roleCode: z.enum(ROLE_CODES),
  defaultLocationId: z.string().uuid().nullable(),
});

const updateUserSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    roleCode: z.enum(ROLE_CODES).optional(),
    defaultLocationId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'No se envió ningún campo para actualizar',
  });

/**
 * Gestión de usuarios (sección 7 y 9 del prompt de Etapa 1). Sólo ADMIN -- es la
 * única responsabilidad confirmada por el relevamiento para este módulo (Doc §6.1:
 * "gestionar usuarios y configuración"). No hay auto-registro: el alta siempre la
 * inicia un Admin invitando a la persona.
 */
export default async function usersRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/users',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const body: ApiSuccess<UserProfile[]> = {
        ok: true,
        data: await listUsers(fastify, request.currentUser!.organizationId),
      };
      return body;
    },
  );

  fastify.post(
    '/api/users',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const input = inviteUserSchema.parse(request.body);
      const admin = request.currentUser!;

      const created = await inviteUser(fastify, admin.organizationId, input);

      await fastify.audit.log({
        organizationId: admin.organizationId,
        userId: admin.id,
        roleCode: admin.roleCode,
        action: 'USER_INVITED',
        module: 'USERS',
        entityType: 'app_user',
        entityId: created.id,
        afterValue: created,
        ipAddress: request.ip,
      });

      reply.status(201);
      const body: ApiSuccess<UserProfile> = { ok: true, data: created };
      return body;
    },
  );

  fastify.patch(
    '/api/users/:id',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = updateUserSchema.parse(request.body);
      const admin = request.currentUser!;

      const { before, after } = await updateUser(fastify, admin.organizationId, params.id, input);

      await fastify.audit.log({
        organizationId: admin.organizationId,
        userId: admin.id,
        roleCode: admin.roleCode,
        action:
          after.active !== before.active
            ? after.active
              ? 'USER_REACTIVATED'
              : 'USER_DEACTIVATED'
            : 'USER_UPDATED',
        module: 'USERS',
        entityType: 'app_user',
        entityId: after.id,
        beforeValue: before,
        afterValue: after,
        ipAddress: request.ip,
      });

      const body: ApiSuccess<UserProfile> = { ok: true, data: after };
      return body;
    },
  );
}
