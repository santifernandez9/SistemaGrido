import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  CloseWeeklyClosingInput,
  Page,
  PageInput,
  PrepareWeeklyClosingInput,
  ReopenWeeklyClosingInput,
  WeeklyClosing as WeeklyClosingDto,
  WeeklyClosingChecklist,
  WeeklyClosingDetail,
  WeeklyClosingFilters,
  WeeklyClosingItem,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ConflictError, InternalError, NotFoundError, ValidationError } from '../errors.js';
import { assertLocationForMovement } from './inventory-ledger.js';
import { isUniqueConstraintViolationOn } from './idempotency.js';

/**
 * Cierre Semanal del núcleo operativo (Etapa 6) -- ver
 * docs/ETAPA-6-CIERRE-SEMANAL.md. `InventoryMovement` sigue siendo la única
 * fuente de verdad de stock (sección 2 del prompt): este servicio sólo
 * consulta el ledger y el conteo ya persistidos (Etapa 3/4), compara
 * teórico vs real, y genera COUNT_CORRECTION + un snapshot histórico al
 * cerrar -- nunca escribe stock directamente ni recalcula el teórico por
 * fuera de `InventoryCountItem`.
 */

const LOCATION_PERIOD_START_UNIQUE_TARGET = [
  'organization_id',
  'location_id',
  'period_start',
] as const;
const CLOSE_IDEMPOTENCY_KEY_TARGET = ['organization_id', 'close_idempotency_key'] as const;

const closingInclude = {
  location: { select: { name: true } },
  createdBy: { select: { displayName: true } },
  reviewConfirmedBy: { select: { displayName: true } },
  closedBy: { select: { displayName: true } },
  reopenedBy: { select: { displayName: true } },
} satisfies Prisma.WeeklyClosingInclude;

type ClosingRow = Prisma.WeeklyClosingGetPayload<{ include: typeof closingInclude }>;

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function mapClosing(row: ClosingRow): WeeklyClosingDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    locationId: row.locationId,
    locationName: row.location.name,
    periodStart: toIsoDate(row.periodStart),
    periodEnd: toIsoDate(row.periodEnd),
    status: row.status,
    currentRevision: row.currentRevision,
    reviewConfirmedById: row.reviewConfirmedById,
    reviewConfirmedByName: row.reviewConfirmedBy?.displayName ?? null,
    reviewConfirmedAt: row.reviewConfirmedAt?.toISOString() ?? null,
    createdById: row.createdById,
    createdByName: row.createdBy.displayName,
    createdAt: row.createdAt.toISOString(),
    closedById: row.closedById,
    closedByName: row.closedBy?.displayName ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    reopenedById: row.reopenedById,
    reopenedByName: row.reopenedBy?.displayName ?? null,
    reopenedAt: row.reopenedAt?.toISOString() ?? null,
    reopenReason: row.reopenReason,
  };
}

/**
 * `periodStart` siempre debe caer en lunes (documento del cliente, sección
 * 24: "Período: lunes a domingo") -- se valida acá en vez de dejar que un
 * período desalineado genere un `WeeklyClosing` que nunca podría coincidir
 * con la semana real de ningún `InventoryCount`.
 */
