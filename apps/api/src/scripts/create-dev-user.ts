import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { prisma } from '@sistema-grido/db';
import { ROLE_CODES, isRoleCode, type RoleCode } from '@sistema-grido/shared-types';
import { loadConfig } from '../config.js';

/**
 * Script de DESARROLLO (nunca correr contra un proyecto de Supabase de
 * producción): crea un usuario con contraseña FIJA directamente, sin pasar
 * por el flujo real de invitación (`inviteUser`, `POST /api/users`) --
 * ese flujo nunca fija una contraseña, siempre manda un email para que la
 * propia persona la elija (ver docs/ETAPA-1-BASE-CORE.md y
 * `apps/api/src/services/users.ts`). Este script existe sólo para no
 * depender de un email real al armar un entorno local -- la Admin API de
 * Supabase (`auth.admin.createUser`) permite setear la contraseña y marcar
 * el email ya confirmado, cosa que la app en sí nunca hace ni expone.
 *
 * Requiere las mismas variables que `apps/api` (.env real, no el .example):
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL/DIRECT_URL. Si no
 * existe todavía ninguna organización (`npm run seed --workspace packages/db`
 * no se corrió), falla con un mensaje claro en vez de inventar una.
 *
 * Uso:
 *   npm run create-dev-user --workspace apps/api -- \
 *     --email admin@dev.local --password "Alguna1234!" \
 *     --name "Admin Dev" --role ADMIN
 *
 * Flags: --email (obligatorio), --password (obligatorio, mínimo 8
 * caracteres -- mínimo exigido por Supabase Auth), --name (obligatorio),
 * --role (ADMIN|DEPOSIT_MANAGER|SHOP_EMPLOYEE, default ADMIN),
 * --location <id> (opcional, debe pertenecer a la misma organización).
 */

interface Args {
  email: string;
  password: string;
  name: string;
  role: RoleCode;
  locationId: string | null;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Falta el valor de --${key}`);
    }
    flags.set(key, value);
    i++;
  }

  const email = flags.get('email');
  const password = flags.get('password');
  const name = flags.get('name');
  if (!email) throw new Error('Falta --email');
  if (!password || password.length < 8) {
    throw new Error('Falta --password (mínimo 8 caracteres, exigido por Supabase Auth)');
  }
  if (!name) throw new Error('Falta --name');

  const role = flags.get('role') ?? 'ADMIN';
  if (!isRoleCode(role)) {
    throw new Error(`--role inválido: "${role}". Válidos: ${ROLE_CODES.join(', ')}`);
  }

  return { email, password, name, role, locationId: flags.get('location') ?? null };
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'create-dev-user nunca se corre con NODE_ENV=production -- es exclusivamente para ' +
        'armar un entorno local/de desarrollo. Usá el flujo real de invitación en producción.',
    );
  }

  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  const organization = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!organization) {
    throw new Error(
      'No hay ninguna organización en la base -- corré primero ' +
        '`npm run seed --workspace packages/db`.',
    );
  }

  const role = await prisma.role.findUnique({ where: { code: args.role } });
  if (!role) {
    throw new Error(
      `No existe el rol ${args.role} en la base -- corré primero ` +
        '`npm run seed --workspace packages/db`.',
    );
  }

  if (args.locationId) {
    const location = await prisma.location.findFirst({
      where: { id: args.locationId, organizationId: organization.id },
    });
    if (!location) {
      throw new Error('--location no existe en esta organización');
    }
  }

  const existing = await prisma.appUser.findUnique({ where: { email: args.email } });
  if (existing) {
    throw new Error(`Ya existe un app_user con el email ${args.email} (id: ${existing.id})`);
  }

  const admin = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // `email_confirm: true` evita depender de que el email de confirmación de
  // Supabase realmente llegue (SMTP sin configurar en local) -- el usuario
  // queda directamente habilitado para loguearse con la contraseña dada.
  const { data, error } = await admin.auth.admin.createUser({
    email: args.email,
    password: args.password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(
      `No se pudo crear el usuario en Supabase Auth: ${error?.message ?? 'error desconocido'}`,
    );
  }
  const createdAuthUserId = data.user.id;

  try {
    const created = await prisma.appUser.create({
      data: {
        organizationId: organization.id,
        roleId: role.id,
        defaultLocationId: args.locationId,
        displayName: args.name,
        email: args.email,
        authSubject: createdAuthUserId,
      },
    });
    console.log('Usuario de desarrollo creado:');
    console.log(`  email:    ${args.email}`);
    console.log(`  password: ${args.password}`);
    console.log(`  rol:      ${args.role}`);
    console.log(`  app_user: ${created.id}`);
    console.log(`  org:      ${organization.name} (${organization.id})`);
  } catch (dbError) {
    // Mismo criterio que `inviteUser` (Corrección 2, Etapa 1.1): si falla la
    // persistencia del app_user después de crear la cuenta en Auth, esa
    // cuenta queda huérfana salvo que se compense acá.
    const { error: deleteError } = await admin.auth.admin.deleteUser(createdAuthUserId);
    if (deleteError) {
      console.error(
        `Falló la creación de app_user y también la compensación en Supabase Auth ` +
          `(usuario huérfano, id ${createdAuthUserId}): ${deleteError.message}`,
      );
    }
    throw dbError;
  }
}

main()
  .catch((err) => {
    console.error('create-dev-user falló:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
