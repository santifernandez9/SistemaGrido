import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiSuccess, Category } from '@sistema-grido/shared-types';
import { requireRole } from '../plugins/authorize.js';
import { createCategory, listCategories, updateCategory } from '../services/catalog.js';

const createCategorySchema = z.object({
  name: z.string().min(1, 'Falta el nombre de la categoría'),
  parentCategoryId: z.string().uuid().nullable(),
});

const updateCategorySchema = z
  .object({
    name: z.string().min(1).optional(),
    parentCategoryId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'No se envió ningún campo para actualizar',
  });

/**
 * Categorías/grupos de producto (Etapa 2, sección 5). Sólo ADMIN -- mismo criterio
 * que el resto del catálogo (ver docs/ETAPA-2-CATALOGO-MAESTROS.md, sección
 * "Permisos": todo RF de catálogo en Etapa 0 tiene Actor = Admin).
 */
export default async function categoriesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/categories',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const body: ApiSuccess<Category[]> = {
        ok: true,
        data: await listCategories(fastify, request.currentUser!.organizationId),
      };
      return body;
    },
  );

  fastify.post(
    '/api/categories',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const input = createCategorySchema.parse(request.body);
      const admin = request.currentUser!;

      const created = await createCategory(fastify, admin.organizationId, input);

      await fastify.audit.log({
        organizationId: admin.organizationId,
        userId: admin.id,
        roleCode: admin.roleCode,
        action: 'CATEGORY_CREATED',
        module: 'CATALOG',
        entityType: 'category',
        entityId: created.id,
        afterValue: created,
        ipAddress: request.ip,
      });

      reply.status(201);
      const body: ApiSuccess<Category> = { ok: true, data: created };
      return body;
    },
  );

  fastify.patch(
    '/api/categories/:id',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = updateCategorySchema.parse(request.body);
      const admin = request.currentUser!;

      const { before, after } = await updateCategory(
        fastify,
        admin.organizationId,
        params.id,
        input,
      );

      await fastify.audit.log({
        organizationId: admin.organizationId,
        userId: admin.id,
        roleCode: admin.roleCode,
        action:
          after.active !== before.active
            ? after.active
              ? 'CATEGORY_ACTIVATED'
              : 'CATEGORY_DEACTIVATED'
            : 'CATEGORY_UPDATED',
        module: 'CATALOG',
        entityType: 'category',
        entityId: after.id,
        beforeValue: before,
        afterValue: after,
        ipAddress: request.ip,
      });

      const body: ApiSuccess<Category> = { ok: true, data: after };
      return body;
    },
  );
}
