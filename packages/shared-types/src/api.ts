/**
 * Convención de respuesta de la API (Etapa 1, sección 11 del prompt: "Definí una
 * convención clara para respuestas API"). Toda respuesta del backend tiene esta forma,
 * nunca un objeto "pelado" — así el frontend puede manejar éxito/error de forma uniforme.
 */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiErrorBody {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    /** Detalle de validación campo por campo, cuando code === 'VALIDATION_ERROR'. */
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorBody;

/**
 * Códigos de error estables que el frontend puede usar para decidir comportamiento
 * (por ejemplo: redirigir a login en UNAUTHENTICATED). No son mensajes de usuario.
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL_ERROR',
  /** La operación es válida pero el backend no tiene la configuración
   * necesaria para completarla (Etapa 4.1) -- ej. una fracción "casi vacía"
   * sin valor confirmado. Distinto de un error inesperado (INTERNAL_ERROR):
   * el mensaje siempre se expone al cliente, incluso en producción. */
  'CONFIGURATION_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
