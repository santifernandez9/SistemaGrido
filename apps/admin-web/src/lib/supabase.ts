import { createSupabaseClient } from '@sistema-grido/auth-client';

function requireEnv(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(
      `Falta la variable de entorno ${name}. Copiá apps/admin-web/.env.example a .env y completá los valores reales.`,
    );
  }
  return value;
}

export const supabase = createSupabaseClient(
  requireEnv('VITE_SUPABASE_URL'),
  requireEnv('VITE_SUPABASE_ANON_KEY'),
);

export const apiBaseUrl = requireEnv('VITE_API_URL');
