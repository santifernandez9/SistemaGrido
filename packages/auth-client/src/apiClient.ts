import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApiResponse } from '@sistema-grido/shared-types';

/**
 * Error tipado del lado del cliente: conserva el `code` de la API (packages/shared-types)
 * para que el frontend pueda reaccionar (ej. UNAUTHENTICATED -> ir a /login) sin
 * parsear el mensaje de texto.
 */
export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  supabase: SupabaseClient;
}

/**
 * Cliente HTTP mínimo compartido por ambos frontends. Adjunta SIEMPRE el token de
 * sesión de Supabase como Bearer -- el backend es quien decide si es válido
 * (sección 8/9 del prompt de Etapa 1: nunca confiar sólo en el frontend).
 */
export function createApiClient({ baseUrl, supabase }: ApiClientOptions) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        // Sólo se declara JSON cuando realmente hay body Y no es un
        // `FormData` (Etapa 5: subida de archivos vía `postFormData`) -- un
        // POST sin payload (ej. `api.post('/api/auth/session')`) no debe
        // mandar `Content-Type: application/json` con el body vacío
        // (Fastify lo interpreta como "viene un JSON" y responde 400 antes
        // de ejecutar la ruta), y un `FormData` necesita que el browser
        // calcule su propio Content-Type con el boundary -- forzarlo acá lo
        // rompería.
        ...(init.body !== undefined && !(init.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });

    const body = (await response.json()) as ApiResponse<T>;

    if (!body.ok) {
      throw new ApiClientError(
        body.error.message,
        body.error.code,
        response.status,
        body.error.details,
      );
    }
    return body.data;
  }

  return {
    get: <T>(path: string) => request<T>(path, { method: 'GET' }),
    post: <T>(path: string, payload?: unknown) =>
      request<T>(path, {
        method: 'POST',
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      }),
    patch: <T>(path: string, payload?: unknown) =>
      request<T>(path, {
        method: 'PATCH',
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      }),
    /**
     * Subida de archivos (Etapa 5: importador de ventas). A diferencia de
     * `post`, NUNCA fuerza `Content-Type: application/json` -- el browser
     * calcula el boundary de `multipart/form-data` solo a partir del
     * `FormData`, y forzar un Content-Type manual acá lo rompería.
     */
    postFormData: <T>(path: string, formData: FormData) =>
      request<T>(path, { method: 'POST', body: formData }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
