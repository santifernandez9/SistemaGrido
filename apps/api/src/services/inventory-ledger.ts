import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  CreateAdjustmentInput,
  CreateInitialStockInput,
  InventoryMovement,
  MovementFilters,
  MovementType,
  Page,
  PageInput,
  StockBalance,
} from '@sistema-grido/shared-types';
import type { CurrentUser } from '../plugins/auth.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

/**
 * Ledger central de movimientos de inventario (RF-009, RN-007..RN-010,
 * CONFIRMADO). Única puerta de escritura de stock del sistema -- ver
 * docs/ETAPA-3-MOTOR-INVENTARIO.md y docs/ETAPA-3.1-HARDENING-INVENTARIO.md.
 * Ninguna otra función de este backend debe usar
 * `fastify.db.inventoryMovement.create` directamente; todo alta de
 * movimiento pasa por acá para garantizar la transacción
 * movimiento+auditoría (sección 18 del prompt de Etapa 3) y las
 * validaciones de dominio.
 */

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

const movementInclude = {
  location: { select: { name: true } },
  product: { select: { name: true, code: true } },
  entryUnitOfMeasure: { select: { name: true } },
  createdBy: { select: { displayName: true } },
} satisfies Prisma.InventoryMovementInclude;

type MovementRow = Prisma.InventoryMovementGetPayload<{ include: typeof movementInclude }>;

function mapMovement(row: MovementRow): InventoryMovement {
  return {
    id: row.id,
    organizationId: row.organizationId,
    locationId: row.locationId,
    locationName: row.location.name,
    productId: row.productId,
    productName: row.product.name,
    productCode: row.product.code,
    movementType: row.movementType,
    // .toFixed(3), no .toString(): la columna es NUMERIC(14,3) y .toString()
    // de decimal.js recorta ceros finales ("10" en vez de "10.000") -- un
    // formato de ancho variable es una API menos predecible para el frontend.
    quantity: row.quantity.toFixed(3),
    enteredQuantity: row.enteredQuantity.toFixed(3),
    entryUnitOfMeasureId: row.entryUnitOfMeasureId,
    entryUnitOfMeasureName: row.entryUnitOfMeasure.name,
    conversionFactor: row.conversionFactor,
    reason: row.reason,
    sourceDocumentType: row.sourceDocumentType,
    sourceDocumentId: row.sourceDocumentId,
    idempotencyKey: row.idempotencyKey,
    reversesMovementId: row.reversesMovementId,
    status: row.status,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    createdByName: row.createdBy.displayName,
  };
}

/** Ubicación válida para recibir un movimiento: existe en la organización y está activa
 * (RN-004: un maestro inactivo "no aparece para nuevas cargas pero conserva su historial" --
 * mismo criterio ya aplicado a Category/Product en Etapa 2, extendido acá a Location). */
async function assertLocationForMovement(
  fastify: FastifyInstance,
  organizationId: string,
  locationId: string,
) {
  const location = await fastify.db.location.findFirst({
    where: { id: locationId, organizationId },
  });
  if (!location) {
    throw new ValidationError('La ubicación indicada no existe en esta organización');
  }
  if (!location.active) {
    throw new ValidationError('La ubicación indicada está inactiva');
  }
  return location;
}

async function assertProductForMovement(
  fastify: FastifyInstance,
  organizationId: string,
  productId: string,
) {
  const product = await fastify.db.product.findFirst({ where: { id: productId, organizationId } });
  if (!product) {
    throw new ValidationError('El producto indicado no existe en esta organización');
  }
  if (!product.active) {
    throw new ValidationError('El producto indicado está inactivo');
  }
  return product;
}

/**
 * Etapa 3.1, corrección del Problema 3 ("idempotencia semántica"). La
 * identidad de una operación de alta de movimiento es exactamente estos
 * campos -- deliberadamente NO incluye nada generado internamente por el
 * servidor (id, createdAt, el `occurredAt` resuelto por default, etc.): dos
 * requests con el mismo `idempotencyKey` y estos mismos valores son "el
 * mismo evento" reenviado (retry legítimo); si alguno difiere, es una
 * reutilización de clave con una operación distinta (conflicto).
 *
 * `enteredQuantity` se canonicaliza vía `Prisma.Decimal` antes de
 * stringificar (`"5"` y `"5.00"` deben considerarse la misma cantidad).
 * `occurredAt` sólo cuenta si el llamador lo mandó explícitamente -- el
 * valor por default ("ahora") no es parte de lo que el cliente pidió, así
 * que nunca debe hacer que un retry legítimo sin `occurredAt` explícito
 * parezca un conflicto.
 */
