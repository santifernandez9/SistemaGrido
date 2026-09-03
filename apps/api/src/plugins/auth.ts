import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RoleCode } from '@sistema-grido/shared-types';
import { AuthenticationError, AuthorizationError } from '../errors.js';

export interface CurrentUser {
  id: string;
  organizationId: string;
  roleCode: RoleCode;
  defaultLocationId: string | null;
  displayName: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: CurrentUser;
  }
}

/**
 * Autenticación (sección 8 del prompt de Etapa 1): el backend SIEMPRE valida el
 * token recibido -- nunca confía en que el frontend ya "controló" la sesión.
 *
 * Estrategia elegida (decisión técnica documentada en docs/ETAPA-1-BASE-CORE.md,
 * sección "Autenticación"): en vez de verificar la firma del JWT de Supabase a mano
 * (requiere saber de antemano el algoritmo/clave del proyecto, HS256 vs RS256 según
 * la configuración de cada proyecto Supabase), se usa `supabase.auth.getUser(jwt)`,
 * el método oficial de la Admin SDK, que valida el token contra Supabase y devuelve
 * el usuario. Es la forma soportada explícitamente por Supabase y evita depender de
 * un detalle criptográfico que puede cambiar por proyecto.
 *
 * `fastify.authenticate` es un preHandler reutilizable: cualquier ruta que necesite
 * "esto requiere estar logueado" lo agrega a `preHandler`. Deja `request.currentUser`
 * con el perfil ya resuelto (organización, rol, ubicación) para que el resto del
 * handler y la autorización (plugins/authorize.ts) no vuelvan a tocar Supabase.
 */
export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AuthenticationError('Falta el header Authorization: Bearer <token>');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new AuthenticationError('Token vacío');
    }

    const { data, error } = await fastify.supabase.auth.auth.getUser(token);
    if (error || !data.user) {
      throw new AuthenticationError('Token inválido o expirado');
    }

    const appUser = await fastify.db.appUser.findUnique({
      where: { authSubject: data.user.id },
      include: { role: true },
    });

    if (!appUser) {
      throw new AuthenticationError(
        'Tu cuenta de Supabase es válida pero todavía no tiene un usuario creado en el sistema. Pedile a un Admin que te invite.',
      );
    }
    if (!appUser.active) {
      throw new AuthorizationError('Tu usuario está desactivado. Contactá a un Admin.');
    }

    request.currentUser = {
      id: appUser.id,
      organizationId: appUser.organizationId,
      roleCode: appUser.role.code,
      defaultLocationId: appUser.defaultLocationId,
      displayName: appUser.displayName,
      email: appUser.email,
    };
  });
});
