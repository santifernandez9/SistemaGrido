import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  ConfirmSalesImportInput,
  Page,
  PageInput,
  SalesImport as SalesImportDto,
  SalesImportFilters,
  SalesImportPreview,
  SalesImportProductMappingSummary,
  SalesImportRow as SalesImportRowDto,
  SalesImportUnmappedCodeSummary,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { assertLocationForMovement } from './inventory-ledger.js';
import { isUniqueConstraintViolationOn } from './idempotency.js';
import { parseMixVentasFile, UnsupportedSalesImportFileError } from './sales-import-parser.js';

/**
 * Servicio del Importador de Ventas (Etapa 5) -- ver
 * docs/ETAPA-5-IMPORTADOR-VENTAS.md. Orquesta el flujo obligatorio de 10
 * pasos del prompt: subir -> parsear -> preview (nunca toca stock) -> revisar
 * -> confirmar (recién ahí se generan Sale + SALE + BOM_CONSUMPTION +
 * auditoría, todo en una única transacción).
 */

const FILE_HASH_UNIQUE_TARGET = ['organization_id', 'location_id', 'file_hash'] as const;
const CONFIRM_IDEMPOTENCY_KEY_TARGET = ['organization_id', 'confirm_idempotency_key'] as const;

/** Tolerancia de reconciliación (sección 13 del prompt) -- redondeo de centavos. */
const RECONCILIATION_TOLERANCE = new Prisma.Decimal('0.02');

const salesImportInclude = {
  location: { select: { name: true } },
  createdBy: { select: { displayName: true } },
  confirmedBy: { select: { displayName: true } },
} satisfies Prisma.SalesImportInclude;

type SalesImportRowRecord = Prisma.SalesImportRowGetPayload<Record<string, never>>;
type SalesImportRow = Prisma.SalesImportGetPayload<{
  include: typeof salesImportInclude;
}>;

function mapSalesImport(row: SalesImportRow, alreadyImported = false): SalesImportDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    locationId: row.locationId,
    locationName: row.location.name,
    source: row.source,
    originalFilename: row.originalFilename,
    fileHash: row.fileHash,
    periodStart: row.periodStart.toISOString().slice(0, 10),
    periodEnd: row.periodEnd.toISOString().slice(0, 10),
    status: row.status,
    totalRows: row.totalRows,
    validRows: row.validRows,
    errorRows: row.errorRows,
    totalQuantity: row.totalQuantity.toFixed(3),
    totalAmount: row.totalAmount.toFixed(2),
    fileStatedTotal: row.fileStatedTotal?.toFixed(2) ?? null,
    blockedReason: row.blockedReason,
    failedReason: row.failedReason,
    createdById: row.createdById,
    createdByName: row.createdBy.displayName,
    createdAt: row.createdAt.toISOString(),
    confirmedById: row.confirmedById,
    confirmedByName: row.confirmedBy?.displayName ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    ...(alreadyImported ? { alreadyImported: true } : {}),
  };
}

function mapSalesImportRow(
  row: SalesImportRowRecord,
  resolvedProductId: string | null,
  resolvedProductName: string | null,
): SalesImportRowDto {
  return {
    id: row.id,
    rowNumber: row.rowNumber,
    rawArticleCode: row.rawArticleCode,
    rawDescription: row.rawDescription,
    rawGroup: row.rawGroup,
    quantity: row.quantity.toFixed(3),
    amount: row.amount.toFixed(2),
    isPromotion: row.isPromotion,
    isCanje: row.isCanje,
    promotionCode: row.promotionCode,
    unitPriceAvg: row.unitPriceAvg?.toFixed(4) ?? null,
    bultos: row.bultos,
    kilos: row.kilos?.toFixed(3) ?? null,
    pctOfTotal: row.pctOfTotal?.toFixed(4) ?? null,
    status: row.status,
    errorMessage: row.errorMessage,
    resolvedProductId,
    resolvedProductName,
  };
}

/** Resuelve, EN VIVO, códigos externos -> Product a través de ProductAlias
 * (nunca se cachea en la fila -- ver comentario de `SalesImportRow` en el
 * schema). */
