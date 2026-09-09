import type { FastifyInstance } from 'fastify';
import { Prisma } from '@sistema-grido/db';
import type {
  CloseIceCreamContainerInput,
  CreateAdjustmentInput,
  CreateInitialStockInput,
  CreateWasteInput as CreateWasteInputDto,
  InventoryMovement,
  MovementFilters,
  MovementType,
  Page,
  PageInput,
  StockBalance,
  Waste as WasteDto,
} from '@sistema-grido/shared-types';
import { openContainerFractionMultiplier } from './bulk-flavor.js';
import { isUniqueConstraintError, isUniqueConstraintViolationOn } from './idempotency.js';
import { createReadUrl } from './attachments.js';
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

/** Columnas reales (snake_case) del `@@unique([organizationId, idempotencyKey])`. */
const IDEMPOTENCY_KEY_UNIQUE_TARGET = ['organization_id', 'idempotency_key'] as const;

/** Columnas reales del índice único parcial de stock inicial (ver migración de Etapa 3). */
const INITIAL_STOCK_UNIQUE_TARGET = ['organization_id', 'location_id', 'product_id'] as const;

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
 * mismo criterio ya aplicado a Category/Product en Etapa 2, extendido acá a Location).
 * Exportada desde Etapa 4: los servicios nuevos (conteo, gasto variable, sin
 * stock -- apps/api/src/services/inventory-count.ts, variable-expense.ts,
 * stockout.ts) la reutilizan en vez de duplicar la misma validación. */
