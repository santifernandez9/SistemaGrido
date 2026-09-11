import { prisma } from '@sistema-grido/db';

/**
 * Limpia las tablas del Core entre tests de integración, en orden seguro para las
 * Foreign Keys (hijos antes que padres). Sólo se usa en tests -- nunca en desarrollo
 * ni en producción -- y requiere que las migraciones ya estén aplicadas contra la
 * base de datos de test (ver docs/ETAPA-1-BASE-CORE.md, sección "Tests").
 */
export async function resetCoreTables(): Promise<void> {
  // Etapa 6.2: InventoryCountTypoCandidate referencia InventoryCountItem --
  // tiene que borrarse antes.
  await prisma.inventoryCountTypoCandidate.deleteMany();
  await prisma.inventoryCountItem.deleteMany();
  await prisma.inventoryCount.deleteMany();
  await prisma.waste.deleteMany();
  await prisma.variableExpense.deleteMany();
  await prisma.stockoutEvent.deleteMany();
  // Etapa 5: Sale referencia InventoryMovement/SalesImport/SalesImportRow --
  // tiene que borrarse antes que todos esos (hijo antes que padres).
  await prisma.sale.deleteMany();
  await prisma.salesImportRow.deleteMany();
  await prisma.salesImport.deleteMany();
  await prisma.productAlias.deleteMany();
  await prisma.billOfMaterialItem.deleteMany();
  // Etapa 6: InventorySnapshotItem referencia InventoryMovement
  // (countCorrectionMovementId), WeeklyClosing y PriceValue -- tiene que
  // borrarse antes que todos esos.
  await prisma.inventorySnapshotItem.deleteMany();
  await prisma.weeklyClosing.deleteMany();
  await prisma.generalWeeklyClosing.deleteMany();
  // Etapa 6.2: PriceValue referencia PriceListImportRow/PriceListImport/
  // PriceReference -- tiene que borrarse antes que todos esos.
  await prisma.priceValue.deleteMany();
  await prisma.priceReferenceProductMapping.deleteMany();
  await prisma.priceListImportRow.deleteMany();
  await prisma.priceListImport.deleteMany();
  await prisma.priceReference.deleteMany();
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

/**
 * Etapa 6.2: crea un costo C/IVA VIGENTE para un producto sin pasar por el
 * flujo real de importación (equivalente a un import+mapeo ya confirmados)
 * -- usado por tests de otras etapas (ej. Etapa 6/6.1) que necesitan que
 * `closeWeeklyClosing` no bloquee por falta de costo, sin que ese sea el
 * foco del test. Los tests que SÍ prueban el importador/mapeo real usan el
 * flujo real end-to-end, nunca este atajo.
 */
export async function seedProductCost(params: {
  organizationId: string;
  productId: string;
  productName: string;
  actorId: string;
  costWithTax: string;
  /** Fecha ISO (YYYY-MM-DD); default: bien en el pasado, siempre vigente. */
  effectiveFrom?: string;
}): Promise<void> {
  const { organizationId, productId, productName, actorId, costWithTax } = params;
  const effectiveFrom = new Date(`${params.effectiveFrom ?? '2020-01-01'}T00:00:00.000Z`);

  const importRow = await prisma.priceListImport.create({
    data: {
      organizationId,
      source: 'HELACOR_COST_LIST',
      priceType: 'COST_WITH_TAX',
      originalFilename: 'test-fixture.xlsx',
      fileHash: `test-${productId}-${Date.now()}-${Math.random()}`,
      status: 'CONFIRMED',
      totalRows: 1,
      validRows: 1,
      errorRows: 0,
      createdById: actorId,
      confirmedById: actorId,
      confirmedAt: new Date(),
      effectiveFrom,
    },
  });
  const row = await prisma.priceListImportRow.create({
    data: {
      organizationId,
      priceListImportId: importRow.id,
      rowNumber: 1,
      rawLabel: productName,
      rawValueWithTax: costWithTax,
      status: 'VALID',
    },
  });
  const reference = await prisma.priceReference.create({
    data: { organizationId, priceType: 'COST_WITH_TAX', label: productName },
  });
  await prisma.priceValue.create({
    data: {
      organizationId,
      priceReferenceId: reference.id,
      priceType: 'COST_WITH_TAX',
      value: costWithTax,
      effectiveFrom,
      priceListImportId: importRow.id,
      priceListImportRowId: row.id,
      createdById: actorId,
    },
  });
  await prisma.priceReferenceProductMapping.create({
    data: {
      organizationId,
      priceReferenceId: reference.id,
      priceType: 'COST_WITH_TAX',
      productId,
      confirmedById: actorId,
    },
  });
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
