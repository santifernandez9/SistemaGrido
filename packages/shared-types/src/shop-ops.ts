/**
 * Tipos de la App Heladería Operativa (Etapa 4) — ver
 * docs/ETAPA-4-APP-HELADERIA.md. Consume el ledger de Etapa 3
 * (`@sistema-grido/shared-types` `inventory.ts`) sin reabrirlo: "dar de baja
 * lata" no tiene tipos propios acá porque es un `InventoryMovement`
 * ICE_CREAM_CONTAINER_CLOSE más — ver `CloseIceCreamContainerInput` al final
 * de este archivo, que sólo agrega el input, reutilizando `InventoryMovement`
 * como respuesta.
 */

export const INVENTORY_COUNT_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'RECOUNT_REQUIRED',
  'COMPLETED',
] as const;
export type InventoryCountStatus = (typeof INVENTORY_COUNT_STATUSES)[number];

/**
 * Fracción estimada de una lata abierta (RF-020/RN-025, CONFIRMADO
 * textualmente por el cliente). Reemplaza el pesaje con balanza del sistema
 * anterior -- ver docs/ETAPA-4-APP-HELADERIA.md.
 */
export const OPEN_CONTAINER_FRACTIONS = [
  'FULL',
  'THREE_QUARTERS',
  'HALF',
  'QUARTER',
  'NEARLY_EMPTY',
] as const;
export type OpenContainerFraction = (typeof OPEN_CONTAINER_FRACTIONS)[number];

export const STOCKOUT_CLASSIFICATIONS = ['URGENT_RESTOCK', 'SUPPLY_SHORTAGE'] as const;
export type StockoutClassification = (typeof STOCKOUT_CLASSIFICATIONS)[number];

/**
 * Línea de un ítem cargado durante el conteo (todavía SIN enviar). Vive
 * enteramente en el dispositivo (IndexedDB, sección 2 del prompt) hasta el
 * envío -- este tipo describe el borrador local, no lo que persiste el
 * backend (ver `InventoryCountItemResult` más abajo para eso).
 *
 * Los dos modos de captura (sección 3/4 del prompt) comparten los mismos
 * tres campos: para un producto CERRADO, `closedUnits` = cajas cerradas,
 * `openUnits` = unidades sueltas (conteo exacto), `openFraction` siempre
 * ausente; para un SABOR a granel, `closedUnits` = latas cerradas,
 * `openUnits` = latas abiertas, `openFraction` estimada cuando `openUnits > 0`.
 */
export interface InventoryCountDraftItem {
  productId: string;
  closedUnits?: number;
  openUnits?: number;
  openFraction?: OpenContainerFraction;
}

/**
 * Envío del conteo físico semanal (RF-012). `weekStart` lo calcula el
 * frontend (el lunes de la semana en curso, hora local del dispositivo) --
 * ver docs/ETAPA-4-APP-HELADERIA.md, "Modelo de datos". `idempotencyKey` es
 * OBLIGATORIA acá (a diferencia del ledger de Etapa 3): el origen es
 * siempre una PWA con conectividad intermitente (sección 12 del prompt).
 */
export interface SubmitInventoryCountInput {
  locationId: string;
  /** Fecha ISO (YYYY-MM-DD) del lunes de la semana contada. */
  weekStart: string;
  items: InventoryCountDraftItem[];
  idempotencyKey: string;
}

/** Reenvío de los ítems marcados `needsRecount` (sección 5 del prompt). */
export interface SubmitInventoryRecountInput {
  items: InventoryCountDraftItem[];
  idempotencyKey: string;
}

/**
 * Línea de conteo tal como la expone la API, YA comparada contra el
 * teórico (conteo ciego: el empleado nunca ve `theoreticalQuantity` ni
 * `difference` mientras cuenta -- sólo después de que el backend responde
 * al envío, sección 1 del prompt).
 */
