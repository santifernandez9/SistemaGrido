import type { FastifyInstance } from 'fastify';
import type { ApiSuccess, UnitOfMeasure } from '@sistema-grido/shared-types';
import { requireRole } from '../plugins/authorize.js';
import { listUnitsOfMeasure } from '../services/catalog.js';

/**
 * Lectura de unidades de manejo (Etapa 2, sección 7: unidad/lata/caja). Catálogo
 * técnico sembrado (packages/db/src/seed.ts) -- sin API de alta en esta etapa, ver
 * docs/ETAPA-2-CATALOGO-MAESTROS.md, sección "Permisos".
 */
export default async function unitsOfMeasureRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/units-of-measure',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const body: ApiSuccess<UnitOfMeasure[]> = {
        ok: true,
        data: await listUnitsOfMeasure(fastify, request.currentUser!.organizationId),
      };
      return body;
    },
  );
}
