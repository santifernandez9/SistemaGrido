/**
 * Tipos del motor de inventario / ledger de stock (Etapa 3) — ver
 * docs/ETAPA-3-MOTOR-INVENTARIO.md y docs/INVARIANTES-INVENTARIO.md.
 *
 * El stock NUNCA es un campo editable: todo lo que este módulo expone se
 * calcula o se registra a partir de `InventoryMovement` (el ledger). No hay
 * ningún tipo "StockUpdateInput" — no existe una operación que edite un saldo.
 */

/**
 * Lista completa de tipos de movimiento (RF-010, CONFIRMADO — lista textual
 * del cliente). El dominio completo se tipa desde ahora aunque, en Etapa 3,
 * sólo un subconjunto tiene un endpoint que efectivamente lo genere — ver
 * `IMPLEMENTED_MOVEMENT_TYPES` más abajo y la sección "Tipos de movimiento"
 * de docs/ETAPA-3-MOTOR-INVENTARIO.md.
 */
export const MOVEMENT_TYPES = [
  'INITIAL_STOCK',
  'PURCHASE_RECEIPT',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'SALE',
  'BOM_CONSUMPTION',
  'WASTE',
  'ICE_CREAM_CONTAINER_CLOSE',
  'ADJUSTMENT',
  'EXTERNAL_OUT',
  'COUNT_CORRECTION',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Subconjunto de MOVEMENT_TYPES que Etapa 3 efectivamente genera vía API. */
export const IMPLEMENTED_MOVEMENT_TYPES = ['INITIAL_STOCK', 'ADJUSTMENT'] as const;

export const MOVEMENT_STATUSES = ['ACTIVE', 'REVERSED'] as const;
export type MovementStatus = (typeof MOVEMENT_STATUSES)[number];

export const INVENTORY_AUDIT_MODULES = ['INVENTORY'] as const;
export type InventoryAuditModule = (typeof INVENTORY_AUDIT_MODULES)[number];

export const INVENTORY_AUDIT_ACTIONS = [
  'INVENTORY_INITIAL_STOCK_CREATED',
  'INVENTORY_ADJUSTMENT_CREATED',
  'INVENTORY_MOVEMENT_REVERSED',
] as const;
export type InventoryAuditAction = (typeof INVENTORY_AUDIT_ACTIONS)[number];

/**
 * Movimiento de inventario, tal como lo expone la API (con nombres resueltos
 * para que el frontend no tenga que resolver UUIDs -- sección 24 del prompt
 * de Etapa 3: "no mostrar UUID como información principal").
 *
 * `quantity`/`enteredQuantity` viajan como `string`: son `NUMERIC(14,3)` en
 * Postgres/`Decimal` en Prisma, y JSON no tiene un tipo decimal seguro -- un
 * `number` de JS perdería precisión en sumas largas. El frontend los
 * parsea sólo para mostrarlos, nunca para volver a sumarlos (esa cuenta la
 * hace siempre el backend).
 */
export interface InventoryMovement {
  id: string;
  organizationId: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  productCode: string | null;
  movementType: MovementType;
  quantity: string;
  enteredQuantity: string;
  entryUnitOfMeasureId: string;
  entryUnitOfMeasureName: string;
  conversionFactor: number;
  reason: string | null;
  sourceDocumentType: string | null;
  sourceDocumentId: string | null;
  idempotencyKey: string | null;
  reversesMovementId: string | null;
  status: MovementStatus;
  occurredAt: string;
  createdAt: string;
  createdById: string;
  createdByName: string;
}

/**
 * Saldo teórico de un producto en una ubicación (sección 9 del prompt:
 * "organization + location + product -> quantity"). Siempre calculado desde
 * el ledger en el momento de la consulta -- no es una fila propia en base de
 * datos (ver docs/ETAPA-3-MOTOR-INVENTARIO.md, sección "Cálculo de stock
 * teórico"). `quantity` puede ser negativo (decisión confirmada por el
 * cliente en esta etapa: el motor no rechaza ni corrige automáticamente un
 * saldo negativo, sólo lo deja visible).
 */
export interface StockBalance {
  organizationId: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  productCode: string | null;
  quantity: string;
}

/**
 * Alta de stock inicial (RF-011/RN-011, CONFIRMADO). Sólo Admin en esta
 * etapa -- ver docs/ETAPA-3-MOTOR-INVENTARIO.md, sección "Autorización": es
 * un mecanismo administrativo controlado, no la pantalla de conteo físico
 * (Etapa 4). `enteredQuantity` va en la unidad de manejo propia del
 * producto (Product.unitOfMeasureId de Etapa 2) -- el producto no tiene más
 * de una unidad posible, así que no hace falta que el llamador elija una.
 */
export interface CreateInitialStockInput {
  locationId: string;
  productId: string;
  enteredQuantity: number;
  /** Fecha efectiva del conteo/carga, si es distinta de "ahora". */
  occurredAt?: string;
  idempotencyKey?: string;
}

/**
 * Ajuste manual de inventario (RN-008/sección 11-12 del prompt). `reason`
 * es obligatorio (CHECK en base de datos, ver migración) -- no existe una
 * lista cerrada de motivos respaldada por el cliente para este caso (RF-017
 * es un motivo tipificado, pero es específico de la justificación de
 * diferencias de conteo, un mecanismo distinto de Etapa 4), así que es
 * texto libre obligatorio.
 */
export interface CreateAdjustmentInput {
  locationId: string;
  productId: string;
  /** Con signo: positivo = ajuste que suma stock, negativo = ajuste que resta. */
  enteredQuantity: number;
  reason: string;
  occurredAt?: string;
  idempotencyKey?: string;
}

/** Reversión de un movimiento existente (sección 13 del prompt). */
export interface ReverseMovementInput {
  reason: string;
}

/** Filtros del historial de movimientos (sección 22 del prompt). */
export interface MovementFilters {
  locationId?: string;
  productId?: string;
  movementType?: MovementType;
  occurredFrom?: string;
  occurredTo?: string;
}

/** Paginación offset simple -- suficiente para el volumen de Etapa 3 (pocas
 * sucursales); ver docs/ETAPA-3-MOTOR-INVENTARIO.md, sección "Índices/performance". */
export interface PageInput {
  page?: number;
  pageSize?: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
