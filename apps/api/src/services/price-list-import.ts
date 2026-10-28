import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  ConfirmPriceListImportInput,
  Page,
  PageInput,
  PriceListImport as PriceListImportDto,
  PriceListImportFilters,
  PriceListImportPreview,
  PriceListImportRow as PriceListImportRowDto,
  PriceListSource,
} from '@sistema-grido/shared-types';
import { PRICE_TYPE_BY_SOURCE } from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { isUniqueConstraintViolationOn } from './idempotency.js';
import {
  parseHelacorCostListFile,
  parseHelacorSalePriceListFile,
  UnsupportedPriceListFileError,
} from './price-list-parser.js';

/**
 * Servicio del importador de listas de precios/costos (Etapa 6.2, secciones
 * 7/9/10 del prompt) -- ver docs/ETAPA-6.2-CIERRE-INTEGRAL.md. Mismo flujo
 * de 3 pasos que `sales-import.ts` (Etapa 5): subir -> parsear -> preview
 * (nunca escribe `PriceReference`/`PriceValue`) -> confirmar (con
 * `effectiveFrom` obligatorio, indicado por el ADMIN acá, nunca al subir).
 */

const FILE_HASH_UNIQUE_TARGET = ['organization_id', 'source', 'file_hash'] as const;
const CONFIRM_IDEMPOTENCY_KEY_TARGET = ['organization_id', 'confirm_idempotency_key'] as const;
const PRICE_REFERENCE_UNIQUE_TARGET = ['organization_id', 'price_type', 'label'] as const;
const PRICE_VALUE_UNIQUE_TARGET = [
  'organization_id',
  'price_reference_id',
  'effective_from',
] as const;

const importInclude = {
  createdBy: { select: { displayName: true } },
  confirmedBy: { select: { displayName: true } },
} satisfies Prisma.PriceListImportInclude;

type ImportRow = Prisma.PriceListImportGetPayload<{ include: typeof importInclude }>;
type ImportRowRecord = Prisma.PriceListImportRowGetPayload<Record<string, never>>;

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function mapImport(row: ImportRow, alreadyImported = false): PriceListImportDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    source: row.source,
    priceType: row.priceType,
    originalFilename: row.originalFilename,
    fileHash: row.fileHash,
    rawPeriodLabel: row.rawPeriodLabel,
    status: row.status,
    totalRows: row.totalRows,
    validRows: row.validRows,
    errorRows: row.errorRows,
    failedReason: row.failedReason,
    createdById: row.createdById,
    createdByName: row.createdBy.displayName,
    createdAt: row.createdAt.toISOString(),
    effectiveFrom: row.effectiveFrom ? toIsoDate(row.effectiveFrom) : null,
    confirmedById: row.confirmedById,
    confirmedByName: row.confirmedBy?.displayName ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    ...(alreadyImported ? { alreadyImported: true } : {}),
  };
}

function mapRow(
  row: ImportRowRecord,
  existingPriceReferenceId: string | null,
  isMapped: boolean,
): PriceListImportRowDto {
  return {
    id: row.id,
    rowNumber: row.rowNumber,
    rawLabel: row.rawLabel,
    rawCategory: row.rawCategory,
    rawValueWithoutTax: row.rawValueWithoutTax?.toFixed(2) ?? null,
    rawValueWithTax: row.rawValueWithTax?.toFixed(2) ?? null,
    status: row.status,
    errorMessage: row.errorMessage,
    existingPriceReferenceId,
    isMapped,
  };
}

interface UploadPriceListImportParams {
  source: PriceListSource;
  originalFilename: string;
  buffer: Buffer;
}

