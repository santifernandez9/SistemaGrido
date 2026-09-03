import 'dotenv/config';
import { prisma } from './index.js';
import { ROLE_CODES, type RoleCode } from '@sistema-grido/shared-types';

/**
 * Seed de DESARROLLO (no productivo — sección 18 del prompt de Etapa 1).
 *
 * No usa nombres reales del cliente: la lista real de ubicaciones (Saavedra/
 * Aristóbulo del Valle/JJ Paso/El Pozo) sigue pendiente de confirmación (P-006,
 * docs/ETAPA-0-ANALISIS-ARQUITECTURA.md sección 22 — no bloqueante, pero no
 * resuelta todavía), así que este seed usa nombres genéricos de desarrollo.
 *
 * Crea: los 3 roles confirmados, una organización única (Hito 1 = una sola
 * organización activa) y sus ubicaciones. NO crea usuarios individuales acá:
 * un `app_user` requiere una cuenta real de Supabase Auth ya existente
 * (auth_subject), que este script no puede inventar. El alta de usuarios se
 * hace desde la API (POST /api/users, sólo ADMIN) una vez que exista al menos
 * un ADMIN — ver docs/ETAPA-1-BASE-CORE.md, sección "Cómo crear el primer usuario".
 */
async function main() {
  console.log('Seed de desarrollo — SistemaGrido');

  const roles = new Map<RoleCode, { id: string }>();
  for (const code of ROLE_CODES) {
    const role = await prisma.role.upsert({
      where: { code },
      update: {},
      create: { code, name: ROLE_NAMES[code] },
    });
    roles.set(code, role);
    console.log(`  role OK: ${code}`);
  }

  const organization = await prisma.organization.upsert({
    where: { id: DEV_ORG_ID },
    update: {},
    create: {
      id: DEV_ORG_ID,
      name: 'Organización Demo (desarrollo)',
      timezone: 'America/Argentina/Cordoba',
    },
  });
  console.log(`  organization OK: ${organization.name}`);

  const locations: Array<{ name: string; type: 'DEPOT' | 'ICE_CREAM_SHOP' }> = [
    { name: 'Depósito Demo', type: 'DEPOT' },
    { name: 'Heladería Demo 1', type: 'ICE_CREAM_SHOP' },
    { name: 'Heladería Demo 2', type: 'ICE_CREAM_SHOP' },
  ];

  for (const loc of locations) {
    await prisma.location.upsert({
      where: { organizationId_name: { organizationId: organization.id, name: loc.name } },
      update: {},
      create: { organizationId: organization.id, name: loc.name, type: loc.type },
    });
    console.log(`  location OK: ${loc.name} (${loc.type})`);
  }

  // Catálogos técnicos de Etapa 2 (docs/ETAPA-2-CATALOGO-MAESTROS.md): valores
  // evidenciados por el material real del cliente (hoja PRODUCTOS de Habash), no
  // datos de negocio del cliente en sí -- por eso van en el seed técnico, igual que
  // los roles, y no en el importador de catálogo.
  const productTypes: Array<{ code: string; name: string }> = [
    { code: 'HELADO', name: 'Helado' },
    { code: 'INSUMO', name: 'Insumo' },
  ];
  for (const pt of productTypes) {
    await prisma.productType.upsert({
      where: { organizationId_code: { organizationId: organization.id, code: pt.code } },
      update: {},
      create: { organizationId: organization.id, code: pt.code, name: pt.name },
    });
    console.log(`  product type OK: ${pt.code}`);
  }

  const unitsOfMeasure: Array<{ code: string; name: string }> = [
    { code: 'UNIDAD', name: 'Unidad' },
    { code: 'LATA', name: 'Lata' },
    { code: 'CAJA', name: 'Caja' },
  ];
  for (const uom of unitsOfMeasure) {
    await prisma.unitOfMeasure.upsert({
      where: { organizationId_code: { organizationId: organization.id, code: uom.code } },
      update: {},
      create: { organizationId: organization.id, code: uom.code, name: uom.name },
    });
    console.log(`  unit of measure OK: ${uom.code}`);
  }

  console.log(
    '\nSeed completo. No se creó ningún app_user: para tener el primer ADMIN, invitalo desde ' +
      'la API una vez que exista una cuenta de Supabase Auth (ver docs/ETAPA-1-BASE-CORE.md).\n' +
      'Tampoco se cargó catálogo de productos real: ver packages/db/src/import-catalog.ts y ' +
      'docs/ETAPA-2-CATALOGO-MAESTROS.md, sección "Importación inicial".',
  );
}

const ROLE_NAMES: Record<RoleCode, string> = {
  ADMIN: 'Administrador / Franquiciado',
  DEPOSIT_MANAGER: 'Encargado de depósito',
  SHOP_EMPLOYEE: 'Empleada de heladería',
};

/** UUID fijo del org de desarrollo, para que el seed sea idempotente (upsert por id). */
const DEV_ORG_ID = '00000000-0000-0000-0000-000000000001';

main()
  .catch((err) => {
    console.error('Seed falló:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