function computeIdempotencyFingerprint(payload: {
  movementType: MovementType;
  locationId: string;
  productId: string;
  enteredQuantity: Prisma.Decimal;
  reason?: string | null;
  occurredAt?: string | null;
}): string {
  return JSON.stringify({
    movementType: payload.movementType,
    locationId: payload.locationId,
    productId: payload.productId,
    enteredQuantity: payload.enteredQuantity.toString(),
    reason: payload.reason ?? null,
    occurredAt: payload.occurredAt ?? null,
  });
}

/**
 * Resuelve qué hacer con un `idempotencyKey` opcional antes de dar de alta
 * un movimiento: si no se mandó, no hay nada que resolver (`null`). Si se
 * mandó y ya existe un movimiento con esa clave en la organización, compara
 * su huella semántica (sección de arriba): coincide -> retry legítimo, se
 * devuelve el movimiento ya creado sin tocar nada; no coincide -> conflicto
 * explícito, `409`, la clave no se reutiliza silenciosamente para una
 * operación distinta.
 */
async function resolveIdempotency(
  fastify: FastifyInstance,
  organizationId: string,
  idempotencyKey: string | undefined,
  fingerprint: string,
): Promise<InventoryMovement | null> {
  if (!idempotencyKey) return null;
  const existing = await fastify.db.inventoryMovement.findFirst({
    where: { organizationId, idempotencyKey },
    include: movementInclude,
  });
  if (!existing) return null;
  if (existing.idempotencyFingerprint === fingerprint) {
    return mapMovement(existing);
  }
  throw new ConflictError(
    'Esta clave de idempotencia ya se usó con datos distintos (ubicación, producto, cantidad, motivo o fecha efectiva); no puede reutilizarse para una operación diferente.',
  );
}

/**
 * Stock teórico por ubicación/producto (sección 9 del prompt: "organization +
 * location + product -> quantity"). SIEMPRE se calcula agregando el ledger en
 * el momento de la consulta -- no hay una tabla/columna de saldo cacheado.
 * Sólo aparecen combinaciones que tienen al menos un movimiento (si nunca se
 * cargó nada para un producto/ubicación, no hay fila -- no es lo mismo que
 * "stock cero", es "sin datos todavía").
 */
export async function getStockBalances(
  fastify: FastifyInstance,
  organizationId: string,
  filters: { locationId?: string; productId?: string },
): Promise<StockBalance[]> {
  const grouped = await fastify.db.inventoryMovement.groupBy({
    by: ['locationId', 'productId'],
    // Sin filtro de `status`: una reversión ya aporta su propia cantidad de
    // signo opuesto (ver reverseMovement), así que sumar TODOS los
    // movimientos (activos y revertidos) da el saldo correcto. Filtrar acá
    // por `status: 'ACTIVE'` restaría el original revertido sin sumar de
    // vuelta su efecto, dejando el saldo mal calculado (ver
    // docs/INVARIANTES-INVENTARIO.md). `status` sólo sirve para trazabilidad
    // y para impedir una doble reversión (ver reverseMovement) -- nunca como
    // filtro del cálculo de stock teórico.
    where: {
      organizationId,
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
      ...(filters.productId ? { productId: filters.productId } : {}),
    },
    _sum: { quantity: true },
  });
  if (grouped.length === 0) return [];

  const locationIds = [...new Set(grouped.map((g) => g.locationId))];
  const productIds = [...new Set(grouped.map((g) => g.productId))];
  const [locations, products] = await Promise.all([
    fastify.db.location.findMany({
      where: { id: { in: locationIds } },
      select: { id: true, name: true },
    }),
    fastify.db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, code: true },
    }),
  ]);
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const productById = new Map(products.map((p) => [p.id, p]));

  const balances: StockBalance[] = [];
  for (const g of grouped) {
    const location = locationById.get(g.locationId);
    const product = productById.get(g.productId);
    if (!location || !product) continue; // no debería pasar: ambos ya están scoped por organizationId
    balances.push({
      organizationId,
      locationId: g.locationId,
      locationName: location.name,
      productId: g.productId,
      productName: product.name,
      productCode: product.code,
      quantity: (g._sum.quantity ?? new Prisma.Decimal(0)).toFixed(3),
    });
  }
  return balances.sort(
    (a, b) =>
      a.locationName.localeCompare(b.locationName) || a.productName.localeCompare(b.productName),
  );
}

