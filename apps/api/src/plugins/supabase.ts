import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    supabase: {
      /** Cliente con anon key: se usa sólo para validar el JWT de una request (auth.getUser). */
      auth: SupabaseClient;
      /**
       * Cliente con service role key: SOLO para la Admin API de Supabase Auth (invitar/
       * desactivar personas). Nunca se usa para leer/escribir datos de negocio -- eso
       * siempre pasa por Prisma, con las reglas de autorización de esta API.
       */
      admin: SupabaseClient;
    };
  }
}

interface SupabasePluginOptions {
  config: AppConfig;
}

/**
 * Decora `fastify.supabase` con dos clientes distintos a propósito (principio de
 * mínimo privilegio): uno para verificar identidad, otro -- con mucho más poder --
 * sólo para las operaciones administrativas de alta/baja de usuarios (sección 7 del
 * prompt de Etapa 1: "Implementá el modelo de identidad individual").
 */
export default fp<SupabasePluginOptions>(
  async (fastify: FastifyInstance, opts: SupabasePluginOptions) => {
    const { config } = opts;
    const auth = createClient(config.supabase.url, config.supabase.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const admin = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    fastify.decorate('supabase', { auth, admin });
  },
);
