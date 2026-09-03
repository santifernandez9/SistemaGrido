import type { ApiErrorCode } from '@sistema-grido/shared-types';

/**
 * Errores de dominio/aplicación, tipados. El error handler centralizado (ver
 * plugins/error-handler.ts) los mapea a la convención de respuesta de la API
 * (packages/shared-types#ApiResponse) y al código HTTP correspondiente.
 *
 * Nunca se manda al cliente el stack trace ni el mensaje interno de un error no
 * controlado (sección 15 del prompt de Etapa 1) — sólo estos errores tipados
 * exponen su `message` tal cual; cualquier otra excepción se convierte en un
 * InternalError genérico antes de responder.
 */
export abstract class AppError extends Error {
  abstract readonly code: ApiErrorCode;
  abstract readonly statusCode: number;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR' as const;
  readonly statusCode = 400;
}

export class AuthenticationError extends AppError {
  readonly code = 'UNAUTHENTICATED' as const;
  readonly statusCode = 401;

  constructor(message = 'No autenticado') {
    super(message);
  }
}

export class AuthorizationError extends AppError {
  readonly code = 'UNAUTHORIZED' as const;
  readonly statusCode = 403;

  constructor(message = 'No autorizado') {
    super(message);
  }
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND' as const;
  readonly statusCode = 404;

  constructor(message = 'No encontrado') {
    super(message);
  }
}

export class ConflictError extends AppError {
  readonly code = 'CONFLICT' as const;
  readonly statusCode = 409;
}

export class InternalError extends AppError {
  readonly code = 'INTERNAL_ERROR' as const;
  readonly statusCode = 500;

  constructor(message = 'Error interno') {
    super(message);
  }
}