export async function uploadPriceListImport(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  params: UploadPriceListImportParams,
): Promise<PriceListImportDto> {
  const fileHash = createHash('sha256').update(params.buffer).digest('hex');
  const priceType = PRICE_TYPE_BY_SOURCE[params.source];

  const existing = await fastify.db.priceListImport.findFirst({
    where: { organizationId, source: params.source, fileHash },
    include: importInclude,
  });
  if (existing) {
    await fastify.audit.log({
      organizationId,
      userId: actor.id,
      roleCode: actor.roleCode,
      action: 'PRICE_LIST_IMPORT_ALREADY_IMPORTED',
      module: 'PRICE_LIST',
      entityType: 'price_list_import',
      entityId: existing.id,
      afterValue: { fileHash, originalFilename: params.originalFilename },
    });
    return mapImport(existing, true);
  }

  let parsed;
  try {
    parsed =
      params.source === 'HELACOR_COST_LIST'
        ? await parseHelacorCostListFile(params.buffer)
        : await parseHelacorSalePriceListFile(params.buffer);
  } catch (err) {
    const message =
      err instanceof UnsupportedPriceListFileError
        ? err.message
        : 'No se pudo leer el archivo subido. Verificá que sea un archivo .xlsx válido.';
    const errorDetail = err instanceof Error ? err.message : String(err);
    await fastify.audit.log({
      organizationId,
      userId: actor.id,
      roleCode: actor.roleCode,
      action: 'PRICE_LIST_IMPORT_FAILED',
      module: 'PRICE_LIST',
      result: 'REJECTED',
      errorDetail,
      afterValue: { fileHash, originalFilename: params.originalFilename },
    });
    throw new ValidationError(message);
  }

  const validRows = parsed.rows.filter((r) => r.status === 'VALID').length;
  const errorRows = parsed.rows.length - validRows;

  let status: 'PREVIEW_READY' | 'FAILED';
  let failedReason: string | null = null;
  if (parsed.rows.length === 0) {
    status = 'FAILED';
    failedReason = 'El archivo no contiene ninguna fila de precio/costo para importar.';
  } else {
    status = 'PREVIEW_READY';
  }

  const auditAction =
    status === 'FAILED' ? 'PRICE_LIST_IMPORT_FAILED' : 'PRICE_LIST_IMPORT_UPLOADED';

  try {
    return await fastify.db.$transaction(async (tx) => {
      const created = await tx.priceListImport.create({
        data: {
          organizationId,
          source: params.source,
          priceType,
          originalFilename: params.originalFilename,
          fileHash,
          rawPeriodLabel: parsed.rawPeriodLabel,
          status,
          totalRows: parsed.rows.length,
          validRows,
          errorRows,
          failedReason,
          createdById: actor.id,
          rows: {
            create: parsed.rows.map((row) => ({
              rowNumber: row.rowNumber,
              rawLabel: row.rawLabel,
              rawCategory: row.rawCategory,
              rawValueWithoutTax:
                row.rawValueWithoutTax !== null
                  ? new Prisma.Decimal(row.rawValueWithoutTax.toFixed(2))
                  : null,
              rawValueWithTax:
                row.rawValueWithTax !== null
                  ? new Prisma.Decimal(row.rawValueWithTax.toFixed(2))
                  : null,
              status: row.status,
              errorMessage: row.errorMessage,
            })),
          },
        },
        include: importInclude,
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: auditAction,
        module: 'PRICE_LIST',
        entityType: 'price_list_import',
        entityId: created.id,
        result: status === 'FAILED' ? 'REJECTED' : 'OK',
        afterValue: mapImport(created),
      });

      return mapImport(created);
    });
  } catch (err) {
    if (isUniqueConstraintViolationOn(err, FILE_HASH_UNIQUE_TARGET)) {
      const winner = await fastify.db.priceListImport.findFirst({
        where: { organizationId, source: params.source, fileHash },
        include: importInclude,
      });
      if (winner) return mapImport(winner, true);
      fastify.log.error(
        { organizationId, source: params.source, fileHash },
        'Etapa 6.2: colisión UNIQUE de fileHash de precios sin import encontrado al reconsultar',
      );
      throw new ConflictError(
        'No se pudo confirmar el resultado de esta subida por una condición de carrera inesperada; reintentá la solicitud.',
      );
    }
    throw err;
  }
}

