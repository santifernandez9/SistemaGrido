import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
}

interface ConfigPluginOptions {
  config: AppConfig;
}

/** Decora `fastify.config` con la configuración ya validada (ver ../config.ts). */
export default fp<ConfigPluginOptions>(
  async (fastify: FastifyInstance, opts: ConfigPluginOptions) => {
    fastify.decorate('config', opts.config);
  },
);
