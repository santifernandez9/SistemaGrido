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
 * Timeout por defecto de una request al backend (Render, plan free): el
 * servicio "se duerme" tras inactividad y puede tardar varias decenas de
 * segundos en responder al primer request tras despertar. Sin un límite acá,
 * un `fetch` sin red (o contra un backend caído) puede quedar esperando
 * indefinidamente -- la pantalla que lo llama (ej. ResetPasswordPage) nunca
 * sale de su estado "enviando", sin mostrar ni éxito ni error. 45s cubre
 * cómodamente un cold start típico sin dejar la UI colgada para siempre.
 */
const DEFAULT_TIMEOUT_MS = 45_000;
/** Subida de archivos (Etapa 5): puede tardar más que un request JSON normal. */
const UPLOAD_TIMEOUT_MS = 90_000;

/**
 * Cliente HTTP mínimo compartido por ambos frontends. Adjunta SIEMPRE el token de
 * sesión de Supabase como Bearer -- el backend es quien decide si es válido
 * (sección 8/9 del prompt de Etapa 1: nunca confiar sólo en el frontend).
 */
export function createApiClient({ baseUrl, supabase }: ApiClientOptions) {
  async function request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
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
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ApiClientError(
          'El servidor está tardando demasiado en responder (puede estar iniciándose tras ' +
            'estar inactivo) -- probá de nuevo en un momento.',
          'TIMEOUT',
          0,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

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
      request<T>(path, { method: 'POST', body: formData }, UPLOAD_TIMEOUT_MS),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
