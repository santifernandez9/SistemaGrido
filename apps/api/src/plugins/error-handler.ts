import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@sistema-grido/shared-types';
import { AppError, InternalError, NotFoundError, ValidationError } from '../errors.js';

/**
 * Manejo centralizado de errores (sección 15 del prompt de Etapa 1). Toda respuesta
 * de error tiene la misma forma (ApiErrorBody, packages/shared-types#api.ts).
 *
 * En producción nunca se manda el mensaje/stack de un error no controlado -- se
 * loguea completo (fastify ya lo hace via request.log) y al cliente sólo le llega
 * "Error interno". En desarrollo se manda el mensaje real para poder depurar rápido.
 */
export default fp(async (fastify: FastifyInstance) => {
  fastify.setNotFoundHandler((request, reply) => {
    respondWithError(
      reply,
      new NotFoundError(`Ruta no encontrada: ${request.method} ${request.url}`),
    );
  });

  fastify.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      request.log.warn({ err: error, code: error.code }, 'Request finalizado con error de dominio');
      respondWithError(reply, error);
      return;
    }

    if (error instanceof ZodError) {
      const validationError = new ValidationError('Datos de entrada inválidos', error.issues);
      request.log.warn({ err: error }, 'Request rechazado por validación');
      respondWithError(reply, validationError);
      return;
    }

    // Errores de validación del propio Fastify (schema de ruta, si se usa) llegan con statusCode.
    if (
      typeof (error as { statusCode?: number }).statusCode === 'number' &&
      (error as { statusCode: number }).statusCode < 500
    ) {
      const validationError = new ValidationError(error.message);
      respondWithError(reply, validationError);
      return;
    }

    request.log.error({ err: error }, 'Error interno no controlado');
    const safeError = new InternalError(
      fastify.config.isProduction ? 'Error interno' : `Error interno: ${error.message}`,
    );
    respondWithError(reply, safeError);
  });
});

function respondWithError(reply: FastifyReply, error: AppError): void {
  const body: ApiErrorBody = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
  reply.status(error.statusCode).send(body);
}
