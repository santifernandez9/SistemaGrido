import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  InventoryCount as InventoryCountDto,
  InventoryCountDraftItem,
  InventoryCountFilters,
  InventoryCountItemResult,
  Page,
  PageInput,
  SubmitInventoryCountInput,
  SubmitInventoryRecountInput,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import {
  assertLocationForMovement,
  assertProductForMovement,
  getStockBalances,
} from './inventory-ledger.js';
import { openContainerFractionMultiplier } from './bulk-flavor.js';
import { isUniqueConstraintViolationOn } from './idempotency.js';

/**
 * Conteo físico semanal, ciego, por sabor y por producto cerrado (RF-012,
 * RF-020, RN-012..018, RN-025..028). Ver docs/ETAPA-4-APP-HELADERIA.md,
 * "Modelo de datos" y "Reconteo inteligente" para el razonamiento completo.
 *
 * Ciego (RN-012): mientras se cuenta, este servicio NO se invoca todavía --
 * el borrador vive enteramente en IndexedDB (sección 2 del prompt). Recién
 * al llamar `submitInventoryCount` se compara contra el teórico; nunca antes.
 */

const COUNT_IDEMPOTENCY_KEY_TARGET = ['organization_id', 'idempotency_key'] as const;
const COUNT_LOCATION_WEEK_TARGET = ['organization_id', 'location_id', 'week_start'] as const;

