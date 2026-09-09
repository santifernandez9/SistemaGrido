import { z } from 'zod';

/**
 * Validación de variables de entorno al iniciar (sección 4 y 20 del prompt de
 * Etapa 1). Si falta o es inválida una variable requerida, el proceso no arranca
 * y lo dice con claridad — mejor fallar rápido al boot que a mitad de un request.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),
  DIRECT_URL: z.string().min(1, 'DIRECT_URL es obligatoria'),

  SUPABASE_URL: z.string().url('SUPABASE_URL debe ser una URL válida'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY es obligatoria'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY es obligatoria'),

  CORS_ORIGINS: z.string().min(1, 'CORS_ORIGINS es obligatoria (lista separada por comas)'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /// Bucket privado de Supabase Storage donde viven las fotos de merma y los
  /// comprobantes de gasto variable (Etapa 4, sección 8/9 del prompt: "no
  /// guardarse como base64 en la base de datos"). Con default para no
  /// romper entornos ya desplegados que todavía no lo declaran -- ver
  /// docs/ETAPA-4-APP-HELADERIA.md, sección "Storage".
  SHOP_ATTACHMENTS_BUCKET: z.string().min(1).default('shop-attachments'),

  /// Etapa 4, sección 5 del prompt ("Reconteo inteligente"): umbrales de
  /// diferencia que disparan un reconteo, DISTINTOS para producto cerrado y
  /// para helado a granel. Deliberadamente sin `.default(...)`: el propio
  /// prompt prohíbe inventar un valor (P-002, docs/ETAPA-0-ANALISIS-ARQUITECTURA.md,
  /// sección 22 -- "no se propone ningún valor por defecto"). Sin configurar,
  /// el reconteo automático queda deshabilitado (nunca se marca needsRecount)
  /// en vez de asumir un número no confirmado -- ver
  /// docs/ETAPA-4-APP-HELADERIA.md, "Reconteo inteligente".
  RECOUNT_THRESHOLD_CLOSED_PRODUCTS: z.coerce.number().positive().optional(),
  RECOUNT_THRESHOLD_BULK_FLAVOR: z.coerce.number().positive().optional(),

  /// Fracción numérica que representa "casi vacía" al convertir el conteo
  /// estimado de una lata abierta a cantidad canónica (las otras cuatro
  /// fracciones -- llena/3/4/1/2/1/4 -- son literales, no una decisión de
  /// negocio). "Casi vacía" no tiene un valor literal: 0.10 es un supuesto
  /// documentado, configurable, pendiente de confirmación del cliente -- ver
  /// docs/ETAPA-4-APP-HELADERIA.md, "Supuestos".
  BULK_FLAVOR_NEARLY_EMPTY_FRACTION: z.coerce.number().min(0).max(1).default(0.1),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Configuración de entorno inválida. Revisá apps/api/.env (copiado de .env.example):\n${details}`,
    );
  }

  const data = parsed.data;
  return {
    nodeEnv: data.NODE_ENV,
    isProduction: data.NODE_ENV === 'production',
    port: data.PORT,
    database: {
      url: data.DATABASE_URL,
      directUrl: data.DIRECT_URL,
    },
    supabase: {
      url: data.SUPABASE_URL,
      anonKey: data.SUPABASE_ANON_KEY,
      serviceRoleKey: data.SUPABASE_SERVICE_ROLE_KEY,
    },
    corsOrigins: data.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    logLevel: data.LOG_LEVEL,
    shopOps: {
      attachmentsBucket: data.SHOP_ATTACHMENTS_BUCKET,
      recountThresholdClosedProducts: data.RECOUNT_THRESHOLD_CLOSED_PRODUCTS,
      recountThresholdBulkFlavor: data.RECOUNT_THRESHOLD_BULK_FLAVOR,
      bulkFlavorNearlyEmptyFraction: data.BULK_FLAVOR_NEARLY_EMPTY_FRACTION,
    },
  };
}
