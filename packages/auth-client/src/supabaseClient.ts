import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * El valor de `url`/`anonKey` lo resuelve cada app desde sus propias env vars de
 * Vite (`import.meta.env.VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`) -- este
 * paquete se mantiene agnóstico de Vite a propósito, para no acoplar el cliente
 * de Supabase a un bundler específico.
 */
export function createSupabaseClient(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}
