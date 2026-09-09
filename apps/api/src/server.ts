import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
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
import categoriesRoutes from './routes/categories.js';
import flavorsRoutes from './routes/flavors.js';
import productTypesRoutes from './routes/product-types.js';
import unitsOfMeasureRoutes from './routes/units-of-measure.js';
import productsRoutes from './routes/products.js';
import inventoryRoutes from './routes/inventory.js';
import shopOpsRoutes from './routes/shop-ops.js';
import attachmentsRoutes from './routes/attachments.js';
import salesImportRoutes from './routes/sales-import.js';
import weeklyClosingRoutes from './routes/weekly-closing.js';

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
    // El default de @fastify/cors es sólo 'GET,HEAD,POST' -- sin esto, cualquier
    // PATCH real desde un navegador (activar/desactivar, editar) queda bloqueado
    // en el preflight con un error de CORS que `app.inject()` nunca reproduce (los
    // tests no pasan por un preflight OPTIONS real). Encontrado al probar la Etapa 2
    // en un navegador real -- ver docs/ETAPA-2-CATALOGO-MAESTROS.md, sección
    // "Seguridad"/"CORS".
    methods: ['GET', 'POST', 'PATCH'],
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
  });

  // Etapa 5: el importador de ventas necesita los bytes del archivo en el
  // backend para parsearlo (node-xlrd sólo lee desde disco, ver
  // sales-import-parser.ts) -- a diferencia de las fotos/comprobantes de
  // Etapa 4, que suben directo a Supabase Storage con una URL firmada.
  // `attachFieldsToBody: true` deja tanto el archivo (`.toBuffer()`/
  // `.filename`) como los campos de texto (`.value`) accesibles en
  // `request.body`, sin acumular streams sin límite -- ver
  // apps/api/src/routes/sales-import.ts.
  await app.register(multipart, {
    attachFieldsToBody: true,
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(usersRoutes);
  await app.register(locationsRoutes);
  await app.register(categoriesRoutes);
  await app.register(flavorsRoutes);
  await app.register(productTypesRoutes);
  await app.register(unitsOfMeasureRoutes);
  await app.register(productsRoutes);
  await app.register(inventoryRoutes);
  await app.register(shopOpsRoutes);
  await app.register(attachmentsRoutes);
  await app.register(salesImportRoutes);
  await app.register(weeklyClosingRoutes);

  return app;
}