export interface InventoryCountItemResult {
  id: string;
  productId: string;
  productName: string;
  productCode: string | null;
  closedUnits: number | null;
  openUnits: number | null;
  openFraction: OpenContainerFraction | null;
  /** String decimal (mismo criterio que `InventoryMovement.quantity`, Etapa 3.1). */
  physicalQuantity: string;
  theoreticalQuantity: string | null;
  difference: string | null;
  needsRecount: boolean;
  recounted: boolean;
}

export interface InventoryCount {
  id: string;
  organizationId: string;
  locationId: string;
  locationName: string;
  weekStart: string;
  status: InventoryCountStatus;
  submittedAt: string;
  recountedAt: string | null;
  completedAt: string | null;
  createdById: string;
  createdByName: string;
  items: InventoryCountItemResult[];
}

export interface InventoryCountFilters {
  locationId?: string;
  status?: InventoryCountStatus;
}

/**
 * Merma con foto (RF-024/025). La foto es OBLIGATORIA (RN-029, CONFIRMADO)
 * -- primero se sube vía `POST /api/shop/attachments/upload-url` (ver
 * `CreateAttachmentUploadUrlInput`), y el `photoPath` que devuelve esa
 * subida es lo que se manda acá. La cantidad se manda como cantidad exacta
 * (mismo formato que el ledger, `DECIMAL_QUANTITY_PATTERN` de
 * `inventory.ts`) O como fracción de una lata abierta -- nunca ambas.
 */
export type WasteQuantityInput =
  | { enteredQuantity: string; fraction?: never }
  | { enteredQuantity?: never; fraction: OpenContainerFraction };

export type CreateWasteInput = WasteQuantityInput & {
  locationId: string;
  productId: string;
  reason: string;
  photoPath: string;
  occurredAt?: string;
  idempotencyKey: string;
};

export interface Waste {
  id: string;
  organizationId: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  quantity: string;
  reason: string;
  photoPath: string;
  /** URL firmada de corta duración, calculada en cada respuesta -- nunca persistida. */
  photoUrl: string | null;
  createdById: string;
  createdByName: string;
  occurredAt: string;
  createdAt: string;
}

/**
 * Gasto variable (RF-026/RN-033). `receiptPath` es OPCIONAL a propósito --
 * RN-033: "comprobante (si existe)".
 */
export interface CreateVariableExpenseInput {
  locationId: string;
  /** String decimal con 2 posiciones -- ver `MONEY_AMOUNT_PATTERN`. */
  amount: string;
  category: string;
  description: string;
  receiptPath?: string;
  occurredAt?: string;
  idempotencyKey: string;
}

export interface VariableExpense {
  id: string;
  organizationId: string;
  locationId: string;
  locationName: string;
  amount: string;
  category: string;
  description: string;
  receiptPath: string | null;
  receiptUrl: string | null;
  occurredAt: string;
  createdAt: string;
  createdById: string;
  createdByName: string;
}

/** Formato de un monto de dinero: signo opcional, hasta 2 decimales (NUMERIC(12,2)). */
export const MONEY_AMOUNT_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

/** Marcar "sin stock" (RF-019). No modifica stock -- es un evento/incidencia. */
export interface CreateStockoutEventInput {
  locationId: string;
  productId: string;
  idempotencyKey: string;
}

export interface StockoutEvent {
  id: string;
  organizationId: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  /** null si no hay ninguna ubicación DEPOT configurada para clasificar. */
  classification: StockoutClassification | null;
  occurredAt: string;
  createdById: string;
  createdByName: string;
}

/** "Dar de baja lata" (RF-021) -- ver nota de cabecera: no genera un tipo de
 * respuesta propio, reutiliza `InventoryMovement` de `inventory.ts`. */
export interface CloseIceCreamContainerInput {
  locationId: string;
  productId: string;
  idempotencyKey: string;
}

export type AttachmentPurpose = 'WASTE_PHOTO' | 'EXPENSE_RECEIPT';

export interface CreateAttachmentUploadUrlInput {
  purpose: AttachmentPurpose;
  filename: string;
}

export interface AttachmentUploadUrl {
  bucket: string;
  path: string;
  signedUrl: string;
  token: string;
}
