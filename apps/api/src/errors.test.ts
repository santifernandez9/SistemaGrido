import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
  InternalError,
} from './errors.js';

describe('errores de dominio', () => {
  it.each([
    [new ValidationError('mal'), 'VALIDATION_ERROR', 400],
    [new AuthenticationError(), 'UNAUTHENTICATED', 401],
    [new AuthorizationError(), 'UNAUTHORIZED', 403],
    [new NotFoundError(), 'NOT_FOUND', 404],
    [new ConflictError('dup'), 'CONFLICT', 409],
    [new InternalError(), 'INTERNAL_ERROR', 500],
  ] as const)('%# mapea code y statusCode correctamente', (error, code, statusCode) => {
    expect(error.code).toBe(code);
    expect(error.statusCode).toBe(statusCode);
    expect(error).toBeInstanceOf(Error);
  });

  it('conserva el detalle de validación cuando se provee', () => {
    const error = new ValidationError('inválido', [{ field: 'email' }]);
    expect(error.details).toEqual([{ field: 'email' }]);
  });

  it('usa mensajes por defecto razonables cuando no se especifica uno', () => {
    expect(new AuthenticationError().message).toBe('No autenticado');
    expect(new AuthorizationError().message).toBe('No autorizado');
    expect(new NotFoundError().message).toBe('No encontrado');
    expect(new InternalError().message).toBe('Error interno');
  });
});
