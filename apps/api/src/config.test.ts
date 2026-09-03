import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const validEnv = {
  NODE_ENV: 'test',
  PORT: '4000',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  DIRECT_URL: 'postgresql://u:p@localhost:5432/db',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  CORS_ORIGINS: 'http://localhost:5173, http://localhost:5174',
  LOG_LEVEL: 'warn',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('carga y transforma variables válidas', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(4000);
    expect(config.isProduction).toBe(false);
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'http://localhost:5174']);
    expect(config.supabase.url).toBe('https://project.supabase.co');
  });

  it('aplica NODE_ENV=production correctamente a isProduction', () => {
    const config = loadConfig({ ...validEnv, NODE_ENV: 'production' });
    expect(config.isProduction).toBe(true);
  });

  it.each([
    'DATABASE_URL',
    'DIRECT_URL',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'CORS_ORIGINS',
  ])('rechaza cuando falta %s', (key) => {
    const broken = { ...validEnv } as Record<string, string>;
    delete broken[key];
    expect(() => loadConfig(broken)).toThrow();
  });

  it('rechaza una SUPABASE_URL que no es una URL válida', () => {
    expect(() => loadConfig({ ...validEnv, SUPABASE_URL: 'no-es-una-url' })).toThrow();
  });

  it('nunca incluye SUPABASE_SERVICE_ROLE_KEY en el mensaje de error de otra variable', () => {
    const broken = { ...validEnv, PORT: 'no-es-numero' };
    try {
      loadConfig(broken);
      expect.fail('debería haber lanzado');
    } catch (err) {
      expect(String(err)).not.toContain(validEnv.SUPABASE_SERVICE_ROLE_KEY);
    }
  });
});
