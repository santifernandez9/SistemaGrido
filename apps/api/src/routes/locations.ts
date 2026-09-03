import type { FastifyInstance } from 'fastify';
import type { ApiSuccess, LocationSummary } from '@sistema-grido/shared-types';
import { requireRole } from '../plugins/authorize.js';

/**
 * Lectura de ubicaciones (sección 5 del prompt de Etapa 1: entidad estructural del
 * Core). Sólo lectura -- el alta/edición de ubicaciones no está pedida para esta
 * etapa; la organización arranca con las ubicaciones del seed de desarrollo
 * (packages/db/src/seed.ts). Sólo ADMIN la necesita hoy (para asignar ubicación al
 * invitar un usuario), así que se restringe igual que /api/users.
 */
export default async function locationsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/locations',
    { preHandler: [fastify.authenticate, requireRole('ADMIN')] },
    async (request) => {
      const locations = await fastify.db.location.findMany({
        where: { organizationId: request.currentUser!.organizationId, active: true },
        orderBy: { name: 'asc' },
      });

      const body: ApiSuccess<LocationSummary[]> = {
        ok: true,
        data: locations.map((location) => ({
          id: location.id,
          name: location.name,
          type: location.type,
          active: location.active,
        })),
      };
      return body;
    },
  );
}
