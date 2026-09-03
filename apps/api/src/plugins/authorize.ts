import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RoleCode } from '@sistema-grido/shared-types';
import { AuthenticationError, AuthorizationError } from '../errors.js';

/**
 * Autorización por rol (sección 9 del prompt de Etapa 1). Se usa como preHandler
 * DESPUÉS de `fastify.authenticate` (necesita `request.currentUser` ya resuelto):
 *
 *   fastify.get('/api/users', { preHandler: [fastify.authenticate, requireRole('ADMIN')] }, handler)
 *
 * Sólo expresa roles ya confirmados por el relevamiento (ADMIN, DEPOSIT_MANAGER,
 * SHOP_EMPLOYEE) -- no se inventan permisos de negocio todavía sin definir.
 */
export function requireRole(...roles: RoleCode[]) {
  return async function authorizeByRole(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (!request.currentUser) {
      // No debería pasar si authenticate corrió antes, pero no se asume -- se falla explícito.
      throw new AuthenticationError();
    }
    if (!roles.includes(request.currentUser.roleCode)) {
      throw new AuthorizationError(`Esta acción requiere uno de estos roles: ${roles.join(', ')}`);
    }
  };
}

/**
 * Autorización por ubicación (infraestructura base para etapas futuras -- sección 9:
 * "Implementá una infraestructura que permita posteriormente expresar... acceso por
 * ubicación"). ADMIN siempre pasa (acceso a toda la organización). Para los demás
 * roles, sólo pasa si la ubicación pedida coincide con su `defaultLocationId`.
 *
 * No se usa todavía en ninguna ruta de Etapa 1 (no hay endpoints con datos por
 * ubicación en el Core) -- queda lista para cuando la haya, sin tener que rediseñar
 * el mecanismo de autorización.
 */
export function requireLocationAccess(locationId: string) {
  return async function authorizeByLocation(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (!request.currentUser) {
      throw new AuthenticationError();
    }
    if (request.currentUser.roleCode === 'ADMIN') {
      return;
    }
    if (request.currentUser.defaultLocationId !== locationId) {
      throw new AuthorizationError('No tenés acceso a esta ubicación');
    }
  };
}
