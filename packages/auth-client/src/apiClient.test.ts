import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApiClient } from './apiClient.js';

/**
 * Cliente fake mínimo: sólo implementa `auth.getSession`, lo único que
 * `apiClient` consume de `SupabaseClient` -- ver createApiClient.
 */
function fakeSupabase(accessToken: string | null): SupabaseClient {
  return {
    auth: {
      getSession: async () => ({
        data: { session: accessToken ? { access_token: accessToken } : null },
      }),
    },
  } as unknown as SupabaseClient;
}

function okResponse(data: unknown = {}) {
  return {
    status: 200,
    json: async () => ({ ok: true, data }),
  } as Response;
}

describe('createApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a) POST sin payload no envía Content-Type: application/json (bug de /api/auth/session)', async () => {
    const api = createApiClient({ baseUrl: 'https://api.test', supabase: fakeSupabase(null) });

    await api.post('/api/auth/session');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('b) POST con payload sí envía Content-Type: application/json y el body serializado', async () => {
    const api = createApiClient({ baseUrl: 'https://api.test', supabase: fakeSupabase(null) });

    await api.post('/ruta', { algo: 'valor' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/ruta');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ algo: 'valor' }));
  });

  it('c) el header Authorization se envía con el access token cuando hay sesión', async () => {
    const api = createApiClient({
      baseUrl: 'https://api.test',
      supabase: fakeSupabase('el-token-de-acceso'),
    });

    await api.post('/api/auth/session');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer el-token-de-acceso' });
  });

  it('no envía Authorization cuando no hay sesión', async () => {
    const api = createApiClient({ baseUrl: 'https://api.test', supabase: fakeSupabase(null) });

    await api.get('/api/inventory/stock');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
  });
});