function parsePeriodStart(periodStart: string): Date {
  const date = new Date(`${periodStart}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('periodStart inválido: debe ser una fecha (YYYY-MM-DD)');
  }
  if (date.getUTCDay() !== 1) {
    throw new ValidationError(
      'periodStart debe ser un lunes (documento del cliente, sección 24: "Período: lunes a domingo")',
    );
  }
  return date;
}

/**
 * Qué conteo gobierna el cierre de [periodStart..periodEnd]: el tomado el
 * lunes SIGUIENTE (periodStart + 7 días), no el del propio periodStart --
 * ver el comentario extenso en `WeeklyClosing` del schema (sección
 * "Período semanal" de docs/ETAPA-6-CIERRE-SEMANAL.md para el ejemplo
 * completo de fechas).
 */
function governingCountWeekStart(periodStart: Date): Date {
  const weekStart = new Date(periodStart);
  weekStart.setUTCDate(weekStart.getUTCDate() + 7);
  return weekStart;
}

interface GoverningCount {
  weekStart: Date;
  count: Prisma.InventoryCountGetPayload<Record<string, never>> | null;
}

async function loadGoverningCount(
  fastify: FastifyInstance,
  organizationId: string,
  closing: Pick<ClosingRow, 'locationId' | 'periodStart'>,
): Promise<GoverningCount> {
  const weekStart = governingCountWeekStart(closing.periodStart);
  const count = await fastify.db.inventoryCount.findFirst({
    where: { organizationId, locationId: closing.locationId, weekStart },
  });
  return { weekStart, count };
}

/**
 * Checklist previo al cierre (sección 5 del prompt). `countSubmitted` es la
 * única sub-condición auto-verificada e inequívoca; mermas/gastos/ventas
 * son sólo informativos (nunca bloquean por sí solos, sección 5: "no
 * inventar 'debe haber al menos una merma'"). El bloqueo adicional es el
 * gesto ÚNICO de revisión del ADMIN (`reviewConfirmedById`).
 */
async function computeChecklist(
  fastify: FastifyInstance,
  organizationId: string,
  closing: ClosingRow,
  governing: GoverningCount,
): Promise<WeeklyClosingChecklist> {
  // Ventana [periodStart, periodStart + 7 días) -- cubre exactamente
  // lunes..domingo del período (`periodEnd` es un DATE a medianoche UTC, así
  // que "< periodStart + 7 días" incluye todo el domingo sin depender de la
  // hora exacta de `occurredAt`).
  const periodEndExclusive = new Date(closing.periodStart);
  periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 7);

  const [salesImportsTotal, salesImportsConfirmed, wastesTotal, variableExpensesTotal] =
    await Promise.all([
      // Las ventas importadas se identifican por SOLAPAMIENTO con el período
      // del cierre -- `SalesImport.periodStart/periodEnd` es el rango que el
      // propio archivo del POS declara (Etapa 5), no necesariamente
      // alineado lunes-a-domingo.
      fastify.db.salesImport.count({
        where: {
          organizationId,
          locationId: closing.locationId,
          periodStart: { lte: closing.periodEnd },
          periodEnd: { gte: closing.periodStart },
        },
      }),
      fastify.db.salesImport.count({
        where: {
          organizationId,
          locationId: closing.locationId,
          periodStart: { lte: closing.periodEnd },
          periodEnd: { gte: closing.periodStart },
          status: 'CONFIRMED',
        },
      }),
      fastify.db.waste.count({
        where: {
          organizationId,
          movement: {
            locationId: closing.locationId,
            occurredAt: { gte: closing.periodStart, lt: periodEndExclusive },
          },
        },
      }),
      fastify.db.variableExpense.count({
        where: {
          organizationId,
          locationId: closing.locationId,
          occurredAt: { gte: closing.periodStart, lt: periodEndExclusive },
        },
      }),
    ]);

  const countSubmitted = governing.count?.status === 'COMPLETED';
  const reviewConfirmed = closing.reviewConfirmedById !== null;

  return {
    countSubmitted,
    governingCountId: governing.count?.id ?? null,
    governingCountWeekStart: toIsoDate(governing.weekStart),
    governingCountStatus: governing.count?.status ?? null,
    salesImportsTotal,
    salesImportsConfirmed,
    wastesTotal,
    variableExpensesTotal,
    reviewConfirmedById: closing.reviewConfirmedById,
    reviewConfirmedByName: closing.reviewConfirmedBy?.displayName ?? null,
    reviewConfirmedAt: closing.reviewConfirmedAt?.toISOString() ?? null,
    canClose: closing.status !== 'CLOSED' && countSubmitted && reviewConfirmed,
  };
}

/**
 * Líneas teórico/real/diferencia EN VIVO, calculadas contra el conteo
 * gobernante -- nunca persistidas todavía (sección 7/9 del prompt: se
 * copian directamente de `InventoryCountItem`, nunca se recalculan). Se
 * usan tanto para el preview (antes de cerrar) como, dentro de `closeWeeklyClosing`,
 * como la fuente exacta de lo que se persiste en `InventorySnapshotItem`.
 */
async function computeLiveItems(
  fastify: FastifyInstance,
  organizationId: string,
  governing: GoverningCount,
): Promise<WeeklyClosingItem[]> {
  if (!governing.count) return [];
  const items = await fastify.db.inventoryCountItem.findMany({
    where: { organizationId, countId: governing.count.id },
    include: { product: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return items
    .filter((item) => item.theoreticalQuantity !== null && item.difference !== null)
    .map((item) => ({
      productId: item.productId,
      productName: item.product.name,
      quantityTheoretical: item.theoreticalQuantity!.toFixed(3),
      quantityReal: item.physicalQuantity.toFixed(3),
      difference: item.difference!.toFixed(3),
      countCorrectionMovementId: null,
    }));
}

/** Líneas PERSISTIDAS e INMUTABLES de una revisión ya cerrada. */
async function loadPersistedItems(
  fastify: FastifyInstance,
  organizationId: string,
  weeklyClosingId: string,
  revision: number,
): Promise<WeeklyClosingItem[]> {
  const rows = await fastify.db.inventorySnapshotItem.findMany({
    where: { organizationId, weeklyClosingId, revision },
    include: { product: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => ({
    productId: row.productId,
    productName: row.product.name,
    quantityTheoretical: row.quantityTheoretical.toFixed(3),
    quantityReal: row.quantityReal.toFixed(3),
    difference: row.difference.toFixed(3),
    countCorrectionMovementId: row.countCorrectionMovementId,
  }));
}

async function loadClosingOrThrow(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
): Promise<ClosingRow> {
  const row = await fastify.db.weeklyClosing.findFirst({
    where: { id, organizationId },
    include: closingInclude,
  });
  if (!row) {
    throw new NotFoundError('Cierre semanal no encontrado en esta organización');
  }
  return row;
}

/**
 * Crea/prepara el cierre de una ubicación y período (get-or-create,
 * protegido por el UNIQUE (organizationId, locationId, periodStart) del
 * schema) -- sección 17 del prompt: "crear/preparar cierre semanal".
 */
export async function prepareWeeklyClosing(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  input: PrepareWeeklyClosingInput,
): Promise<WeeklyClosingDto> {
  const periodStart = parsePeriodStart(input.periodStart);
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 6);

  await assertLocationForMovement(fastify, organizationId, input.locationId);

  const existing = await fastify.db.weeklyClosing.findFirst({
    where: { organizationId, locationId: input.locationId, periodStart },
    include: closingInclude,
  });
  if (existing) return mapClosing(existing);

  try {
    return await fastify.db.$transaction(async (tx) => {
      const created = await tx.weeklyClosing.create({
        data: {
          organizationId,
          locationId: input.locationId,
          periodStart,
          periodEnd,
          createdById: actor.id,
        },
        include: closingInclude,
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        locationId: input.locationId,
        action: 'WEEKLY_CLOSING_PREPARED',
        module: 'WEEKLY_CLOSING',
        entityType: 'weekly_closing',
        entityId: created.id,
        afterValue: mapClosing(created),
      });

      return mapClosing(created);
    });
  } catch (err) {
    if (isUniqueConstraintViolationOn(err, LOCATION_PERIOD_START_UNIQUE_TARGET)) {
      const winner = await fastify.db.weeklyClosing.findFirst({
        where: { organizationId, locationId: input.locationId, periodStart },
        include: closingInclude,
      });
      if (winner) return mapClosing(winner);
      fastify.log.error(
        { organizationId, locationId: input.locationId, periodStart },
        'Etapa 6: colisión UNIQUE de (ubicación, período) sin cierre encontrado al reconsultar',
      );
      throw new ConflictError(
        'No se pudo confirmar el resultado de esta preparación por una condición de carrera inesperada; reintentá la solicitud.',
      );
    }
    throw err;
  }
}

export async function listWeeklyClosings(
  fastify: FastifyInstance,
  organizationId: string,
  filters: WeeklyClosingFilters,
  pageInput: PageInput,
): Promise<Page<WeeklyClosingDto>> {
  const page = Math.max(1, pageInput.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, pageInput.pageSize ?? 20));

  const where: Prisma.WeeklyClosingWhereInput = {
    organizationId,
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };

  const [rows, total] = await Promise.all([
    fastify.db.weeklyClosing.findMany({
      where,
      include: closingInclude,
      orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    fastify.db.weeklyClosing.count({ where }),
  ]);

  return { items: rows.map(mapClosing), page, pageSize, total };
}

/**
 * Vista completa (checklist + comparación teórico/real) -- misma forma de
 * respuesta antes y después de cerrar (sección 19 del prompt).
 */
export async function getWeeklyClosingDetail(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
): Promise<WeeklyClosingDetail> {
  const closing = await loadClosingOrThrow(fastify, organizationId, id);
  const governing = await loadGoverningCount(fastify, organizationId, closing);
  const checklist = await computeChecklist(fastify, organizationId, closing, governing);
  const items =
    closing.status === 'CLOSED'
      ? await loadPersistedItems(fastify, organizationId, closing.id, closing.currentRevision)
      : await computeLiveItems(fastify, organizationId, governing);

  return {
    closing: mapClosing(closing),
    checklist,
    revision: closing.currentRevision,
    items,
  };
}

function computeCloseFingerprint(weeklyClosingId: string): string {
  return JSON.stringify({ weeklyClosingId });
}

async function resolveCloseConflictAfterRace(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<WeeklyClosingDetail> {
  const winner = await fastify.db.weeklyClosing.findFirst({ where: { id, organizationId } });
  if (!winner) {
    fastify.log.error(
      { organizationId, id, idempotencyKey },
      'Etapa 6: colisión de idempotencia de cierre sin fila encontrada al reconsultar',
    );
    throw new ConflictError(
      'No se pudo confirmar el resultado de este cierre por una condición de carrera inesperada; reintentá la solicitud.',
    );
  }
  if (
    winner.closeIdempotencyKey === idempotencyKey &&
    winner.closeIdempotencyFingerprint === fingerprint
  ) {
    return getWeeklyClosingDetail(fastify, organizationId, id);
  }
  throw new ConflictError('Este cierre ya fue cerrado con una clave distinta.');
}

/**
 * Confirmación única y consolidada de revisión del checklist (sección 5 del
 * prompt) -- gesto explícito de un ADMIN que, junto con `countSubmitted`,
 * habilita `close`. No tiene idempotencyKey propia: repetirla sólo
 * actualiza el timestamp, no tiene efectos destructivos ni genera
 * duplicados (a diferencia de `close`, que sí es crítica y exige
 * idempotencia estricta -- sección 13 del prompt).
 */
export async function confirmWeeklyClosingReview(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  id: string,
): Promise<WeeklyClosingDetail> {
  const closing = await loadClosingOrThrow(fastify, organizationId, id);
  if (closing.status === 'CLOSED') {
    throw new ConflictError('No se puede confirmar la revisión de un cierre que ya está cerrado.');
  }

  const updateResult = await fastify.db.weeklyClosing.updateMany({
    where: { id, organizationId, status: { in: ['OPEN', 'REOPENED'] } },
    data: { reviewConfirmedById: actor.id, reviewConfirmedAt: new Date() },
  });
  if (updateResult.count === 0) {
    throw new ConflictError(
      'Este cierre ya no admite confirmar la revisión (fue cerrado por otra solicitud); volvé a consultarlo.',
    );
  }

  await fastify.audit.log({
    organizationId,
    userId: actor.id,
    roleCode: actor.roleCode,
    locationId: closing.locationId,
    action: 'WEEKLY_CLOSING_REVIEW_CONFIRMED',
    module: 'WEEKLY_CLOSING',
    entityType: 'weekly_closing',
    entityId: id,
  });

  return getWeeklyClosingDetail(fastify, organizationId, id);
}

/**
 * Cierre definitivo (sección 11/13/14 del prompt): TODO en una única
 * transacción -- transición de estado, `InventorySnapshotItem` por
 * producto, `COUNT_CORRECTION` por cada diferencia histórica no
 * reconciliada todavía, auditoría. Si algo falla, ROLLBACK completo (nunca
 * CLOSED sin snapshot, ni snapshot sin cierre, ni ajuste parcial).
 *
 * Idempotencia (sección 13): mismo patrón endurecido de Etapa 3.2/4.1/5.1 --
 * `closeIdempotencyKey`/`closeIdempotencyFingerprint` + UNIQUE + UPDATE
 * condicional (`status: OPEN|REOPENED -> CLOSED`) + resolución explícita de
 * carrera reconsultando Postgres, nunca locks en memoria.
 *
 * Consistencia temporal de la reconciliación (Etapa 6.1 -- ver
 * docs/ETAPA-6-CIERRE-SEMANAL.md, sección "Etapa 6.1"): el ajuste que se
 * aplica al ledger es SIEMPRE la diferencia histórica congelada en
 * `InventoryCountItem` al momento del conteo (`item.difference`,
 * `real - teórico EN ESE MOMENTO`) -- NUNCA se recalcula comparando contra
 * el saldo VIGENTE del ledger, porque el saldo vigente puede incluir
 * movimientos legítimos (ventas, mermas, otros ajustes) ocurridos DESPUÉS
 * del conteo, que no son parte de la diferencia física que el conteo
 * detectó. Si se reconciliara contra el saldo vigente, un movimiento
 * legítimo posterior al conteo podría quedar absorbido silenciosamente
 * como si fuera parte del ajuste del cierre.
 *
 * Para no duplicar el ajuste en un recierre (reapertura sin conteo nuevo),
 * se consulta la trazabilidad YA PERSISTIDA del propio ledger antes de
 * decidir si hace falta un `COUNT_CORRECTION` nuevo: `InventoryMovement`
 * con `sourceDocumentType = 'WEEKLY_CLOSING'` y `sourceDocumentId =
 * WeeklyClosing.id` (mecanismo reservado desde Etapa 3, el mismo que ya
 * usan SALE/BOM_CONSUMPTION). Como `WeeklyClosing.id` es constante a
 * través de todas sus revisiones, esa consulta encuentra la corrección de
 * cualquier cierre previo de ESTE `WeeklyClosing` para el mismo producto
 * -- si ya existe, la nueva revisión REUTILIZA esa misma referencia (nunca
 * crea un segundo movimiento); si no existe, crea uno por la diferencia
 * histórica exacta. Un índice único parcial sobre `inventory_movement`
 * (migración `20260910120000_..._etapa6_1`) es la garantía de última
 * instancia a nivel de PostgreSQL de que nunca puede existir más de un
 * `COUNT_CORRECTION` por (cierre, producto).
 *
 * Concurrencia (sección 15): a diferencia de Etapa 5.2 (`ProductAlias`
 * remapeable en cualquier momento -- TOCTOU real), acá NO hace falta
 * `Serializable`: el checklist exige `countSubmitted` (el `InventoryCount`
 * gobernante debe estar COMPLETED), y una vez COMPLETED un `InventoryCount`
 * es terminal -- `submitInventoryCount`/`submitInventoryRecount`
 * (inventory-count.ts) nunca vuelven a tocar sus `InventoryCountItem` una
 * vez alcanzado ese estado. Por eso leer teórico/real/diferencia ANTES de
 * abrir la transacción es seguro: no hay ninguna escritura concurrente
 * posible sobre esos datos entre la lectura y el commit. La decisión de
 * qué `COUNT_CORRECTION` corresponde (búsqueda de la trazabilidad
 * existente + creación si falta) se hace DENTRO de la transacción, después
 * del UPDATE condicional que ya serializa cualquier cierre concurrente de
 * ESTE `WeeklyClosing` contra sí mismo (sólo una transacción puede ganar
 * esa fila a la vez) -- eso, más el UNIQUE parcial de la migración, cierra
 * la ventana también bajo dos requests de cierre concurrentes.
 */
export async function closeWeeklyClosing(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  id: string,
  input: CloseWeeklyClosingInput,
): Promise<WeeklyClosingDetail> {
  const closing = await loadClosingOrThrow(fastify, organizationId, id);
  const fingerprint = computeCloseFingerprint(id);

  // Atajo rápido (no la protección real, ver el UPDATE condicional de
  // abajo): closeIdempotencyKey sólo es no-null mientras CLOSED (se
  // resetea a null en cada reopen), así que esto también cubre el caso
  // "ya está cerrado".
  if (closing.closeIdempotencyKey !== null) {
    if (
      closing.closeIdempotencyKey === input.idempotencyKey &&
      closing.closeIdempotencyFingerprint === fingerprint
    ) {
      return getWeeklyClosingDetail(fastify, organizationId, id);
    }
    throw new ConflictError('Este cierre ya fue cerrado con una clave distinta.');
  }
  if (closing.status === 'CLOSED') {
    throw new ConflictError('Este cierre ya está cerrado.');
  }

  const governing = await loadGoverningCount(fastify, organizationId, closing);
  const checklist = await computeChecklist(fastify, organizationId, closing, governing);
  if (!checklist.canClose) {
    const reasons: string[] = [];
    if (!checklist.countSubmitted) {
      reasons.push(
        `falta el conteo físico semanal completo (conteo del ${checklist.governingCountWeekStart}, estado actual: ${checklist.governingCountStatus ?? 'no enviado'})`,
      );
    }
    if (!checklist.reviewConfirmedById) {
      reasons.push('falta la confirmación de revisión del checklist por un ADMIN');
    }
    throw new ConflictError(`No se puede cerrar esta semana: ${reasons.join('; ')}.`);
  }

  // Sección 7/9 del prompt: se copian DIRECTAMENTE de `InventoryCountItem`
  // (vía `computeLiveItems`), nunca se recalculan acá. Seguro leerlos antes
  // de abrir la transacción -- ver el comentario de esta función sobre por
  // qué un `InventoryCount` COMPLETED es terminal.
  const items = await computeLiveItems(fastify, organizationId, governing);
  const productIds = items.map((item) => item.productId);

  try {
    await fastify.db.$transaction(async (tx) => {
      const updateResult = await tx.weeklyClosing.updateMany({
        where: {
          id,
          organizationId,
          status: { in: ['OPEN', 'REOPENED'] },
          closeIdempotencyKey: null,
        },
        data: {
          status: 'CLOSED',
          closedById: actor.id,
          closedAt: new Date(),
          currentRevision: { increment: 1 },
          closeIdempotencyKey: input.idempotencyKey,
          closeIdempotencyFingerprint: fingerprint,
        },
      });
      if (updateResult.count === 0) {
        throw new ConflictError(
          'Este cierre ya fue cerrado por otra solicitud; volvé a consultarlo.',
        );
      }

      const updatedClosing = await tx.weeklyClosing.findFirstOrThrow({
        where: { id, organizationId },
      });
      const revision = updatedClosing.currentRevision;

      // Sección 8 del prompt Etapa 6.1: los productos y las correcciones ya
      // aplicadas se cargan DENTRO de la transacción -- la decisión de qué
      // `COUNT_CORRECTION` corresponde a cada producto es parte de la misma
      // operación atómica que el resto del cierre.
      const products = await tx.product.findMany({
        where: { organizationId, id: { in: productIds } },
        select: { id: true, unitOfMeasureId: true },
      });
      const productById = new Map(products.map((p) => [p.id, p]));

      // Trazabilidad persistida (sección 7 del prompt Etapa 6.1): un mismo
      // `WeeklyClosing` (id constante a través de sus revisiones) sólo
      // puede tener, como mucho, un COUNT_CORRECTION por producto en toda
      // su vida -- se busca acá si ya existe ANTES de decidir si hace
      // falta crear uno nuevo. Nunca se infiere comparando contra el saldo
      // actual del ledger (eso absorbería movimientos legítimos -ventas,
      // mermas- ocurridos después del conteo como si fueran parte de la
      // diferencia física detectada por ese conteo).
      const existingCorrections = await tx.inventoryMovement.findMany({
        where: {
          organizationId,
          locationId: closing.locationId,
          movementType: 'COUNT_CORRECTION',
          sourceDocumentType: 'WEEKLY_CLOSING',
          sourceDocumentId: id,
          productId: { in: productIds },
        },
        select: { id: true, productId: true },
      });
      const existingCorrectionMovementIdByProduct = new Map(
        existingCorrections.map((m) => [m.productId, m.id]),
      );

      let correctionsCreated = 0;
      for (const item of items) {
        const product = productById.get(item.productId);
        if (!product) {
          // Sección 10 del prompt Etapa 6.1: nunca omitir en silencio un
          // producto que no puede resolverse -- todo el cierre debe
          // fallar (ROLLBACK completo: nada queda CLOSED, ningún snapshot
          // ni COUNT_CORRECTION parcial, ninguna auditoría).
          throw new InternalError(
            `No se pudo resolver el producto ${item.productId} del conteo gobernante al cerrar la semana; se abortó el cierre completo.`,
          );
        }

        // `item.difference` es la diferencia HISTÓRICA congelada al momento
        // del conteo (real - teórico EN ESE MOMENTO, sección 16.1 del
        // documento del cliente: "la diferencia histórica se conserva") --
        // es SIEMPRE el valor que se aplica como ajuste, sin importar
        // cuántas veces se recierre esta semana.
        const historicalDifference = new Prisma.Decimal(item.difference);

        let countCorrectionMovementId = existingCorrectionMovementIdByProduct.get(item.productId);

        // Sección 8 del prompt: NUNCA se genera un ajuste cuando la
        // diferencia histórica es cero, y NUNCA se genera un segundo
        // ajuste cuando este cierre ya tiene uno para este producto (ver
        // arriba) -- la nueva revisión reutiliza la MISMA referencia.
        if (countCorrectionMovementId === undefined && !historicalDifference.isZero()) {
          // `historicalDifference` ya está en unidad CANÓNICA (mismo
          // concepto que `InventoryMovement.quantity`). Se registra con
          // `conversionFactor = 1` y `enteredQuantity = historicalDifference`
          // (en vez de convertir a la unidad de manejo del producto vía
          // `unitsPerHandlingUnit`) para que `quantity = enteredQuantity *
          // conversionFactor` sea EXACTO, sin ninguna división/multiplicación
          // intermedia que arriesgue redondeo sobre una cantidad sensible
          // (sección 7 del prompt: "usar Decimal end-to-end; nunca perder
          // precisión"). `entryUnitOfMeasureId` sigue siendo la unidad del
          // producto (único valor disponible y NOT NULL en el schema) --
          // es sólo el campo informativo de "en qué unidad se tipeó", que
          // para un ajuste generado por el sistema (no tipeado por nadie)
          // es una convención razonable, documentada acá.
          const movement = await tx.inventoryMovement.create({
            data: {
              organizationId,
              locationId: closing.locationId,
              productId: item.productId,
              movementType: 'COUNT_CORRECTION',
              quantity: historicalDifference,
              enteredQuantity: historicalDifference,
              entryUnitOfMeasureId: product.unitOfMeasureId,
              conversionFactor: 1,
              reason: `Ajuste automático del cierre semanal ${toIsoDate(closing.periodStart)}..${toIsoDate(closing.periodEnd)} (revisión ${revision})`,
              sourceDocumentType: 'WEEKLY_CLOSING',
              sourceDocumentId: id,
              createdById: actor.id,
            },
          });
          countCorrectionMovementId = movement.id;
          correctionsCreated++;
        }

        await tx.inventorySnapshotItem.create({
          data: {
            organizationId,
            locationId: closing.locationId,
            weeklyClosingId: id,
            productId: item.productId,
            revision,
            quantityTheoretical: new Prisma.Decimal(item.quantityTheoretical),
            quantityReal: new Prisma.Decimal(item.quantityReal),
            difference: historicalDifference,
            countCorrectionMovementId: countCorrectionMovementId ?? null,
          },
        });
      }

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        locationId: closing.locationId,
        action: 'WEEKLY_CLOSING_CLOSED',
        module: 'WEEKLY_CLOSING',
        entityType: 'weekly_closing',
        entityId: id,
        afterValue: {
          weeklyClosingId: id,
          revision,
          itemsSnapshotted: items.length,
          correctionsCreated,
        },
      });
    });
  } catch (err) {
    if (isUniqueConstraintViolationOn(err, CLOSE_IDEMPOTENCY_KEY_TARGET)) {
      return resolveCloseConflictAfterRace(
        fastify,
        organizationId,
        id,
        input.idempotencyKey,
        fingerprint,
      );
    }
    if (err instanceof ConflictError) {
      return resolveCloseConflictAfterRace(
        fastify,
        organizationId,
        id,
        input.idempotencyKey,
        fingerprint,
      );
    }
    throw err;
  }

  return getWeeklyClosingDetail(fastify, organizationId, id);
}

