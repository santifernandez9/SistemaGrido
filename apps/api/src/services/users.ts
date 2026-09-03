import type { FastifyInstance } from 'fastify';
import type { InviteUserInput, UpdateUserInput, UserProfile } from '@sistema-grido/shared-types';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

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
    const location = await fastify.db.location.findFirst({
      where: { id: input.defaultLocationId, organizationId },
    });
    if (!location) {
      throw new ValidationError('La ubicación indicada no existe en esta organización');
    }
  }

  const existing = await fastify.db.appUser.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new ConflictError(`Ya existe un usuario con el email ${input.email}`);
  }

  const { data, error } = await fastify.supabase.admin.auth.admin.inviteUserByEmail(input.email);
  if (error || !data.user) {
    throw new ConflictError(
      `No se pudo invitar a ${input.email} en Supabase Auth: ${error?.message ?? 'error desconocido'}`,
    );
  }

  const created = await fastify.db.appUser.create({
    data: {
      organizationId,
      roleId: role.id,
      defaultLocationId: input.defaultLocationId,
      displayName: input.displayName,
      email: input.email,
      authSubject: data.user.id,
    },
    include: { role: true },
  });

  return mapToProfile(created);
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