export async function listPriceListImports(
  fastify: FastifyInstance,
  organizationId: string,
  filters: PriceListImportFilters,
  pageInput: PageInput,
): Promise<Page<PriceListImportDto>> {
  const page = Math.max(1, pageInput.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, pageInput.pageSize ?? 20));

  const where: Prisma.PriceListImportWhereInput = {
    organizationId,
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };

  const [rows, total] = await Promise.all([
    fastify.db.priceListImport.findMany({
      where,
      include: importInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    fastify.db.priceListImport.count({ where }),
  ]);

  return { items: rows.map((r) => mapImport(r)), page, pageSize, total };
}

async function loadImportOrThrow(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
): Promise<ImportRow> {
  const row = await fastify.db.priceListImport.findFirst({
    where: { id, organizationId },
    include: importInclude,
  });
  if (!row) {
    throw new NotFoundError('Importación de precios/costos no encontrada en esta organización');
  }
  return row;
}

/** Preview SÓLO LECTURA (sección 6 del prompt de Etapa 5, mismo criterio
 * reutilizado acá) -- resuelve EN VIVO contra `PriceReference` existente,
 * nunca crea nada. */
export async function getPriceListImportPreview(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
): Promise<PriceListImportPreview> {
  const importRow = await loadImportOrThrow(fastify, organizationId, id);
  const rows = await fastify.db.priceListImportRow.findMany({
    where: { organizationId, priceListImportId: id },
    orderBy: { rowNumber: 'asc' },
  });

  const validRows = rows.filter((r) => r.status === 'VALID');
  const labels = [...new Set(validRows.map((r) => r.rawLabel))];
  const existingReferences =
    labels.length > 0
      ? await fastify.db.priceReference.findMany({
          where: { organizationId, priceType: importRow.priceType, label: { in: labels } },
          include: { mappings: { where: { active: true }, select: { id: true } } },
        })
      : [];
  const referenceByLabel = new Map(existingReferences.map((r) => [r.label, r]));

  let newReferenceCount = 0;
  let existingReferenceCount = 0;
  let unmappedReferenceCount = 0;

  const rowDtos = rows.map((row) => {
    if (row.status !== 'VALID') {
      return mapRow(row, null, false);
    }
    const existingReference = referenceByLabel.get(row.rawLabel);
    if (existingReference) {
      existingReferenceCount++;
      const isMapped = existingReference.mappings.length > 0;
      if (!isMapped) unmappedReferenceCount++;
      return mapRow(row, existingReference.id, isMapped);
    }
    newReferenceCount++;
    unmappedReferenceCount++;
    return mapRow(row, null, false);
  });

  return {
    import: mapImport(importRow),
    rows: rowDtos,
    newReferenceCount,
    existingReferenceCount,
    unmappedReferenceCount,
    canConfirm: importRow.status === 'PREVIEW_READY',
  };
}

function computeConfirmFingerprint(priceListImportId: string, effectiveFrom: string): string {
  return JSON.stringify({ priceListImportId, effectiveFrom });
}

async function resolveConfirmConflictAfterRace(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<PriceListImportDto> {
  const winner = await fastify.db.priceListImport.findFirst({
    where: { id, organizationId },
    include: importInclude,
  });
  if (!winner) {
    fastify.log.error(
      { organizationId, id, idempotencyKey },
      'Etapa 6.2: colisión de idempotencia de confirmación de precios sin import encontrado al reconsultar',
    );
    throw new ConflictError(
      'No se pudo confirmar el resultado de esta importación por una condición de carrera inesperada; reintentá la solicitud.',
    );
  }
  if (
    winner.confirmIdempotencyKey === idempotencyKey &&
    winner.confirmIdempotencyFingerprint === fingerprint
  ) {
    return mapImport(winner);
  }
  throw new ConflictError('Esta importación ya fue confirmada con una clave o vigencia distinta.');
}

/** Marca, dentro del `catch`, un `ConflictError` de "referencia/valor en
 * conflicto" (nunca una carrera de confirmación real) -- mismo criterio que
 * `UnmappedProductsConflictError` de `sales-import.ts`. */
class PriceConflictError extends ConflictError {}

/**
 * Confirmación (sección 9/10 del prompt): crea/reutiliza `PriceReference`
 * por `(priceType, label)` y agrega un `PriceValue` nuevo por cada fila
 * VALID -- nunca pisa uno existente. Si YA existe un `PriceValue` para
 * exactamente la misma `(referencia, effectiveFrom)`:
 *   - mismo valor -> se reutiliza (reimportar el mismo archivo, o dos
 *     archivos que coinciden, no duplica historial -- sección 9 del prompt).
 *   - valor DISTINTO -> conflicto genuino: TODA la confirmación se aborta
 *     (rollback completo, sección 9: "no asumir que dos archivos del mismo
 *     período son necesariamente duplicados" -- se informa el conflicto en
 *     vez de decidir solo cuál vale).
 */
export async function confirmPriceListImport(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  id: string,
  input: ConfirmPriceListImportInput,
): Promise<PriceListImportDto> {
  const effectiveFromDate = new Date(`${input.effectiveFrom}T00:00:00.000Z`);
  if (Number.isNaN(effectiveFromDate.getTime())) {
    throw new ValidationError('effectiveFrom inválido: debe ser una fecha (YYYY-MM-DD)');
  }

  const importRow = await loadImportOrThrow(fastify, organizationId, id);
  const fingerprint = computeConfirmFingerprint(id, input.effectiveFrom);

  if (importRow.confirmIdempotencyKey !== null) {
    if (
      importRow.confirmIdempotencyKey === input.idempotencyKey &&
      importRow.confirmIdempotencyFingerprint === fingerprint
    ) {
      return mapImport(importRow);
    }
    throw new ConflictError(
      importRow.confirmIdempotencyKey === input.idempotencyKey
        ? 'Esta clave de idempotencia ya se usó para confirmar una importación distinta; no puede reutilizarse.'
        : 'Esta importación ya fue confirmada con una clave o vigencia distinta.',
    );
  }
  if (importRow.status !== 'PREVIEW_READY') {
    throw new ConflictError(
      `Esta importación no se puede confirmar en su estado actual (${importRow.status}).`,
    );
  }

  try {
    return await fastify.db.$transaction(async (tx) => {
      const updateResult = await tx.priceListImport.updateMany({
        where: { id, organizationId, status: 'PREVIEW_READY' },
        data: {
          status: 'CONFIRMED',
          effectiveFrom: effectiveFromDate,
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

      const validRows = await tx.priceListImportRow.findMany({
        where: { organizationId, priceListImportId: id, status: 'VALID' },
      });

      const labels = [...new Set(validRows.map((r) => r.rawLabel))];
      const existingReferences =
        labels.length > 0
          ? await tx.priceReference.findMany({
              where: { organizationId, priceType: importRow.priceType, label: { in: labels } },
            })
          : [];
      const referenceByLabel = new Map(existingReferences.map((r) => [r.label, r]));

      let valuesCreated = 0;
      let referencesCreated = 0;

      for (const row of validRows) {
        if (row.rawValueWithTax === null) {
          fastify.log.error(
            { organizationId, priceListImportId: id, rowId: row.id },
            'Etapa 6.2: fila VALID de precio sin rawValueWithTax al confirmar (dato inconsistente)',
          );
          continue;
        }

        let reference = referenceByLabel.get(row.rawLabel);
        if (!reference) {
          reference = await tx.priceReference.create({
            data: {
              organizationId,
              priceType: importRow.priceType,
              label: row.rawLabel,
              sourceCategory: row.rawCategory,
            },
          });
          referenceByLabel.set(row.rawLabel, reference);
          referencesCreated++;
        } else if (reference.sourceCategory !== row.rawCategory && row.rawCategory !== null) {
          reference = await tx.priceReference.update({
            where: { organizationId_id: { organizationId, id: reference.id } },
            data: { sourceCategory: row.rawCategory },
          });
          referenceByLabel.set(row.rawLabel, reference);
        }

        const existingValue = await tx.priceValue.findFirst({
          where: {
            organizationId,
            priceReferenceId: reference.id,
            effectiveFrom: effectiveFromDate,
          },
        });
        if (existingValue) {
          if (!existingValue.value.equals(row.rawValueWithTax)) {
            throw new PriceConflictError(
              `Ya existe un valor de "${row.rawLabel}" vigente desde ${input.effectiveFrom} ` +
                `(${existingValue.value.toFixed(2)}) distinto al de este archivo (${row.rawValueWithTax.toFixed(2)}). ` +
                'No se puede confirmar: elegí otra vigencia o confirmá que el archivo anterior estaba mal.',
            );
          }
          await tx.priceValue.update({
            where: { organizationId_id: { organizationId, id: existingValue.id } },
            data: { priceListImportRowId: row.id, priceListImportId: id },
          });
          continue;
        }

        await tx.priceValue.create({
          data: {
            organizationId,
            priceReferenceId: reference.id,
            priceType: importRow.priceType,
            value: row.rawValueWithTax,
            effectiveFrom: effectiveFromDate,
            priceListImportId: id,
            priceListImportRowId: row.id,
            createdById: actor.id,
          },
        });
        valuesCreated++;
      }

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'PRICE_LIST_IMPORT_CONFIRMED',
        module: 'PRICE_LIST',
        entityType: 'price_list_import',
        entityId: id,
        afterValue: {
          priceListImportId: id,
          effectiveFrom: input.effectiveFrom,
          referencesCreated,
          valuesCreated,
        },
      });

      const updated = await tx.priceListImport.findFirstOrThrow({
        where: { id, organizationId },
        include: importInclude,
      });
      return mapImport(updated);
    });
  } catch (err) {
    if (err instanceof PriceConflictError) {
      throw err;
    }
    if (
      isUniqueConstraintViolationOn(err, PRICE_REFERENCE_UNIQUE_TARGET) ||
      isUniqueConstraintViolationOn(err, PRICE_VALUE_UNIQUE_TARGET)
    ) {
      // Etapa 6.2, sección 17: otra confirmación concurrente (de este mismo
      // import reintentado, o de un import distinto que toca la misma
      // referencia) ganó la carrera de creación -- se aborta ESTA
      // transacción completa (nunca un ajuste parcial) y se pide reintentar;
      // el reintento encontrará la referencia/valor ya creados y avanzará
      // idempotentemente.
      throw new ConflictError(
        'No se pudo confirmar por una condición de carrera con otra importación de precios concurrente; reintentá la solicitud.',
      );
    }
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
