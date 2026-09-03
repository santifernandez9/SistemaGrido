import type { FastifyInstance } from 'fastify';
import type { ApiSuccess } from '@sistema-grido/shared-types';

interface HealthData {
  status: 'ok';
  db: 'ok';
  timestamp: string;
}

/**
 * Healthcheck (sección 23 del prompt de Etapa 1). Público (sin auth): lo consultan
 * balanceadores/monitoreo, no una persona logueada. Confirma que el backend está
 * operativo Y que la conexión mínima necesaria (la base de datos) está disponible --
 * nunca expone secretos ni detalle interno de la conexión.
 */
export default async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', async (_request, reply) => {
    try {
      await fastify.db.$queryRaw`SELECT 1`;
    } catch (err) {
      fastify.log.error({ err }, 'Healthcheck: la base de datos no responde');
      reply.status(503);
      return {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Base de datos no disponible' },
      };
    }

    const body: ApiSuccess<HealthData> = {
      ok: true,
      data: { status: 'ok', db: 'ok', timestamp: new Date().toISOString() },
    };
    return body;
  });
}
