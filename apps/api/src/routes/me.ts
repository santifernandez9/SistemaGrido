import type { FastifyInstance } from 'fastify';
import type { ApiSuccess, UserProfile } from '@sistema-grido/shared-types';
import { toUserProfile } from '../services/users.js';

/**
 * Perfil del usuario autenticado. De sólo lectura (sin efecto de auditoría, a
 * diferencia de POST /api/auth/session): la usan las rutas protegidas del frontend
 * para confirmar "sigo logueado y activo" (por ejemplo al refrescar la página).
 */
export default async function meRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/me', { preHandler: [fastify.authenticate] }, async (request) => {
    const body: ApiSuccess<UserProfile> = {
      ok: true,
      data: await toUserProfile(fastify, request.currentUser!.id),
    };
    return body;
  });
}