export async function assertLocationForMovement(
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

export async function assertProductForMovement(
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
 * Etapa 3.2: se llama SOLO después de que un INSERT falló con P2002 sobre el
 * UNIQUE de `idempotencyKey` (nunca ante cualquier P2002 -- ver
 * `isUniqueConstraintViolationOn`). La única forma de llegar acá es que, entre
 * el chequeo previo de `resolveIdempotency` (una simple lectura, sin lock) y
 * este INSERT, otra transacción concurrente haya insertado primero un
 * movimiento con la misma clave -- el escenario de carrera que describe el
 * prompt de Etapa 3.2: "Request A busca key, no existe; Request B busca key,
 * no existe; A inserta; B inserta". PostgreSQL ya garantizó que sólo una fila
 * quedó insertada (el UNIQUE); acá sólo falta decidir qué responderle al
 * request que perdió la carrera, aplicando EXACTAMENTE el mismo criterio de
 * identidad semántica que un retry secuencial (mismo fingerprint):
 *
 * - Fingerprint igual al del ganador -> retry legítimo bajo concurrencia: se
 *   devuelve el movimiento ya persistido, sin crear uno nuevo ni una segunda
 *   auditoría (la transacción que perdió ya hizo ROLLBACK completo -- nunca
 *   llegó a ejecutar `audit.logTx`, porque el `create` fue lo primero que
 *   falló dentro de ella).
 * - Fingerprint distinto -> conflicto real: la clave se reutilizó para una
 *   operación distinta, `409 CONFLICT`, igual que el caso secuencial.
 * - El movimiento no aparece al reconsultar (no debería poder pasar nunca,
 *   dado que la propia constraint que disparó el P2002 garantiza que existe
 *   una fila con esa clave): no se oculta como si fuera un retry exitoso ni
 *   se deja escapar como 500 sin contexto -- se registra la situación en el
 *   log y se responde un conflicto controlado, explícito, pidiendo reintentar.
 */
async function resolveIdempotencyConflictAfterRace(
  fastify: FastifyInstance,
  organizationId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<InventoryMovement> {
  const winner = await fastify.db.inventoryMovement.findFirst({
    where: { organizationId, idempotencyKey },
    include: movementInclude,
  });
  if (!winner) {
    fastify.log.error(
      { organizationId, idempotencyKey },
      'Etapa 3.2: colisión UNIQUE de idempotencyKey sin movimiento encontrado al reconsultar; condición de carrera irresoluble',
    );
    throw new ConflictError(
      'No se pudo confirmar el resultado de esta operación por una condición de carrera inesperada; reintentá la solicitud con la misma clave de idempotencia.',
    );
  }
  if (winner.idempotencyFingerprint === fingerprint) {
    return mapMovement(winner);
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
    include: movementInclude,
  });
  if (existingInitial) {
    // Etapa 3.2: este chequeo también es una lectura sin lock -- exactamente
    // igual de vulnerable a la carrera que el pre-check de idempotencyKey.
    // Si dos requests concurrentes comparten `idempotencyKey` (y por lo
    // tanto, al ser parte del mismo fingerprint, el mismo location/product),
    // el que llega acá una vez que el otro YA COMMITEÓ puede encontrar el
    // stock inicial recién creado por ese otro request y, sin esta
    // distinción, lo reportaría como "ya existe stock inicial" -- un
    // mensaje/código incorrecto para lo que en realidad es un retry
    // idempotente legítimo. Se aplica el mismo criterio de identidad
    // semántica que en cualquier otro punto de colisión de idempotencia:
    // misma key + mismo fingerprint -> se devuelve el existente; misma key +
    // fingerprint distinto -> conflicto de idempotencia (no de "duplicado").
    // Sólo cuando el conflicto NO tiene relación con la key del request (key
    // distinta o ausente) es genuinamente "otro stock inicial ya cargado".
    if (input.idempotencyKey && existingInitial.idempotencyKey === input.idempotencyKey) {
      if (existingInitial.idempotencyFingerprint === fingerprint) {
        return mapMovement(existingInitial);
      }
      throw new ConflictError(
        'Esta clave de idempotencia ya se usó con datos distintos (ubicación, producto, cantidad, motivo o fecha efectiva); no puede reutilizarse para una operación diferente.',
      );
    }
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
    // Etapa 3.2: dos causas DISTINTAS pueden disparar P2002 acá -- nunca
    // asumir cuál fue sin mirar `err.meta.target` (ver
    // isUniqueConstraintViolationOn). Confundirlas es exactamente el bug
    // señalado por la auditoría: una colisión de idempotencyKey reportada
    // como "ya existe stock inicial" (o viceversa) sería un mensaje/código
    // HTTP incorrecto para el caso real.
    if (input.idempotencyKey && isUniqueConstraintViolationOn(err, IDEMPOTENCY_KEY_UNIQUE_TARGET)) {
      return resolveIdempotencyConflictAfterRace(
        fastify,
        organizationId,
        input.idempotencyKey,
        fingerprint,
      );
    }
    if (isUniqueConstraintViolationOn(err, INITIAL_STOCK_UNIQUE_TARGET)) {
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

  try {
    return await fastify.db.$transaction(async (tx) => {
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
  } catch (err) {
    // Etapa 3.2: mismo patrón que createInitialStock -- un ajuste sólo tiene
    // un UNIQUE relevante posible (idempotencyKey), pero igual se valida por
    // `target` en vez de asumir "cualquier P2002 es esto", para no ocultar
    // silenciosamente una causa real distinta si el esquema cambiara en el
    // futuro.
    if (input.idempotencyKey && isUniqueConstraintViolationOn(err, IDEMPOTENCY_KEY_UNIQUE_TARGET)) {
      return resolveIdempotencyConflictAfterRace(
        fastify,
        organizationId,
        input.idempotencyKey,
        fingerprint,
      );
    }
    throw err;
  }
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

// ---------------------------------------------------------------------------
// Etapa 4 (App Heladería Operativa) — ver docs/ETAPA-4-APP-HELADERIA.md.
//
// "Dar de baja lata" y "merma" son, ante todo, movimientos del ledger
// (ICE_CREAM_CONTAINER_CLOSE / WASTE, ambos RESERVADOS desde Etapa 3) --
// siguen viviendo acá, la única puerta de escritura de InventoryMovement,
// en vez de en un servicio aparte que duplique la validación/idempotencia
// ya resuelta arriba.

/**
 * Baja normal de lata (RF-021/RN-027): "dar de baja" un sabor consume UNA
 * unidad de manejo completa (una lata), siempre -- no se le pide cantidad
 * al empleado (sección 7 del prompt: "muy pocos toques"), y no exige motivo
 * (a diferencia de ADJUSTMENT) porque representa consumo normal, no una
 * corrección -- "no pedir observaciones obligatorias para una baja normal".
 * Sólo aplica a productos con `flavorId` (un sabor de helado, RF-003):
 * "dar de baja lata" no tiene sentido para un insumo o packaging.
 */
export async function closeIceCreamContainer(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  input: CloseIceCreamContainerInput,
): Promise<InventoryMovement> {
  const fingerprint = computeIdempotencyFingerprint({
    movementType: 'ICE_CREAM_CONTAINER_CLOSE',
    locationId: input.locationId,
    productId: input.productId,
    enteredQuantity: new Prisma.Decimal(-1),
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
  if (!product.flavorId) {
    throw new ValidationError(
      'Sólo se puede dar de baja una lata de un producto que sea un sabor de helado',
    );
  }

  const enteredQuantity = new Prisma.Decimal(-1);
  const conversionFactor = product.unitsPerHandlingUnit;
  const quantity = enteredQuantity.mul(conversionFactor);

  try {
    return await fastify.db.$transaction(async (tx) => {
      const created = await tx.inventoryMovement.create({
        data: {
          organizationId,
          locationId: input.locationId,
          productId: input.productId,
          movementType: 'ICE_CREAM_CONTAINER_CLOSE',
          quantity,
          enteredQuantity,
          entryUnitOfMeasureId: product.unitOfMeasureId,
          conversionFactor,
          idempotencyKey: input.idempotencyKey,
          idempotencyFingerprint: fingerprint,
          createdById: actor.id,
        },
        include: movementInclude,
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'SHOP_ICE_CREAM_CONTAINER_CLOSED',
        module: 'SHOP_OPS',
        entityType: 'inventory_movement',
        entityId: created.id,
        afterValue: mapMovement(created),
      });

      return mapMovement(created);
    });
  } catch (err) {
    if (isUniqueConstraintViolationOn(err, IDEMPOTENCY_KEY_UNIQUE_TARGET)) {
      return resolveIdempotencyConflictAfterRace(
        fastify,
        organizationId,
        input.idempotencyKey,
        fingerprint,
      );
    }
    throw err;
  }
}

const wasteInclude = {
  movement: { include: movementInclude },
} satisfies Prisma.WasteInclude;

type WasteRow = Prisma.WasteGetPayload<{ include: typeof wasteInclude }>;

function mapWaste(row: WasteRow, photoUrl: string | null): WasteDto {
  const movement = mapMovement(row.movement);
  return {
    id: row.id,
    organizationId: row.organizationId,
    locationId: movement.locationId,
    locationName: movement.locationName,
    productId: movement.productId,
    productName: movement.productName,
    // La cantidad de la merma se muestra siempre positiva (lo que se tiró),
    // aunque el movimiento del ledger la registre negativa (una salida).
    quantity: movement.enteredQuantity.startsWith('-')
      ? movement.enteredQuantity.slice(1)
      : movement.enteredQuantity,
    reason: movement.reason ?? '',
    photoPath: row.photoPath,
    photoUrl,
    createdById: movement.createdById,
    createdByName: movement.createdByName,
    occurredAt: movement.occurredAt,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Merma con foto (RF-024/025/RN-029..032). Genera un movimiento WASTE (ya
 * RESERVADO desde Etapa 3) y, en la MISMA transacción, la fila `Waste` que
 * sólo agrega lo que el movimiento no tiene: la foto (obligatoria, RN-029).
 * La cantidad se acepta como cantidad exacta O como fracción de una lata
 * abierta (sección 8 del prompt: "cantidad o fracción") -- nunca ambas; la
 * fracción sólo tiene sentido para un sabor de helado (`flavorId`).
 */
export async function createWaste(
  fastify: FastifyInstance,
  organizationId: string,
  actor: CurrentUser,
  input: CreateWasteInputDto,
): Promise<WasteDto> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new ValidationError('La merma requiere un motivo');
  }
  const photoPath = input.photoPath?.trim();
  if (!photoPath) {
    throw new ValidationError('La merma requiere una foto');
  }

  await assertLocationForMovement(fastify, organizationId, input.locationId);
  const product = await assertProductForMovement(fastify, organizationId, input.productId);

  let enteredQuantityMagnitude: Prisma.Decimal;
  if (input.enteredQuantity !== undefined) {
    enteredQuantityMagnitude = new Prisma.Decimal(input.enteredQuantity);
    if (enteredQuantityMagnitude.lte(0)) {
      throw new ValidationError('La cantidad de la merma debe ser mayor a cero');
    }
  } else if (input.fraction !== undefined) {
    if (!product.flavorId) {
      throw new ValidationError(
        'Sólo se puede registrar una merma como fracción de lata para un sabor de helado',
      );
    }
    enteredQuantityMagnitude = openContainerFractionMultiplier(fastify, input.fraction);
  } else {
    throw new ValidationError('Debe indicarse una cantidad o una fracción para la merma');
  }

  // WASTE siempre resta -- la magnitud ingresada (positiva, "lo que se tiró")
  // se registra en el ledger con signo negativo, mismo criterio que RN-010.
  const enteredQuantity = enteredQuantityMagnitude.negated();
  const conversionFactor = product.unitsPerHandlingUnit;
  const quantity = enteredQuantity.mul(conversionFactor);

  const fingerprint = computeIdempotencyFingerprint({
    movementType: 'WASTE',
    locationId: input.locationId,
    productId: input.productId,
    enteredQuantity,
    reason,
    occurredAt: input.occurredAt ?? null,
  });

  const idempotentMovement = await resolveIdempotency(
    fastify,
    organizationId,
    input.idempotencyKey,
    fingerprint,
  );
  if (idempotentMovement) {
    return loadWasteForMovement(fastify, organizationId, idempotentMovement.id);
  }

  try {
    return await fastify.db.$transaction(async (tx) => {
      const movement = await tx.inventoryMovement.create({
        data: {
          organizationId,
          locationId: input.locationId,
          productId: input.productId,
          movementType: 'WASTE',
          quantity,
          enteredQuantity,
          entryUnitOfMeasureId: product.unitOfMeasureId,
          conversionFactor,
          reason,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
          idempotencyKey: input.idempotencyKey,
          idempotencyFingerprint: fingerprint,
          createdById: actor.id,
        },
      });

      const waste = await tx.waste.create({
        data: { organizationId, movementId: movement.id, photoPath },
        include: wasteInclude,
      });

      await fastify.audit.logTx(tx, {
        organizationId,
        userId: actor.id,
        roleCode: actor.roleCode,
        action: 'SHOP_WASTE_CREATED',
        module: 'SHOP_OPS',
        entityType: 'waste',
        entityId: waste.id,
        afterValue: mapWaste(waste, null),
        reason,
      });

      return mapWaste(waste, null);
    });
  } catch (err) {
    if (isUniqueConstraintViolationOn(err, IDEMPOTENCY_KEY_UNIQUE_TARGET)) {
      const winner = await resolveIdempotencyConflictAfterRace(
        fastify,
        organizationId,
        input.idempotencyKey,
        fingerprint,
      );
      return loadWasteForMovement(fastify, organizationId, winner.id);
    }
    throw err;
  }
}

async function loadWasteForMovement(
  fastify: FastifyInstance,
  organizationId: string,
  movementId: string,
): Promise<WasteDto> {
  const waste = await fastify.db.waste.findFirst({
    where: { organizationId, movementId },
    include: wasteInclude,
  });
  if (!waste) {
    // No debería poder pasar: el UNIQUE de idempotencyKey que disparó esta
    // reconsulta es del propio InventoryMovement WASTE, y `waste` siempre se
    // crea en la MISMA transacción que ese movimiento -- ver el catch de
    // arriba. Se registra igual, en vez de devolver un error genérico sin
    // contexto (mismo criterio que `resolveIdempotencyConflictAfterRace`).
    fastify.log.error(
      { organizationId, movementId },
      'Etapa 4: movimiento WASTE idempotente sin fila Waste asociada (condición inesperada)',
    );
    throw new ConflictError(
      'No se pudo confirmar el resultado de esta merma por una condición inesperada; reintentá la solicitud.',
    );
  }
  return mapWaste(waste, null);
}

/** Listado de mermas para revisión de Admin (sección 15 del prompt de
 * Etapa 4: "vistas mínimas necesarias para revisar... mermas"). La foto se
 * expone como URL firmada de corta duración, calculada en cada respuesta. */
export async function listWaste(
  fastify: FastifyInstance,
  organizationId: string,
  filters: { locationId?: string },
): Promise<WasteDto[]> {
  const rows = await fastify.db.waste.findMany({
    where: {
      organizationId,
      ...(filters.locationId ? { movement: { locationId: filters.locationId } } : {}),
    },
    include: wasteInclude,
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(
    rows.map(async (row) => mapWaste(row, await createReadUrl(fastify, row.photoPath))),
  );
}
