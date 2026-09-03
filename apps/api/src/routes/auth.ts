import type { FastifyInstance } from 'fastify';
import type { ApiSuccess, UserProfile } from '@sistema-grido/shared-types';
import { toUserProfile } from '../services/users.js';

/**
 * Sesión (sección 8 del prompt de Etapa 1). El login/logout en sí (intercambiar
 * credenciales por un token) lo hace Supabase Auth del lado del frontend
 * (@supabase/supabase-js) -- el backend no maneja contraseñas. Estas dos rutas
 * son el "acuse de recibo" server-side de esos dos eventos: registran auditoría
 * (RN-060) con el usuario real ya resuelto por `fastify.authenticate`, y en el caso
 * de /session, además confirman que la cuenta existe y está activa antes de dejar
 * entrar a la app (si no, `fastify.authenticate` ya cortó con 401/403 antes de llegar acá).
 */
export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/auth/session', { preHandler: [fastify.authenticate] }, async (request) => {
    const user = request.currentUser!;
    await fastify.audit.log({
      organizationId: user.organizationId,
      userId: user.id,
      roleCode: user.roleCode,
      locationId: user.defaultLocationId,
      action: 'LOGIN',
      module: 'AUTH',
      entityType: 'app_user',
      entityId: user.id,
      ipAddress: request.ip,
    });

    const body: ApiSuccess<UserProfile> = { ok: true, data: await toUserProfile(fastify, user.id) };
    return body;
  });

  fastify.post('/api/auth/logout', { preHandler: [fastify.authenticate] }, async (request) => {
    const user = request.currentUser!;
    await fastify.audit.log({
      organizationId: user.organizationId,
      userId: user.id,
      roleCode: user.roleCode,
      locationId: user.defaultLocationId,
      action: 'LOGOUT',
      module: 'AUTH',
      entityType: 'app_user',
      entityId: user.id,
      ipAddress: request.ip,
    });

    const body: ApiSuccess<{ ok: true }> = { ok: true, data: { ok: true } };
    return body;
  });
}
