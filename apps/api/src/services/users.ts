import type { FastifyInstance } from 'fastify';
import type { InviteUserInput, UpdateUserInput, UserProfile } from '@sistema-grido/shared-types';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

/**
 * Regla compartida por inviteUser() y updateUser() (Corrección 1.1, Etapa 1.1): una
 * ubicación sólo puede asociarse a un usuario si pertenece a la MISMA organización de
 * ese usuario. Nunca se confía en el rol del usuario, en datos previos ni en que el
 * UUID recibido ya sea válido -- se revalida contra la base en cada alta/edición.
 */
async function assertLocationBelongsToOrganization(
  fastify: FastifyInstance,
  organizationId: string,
  locationId: string,
): Promise<void> {
  const location = await fastify.db.location.findFirst({
    where: { id: locationId, organizationId },
  });
  if (!location) {
    throw new ValidationError('La ubicación indicada no existe en esta organización');
  }
}

/** Carga un app_user por id y lo convierte al DTO público (packages/shared-types#UserProfile). */
export async function toUserProfile(
  fastify: FastifyInstance,
  userId: string,
): Promise<UserProfile> {
  const user = await fastify.db.appUser.findUniqueOrThrow({
    where: { id: userId },
    include: { role: true },
  });
  return mapToProfile(user);
}

function mapToProfile(user: {
  id: string;
  organizationId: string;
  role: { code: UserProfile['roleCode'] };
  defaultLocationId: string | null;
  displayName: string;
  email: string;
  active: boolean;
  createdAt: Date;
}): UserProfile {
  return {
    id: user.id,
    organizationId: user.organizationId,
    roleCode: user.role.code,
    defaultLocationId: user.defaultLocationId,
    displayName: user.displayName,
    email: user.email,
    active: user.active,
    createdAt: user.createdAt.toISOString(),
  };
}

export async function listUsers(
  fastify: FastifyInstance,
  organizationId: string,
): Promise<UserProfile[]> {
  const users = await fastify.db.appUser.findMany({
    where: { organizationId },
    include: { role: true },
    orderBy: { createdAt: 'asc' },
  });
  return users.map(mapToProfile);
}

/**
 * Invita a una persona nueva: crea su cuenta en Supabase Auth (Admin API, le llega
 * un email para poner su propia contraseña) y su fila `app_user` en la misma
 * organización. Es la única forma de crear un usuario -- no hay auto-registro
 * (coherente con P-001 resuelta: identidad individual, dada de alta por el Admin).
 */
export async function inviteUser(
  fastify: FastifyInstance,
  organizationId: string,
  input: InviteUserInput,
): Promise<UserProfile> {
  const role = await fastify.db.role.findUnique({ where: { code: input.roleCode } });
  if (!role) {
    throw new ValidationError(`Rol desconocido: ${input.roleCode}`);
  }

  if (input.defaultLocationId) {
    await assertLocationBelongsToOrganization(fastify, organizationId, input.defaultLocationId);
  }

  const existing = await fastify.db.appUser.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new ConflictError(`Ya existe un usuario con el email ${input.email}`);
  }

  const { data, error } = await fastify.supabase.admin.auth.admin.inviteUserByEmail(input.email);
  if (error || !data.user) {
    // Supabase no llegó a crear nada nuevo (p. ej. el email ya tiene una cuenta de Auth
    // ajena a este alta) -- no hay nada que compensar, sólo se propaga el error.
    throw new ConflictError(
      `No se pudo invitar a ${input.email} en Supabase Auth: ${error?.message ?? 'error desconocido'}`,
    );
  }

  // Se conserva explícitamente el id que Supabase devolvió PARA ESTA llamada: es el
  // único usuario de Auth que la compensación de abajo puede llegar a eliminar. Nunca
  // se compensa en base a un email o a una búsqueda posterior -- sólo este id exacto.
  const createdAuthUserId = data.user.id;

  try {
    const created = await fastify.db.appUser.create({
      data: {
        organizationId,
        roleId: role.id,
        defaultLocationId: input.defaultLocationId,
        displayName: input.displayName,
        email: input.email,
        authSubject: createdAuthUserId,
      },
      include: { role: true },
    });

    return mapToProfile(created);
  } catch (dbError) {
    // Corrección 2 (Etapa 1.1): Supabase Auth y PostgreSQL no comparten una transacción
    // distribuida. Si la persistencia de app_user falla después de haber creado la cuenta
    // en Auth, esa cuenta queda huérfana (sin app_user) salvo que se compense acá.
    await compensateOrphanedAuthUser(fastify, {
      authUserId: createdAuthUserId,
      email: input.email,
      organizationId,
      dbError,
    });
    // El error original de persistencia nunca se oculta ni se reemplaza por el resultado
    // de la compensación: sea cual sea ese resultado, esta operación nunca devuelve éxito.
    throw dbError;
  }
}