async function resolveProductAliases(
  fastify: FastifyInstance,
  organizationId: string,
  articleCodes: string[],
): Promise<Map<string, { productId: string; productName: string }>> {
  if (articleCodes.length === 0) return new Map();
  const aliases = await fastify.db.productAlias.findMany({
    where: {
      organizationId,
      source: 'MIX_VENTAS',
      externalCode: { in: [...new Set(articleCodes)] },
    },
    include: { product: { select: { name: true } } },
  });
  return new Map(
    aliases.map((a) => [a.externalCode, { productId: a.productId, productName: a.product.name }]),
  );
}

function computeConfirmFingerprint(salesImportId: string): string {
  return JSON.stringify({ salesImportId });
}

async function resolveConfirmConflictAfterRace(
  fastify: FastifyInstance,
  organizationId: string,
  salesImportId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<SalesImportDto> {
  const winner = await fastify.db.salesImport.findFirst({
    where: { id: salesImportId, organizationId },
    include: salesImportInclude,
  });
  if (!winner) {
    fastify.log.error(
      { organizationId, salesImportId, idempotencyKey },
      'Etapa 5: colisión de idempotencia de confirmación sin import encontrado al reconsultar',
    );
    throw new ConflictError(
      'No se pudo confirmar el resultado de esta importación por una condición de carrera inesperada; reintentá la solicitud.',
    );
  }
  if (
    winner.confirmIdempotencyKey === idempotencyKey &&
    winner.confirmIdempotencyFingerprint === fingerprint
  ) {
    return mapSalesImport(winner);
  }
  throw new ConflictError('Esta importación ya fue confirmada con una clave distinta.');
}

interface UploadSalesImportParams {
  locationId: string;
  originalFilename: string;
  buffer: Buffer;
}

/**
 * Sube y parsea un archivo de ventas (pasos 2-6 del flujo obligatorio,
 * sección 6 del prompt). Idempotencia de ARCHIVO (sección 8, CRÍTICO): la
 * identidad es (organización, ubicación, hash del contenido) -- nunca el
 * nombre. Subir el mismo archivo exacto dos veces devuelve el import ya
 * existente (`alreadyImported: true`), nunca lo duplica.
 */
export async function uploadSalesImport(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  params: UploadSalesImportParams,
): Promise<SalesImportDto> {
  await assertLocationForMovement(fastify, organizationId, params.locationId);

  const fileHash = createHash('sha256').update(params.buffer).digest('hex');

  const existing = await fastify.db.salesImport.findFirst({
    where: { organizationId, locationId: params.locationId, fileHash },
    include: salesImportInclude,
  });
  if (existing) {
    await fastify.audit.log({
      organizationId,
      userId: actor.id,
      roleCode: actor.roleCode,
      locationId: params.locationId,
      action: 'SALES_IMPORT_ALREADY_IMPORTED',
      module: 'SALES_IMPORT',
      entityType: 'sales_import',
      entityId: existing.id,
      afterValue: { fileHash, originalFilename: params.originalFilename },
    });
    return mapSalesImport(existing, true);
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'sistema-grido-sales-import-'));
  const tempFilePath = path.join(tempDir, `${randomUUID()}.xls`);
  try {
    await writeFile(tempFilePath, params.buffer);

    let parsed;
    try {
      parsed = await parseMixVentasFile(tempFilePath);
    } catch (err) {
      // Cualquier falla al INTERPRETAR un archivo subido por el usuario es,
      // por definición, un problema del archivo (formato no soportado,
      // corrupto, no es realmente un .xls) -- nunca un error interno del
      // servidor. `UnsupportedSalesImportFileError` es el caso esperado
      // (encabezado/estructura reconocibles pero inválidos); cualquier otro
      // error que node-xlrd pueda lanzar ante un archivo genuinamente
      // corrupto se trata con el mismo criterio, con un mensaje genérico
      // (nunca se expone el detalle interno del parser al cliente).
      const message =
        err instanceof UnsupportedSalesImportFileError
          ? err.message
          : 'No se pudo leer el archivo subido. Verificá que sea un archivo .xls válido del reporte "Mix de Ventas".';
      const errorDetail = err instanceof Error ? err.message : String(err);
      await fastify.audit.log({
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        locationId: params.locationId,
        action: 'SALES_IMPORT_FAILED',
        module: 'SALES_IMPORT',
        result: 'REJECTED',
        errorDetail,
        afterValue: { fileHash, originalFilename: params.originalFilename },
      });
      throw new ValidationError(message);
    }

    let totalQuantity = new Prisma.Decimal(0);
    let totalAmount = new Prisma.Decimal(0);
    let validRows = 0;
    let errorRows = 0;
    for (const row of parsed.rows) {
      if (row.status === 'VALID') {
        validRows++;
        totalQuantity = totalQuantity.add(row.quantity);
        totalAmount = totalAmount.add(row.amount);
      } else {
        errorRows++;
      }
    }

    const fileStatedTotal =
      parsed.fileStatedTotal !== null ? new Prisma.Decimal(parsed.fileStatedTotal) : null;

    let status: 'PREVIEW_READY' | 'BLOCKED' | 'FAILED';
    let blockedReason: string | null = null;
    let failedReason: string | null = null;
    if (parsed.rows.length === 0) {
      status = 'FAILED';
      failedReason = 'El archivo no contiene filas de venta para importar.';
    } else if (fileStatedTotal === null) {
      status = 'BLOCKED';
      blockedReason =
        'No se encontró la fila "Total General" del archivo; no se puede verificar el total.';
    } else if (totalAmount.sub(fileStatedTotal).abs().greaterThan(RECONCILIATION_TOLERANCE)) {
      status = 'BLOCKED';
      blockedReason = `La suma de los importes válidos (${totalAmount.toFixed(2)}) no coincide con el total declarado por el archivo (${fileStatedTotal.toFixed(2)}). Revisá las filas con error y subí un archivo corregido.`;
    } else {
      status = 'PREVIEW_READY';
    }

    const auditAction =
      status === 'FAILED'
        ? 'SALES_IMPORT_FAILED'
        : status === 'BLOCKED'
          ? 'SALES_IMPORT_BLOCKED'
          : 'SALES_IMPORT_UPLOADED';

    try {
      return await fastify.db.$transaction(async (tx) => {
        const created = await tx.salesImport.create({
          data: {
            organizationId,
            locationId: params.locationId,
            source: 'MIX_VENTAS',
            originalFilename: params.originalFilename,
            fileHash,
            periodStart: new Date(`${parsed.periodStart}T00:00:00.000Z`),
            periodEnd: new Date(`${parsed.periodEnd}T00:00:00.000Z`),
            status,
            totalRows: parsed.rows.length,
            validRows,
            errorRows,
            totalQuantity,
            totalAmount,
            fileStatedTotal,
            blockedReason,
            failedReason,
            createdById: actor.id,
            rows: {
              create: parsed.rows.map((row) => ({
                rowNumber: row.rowNumber,
                rawArticleCode: row.rawArticleCode,
                rawDescription: row.rawDescription,
                rawGroup: row.rawGroup,
                quantity: row.quantity,
                amount: row.amount,
                isPromotion: row.isPromotion,
                isCanje: row.isCanje,
                promotionCode: row.promotionCode,
                unitPriceAvg: row.unitPriceAvg,
                bultos: row.bultos,
                kilos: row.kilos,
                pctOfTotal: row.pctOfTotal,
                status: row.status,
                errorMessage: row.errorMessage,
              })),
            },
          },
          include: salesImportInclude,
        });

        await fastify.audit.logTx(tx, {
          organizationId,
          userId: actor.id,
          roleCode: actor.roleCode,
          locationId: params.locationId,
          action: auditAction,
          module: 'SALES_IMPORT',
          entityType: 'sales_import',
          entityId: created.id,
          result: status === 'FAILED' ? 'REJECTED' : 'OK',
          afterValue: mapSalesImport(created),
        });

        return mapSalesImport(created);
      });
    } catch (err) {
      if (isUniqueConstraintViolationOn(err, FILE_HASH_UNIQUE_TARGET)) {
        // Carrera: otra subida concurrente del MISMO archivo ganó -- Postgres
        // es la única fuente de verdad, se reconsulta lo que quedó
        // persistido en vez de asumir un conflicto (mismo criterio que el
        // resto de las idempotencias de Etapa 3.2/4.1).
        const winner = await fastify.db.salesImport.findFirst({
          where: { organizationId, locationId: params.locationId, fileHash },
          include: salesImportInclude,
        });
        if (winner) return mapSalesImport(winner, true);
        fastify.log.error(
          { organizationId, locationId: params.locationId, fileHash },
          'Etapa 5: colisión UNIQUE de fileHash sin import encontrado al reconsultar',
        );
        throw new ConflictError(
          'No se pudo confirmar el resultado de esta subida por una condición de carrera inesperada; reintentá la solicitud.',
        );
      }
      throw err;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function listSalesImports(
  fastify: FastifyInstance,
  organizationId: string,
  filters: SalesImportFilters,
  pageInput: PageInput,
): Promise<Page<SalesImportDto>> {
  const page = Math.max(1, pageInput.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, pageInput.pageSize ?? 20));

  const where: Prisma.SalesImportWhereInput = {
    organizationId,
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };

  const [rows, total] = await Promise.all([
    fastify.db.salesImport.findMany({
      where,
      include: salesImportInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    fastify.db.salesImport.count({ where }),
  ]);

  return { items: rows.map((r) => mapSalesImport(r)), page, pageSize, total };
}

async function loadSalesImportOrThrow(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
): Promise<SalesImportRow> {
  const row = await fastify.db.salesImport.findFirst({
    where: { id, organizationId },
    include: salesImportInclude,
  });
  if (!row) {
    throw new NotFoundError('Importación de ventas no encontrada en esta organización');
  }
  return row;
}

/**
 * Preview completo (paso 5-8 del flujo obligatorio, sección 6 del prompt).
 * SÓLO LECTURA -- nunca crea Sale ni movimientos, ni siquiera para un import
 * ya CONFIRMED (ahí muestra el resultado final, no recalcula nada).
 */
export async function getSalesImportPreview(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
): Promise<SalesImportPreview> {
  const importRow = await loadSalesImportOrThrow(fastify, organizationId, id);
  const rows = await fastify.db.salesImportRow.findMany({
    where: { organizationId, salesImportId: id },
    orderBy: { rowNumber: 'asc' },
  });

  const validRows = rows.filter((r) => r.status === 'VALID');
  const aliasMap = await resolveProductAliases(
    fastify,
    organizationId,
    validRows.map((r) => r.rawArticleCode),
  );

  const mappedByProduct = new Map<string, SalesImportProductMappingSummary>();
  const unmappedByCode = new Map<string, SalesImportUnmappedCodeSummary>();
  const duplicateGroups = new Map<string, number[]>();

  const rowDtos: SalesImportRowDto[] = rows.map((row) => {
    const resolved = row.status === 'VALID' ? aliasMap.get(row.rawArticleCode) : undefined;

    if (row.status === 'VALID') {
      if (resolved) {
        const entry = mappedByProduct.get(resolved.productId);
        if (entry) {
          entry.rowCount++;
        } else {
          mappedByProduct.set(resolved.productId, {
            productId: resolved.productId,
            productName: resolved.productName,
            rowCount: 1,
          });
        }
      } else {
        const entry = unmappedByCode.get(row.rawArticleCode);
        if (entry) {
          entry.rowCount++;
        } else {
          unmappedByCode.set(row.rawArticleCode, {
            rawArticleCode: row.rawArticleCode,
            rawDescription: row.rawDescription,
            rowCount: 1,
          });
        }
      }

      const dupKey = JSON.stringify([
        row.rawArticleCode,
        row.quantity.toString(),
        row.amount.toString(),
        row.promotionCode,
      ]);
      const group = duplicateGroups.get(dupKey);
      if (group) {
        group.push(row.rowNumber);
      } else {
        duplicateGroups.set(dupKey, [row.rowNumber]);
      }
    }

    return mapSalesImportRow(row, resolved?.productId ?? null, resolved?.productName ?? null);
  });

  const potentialDuplicateRowNumbers = [...duplicateGroups.values()]
    .filter((group) => group.length > 1)
    .flat()
    .sort((a, b) => a - b);

  return {
    import: mapSalesImport(importRow),
    rows: rowDtos,
    mappedProducts: [...mappedByProduct.values()].sort((a, b) =>
      a.productName.localeCompare(b.productName),
    ),
    unmappedCodes: [...unmappedByCode.values()].sort((a, b) =>
      a.rawDescription.localeCompare(b.rawDescription),
    ),
    hasUnmappedProducts: unmappedByCode.size > 0,
    potentialDuplicateRowNumbers,
    canConfirm: importRow.status === 'PREVIEW_READY',
  };
}

/**
 * Confirmación (pasos 9-10 del flujo obligatorio). Única operación que
 * escribe Sale + InventoryMovement (SALE y BOM_CONSUMPTION) + auditoría --
 * todo en UNA transacción atómica (sección 14 del prompt: si algo falla,
 * ninguna parte queda aplicada).
 *
 * Idempotencia de CONFIRMACIÓN (sección 9, distinta de la idempotencia de
 * ARCHIVO de `uploadSalesImport`): mismo patrón endurecido de Etapa 3.2/4.1
 * -- `confirmIdempotencyKey`/`confirmIdempotencyFingerprint` + UNIQUE +
 * resolución explícita de carrera vía Postgres (UPDATE condicional
 * `status: PREVIEW_READY -> CONFIRMED`), nunca locks en memoria.
 */
export async function confirmSalesImport(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  id: string,
  input: ConfirmSalesImportInput,
): Promise<SalesImportDto> {
  const importRow = await loadSalesImportOrThrow(fastify, organizationId, id);
  const fingerprint = computeConfirmFingerprint(id);

  if (importRow.confirmIdempotencyKey !== null) {
    if (
      importRow.confirmIdempotencyKey === input.idempotencyKey &&
      importRow.confirmIdempotencyFingerprint === fingerprint
    ) {
      return mapSalesImport(importRow);
    }
    throw new ConflictError(
      importRow.confirmIdempotencyKey === input.idempotencyKey
        ? 'Esta clave de idempotencia ya se usó para confirmar una importación distinta; no puede reutilizarse.'
        : 'Esta importación ya fue confirmada con una clave distinta.',
    );
  }

  if (importRow.status !== 'PREVIEW_READY') {
    throw new ConflictError(
      `Esta importación no se puede confirmar en su estado actual (${importRow.status}).`,
    );
  }

  const validRows = await fastify.db.salesImportRow.findMany({
    where: { organizationId, salesImportId: id, status: 'VALID' },
  });
  const aliasMap = await resolveProductAliases(
    fastify,
    organizationId,
    validRows.map((r) => r.rawArticleCode),
  );
  const mappedRows: { row: (typeof validRows)[number]; alias: { productId: string } }[] = [];
  for (const row of validRows) {
    const alias = aliasMap.get(row.rawArticleCode);
    if (alias) mappedRows.push({ row, alias });
  }

  const soldProductIds = [...new Set(mappedRows.map((e) => e.alias.productId))];
  const soldProducts = await fastify.db.product.findMany({
    where: { organizationId, id: { in: soldProductIds } },
    select: { id: true, unitsPerHandlingUnit: true, unitOfMeasureId: true },
  });
  const soldProductById = new Map(soldProducts.map((p) => [p.id, p]));

  const bomItems = await fastify.db.billOfMaterialItem.findMany({
    where: { organizationId, productId: { in: soldProductIds }, active: true },
  });
  const bomByProductId = new Map<string, typeof bomItems>();
  for (const item of bomItems) {
    const list = bomByProductId.get(item.productId);
    if (list) list.push(item);
    else bomByProductId.set(item.productId, [item]);
  }
  const componentProductIds = [...new Set(bomItems.map((i) => i.componentProductId))];
  const componentProducts = await fastify.db.product.findMany({
    where: { organizationId, id: { in: componentProductIds } },
    select: { id: true, unitsPerHandlingUnit: true, unitOfMeasureId: true },
  });
  const componentProductById = new Map(componentProducts.map((p) => [p.id, p]));

  try {
    return await fastify.db.$transaction(async (tx) => {
      const updateResult = await tx.salesImport.updateMany({
        where: { id, organizationId, status: 'PREVIEW_READY' },
        data: {
          status: 'CONFIRMED',
          confirmedById: actor.id,
          confirmedAt: new Date(),
          confirmIdempotencyKey: input.idempotencyKey,
          confirmIdempotencyFingerprint: fingerprint,
        },
      });
      if (updateResult.count === 0) {
        throw new ConflictError(
          'Esta importación ya fue confirmada por otra solicitud; volvé a consultarla.',
        );
      }

      let salesCreated = 0;
      let movementsCreated = 0;

      for (const { row, alias } of mappedRows) {
        const product = soldProductById.get(alias.productId);
        if (!product) {
          fastify.log.error(
            { organizationId, salesImportId: id, productId: alias.productId },
            'Etapa 5: producto de un alias resuelto no encontrado al confirmar (dato inconsistente)',
          );
          continue;
        }

        const quantitySold = new Prisma.Decimal(row.quantity);
        const enteredQuantity = quantitySold.negated();
        const conversionFactor = product.unitsPerHandlingUnit;
        const canonicalQuantity = enteredQuantity.mul(conversionFactor);

        const movement = await tx.inventoryMovement.create({
          data: {
            organizationId,
            locationId: importRow.locationId,
            productId: alias.productId,
            movementType: 'SALE',
            quantity: canonicalQuantity,
            enteredQuantity,
            entryUnitOfMeasureId: product.unitOfMeasureId,
            conversionFactor,
            occurredAt: importRow.periodEnd,
            sourceDocumentType: 'SALES_IMPORT',
            sourceDocumentId: importRow.id,
            createdById: actor.id,
          },
        });
        movementsCreated++;

        const sale = await tx.sale.create({
          data: {
            organizationId,
            locationId: importRow.locationId,
            salesImportId: id,
            salesImportRowId: row.id,
            productId: alias.productId,
            quantity: quantitySold,
            amountReal: row.amount,
            isPromotion: row.isPromotion,
            isCanje: row.isCanje,
            occurredAt: importRow.periodEnd,
            movementId: movement.id,
            createdById: actor.id,
          },
        });
        salesCreated++;

        const recipe = bomByProductId.get(alias.productId) ?? [];
        const soldCanonicalMagnitude = canonicalQuantity.abs();
        for (const bomItem of recipe) {
          const componentProduct = componentProductById.get(bomItem.componentProductId);
          if (!componentProduct) {
            fastify.log.error(
              { organizationId, componentProductId: bomItem.componentProductId },
              'Etapa 5: componente de BOM no encontrado al confirmar (dato inconsistente)',
            );
            continue;
          }
          const componentCanonicalQty = soldCanonicalMagnitude.mul(bomItem.quantityPerUnit);
          const componentConversionFactor = componentProduct.unitsPerHandlingUnit;
          const componentEnteredQuantity = componentCanonicalQty
            .div(componentConversionFactor)
            .negated();
          const componentCanonicalSigned = componentEnteredQuantity.mul(componentConversionFactor);

          await tx.inventoryMovement.create({
            data: {
              organizationId,
              locationId: importRow.locationId,
              productId: bomItem.componentProductId,
              movementType: 'BOM_CONSUMPTION',
              quantity: componentCanonicalSigned,
              enteredQuantity: componentEnteredQuantity,
              entryUnitOfMeasureId: componentProduct.unitOfMeasureId,
              conversionFactor: componentConversionFactor,
              occurredAt: importRow.periodEnd,
              sourceDocumentType: 'SALE',
              sourceDocumentId: sale.id,
              createdById: actor.id,
            },
          });
          movementsCreated++;
        }
      }

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        locationId: importRow.locationId,
        action: 'SALES_IMPORT_CONFIRMED',
        module: 'SALES_IMPORT',
        entityType: 'sales_import',
        entityId: id,
        afterValue: { salesImportId: id, salesCreated, movementsCreated },
      });

      const updated = await tx.salesImport.findFirstOrThrow({
        where: { id, organizationId },
        include: salesImportInclude,
      });
      return mapSalesImport(updated);
    });
  } catch (err) {
    if (isUniqueConstraintViolationOn(err, CONFIRM_IDEMPOTENCY_KEY_TARGET)) {
      return resolveConfirmConflictAfterRace(
        fastify,
        organizationId,
        id,
        input.idempotencyKey,
        fingerprint,
      );
    }
    if (err instanceof ConflictError) {
      return resolveConfirmConflictAfterRace(
        fastify,
        organizationId,
        id,
        input.idempotencyKey,
        fingerprint,
      );
    }
    throw err;
  }
}
