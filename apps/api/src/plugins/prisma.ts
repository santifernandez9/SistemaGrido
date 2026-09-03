import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { prisma, type PrismaClient } from '@sistema-grido/db';

declare module 'fastify' {
  interface FastifyInstance {
    db: PrismaClient;
  }
}

/**
 * Decora `fastify.db` con el cliente Prisma (packages/db). Registra un hook de
 * cierre para desconectar el pool de conexiones de forma prolija al apagar el
 * servidor (Fastify onClose), en vez de dejarlo colgado.
 */
export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('db', prisma);

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
});