interface CompensateOrphanedAuthUserInput {
  authUserId: string;
  email: string;
  organizationId: string;
  dbError: unknown;
}

/**
 * Intenta revertir el usuario de Supabase Auth creado por ESTA invitación cuando la
 * persistencia de `app_user` falló. Nunca lanza: un fallo acá no debe reemplazar el
 * error original de persistencia (ver catch de arriba, que siempre relanza `dbError`).
 * Si la propia compensación falla, queda un usuario de Auth huérfano -- se loguea con
 * el contexto completo (organización, email, id de Auth, ambos errores) para que se
 * pueda resolver a mano; nunca se silencia ni se reintenta automáticamente acá.
 */
async function compensateOrphanedAuthUser(
  fastify: FastifyInstance,
  { authUserId, email, organizationId, dbError }: CompensateOrphanedAuthUserInput,
): Promise<void> {
  try {
    const { error: deleteError } = await fastify.supabase.admin.auth.admin.deleteUser(authUserId);
    if (deleteError) {
      fastify.log.error(
        { authUserId, email, organizationId, dbError, compensationError: deleteError.message },
        'Falló la creación de app_user y también la compensación en Supabase Auth: ' +
          'queda un usuario huérfano en Auth. Requiere intervención manual.',
      );
      return;
    }
    fastify.log.warn(
      { authUserId, email, organizationId, dbError },
      'Falló la creación de app_user tras crear el usuario en Supabase Auth; se compensó ' +
        'eliminando ese usuario de Auth.',
    );
  } catch (compensationError) {
    fastify.log.error(
      { authUserId, email, organizationId, dbError, compensationError },
      'Falló la creación de app_user y la llamada de compensación a Supabase Auth lanzó ' +
        'una excepción: queda un usuario huérfano en Auth. Requiere intervención manual.',
    );
  }
}

export async function updateUser(
  fastify: FastifyInstance,
  organizationId: string,
  userId: string,
  input: UpdateUserInput,
): Promise<{ before: UserProfile; after: UserProfile }> {
  const existing = await fastify.db.appUser.findFirst({
    where: { id: userId, organizationId },
    include: { role: true },
  });
  if (!existing) {
    throw new NotFoundError('Usuario no encontrado en esta organización');
  }
  const before = mapToProfile(existing);

  let roleId: string | undefined;
  if (input.roleCode) {
    const role = await fastify.db.role.findUnique({ where: { code: input.roleCode } });
    if (!role) {
      throw new ValidationError(`Rol desconocido: ${input.roleCode}`);
    }
    roleId = role.id;
  }

  // `null` explícito (quitar la ubicación por defecto) sigue permitido tal cual estaba
  // -- sólo se valida cuando se manda un id concreto.
  if (input.defaultLocationId !== undefined && input.defaultLocationId !== null) {
    await assertLocationBelongsToOrganization(fastify, organizationId, input.defaultLocationId);
  }

  const updated = await fastify.db.appUser.update({
    where: { id: userId },
    data: {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(roleId !== undefined ? { roleId } : {}),
      ...(input.defaultLocationId !== undefined
        ? { defaultLocationId: input.defaultLocationId }
        : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
    include: { role: true },
  });

  return { before, after: mapToProfile(updated) };
}