const countInclude = {
  location: { select: { name: true } },
  createdBy: { select: { displayName: true } },
  items: {
    include: { product: { select: { name: true, code: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.InventoryCountInclude;

type CountRow = Prisma.InventoryCountGetPayload<{ include: typeof countInclude }>;
type CountItemRow = CountRow['items'][number];

function mapCountItem(row: CountItemRow): InventoryCountItemResult {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.product.name,
    productCode: row.product.code,
    closedUnits: row.closedUnits,
    openUnits: row.openUnits,
    openFraction: row.openFraction,
    physicalQuantity: row.physicalQuantity.toFixed(3),
    theoreticalQuantity: row.theoreticalQuantity?.toFixed(3) ?? null,
    difference: row.difference?.toFixed(3) ?? null,
    needsRecount: row.needsRecount,
    recounted: row.recounted,
  };
}

function mapCount(row: CountRow): InventoryCountDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    locationId: row.locationId,
    locationName: row.location.name,
    weekStart: row.weekStart.toISOString().slice(0, 10),
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    recountedAt: row.recountedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdById: row.createdById,
    createdByName: row.createdBy.displayName,
    items: row.items.map(mapCountItem),
  };
}

function canonicalItemsForFingerprint(items: InventoryCountDraftItem[]) {
  return [...items]
    .map((item) => ({
      productId: item.productId,
      closedUnits: item.closedUnits ?? null,
      openUnits: item.openUnits ?? null,
      openFraction: item.openFraction ?? null,
    }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
}

/** Identidad semántica del envío (mismo criterio que Etapa 3.1/3.2, ver
 * `computeIdempotencyFingerprint` en inventory-ledger.ts): estos campos, y
 * sólo estos, definen "es la misma operación reenviada". */
function computeCountFingerprint(payload: {
  locationId: string;
  weekStart: string;
  items: InventoryCountDraftItem[];
}): string {
  return JSON.stringify({
    locationId: payload.locationId,
    weekStart: payload.weekStart,
    items: canonicalItemsForFingerprint(payload.items),
  });
}

async function resolveCountIdempotency(
  fastify: FastifyInstance,
  organizationId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<InventoryCountDto | null> {
  const existing = await fastify.db.inventoryCount.findFirst({
    where: { organizationId, idempotencyKey },
    include: countInclude,
  });
  if (!existing) return null;
  if (existing.idempotencyFingerprint === fingerprint) {
    return mapCount(existing);
  }
  throw new ConflictError(
    'Esta clave de idempotencia ya se usó para enviar un conteo distinto; no puede reutilizarse.',
  );
}

async function resolveCountIdempotencyConflictAfterRace(
  fastify: FastifyInstance,
  organizationId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<InventoryCountDto> {
  const winner = await fastify.db.inventoryCount.findFirst({
    where: { organizationId, idempotencyKey },
    include: countInclude,
  });
  if (!winner) {
    fastify.log.error(
      { organizationId, idempotencyKey },
      'Etapa 4: colisión UNIQUE de idempotencyKey de conteo sin fila encontrada al reconsultar',
    );
    throw new ConflictError(
      'No se pudo confirmar el resultado de este conteo por una condición de carrera inesperada; reintentá la solicitud.',
    );
  }
  if (winner.idempotencyFingerprint === fingerprint) {
    return mapCount(winner);
  }
  throw new ConflictError(
    'Esta clave de idempotencia ya se usó para enviar un conteo distinto; no puede reutilizarse.',
  );
}

function parseWeekStart(weekStart: string): Date {
  const date = new Date(`${weekStart}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('weekStart inválido: debe ser una fecha (YYYY-MM-DD)');
  }
  return date;
}

interface ComputedItem {
  productId: string;
  closedUnits: number | null;
  openUnits: number | null;
  openFraction: InventoryCountDraftItem['openFraction'] | null;
  physicalQuantity: Prisma.Decimal;
}

/** Valida un ítem del borrador y calcula su cantidad física canónica --
 * NUNCA el frontend: "la empleada no debe hacer multiplicaciones" (sección
 * 3 del prompt). */
async function computeItem(
  fastify: FastifyInstance,
  organizationId: string,
  item: InventoryCountDraftItem,
): Promise<ComputedItem> {
  const product = await assertProductForMovement(fastify, organizationId, item.productId);

  const closedUnits = item.closedUnits ?? null;
  const openUnits = item.openUnits ?? null;
  const openFraction = item.openFraction ?? null;

  if (closedUnits !== null && (!Number.isInteger(closedUnits) || closedUnits < 0)) {
    throw new ValidationError(`Cantidad de cerrados inválida para el producto ${product.name}`);
  }
  if (openUnits !== null && (!Number.isInteger(openUnits) || openUnits < 0)) {
    throw new ValidationError(`Cantidad de abiertos inválida para el producto ${product.name}`);
  }
  if (openFraction !== null && (openUnits === null || openUnits <= 0)) {
    throw new ValidationError(
      `La fracción estimada requiere al menos una unidad abierta (${product.name})`,
    );
  }
  if (product.flavorId && openUnits && openUnits > 0 && openFraction === null) {
    throw new ValidationError(
      `Falta indicar la fracción estimada de las unidades abiertas para el sabor ${product.name}`,
    );
  }
  if (closedUnits === null && openUnits === null) {
    throw new ValidationError(`Debe indicarse alguna cantidad contada para ${product.name}`);
  }

  const conversionFactor = new Prisma.Decimal(product.unitsPerHandlingUnit);
  const closedContribution = closedUnits
    ? new Prisma.Decimal(closedUnits).mul(conversionFactor)
    : new Prisma.Decimal(0);
  const openContribution = openFraction
    ? new Prisma.Decimal(openUnits ?? 0)
        .mul(openContainerFractionMultiplier(fastify, openFraction))
        .mul(conversionFactor)
    : new Prisma.Decimal(openUnits ?? 0);

  return {
    productId: item.productId,
    closedUnits,
    openUnits,
    openFraction,
    physicalQuantity: closedContribution.add(openContribution),
  };
}

function recountThresholdFor(
  fastify: FastifyInstance,
  isBulkFlavor: boolean,
): Prisma.Decimal | null {
  const value = isBulkFlavor
    ? fastify.config.shopOps.recountThresholdBulkFlavor
    : fastify.config.shopOps.recountThresholdClosedProducts;
  return value === undefined ? null : new Prisma.Decimal(value);
}

/**
 * Envío del conteo físico (RF-012). Crea el `InventoryCount` y sus líneas ya
 * comparadas contra el teórico -- el ciego (RN-012) lo garantiza el
 * FRONTEND no llamando a este endpoint hasta terminar de contar, nunca
 * mostrando lo que este servicio devuelve mientras tanto.
 */
export async function submitInventoryCount(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  input: SubmitInventoryCountInput,
): Promise<InventoryCountDto> {
  if (input.items.length === 0) {
    throw new ValidationError('El conteo requiere al menos un producto');
  }
  const productIds = new Set(input.items.map((item) => item.productId));
  if (productIds.size !== input.items.length) {
    throw new ValidationError('Un mismo producto no puede aparecer dos veces en el conteo');
  }

  const weekStart = parseWeekStart(input.weekStart);
  const fingerprint = computeCountFingerprint(input);

  const idempotent = await resolveCountIdempotency(
    fastify,
    organizationId,
    input.idempotencyKey,
    fingerprint,
  );
  if (idempotent) return idempotent;

  await assertLocationForMovement(fastify, organizationId, input.locationId);

  const existingForWeek = await fastify.db.inventoryCount.findFirst({
    where: { organizationId, locationId: input.locationId, weekStart },
  });
  if (existingForWeek) {
    throw new ConflictError('Ya existe un conteo cargado para esta ubicación en esta semana.');
  }

  const computedItems = await Promise.all(
    input.items.map((item) => computeItem(fastify, organizationId, item)),
  );

  const balances = await getStockBalances(fastify, organizationId, {
    locationId: input.locationId,
  });
  const theoreticalByProduct = new Map(
    balances.map((b) => [b.productId, new Prisma.Decimal(b.quantity)]),
  );

  const productFlavorFlags = await fastify.db.product.findMany({
    where: { organizationId, id: { in: [...productIds] } },
    select: { id: true, flavorId: true },
  });
  const isBulkFlavorByProduct = new Map(productFlavorFlags.map((p) => [p.id, p.flavorId !== null]));

  let anyNeedsRecount = false;
  const finalItems = computedItems.map((item) => {
    const theoreticalQuantity = theoreticalByProduct.get(item.productId) ?? new Prisma.Decimal(0);
    const difference = item.physicalQuantity.sub(theoreticalQuantity);
    const threshold = recountThresholdFor(
      fastify,
      isBulkFlavorByProduct.get(item.productId) ?? false,
    );
    const needsRecount = threshold !== null && difference.abs().greaterThan(threshold);
    if (needsRecount) anyNeedsRecount = true;
    return { ...item, theoreticalQuantity, difference, needsRecount };
  });

  const status = anyNeedsRecount ? 'RECOUNT_REQUIRED' : 'COMPLETED';

  try {
    return await fastify.db.$transaction(async (tx) => {
      const count = await tx.inventoryCount.create({
        data: {
          organizationId,
          locationId: input.locationId,
          weekStart,
          status,
          completedAt: status === 'COMPLETED' ? new Date() : null,
          createdById: actor.id,
          idempotencyKey: input.idempotencyKey,
          idempotencyFingerprint: fingerprint,
          items: {
            // Sin `organizationId` acá: es parte de la FK compuesta hacia el
            // propio `InventoryCount` padre (`count` relation, [organizationId,
            // countId]), así que Prisma lo completa solo a partir del padre --
            // pasarlo explícito en un create anidado da "Unknown argument".
            create: finalItems.map((item) => ({
              productId: item.productId,
              closedUnits: item.closedUnits,
              openUnits: item.openUnits,
              openFraction: item.openFraction ?? undefined,
              physicalQuantity: item.physicalQuantity,
              theoreticalQuantity: item.theoreticalQuantity,
              difference: item.difference,
              needsRecount: item.needsRecount,
            })),
          },
        },
        include: countInclude,
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'SHOP_COUNT_SUBMITTED',
        module: 'SHOP_OPS',
        entityType: 'inventory_count',
        entityId: count.id,
        afterValue: mapCount(count),
      });

      return mapCount(count);
    });
  } catch (err) {
    if (isUniqueConstraintViolationOn(err, COUNT_IDEMPOTENCY_KEY_TARGET)) {
      return resolveCountIdempotencyConflictAfterRace(
        fastify,
        organizationId,
        input.idempotencyKey,
        fingerprint,
      );
    }
    if (isUniqueConstraintViolationOn(err, COUNT_LOCATION_WEEK_TARGET)) {
      throw new ConflictError('Ya existe un conteo cargado para esta ubicación en esta semana.');
    }
    throw err;
  }
}

function itemMatchesResubmission(row: CountItemRow, item: InventoryCountDraftItem): boolean {
  return (
    row.closedUnits === (item.closedUnits ?? null) &&
    row.openUnits === (item.openUnits ?? null) &&
    row.openFraction === (item.openFraction ?? null)
  );
}

/**
 * Reconteo (sección 5 del prompt): un único reenvío adicional para los
 * ítems marcados `needsRecount` -- "solicitar SEGUNDO conteo", no un loop.
 * Idempotencia por VALOR (no por clave propia): dado que esta operación
 * está atada a un `InventoryCount` ya identificado por `countId`, un
 * reenvío se reconoce comparando los valores contra lo que ya quedó
 * guardado, en vez de agregar un segundo par de columnas de idempotencia
 * (ver docs/ETAPA-4-APP-HELADERIA.md, "Idempotencia").
 */
export async function submitInventoryRecount(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  countId: string,
  input: SubmitInventoryRecountInput,
): Promise<InventoryCountDto> {
  if (input.items.length === 0) {
    throw new ValidationError('El reconteo requiere al menos un producto');
  }

  const count = await fastify.db.inventoryCount.findFirst({
    where: { id: countId, organizationId },
    include: countInclude,
  });
  if (!count) {
    throw new NotFoundError('Conteo no encontrado en esta organización');
  }

  const flaggedIds = new Set(count.items.filter((i) => i.needsRecount).map((i) => i.productId));
  for (const item of input.items) {
    if (!flaggedIds.has(item.productId)) {
      throw new ValidationError(
        'El reconteo sólo puede reenviar productos marcados para recontar en este conteo',
      );
    }
  }

  if (count.status === 'COMPLETED') {
    // Posible retry legítimo del mismo reconteo -- compara valores, no una clave.
    const currentByProduct = new Map(count.items.map((i) => [i.productId, i]));
    const identical = input.items.every((item) => {
      const row = currentByProduct.get(item.productId);
      return row && row.recounted && itemMatchesResubmission(row, item);
    });
    if (identical) return mapCount(count);
    throw new ConflictError('Este conteo ya fue completado con valores de reconteo distintos.');
  }

  if (count.status !== 'RECOUNT_REQUIRED') {
    throw new ConflictError('Este conteo no está esperando un reconteo.');
  }

  const computedItems = await Promise.all(
    input.items.map((item) => computeItem(fastify, organizationId, item)),
  );
  const currentByProduct = new Map(count.items.map((i) => [i.productId, i]));

  try {
    return await fastify.db.$transaction(async (tx) => {
      const updateResult = await tx.inventoryCount.updateMany({
        where: { id: countId, organizationId, status: 'RECOUNT_REQUIRED' },
        data: { status: 'COMPLETED', recountedAt: new Date(), completedAt: new Date() },
      });
      if (updateResult.count === 0) {
        // Otra transacción ganó la carrera entre la lectura de arriba y acá.
        throw new ConflictError(
          'Este conteo ya fue completado por otra solicitud; volvé a consultarlo.',
        );
      }

      for (const item of computedItems) {
        const original = currentByProduct.get(item.productId);
        const theoreticalQuantity = original?.theoreticalQuantity ?? new Prisma.Decimal(0);
        const difference = item.physicalQuantity.sub(theoreticalQuantity);
        // Segundo conteo: no vuelve a marcar needsRecount aunque la
        // diferencia persista (sección 5 del prompt: un solo reenvío
        // adicional, no un loop -- ver docs/ETAPA-4-APP-HELADERIA.md).
        await tx.inventoryCountItem.updateMany({
          where: { organizationId, countId, productId: item.productId },
          data: {
            closedUnits: item.closedUnits,
            openUnits: item.openUnits,
            openFraction: item.openFraction ?? null,
            physicalQuantity: item.physicalQuantity,
            difference,
            recounted: true,
          },
        });
      }

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'SHOP_COUNT_RECOUNTED',
        module: 'SHOP_OPS',
        entityType: 'inventory_count',
        entityId: countId,
        beforeValue: mapCount(count),
      });

      const updated = await tx.inventoryCount.findFirstOrThrow({
        where: { id: countId, organizationId },
        include: countInclude,
      });
      return mapCount(updated);
    });
  } catch (err) {
    if (err instanceof ConflictError) throw err;
    throw err;
  }
}

export async function listInventoryCounts(
  fastify: FastifyInstance,
  organizationId: string,
  filters: InventoryCountFilters,
  pageInput: PageInput,
): Promise<Page<InventoryCountDto>> {
  const page = Math.max(1, pageInput.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, pageInput.pageSize ?? 20));

  const where: Prisma.InventoryCountWhereInput = {
    organizationId,
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };

  const [rows, total] = await Promise.all([
    fastify.db.inventoryCount.findMany({
      where,
      include: countInclude,
      orderBy: [{ weekStart: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    fastify.db.inventoryCount.count({ where }),
  ]);

  return { items: rows.map(mapCount), page, pageSize, total };
}

export async function getInventoryCountDetail(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
): Promise<InventoryCountDto> {
  const row = await fastify.db.inventoryCount.findFirst({
    where: { id, organizationId },
    include: countInclude,
  });
  if (!row) {
    throw new NotFoundError('Conteo no encontrado en esta organización');
  }
  return mapCount(row);
}
