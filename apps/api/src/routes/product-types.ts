import type { FastifyInstance } from 'fastify';
import type { ApiSuccess, ProductType } from '@sistema-grido/shared-types';
import { requireRole } from '../plugins/authorize.js';
import { listProductTypes } from '../services/catalog.js';

/**
 * Lectura de tipos de producto (Etapa 2, sección 4: "tipo" confirmado por RF-002).
 * Catálogo técnico sembrado (packages/db/src/seed.ts: HELADO, INSUMO) -- sin API de
 * alta en esta etapa, ver docs/ETAPA-2-CATALOGO-MAESTROS.md, sección "Permisos".
 */
export default async function productTypesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/product-types',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const body: ApiSuccess<ProductType[]> = {
        ok: true,
        data: await listProductTypes(fastify, request.currentUser!.organizationId),
      };
      return body;
    },
  );
}
