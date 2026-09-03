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
  };
}
