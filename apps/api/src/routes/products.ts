import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiSuccess, Product } from '@sistema-grido/shared-types';
import { requireRole } from '../plugins/authorize.js';
import { createProduct, getProduct, listProducts, updateProduct } from '../services/catalog.js';

const createProductSchema = z.object({
  code: z.string().min(1).nullable(),
  name: z.string().min(1, 'Falta el nombre del producto'),
  categoryId: z.string().uuid(),
  productTypeId: z.string().uuid(),
  unitOfMeasureId: z.string().uuid(),
  unitsPerHandlingUnit: z.number().int().positive(),
  flavorId: z.string().uuid().nullable(),
});

const updateProductSchema = z
  .object({
    code: z.string().min(1).nullable().optional(),
    name: z.string().min(1).optional(),
    categoryId: z.string().uuid().optional(),
    productTypeId: z.string().uuid().optional(),
    unitOfMeasureId: z.string().uuid().optional(),
    unitsPerHandlingUnit: z.number().int().positive().optional(),
    flavorId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'No se envió ningún campo para actualizar',
  });

/**
 * Catálogo de productos (RF-001, Etapa 2 sección 4). Sólo ADMIN. Ninguna ruta de
 * este archivo toca stock/inventario -- ver docs/ETAPA-2-CATALOGO-MAESTROS.md,
 * sección "Qué NO se implementó".
 */
export default async function productsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/products',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const body: ApiSuccess<Product[]> = {
        ok: true,
        data: await listProducts(fastify, request.currentUser!.organizationId),
      };
      return body;
    },
  );

  fastify.get(
    '/api/products/:id',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body: ApiSuccess<Product> = {
        ok: true,
        data: await getProduct(fastify, request.currentUser!.organizationId, params.id),
      };
      return body;
    },
  );

  fastify.post(
    '/api/products',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request, reply) => {
      const input = createProductSchema.parse(request.body);
      const admin = request.currentUser!;

      const created = await createProduct(fastify, admin.organizationId, input);

      await fastify.audit.log({
        organizationId: admin.organizationId,
        userId: admin.id,
        roleCode: admin.roleCode,
        action: 'PRODUCT_CREATED',
        module: 'CATALOG',
        entityType: 'product',
        entityId: created.id,
        afterValue: created,
        ipAddress: request.ip,
      });

      reply.status(201);
      const body: ApiSuccess<Product> = { ok: true, data: created };
      return body;
    },
  );

  fastify.patch(
    '/api/products/:id',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = updateProductSchema.parse(request.body);
      const admin = request.currentUser!;

      const { before, after } = await updateProduct(
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
              ? 'PRODUCT_ACTIVATED'
              : 'PRODUCT_DEACTIVATED'
            : 'PRODUCT_UPDATED',
        module: 'CATALOG',
        entityType: 'product',
        entityId: after.id,
        beforeValue: before,
        afterValue: after,
        ipAddress: request.ip,
      });

      const body: ApiSuccess<Product> = { ok: true, data: after };
      return body;
    },
  );
}
