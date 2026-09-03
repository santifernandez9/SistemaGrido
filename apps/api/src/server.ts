import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { loadConfig, type AppConfig } from './config.js';
import { buildLoggerOptions } from './logger.js';
import configPlugin from './plugins/config.js';
import supabasePlugin from './plugins/supabase.js';
import prismaPlugin from './plugins/prisma.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import auditPlugin from './plugins/audit.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import usersRoutes from './routes/users.js';
import locationsRoutes from './routes/locations.js';

/**
 * Arma la app de Fastify sin escucharla en un puerto -- así `src/index.ts` la usa
 * para levantar el servidor real, y los tests la usan con `app.inject()` sin abrir
 * un socket. `overrides` permite a los tests pasar una config distinta (ej. apuntar
 * a una base de datos de test) sin tocar variables de entorno globales.
 */
export async function buildServer(overrides?: Partial<AppConfig>): Promise<FastifyInstance> {
  const config: AppConfig = { ...loadConfig(), ...overrides };

  const app = Fastify({
    logger: buildLoggerOptions(config),
    trustProxy: true, // Render/Vercel están detrás de un proxy -- request.ip debe ser el real.
  });

  await app.register(configPlugin, { config });
  await app.register(supabasePlugin, { config });
  await app.register(prismaPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(auditPlugin);
  await app.register(authPlugin);

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(usersRoutes);
  await app.register(locationsRoutes);

  return app;
}