/** Historial de movimientos, paginado y filtrable (sección 22 del prompt). */
export async function listMovements(
  fastify: FastifyInstance,
  organizationId: string,
  filters: MovementFilters,
  pageInput: PageInput,
): Promise<Page<InventoryMovement>> {
  const page = Math.max(1, pageInput.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, pageInput.pageSize ?? 20));

  const where: Prisma.InventoryMovementWhereInput = {
    organizationId,
    ...(filters.locationId ? { locationId: filters.locationId } : {}),
    ...(filters.productId ? { productId: filters.productId } : {}),
    ...(filters.movementType ? { movementType: filters.movementType } : {}),
    ...(filters.occurredFrom || filters.occurredTo
      ? {
          occurredAt: {
            ...(filters.occurredFrom ? { gte: new Date(filters.occurredFrom) } : {}),
            ...(filters.occurredTo ? { lte: new Date(filters.occurredTo) } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    fastify.db.inventoryMovement.findMany({
      where,
      include: movementInclude,
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    fastify.db.inventoryMovement.count({ where }),
  ]);

  return { items: rows.map(mapMovement), page, pageSize, total };
}

export async function getMovementDetail(
  fastify: FastifyInstance,
  organizationId: string,
  id: string,
): Promise<InventoryMovement> {
  const row = await fastify.db.inventoryMovement.findFirst({
    where: { id, organizationId },
    include: movementInclude,
  });
  if (!row) {
    throw new NotFoundError('Movimiento no encontrado en esta organización');
  }
  return mapMovement(row);
}

/**
 * Stock inicial (RF-011/RN-011, CONFIRMADO). Mecanismo administrativo
 * controlado -- sólo ADMIN en esta etapa (ver docs/ETAPA-3-MOTOR-INVENTARIO.md,
 * sección "Autorización"). Protegido contra cargas duplicadas en dos capas:
 * un chequeo previo (error claro, UX) y el índice único parcial de la
 * migración (garantía final de PostgreSQL, cubre condiciones de carrera).
 */
export async function createInitialStock(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  input: CreateInitialStockInput,
): Promise<InventoryMovement> {
  // Etapa 3.1, corrección del Problema 2: `input.enteredQuantity` es un
  // string decimal (ya validado por formato/escala en el schema Zod de la
  // ruta, ver apps/api/src/routes/inventory.ts). Se convierte DIRECTAMENTE
  // a Prisma.Decimal acá -- nunca pasa por `Number(...)` ni por
  // `valueAsNumber` en ningún punto del camino.
  const enteredQuantity = new Prisma.Decimal(input.enteredQuantity);
  if (enteredQuantity.lte(0)) {
    throw new ValidationError('La cantidad de stock inicial debe ser mayor a cero');
  }

  const fingerprint = computeIdempotencyFingerprint({
    movementType: 'INITIAL_STOCK',
    locationId: input.locationId,
    productId: input.productId,
    enteredQuantity,
    occurredAt: input.occurredAt ?? null,
  });
  const idempotent = await resolveIdempotency(
    fastify,
    organizationId,
    input.idempotencyKey,
    fingerprint,
  );
  if (idempotent) return idempotent;

  await assertLocationForMovement(fastify, organizationId, input.locationId);
  const product = await assertProductForMovement(fastify, organizationId, input.productId);

  // `reversesMovementId: null` es clave: una reversión de un INITIAL_STOCK
  // reutiliza el mismo `movementType` (sección "Reversión" de
  // docs/ETAPA-3-MOTOR-INVENTARIO.md) y queda ACTIVE, pero NO es "una carga
  // de stock inicial" -- es la corrección de una. Si se contara acá, revertir
  // un stock inicial equivocado dejaría imposible cargar uno nuevo (la propia
  // reversión ocuparía el lugar para siempre), justo lo contrario de lo que
  // pide la sección 8 del prompt de Etapa 3.
  const existingInitial = await fastify.db.inventoryMovement.findFirst({
    where: {
      organizationId,
      locationId: input.locationId,
      productId: input.productId,
      movementType: 'INITIAL_STOCK',
      status: 'ACTIVE',
      reversesMovementId: null,
    },
  });
  if (existingInitial) {
    throw new ConflictError(
      'Ya existe un stock inicial activo para este producto en esta ubicación. Si necesitás corregirlo, revertí el movimiento existente y cargá uno nuevo.',
    );
  }

  const conversionFactor = product.unitsPerHandlingUnit;
  const quantity = enteredQuantity.mul(conversionFactor);

  try {
    return await fastify.db.$transaction(async (tx) => {
      const created = await tx.inventoryMovement.create({
        data: {
          organizationId,
          locationId: input.locationId,
          productId: input.productId,
          movementType: 'INITIAL_STOCK',
          quantity,
          enteredQuantity,
          entryUnitOfMeasureId: product.unitOfMeasureId,
          conversionFactor,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
          idempotencyKey: input.idempotencyKey ?? null,
          idempotencyFingerprint: input.idempotencyKey ? fingerprint : null,
          createdById: actor.id,
        },
        include: movementInclude,
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'INVENTORY_INITIAL_STOCK_CREATED',
        module: 'INVENTORY',
        entityType: 'inventory_movement',
        entityId: created.id,
        afterValue: mapMovement(created),
      });

      return mapMovement(created);
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(
        'Ya existe un stock inicial activo para este producto en esta ubicación (detectado por la base de datos).',
      );
    }
    throw err;
  }
}

/**
 * Ajuste manual (RN-008, sección 11/12 del prompt). `reason` es obligatorio
 * -- CHECK a nivel de base de datos además de esta validación (ver migración).
 * Sólo ADMIN en esta etapa (ver sección "Autorización" del documento).
 */
export async function createAdjustment(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  input: CreateAdjustmentInput,
): Promise<InventoryMovement> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new ValidationError('El ajuste requiere un motivo');
  }
  // Etapa 3.1, Problema 2: conversión directa string -> Decimal, sin Number().
  const enteredQuantity = new Prisma.Decimal(input.enteredQuantity);
  if (enteredQuantity.isZero()) {
    throw new ValidationError('La cantidad del ajuste no puede ser cero');
  }

  const fingerprint = computeIdempotencyFingerprint({
    movementType: 'ADJUSTMENT',
    locationId: input.locationId,
    productId: input.productId,
    enteredQuantity,
    reason,
    occurredAt: input.occurredAt ?? null,
  });
  const idempotent = await resolveIdempotency(
    fastify,
    organizationId,
    input.idempotencyKey,
    fingerprint,
  );
  if (idempotent) return idempotent;

  await assertLocationForMovement(fastify, organizationId, input.locationId);
  const product = await assertProductForMovement(fastify, organizationId, input.productId);

  const conversionFactor = product.unitsPerHandlingUnit;
  const quantity = enteredQuantity.mul(conversionFactor);

  return fastify.db.$transaction(async (tx) => {
    const created = await tx.inventoryMovement.create({
      data: {
        organizationId,
        locationId: input.locationId,
        productId: input.productId,
        movementType: 'ADJUSTMENT',
        quantity,
        enteredQuantity,
        entryUnitOfMeasureId: product.unitOfMeasureId,
        conversionFactor,
        reason,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
        idempotencyKey: input.idempotencyKey ?? null,
        idempotencyFingerprint: input.idempotencyKey ? fingerprint : null,
        createdById: actor.id,
      },
      include: movementInclude,
    });

    await fastify.audit.logTx(tx, {
      organizationId,
      userId: actor.id,
      roleCode: actor.roleCode,
      action: 'INVENTORY_ADJUSTMENT_CREATED',
      module: 'INVENTORY',
      entityType: 'inventory_movement',
      entityId: created.id,
      afterValue: mapMovement(created),
      reason,
    });

    return mapMovement(created);
  });
}

/**
 * Reversión (sección 13 del prompt): preserva el movimiento original, crea
 * un movimiento compensatorio (misma naturaleza, cantidad de signo opuesto)
 * y vincula ambos vía `reversesMovementId`. El original nunca se edita más
 * allá de su `status` (ACTIVE -> REVERSED) -- `quantity`, `reason` y el
 * resto de sus campos quedan intactos para siempre (RN-008/RN-009).
 *
 * Etapa 3.1, corrección del Problema 1 ("doble reversión concurrente"): la
 * protección real es el `UPDATE ... WHERE status = 'ACTIVE'` de abajo,
 * ejecutado dentro de una transacción -- NO el chequeo de `original.status`
 * de más arriba (ese sigue existiendo sólo como atajo rápido para el caso
 * secuencial obvio, evita abrir una transacción para un pedido que ya se
 * sabe inválido). Dos requests concurrentes que pasen ese chequeo inicial
 * (ambos vieron `ACTIVE` porque llegaron casi al mismo tiempo) igual no
 * pueden generar dos reversiones: Postgres serializa el acceso a la MISMA
 * fila en el `UPDATE` condicional -- la segunda transacción espera a que la
 * primera confirme y, al reintentar, ya no encuentra la fila en `ACTIVE`
 * (0 filas afectadas), así que aborta antes de insertar nada. El índice
 * único parcial `(organization_id, reverses_movement_id)` de la migración
 * es la segunda capa: protege el invariante aunque algún camino de código
 * futuro no pase por este `UPDATE` condicional.
 */
export async function reverseMovement(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  movementId: string,
  reasonInput: string,
): Promise<InventoryMovement> {
  const reason = reasonInput?.trim();
  if (!reason) {
    throw new ValidationError('La reversión requiere un motivo');
  }

  const original = await fastify.db.inventoryMovement.findFirst({
    where: { id: movementId, organizationId },
    include: movementInclude,
  });
  if (!original) {
    throw new NotFoundError('Movimiento no encontrado en esta organización');
  }
  // Atajo rápido, no la protección real -- ver el UPDATE condicional de abajo.
  if (original.status !== 'ACTIVE') {
    throw new ConflictError('Este movimiento ya fue revertido; no se puede revertir dos veces');
  }

  try {
    return await fastify.db.$transaction(async (tx) => {
      const updateResult = await tx.inventoryMovement.updateMany({
        where: { id: original.id, organizationId, status: 'ACTIVE' },
        data: { status: 'REVERSED' },
      });
      if (updateResult.count === 0) {
        // Otra transacción ganó la carrera entre que leímos el original (arriba)
        // y que llegamos acá: aborta sin crear ni auditar nada.
        throw new ConflictError('Este movimiento ya fue revertido; no se puede revertir dos veces');
      }

      const reversal = await tx.inventoryMovement.create({
        data: {
          organizationId,
          locationId: original.locationId,
          productId: original.productId,
          movementType: original.movementType,
          quantity: original.quantity.negated(),
          enteredQuantity: original.enteredQuantity.negated(),
          entryUnitOfMeasureId: original.entryUnitOfMeasureId,
          conversionFactor: original.conversionFactor,
          reason,
          reversesMovementId: original.id,
          createdById: actor.id,
        },
        include: movementInclude,
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'INVENTORY_MOVEMENT_REVERSED',
        module: 'INVENTORY',
        entityType: 'inventory_movement',
        entityId: reversal.id,
        beforeValue: mapMovement(original),
        afterValue: mapMovement(reversal),
        reason,
      });

      return mapMovement(reversal);
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // Índice único parcial (organization_id, reverses_movement_id) --
      // segunda capa de defensa, ver migración 20260907130454_inventory_hardening.
      throw new ConflictError('Este movimiento ya fue revertido; no se puede revertir dos veces');
    }
    throw err;
  }
}