/**
 * Reapertura (sección 12 del prompt): operación sensible, sólo desde
 * CLOSED, motivo obligatorio. El snapshot de la revisión que se reabre
 * NUNCA se borra ni se edita -- queda intacto bajo su `revision` (el
 * `currentRevision` en ese momento). `closeIdempotencyKey`/
 * `reviewConfirmedById` se resetean a null para que el PRÓXIMO cierre use
 * una clave/revisión propia, nunca confundida con la anterior.
 */
export async function reopenWeeklyClosing(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  id: string,
  input: ReopenWeeklyClosingInput,
): Promise<WeeklyClosingDetail> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new ValidationError('La reapertura de un cierre requiere un motivo');
  }

  const closing = await loadClosingOrThrow(fastify, organizationId, id);
  if (closing.status !== 'CLOSED') {
    throw new ConflictError('Sólo se puede reabrir un cierre que esté CLOSED.');
  }

  await fastify.db.$transaction(async (tx) => {
    const updateResult = await tx.weeklyClosing.updateMany({
      where: { id, organizationId, status: 'CLOSED' },
      data: {
        status: 'REOPENED',
        reopenedById: actor.id,
        reopenedAt: new Date(),
        reopenReason: reason,
        closeIdempotencyKey: null,
        closeIdempotencyFingerprint: null,
        reviewConfirmedById: null,
        reviewConfirmedAt: null,
      },
    });
    if (updateResult.count === 0) {
      throw new ConflictError(
        'Este cierre ya no está CLOSED (fue reabierto por otra solicitud); volvé a consultarlo.',
      );
    }

    await fastify.audit.logTx(tx, {
      organizationId,
      userId: actor.id,
      roleCode: actor.roleCode,
      locationId: closing.locationId,
      action: 'WEEKLY_CLOSING_REOPENED',
      module: 'WEEKLY_CLOSING',
      entityType: 'weekly_closing',
      entityId: id,
      reason,
    });
  });

  return getWeeklyClosingDetail(fastify, organizationId, id);
}
