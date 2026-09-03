import { PrismaClient } from '../generated/prisma/client.js';

export * from '../generated/prisma/client.js';

/**
 * Singleton de PrismaClient para todo el backend (apps/api). Evita abrir múltiples
 * pools de conexión en desarrollo (hot-reload) y centraliza la configuración de logs.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}
