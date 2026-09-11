import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  InventoryCount as InventoryCountDto,
  InventoryCountDraftItem,
  InventoryCountFilters,
  InventoryCountItemResult,
  InventoryCountTypoCandidate as TypoCandidateDto,
  Page,
  PageInput,
  PresentationBreakdownEntry,
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
import { resolveEffectivePricesForProducts } from './price-reference-mapping.js';
import {
  getActiveCountingPresentationsForProducts,
  type PresentationRow,
} from './product-counting-presentation.js';

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
const RECOUNT_IDEMPOTENCY_KEY_TARGET = ['organization_id', 'recount_idempotency_key'] as const;

const countInclude = {
  location: { select: { name: true } },
  createdBy: { select: { displayName: true } },
  items: {
    include: {
      product: { select: { name: true, code: true } },
      differenceResolvedBy: { select: { displayName: true } },
    },
    // `id: 'asc'` como desempate estable: dos ítems creados en la misma
    // transacción pueden tener el mismo `createdAt` (mismo timestamp de
    // Postgres), y sin un segundo criterio el orden entre ellos no está
    // garantizado -- nunca asumir un orden implícito basado sólo en
    // `createdAt` cuando puede haber empates.
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
  typoCandidates: {
    include: {
      shortageItem: { select: { productId: true, product: { select: { name: true } } } },
      surplusItem: { select: { productId: true, product: { select: { name: true } } } },
      resolvedBy: { select: { displayName: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.InventoryCountInclude;

type CountRow = Prisma.InventoryCountGetPayload<{ include: typeof countInclude }>;
type CountItemRow = CountRow['items'][number];
type TypoCandidateRow = CountRow['typoCandidates'][number];

function mapCountItem(row: CountItemRow): InventoryCountItemResult {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.product.name,
    productCode: row.product.code,
    closedUnits: row.closedUnits,
    openUnits: row.openUnits,
    openFraction: row.openFraction,
    depositoClosedUnits: row.depositoClosedUnits,
    presentationBreakdown:
      (row.presentationBreakdown as PresentationBreakdownEntry[] | null) ?? null,
    physicalQuantity: row.physicalQuantity.toFixed(3),
    theoreticalQuantity: row.theoreticalQuantity?.toFixed(3) ?? null,
    difference: row.difference?.toFixed(3) ?? null,
    needsRecount: row.needsRecount,
    recounted: row.recounted,
    differenceResolution: row.differenceResolution,
    differenceResolvedById: row.differenceResolvedById,
    differenceResolvedByName: row.differenceResolvedBy?.displayName ?? null,
    differenceResolvedAt: row.differenceResolvedAt?.toISOString() ?? null,
    differenceResolutionNote: row.differenceResolutionNote,
  };
}

function mapTypoCandidate(row: TypoCandidateRow): TypoCandidateDto {
  return {
    id: row.id,
    countId: row.countId,
    shortageItemId: row.shortageItemId,
    shortageProductId: row.shortageItem.productId,
    shortageProductName: row.shortageItem.product.name,
    surplusItemId: row.surplusItemId,
    surplusProductId: row.surplusItem.productId,
    surplusProductName: row.surplusItem.product.name,
    compensatingQuantity: row.compensatingQuantity.toFixed(3),
    salePriceUsed: row.salePriceUsed.toFixed(2),
    status: row.status,
    resolvedById: row.resolvedById,
    resolvedByName: row.resolvedBy?.displayName ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString(),
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
    typoCandidates: row.typoCandidates.map(mapTypoCandidate),
  };
}

/**
 * Umbral PORCENTUAL obligatorio de reconteo por faltante (Etapa 6.2, sección
 * 4 del prompt, CONFIRMADO textualmente por el cliente: "un faltante ≥25%
 * del teórico dispara reconteo obligatorio"). A diferencia de
 * `RECOUNT_THRESHOLD_CLOSED_PRODUCTS`/`RECOUNT_THRESHOLD_BULK_FLAVOR`
 * (umbrales ABSOLUTOS, opcionales, nunca confirmados con un valor concreto
 * -- Etapa 4.1), este 25% SÍ es un literal confirmado por el cliente, igual
 * criterio que las fracciones de `OpenContainerFraction` -- se usa como
 * constante, sin exponerlo como variable de entorno. Es una regla ADICIONAL
 * sobre el MISMO campo `needsRecount`/estado `RECOUNT_REQUIRED` de Etapa 4
 * (nunca un sistema paralelo): el estado final es la unión de ambas reglas.
 * Sólo aplica a FALTANTES (RN nueva, sección 4: nunca a sobrantes -- un
 * sobrante grande puede disparar el umbral ABSOLUTO si está configurado,
 * pero no este 25%, que es específico de faltante).
 */
const MANDATORY_SHORTAGE_RECOUNT_PERCENTAGE = new Prisma.Decimal('0.25');

/**
 * = |difference| / theoreticalQuantity >= 25%, sólo para FALTANTE
 * (difference negativo). Maneja teórico cero o negativo SIN dividir por
 * cero/negativo (sección 4 del prompt): en ese caso el porcentaje no está
 * definido de forma significativa, así que esta regla simplemente no se
 * activa -- el umbral ABSOLUTO configurado (si existe) sigue disponible
 * para cubrir ese caso por su cuenta, sin necesitar una convención inventada
 * de "qué es un 25% de un teórico negativo".
 */
function exceedsMandatoryShortagePercentage(
  difference: Prisma.Decimal,
  theoreticalQuantity: Prisma.Decimal,
): boolean {
  if (!difference.isNegative()) return false;
  if (theoreticalQuantity.lessThanOrEqualTo(0)) return false;
  const shortagePercentage = difference.abs().div(theoreticalQuantity);
  return shortagePercentage.greaterThanOrEqualTo(MANDATORY_SHORTAGE_RECOUNT_PERCENTAGE);
}

/**
 * Posible error de tipeo (Etapa 6.2, sección 6 del prompt, CONFIRMADO): un
 * FALTANTE en un producto compensado EXACTAMENTE por un SOBRANTE en otro,
 * ambos con el MISMO precio de VENTA vigente (nunca costo). Genera TODAS
 * las combinaciones que califiquen -- soporta múltiples candidatos
 * ambiguos sin decidir cuál es "el correcto" (sección 6: nunca decidir sola
 * la dirección). Se llama DENTRO de la transacción que deja el conteo
 * COMPLETED (directo o tras reconteo) -- nunca antes, para trabajar siempre
 * sobre las diferencias FINALES. Nunca modifica `Sale`/`InventoryMovement`.
 *
 * Etapa 6.2.2, sección 13 del prompt (CORRECCIÓN, CONFIRMADO): el precio de
 * VENTA usado como evidencia debe ser el vigente para la SEMANA del conteo
 * que se está analizando, nunca "ahora" (el instante en que el backend
 * procesa el envío) -- mismo razonamiento y mismo mecanismo que la
 * corrección de `asOfDate` en la valorización del cierre (Etapa 6.2.1,
 * sección 9): analizar hoy un conteo viejo (ej. al confirmar tarde un
 * reconteo, o simplemente por la fecha real del servidor) no debe usar un
 * precio que cambió DESPUÉS de esa semana. `asOfDate` la pasa el llamador,
 * calculada una sola vez a partir de `InventoryCount.weekStart` (el domingo
 * de esa semana, `weekEndDate`) -- nunca `new Date()`.
 */
async function detectAndPersistTypoCandidates(
  tx: Prisma.TransactionClient,
  organizationId: string,
  countId: string,
  asOfDate: Date,
): Promise<void> {
  const items = await tx.inventoryCountItem.findMany({
    where: { organizationId, countId },
    select: { id: true, productId: true, difference: true },
  });
  const shortages = items.filter((i) => i.difference !== null && i.difference.isNegative());
  const surpluses = items.filter((i) => i.difference !== null && i.difference.isPositive());
  if (shortages.length === 0 || surpluses.length === 0) return;

  const productIds = [...new Set([...shortages, ...surpluses].map((i) => i.productId))];
  const priceByProduct = await resolveEffectivePricesForProducts(
    tx,
    organizationId,
    productIds,
    'SALE_PRICE',
    asOfDate,
  );

  for (const shortage of shortages) {
    const shortagePrice = priceByProduct.get(shortage.productId);
    if (!shortagePrice || shortagePrice.status !== 'OK') continue;

    for (const surplus of surpluses) {
      if (surplus.productId === shortage.productId) continue;
      if (!shortage.difference!.abs().equals(surplus.difference!)) continue;

      const surplusPrice = priceByProduct.get(surplus.productId);
      if (!surplusPrice || surplusPrice.status !== 'OK') continue;
      if (!shortagePrice.value.equals(surplusPrice.value)) continue;

      await tx.inventoryCountTypoCandidate.upsert({
        where: {
          organizationId_countId_shortageItemId_surplusItemId: {
            organizationId,
            countId,
            shortageItemId: shortage.id,
            surplusItemId: surplus.id,
          },
        },
        create: {
          organizationId,
          countId,
          shortageItemId: shortage.id,
          surplusItemId: surplus.id,
          compensatingQuantity: shortage.difference!.abs(),
          salePriceUsed: shortagePrice.value,
        },
        // Nunca pisa un candidato ya revisado (CONFIRMED/REJECTED) -- sólo
        // asegura que exista, idempotente ante cualquier reintento.
        update: {},
      });
    }
  }
}

function canonicalItemsForFingerprint(items: InventoryCountDraftItem[]) {
  return [...items]
    .map((item) => ({
      productId: item.productId,
      closedUnits: item.closedUnits ?? null,
      openUnits: item.openUnits ?? null,
      openFraction: item.openFraction ?? null,
      depositoClosedUnits: item.depositoClosedUnits ?? null,
      // Etapa 6.2.2: sin esto, dos envíos con el MISMO idempotencyKey pero
      // presentaciones DISTINTAS para un producto (ej. "2 cajas" vs "3
      // cajas") serían indistinguibles para la reconsulta de idempotencia
      // -- quedaría silenciosamente devolviendo el resultado del primero.
      // Ordenado por `presentationId` para que el orden en que se tipeó
      // cada presentación no altere la huella.
      presentations: item.presentations
        ? [...item.presentations]
            .map((p) => ({ presentationId: p.presentationId, quantity: p.quantity }))
            .sort((a, b) => a.presentationId.localeCompare(b.presentationId))
        : null,
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

/**
 * Identidad semántica del RECONTEO (Etapa 4.1, sección 3) -- distinta de
 * `computeCountFingerprint` de arriba (esa es del envío ORIGINAL, una
 * operación diferente; nunca se reutiliza ambiguamente). Incluye
 * `countId` porque el reconteo está atado a un conteo puntual: los mismos
 * valores enviados para dos conteos distintos NO son "la misma operación".
 * `canonicalItemsForFingerprint` ya ordena por `productId`, así que el
 * orden del array de entrada no afecta el resultado.
 */
function computeRecountFingerprint(countId: string, items: InventoryCountDraftItem[]): string {
  return JSON.stringify({ countId, items: canonicalItemsForFingerprint(items) });
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

/**
 * Resolución explícita de carrera del RECONTEO (Etapa 4.1, sección 4):
 * Postgres (el UPDATE condicional + este índice único) sigue siendo la
 * única fuente de verdad -- acá sólo se reconsulta lo que YA quedó
 * persistido para decidir si el request que perdió la carrera (o un
 * P2002 real por reutilizar la clave en otro conteo) representa la MISMA
 * operación (mismo `countId` + misma clave + mismo fingerprint -> éxito
 * idempotente) o una incompatible (-> 409). Nunca locks/mutex/sleeps: sólo
 * una lectura después del hecho.
 */
async function resolveRecountConflictAfterRace(
  fastify: FastifyInstance,
  organizationId: string,
  countId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<InventoryCountDto> {
  const winner = await fastify.db.inventoryCount.findFirst({
    where: { id: countId, organizationId },
    include: countInclude,
  });
  if (!winner) {
    fastify.log.error(
      { organizationId, countId, idempotencyKey },
      'Etapa 4.1: colisión de idempotencia de reconteo sin conteo encontrado al reconsultar',
    );
    throw new ConflictError(
      'No se pudo confirmar el resultado de este reconteo por una condición de carrera inesperada; reintentá la solicitud.',
    );
  }
  if (
    winner.recountIdempotencyKey === idempotencyKey &&
    winner.recountIdempotencyFingerprint === fingerprint
  ) {
    return mapCount(winner);
  }
  throw new ConflictError('Este conteo ya fue completado con un reconteo distinto.');
}

function parseWeekStart(weekStart: string): Date {
  const date = new Date(`${weekStart}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('weekStart inválido: debe ser una fecha (YYYY-MM-DD)');
  }
  return date;
}

/** Domingo de la semana contada (`weekStart + 6 días`) -- misma noción de
 * "fecha estable del período" que `closing.periodEnd` en weekly-closing.ts
 * (Etapa 6.2.1, sección 9), usada acá para resolver el precio de venta
 * histórico de `detectAndPersistTypoCandidates`. */
function weekEndDate(weekStart: Date): Date {
  const end = new Date(weekStart);
  end.setUTCDate(end.getUTCDate() + 6);
  return end;
}

interface ComputedItem {
  productId: string;
  closedUnits: number | null;
  openUnits: number | null;
  openFraction: InventoryCountDraftItem['openFraction'] | null;
  depositoClosedUnits: number | null;
  presentationBreakdown: PresentationBreakdownEntry[] | null;
  physicalQuantity: Prisma.Decimal;
}

/** Valida un ítem del borrador y calcula su cantidad física canónica --
 * NUNCA el frontend: "la empleada no debe hacer multiplicaciones" (sección
 * 3 del prompt). */
async function computeItem(
  fastify: FastifyInstance,
  organizationId: string,
  item: InventoryCountDraftItem,
  presentationsByProduct: Map<string, PresentationRow[]>,
): Promise<ComputedItem> {
  const product = await assertProductForMovement(fastify, organizationId, item.productId);

  const closedUnits = item.closedUnits ?? null;
  const openUnits = item.openUnits ?? null;
  const openFraction = item.openFraction ?? null;
  const depositoClosedUnits = item.depositoClosedUnits ?? null;
  const presentations = item.presentations ?? null;

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
  // Etapa 6.2.1, secciones 2/3/4 del prompt: la columna "Depósito" de la
  // planilla real sólo existe para SABORES -- ver el comentario extenso de
  // `InventoryCountItem.depositoClosedUnits` en schema.prisma. Un producto
  // sin sabor no tiene esa columna en el catálogo/conversiones, así que
  // recibirla acá sería precisamente "inventar una configuración que no
  // existe" (sección 4 del prompt): se rechaza explícitamente en vez de
  // aceptarla en silencio.
  if (depositoClosedUnits !== null && !product.flavorId) {
    throw new ValidationError(
      `El producto ${product.name} no es un sabor: no admite existencia de depósito`,
    );
  }
  if (
    depositoClosedUnits !== null &&
    (!Number.isInteger(depositoClosedUnits) || depositoClosedUnits < 0)
  ) {
    throw new ValidationError(
      `Cantidad de existencia en depósito inválida para el producto ${product.name}`,
    );
  }

  // Etapa 6.2.2, secciones 14/15/16/17/18 del prompt: si el producto tiene
  // presentaciones de conteo ACTIVAS configuradas (Unidad/Caja/Pack u
  // otras), `presentations` REEMPLAZA a `closedUnits` para ese ítem -- los
  // dos a la vez son ambiguos (¿cuál manda?) y se rechazan explícitamente.
  // Un producto SIN presentaciones configuradas sigue usando `closedUnits`
  // tal cual (compatibilidad total, sección 16) -- enviar `presentations`
  // para un producto así también se rechaza (no hay nada que resolver).
  const activePresentations = presentationsByProduct.get(product.id) ?? [];
  let presentationBreakdown: PresentationBreakdownEntry[] | null = null;
  let closedContribution: Prisma.Decimal;
  const conversionFactor = new Prisma.Decimal(product.unitsPerHandlingUnit);

  if (activePresentations.length > 0) {
    if (closedUnits !== null) {
      throw new ValidationError(
        `El producto ${product.name} tiene presentaciones de conteo configuradas: usá "presentations" en vez de "closedUnits"`,
      );
    }
    if (presentations === null || presentations.length === 0) {
      throw new ValidationError(
        `Debe indicarse la cantidad contada por presentación para ${product.name}`,
      );
    }
    const presentationById = new Map(activePresentations.map((p) => [p.id, p]));
    const seenPresentationIds = new Set<string>();
    let sum = new Prisma.Decimal(0);
    const breakdown: PresentationBreakdownEntry[] = [];
    for (const entry of presentations) {
      if (seenPresentationIds.has(entry.presentationId)) {
        throw new ValidationError(`Presentación duplicada en el mismo ítem para ${product.name}`);
      }
      seenPresentationIds.add(entry.presentationId);
      const presentation = presentationById.get(entry.presentationId);
      if (!presentation) {
        throw new ValidationError(
          `La presentación indicada no existe, no está activa, o no pertenece a ${product.name}`,
        );
      }
      if (!Number.isInteger(entry.quantity) || entry.quantity < 0) {
        throw new ValidationError(`Cantidad inválida para una presentación de ${product.name}`);
      }
      sum = sum.add(
        new Prisma.Decimal(entry.quantity).mul(presentation.conversionFactorToCanonical),
      );
      breakdown.push({
        presentationId: presentation.id,
        unitOfMeasureName: presentation.unitOfMeasure.name,
        quantity: entry.quantity,
        conversionFactorToCanonical: presentation.conversionFactorToCanonical.toFixed(3),
      });
    }
    closedContribution = sum;
    presentationBreakdown = breakdown;
  } else {
    if (presentations !== null) {
      throw new ValidationError(
        `El producto ${product.name} no tiene presentaciones de conteo configuradas`,
      );
    }
    closedContribution = closedUnits
      ? new Prisma.Decimal(closedUnits).mul(conversionFactor)
      : new Prisma.Decimal(0);
  }

  if (
    closedUnits === null &&
    openUnits === null &&
    depositoClosedUnits === null &&
    presentationBreakdown === null
  ) {
    throw new ValidationError(`Debe indicarse alguna cantidad contada para ${product.name}`);
  }

  const openContribution = openFraction
    ? new Prisma.Decimal(openUnits ?? 0)
        .mul(openContainerFractionMultiplier(fastify, openFraction))
        .mul(conversionFactor)
    : new Prisma.Decimal(openUnits ?? 0);
  // Misma mecánica que `closedContribution` -- Salón-cerrada y
  // Depósito-existencia son ambas latas CERRADAS del mismo producto en la
  // misma `Location`, así que se suman con el mismo factor de conversión
  // (nunca una fracción nueva, nunca un teórico/ledger separado).
  const depositoContribution = depositoClosedUnits
    ? new Prisma.Decimal(depositoClosedUnits).mul(conversionFactor)
    : new Prisma.Decimal(0);

  return {
    productId: item.productId,
    closedUnits,
    openUnits,
    openFraction,
    depositoClosedUnits,
    presentationBreakdown,
    physicalQuantity: closedContribution.add(openContribution).add(depositoContribution),
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

  // Etapa 6.2.2, secciones 1/2/5 del prompt (BLOCKER, CONFIRMADO): el
  // conteo semanal INICIAL debe cubrir el universo obligatorio completo --
  // nunca puede quedar COMPLETED con productos faltantes. El universo se
  // determina de forma AUTORITATIVA en el backend, nunca confiando en lo
  // que mandó el cliente: todo producto ACTIVO de esta organización (el
  // catálogo de Etapa 2 no tiene ninguna distinción explícita de
  // "inventariable/no contable" todavía -- sección 2 del prompt: "si no
  // existe esa distinción, no inventarla silenciosamente" -- así que se usa
  // la interpretación más consistente con el sistema actual: exactamente el
  // mismo conjunto que ya devuelve `GET /api/products` filtrado por
  // `active`, que es lo que la Shop PWA ya carga y muestra para contar
  // desde Etapa 6.2.1). El catálogo es único por organización, sin
  // restricción por ubicación en el modelo actual -- no hay nada que
  // filtrar por `locationId` acá (documentado, no inventado). Se valida
  // ANTES de tocar la base (ningún `InventoryCount` parcial) y DESPUÉS de
  // la resolución de idempotencia (un reintento de un envío que ya tuvo
  // éxito nunca debe fallar retroactivamente por cambios posteriores del
  // catálogo).
  const requiredProducts = await fastify.db.product.findMany({
    where: { organizationId, active: true },
    select: { id: true, name: true },
  });
  const missingProducts = requiredProducts.filter((p) => !productIds.has(p.id));
  if (missingProducts.length > 0) {
    throw new ValidationError(
      `Faltan ${missingProducts.length} producto(s) por contar: ${missingProducts.map((p) => p.name).join(', ')}`,
    );
  }

  await assertLocationForMovement(fastify, organizationId, input.locationId);

  const existingForWeek = await fastify.db.inventoryCount.findFirst({
    where: { organizationId, locationId: input.locationId, weekStart },
  });
  if (existingForWeek) {
    throw new ConflictError('Ya existe un conteo cargado para esta ubicación en esta semana.');
  }

  const presentationsByProduct = await getActiveCountingPresentationsForProducts(
    fastify.db,
    organizationId,
    [...productIds],
  );
  const computedItems = await Promise.all(
    input.items.map((item) => computeItem(fastify, organizationId, item, presentationsByProduct)),
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
    const exceedsAbsoluteThreshold = threshold !== null && difference.abs().greaterThan(threshold);
    const exceedsMandatoryShortage = exceedsMandatoryShortagePercentage(
      difference,
      theoreticalQuantity,
    );
    const needsRecount = exceedsAbsoluteThreshold || exceedsMandatoryShortage;
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
              depositoClosedUnits: item.depositoClosedUnits,
              presentationBreakdown: item.presentationBreakdown
                ? (item.presentationBreakdown as unknown as Prisma.InputJsonValue)
                : undefined,
              physicalQuantity: item.physicalQuantity,
              theoreticalQuantity: item.theoreticalQuantity,
              difference: item.difference,
              needsRecount: item.needsRecount,
            })),
          },
        },
        include: countInclude,
      });

      // Etapa 6.2, sección 6 del prompt: sólo se detectan candidatos de
      // tipeo cuando el conteo queda COMPLETED de una (sin reconteo
      // pendiente) -- si algún ítem quedó RECOUNT_REQUIRED, las diferencias
      // todavía no son finales; la detección se repite al completar el
      // reconteo (ver `submitInventoryRecount`).
      if (status === 'COMPLETED') {
        await detectAndPersistTypoCandidates(tx, organizationId, count.id, weekEndDate(weekStart));
      }

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

      const final =
        status === 'COMPLETED'
          ? await tx.inventoryCount.findFirstOrThrow({
              where: { id: count.id, organizationId },
              include: countInclude,
            })
          : count;
      return mapCount(final);
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

/**
 * Reconteo (sección 5 del prompt original): un único reenvío adicional
 * para los ítems marcados `needsRecount` -- "solicitar SEGUNDO conteo", no
 * un loop.
 *
 * Idempotencia (Etapa 4.1, secciones 2/3/4 del hardening): clave +
 * fingerprint propios (`InventoryCount.recountIdempotencyKey`/
 * `recountIdempotencyFingerprint`, columnas separadas de las del envío
 * ORIGINAL del conteo -- nunca se reutiliza ambiguamente una clave para dos
 * operaciones distintas), con el mismo criterio de Etapa 3.1/3.2: la
 * identidad semántica del reconteo es `countId` + los productos
 * recontados + los valores físicos enviados, canonicalizados para que el
 * orden del array no la altere (`computeRecountFingerprint`).
 *
 * Concurrencia: Postgres sigue siendo la única fuente de verdad. El UPDATE
 * condicional (`status: RECOUNT_REQUIRED -> COMPLETED`) serializa a los
 * requests concurrentes vía el lock de fila que Postgres ya toma en el
 * propio UPDATE (mismo mecanismo que `reverseMovement`, Etapa 3.1,
 * Problema 1) -- nunca un lock en memoria ni un mutex por proceso, así que
 * funciona igual con una o con varias instancias del backend. El request
 * que "pierde" la carrera (`updateResult.count === 0`) nunca asume que es
 * un conflicto: reconsulta lo que quedó persistido
 * (`resolveRecountConflictAfterRace`) y sólo si NO coincide con su propia
 * clave+fingerprint responde 409 -- si coincide, es el mismo retry y
 * devuelve el mismo resultado exitoso que el ganador, sin volver a auditar
 * ni a escribir nada.
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

  const fingerprint = computeRecountFingerprint(countId, input.items);

  // Idempotencia primaria: esta MISMA clave ya se usó para el reconteo de
  // ESTE conteo -- cubre tanto el retry secuencial (después de COMPLETED)
  // como el caso en el que este request perdió una carrera concurrente
  // contra sí mismo (mismo cliente, mismo idempotencyKey persistido).
  if (count.recountIdempotencyKey !== null) {
    if (
      count.recountIdempotencyKey === input.idempotencyKey &&
      count.recountIdempotencyFingerprint === fingerprint
    ) {
      return mapCount(count);
    }
    throw new ConflictError(
      count.recountIdempotencyKey === input.idempotencyKey
        ? 'Esta clave de idempotencia ya se usó para un reconteo distinto de este conteo; no puede reutilizarse.'
        : 'Este conteo ya fue completado con un reconteo distinto.',
    );
  }

  if (count.status !== 'RECOUNT_REQUIRED') {
    throw new ConflictError('Este conteo no está esperando un reconteo.');
  }

  const presentationsByProduct = await getActiveCountingPresentationsForProducts(
    fastify.db,
    organizationId,
    input.items.map((item) => item.productId),
  );
  const computedItems = await Promise.all(
    input.items.map((item) => computeItem(fastify, organizationId, item, presentationsByProduct)),
  );
  const currentByProduct = new Map(count.items.map((i) => [i.productId, i]));

  try {
    return await fastify.db.$transaction(async (tx) => {
      const updateResult = await tx.inventoryCount.updateMany({
        where: { id: countId, organizationId, status: 'RECOUNT_REQUIRED' },
        data: {
          status: 'COMPLETED',
          recountedAt: new Date(),
          completedAt: new Date(),
          recountIdempotencyKey: input.idempotencyKey,
          recountIdempotencyFingerprint: fingerprint,
        },
      });
      if (updateResult.count === 0) {
        // Otra transacción ganó la carrera entre la lectura de arriba y
        // acá -- se resuelve AFUERA de esta transacción (ver el catch),
        // reconsultando lo que esa otra transacción efectivamente dejó
        // persistido, nunca asumiendo un conflicto sin comparar.
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
            depositoClosedUnits: item.depositoClosedUnits,
            presentationBreakdown: item.presentationBreakdown
              ? (item.presentationBreakdown as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            physicalQuantity: item.physicalQuantity,
            difference,
            recounted: true,
          },
        });
      }

      // El reconteo siempre deja el conteo COMPLETED (una sola ronda
      // adicional) -- las diferencias ya son finales, se detectan
      // candidatos de tipeo acá (sección 6 del prompt de Etapa 6.2), usando
      // el mismo `weekEndDate(count.weekStart)` que el envío original --
      // ambos analizan la MISMA semana, nunca "ahora" (sección 13 del
      // prompt de Etapa 6.2.2).
      await detectAndPersistTypoCandidates(
        tx,
        organizationId,
        countId,
        weekEndDate(count.weekStart),
      );

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
    if (isUniqueConstraintViolationOn(err, RECOUNT_IDEMPOTENCY_KEY_TARGET)) {
      return resolveRecountConflictAfterRace(
        fastify,
        organizationId,
        countId,
        input.idempotencyKey,
        fingerprint,
      );
    }
    if (err instanceof ConflictError) {
      return resolveRecountConflictAfterRace(
        fastify,
        organizationId,
        countId,
        input.idempotencyKey,
        fingerprint,
      );
    }
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
