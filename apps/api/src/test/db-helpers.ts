import { prisma } from '@sistema-grido/db';

/**
 * Limpia las tablas del Core entre tests de integración, en orden seguro para las
 * Foreign Keys (hijos antes que padres). Sólo se usa en tests -- nunca en desarrollo
 * ni en producción -- y requiere que las migraciones ya estén aplicadas contra la
 * base de datos de test (ver docs/ETAPA-1-BASE-CORE.md, sección "Tests").
 */
export async function resetCoreTables(): Promise<void> {
  await prisma.inventoryMovement.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.productType.deleteMany();
  await prisma.unitOfMeasure.deleteMany();
  await prisma.flavor.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.appUser.deleteMany();
  await prisma.location.deleteMany();
  await prisma.role.deleteMany();
  await prisma.organization.deleteMany();
}

export async function seedRoles(): Promise<
  Record<'ADMIN' | 'DEPOSIT_MANAGER' | 'SHOP_EMPLOYEE', string>
> {
  const admin = await prisma.role.create({ data: { code: 'ADMIN', name: 'Administrador' } });
  const deposit = await prisma.role.create({
    data: { code: 'DEPOSIT_MANAGER', name: 'Encargado de depósito' },
  });
  const employee = await prisma.role.create({
    data: { code: 'SHOP_EMPLOYEE', name: 'Empleada de heladería' },
  });
  return { ADMIN: admin.id, DEPOSIT_MANAGER: deposit.id, SHOP_EMPLOYEE: employee.id };
}

export async function seedOrganization(): Promise<string> {
  const org = await prisma.organization.create({ data: { name: 'Organización de test' } });
  return org.id;
}

/** Catálogos técnicos de Etapa 2 (ver packages/db/src/seed.ts) para un test dado. */
export async function seedProductTypes(
  organizationId: string,
): Promise<Record<'HELADO' | 'INSUMO', string>> {
  const helado = await prisma.productType.create({
    data: { organizationId, code: 'HELADO', name: 'Helado' },
  });
  const insumo = await prisma.productType.create({
    data: { organizationId, code: 'INSUMO', name: 'Insumo' },
  });
  return { HELADO: helado.id, INSUMO: insumo.id };
}

export async function seedUnitsOfMeasure(
  organizationId: string,
): Promise<Record<'UNIDAD' | 'LATA' | 'CAJA', string>> {
  const unidad = await prisma.unitOfMeasure.create({
    data: { organizationId, code: 'UNIDAD', name: 'Unidad' },
  });
  const lata = await prisma.unitOfMeasure.create({
    data: { organizationId, code: 'LATA', name: 'Lata' },
  });
  const caja = await prisma.unitOfMeasure.create({
    data: { organizationId, code: 'CAJA', name: 'Caja' },
  });
  return { UNIDAD: unidad.id, LATA: lata.id, CAJA: caja.id };
}
