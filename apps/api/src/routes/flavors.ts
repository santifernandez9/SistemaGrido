import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiSuccess, Flavor } from '@sistema-grido/shared-types';
import { requireRole } from '../plugins/authorize.js';
import { createFlavor, listFlavors, updateFlavor } from '../services/catalog.js';

const createFlavorSchema = z.object({
  name: z.string().min(1, 'Falta el nombre del sabor'),
});

const updateFlavorSchema = z
  .object({
    name: z.string().min(1).optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'No se envió ningún campo para actualizar',
  });

/**
 * Sabores de helado (RF-003/RN-003, Etapa 2 sección 6). Sólo ADMIN. No implementa
 * todavía consumo por sabor ni movimientos -- eso es motor de inventario.
 */
export default async function flavorsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/flavors',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const body: ApiSuccess<Flavor[]> = {
        ok: true,
        data: await listFlavors(fastify, request.currentUser!.organizationId),
      };
      return body;
    },
  );

  fastify.post(
    '/api/flavors',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const input = createFlavorSchema.parse(request.body);
      const admin = request.currentUser!;

      const created = await createFlavor(fastify, admin.organizationId, input);

      await fastify.audit.log({
        organizationId: admin.organizationId,
        userId: admin.id,
        roleCode: admin.roleCode,
        action: 'FLAVOR_CREATED',
        module: 'CATALOG',
        entityType: 'flavor',
        entityId: created.id,
        afterValue: created,
        ipAddress: request.ip,
      });

      reply.status(201);
      const body: ApiSuccess<Flavor> = { ok: true, data: created };
      return body;
    },
  );

  fastify.patch(
    '/api/flavors/:id',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = updateFlavorSchema.parse(request.body);
      const admin = request.currentUser!;

      const { before, after } = await updateFlavor(fastify, admin.organizationId, params.id, input);

      await fastify.audit.log({
        organizationId: admin.organizationId,
        userId: admin.id,
        roleCode: admin.roleCode,
        action:
          after.active !== before.active
            ? after.active
              ? 'FLAVOR_ACTIVATED'
              : 'FLAVOR_DEACTIVATED'
            : 'FLAVOR_UPDATED',
        module: 'CATALOG',
        entityType: 'flavor',
        entityId: after.id,
        beforeValue: before,
        afterValue: after,
        ipAddress: request.ip,
      });

      const body: ApiSuccess<Flavor> = { ok: true, data: after };
      return body;
    },
  );
}
