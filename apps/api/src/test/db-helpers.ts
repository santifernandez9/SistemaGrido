import { prisma } from '@sistema-grido/db';

/**
 * Limpia las tablas del Core entre tests de integración, en orden seguro para las
 * Foreign Keys (hijos antes que padres). Sólo se usa en tests -- nunca en desarrollo
 * ni en producción -- y requiere que las migraciones ya estén aplicadas contra la
 * base de datos de test (ver docs/ETAPA-1-BASE-CORE.md, sección "Tests").
 */
export async function resetCoreTables(): Promise<void> {
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
